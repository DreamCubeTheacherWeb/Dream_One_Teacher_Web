-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  認領「手機末四碼相符 → 自動核准」
-- ───────────────────────────────────────────────────────────────────
-- 需求（業主 2026-07-09 拍板）：名冊上的老師認領自己的舊資料時，若能證明是
--   本人，就不必再等 admin 手動審核。「名單」＝全部講師名冊（instructors 表
--   任何一筆未綁定的舊資料）；「身分證明」＝姓名對得到（搜尋階段）＋送出時填的
--   完整手機號碼末四碼與名冊該列相符。
--
-- 背景：原 submit_claim_request 一律開 pending claim 等 admin 審核
--   （見 2025_instructor_claim.sql）。本檔改寫它：送出當下若手機末四碼相符
--   就「當場綁定＋核准」，等同 admin 按了核准；不符或名冊該列沒手機可比對，
--   則維持原本的 pending 人工審核流程（安全預設）。
--
-- ⚠️ 為什麼只靠手機末四碼＝業主明確取捨（省事 vs 安全）：這是唯一在送出當下
--   可驗證的「祕密」。名字只是搜尋用、不算祕密。副作用是理論上有人可暴力猜
--   4 位數（1/10000）。防線＝下面的 auto_attempts 計數器：同一人對同一筆猜錯
--   達 5 次後，就算之後猜對也一律轉人工審核，把暴力破解成本壓死。
--
-- 相依：2025_instructor_claim.sql（表與原函式、角色升級規則）。
-- 冪等：ADD COLUMN IF NOT EXISTS ＋ DROP/CREATE FUNCTION（回傳型別由 uuid 改
--   為 jsonb，故必須先 DROP 舊簽章）。
-- ═══════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────
-- A. 暴力破解防線欄位：記錄同一（申請人, 講師）配對猜錯手機的次數
-- ──────────────────────────────────────────────────────────────────
ALTER TABLE public.instructor_claim_requests
  ADD COLUMN IF NOT EXISTS auto_attempts int NOT NULL DEFAULT 0;


-- ──────────────────────────────────────────────────────────────────
-- B. 改寫 submit_claim_request：手機末四碼相符即自動核准
-- ──────────────────────────────────────────────────────────────────
-- 回傳 jsonb：{ "claim_id": uuid, "status": "approved" | "pending" }
--   approved＝已自動綁定；pending＝已建立申請、等 admin 審核。
-- ──────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.submit_claim_request(uuid, text, text);

