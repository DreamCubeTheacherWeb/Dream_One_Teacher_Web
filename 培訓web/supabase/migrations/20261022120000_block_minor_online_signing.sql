-- ═══════════════════════════════════════════════════════════════════
-- 未滿 18 歲的講師不能線上簽約，一律改走紙本＋法定代理人（2026-10-22）
--
-- 來源：法規顧問紅燈 R3（docs/specs/2026-10-20-esign-legal-copy.md §4）。民法 §12 滿 18 歲成年、
--       §77～§79 限制行為能力人訂約需法定代理人允許或承認。業主 2026-10-22 授權主對話定案：採保守做法——
--       未滿 18 歲一律不能線上簽約，只能紙本由本人和法定代理人一起簽；成年人完全不受影響；
--       線上「不同意，改以紙本簽約」照常可用（會記錄並通知行政）。
--
-- 防線放在資料庫（畫面只是提早說清楚）：
--   * instructor_contracts 新增 status='signed' 的列        → 拒絕 MINOR_REQUIRES_GUARDIAN
--   * contract_consent_records 新增 decision='agree_electronic' → 拒絕 MINOR_REQUIRES_GUARDIAN
--   * decline_electronic 不擋（未成年也可以記錄「改紙本」）
--   兩個 BEFORE INSERT trigger 在 SECURITY DEFINER 函式（record_contract_consent、submit_my_contract）內觸發，
--   例外會讓整個 RPC 交易回滾——submit_my_contract 先 consume OTP 才寫契約，被擋時 OTP 一併還原（verify 腳本有實測）。
--
-- 判斷規則：以該帳號綁定的講師主檔 birth_date、台灣日期 ((now() AT TIME ZONE 'Asia/Taipei')::date) 為準；
--           出生日當天滿 18 歲；birth_date 為 NULL 視為成年（資料完整度本來就要求出生年月日，缺值由個資流程處理）。
--           2/29 出生者：滿 18 歲那年不是閏年，民法 §121 以「月之末日」為期間末日，於 3/1 起視為成年（較保守的一側）。
--
-- 補強（本檔新增，非必要時可整段拿掉）：
--   * private.guard_minor_birth_date_change：未成年講師不能自己把出生日期改成成年（或清空）。
--     否則「改個資再簽」可以繞過上面的防線。只擋「未成年 → 成年／NULL」這一種；成年人改日期、
--     未成年人改成另一個未成年日期、管理員修正、SQL Editor／service 操作（auth.uid() 為 NULL）都放行。
--   * private.notify_minor_paper_signing：未成年講師選擇紙本時，另外通知管理員「需法定代理人一起簽」
--     （原本的「講師選擇改以紙本簽約」通知看不出他是未成年）。
--   * 種入畫面文案 esign-minor-paper-v1：同意紀錄的 consent_text 存「講師當下實際看到的全文」，
--     未成年講師看到的是這份說明，所以要有自己的版本代碼（record_contract_consent 靠版本代碼查全文）。
--
-- 前置：20261020100000（esign 證據）已套用。可重複執行；不刪既有資料。
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ──────────────────────────────────────────────────────────────────
-- 1. 判斷函式
-- ──────────────────────────────────────────────────────────────────

