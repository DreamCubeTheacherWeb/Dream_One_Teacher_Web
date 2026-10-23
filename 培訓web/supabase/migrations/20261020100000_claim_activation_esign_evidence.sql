-- ═══════════════════════════════════════════════════════════════════
-- 帳號認領啟用（Email OTP）＋電子契約簽署證據（2026-10-20）
-- 介面契約：docs/specs/2026-10-20-claim-activation-esign.md §1（函式名稱／參數／回傳照規格）
-- 法規文案：docs/specs/2026-10-20-esign-legal-copy.md §5（全文種入 public.esign_text_versions）
-- 可重複執行；不刪既有資料。
--
-- 區段：
--   0. 擴充（pg_net 能啟用就啟用；失敗不擋，寄信改記 not_configured）
--   1. instructors 新欄位＋管理欄位 guard（獨立 trigger trg_guard_instructor_claim_fields）
--   2. contract_documents.content_sha256、instructor_contracts 新欄位
--   3. 新表（啟用紀錄、OTP challenge、寄送紀錄、法規文案版本、同意紀錄、簽署證據）＋RLS
--   4. 內部輔助函式（內部寫入旗標、遮罩、header、寄信、雜湊鏈）
--   5. 防竄改 trigger 與 Storage restrictive 政策
--   6. RPC（get_my_activation_status、request_email_otp、verify_email_otp、record_contract_consent、
--      submit_my_contract v2、admin_confirm_instructor_email、admin_set_document_hash、
--      admin_verify_contract_evidence_chain）
--   7. 認領／核准／解除綁定／刪除帳號函式改版（綁定後待啟用）
--   8. 一次性回填（D2 身分已核驗＋既有 Email 登錄、D4 既有 teacher 的 legacy 啟用紀錄、舊約 instructor_id）
--   9. pg_cron：每分鐘更新寄送狀態（沒有 cron schema 就略過）
--
-- 防竄改的邊界（誠實條款）：
--   * 證據相關表的 trigger 只放行「SECURITY DEFINER 函式在內部流程中、且執行身分不是
--     anon／authenticated／service_role」的寫入；admin 透過 PostgREST 一律擋下。
--   * 資料表擁有者／超級使用者（Supabase 的 postgres）可以停用 trigger 或改 session_replication_role，
--     資料庫層擋不住；這種竄改由 contract_signing_evidence 的雜湊鏈與
--     admin_verify_contract_evidence_chain() 的交叉比對抓出來。
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- 整支在同一個交易裡；拿不到表鎖 5 秒就放棄（整批回滾），不讓線上查詢排隊等我們
-- （2026-10-23 資安審查建議 6：區段 8 會 ALTER TABLE … DISABLE TRIGGER，要 ACCESS EXCLUSIVE 鎖；比照 20261022120000）
SET LOCAL lock_timeout = '5s';

-- ──────────────────────────────────────────────────────────────────
-- 0. 擴充
-- ──────────────────────────────────────────────────────────────────
-- pg_net 依 Supabase 文件寫法登記在 extensions schema（https://supabase.com/docs/guides/database/extensions/pg_net：
-- `create extension pg_net with schema "extensions";`）。pg_net 不可搬移（relocatable = false），函式與資料表固定建在
-- 它自己的 net schema（net.http_post、net._http_response），WITH SCHEMA 只決定擴充本身登記在哪，不影響下面的呼叫。
-- CREATE EXTENSION 可以在交易內執行（Supabase CLI 的 migration 也是整支包在交易裡）；請求要等交易 commit 後才會真的送出。
DO $$
BEGIN
  IF pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
    BEGIN
      IF pg_catalog.to_regnamespace('extensions') IS NOT NULL THEN
        CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
      ELSE
        CREATE EXTENSION IF NOT EXISTS pg_net;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'pg_net 無法啟用（%）；寄信會記錄為 not_configured，直到啟用 pg_net 並設定 Vault。', SQLERRM;
    END;
  END IF;
END;
$$;

-- ──────────────────────────────────────────────────────────────────
-- 1. instructors 新欄位（admin 專屬）
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS identity_verification_basis text,
  ADD COLUMN IF NOT EXISTS confirmed_email text,
  ADD COLUMN IF NOT EXISTS confirmed_email_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_email_by uuid,
  ADD COLUMN IF NOT EXISTS confirmed_email_method text,
  ADD COLUMN IF NOT EXISTS confirmed_email_note text;

DO $$ BEGIN
  ALTER TABLE public.instructors ADD CONSTRAINT instructors_confirmed_email_method_check
    CHECK (confirmed_email_method IS NULL
           OR confirmed_email_method IN ('company_existing_record', 'admin_trusted_channel', 'google_login_new_instructor'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.instructors ADD CONSTRAINT instructors_confirmed_email_format_check
    CHECK (confirmed_email IS NULL
           OR (confirmed_email = lower(btrim(confirmed_email))
               AND confirmed_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.instructors.identity_verified_at IS '身分已核驗的登錄時間（admin 專屬）。';
COMMENT ON COLUMN public.instructors.confirmed_email IS '公司已確認屬於該講師的 Email（小寫去空白）；啟用與簽約 OTP 一律寄到這裡（admin 專屬）。';

-- 1.1 的七個新欄位只有 admin 能設定或更改：以 20261019233000 的獨立 guard 為底（name_slot），多保護這七欄。
-- 不重定義共用的 guard_instructor_admin_fields（正式庫已套 20261022100000_personnel_types 的版本，
-- 本檔若再 CREATE OR REPLACE 它，不管誰後套都會把另一邊的保護洗掉；理由見 20261019233000）。
CREATE OR REPLACE FUNCTION public.guard_instructor_claim_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_is_admin boolean := false;
BEGIN
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = actor_id AND u.role = 'admin'
  ) INTO actor_is_admin;
  IF actor_is_admin THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.name_slot IS DISTINCT FROM false
       OR NEW.identity_verified_at IS NOT NULL
       OR NEW.identity_verification_basis IS NOT NULL
       OR NEW.confirmed_email IS NOT NULL
       OR NEW.confirmed_email_at IS NOT NULL
       OR NEW.confirmed_email_by IS NOT NULL
       OR NEW.confirmed_email_method IS NOT NULL
       OR NEW.confirmed_email_note IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'administrator-managed instructor fields cannot be set by instructors';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
      NEW.name_slot,
      NEW.identity_verified_at, NEW.identity_verification_basis,
      NEW.confirmed_email, NEW.confirmed_email_at, NEW.confirmed_email_by,
      NEW.confirmed_email_method, NEW.confirmed_email_note
    ) IS DISTINCT FROM ROW(
      OLD.name_slot,
      OLD.identity_verified_at, OLD.identity_verification_basis,
      OLD.confirmed_email, OLD.confirmed_email_at, OLD.confirmed_email_by,
      OLD.confirmed_email_method, OLD.confirmed_email_note
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'administrator-managed instructor fields cannot be changed by instructors';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_claim_fields() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_claim_fields ON public.instructors;
CREATE TRIGGER trg_guard_instructor_claim_fields
  BEFORE INSERT OR UPDATE ON public.instructors
  FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_claim_fields();

-- 管理員在後台新建講師列時，登錄「管理員建立講師資料」為身分核驗依據（Email 仍需另外確認）。
CREATE OR REPLACE FUNCTION private.stamp_admin_created_instructor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NOT NULL
     AND NEW.identity_verified_at IS NULL
     AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin') THEN
    NEW.identity_verified_at := pg_catalog.now();
    NEW.identity_verification_basis := COALESCE(NEW.identity_verification_basis, '管理員建立講師資料');
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.stamp_admin_created_instructor() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stamp_admin_created_instructor ON public.instructors;
CREATE TRIGGER trg_stamp_admin_created_instructor
BEFORE INSERT ON public.instructors
FOR EACH ROW EXECUTE FUNCTION private.stamp_admin_created_instructor();

-- ──────────────────────────────────────────────────────────────────
-- 2. contract_documents.content_sha256、instructor_contracts 新欄位
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE public.contract_documents
  ADD COLUMN IF NOT EXISTS content_sha256 text;

DO $$ BEGIN
  ALTER TABLE public.contract_documents ADD CONSTRAINT contract_documents_content_sha256_check
    CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.contract_documents.content_sha256 IS
  '範本 PDF 的 SHA-256（小寫 hex）。管理員上傳新版時寫入；舊版用 admin_set_document_hash 補登（只能補 NULL）。';

ALTER TABLE public.instructor_contracts
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verify_method text,
  ADD COLUMN IF NOT EXISTS instructor_id uuid,
  ADD COLUMN IF NOT EXISTS bound_email text,
  ADD COLUMN IF NOT EXISTS consent_id uuid,
  ADD COLUMN IF NOT EXISTS otp_challenge_id uuid,
  ADD COLUMN IF NOT EXISTS otp_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS document_sha256 jsonb,
  ADD COLUMN IF NOT EXISTS signed_pdf_sha256 jsonb,
  ADD COLUMN IF NOT EXISTS evidence_id uuid,
  ADD COLUMN IF NOT EXISTS voided_at timestamptz,
  ADD COLUMN IF NOT EXISTS voided_reason text,
  ADD COLUMN IF NOT EXISTS superseded_by uuid;

DO $$ BEGIN
  ALTER TABLE public.instructor_contracts ADD CONSTRAINT instructor_contracts_superseded_by_fkey
    FOREIGN KEY (superseded_by) REFERENCES public.instructor_contracts(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_instructor_contracts_user_status
  ON public.instructor_contracts (user_id, status);

-- ──────────────────────────────────────────────────────────────────
-- 3. 新表
-- ──────────────────────────────────────────────────────────────────

-- 3.1 帳號啟用紀錄
CREATE TABLE IF NOT EXISTS public.instructor_account_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id uuid,
  user_id uuid NOT NULL,
  claim_method text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  activation_email text,
  otp_challenge_id uuid,
  otp_verified_at timestamptz,
  activated_at timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  revoked_at timestamptz,
  revoked_reason text
);

-- claim_method 清單獨立成具名 CHECK，重跑時一併更新（admin_link＝後台手動綁定，2026-10-20 補）
ALTER TABLE public.instructor_account_activations
  DROP CONSTRAINT IF EXISTS instructor_account_activations_claim_method_check;
ALTER TABLE public.instructor_account_activations
  ADD CONSTRAINT instructor_account_activations_claim_method_check CHECK (claim_method IN (
    'email_match', 'identity_check', 'name_slot', 'admin_link', 'new_instructor_approved', 'legacy_pre_activation'));

COMMENT ON TABLE public.instructor_account_activations IS
  '講師帳號啟用紀錄。user_id／instructor_id 刻意不設外鍵：帳號刪除後紀錄仍保留作稽核。同一 user 同時只能有一筆 pending/active。';

CREATE UNIQUE INDEX IF NOT EXISTS uq_instructor_account_activations_open
  ON public.instructor_account_activations (user_id)
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS idx_instructor_account_activations_instructor
  ON public.instructor_account_activations (instructor_id);

-- 3.2 OTP challenge（不對外；不存明碼，只存 salt＋SHA-256）
CREATE TABLE IF NOT EXISTS private.email_otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('account_activation', 'contract_sign')),
  target_email text NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  salt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  verified_at timestamptz,
  consumed_at timestamptz,
  superseded_at timestamptz,
  delivery_id uuid
);

CREATE INDEX IF NOT EXISTS idx_email_otp_challenges_user_purpose
  ON private.email_otp_challenges (user_id, purpose, created_at DESC);

ALTER TABLE private.email_otp_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.email_otp_challenges FROM PUBLIC, anon, authenticated;

-- 3.3 寄送紀錄（信件內文不入庫，OTP 信尤其不可）
CREATE TABLE IF NOT EXISTS public.email_delivery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('otp_activation', 'otp_contract', 'contract_signed_copy')),
  to_email text NOT NULL,
  subject text NOT NULL,
  related_user_id uuid,
  related_contract_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  provider text NOT NULL DEFAULT 'resend',
  net_request_id bigint,
  status text NOT NULL CHECK (status IN ('queued', 'sent', 'failed', 'not_configured')),
  http_status integer,
  provider_message_id text,
  error_text text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_delivery_log_user ON public.email_delivery_log (related_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_log_contract ON public.email_delivery_log (related_contract_id);
CREATE INDEX IF NOT EXISTS idx_email_delivery_log_queued ON public.email_delivery_log (net_request_id) WHERE status = 'queued';

-- 3.4 法規文案版本（append-only；同一代碼不能改內容，改版新增 -v2）
CREATE TABLE IF NOT EXISTS public.esign_text_versions (
  version_code text PRIMARY KEY CHECK (version_code ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.esign_text_versions IS
  '電子簽約法規文案全文（docs/specs/2026-10-20-esign-legal-copy.md §5）。{{company_name}}／{{contact_email}} 已代入；'
  '{{doc_list}}／{{masked_email}}／{{instructor_name}} 等動態值於 record_contract_consent／寄信時由伺服器代入。append-only。';

-- 3.5 電子簽約同意紀錄（append-only）
CREATE TABLE IF NOT EXISTS public.contract_consent_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  instructor_id uuid,
  decision text NOT NULL CHECK (decision IN ('agree_electronic', 'decline_electronic')),
  consent_text_version text NOT NULL REFERENCES public.esign_text_versions(version_code),
  consent_text text NOT NULL,
  doc_versions jsonb NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_consent_records_user ON public.contract_consent_records (user_id, created_at DESC);

-- 同意頁同時顯示的個資告知（esign-privacy-notice-v1）：版本代碼＋全文分欄保存，同意與不同意都存
ALTER TABLE public.contract_consent_records
  ADD COLUMN IF NOT EXISTS privacy_notice_version text,
  ADD COLUMN IF NOT EXISTS privacy_notice_text text;

DO $$ BEGIN
  ALTER TABLE public.contract_consent_records ADD CONSTRAINT contract_consent_records_privacy_notice_version_fkey
    FOREIGN KEY (privacy_notice_version) REFERENCES public.esign_text_versions(version_code);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN public.contract_consent_records.privacy_notice_text IS
  '同意頁同時顯示的個資告知全文（record_contract_consent 固定帶入目前版本 privacy_notice_version）。';

DO $$ BEGIN
  ALTER TABLE public.instructor_contracts ADD CONSTRAINT instructor_contracts_consent_id_fkey
    FOREIGN KEY (consent_id) REFERENCES public.contract_consent_records(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 3.6 簽署證據（append-only，雜湊鏈）
CREATE TABLE IF NOT EXISTS public.contract_signing_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chain_seq bigint NOT NULL UNIQUE CHECK (chain_seq > 0),
  contract_id uuid NOT NULL UNIQUE REFERENCES public.instructor_contracts(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  instructor_id uuid,
  bound_email text NOT NULL,
  doc_versions jsonb NOT NULL,
  document_sha256 jsonb NOT NULL,
  signed_pdf_paths jsonb NOT NULL,
  signed_pdf_sha256 jsonb NOT NULL,
  signature_path text NOT NULL,
  contract_fields_sha256 text NOT NULL,
  consent_id uuid NOT NULL REFERENCES public.contract_consent_records(id),
  consent_at timestamptz NOT NULL,
  otp_challenge_id uuid NOT NULL,
  otp_verified_at timestamptz NOT NULL,
  signed_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  previous_evidence_sha256 text CHECK (previous_evidence_sha256 IS NULL OR previous_evidence_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_sha256 text NOT NULL UNIQUE CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.contract_signing_evidence IS
  '簽署證據（append-only）。evidence_sha256 = sha256(前一筆 evidence_sha256 ∥ 本列規範化 JSON)，第一筆的前一筆視為空字串；'
  'chain_seq 由 1 連號。contract_fields_sha256 是契約填寫欄位（姓名／等級／身分證／地址／電話）的規範化雜湊，'
  '用來發現 instructor_contracts 被改而不在證據表重複存個資。';

-- 3.7 RLS：本人讀自己的、admin 讀全部；沒有任何直接寫入政策
ALTER TABLE public.instructor_account_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_delivery_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.esign_text_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_signing_evidence ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.instructor_account_activations, public.email_delivery_log, public.esign_text_versions,
  public.contract_consent_records, public.contract_signing_evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.instructor_account_activations, public.email_delivery_log, public.esign_text_versions,
  public.contract_consent_records, public.contract_signing_evidence TO authenticated;

DROP POLICY IF EXISTS "Own or admin can read activations" ON public.instructor_account_activations;
CREATE POLICY "Own or admin can read activations"
  ON public.instructor_account_activations FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT private.current_user_is_admin()));

DROP POLICY IF EXISTS "Own or admin can read email delivery log" ON public.email_delivery_log;
CREATE POLICY "Own or admin can read email delivery log"
  ON public.email_delivery_log FOR SELECT TO authenticated
  USING (related_user_id = (SELECT auth.uid()) OR (SELECT private.current_user_is_admin()));

DROP POLICY IF EXISTS "Signed-in users can read esign texts" ON public.esign_text_versions;
CREATE POLICY "Signed-in users can read esign texts"
  ON public.esign_text_versions FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "Own or admin can read consent records" ON public.contract_consent_records;
CREATE POLICY "Own or admin can read consent records"
  ON public.contract_consent_records FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT private.current_user_is_admin()));

DROP POLICY IF EXISTS "Own or admin can read signing evidence" ON public.contract_signing_evidence;
CREATE POLICY "Own or admin can read signing evidence"
  ON public.contract_signing_evidence FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()) OR (SELECT private.current_user_is_admin()));