CREATE OR REPLACE FUNCTION public.submit_claim_request(
  target_instructor_id uuid,
  phone_input          text DEFAULT NULL,
  message_input        text DEFAULT NULL
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
  matched_status  text;
  new_role        text;
  v_input_last4   text;
  v_inst_last4    text;
  v_phone_match   boolean := false;
  v_attempts      int;
  AUTO_LIMIT constant int := 5;   -- 猜錯上限，超過一律轉人工
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT user_id, phone_mobile, employment_status::text
    INTO inst_user_id, inst_phone, matched_status
    FROM public.instructors WHERE id = target_instructor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instructor not found';
  END IF;

  IF inst_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Instructor already linked';
  END IF;

  SELECT email INTO my_email FROM auth.users WHERE id = auth.uid();

  -- 手機末四碼比對（雙邊都先去掉非數字）
  v_input_last4 := right(regexp_replace(COALESCE(phone_input, ''), '\D', '', 'g'), 4);
  v_inst_last4  := right(regexp_replace(COALESCE(inst_phone, ''), '\D', '', 'g'), 4);
  v_phone_match := (length(v_input_last4) = 4 AND v_input_last4 = v_inst_last4);

  -- 建立 / 更新申請；猜錯就把 auto_attempts +1（猜對不加）
  INSERT INTO public.instructor_claim_requests (
    requester_user_id, instructor_id, requester_email, proposed_phone, message,
    auto_attempts
  ) VALUES (
    auth.uid(), target_instructor_id, my_email, phone_input, message_input,
    CASE WHEN v_phone_match THEN 0 ELSE 1 END
  )
  ON CONFLICT (requester_user_id, instructor_id) DO UPDATE
    SET proposed_phone = EXCLUDED.proposed_phone,
        message        = EXCLUDED.message,
        status         = 'pending',
        reviewer_id    = NULL,
        review_notes   = NULL,
        reviewed_at    = NULL,
        auto_attempts  = public.instructor_claim_requests.auto_attempts
                         + CASE WHEN v_phone_match THEN 0 ELSE 1 END
  RETURNING id, auto_attempts INTO claim_id, v_attempts;

  -- 自動核准條件：手機末四碼相符，且累計猜錯次數未超過上限
  IF v_phone_match AND v_attempts < AUTO_LIMIT THEN
    -- 綁定（等同 admin 核准）
    UPDATE public.instructors
      SET user_id = auth.uid()
      WHERE id = target_instructor_id AND user_id IS NULL;

    IF NOT FOUND THEN
      -- 極少數併發：剛好被別人搶綁 → 退回人工審核，不拋錯
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
          review_notes = '系統自動核准：手機末四碼與名冊相符',
          reviewed_at  = now()
      WHERE id = claim_id;

    RETURN jsonb_build_object('claim_id', claim_id, 'status', 'approved');
  END IF;

  -- 未達自動核准 → 維持 pending，等 admin 審核
  RETURN jsonb_build_object('claim_id', claim_id, 'status', 'pending');
END;
$$;

REVOKE ALL     ON FUNCTION public.submit_claim_request(uuid, text, text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.submit_claim_request(uuid, text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_claim_request(uuid, text, text) TO authenticated;


-- ──────────────────────────────────────────────────────────────────
-- B2. 堵住「後四碼＝密碼卻公開可見」的洞（資安審查阻斷項，缺一不可）
-- ──────────────────────────────────────────────────────────────────
-- 問題：原 search_unlinked_instructors（見 2025_instructor_claim.sql）把手機
--   遮罩成 '••••1234'＝把後四碼直接顯示給任何登入者；且可用 phone_last4 當過濾
--   參數（變成免費對答機）。在「後四碼＝自動核准密碼」的新設計下，等於密碼公開，
--   B 段的猜錯計數器形同虛設。
-- 修法：① 搜尋結果不再露出任何手機數字（只回「是否有登記手機」的中性提示）；
--       ② 移除 phone_last4 過濾參數（消掉對答機）。
--   → 前端 ProfilePage.jsx 的搜尋 UI 也同步改（移除末四碼輸入框；不再誤導可縮小結果）。
-- 向後相容：保留原本「兩參數」簽章（phone_last4 保留但停用），這樣「線上還沒換版的
--   舊前端」照樣呼叫得到、搜尋不會壞；新前端只傳 name_query（phone_last4 有 DEFAULT）。
--   回傳欄位與原版一致，故用 CREATE OR REPLACE、不需 DROP。
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_unlinked_instructors(
  name_query  text,
  phone_last4 text DEFAULT NULL   -- ⚠️ 已停用:僅保留簽章相容,不再用於過濾（消掉對答機）
)
RETURNS TABLE (
  id           uuid,
  full_name    text,
  email_masked text,
  phone_masked text   -- 只回中性提示,永不含數字
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    i.id,
    i.full_name,
    CASE
      WHEN i.email_primary IS NOT NULL AND position('@' in i.email_primary) > 2
      THEN substring(i.email_primary, 1, 2) || '••••' || substring(i.email_primary, position('@' in i.email_primary))
      ELSE NULL
    END,
    -- 只透露「有沒有登記手機」,不透露任何一位數字（後四碼是自動核准密碼,不可外露）
    CASE
      WHEN i.phone_mobile IS NOT NULL
           AND length(regexp_replace(i.phone_mobile, '\D', '', 'g')) >= 4
      THEN '已登記手機'
      ELSE NULL
    END
  FROM public.instructors i
  WHERE i.user_id IS NULL
    AND auth.uid() IS NOT NULL
    AND length(trim(name_query)) >= 1
    AND i.full_name ILIKE '%' || trim(name_query) || '%'
    -- phone_last4 蓄意不參與過濾（見上方註解）
  ORDER BY i.full_name
  LIMIT 20;
$$;

REVOKE ALL     ON FUNCTION public.search_unlinked_instructors(text, text) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.search_unlinked_instructors(text, text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.search_unlinked_instructors(text, text) TO authenticated;


-- ──────────────────────────────────────────────────────────────────
-- C. 驗證（需登入老師 session）
-- ──────────────────────────────────────────────────────────────────
--   結構：SELECT proname, pg_get_function_result(oid)
--           FROM pg_proc WHERE proname = 'submit_claim_request';
--         （回傳型別應為 jsonb）
--   行為：對一筆未綁定、名冊有手機的 instructor
--         填「正確」末四碼 → 應回 {"status":"approved"} 且該列 user_id 已寫入；
--         填「錯誤」末四碼 → 應回 {"status":"pending"}，auto_attempts 遞增；
--         猜錯 5 次後即使填對也回 pending（轉人工）。