-- 1.1 某出生日期在某天（預設＝台灣今天）是否未滿 18 歲。p_on 只給測試用。
CREATE OR REPLACE FUNCTION private.is_minor_birth_date(p_birth_date date, p_on date DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_birth_date IS NOT NULL
     AND p_birth_date > (
       COALESCE(p_on, (pg_catalog.now() AT TIME ZONE 'Asia/Taipei')::date) - interval '18 years'
     )::date;
$$;

-- 1.2 這個帳號綁定的講師主檔是否未滿 18 歲（沒有主檔或沒有出生日期 → false）。
CREATE OR REPLACE FUNCTION private.instructor_is_minor(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.instructors i
     WHERE i.user_id = p_user_id
       AND private.is_minor_birth_date(i.birth_date)
  );
$$;

REVOKE ALL ON FUNCTION private.is_minor_birth_date(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.instructor_is_minor(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION private.instructor_is_minor(uuid) IS
  '綁定講師主檔的 birth_date 依台灣日期判斷未滿 18 歲（出生日當天滿 18）；NULL 回 false。供電子簽約防線 trigger 使用。';

-- ──────────────────────────────────────────────────────────────────
-- 2. 擋線上簽約：契約簽署列、同意（agree）紀錄
-- ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.block_minor_online_signing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_TABLE_NAME = 'instructor_contracts' THEN
    IF NEW.status IS NOT DISTINCT FROM 'signed' AND private.instructor_is_minor(NEW.user_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MINOR_REQUIRES_GUARDIAN',
        DETAIL = '未滿 18 歲不能線上簽約，請改以紙本簽約，由本人和法定代理人一起簽名。';
    END IF;
  ELSIF TG_TABLE_NAME = 'contract_consent_records' THEN
    IF NEW.decision IS NOT DISTINCT FROM 'agree_electronic' AND private.instructor_is_minor(NEW.user_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'MINOR_REQUIRES_GUARDIAN',
        DETAIL = '未滿 18 歲不能同意線上簽約，請改以紙本簽約，由本人和法定代理人一起簽名。';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.block_minor_online_signing() FROM PUBLIC, anon, authenticated;

-- trigger 名稱以 trg_block_ 開頭，同表的 trg_guard_* 之前先執行；兩者都會 RAISE，先後不影響結果。
DROP TRIGGER IF EXISTS trg_block_minor_signed_contract ON public.instructor_contracts;
CREATE TRIGGER trg_block_minor_signed_contract
BEFORE INSERT ON public.instructor_contracts
FOR EACH ROW EXECUTE FUNCTION private.block_minor_online_signing();

DROP TRIGGER IF EXISTS trg_block_minor_agree_consent ON public.contract_consent_records;
CREATE TRIGGER trg_block_minor_agree_consent
BEFORE INSERT ON public.contract_consent_records
FOR EACH ROW EXECUTE FUNCTION private.block_minor_online_signing();

-- ──────────────────────────────────────────────────────────────────
-- 3. 未成年講師不能自己把出生日期改成成年（不讓人「改個資再簽」）
-- ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.guard_minor_birth_date_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
BEGIN
  -- SQL Editor／service／migration（沒有登入身分）放行，與 guard_instructor_admin_fields 同一慣例
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF private.is_minor_birth_date(OLD.birth_date) AND NOT private.is_minor_birth_date(NEW.birth_date) THEN
    IF EXISTS (SELECT 1 FROM public.users u WHERE u.id = actor_id AND u.role = 'admin') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'BIRTH_DATE_ADMIN_ONLY',
      DETAIL = '出生日期已登錄為未滿 18 歲，只有管理員可以更正；如果登錄有誤，請聯繫行政人員。';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.guard_minor_birth_date_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_minor_birth_date_change ON public.instructors;
CREATE TRIGGER trg_guard_minor_birth_date_change
BEFORE UPDATE OF birth_date ON public.instructors
FOR EACH ROW
WHEN (OLD.birth_date IS DISTINCT FROM NEW.birth_date)
EXECUTE FUNCTION private.guard_minor_birth_date_change();

-- ──────────────────────────────────────────────────────────────────
-- 4. 未成年講師選擇紙本 → 另外通知管理員（需法定代理人一起簽）
--    record_contract_consent 已通知「講師選擇改以紙本簽約」；這則補上「他未滿 18 歲」。
-- ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.notify_minor_paper_signing()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text;
BEGIN
  IF NEW.decision IS DISTINCT FROM 'decline_electronic' OR NOT private.instructor_is_minor(NEW.user_id) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(btrim(i.full_name), ''), NULLIF(btrim(u.name), ''), u.email, '一位講師')
    INTO v_name
    FROM public.users u
    LEFT JOIN public.instructors i ON i.user_id = u.id
   WHERE u.id = NEW.user_id;

  INSERT INTO public.notifications (user_id, type, title, body, link)
  SELECT admin_row.id, 'contract', '未滿 18 歲的講師需由法定代理人一起簽紙本契約',
         COALESCE(v_name, '一位講師') || ' 依出生日期判斷未滿 18 歲，不能線上簽約，請安排紙本簽約，並請法定代理人（通常是父母）一起簽名。',
         '/admin/contracts'
    FROM public.users admin_row
   WHERE admin_row.role = 'admin';

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.notify_minor_paper_signing() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_notify_minor_paper_signing ON public.contract_consent_records;
CREATE TRIGGER trg_notify_minor_paper_signing
AFTER INSERT ON public.contract_consent_records
FOR EACH ROW
WHEN (NEW.decision = 'decline_electronic')
EXECUTE FUNCTION private.notify_minor_paper_signing();

-- ──────────────────────────────────────────────────────────────────
-- 5. 畫面文案種子：esign-minor-paper-v1（逐字等於 src/lib/esignCopy.js 的未成年說明；esignCopy.test.js 會核對）
--    只新增，已存在的代碼不覆寫（append-only，改版請新增 -v2）。
-- ──────────────────────────────────────────────────────────────────
DO $$
DECLARE
  seed record;
  existing text;
BEGIN
  FOR seed IN
    SELECT * FROM (VALUES
      ('esign-minor-paper-v1', $t$請改以紙本簽約

這次要簽的文件是：{{doc_list}}。

依民法規定，未滿 18 歲簽訂契約需要法定代理人（通常是父母）同意。為保障你的權益，請改以紙本簽約，由你和法定代理人一起簽名。

按下方按鈕後，行政人員會和你聯繫。

系統是依你個人資料裡的出生日期判斷的。如果出生日期登錄有誤，請寄信到 hi@dreamcube.tw。

［改以紙本簽約］$t$)
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

COMMIT;