-- 一次性回填的執行標記（D2／D4 只在第一次套用時做）
CREATE TABLE IF NOT EXISTS private.schema_backfill_markers (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  detail jsonb
);
REVOKE ALL ON TABLE private.schema_backfill_markers FROM PUBLIC, anon, authenticated;

-- 3.8 法規文案種子（docs/specs/2026-10-20-esign-legal-copy.md §5；只新增，已存在的代碼不覆寫）
DO $$
DECLARE
  seed record;
  existing text;
BEGIN
  FOR seed IN
    SELECT * FROM (VALUES
      ('esign-read-ack-v1', $t$☐ 我已完整閱讀並了解 {{doc_list}} 的內容。$t$),
      ('esign-consent-v1', $t$選擇簽約方式

這次要簽的文件是：{{doc_list}}。你可以在上一步下載這些文件。

夢想一號文化教育股份有限公司（以下稱「本公司」）提供線上簽約，讓你不必寄送紙本。流程是：系統寄一組 Email 驗證碼到本公司已確認的你的信箱（{{masked_email}}），確認是你本人操作；你在畫面上手寫簽名，按下「確認簽署」後完成。完成後系統會產生已簽署的 PDF 檔，你可以隨時登入下載。

要不要用線上簽約，由你決定。你也可以選擇紙本簽約，兩種方式簽的是同一個版本的文件。

選擇線上簽約後，如果你之後想改回紙本（例如之後的契約修訂或續約），隨時可以用 Email、LINE 或口頭告訴本公司行政人員；改回紙本之前已經完成的線上簽署，效力不受影響。

為了證明簽約事實，系統會保存以下紀錄：你的帳號與 Email、你看到的文件版本與檔案指紋（SHA-256）、你在本頁的選擇與時間、Email 驗證時間、簽署時間、IP 位址、裝置與瀏覽器資訊、你的簽名影像、已簽署 PDF 的檔案指紋，以及通知信的寄送紀錄。你可以隨時向本公司索取已簽署文件的副本（電子檔或紙本）。

☐ 我已閱讀上述說明，同意以電子文件及線上簽署方式（Email 驗證碼＋線上手寫簽名）簽訂本次契約。我了解簽署紀錄會被保存作為簽約證明，也可以隨時索取副本。

［同意，使用線上簽約］［不同意，改以紙本簽約］$t$),
      ('esign-decline-paper-v1', $t$改以紙本簽約

你可以不使用線上簽約，這是你的權利。選擇紙本簽約不代表你不同意契約內容。

確認後：
1. 系統會記錄你選擇紙本簽約，並通知本公司行政人員。
2. 行政人員會主動和你聯繫，安排紙本簽約。
3. 紙本契約和線上版本是同一個版本：{{doc_list}}。
4. 紙本簽署完成前，網站上的簽約狀態會顯示「紙本簽約處理中」。

如果之後改變主意想改用線上簽約，請聯絡 hi@dreamcube.tw。

［確認改以紙本簽約］［返回］$t$),
      ('esign-final-confirm-v1', $t$按下「確認簽署」，即表示：
- 我是 {{instructor_name}} 本人，簽名是我親自在本畫面完成的；
- 我已閱讀並同意 {{doc_list}} 的全部內容，並以上方的簽名簽署這些文件；
- 我填寫的姓名、身分證字號、地址、電話正確無誤。

簽署完成後，簽署時間以系統伺服器時間（台北時間）為準，已簽署的文件不能自行修改或撤回；如有錯誤，請聯絡 hi@dreamcube.tw。

［確認簽署］$t$),
      ('esign-privacy-notice-v1', $t$個人資料蒐集告知（電子簽約）

夢想一號文化教育股份有限公司 依《個人資料保護法》第 8 條告知：
- 目的：訂定、履行及管理講師合作契約；證明簽約事實、處理契約爭議；辦理報酬給付及相關稅務申報。
- 資料類別：姓名、身分證統一編號、地址、電話、Email、帳號識別資料、講師等級；簽名影像；簽署紀錄（文件版本與檔案指紋、同意與驗證時間、簽署時間、IP 位址、裝置與瀏覽器資訊、通知信寄送紀錄）。
- 期間：合作期間，以及合作結束後 15 年；法令規定更長保存期間的，依法令規定。
- 地區：中華民國，以及本公司委託的雲端資料庫、檔案儲存與電子郵件寄送服務提供服務的地區（可能在中華民國境外）。
- 對象：本公司負責合約與行政的授權人員；本公司委託處理資料的資訊服務商（雲端資料庫與檔案儲存、電子郵件寄送）；依法有權調閱的機關（例如法院、稅捐機關）。
- 方式：以電子方式蒐集、儲存、產生簽署文件、寄送通知，並依職務限制存取權限。
- 你的權利：你可以請求查詢、閱覽、製給複製本、補充或更正、停止蒐集處理利用，或刪除你的個人資料，請寄信至 hi@dreamcube.tw。保存期間內，如果資料是證明簽約事實或處理契約爭議所必需，本公司可能依法暫不刪除，並會向你說明原因。
- 不提供的影響：不提供上述資料或不同意保存簽署紀錄，就無法完成線上簽約；你可以改用紙本簽約（紙本契約仍需填寫姓名、身分證字號、地址、電話）。

完整說明請見〈隱私權政策〉。$t$),
      ('esign-signed-email-v1', $t$主旨：【夢想一號】講師合作契約簽署完成通知

{{instructor_name}} 你好：

你已於 {{signed_at_taipei}} 以線上方式完成以下文件的簽署：{{doc_list}}。
簽署編號：{{contract_ref}}

下載：請登入講師資源站下載已簽署的文件：{{download_url}}
為了保護你的個人資料，這封信不附檔案，連結要登入你本人的帳號才能開啟。

保存：已簽署的 PDF 與簽署紀錄（包括文件指紋、Email 驗證與簽署時間、IP 位址等）由本公司保存在講師資源站系統，保存期間依簽署時的〈個人資料蒐集告知〉辦理。如果帳號停用或無法登入，可以寄信到 hi@dreamcube.tw 索取副本（電子檔或紙本）。

如果這不是你本人簽署的：請立即寄信到 hi@dreamcube.tw，附上簽署編號，本公司會協助查證處理；也建議你馬上更改 Google 帳號密碼。

之後想改用紙本：可以隨時告訴本公司行政人員；已經完成的線上簽署不受影響。

這封信由系統自動寄出。
夢想一號文化教育股份有限公司$t$),
      ('esign-otp-email-v1', $t$這組驗證碼用來確認是你本人要簽署夢想一號的講師合作文件，5 分鐘內有效。請不要把驗證碼告訴任何人，本公司人員不會向你索取。如果你沒有要簽約，請忽略這封信，並通知 hi@dreamcube.tw。$t$)
    ) AS v(version_code, content)
  LOOP
    SELECT t.content INTO existing FROM public.esign_text_versions t WHERE t.version_code = seed.version_code;
    IF existing IS NULL THEN
      INSERT INTO public.esign_text_versions (version_code, content) VALUES (seed.version_code, seed.content);
    ELSIF existing IS DISTINCT FROM seed.content THEN
      RAISE WARNING 'esign_text_versions % 已存在且內容不同；append-only 不覆寫，改版請新增新代碼（例如 -v2）。', seed.version_code;
    END IF;
  END LOOP;
END;
$$;

-- ──────────────────────────────────────────────────────────────────
-- 4. 內部輔助函式（private schema；不對 PostgREST 暴露）
-- ──────────────────────────────────────────────────────────────────

-- 4.1 內部寫入旗標：只有 SECURITY DEFINER 函式在明確的內部流程才打開；回傳舊值供巢狀還原。
CREATE OR REPLACE FUNCTION private.internal_write_begin()
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  previous text := COALESCE(NULLIF(pg_catalog.current_setting('dreamone.internal_write', true), ''), 'off');
BEGIN
  PERFORM pg_catalog.set_config('dreamone.internal_write', 'on', true);
  RETURN previous;
END;
$$;

