-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  認領加驗「身分證末四碼」＋ 等級伺服器端強制（實習預設）
-- ───────────────────────────────────────────────────────────────────
-- 需求（業主 2026-07-09）：
--   (A) 老師認領時，除了手機末四碼，再加「身分證末四碼」一起比對，兩個都對
--       才自動綁定＝更難冒認。（登入後在「已是夢想一號老師」入口驗證。）
--   (B) 講師「等級」(instructor_role) 不讓老師自己選：認領到的沿用名冊原等級；
--       全新老師（不在名冊、自己建資料）一律預設「實習」。
--
-- 前置：本檔建立在 2026-07-09_claim_auto_approve.sql（搜尋遮罩＋手機自動核准）
--   之後執行。冪等：DROP/CREATE FUNCTION、CREATE OR REPLACE、DROP TRIGGER IF EXISTS。
--
-- ⚠️ 上線順序：這份把 submit_claim_request 收緊成「名冊有身分證就必須連身分證末四碼
--   一起對」。若在「送身分證的新前端」部署前先跑這份，舊前端只送手機 → 對有身分證的
--   名冊列會改走人工審核（較嚴、安全），不會壞，只是那段空窗少了自動核准的便利。
--   建議這份 SQL 與新前端同批上線。
-- ═══════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────
-- A. submit_claim_request 加第 4 參數 id_last4_input，比對規則升級
-- ──────────────────────────────────────────────────────────────────
-- 自動核准條件（v_match）：名冊該列「有登記的每一項祕密都要對」，且至少對到一項——
--   有手機 → 手機末四碼必須相符；有身分證 → 身分證末四碼必須相符；
--   兩者皆無可比對 → 不自動核准（轉人工，安全預設）。
-- 暴力破解防線：沿用 auto_attempts，猜錯累計達 5 次即鎖死轉人工。
-- 回傳 jsonb：{ claim_id, status: 'approved'|'pending' }。
-- 簽章由 3 參數改 4 參數，故先 DROP。
-- ──────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.submit_claim_request(uuid, text, text);