CREATE OR REPLACE FUNCTION private.internal_write_end(p_previous text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  PERFORM pg_catalog.set_config('dreamone.internal_write', COALESCE(p_previous, 'off'), true);
END;
$$;

REVOKE ALL ON FUNCTION private.internal_write_begin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.internal_write_end(text) FROM PUBLIC, anon, authenticated;

-- 4.2 小工具
CREATE OR REPLACE FUNCTION private.mask_email(p_email text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_local text;
  v_domain text;
BEGIN
  IF p_email IS NULL OR position('@' IN p_email) = 0 THEN
    RETURN NULL;
  END IF;
  v_local := split_part(p_email, '@', 1);
  v_domain := substr(p_email, position('@' IN p_email) + 1);
  RETURN left(v_local, CASE WHEN char_length(v_local) > 2 THEN 2 ELSE 1 END) || '***@' || v_domain;
END;
$$;

CREATE OR REPLACE FUNCTION private.html_escape(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT replace(replace(replace(replace(replace(COALESCE(p_text, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

CREATE OR REPLACE FUNCTION private.utc_text(p_ts timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE WHEN p_ts IS NULL THEN NULL
              ELSE to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END;
$$;

CREATE OR REPLACE FUNCTION private.safe_jsonb(p_text text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  RETURN p_text::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- 用 {{key}} 代入動態值；沒給的佔位符原樣保留。
CREATE OR REPLACE FUNCTION private.render_esign_text(p_content text, p_vars jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_out text := p_content;
  v_item record;
BEGIN
  IF p_vars IS NULL OR jsonb_typeof(p_vars) <> 'object' THEN
    RETURN v_out;
  END IF;
  FOR v_item IN SELECT e.key, e.value FROM jsonb_each_text(p_vars) e LOOP
    IF v_item.value IS NOT NULL THEN
      v_out := replace(v_out, '{{' || v_item.key || '}}', v_item.value);
    END IF;
  END LOOP;
  RETURN v_out;
END;
$$;

-- 依 doc_versions 組文件清單：「講師合作契約（第 3 版）、講師管理辦法（第 2 版）」
CREATE OR REPLACE FUNCTION private.esign_doc_list(p_doc_versions jsonb)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT string_agg(
           COALESCE(NULLIF(btrim(d.display_name), ''), v.key) || '（第 ' || v.value || ' 版）',
           '、' ORDER BY COALESCE(d.sort_order, 2147483647), v.key)
    FROM jsonb_each_text(CASE WHEN jsonb_typeof(p_doc_versions) = 'object' THEN p_doc_versions ELSE '{}'::jsonb END) AS v(key, value)
    LEFT JOIN public.contract_documents d
      ON d.doc_type = v.key AND d.version::text = v.value;
$$;

-- 4.3 PostgREST 的 request.headers：IP 依 cf-connecting-ip → x-forwarded-for 第一段 → x-real-ip；UA 取 user-agent
CREATE OR REPLACE FUNCTION private.request_client_meta(OUT ip_address text, OUT user_agent text)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_headers jsonb;
BEGIN
  BEGIN
    v_headers := NULLIF(pg_catalog.current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;
  IF v_headers IS NULL OR jsonb_typeof(v_headers) <> 'object' THEN
    RETURN;
  END IF;
  ip_address := NULLIF(btrim(v_headers ->> 'cf-connecting-ip'), '');
  IF ip_address IS NULL THEN
    ip_address := NULLIF(btrim(split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
  END IF;
  IF ip_address IS NULL THEN
    ip_address := NULLIF(btrim(v_headers ->> 'x-real-ip'), '');
  END IF;
  ip_address := left(ip_address, 64);
  user_agent := NULLIF(left(btrim(COALESCE(v_headers ->> 'user-agent', '')), 500), '');
END;
$$;

-- 4.4 簽約帳號狀態：teacher 有啟用紀錄時必須有 active 那筆；mentor／admin 是邀請制 staff，不需啟用紀錄；
--     三者都必須綁定未停用的講師主檔（OTP 寄到主檔的 confirmed_email）。
--     【上線前審查 必修 1，2026-10-22】teacher「完全沒有任何啟用紀錄」視為 legacy（已由管理員核准的舊流程帳號）放行。
--     原因：D4 回填只幫「套用當下已綁主檔的 teacher」補 legacy 紀錄；套用當下是 teacher 但還沒有主檔、之後在
--     /profile 自建主檔的人，以及被行政用角色下拉直接改成 teacher 的人，都不會有任何啟用紀錄。若一律要求 active，
--     他們要簽約驗證碼會被回 account_not_active，個人資料頁卻因狀態是 none 不顯示啟用卡、要啟用碼又回
--     no_pending_activation——死循環（舊版 submit_my_contract 只擋 pending，一律要求 active 是倒退）。
--     仍擋：有 pending 紀錄（只綁不開通，須本人以 Email 驗證碼啟用）或只剩 revoked 紀錄者。
--     confirmed_email 為 NULL 時由呼叫端走既有「待行政確認 Email」路徑（no_confirmed_email），此處不放寬。
CREATE OR REPLACE FUNCTION private.signing_account_state(
  p_uid uuid,
  OUT is_active boolean,
  OUT user_role text,
  OUT instructor_id uuid,
  OUT confirmed_email text,
  OUT full_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_employment text;
BEGIN
  is_active := false;
  SELECT u.role INTO user_role FROM public.users u WHERE u.id = p_uid;
  SELECT i.id, i.confirmed_email, i.employment_status::text, i.full_name
    INTO instructor_id, confirmed_email, v_employment, full_name
    FROM public.instructors i
   WHERE i.user_id = p_uid
   LIMIT 1;

  IF user_role IS NULL
     OR user_role NOT IN ('teacher', 'mentor', 'admin')
     OR instructor_id IS NULL
     OR v_employment IN ('frozen', 'cancelled') THEN
    RETURN;
  END IF;

  IF user_role = 'teacher'
     AND EXISTS (
       SELECT 1 FROM public.instructor_account_activations a
        WHERE a.user_id = p_uid
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.instructor_account_activations a
        WHERE a.user_id = p_uid AND a.status = 'active'
     ) THEN
    RETURN;
  END IF;

  is_active := true;
END;
$$;

-- 4.5 Vault／pg_net：缺任何一樣都視為未設定，不丟錯。
CREATE OR REPLACE FUNCTION private.read_vault_secret(p_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_value text;
BEGIN
  IF pg_catalog.to_regclass('vault.decrypted_secrets') IS NULL THEN
    RETURN NULL;
  END IF;
  BEGIN
    EXECUTE 'SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = $1 LIMIT 1'
      INTO v_value USING p_name;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  RETURN NULLIF(btrim(v_value), '');
END;
$$;

CREATE OR REPLACE FUNCTION private.email_delivery_configured()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NOT NULL
     AND private.read_vault_secret('resend_api_key') IS NOT NULL
     AND private.read_vault_secret('resend_from') IS NOT NULL;
$$;

-- 排入寄送：回傳 email_delivery_log.id。未設定 → not_configured；pg_net 呼叫失敗 → failed。都不丟錯。
-- 信件內文只交給 pg_net，不寫進任何本系統的資料表。
CREATE OR REPLACE FUNCTION private.enqueue_email(
  p_kind text,
  p_to text,
  p_subject text,
  p_html text,
  p_text text,
  p_related_user_id uuid,
  p_related_contract_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_key text := private.read_vault_secret('resend_api_key');
  v_from text := private.read_vault_secret('resend_from');
  v_request_id bigint;
  v_status text;
  v_error text;
  v_log_id uuid;
BEGIN
  IF pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL
     OR v_key IS NULL OR v_from IS NULL THEN
    v_status := 'not_configured';
    v_error := 'missing:' || concat_ws(',',
      CASE WHEN pg_catalog.to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN 'pg_net' END,
      CASE WHEN v_key IS NULL THEN 'vault:resend_api_key' END,
      CASE WHEN v_from IS NULL THEN 'vault:resend_from' END);
  ELSE
    BEGIN
      EXECUTE 'SELECT net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := $4)'
        INTO v_request_id
        USING 'https://api.resend.com/emails',
              jsonb_build_object('from', v_from, 'to', jsonb_build_array(p_to),
                                 'subject', p_subject, 'html', p_html, 'text', p_text),
              jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
              10000;
      v_status := 'queued';
    EXCEPTION WHEN OTHERS THEN
      v_status := 'failed';
      v_error := left('pg_net enqueue failed: ' || SQLERRM, 500);
    END;
  END IF;

  INSERT INTO public.email_delivery_log (
    kind, to_email, subject, related_user_id, related_contract_id, provider,
    net_request_id, status, error_text
  ) VALUES (
    p_kind, p_to, p_subject, p_related_user_id, p_related_contract_id, 'resend',
    v_request_id, v_status, v_error
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$;

-- pg_cron 每分鐘跑：讀 net._http_response 更新寄送狀態；超過 1 小時沒有回應的標 failed。
CREATE OR REPLACE FUNCTION private.refresh_email_delivery_status()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer := 0;
  v_stale integer := 0;
BEGIN
  IF pg_catalog.to_regclass('net._http_response') IS NOT NULL THEN
    EXECUTE $q$
      UPDATE public.email_delivery_log l
         SET status = CASE WHEN r.status_code BETWEEN 200 AND 299 AND NOT COALESCE(r.timed_out, false)
                           THEN 'sent' ELSE 'failed' END,
             http_status = r.status_code,
             provider_message_id = CASE WHEN r.status_code BETWEEN 200 AND 299
                                        THEN private.safe_jsonb(r.content) ->> 'id' END,
             error_text = CASE WHEN r.status_code BETWEEN 200 AND 299 AND NOT COALESCE(r.timed_out, false) THEN NULL
                               ELSE left(COALESCE(r.error_msg, r.content, 'http request failed'), 500) END,
             updated_at = pg_catalog.now()
        FROM net._http_response r
       WHERE l.status = 'queued'
         AND l.net_request_id IS NOT NULL
         AND r.id = l.net_request_id
    $q$;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
  END IF;

  UPDATE public.email_delivery_log l
     SET status = 'failed',
         error_text = 'no response from pg_net within 1 hour',
         updated_at = pg_catalog.now()
   WHERE l.status = 'queued'
     AND l.requested_at < pg_catalog.now() - interval '1 hour';
  GET DIAGNOSTICS v_stale = ROW_COUNT;

  RETURN v_updated + v_stale;
END;
$$;

REVOKE ALL ON FUNCTION private.read_vault_secret(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.email_delivery_configured() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.enqueue_email(text, text, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.refresh_email_delivery_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.signing_account_state(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.request_client_meta() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.esign_doc_list(jsonb) FROM PUBLIC, anon, authenticated;

-- 4.6 寫一筆 pending 啟用紀錄（已有 pending/active 就不重複）
CREATE OR REPLACE FUNCTION private.open_pending_activation(p_user_id uuid, p_instructor_id uuid, p_method text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
  v_prev text;
BEGIN
  SELECT a.id INTO v_id
    FROM public.instructor_account_activations a
   WHERE a.user_id = p_user_id AND a.status IN ('pending', 'active')
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  v_prev := private.internal_write_begin();
  INSERT INTO public.instructor_account_activations (instructor_id, user_id, claim_method, claimed_at, status)
  VALUES (p_instructor_id, p_user_id, p_method, pg_catalog.now(), 'pending')
  RETURNING id INTO v_id;
  PERFORM private.internal_write_end(v_prev);
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION private.open_pending_activation(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- 4.7 雜湊鏈
CREATE OR REPLACE FUNCTION private.contract_fields_sha256(
  p_name text, p_instructor_role text, p_id_number text, p_address text, p_phone text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT encode(sha256(convert_to(jsonb_build_object(
    'filled_name', p_name,
    'filled_instructor_role', p_instructor_role,
    'filled_id_number', p_id_number,
    'filled_address', p_address,
    'filled_phone', p_phone
  )::text, 'UTF8')), 'hex');
$$;

-- 規範化 JSON：jsonb 的文字輸出鍵順序固定；時間一律轉成 UTC 固定格式，與 session 時區無關。
CREATE OR REPLACE FUNCTION private.contract_evidence_canonical(e public.contract_signing_evidence)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'id', e.id,
    'chain_seq', e.chain_seq,
    'contract_id', e.contract_id,
    'user_id', e.user_id,
    'instructor_id', e.instructor_id,
    'bound_email', e.bound_email,
    'doc_versions', e.doc_versions,
    'document_sha256', e.document_sha256,
    'signed_pdf_paths', e.signed_pdf_paths,
    'signed_pdf_sha256', e.signed_pdf_sha256,
    'signature_path', e.signature_path,
    'contract_fields_sha256', e.contract_fields_sha256,
    'consent_id', e.consent_id,
    'consent_at', private.utc_text(e.consent_at),
    'otp_challenge_id', e.otp_challenge_id,
    'otp_verified_at', private.utc_text(e.otp_verified_at),
    'signed_at', private.utc_text(e.signed_at),
    'ip_address', e.ip_address,
    'user_agent', e.user_agent,
    'previous_evidence_sha256', e.previous_evidence_sha256,
    'created_at', private.utc_text(e.created_at)
  )::text;
$$;

CREATE OR REPLACE FUNCTION private.evidence_hash(p_previous text, p_canonical text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT encode(sha256(convert_to(COALESCE(p_previous, '') || p_canonical, 'UTF8')), 'hex');
$$;

-- 驗證 jsonb {key: sha256} 並轉小寫；鍵集合必須剛好等於 p_keys。不合格回 NULL。
CREATE OR REPLACE FUNCTION private.normalize_sha256_map(p_map jsonb, p_keys text[])
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_out jsonb := '{}'::jsonb;
  v_item record;
  v_hex text;
BEGIN
  IF p_map IS NULL OR jsonb_typeof(p_map) <> 'object' THEN
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_map)) <> COALESCE(cardinality(p_keys), 0) THEN
    RETURN NULL;
  END IF;
  FOR v_item IN SELECT e.key, e.value FROM jsonb_each(p_map) e LOOP
    IF NOT (v_item.key = ANY (COALESCE(p_keys, ARRAY[]::text[]))) OR jsonb_typeof(v_item.value) <> 'string' THEN
      RETURN NULL;
    END IF;
    v_hex := lower(btrim(v_item.value #>> '{}'));
    IF v_hex !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;
    v_out := v_out || jsonb_build_object(v_item.key, v_hex);
  END LOOP;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION private.contract_fields_sha256(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.contract_evidence_canonical(public.contract_signing_evidence) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.evidence_hash(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.normalize_sha256_map(jsonb, text[]) FROM PUBLIC, anon, authenticated;

-- 4.8 範本／檔案是否已被簽署引用
CREATE OR REPLACE FUNCTION private.contract_document_is_referenced(p_doc_type text, p_version integer)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.instructor_contracts c
     WHERE (c.doc_versions ->> p_doc_type) = p_version::text
        OR (p_doc_type = 'rules' AND c.rules_doc_version = p_version AND p_version > 0)
        OR (p_doc_type = 'compensation' AND c.compensation_doc_version = p_version AND p_version > 0)
        OR (p_doc_type = 'contract' AND c.contract_doc_version = p_version AND p_version > 0)
  );
$$;

CREATE OR REPLACE FUNCTION private.contract_storage_object_is_locked(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((string_to_array(p_name, '/'))[1] = 'signed', false)
      OR EXISTS (
        SELECT 1 FROM public.contract_documents d
         WHERE d.file_path = p_name
           AND private.contract_document_is_referenced(d.doc_type, d.version)
      )
      OR EXISTS (
        SELECT 1 FROM public.instructor_contracts c
         WHERE c.signature_path = p_name
            OR c.signed_pdf_path = p_name
            OR EXISTS (SELECT 1 FROM jsonb_each_text(COALESCE(c.signed_pdf_paths, '{}'::jsonb)) p WHERE p.value = p_name)
      );
$$;

REVOKE ALL ON FUNCTION private.contract_document_is_referenced(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.contract_storage_object_is_locked(text) FROM PUBLIC, anon;
-- Storage 政策以登入者身分評估，需要 EXECUTE（private schema 不對 PostgREST 暴露）。
GRANT EXECUTE ON FUNCTION private.contract_storage_object_is_locked(text) TO authenticated;

-- ──────────────────────────────────────────────────────────────────
-- 5. 防竄改
-- ──────────────────────────────────────────────────────────────────
-- 判斷「內部流程」：旗標由 SECURITY DEFINER 函式打開，且執行身分（CURRENT_USER）不是 API 角色。
-- trigger 函式刻意用 SECURITY INVOKER，CURRENT_USER 才是真正下指令的角色。

-- 5.1 instructor_contracts：禁止 DELETE；INSERT 只能走 submit_my_contract；UPDATE 只允許內部的 signed → voided
CREATE OR REPLACE FUNCTION private.guard_instructor_contracts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_internal boolean := COALESCE(pg_catalog.current_setting('dreamone.internal_write', true), '') = 'on'
                        AND CURRENT_USER NOT IN ('anon', 'authenticated', 'service_role', 'authenticator');
  v_mutable text[] := ARRAY['status', 'voided_at', 'voided_reason', 'superseded_by'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_internal THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CONTRACT_WRITE_DENIED',
      DETAIL = '契約紀錄只能由 submit_my_contract 建立。';
  ELSIF TG_OP = 'UPDATE' THEN
    IF v_internal
       AND OLD.status = 'signed'
       AND NEW.status = 'voided'
       AND OLD.voided_at IS NULL
       AND NEW.voided_at IS NOT NULL
       AND NULLIF(btrim(NEW.voided_reason), '') IS NOT NULL
       AND (to_jsonb(NEW) - v_mutable) = (to_jsonb(OLD) - v_mutable) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CONTRACT_IMMUTABLE',
      DETAIL = '已簽契約只允許系統在重簽時由 signed 改為 voided，其他欄位不得變更。';
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'CONTRACT_IMMUTABLE',
    DETAIL = format('契約紀錄不得 %s（依簽署證據保存規定）。', TG_OP);
END;
$$;

-- 5.2 同意紀錄、簽署證據：append-only（INSERT 只能走內部流程；UPDATE／DELETE／TRUNCATE 一律拒絕）
CREATE OR REPLACE FUNCTION private.guard_append_only_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(pg_catalog.current_setting('dreamone.internal_write', true), '') = 'on'
       AND CURRENT_USER NOT IN ('anon', 'authenticated', 'service_role', 'authenticator') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'EVIDENCE_WRITE_DENIED',
      DETAIL = format('%s 只能由系統簽署流程寫入。', TG_TABLE_NAME);
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'EVIDENCE_IMMUTABLE',
    DETAIL = format('%s 為不可變更的簽署證據（%s 被拒）。', TG_TABLE_NAME, TG_OP);
END;
$$;

-- 5.3 啟用紀錄：INSERT／UPDATE 只能走內部流程；只允許 pending→active、pending→revoked、active→revoked；禁止 DELETE
CREATE OR REPLACE FUNCTION private.guard_account_activations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_internal boolean := COALESCE(pg_catalog.current_setting('dreamone.internal_write', true), '') = 'on'
                        AND CURRENT_USER NOT IN ('anon', 'authenticated', 'service_role', 'authenticator');
  v_activate_cols text[] := ARRAY['status', 'activation_email', 'otp_challenge_id', 'otp_verified_at', 'activated_at'];
  v_revoke_cols text[] := ARRAY['status', 'revoked_at', 'revoked_reason'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_internal AND NEW.status IN ('pending', 'active') AND NEW.revoked_at IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    IF v_internal THEN
      IF OLD.status = 'pending' AND NEW.status = 'active'
         AND NEW.activated_at IS NOT NULL
         AND (to_jsonb(NEW) - v_activate_cols) = (to_jsonb(OLD) - v_activate_cols) THEN
        RETURN NEW;
      END IF;
      IF OLD.status IN ('pending', 'active') AND NEW.status = 'revoked'
         AND NEW.revoked_at IS NOT NULL
         AND (to_jsonb(NEW) - v_revoke_cols) = (to_jsonb(OLD) - v_revoke_cols) THEN
        RETURN NEW;
      END IF;
    END IF;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ACTIVATION_RECORD_IMMUTABLE',
    DETAIL = format('啟用紀錄只能由系統流程建立與轉換狀態（%s 被拒）。', TG_OP);
END;
$$;

-- 5.4 法規文案：append-only（INSERT 不限內部流程，但只有擁有者／migration 有 INSERT 權限）
CREATE OR REPLACE FUNCTION private.guard_esign_text_versions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := pg_catalog.now();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'ESIGN_TEXT_IMMUTABLE',
    DETAIL = '法規文案版本不可修改或刪除；改版請新增新的版本代碼（例如 -v2）。';
END;
$$;

-- 5.5 contract_documents：被簽署引用的版本不可刪、不可改 doc_type／version／file_path，content_sha256 只能 NULL→值
CREATE OR REPLACE FUNCTION private.guard_contract_documents()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    NEW.content_sha256 := NULLIF(lower(btrim(NEW.content_sha256)), '');
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF private.contract_document_is_referenced(OLD.doc_type, OLD.version) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DOCUMENT_REFERENCED',
        DETAIL = '此文件版本已被簽署契約引用，依簽署證據保存規定不可刪除。';
    END IF;
    IF NEW.doc_type IS DISTINCT FROM OLD.doc_type
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.file_path IS DISTINCT FROM OLD.file_path
       OR (OLD.content_sha256 IS NOT NULL AND NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DOCUMENT_REFERENCED',
        DETAIL = '此文件版本已被簽署契約引用，不可修改檔案路徑、版本或檔案雜湊。';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- 5.6 解除綁定（任何途徑把 instructors.user_id 改掉）就撤銷該帳號的 pending／active 啟用紀錄
CREATE OR REPLACE FUNCTION private.revoke_activation_on_unlink()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev text;
BEGIN
  IF OLD.user_id IS NOT NULL AND NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    v_prev := private.internal_write_begin();
    UPDATE public.instructor_account_activations a
       SET status = 'revoked',
           revoked_at = pg_catalog.now(),
           revoked_reason = 'instructor_unlinked'
     WHERE a.user_id = OLD.user_id
       AND a.status IN ('pending', 'active');
    PERFORM private.internal_write_end(v_prev);
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.guard_instructor_contracts() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_append_only_evidence() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_account_activations() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_esign_text_versions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_contract_documents() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.revoke_activation_on_unlink() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_contracts ON public.instructor_contracts;
CREATE TRIGGER trg_guard_instructor_contracts
BEFORE INSERT OR UPDATE OR DELETE ON public.instructor_contracts
FOR EACH ROW EXECUTE FUNCTION private.guard_instructor_contracts();
DROP TRIGGER IF EXISTS trg_guard_instructor_contracts_truncate ON public.instructor_contracts;
CREATE TRIGGER trg_guard_instructor_contracts_truncate
BEFORE TRUNCATE ON public.instructor_contracts
FOR EACH STATEMENT EXECUTE FUNCTION private.guard_instructor_contracts();

DROP TRIGGER IF EXISTS trg_guard_contract_consent_records ON public.contract_consent_records;
CREATE TRIGGER trg_guard_contract_consent_records
BEFORE INSERT OR UPDATE OR DELETE ON public.contract_consent_records
FOR EACH ROW EXECUTE FUNCTION private.guard_append_only_evidence();
DROP TRIGGER IF EXISTS trg_guard_contract_consent_records_truncate ON public.contract_consent_records;
CREATE TRIGGER trg_guard_contract_consent_records_truncate
BEFORE TRUNCATE ON public.contract_consent_records
FOR EACH STATEMENT EXECUTE FUNCTION private.guard_append_only_evidence();

DROP TRIGGER IF EXISTS trg_guard_contract_signing_evidence ON public.contract_signing_evidence;
CREATE TRIGGER trg_guard_contract_signing_evidence
BEFORE INSERT OR UPDATE OR DELETE ON public.contract_signing_evidence
FOR EACH ROW EXECUTE FUNCTION private.guard_append_only_evidence();
DROP TRIGGER IF EXISTS trg_guard_contract_signing_evidence_truncate ON public.contract_signing_evidence;
CREATE TRIGGER trg_guard_contract_signing_evidence_truncate
BEFORE TRUNCATE ON public.contract_signing_evidence
FOR EACH STATEMENT EXECUTE FUNCTION private.guard_append_only_evidence();

DROP TRIGGER IF EXISTS trg_guard_account_activations ON public.instructor_account_activations;
CREATE TRIGGER trg_guard_account_activations
BEFORE INSERT OR UPDATE OR DELETE ON public.instructor_account_activations
FOR EACH ROW EXECUTE FUNCTION private.guard_account_activations();
DROP TRIGGER IF EXISTS trg_guard_account_activations_truncate ON public.instructor_account_activations;
CREATE TRIGGER trg_guard_account_activations_truncate
BEFORE TRUNCATE ON public.instructor_account_activations
FOR EACH STATEMENT EXECUTE FUNCTION private.guard_account_activations();

DROP TRIGGER IF EXISTS trg_guard_esign_text_versions ON public.esign_text_versions;
CREATE TRIGGER trg_guard_esign_text_versions
BEFORE INSERT OR UPDATE OR DELETE ON public.esign_text_versions
FOR EACH ROW EXECUTE FUNCTION private.guard_esign_text_versions();
DROP TRIGGER IF EXISTS trg_guard_esign_text_versions_truncate ON public.esign_text_versions;
CREATE TRIGGER trg_guard_esign_text_versions_truncate
BEFORE TRUNCATE ON public.esign_text_versions
FOR EACH STATEMENT EXECUTE FUNCTION private.guard_esign_text_versions();

DROP TRIGGER IF EXISTS trg_guard_contract_documents ON public.contract_documents;
CREATE TRIGGER trg_guard_contract_documents
BEFORE INSERT OR UPDATE OR DELETE ON public.contract_documents
FOR EACH ROW EXECUTE FUNCTION private.guard_contract_documents();

DROP TRIGGER IF EXISTS trg_revoke_activation_on_unlink ON public.instructors;
CREATE TRIGGER trg_revoke_activation_on_unlink
AFTER UPDATE OF user_id ON public.instructors
FOR EACH ROW EXECUTE FUNCTION private.revoke_activation_on_unlink();

-- 5.7 Storage：restrictive 政策與既有 permissive 政策 AND，任何人（含 admin）都不能改／刪 signed/ 與被引用的檔案。
--     service_role（BYPASSRLS）不受 RLS 約束，見檔頭誠實條款；被換檔可由檔案雜湊比對發現。
DROP POLICY IF EXISTS "contract evidence objects are immutable (update)" ON storage.objects;
CREATE POLICY "contract evidence objects are immutable (update)"
  ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (bucket_id IS DISTINCT FROM 'contract-documents' OR NOT private.contract_storage_object_is_locked(name))
  WITH CHECK (bucket_id IS DISTINCT FROM 'contract-documents' OR NOT private.contract_storage_object_is_locked(name));

DROP POLICY IF EXISTS "contract evidence objects are immutable (delete)" ON storage.objects;
CREATE POLICY "contract evidence objects are immutable (delete)"
  ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated
  USING (bucket_id IS DISTINCT FROM 'contract-documents' OR NOT private.contract_storage_object_is_locked(name));

-- ──────────────────────────────────────────────────────────────────
-- 6. RPC
-- ──────────────────────────────────────────────────────────────────

-- 6.1 啟用狀態
CREATE OR REPLACE FUNCTION public.get_my_activation_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_status text;
  v_method text;
  v_instructor_id uuid;
  v_email text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  SELECT a.status, a.claim_method
    INTO v_status, v_method
    FROM public.instructor_account_activations a
   WHERE a.user_id = v_uid AND a.status IN ('pending', 'active')
   ORDER BY a.claimed_at DESC
   LIMIT 1;

  SELECT i.id, i.confirmed_email
    INTO v_instructor_id, v_email
    FROM public.instructors i
   WHERE i.user_id = v_uid
   LIMIT 1;

  RETURN jsonb_build_object(
    'status', COALESCE(v_status, 'none'),
    'claim_method', v_method,
    'has_confirmed_email', v_email IS NOT NULL,
    'masked_email', private.mask_email(v_email),
    'profile_complete', CASE WHEN v_instructor_id IS NULL THEN false
                             ELSE COALESCE(private.instructor_profile_is_complete(v_instructor_id), false) END
  );
END;
$$;

-- 6.2 寄送 OTP
CREATE OR REPLACE FUNCTION public.request_email_otp(p_purpose text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_purpose text := btrim(COALESCE(p_purpose, ''));
  v_now timestamptz := pg_catalog.now();
  v_role text;
  v_instructor_id uuid;
  v_email text;
  v_employment text;
  v_signing_active boolean;
  v_last timestamptz;
  v_recent integer;
  v_kind text;
  v_rand bigint;
  v_code text;
  v_salt text;
  v_challenge_id uuid;
  v_expires timestamptz;
  v_delivery_id uuid;
  v_delivery_status text;
  v_subject text := '夢想一號講師資源站驗證碼';
  v_purpose_line text;
  v_extra text;
  v_pending_email text;
  v_text text;
  v_html text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  IF v_purpose NOT IN ('account_activation', 'contract_sign') THEN
    RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'invalid_purpose');
  END IF;

  -- 同一人同時只處理一個寄送請求，避免冷卻與每小時上限被併發繞過
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('request_email_otp'), pg_catalog.hashtext(v_uid::text));

  SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;
  SELECT i.id, i.confirmed_email, i.employment_status::text
    INTO v_instructor_id, v_email, v_employment
    FROM public.instructors i
   WHERE i.user_id = v_uid
   LIMIT 1;

  IF v_purpose = 'account_activation' THEN
    IF v_role IS NULL OR v_role NOT IN ('pending', 'teacher') THEN
      RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'role_not_allowed');
    END IF;
    IF v_instructor_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.instructor_account_activations a
       WHERE a.user_id = v_uid AND a.status = 'pending' AND a.instructor_id = v_instructor_id
    ) THEN
      RETURN jsonb_build_object('status', 'not_allowed', 'reason',
        CASE WHEN EXISTS (SELECT 1 FROM public.instructor_account_activations a
                           WHERE a.user_id = v_uid AND a.status = 'active')
             THEN 'already_active' ELSE 'no_pending_activation' END);
    END IF;
    IF v_employment IN ('frozen', 'cancelled') THEN
      RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'instructor_disabled');
    END IF;
    IF v_email IS NULL THEN
      RETURN jsonb_build_object('status', 'no_confirmed_email');
    END IF;
    IF NOT COALESCE(private.instructor_profile_is_complete(v_instructor_id), false) THEN
      RETURN jsonb_build_object('status', 'profile_incomplete');
    END IF;
    v_kind := 'otp_activation';
    v_purpose_line := '這組驗證碼用來確認是你本人要啟用夢想一號講師資源站帳號，5 分鐘內有效，只能使用一次。請不要把驗證碼告訴任何人，本公司人員不會向你索取。';
  ELSE
    SELECT s.is_active INTO v_signing_active FROM private.signing_account_state(v_uid) s;
    IF NOT COALESCE(v_signing_active, false) THEN
      RETURN jsonb_build_object('status', 'not_allowed', 'reason', 'account_not_active');
    END IF;
    IF v_email IS NULL THEN
      RETURN jsonb_build_object('status', 'no_confirmed_email');
    END IF;
    v_kind := 'otp_contract';
    SELECT t.content INTO v_extra FROM public.esign_text_versions t WHERE t.version_code = 'esign-otp-email-v1';
    v_purpose_line := COALESCE(v_extra,
      '這組驗證碼用來確認是你本人要簽署夢想一號的講師合作文件，5 分鐘內有效。請不要把驗證碼告訴任何人。');
  END IF;

  -- 同目的 60 秒冷卻
  SELECT max(c.created_at) INTO v_last
    FROM private.email_otp_challenges c
   WHERE c.user_id = v_uid AND c.purpose = v_purpose;
  IF v_last IS NOT NULL AND v_last > v_now - interval '60 seconds' THEN
    -- 冷卻中：一併帶回本人同一用途最新一筆仍可輸入的 challenge（未過期、未作廢、未驗證／消耗、未鎖），
    -- 讓使用者關掉視窗再打開還能輸入剛寄出的碼；沒有就不帶。只查 user_id = 本人。
    SELECT c.id, c.expires_at, c.target_email
      INTO v_challenge_id, v_expires, v_pending_email
      FROM private.email_otp_challenges c
     WHERE c.user_id = v_uid
       AND c.purpose = v_purpose
       AND c.superseded_at IS NULL
       AND c.verified_at IS NULL
       AND c.consumed_at IS NULL
       AND c.attempts < c.max_attempts
       AND c.expires_at > v_now
     ORDER BY c.created_at DESC
     LIMIT 1;
    RETURN jsonb_build_object('status', 'cooldown',
      'retry_after_seconds', GREATEST(1, ceil(60 - extract(epoch FROM (v_now - v_last))))::integer)
      || CASE WHEN v_challenge_id IS NULL THEN '{}'::jsonb
              ELSE jsonb_build_object('challenge_id', v_challenge_id, 'expires_at', v_expires,
                                      'masked_email', private.mask_email(v_pending_email)) END;
  END IF;

  -- 每人每小時最多 5 封（兩種目的合計）
  SELECT count(*) INTO v_recent
    FROM private.email_otp_challenges c
   WHERE c.user_id = v_uid AND c.created_at > v_now - interval '1 hour';
  IF v_recent >= 5 THEN
    RETURN jsonb_build_object('status', 'rate_limited');
  END IF;

  -- 寄信設定缺任一項：只記 not_configured，不產生驗證碼
  IF NOT private.email_delivery_configured() THEN
    PERFORM private.enqueue_email(v_kind, v_email, v_subject, NULL, NULL, v_uid, NULL);
    RETURN jsonb_build_object('status', 'email_not_configured');
  END IF;

  -- 新寄出後舊的作廢
  UPDATE private.email_otp_challenges c
     SET superseded_at = v_now
   WHERE c.user_id = v_uid
     AND c.purpose = v_purpose
     AND c.consumed_at IS NULL
     AND c.superseded_at IS NULL;

  -- 6 位數：取 gen_random_uuid()（PostgreSQL 的強隨機來源）前 48 bit 取模
  v_rand := ('x' || substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint;
  v_code := lpad((v_rand % 1000000)::text, 6, '0');
  v_salt := replace(pg_catalog.gen_random_uuid()::text, '-', '') || replace(pg_catalog.gen_random_uuid()::text, '-', '');
  v_expires := v_now + interval '5 minutes';

  INSERT INTO private.email_otp_challenges (
    user_id, purpose, target_email, code_hash, salt, created_at, expires_at, attempts, max_attempts
  ) VALUES (
    v_uid, v_purpose, v_email,
    encode(sha256(convert_to(v_salt || ':' || v_code, 'UTF8')), 'hex'),
    v_salt, v_now, v_expires, 0, 5
  )
  RETURNING id INTO v_challenge_id;

  v_text := '你的驗證碼：' || v_code || E'\n\n'
         || v_purpose_line || E'\n'
         || '若非本人操作請忽略並通知行政。' || E'\n\n'
         || '夢想一號講師資源站（系統自動寄出）';
  v_html := '<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#222">'
         || '<p>你的驗證碼：</p>'
         || '<p style="font-size:28px;font-weight:bold;letter-spacing:6px;margin:8px 0">' || v_code || '</p>'
         || '<p>' || private.html_escape(v_purpose_line) || '</p>'
         || '<p>若非本人操作請忽略並通知行政。</p>'
         || '<p style="color:#888;font-size:13px">夢想一號講師資源站（系統自動寄出）</p></div>';

  v_delivery_id := private.enqueue_email(v_kind, v_email, v_subject, v_html, v_text, v_uid, NULL);
  v_code := NULL;
  v_text := NULL;
  v_html := NULL;

  UPDATE private.email_otp_challenges c SET delivery_id = v_delivery_id WHERE c.id = v_challenge_id;

  SELECT l.status INTO v_delivery_status FROM public.email_delivery_log l WHERE l.id = v_delivery_id;
  IF v_delivery_status IS DISTINCT FROM 'queued' THEN
    UPDATE private.email_otp_challenges c SET superseded_at = v_now WHERE c.id = v_challenge_id;
    RETURN jsonb_build_object('status', 'email_not_configured');
  END IF;

  RETURN jsonb_build_object(
    'status', 'sent',
    'challenge_id', v_challenge_id,
    'expires_at', v_expires,
    'masked_email', private.mask_email(v_email),
    'resend_after_seconds', 60
  );
END;
$$;

-- 6.3 驗證 OTP
CREATE OR REPLACE FUNCTION public.verify_email_otp(p_challenge_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_code text := btrim(COALESCE(p_code, ''));
  v_now timestamptz := pg_catalog.now();
  v_ch private.email_otp_challenges%ROWTYPE;
  v_attempts integer;
  v_instructor_id uuid;
  v_confirmed text;
  v_employment text;
  v_role text;
  v_activation_id uuid;
  v_activation_instructor uuid;
  v_activated boolean := false;
  v_prev text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  -- 只找自己的 challenge；別人的 challenge_id 一律當作不存在（不累計對方的錯誤次數）
  SELECT c.* INTO v_ch
    FROM private.email_otp_challenges c
   WHERE c.id = p_challenge_id AND c.user_id = v_uid
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'invalid', 'attempts_remaining', 0);
  END IF;

  IF v_ch.superseded_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'superseded');
  END IF;
  IF v_ch.verified_at IS NOT NULL OR v_ch.consumed_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'used');
  END IF;
  IF v_ch.attempts >= v_ch.max_attempts THEN
    RETURN jsonb_build_object('status', 'locked');
  END IF;
  IF v_ch.expires_at <= v_now THEN
    RETURN jsonb_build_object('status', 'expired');
  END IF;

  SELECT i.id, i.confirmed_email, i.employment_status::text
    INTO v_instructor_id, v_confirmed, v_employment
    FROM public.instructors i
   WHERE i.user_id = v_uid
   LIMIT 1;

  -- 寄出後管理員改了已確認 Email：舊碼作廢
  IF v_confirmed IS DISTINCT FROM v_ch.target_email THEN
    UPDATE private.email_otp_challenges c SET superseded_at = v_now WHERE c.id = v_ch.id;
    RETURN jsonb_build_object('status', 'superseded');
  END IF;

  IF v_code !~ '^[0-9]{6}$'
     OR encode(sha256(convert_to(v_ch.salt || ':' || v_code, 'UTF8')), 'hex') <> v_ch.code_hash THEN
    v_attempts := v_ch.attempts + 1;
    UPDATE private.email_otp_challenges c SET attempts = v_attempts WHERE c.id = v_ch.id;
    IF v_attempts >= v_ch.max_attempts THEN
      RETURN jsonb_build_object('status', 'locked');
    END IF;
    RETURN jsonb_build_object('status', 'invalid', 'attempts_remaining', v_ch.max_attempts - v_attempts);
  END IF;

  IF v_ch.purpose = 'account_activation' THEN
    -- 啟用碼一次性：驗證當下就消耗
    UPDATE private.email_otp_challenges c SET verified_at = v_now, consumed_at = v_now WHERE c.id = v_ch.id;

    SELECT u.role INTO v_role FROM public.users u WHERE u.id = v_uid;
    SELECT a.id, a.instructor_id INTO v_activation_id, v_activation_instructor
      FROM public.instructor_account_activations a
     WHERE a.user_id = v_uid AND a.status = 'pending'
     LIMIT 1
     FOR UPDATE;

    IF v_role IN ('pending', 'teacher')
       AND v_activation_id IS NOT NULL
       AND v_activation_instructor IS NOT DISTINCT FROM v_instructor_id
       AND v_instructor_id IS NOT NULL
       AND v_employment IS DISTINCT FROM 'frozen'
       AND v_employment IS DISTINCT FROM 'cancelled'
       AND COALESCE(private.instructor_profile_is_complete(v_instructor_id), false) THEN
      v_prev := private.internal_write_begin();
      UPDATE public.instructor_account_activations a
         SET status = 'active',
             otp_challenge_id = v_ch.id,
             otp_verified_at = v_now,
             activated_at = v_now,
             activation_email = v_ch.target_email
       WHERE a.id = v_activation_id;
      PERFORM private.internal_write_end(v_prev);

      UPDATE public.users u SET role = 'teacher' WHERE u.id = v_uid AND u.role = 'pending';
      v_activated := true;
    END IF;
  ELSE
    -- 簽約碼：驗證後 15 分鐘內由 submit_my_contract 消耗
    UPDATE private.email_otp_challenges c SET verified_at = v_now WHERE c.id = v_ch.id;
  END IF;

  RETURN jsonb_build_object('status', 'verified', 'verified_at', v_now, 'activated', v_activated);
END;
$$;

-- 6.4 電子簽約同意／不同意（append-only）；文案全文依版本代碼由資料庫抄入
CREATE OR REPLACE FUNCTION public.record_contract_consent(
  p_decision text,
  p_doc_versions jsonb,
  p_consent_text_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := btrim(COALESCE(p_decision, ''));
  v_version text := btrim(COALESCE(p_consent_text_version, ''));
  v_active boolean;
  v_instructor_id uuid;
  v_email text;
  v_full_name text;
  v_content text;
  v_text text;
  v_ip text;
  v_ua text;
  v_id uuid;
  v_created timestamptz;
  v_prev text;
  v_user_name text;
  -- 同意頁上同時顯示的個資告知：前端參數不變，由資料庫固定帶入目前版本（改版時改這裡並新增 -v2 文案）
  v_privacy_version constant text := 'esign-privacy-notice-v1';
  v_privacy_content text;
  v_privacy_text text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  SELECT s.is_active, s.instructor_id, s.confirmed_email, s.full_name
    INTO v_active, v_instructor_id, v_email, v_full_name
    FROM private.signing_account_state(v_uid) s;
  IF NOT COALESCE(v_active, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ACCOUNT_NOT_ACTIVE';
  END IF;

  IF v_decision NOT IN ('agree_electronic', 'decline_electronic')
     OR p_doc_versions IS NULL OR jsonb_typeof(p_doc_versions) <> 'object'
     OR char_length(p_doc_versions::text) > 4000
     OR v_version = '' OR char_length(v_version) > 64 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_INPUT';
  END IF;

  SELECT t.content INTO v_content FROM public.esign_text_versions t WHERE t.version_code = v_version;
  IF v_content IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CONSENT_TEXT_UNKNOWN';
  END IF;

  SELECT t.content INTO v_privacy_content FROM public.esign_text_versions t WHERE t.version_code = v_privacy_version;
  IF v_privacy_content IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CONSENT_TEXT_UNKNOWN';
  END IF;

  v_text := private.render_esign_text(v_content, jsonb_build_object(
    'doc_list', private.esign_doc_list(p_doc_versions),
    'masked_email', private.mask_email(v_email),
    'instructor_name', v_full_name
  ));
  v_privacy_text := private.render_esign_text(v_privacy_content, jsonb_build_object(
    'doc_list', private.esign_doc_list(p_doc_versions),
    'masked_email', private.mask_email(v_email),
    'instructor_name', v_full_name
  ));

  SELECT m.ip_address, m.user_agent INTO v_ip, v_ua FROM private.request_client_meta() m;

  v_prev := private.internal_write_begin();
  INSERT INTO public.contract_consent_records (
    user_id, instructor_id, decision, consent_text_version, consent_text, doc_versions,
    ip_address, user_agent, created_at, privacy_notice_version, privacy_notice_text
  ) VALUES (
    v_uid, v_instructor_id, v_decision, v_version, v_text, p_doc_versions,
    v_ip, v_ua, pg_catalog.now(), v_privacy_version, v_privacy_text
  )
  RETURNING id, created_at INTO v_id, v_created;
  PERFORM private.internal_write_end(v_prev);

  IF v_decision = 'decline_electronic' THEN
    SELECT COALESCE(NULLIF(btrim(v_full_name), ''), NULLIF(btrim(u.name), ''), u.email)
      INTO v_user_name
      FROM public.users u WHERE u.id = v_uid;
    INSERT INTO public.notifications (user_id, type, title, body, link)
    SELECT admin_row.id, 'contract', '講師選擇改以紙本簽約',
           COALESCE(v_user_name, '一位講師') || ' 不同意以電子方式簽署（'
             || COALESCE(private.esign_doc_list(p_doc_versions), '本次文件') || '），請安排紙本簽約。',
           '/admin/contracts'
      FROM public.users admin_row
     WHERE admin_row.role = 'admin';
  END IF;

  RETURN jsonb_build_object('status', 'recorded', 'consent_id', v_id, 'created_at', v_created);
END;
$$;

-- 6.5 submit_my_contract v2：移除所有舊多載後重建
DO $$
DECLARE
  old_function record;
BEGIN
  FOR old_function IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'submit_my_contract'
  LOOP
    EXECUTE format('DROP FUNCTION %s', old_function.signature);
  END LOOP;
END;
$$;

CREATE FUNCTION public.submit_my_contract(
  p_filled_name text,
  p_filled_instructor_role text,
  p_filled_id_number text,
  p_filled_address text,
  p_filled_phone text,
  p_signature_path text,
  p_signed_pdf_paths jsonb,
  p_doc_versions jsonb,
  p_user_agent text DEFAULT NULL,
  p_otp_challenge_id uuid DEFAULT NULL,
  p_consent_id uuid DEFAULT NULL,
  p_document_sha256 jsonb DEFAULT NULL,
  p_signed_pdf_sha256 jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now timestamptz := pg_catalog.now();
  v_active boolean;
  v_instructor_id uuid;
  v_bound_email text;
  v_name text := NULLIF(btrim(p_filled_name), '');
  v_instructor_role text := NULLIF(btrim(p_filled_instructor_role), '');
  v_id_number text := NULLIF(btrim(p_filled_id_number), '');
  v_address text := NULLIF(btrim(p_filled_address), '');
  v_phone text := NULLIF(btrim(p_filled_phone), '');
  v_param_ua text := NULLIF(left(btrim(COALESCE(p_user_agent, '')), 500), '');
  v_consent public.contract_consent_records%ROWTYPE;
  v_ch private.email_otp_challenges%ROWTYPE;
  v_doc record;
  v_active_types text[] := ARRAY[]::text[];
  v_pdf_keys text[];
  v_doc_hashes jsonb;
  v_pdf_hashes jsonb;
  v_prefix text;
  v_path text;
  v_ip text;
  v_ua text;
  v_contract_id uuid := pg_catalog.gen_random_uuid();
  v_ev public.contract_signing_evidence%ROWTYPE;
  v_prev_hash text;
  v_prev_seq bigint;
  v_prev_write text;
  v_template text;
  v_body text;
  v_subject text;
  v_html text;
  v_vars jsonb;
  v_download_url text;
BEGIN
  -- a. 必須登入
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  -- b. 帳號必須已啟用（teacher 要有 active 啟用紀錄）並綁定未停用的講師主檔
  SELECT s.is_active, s.instructor_id, s.confirmed_email
    INTO v_active, v_instructor_id, v_bound_email
    FROM private.signing_account_state(v_uid) s;
  IF NOT COALESCE(v_active, false) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'ACCOUNT_NOT_ACTIVE';
  END IF;

  -- c. 輸入清洗與長度限制
  IF v_name IS NULL OR v_instructor_role IS NULL OR v_id_number IS NULL
     OR v_address IS NULL OR v_phone IS NULL
     OR char_length(v_id_number) <> 10
     OR char_length(v_name) > 100
     OR char_length(v_instructor_role) > 50
     OR char_length(v_address) > 300
     OR char_length(v_phone) > 30
     OR p_signature_path IS NULL
     OR p_signed_pdf_paths IS NULL OR jsonb_typeof(p_signed_pdf_paths) <> 'object'
     OR p_doc_versions IS NULL OR jsonb_typeof(p_doc_versions) <> 'object'
     OR char_length(p_signed_pdf_paths::text) > 8000
     OR char_length(p_doc_versions::text) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_INPUT';
  END IF;

  -- d. 電子簽約同意：本人、agree、2 小時內、doc_versions 與送出時一致
  IF p_consent_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CONSENT_REQUIRED';
  END IF;
  SELECT r.* INTO v_consent
    FROM public.contract_consent_records r
   WHERE r.id = p_consent_id AND r.user_id = v_uid;
  IF NOT FOUND
     OR v_consent.decision <> 'agree_electronic'
     OR v_consent.created_at < v_now - interval '2 hours'
     OR v_consent.doc_versions IS DISTINCT FROM p_doc_versions THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'CONSENT_REQUIRED';
  END IF;

  -- e. 簽約 OTP：本人、contract_sign、已驗證、未消耗、驗證後 15 分鐘內、寄送信箱仍是已確認 Email
  IF p_otp_challenge_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OTP_REQUIRED';
  END IF;
  SELECT c.* INTO v_ch
    FROM private.email_otp_challenges c
   WHERE c.id = p_otp_challenge_id AND c.user_id = v_uid AND c.purpose = 'contract_sign'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OTP_REQUIRED';
  END IF;
  IF v_ch.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OTP_ALREADY_USED';
  END IF;
  IF v_ch.verified_at IS NULL OR v_ch.superseded_at IS NOT NULL
     OR v_ch.target_email IS DISTINCT FROM v_bound_email THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OTP_REQUIRED';
  END IF;
  IF v_ch.verified_at < v_now - interval '15 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'OTP_EXPIRED';
  END IF;

  -- f. 文件版本：每種啟用中的契約文件，送來的版本必須等於目前啟用版本（行政表單 doc_category='form' 除外）
  IF NOT EXISTS (
    SELECT 1 FROM public.contract_documents document_row
     WHERE document_row.is_active = true
       AND COALESCE(to_jsonb(document_row) ->> 'doc_category', 'contract') <> 'form'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NO_ACTIVE_DOCUMENTS';
  END IF;

  FOR v_doc IN
    SELECT DISTINCT ON (document_row.doc_type)
           document_row.doc_type, document_row.version, document_row.doc_mode
      FROM public.contract_documents document_row
     WHERE document_row.is_active = true
       AND COALESCE(to_jsonb(document_row) ->> 'doc_category', 'contract') <> 'form'
     ORDER BY document_row.doc_type, document_row.version DESC
  LOOP
    v_active_types := v_active_types || v_doc.doc_type;
    IF (p_doc_versions ->> v_doc.doc_type) IS DISTINCT FROM v_doc.version::text THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DOC_VERSION_MISMATCH';
    END IF;
    IF v_doc.doc_mode = 'fill_sign'
       AND NULLIF(p_signed_pdf_paths ->> v_doc.doc_type, '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SIGNED_PDF_MISSING';
    END IF;
  END LOOP;

  -- g. 檔案雜湊：範本雜湊要涵蓋所有啟用文件、成品雜湊要涵蓋所有 signed_pdf_paths；格式 64 碼 hex
  v_doc_hashes := private.normalize_sha256_map(p_document_sha256, v_active_types);
  SELECT COALESCE(array_agg(k), ARRAY[]::text[]) INTO v_pdf_keys FROM jsonb_object_keys(p_signed_pdf_paths) AS k;
  v_pdf_hashes := private.normalize_sha256_map(p_signed_pdf_sha256, v_pdf_keys);
  IF v_doc_hashes IS NULL OR v_pdf_hashes IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HASH';
  END IF;

  FOR v_doc IN
    SELECT DISTINCT ON (document_row.doc_type)
           document_row.doc_type, document_row.content_sha256
      FROM public.contract_documents document_row
     WHERE document_row.is_active = true
       AND COALESCE(to_jsonb(document_row) ->> 'doc_category', 'contract') <> 'form'
     ORDER BY document_row.doc_type, document_row.version DESC
  LOOP
    IF v_doc.content_sha256 IS NOT NULL
       AND (v_doc_hashes ->> v_doc.doc_type) IS DISTINCT FROM v_doc.content_sha256 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DOC_HASH_MISMATCH';
    END IF;
  END LOOP;

  -- h. 檔案路徑：只能是自己 signed/<uid>/ 底下、副檔名正確、且確實已上傳
  v_prefix := 'signed/' || v_uid::text || '/';

  IF left(p_signature_path, char_length(v_prefix)) <> v_prefix
     OR position('..' IN p_signature_path) > 0
     OR right(p_signature_path, 4) <> '.png'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects object_row
        WHERE object_row.bucket_id = 'contract-documents'
          AND object_row.name = p_signature_path
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FILE_NOT_UPLOADED';
  END IF;

  FOR v_path IN
    SELECT path_item.value FROM jsonb_each_text(p_signed_pdf_paths) AS path_item(key, value)
  LOOP
    IF v_path IS NULL
       OR left(v_path, char_length(v_prefix)) <> v_prefix
       OR position('..' IN v_path) > 0
       OR right(v_path, 4) <> '.pdf'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects object_row
          WHERE object_row.bucket_id = 'contract-documents'
            AND object_row.name = v_path
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FILE_NOT_UPLOADED';
    END IF;
  END LOOP;

  -- i. IP／UA 由伺服器端 header 取得（前端 UA 參數只當後備）；時間一律 now()
  SELECT m.ip_address, m.user_agent INTO v_ip, v_ua FROM private.request_client_meta() m;
  v_ua := COALESCE(v_ua, v_param_ua);

  -- j. 同一交易：消耗 OTP → 新增新約 → 作廢舊約 → 寫證據（雜湊鏈）→ 排入通知信
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('submit_my_contract'),
    pg_catalog.hashtext(v_uid::text)
  );

  UPDATE private.email_otp_challenges c SET consumed_at = v_now WHERE c.id = v_ch.id;

  -- 證據 id 先決定，新約建立時就寫好 evidence_id，已簽契約之後不必再 UPDATE
  v_ev.id := pg_catalog.gen_random_uuid();

  v_prev_write := private.internal_write_begin();

  INSERT INTO public.instructor_contracts (
    id, user_id,
    filled_name, filled_instructor_role, filled_id_number, filled_address, filled_phone,
    signature_path,
    rules_doc_version, compensation_doc_version, contract_doc_version,
    doc_versions, signed_pdf_paths, signed_pdf_path,
    signed_at, ip_address, user_agent,
    verified_at, verify_method, status,
    instructor_id, bound_email, consent_id, otp_challenge_id, otp_verified_at,
    document_sha256, signed_pdf_sha256, evidence_id
  )
  VALUES (
    v_contract_id, v_uid,
    v_name, v_instructor_role, v_id_number, v_address, v_phone,
    p_signature_path,
    CASE WHEN (p_doc_versions ->> 'rules') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'rules')::integer ELSE 0 END,
    CASE WHEN (p_doc_versions ->> 'compensation') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'compensation')::integer ELSE 0 END,
    CASE WHEN (p_doc_versions ->> 'contract') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'contract')::integer ELSE 0 END,
    p_doc_versions,
    p_signed_pdf_paths,
    (SELECT path_item.value
       FROM jsonb_each_text(p_signed_pdf_paths) WITH ORDINALITY AS path_item(key, value, ordinality)
      ORDER BY path_item.ordinality
      LIMIT 1),
    v_now, v_ip, v_ua,
    v_ch.verified_at, 'email_otp', 'signed',
    v_instructor_id, v_bound_email, v_consent.id, v_ch.id, v_ch.verified_at,
    v_doc_hashes, v_pdf_hashes, v_ev.id
  );

  UPDATE public.instructor_contracts contract_row
     SET status = 'voided',
         voided_at = v_now,
         voided_reason = 'superseded_by_new_signature',
         superseded_by = v_contract_id
   WHERE contract_row.user_id = v_uid
     AND contract_row.status = 'signed'
     AND contract_row.id <> v_contract_id;

  -- 全域鎖：證據鏈一次只接一筆
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('contract_signing_evidence_chain'));
  SELECT e.evidence_sha256, e.chain_seq INTO v_prev_hash, v_prev_seq
    FROM public.contract_signing_evidence e
   ORDER BY e.chain_seq DESC
   LIMIT 1;

  v_ev.chain_seq := COALESCE(v_prev_seq, 0) + 1;
  v_ev.contract_id := v_contract_id;
  v_ev.user_id := v_uid;
  v_ev.instructor_id := v_instructor_id;
  v_ev.bound_email := v_bound_email;
  v_ev.doc_versions := p_doc_versions;
  v_ev.document_sha256 := v_doc_hashes;
  v_ev.signed_pdf_paths := p_signed_pdf_paths;
  v_ev.signed_pdf_sha256 := v_pdf_hashes;
  v_ev.signature_path := p_signature_path;
  v_ev.contract_fields_sha256 := private.contract_fields_sha256(v_name, v_instructor_role, v_id_number, v_address, v_phone);
  v_ev.consent_id := v_consent.id;
  v_ev.consent_at := v_consent.created_at;
  v_ev.otp_challenge_id := v_ch.id;
  v_ev.otp_verified_at := v_ch.verified_at;
  v_ev.signed_at := v_now;
  v_ev.ip_address := v_ip;
  v_ev.user_agent := v_ua;
  v_ev.previous_evidence_sha256 := v_prev_hash;
  v_ev.created_at := v_now;
  v_ev.evidence_sha256 := private.evidence_hash(v_prev_hash, private.contract_evidence_canonical(v_ev));

  INSERT INTO public.contract_signing_evidence SELECT (v_ev).*;

  PERFORM private.internal_write_end(v_prev_write);

  -- k. 簽署完成通知信（esign-signed-email-v1 原文；寄到綁定的已確認 Email）
  v_download_url := 'https://dream-one-teacher.zeabur.app/contract/view/' || v_contract_id::text;
  v_vars := jsonb_build_object(
    'instructor_name', v_name,
    'signed_at_taipei', to_char(v_now AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || '（台北時間）',
    'doc_list', COALESCE(private.esign_doc_list(p_doc_versions), ''),
    'contract_ref', left(v_contract_id::text, 8),
    'download_url', v_download_url
  );
  SELECT t.content INTO v_template FROM public.esign_text_versions t WHERE t.version_code = 'esign-signed-email-v1';
  v_body := private.render_esign_text(COALESCE(v_template,
    E'主旨：【夢想一號】講師合作契約簽署完成通知\n\n{{instructor_name}} 你好：\n\n你已於 {{signed_at_taipei}} 以線上方式完成以下文件的簽署：{{doc_list}}。\n簽署編號：{{contract_ref}}\n\n下載：請登入講師資源站下載已簽署的文件：{{download_url}}'),
    v_vars);
  IF v_body LIKE '主旨：%' THEN
    v_subject := btrim(substr(split_part(v_body, E'\n', 1), char_length('主旨：') + 1));
    v_body := ltrim(substr(v_body, position(E'\n' IN v_body) + 1), E'\n');
  ELSE
    v_subject := '【夢想一號】講師合作契約簽署完成通知';
  END IF;
  SELECT '<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#222">'
         || string_agg('<p>' || replace(private.html_escape(paragraph), E'\n', '<br>') || '</p>', '' ORDER BY ordinality)
         || '</div>'
    INTO v_html
    FROM regexp_split_to_table(v_body, E'\n\n') WITH ORDINALITY AS para(paragraph, ordinality);
  v_html := replace(v_html, private.html_escape(v_download_url),
    '<a href="' || private.html_escape(v_download_url) || '">' || private.html_escape(v_download_url) || '</a>');

  PERFORM private.enqueue_email('contract_signed_copy', v_bound_email, v_subject, v_html, v_body, v_uid, v_contract_id);

  RETURN jsonb_build_object(
    'status', 'signed',
    'contract_id', v_contract_id,
    'signed_at', v_now,
    'evidence_id', v_ev.id,
    'copy_email_masked', private.mask_email(v_bound_email)
  );
END;
$$;

-- 6.6 管理員確認 Email（附註記確認管道）
CREATE OR REPLACE FUNCTION public.admin_confirm_instructor_email(p_instructor_id uuid, p_email text, p_note text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(COALESCE(p_email, '')));
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_user_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = v_uid AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  IF v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_EMAIL';
  END IF;
  IF v_note IS NULL OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOTE_REQUIRED';
  END IF;

  UPDATE public.instructors i
     SET confirmed_email = v_email,
         confirmed_email_at = pg_catalog.now(),
         confirmed_email_by = v_uid,
         confirmed_email_method = 'admin_trusted_channel',
         confirmed_email_note = v_note
   WHERE i.id = p_instructor_id
  RETURNING i.user_id INTO v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTRUCTOR_NOT_FOUND';
  END IF;

  -- 寄到舊信箱、還沒用掉的驗證碼一律作廢
  IF v_user_id IS NOT NULL THEN
    UPDATE private.email_otp_challenges c
       SET superseded_at = pg_catalog.now()
     WHERE c.user_id = v_user_id
       AND c.consumed_at IS NULL
       AND c.superseded_at IS NULL
       AND c.target_email IS DISTINCT FROM v_email;
  END IF;

  RETURN jsonb_build_object('status', 'confirmed');
END;
$$;

-- 6.7 管理員補登範本雜湊（只能補 NULL）
CREATE OR REPLACE FUNCTION public.admin_set_document_hash(p_document_id uuid, p_sha256 text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text := lower(btrim(COALESCE(p_sha256, '')));
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = v_uid AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  IF v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_HASH';
  END IF;

  UPDATE public.contract_documents d
     SET content_sha256 = v_hash
   WHERE d.id = p_document_id
     AND d.content_sha256 IS NULL;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.contract_documents d WHERE d.id = p_document_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'HASH_ALREADY_SET';
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DOCUMENT_NOT_FOUND';
  END IF;

  RETURN jsonb_build_object('status', 'saved');
END;
$$;

-- 6.8 管理員驗證證據鏈：逐筆重算雜湊、檢查連號與前後相接，並與 instructor_contracts 交叉比對
CREATE OR REPLACE FUNCTION public.admin_verify_contract_evidence_chain()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.contract_signing_evidence%ROWTYPE;
  v_contract public.instructor_contracts%ROWTYPE;
  v_prev_hash text := NULL;
  v_expected_seq bigint := 1;
  v_checked integer := 0;
  v_broken uuid;
  v_reason text;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = v_uid AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  FOR v_row IN SELECT e.* FROM public.contract_signing_evidence e ORDER BY e.chain_seq LOOP
    v_checked := v_checked + 1;

    IF v_row.chain_seq <> v_expected_seq THEN
      v_broken := v_row.id; v_reason := 'chain_seq_gap';
    ELSIF v_row.previous_evidence_sha256 IS DISTINCT FROM v_prev_hash THEN
      v_broken := v_row.id; v_reason := 'previous_hash_mismatch';
    ELSIF v_row.evidence_sha256 IS DISTINCT FROM
          private.evidence_hash(v_row.previous_evidence_sha256, private.contract_evidence_canonical(v_row)) THEN
      v_broken := v_row.id; v_reason := 'evidence_hash_mismatch';
    ELSE
      SELECT c.* INTO v_contract FROM public.instructor_contracts c WHERE c.id = v_row.contract_id;
      IF NOT FOUND THEN
        v_broken := v_row.id; v_reason := 'contract_missing';
      ELSIF v_contract.user_id IS DISTINCT FROM v_row.user_id
         OR v_contract.doc_versions IS DISTINCT FROM v_row.doc_versions
         OR v_contract.signed_pdf_paths IS DISTINCT FROM v_row.signed_pdf_paths
         OR v_contract.signed_pdf_sha256 IS DISTINCT FROM v_row.signed_pdf_sha256
         OR v_contract.document_sha256 IS DISTINCT FROM v_row.document_sha256
         OR v_contract.signature_path IS DISTINCT FROM v_row.signature_path
         OR v_contract.signed_at IS DISTINCT FROM v_row.signed_at
         OR v_contract.bound_email IS DISTINCT FROM v_row.bound_email
         OR v_contract.ip_address IS DISTINCT FROM v_row.ip_address
         OR v_contract.user_agent IS DISTINCT FROM v_row.user_agent
         OR v_contract.consent_id IS DISTINCT FROM v_row.consent_id
         OR v_contract.otp_challenge_id IS DISTINCT FROM v_row.otp_challenge_id
         OR v_contract.otp_verified_at IS DISTINCT FROM v_row.otp_verified_at
         OR v_contract.instructor_id IS DISTINCT FROM v_row.instructor_id
         OR private.contract_fields_sha256(v_contract.filled_name, v_contract.filled_instructor_role,
              v_contract.filled_id_number, v_contract.filled_address, v_contract.filled_phone)
            IS DISTINCT FROM v_row.contract_fields_sha256 THEN
        v_broken := v_row.id; v_reason := 'contract_mismatch';
      END IF;
    END IF;

    EXIT WHEN v_broken IS NOT NULL;
    v_prev_hash := v_row.evidence_sha256;
    v_expected_seq := v_expected_seq + 1;
  END LOOP;

  -- 鏈尾被刪：v2 之後建立的契約都必須有對應證據
  IF v_broken IS NULL THEN
    SELECT c.id INTO v_broken
      FROM public.instructor_contracts c
     WHERE c.otp_challenge_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.contract_signing_evidence e WHERE e.contract_id = c.id)
     ORDER BY c.signed_at
     LIMIT 1;
    IF v_broken IS NOT NULL THEN
      v_reason := 'evidence_missing_for_contract';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', v_broken IS NULL,
    'checked', v_checked,
    'first_broken_id', v_broken,
    'broken_reason', v_reason
  );
END;
$$;

-- 6.9 權限：只給登入者；admin 函式在函式內檢查 admin
DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.get_my_activation_status()',
    'public.request_email_otp(text)',
    'public.verify_email_otp(uuid, text)',
    'public.record_contract_consent(text, jsonb, text)',
    'public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text, uuid, uuid, jsonb, jsonb)',
    'public.admin_confirm_instructor_email(uuid, text, text)',
    'public.admin_set_document_hash(uuid, text)',
    'public.admin_verify_contract_evidence_chain()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, service_role', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text, uuid, uuid, jsonb, jsonb) IS
  '講師簽約的唯一寫入通道（v2，2026-10-20）：帳號已啟用、電子簽約同意（2 小時內、版本一致）、本系統簽約 OTP（驗證後 15 分鐘內、一次性）、'
  '文件版本、範本與成品 SHA-256、已上傳檔案；同一交易作廢舊約、建立新約、寫入雜湊鏈證據並排入簽署完成通知信。';

-- ──────────────────────────────────────────────────────────────────
-- 7. 認領／核准／解除綁定／刪除帳號
-- ──────────────────────────────────────────────────────────────────

-- 7.1 首次登入：Email 唯一命中 → 綁定但維持 pending，寫 pending 啟用紀錄（staff 邀請不受影響）
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text := lower(BTRIM(COALESCE(NEW.email, '')));
  match_count      integer := 0;
  matched_id       uuid;
  matched_name     text;
  matched_status   text;
  matched_user_id  uuid;
  linked_id        uuid;
  staff_invite_id  uuid;
  staff_role       text;
  staff_name       text;
  resolved_role    text := 'pending';
  resolved_name    text := NEW.raw_user_meta_data->>'full_name';
BEGIN
  IF normalized_email <> '' THEN
    SELECT ti.id, ti.role, ti.name
      INTO staff_invite_id, staff_role, staff_name
      FROM public.teacher_invites ti
     WHERE lower(BTRIM(ti.email)) = normalized_email
       AND ti.role IN ('admin', 'mentor')
     ORDER BY ti.created_at ASC
     LIMIT 1;

    SELECT count(*)
      INTO match_count
      FROM public.instructors i
     WHERE lower(BTRIM(i.email_primary)) = normalized_email
        OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email;

    IF match_count = 1 THEN
      SELECT i.id, i.full_name, i.employment_status::text, i.user_id
        INTO matched_id, matched_name, matched_status, matched_user_id
        FROM public.instructors i
       WHERE lower(BTRIM(i.email_primary)) = normalized_email
          OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email
       FOR UPDATE;

      IF matched_user_id IS NULL
         AND matched_status IS DISTINCT FROM 'frozen'
         AND matched_status IS DISTINCT FROM 'cancelled' THEN
        resolved_name := COALESCE(NULLIF(BTRIM(matched_name), ''), resolved_name);
      END IF;
    END IF;
  END IF;

  IF staff_invite_id IS NOT NULL THEN
    resolved_role := staff_role;
    resolved_name := COALESCE(NULLIF(BTRIM(staff_name), ''), matched_name, resolved_name);
  END IF;

  INSERT INTO public.users (id, name, email, role)
  VALUES (NEW.id, resolved_name, NEW.email, resolved_role)
  ON CONFLICT (id) DO NOTHING;

  IF matched_id IS NOT NULL
     AND matched_user_id IS NULL
     AND matched_status IS DISTINCT FROM 'frozen'
     AND matched_status IS DISTINCT FROM 'cancelled' THEN
    UPDATE public.instructors
       SET user_id = NEW.id
     WHERE id = matched_id
       AND user_id IS NULL
    RETURNING id INTO linked_id;

    IF linked_id IS NOT NULL AND staff_invite_id IS NULL THEN
      PERFORM private.open_pending_activation(NEW.id, linked_id, 'email_match');
    END IF;
  END IF;

  IF staff_invite_id IS NOT NULL THEN
    DELETE FROM public.teacher_invites WHERE id = staff_invite_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- 7.2 登入後的認領決策點：Email 命中 → 綁定、寫 pending 啟用紀錄，不再改 role
CREATE OR REPLACE FUNCTION public.claim_my_precreated_instructor()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id          uuid := auth.uid();
  actor_role        text;
  normalized_email  text;
  existing_id       uuid;
  existing_status   text;
  match_count       integer := 0;
  matched_id        uuid;
  matched_user_id   uuid;
  matched_status    text;
  linked_id         uuid;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  SELECT pu.role, lower(BTRIM(COALESCE(au.email, '')))
    INTO actor_role, normalized_email
    FROM auth.users au
    LEFT JOIN public.users pu ON pu.id = au.id
   WHERE au.id = actor_id;

  IF actor_role IS NULL
     OR actor_role NOT IN ('pending', 'teacher', 'mentor', 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'registered account required';
  END IF;

  SELECT i.id, i.employment_status::text
    INTO existing_id, existing_status
    FROM public.instructors i
   WHERE i.user_id = actor_id
   LIMIT 1;

  IF existing_id IS NOT NULL THEN
    IF existing_status IN ('frozen', 'cancelled')
       AND COALESCE(actor_role, 'pending') NOT IN ('admin', 'mentor') THEN
      UPDATE public.users
         SET role = 'pending'
       WHERE id = actor_id
         AND role = 'teacher';

      RETURN jsonb_build_object(
        'status', 'blocked',
        'instructor_id', existing_id,
        'reason', '此講師帳號已停止使用，如有疑問請聯繫管理員。'
      );
    END IF;

    RETURN jsonb_build_object(
      'status', 'claimed',
      'instructor_id', existing_id,
      'claimed_now', false,
      'activation_required', EXISTS (
        SELECT 1 FROM public.instructor_account_activations a
         WHERE a.user_id = actor_id AND a.status = 'pending'
      )
    );
  END IF;

  IF normalized_email = '' THEN
    RETURN jsonb_build_object('status', 'new', 'reason', '登入帳號沒有可用的 Email。');
  END IF;

  SELECT count(*)
    INTO match_count
    FROM public.instructors i
   WHERE lower(BTRIM(i.email_primary)) = normalized_email
      OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email;

  IF match_count = 0 THEN
    RETURN jsonb_build_object('status', 'new');
  END IF;

  IF match_count > 1 THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', '此 Email 對應多筆講師資料，請聯繫管理員確認。'
    );
  END IF;

  SELECT i.id, i.user_id, i.employment_status::text
    INTO matched_id, matched_user_id, matched_status
    FROM public.instructors i
   WHERE lower(BTRIM(i.email_primary)) = normalized_email
      OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email
   FOR UPDATE;

  IF matched_user_id IS NOT NULL AND matched_user_id <> actor_id THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', '此講師資料已由其他帳號認領，請聯繫管理員。'
    );
  END IF;

  IF matched_status IN ('frozen', 'cancelled') THEN
    IF COALESCE(actor_role, 'pending') IN ('admin', 'mentor') THEN
      RETURN jsonb_build_object('status', 'staff');
    END IF;

    RETURN jsonb_build_object(
      'status', 'blocked',
      'instructor_id', matched_id,
      'reason', '此講師帳號已停止使用，如有疑問請聯繫管理員。'
    );
  END IF;

  UPDATE public.instructors
     SET user_id = actor_id
   WHERE id = matched_id
     AND user_id IS NULL
  RETURNING id INTO linked_id;

  IF linked_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', '講師資料剛被其他帳號認領，請聯繫管理員。'
    );
  END IF;

  -- 綁定後待啟用：role 不變；staff（admin／mentor）不需要啟用紀錄
  IF actor_role IN ('pending', 'teacher') THEN
    PERFORM private.open_pending_activation(actor_id, linked_id, 'email_match');
  END IF;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'instructor_id', linked_id,
    'claimed_now', true,
    'activation_required', actor_role IN ('pending', 'teacher')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_my_precreated_instructor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_my_precreated_instructor() TO authenticated;

-- 7.3 姓名＋完整手機＋身分證末四碼核對：綁定後待啟用
CREATE OR REPLACE FUNCTION public.claim_existing_instructor_by_identity(
  provided_full_name text,
  provided_phone_mobile text,
  provided_id_last_four text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id          uuid := auth.uid();
  actor_role        text;
  normalized_name   text := regexp_replace(BTRIM(COALESCE(provided_full_name, '')), '\s+', '', 'g');
  normalized_phone  text := regexp_replace(COALESCE(provided_phone_mobile, ''), '\D', '', 'g');
  normalized_last4  text := BTRIM(COALESCE(provided_id_last_four, ''));
  attempt_count     integer;
  attempt_lock      timestamptz;
  match_count       integer := 0;
  matched_id        uuid;
  matched_name      text;
  matched_user_id   uuid;
  linked_id         uuid;
  next_attempts     integer;
  next_lock         timestamptz;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  SELECT u.role INTO actor_role
    FROM public.users u
   WHERE u.id = actor_id;

  IF actor_role IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'pending account required';
  END IF;

  IF EXISTS (SELECT 1 FROM public.instructors i WHERE i.user_id = actor_id) THEN
    RETURN jsonb_build_object(
      'status', 'claimed',
      'claimed_now', false,
      'activation_required', EXISTS (
        SELECT 1 FROM public.instructor_account_activations a
         WHERE a.user_id = actor_id AND a.status = 'pending'
      )
    );
  END IF;

  IF normalized_name = ''
     OR length(normalized_phone) < 8
     OR length(normalized_phone) > 15
     OR normalized_last4 !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object(
      'status', 'invalid_input',
      'reason', '請輸入完整姓名、完整手機號碼與身分證末四碼。'
    );
  END IF;

  INSERT INTO private.instructor_identity_claim_attempts (user_id)
  VALUES (actor_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT a.failed_attempts, a.locked_until
    INTO attempt_count, attempt_lock
    FROM private.instructor_identity_claim_attempts a
   WHERE a.user_id = actor_id
   FOR UPDATE;

  IF attempt_lock IS NOT NULL AND attempt_lock > now() THEN
    RETURN jsonb_build_object(
      'status', 'locked',
      'reason', '核對嘗試次數過多，請 24 小時後再試或聯繫管理員。',
      'locked_until', attempt_lock
    );
  END IF;

  IF attempt_lock IS NOT NULL AND attempt_lock <= now() THEN
    attempt_count := 0;
    UPDATE private.instructor_identity_claim_attempts
       SET failed_attempts = 0, locked_until = NULL, updated_at = now()
     WHERE user_id = actor_id;
  END IF;

  SELECT count(*)
    INTO match_count
    FROM public.instructors i
   WHERE regexp_replace(BTRIM(COALESCE(i.full_name, '')), '\s+', '', 'g') = normalized_name
     AND regexp_replace(COALESCE(i.phone_mobile, ''), '\D', '', 'g') = normalized_phone
     AND right(regexp_replace(upper(COALESCE(i.id_number, '')), '[^A-Z0-9]', '', 'g'), 4) = normalized_last4
     AND i.employment_status::text NOT IN ('frozen', 'cancelled');

  IF match_count = 1 THEN
    SELECT i.id, i.full_name, i.user_id
      INTO matched_id, matched_name, matched_user_id
      FROM public.instructors i
     WHERE regexp_replace(BTRIM(COALESCE(i.full_name, '')), '\s+', '', 'g') = normalized_name
       AND regexp_replace(COALESCE(i.phone_mobile, ''), '\D', '', 'g') = normalized_phone
       AND right(regexp_replace(upper(COALESCE(i.id_number, '')), '[^A-Z0-9]', '', 'g'), 4) = normalized_last4
       AND i.employment_status::text NOT IN ('frozen', 'cancelled')
     FOR UPDATE;

    IF matched_user_id IS NULL THEN
      UPDATE public.instructors
         SET user_id = actor_id
       WHERE id = matched_id
         AND user_id IS NULL
      RETURNING id INTO linked_id;
    END IF;
  END IF;

  IF linked_id IS NOT NULL THEN
    UPDATE public.users
       SET name = COALESCE(NULLIF(BTRIM(matched_name), ''), name)
     WHERE id = actor_id;

    PERFORM private.open_pending_activation(actor_id, linked_id, 'identity_check');

    DELETE FROM private.instructor_identity_claim_attempts WHERE user_id = actor_id;

    RETURN jsonb_build_object(
      'status', 'claimed',
      'instructor_id', linked_id,
      'claimed_now', true,
      'activation_required', true
    );
  END IF;

  next_attempts := attempt_count + 1;
  next_lock := CASE WHEN next_attempts >= 5 THEN now() + interval '24 hours' ELSE NULL END;

  UPDATE private.instructor_identity_claim_attempts
     SET failed_attempts = CASE WHEN next_attempts >= 5 THEN 5 ELSE next_attempts END,
         locked_until = next_lock,
         updated_at = now()
   WHERE user_id = actor_id;

  IF next_lock IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'locked',
      'reason', '核對嘗試次數過多，請 24 小時後再試或聯繫管理員。',
      'locked_until', next_lock
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'not_found',
    'reason', '資料核對未通過，請確認三項資料與原講師主檔一致。',
    'attempts_remaining', 5 - next_attempts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_existing_instructor_by_identity(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_existing_instructor_by_identity(text, text, text) TO authenticated;

-- 7.4 姓名空位：只綁不開通（D1）
CREATE OR REPLACE FUNCTION public.claim_instructor_name_slot(provided_full_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id        uuid := auth.uid();
  actor_role      text;
  normalized_name text := regexp_replace(BTRIM(COALESCE(provided_full_name, '')), '\s+', '', 'g');
  matched_id      uuid;
  matched_name    text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  SELECT u.role INTO actor_role
    FROM public.users u
   WHERE u.id = actor_id;

  IF actor_role IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'pending account required';
  END IF;

  IF EXISTS (SELECT 1 FROM public.instructors i WHERE i.user_id = actor_id) THEN
    RETURN jsonb_build_object(
      'status', 'already_linked',
      'claimed_now', false,
      'activation_required', EXISTS (
        SELECT 1 FROM public.instructor_account_activations a
         WHERE a.user_id = actor_id AND a.status = 'pending'
      )
    );
  END IF;

  IF normalized_name = '' OR char_length(normalized_name) > 50 THEN
    RETURN jsonb_build_object('status', 'invalid_input', 'reason', '請輸入完整姓名。');
  END IF;

  SELECT i.id, i.full_name
    INTO matched_id, matched_name
    FROM public.instructors i
   WHERE i.name_slot
     AND i.user_id IS NULL
     AND regexp_replace(BTRIM(COALESCE(i.full_name, '')), '\s+', '', 'g') = normalized_name
     AND COALESCE(i.employment_status::text, 'active') NOT IN ('frozen', 'cancelled')
     AND NULLIF(BTRIM(COALESCE(i.id_number, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.phone_mobile, '')), '') IS NULL
     AND i.birth_date IS NULL
     AND NULLIF(BTRIM(COALESCE(i.address, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.household_address, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bank_account_number, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bank_info_raw, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_front_path, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_back_path, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bankbook_path, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_front_external_url, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_back_external_url, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bankbook_external_url, '')), '') IS NULL
     -- [claim-records-check] 已有上課或報酬紀錄的空位不能只靠姓名認領（2026-10-23 資安審查必修 1）：
     -- 這種主檔背後是真的老師，同名的人一綁定就會變成「這些紀錄的本人」。改由行政確認 Email 後在後台手動綁定，
     -- 或請老師走「姓名＋手機＋身分證末四碼」核對。回 not_found，不透露名冊裡有這個姓名。
     AND NOT EXISTS (SELECT 1 FROM public.class_sessions s WHERE s.instructor_id = i.id)
     AND NOT EXISTS (SELECT 1 FROM public.class_sessions_quarantine q WHERE q.instructor_id = i.id)
     AND NOT EXISTS (SELECT 1 FROM public.salary_master_rows m WHERE m.instructor_id = i.id)
     AND NOT EXISTS (SELECT 1 FROM public.salary_payout_export_items e WHERE e.instructor_id = i.id)
     -- [/claim-records-check]
   ORDER BY i.created_at, i.id
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF matched_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'not_found',
      'reason', '名冊裡沒有可直接認領的這個姓名。'
    );
  END IF;

  UPDATE public.instructors
     SET user_id = actor_id
   WHERE id = matched_id
     AND user_id IS NULL;

  UPDATE public.users
     SET name = COALESCE(NULLIF(BTRIM(matched_name), ''), name)
   WHERE id = actor_id;

  PERFORM private.open_pending_activation(actor_id, matched_id, 'name_slot');

  RETURN jsonb_build_object(
    'status', 'claimed',
    'instructor_id', matched_id,
    'claimed_now', true,
    'activation_required', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_instructor_name_slot(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_instructor_name_slot(text) TO authenticated;

COMMENT ON FUNCTION public.claim_instructor_name_slot(text) IS
  'Pending account binds the oldest unclaimed, active, data-free name_slot row whose whitespace-normalized full_name matches. '
  'Rows that already have class or salary records are never name-claimable (2026-10-23). '
  'Binding only: role stays pending until Email OTP activation (2026-10-20).';

-- 7.5 新建帳號核准＝公司核驗：改 teacher、寫 new_instructor_approved（active）、登錄 Google 信箱為已確認 Email
CREATE OR REPLACE FUNCTION public.approve_new_instructor_account(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_instructor_id uuid;
  google_email text;
  v_prev text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  SELECT i.id
    INTO target_instructor_id
    FROM public.instructors i
   WHERE i.user_id = target_user_id
   LIMIT 1;

  IF target_instructor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'instructor profile has not been created';
  END IF;

  IF NOT private.instructor_profile_is_complete(target_instructor_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'instructor profile is incomplete or disabled';
  END IF;

  -- 認領既有主檔的帳號必須由講師本人以 Email OTP 啟用，不能由管理員直接核准開通
  IF EXISTS (
    SELECT 1 FROM public.instructor_account_activations a
     WHERE a.user_id = target_user_id
       AND a.status = 'pending'
       AND a.claim_method IN ('email_match', 'identity_check', 'name_slot', 'admin_link')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'claimed account must be activated by the instructor via email verification';
  END IF;

  UPDATE public.users
     SET role = 'teacher'
   WHERE id = target_user_id
     AND role = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account is not pending';
  END IF;

  SELECT lower(BTRIM(au.email)) INTO google_email FROM auth.users au WHERE au.id = target_user_id;
  IF google_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    google_email := NULL;
  END IF;

  UPDATE public.instructors i
     SET identity_verified_at = COALESCE(i.identity_verified_at, pg_catalog.now()),
         identity_verification_basis = CASE WHEN i.identity_verified_at IS NULL THEN '管理員審核新進講師'
                                            ELSE i.identity_verification_basis END,
         confirmed_email = COALESCE(i.confirmed_email, google_email),
         confirmed_email_at = CASE WHEN i.confirmed_email IS NULL AND google_email IS NOT NULL
                                   THEN pg_catalog.now() ELSE i.confirmed_email_at END,
         confirmed_email_by = CASE WHEN i.confirmed_email IS NULL AND google_email IS NOT NULL
                                   THEN auth.uid() ELSE i.confirmed_email_by END,
         confirmed_email_method = CASE WHEN i.confirmed_email IS NULL AND google_email IS NOT NULL
                                       THEN 'google_login_new_instructor' ELSE i.confirmed_email_method END
   WHERE i.id = target_instructor_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.instructor_account_activations a
     WHERE a.user_id = target_user_id AND a.status IN ('pending', 'active')
  ) THEN
    v_prev := private.internal_write_begin();
    INSERT INTO public.instructor_account_activations (
      instructor_id, user_id, claim_method, claimed_at, activation_email, activated_at, status
    ) VALUES (
      target_instructor_id, target_user_id, 'new_instructor_approved', pg_catalog.now(),
      google_email, pg_catalog.now(), 'active'
    );
    PERFORM private.internal_write_end(v_prev);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_new_instructor_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_new_instructor_account(uuid) TO authenticated;

-- 7.6 解除綁定：先撤銷啟用紀錄（revoked），再解綁並撤回 teacher
CREATE OR REPLACE FUNCTION public.admin_unlink_instructor(target_instructor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  linked_user_id uuid;
  v_prev text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  SELECT i.user_id INTO linked_user_id
  FROM public.instructors i
  WHERE i.id = target_instructor_id
  FOR UPDATE;

  IF linked_user_id IS NOT NULL THEN
    v_prev := private.internal_write_begin();
    UPDATE public.instructor_account_activations a
       SET status = 'revoked',
           revoked_at = pg_catalog.now(),
           revoked_reason = 'admin_unlink'
     WHERE a.user_id = linked_user_id
       AND a.status IN ('pending', 'active');
    PERFORM private.internal_write_end(v_prev);
  END IF;

  UPDATE public.instructors
  SET user_id = NULL
  WHERE id = target_instructor_id;

  UPDATE public.users
  SET role = 'pending'
  WHERE id = linked_user_id AND role = 'teacher';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_unlink_instructor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_unlink_instructor(uuid) TO authenticated;

-- 7.6b 後台手動綁定：比照其他認領路徑「只綁不開通」
--   * pending 帳號：綁定後維持 pending，寫 pending 啟用紀錄（admin_link），等講師本人用 Email OTP 啟用；
--     不再直接升成 teacher（舊版 2025_instructor_claim.sql 會直接升）。
--   * 已是 teacher：比照 mentor／admin 的規則＝已核准帳號不降級、不要求再做 OTP 啟用；
--     因 teacher 簽約要有 active 啟用紀錄，這裡寫一筆 active 的 admin_link（otp 欄位為 NULL）。
--   * mentor／admin：不寫啟用紀錄（staff 免啟用）；簽約仍須綁定主檔＋已確認 Email。
--   * 主檔已停用（frozen／cancelled）：只綁定，不寫啟用紀錄、不改角色。
CREATE OR REPLACE FUNCTION public.admin_link_instructor(target_instructor_id uuid, target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text;
  v_status text;
  v_email text;
  v_prev text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  SELECT u.role INTO v_role FROM public.users u WHERE u.id = target_user_id;
  IF v_role IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'USER_NOT_FOUND';
  END IF;

  -- target_user_id 已綁其他講師主檔會被 instructors.user_id UNIQUE 擋住（與舊版相同）
  UPDATE public.instructors i
     SET user_id = target_user_id
   WHERE i.id = target_instructor_id
  RETURNING i.employment_status::text INTO v_status;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INSTRUCTOR_NOT_FOUND';
  END IF;

  IF v_status IN ('frozen', 'cancelled') THEN
    RETURN;
  END IF;

  IF v_role = 'pending' THEN
    PERFORM private.open_pending_activation(target_user_id, target_instructor_id, 'admin_link');
  ELSIF v_role = 'teacher' AND NOT EXISTS (
    SELECT 1 FROM public.instructor_account_activations a
     WHERE a.user_id = target_user_id AND a.status IN ('pending', 'active')
  ) THEN
    SELECT lower(BTRIM(au.email)) INTO v_email FROM auth.users au WHERE au.id = target_user_id;
    v_prev := private.internal_write_begin();
    INSERT INTO public.instructor_account_activations (
      instructor_id, user_id, claim_method, claimed_at, activation_email, activated_at, status
    ) VALUES (
      target_instructor_id, target_user_id, 'admin_link', pg_catalog.now(), v_email, pg_catalog.now(), 'active'
    );
    PERFORM private.internal_write_end(v_prev);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_link_instructor(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_link_instructor(uuid, uuid) TO authenticated;

-- 7.7 刪除帳號：有任何簽署證據（契約、同意紀錄、證據列）就拒絕；啟用紀錄改 revoked 保留
CREATE OR REPLACE FUNCTION public.delete_user_completely(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_email text;
  delete_id uuid := target_user_id;
  v_prev text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  IF EXISTS (SELECT 1 FROM public.instructor_contracts c WHERE c.user_id = delete_id)
     OR EXISTS (SELECT 1 FROM public.contract_consent_records r WHERE r.user_id = delete_id)
     OR EXISTS (SELECT 1 FROM public.contract_signing_evidence e WHERE e.user_id = delete_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = '依簽署證據保存規定不可刪除，請改用停用';
  END IF;

  SELECT au.email INTO target_email FROM auth.users au WHERE au.id = delete_id;

  v_prev := private.internal_write_begin();
  UPDATE public.instructor_account_activations a
     SET status = 'revoked',
         revoked_at = pg_catalog.now(),
         revoked_reason = 'account_deleted'
   WHERE a.user_id = delete_id
     AND a.status IN ('pending', 'active');
  PERFORM private.internal_write_end(v_prev);

  DELETE FROM private.email_otp_challenges c WHERE c.user_id = delete_id;

  UPDATE public.instructors i SET user_id = NULL WHERE i.user_id = delete_id;
  UPDATE public.instructor_form_downloads d
     SET target_user_id = NULL
   WHERE d.target_user_id = delete_id;
  UPDATE public.instructor_form_downloads d
     SET downloaded_by = NULL
   WHERE d.downloaded_by = delete_id;
  DELETE FROM public.instructor_profile_drafts d WHERE d.user_id = delete_id;
  DELETE FROM public.progress p WHERE p.user_id = delete_id;
  DELETE FROM public.assignments a WHERE a.user_id = delete_id;
  DELETE FROM public.course_training_status s WHERE s.user_id = delete_id;
  DELETE FROM public.notifications n WHERE n.user_id = delete_id;
  DELETE FROM public.users u WHERE u.id = delete_id;
  IF target_email IS NOT NULL THEN
    DELETE FROM public.teacher_invites ti
    WHERE lower(BTRIM(ti.email)) = lower(BTRIM(target_email));
  END IF;
  DELETE FROM auth.users au WHERE au.id = delete_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_user_completely(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_completely(uuid) TO authenticated;

-- ──────────────────────────────────────────────────────────────────
-- 8. 一次性回填（第一次套用時執行；以 private.schema_backfill_markers 標記）
-- ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_marker constant text := '20261020100000_claim_activation_esign_evidence';
  v_verified integer := 0;
  v_emails integer := 0;
  v_legacy integer := 0;
  v_contracts integer := 0;
  v_prev text;
  v_has_updated_at_trigger boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM private.schema_backfill_markers m WHERE m.name = v_marker) THEN
    RAISE NOTICE '% 回填已做過，略過。', v_marker;
    RETURN;
  END IF;

  -- 回填不應改動 instructors.updated_at（後台以它排序「最近更新」）
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.instructors'::regclass
       AND t.tgname = 'set_instructors_updated_at'
       AND NOT t.tgisinternal
  ) INTO v_has_updated_at_trigger;
  IF v_has_updated_at_trigger THEN
    ALTER TABLE public.instructors DISABLE TRIGGER set_instructors_updated_at;
  END IF;

  -- D2：既有主檔（排除「新建帳號待審核」＝綁定在 pending 帳號、且未停用的列）登錄為身分已核驗
  UPDATE public.instructors i
     SET identity_verified_at = pg_catalog.now(),
         identity_verification_basis = '公司既有核驗結果登錄（非第三方實名認證）'
   WHERE i.identity_verified_at IS NULL
     AND NOT (
       i.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = i.user_id AND u.role = 'pending')
       AND COALESCE(i.employment_status::text, '') NOT IN ('frozen', 'cancelled')
     );
  GET DIAGNOSTICS v_verified = ROW_COUNT;

  -- D2：同一批列的既有 email_primary（格式正確者）登錄為「公司既有資料之 Email」
  UPDATE public.instructors i
     SET confirmed_email = lower(btrim(i.email_primary)),
         confirmed_email_at = pg_catalog.now(),
         confirmed_email_by = NULL,
         confirmed_email_method = 'company_existing_record',
         confirmed_email_note = '公司既有資料之 Email（2026-10-20 migration 登錄）'
   WHERE i.confirmed_email IS NULL
     AND NULLIF(btrim(i.email_primary), '') IS NOT NULL
     AND lower(btrim(i.email_primary)) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     AND NOT (
       i.user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = i.user_id AND u.role = 'pending')
       AND COALESCE(i.employment_status::text, '') NOT IN ('frozen', 'cancelled')
     );
  GET DIAGNOSTICS v_emails = ROW_COUNT;

  IF v_has_updated_at_trigger THEN
    ALTER TABLE public.instructors ENABLE TRIGGER set_instructors_updated_at;
  END IF;

  -- D4：已是 teacher 的既有帳號補一筆 legacy 啟用紀錄（active），不受新流程影響
  v_prev := private.internal_write_begin();
  INSERT INTO public.instructor_account_activations (
    instructor_id, user_id, claim_method, claimed_at, activation_email, activated_at, status
  )
  SELECT i.id, u.id, 'legacy_pre_activation', pg_catalog.now(),
         lower(btrim(au.email)), pg_catalog.now(), 'active'
    FROM public.users u
    JOIN public.instructors i ON i.user_id = u.id
    LEFT JOIN auth.users au ON au.id = u.id
   WHERE u.role = 'teacher'
     AND NOT EXISTS (
       SELECT 1 FROM public.instructor_account_activations a
        WHERE a.user_id = u.id AND a.status IN ('pending', 'active')
     );
  GET DIAGNOSTICS v_legacy = ROW_COUNT;
  PERFORM private.internal_write_end(v_prev);

  -- 舊約補 instructor_id（只是關聯欄位；暫停防竄改 trigger 只為這一步，同一交易內恢復）
  ALTER TABLE public.instructor_contracts DISABLE TRIGGER trg_guard_instructor_contracts;
  UPDATE public.instructor_contracts c
     SET instructor_id = i.id
    FROM public.instructors i
   WHERE c.instructor_id IS NULL
     AND i.user_id = c.user_id;
  GET DIAGNOSTICS v_contracts = ROW_COUNT;
  ALTER TABLE public.instructor_contracts ENABLE TRIGGER trg_guard_instructor_contracts;

  INSERT INTO private.schema_backfill_markers (name, detail)
  VALUES (v_marker, jsonb_build_object(
    'identity_verified', v_verified,
    'confirmed_email', v_emails,
    'legacy_activations', v_legacy,
    'contracts_instructor_id', v_contracts
  ));

  RAISE NOTICE '回填完成：身分已核驗 % 筆、Email 登錄 % 筆、legacy 啟用紀錄 % 筆、舊約 instructor_id % 筆',
    v_verified, v_emails, v_legacy, v_contracts;
END;
$$;

-- ──────────────────────────────────────────────────────────────────
-- 9. pg_cron：每分鐘更新寄送狀態（沒有 cron 就略過）
-- ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF pg_catalog.to_regnamespace('cron') IS NULL
     OR pg_catalog.to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'cron schema 不存在，略過寄送狀態排程（可手動執行 SELECT private.refresh_email_delivery_status();）';
    RETURN;
  END IF;
  PERFORM cron.schedule(
    'dreamone-refresh-email-delivery-status',
    '* * * * *',
    'SELECT private.refresh_email_delivery_status();'
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '寄送狀態排程建立失敗（%），可稍後手動排程。', SQLERRM;
END;
$$;

COMMIT;