CREATE OR REPLACE FUNCTION public.submit_claim_request(
  target_instructor_id uuid,
  phone_input          text DEFAULT NULL,
  message_input        text DEFAULT NULL,
  id_last4_input       text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  my_email        text;
  claim_id        uuid;
  inst_user_id    uuid;
  inst_phone      text;
  inst_idnum      text;
  matched_status  text;
  new_role        text;
  v_in_phone4     text;
  v_inst_phone4   text;
  v_in_id4        text;
  v_inst_id4      text;
  v_phone_present boolean;
  v_id_present    boolean;
  v_phone_ok      boolean;
  v_id_ok         boolean;
  v_match         boolean;
  v_attempts      int;
  AUTO_LIMIT constant int := 5;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT user_id, phone_mobile, id_number, employment_status::text
    INTO inst_user_id, inst_phone, inst_idnum, matched_status
    FROM public.instructors WHERE id = target_instructor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instructor not found';
  END IF;

  IF inst_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Instructor already linked';
  END IF;

  SELECT email INTO my_email FROM auth.users WHERE id = auth.uid();

  -- 取雙邊末四碼（去掉非數字後取後 4 位）
  v_in_phone4   := right(regexp_replace(COALESCE(phone_input, ''),    '\D', '', 'g'), 4);
  v_inst_phone4 := right(regexp_replace(COALESCE(inst_phone, ''),     '\D', '', 'g'), 4);
  v_in_id4      := right(regexp_replace(COALESCE(id_last4_input, ''), '\D', '', 'g'), 4);
  v_inst_id4    := right(regexp_replace(COALESCE(inst_idnum, ''),     '\D', '', 'g'), 4);

  v_phone_present := (length(v_inst_phone4) = 4);
  v_id_present    := (length(v_inst_id4) = 4);

  -- 有登記的項目才要求相符；沒登記的項目視為通過（vacuously true）
  v_phone_ok := (NOT v_phone_present) OR (length(v_in_phone4) = 4 AND v_in_phone4 = v_inst_phone4);
  v_id_ok    := (NOT v_id_present)    OR (length(v_in_id4)    = 4 AND v_in_id4    = v_inst_id4);

  -- 至少要有一項可比對，且所有已登記項目都對
  v_match := (v_phone_present OR v_id_present) AND v_phone_ok AND v_id_ok;

  INSERT INTO public.instructor_claim_requests (
    requester_user_id, instructor_id, requester_email, proposed_phone, message,
    auto_attempts
  ) VALUES (
    auth.uid(), target_instructor_id, my_email, phone_input, message_input,
    CASE WHEN v_match THEN 0 ELSE 1 END
  )
  ON CONFLICT (requester_user_id, instructor_id) DO UPDATE
    SET proposed_phone = EXCLUDED.proposed_phone,
        message        = EXCLUDED.message,
        status         = 'pending',
        reviewer_id    = NULL,
        review_notes   = NULL,
        reviewed_at    = NULL,
        auto_attempts  = public.instructor_claim_requests.auto_attempts
                         + CASE WHEN v_match THEN 0 ELSE 1 END
  RETURNING id, auto_attempts INTO claim_id, v_attempts;

  IF v_match AND v_attempts < AUTO_LIMIT THEN
    UPDATE public.instructors
      SET user_id = auth.uid()
      WHERE id = target_instructor_id AND user_id IS NULL;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('claim_id', claim_id, 'status', 'pending');
    END IF;

    new_role := CASE
      WHEN matched_status IN ('frozen', 'cancelled') THEN 'pending'
      ELSE 'teacher'
    END;
    UPDATE public.users
      SET role = new_role
      WHERE id = auth.uid() AND role = 'pending';

    UPDATE public.instructor_claim_requests
      SET status       = 'approved',
          reviewer_id  = NULL,
          review_notes = '系統自動核准：手機＋身分證末四碼與名冊相符',
          reviewed_at  = now()
      WHERE id = claim_id;

    RETURN jsonb_build_object('claim_id', claim_id, 'status', 'approved');
  END IF;

  RETURN jsonb_build_object('claim_id', claim_id, 'status', 'pending');
END;
$$;

REVOKE ALL     ON FUNCTION public.submit_claim_request(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.submit_claim_request(uuid, text, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_claim_request(uuid, text, text, text) TO authenticated;


-- ──────────────────────────────────────────────────────────────────
-- B. 等級伺服器端強制：老師不能自己設 / 改 instructor_role
-- ──────────────────────────────────────────────────────────────────
-- 規則（只約束「真的登入的非 admin 使用者」）：
--   INSERT 自己那列 → instructor_role 一律寫成 '實習'（忽略前端送什麼）。
--   UPDATE 自己那列 → instructor_role 保持原值（非 admin 不得變更等級）。
-- 放行對象（RETURN NEW 不干涉）：
--   auth.uid() IS NULL → service role / SQL Editor / 資料匯入（等級由匯入資料決定）；
--   admin 使用者 → 後台改等級照常。
-- ⚠️ 這是「前端不可信」的後端防線：即使有人繞過畫面直接打 API 也改不了自己的等級。
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.guard_instructor_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_admin boolean;
BEGIN
  -- service role / 匯入（無 JWT）→ 放行
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  ) INTO v_is_admin;

  IF v_is_admin THEN
    RETURN NEW;
  END IF;

  -- 一般登入者：等級不由他決定
  IF TG_OP = 'INSERT' THEN
    NEW.instructor_role := '實習';
  ELSIF TG_OP = 'UPDATE' THEN
    NEW.instructor_role := OLD.instructor_role;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_instructor_role ON public.instructors;
CREATE TRIGGER trg_guard_instructor_role
  BEFORE INSERT OR UPDATE ON public.instructors
  FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_role();


-- ──────────────────────────────────────────────────────────────────
-- C. 驗證
-- ──────────────────────────────────────────────────────────────────
--   簽章：SELECT pg_get_function_arguments(oid) FROM pg_proc
--           WHERE proname='submit_claim_request';  -- 應含 id_last4_input
--   等級強制（需一般老師 session）：
--     - 老師自建資料 → 該列 instructor_role 應為 '實習'（即使前端送 'S'）。
--     - 老師改自己資料 → instructor_role 不變。
--     - admin 後台改等級 → 生效。
--     - SQL Editor 直接 UPDATE 設等級 → 生效（auth.uid() 為 NULL 放行）。
--   認領：名冊列有身分證時，手機對但身分證不對 → pending；兩者皆對 → approved。
