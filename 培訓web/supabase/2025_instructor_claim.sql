-- ═══════════════════════════════════════════════════════════════════
-- 講師帳號認領 / 綁定 Migration  (2025)
--
-- 目的:
--   1. 補上「email 對不上」時的認領申請機制(instructor_claim_requests)
--   2. 提供 RPC 讓前端在登入後可主動 link / 申請認領,而不必只依賴
--      auth.users INSERT trigger(避免 trigger 失效時新講師永遠卡 pending)
--   3. 提供 admin RPC 強制手動綁定 / 解綁
--
-- 安全性:
--   - 所有 RPC 都用 SECURITY DEFINER,但內部會檢查 auth.uid() / role
--   - 一般使用者只能操作「自己 email 對得上的列」或「自己送出的 claim」
--
-- 執行方式:在 Supabase Dashboard → SQL Editor 整段貼上執行
-- 重跑安全:全部使用 IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS
-- ═══════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────
-- A. instructor_claim_requests 表
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.instructor_claim_requests (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  requester_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instructor_id      uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  requester_email    text NOT NULL,
  proposed_phone     text,
  message            text,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewer_id        uuid REFERENCES auth.users(id),
  review_notes       text,
  reviewed_at        timestamptz,
  created_at         timestamptz DEFAULT now() NOT NULL,
  UNIQUE (requester_user_id, instructor_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_status
  ON public.instructor_claim_requests (status);
CREATE INDEX IF NOT EXISTS idx_claim_requester
  ON public.instructor_claim_requests (requester_user_id);

ALTER TABLE public.instructor_claim_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own claims" ON public.instructor_claim_requests;
CREATE POLICY "Users can view own claims"
  ON public.instructor_claim_requests FOR SELECT
  USING (auth.uid() = requester_user_id);

DROP POLICY IF EXISTS "Users can create own claims" ON public.instructor_claim_requests;
CREATE POLICY "Users can create own claims"
  ON public.instructor_claim_requests FOR INSERT
  WITH CHECK (auth.uid() = requester_user_id);

DROP POLICY IF EXISTS "Admins manage all claims" ON public.instructor_claim_requests;
CREATE POLICY "Admins manage all claims"
  ON public.instructor_claim_requests FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );


-- ──────────────────────────────────────────────────────────────────
-- B. RPC: find_unlinked_instructor_by_my_email
-- ──────────────────────────────────────────────────────────────────
-- 讓登入後的使用者查「我這個 email 在 instructors 表是否有未綁的列」
-- 只回最小辨識資訊(姓名 + 遮罩手機),避免洩漏其他人 PII
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.find_unlinked_instructor_by_my_email()
RETURNS TABLE (
  id                uuid,
  full_name         text,
  email_primary     text,
  phone_masked      text,
  employment_status text,
  instructor_role   text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    i.id,
    i.full_name,
    i.email_primary,
    CASE
      WHEN i.phone_mobile IS NOT NULL AND length(i.phone_mobile) >= 4
      THEN '••••' || right(i.phone_mobile, 4)
      ELSE NULL
    END,
    i.employment_status::text,
    i.instructor_role::text
  FROM public.instructors i
  JOIN auth.users u ON lower(u.email) = lower(i.email_primary)
  WHERE u.id = auth.uid() AND i.user_id IS NULL;
$$;


-- ──────────────────────────────────────────────────────────────────
-- C. RPC: link_my_instructor_by_email
-- ──────────────────────────────────────────────────────────────────
-- 「樂觀路徑 fallback」:當 DB trigger 沒接到時,前端可主動呼叫
-- 條件:該 instructors.email_primary = my email AND user_id IS NULL
-- 副作用:把 user_id 寫回 + 升 users.role(冷凍/取消 → pending)
-- 回傳:被綁的 instructor.id 或 NULL
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.link_my_instructor_by_email()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  my_email       text;
  matched_id     uuid;
  matched_status text;
  new_role       text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT email INTO my_email FROM auth.users WHERE id = auth.uid();
  IF my_email IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id, employment_status::text INTO matched_id, matched_status
  FROM public.instructors
  WHERE lower(email_primary) = lower(my_email) AND user_id IS NULL
  ORDER BY created_at ASC
  LIMIT 1;

  IF matched_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.instructors SET user_id = auth.uid() WHERE id = matched_id;

  new_role := CASE
    WHEN matched_status IN ('frozen', 'cancelled') THEN 'pending'
    ELSE 'teacher'
  END;
  UPDATE public.users
    SET role = new_role
    WHERE id = auth.uid() AND role = 'pending';

  RETURN matched_id;
END;
$$;


-- ──────────────────────────────────────────────────────────────────
-- D-pre. RPC: search_unlinked_instructors (一般使用者可呼叫)
-- ──────────────────────────────────────────────────────────────────
-- 給講師端「認領」UI 用:輸入姓名片段(+選填手機末四碼)
-- 搜尋未綁帳號的歷史 instructors,只回傳遮罩過的辨識資訊
-- 不要讓使用者直接 SELECT 整張表(RLS 已擋),這支 RPC 是受控的查詢窗口
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.search_unlinked_instructors(
  name_query  text,
  phone_last4 text DEFAULT NULL
)
RETURNS TABLE (
  id            uuid,
  full_name     text,
  email_masked  text,
  phone_masked  text
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
    CASE
      WHEN i.phone_mobile IS NOT NULL AND length(i.phone_mobile) >= 4
      THEN '••••' || right(i.phone_mobile, 4)
      ELSE NULL
    END
  FROM public.instructors i
  WHERE i.user_id IS NULL
    AND auth.uid() IS NOT NULL
    AND length(trim(name_query)) >= 1
    AND i.full_name ILIKE '%' || trim(name_query) || '%'
    AND (
      phone_last4 IS NULL
      OR length(phone_last4) <> 4
      OR right(i.phone_mobile, 4) = phone_last4
    )
  ORDER BY i.full_name
  LIMIT 20;
$$;


-- ──────────────────────────────────────────────────────────────────
-- D. RPC: submit_claim_request
-- ──────────────────────────────────────────────────────────────────
-- 「悲觀路徑」:email 對不上時,使用者選一筆 instructor 提出認領申請
-- 同 (requester, instructor) 重複送會 reset 回 pending
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.submit_claim_request(
  target_instructor_id uuid,
  phone_input          text DEFAULT NULL,
  message_input        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  my_email      text;
  claim_id      uuid;
  inst_user_id  uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT user_id INTO inst_user_id
  FROM public.instructors WHERE id = target_instructor_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instructor not found';
  END IF;

  IF inst_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'Instructor already linked';
  END IF;

  SELECT email INTO my_email FROM auth.users WHERE id = auth.uid();

  INSERT INTO public.instructor_claim_requests (
    requester_user_id, instructor_id, requester_email, proposed_phone, message
  ) VALUES (
    auth.uid(), target_instructor_id, my_email, phone_input, message_input
  )
  ON CONFLICT (requester_user_id, instructor_id) DO UPDATE
    SET proposed_phone = EXCLUDED.proposed_phone,
        message        = EXCLUDED.message,
        status         = 'pending',
        reviewer_id    = NULL,
        review_notes   = NULL,
        reviewed_at    = NULL
  RETURNING id INTO claim_id;

  RETURN claim_id;
END;
$$;


-- ──────────────────────────────────────────────────────────────────
-- E. RPC: approve_claim_request (admin only)
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.approve_claim_request(claim_id_input uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c_record       record;
  matched_status text;
  new_role       text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  SELECT * INTO c_record
  FROM public.instructor_claim_requests
  WHERE id = claim_id_input;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;

  IF c_record.status <> 'pending' THEN
    RAISE EXCEPTION 'Claim is not pending (current: %)', c_record.status;
  END IF;

  -- 該 instructor 必須仍未綁(可能被別人搶先 / 被 admin 手動綁)
  IF EXISTS (
    SELECT 1 FROM public.instructors
    WHERE id = c_record.instructor_id AND user_id IS NOT NULL
  ) THEN
    UPDATE public.instructor_claim_requests
      SET status = 'rejected',
          reviewer_id = auth.uid(),
          review_notes = '已被其他帳號綁定,自動拒絕',
          reviewed_at = now()
      WHERE id = claim_id_input;
    RAISE EXCEPTION 'Target instructor already linked to another user';
  END IF;

  SELECT employment_status::text INTO matched_status
  FROM public.instructors WHERE id = c_record.instructor_id;

  UPDATE public.instructors
    SET user_id = c_record.requester_user_id
    WHERE id = c_record.instructor_id;

  new_role := CASE
    WHEN matched_status IN ('frozen', 'cancelled') THEN 'pending'
    ELSE 'teacher'
  END;
  UPDATE public.users
    SET role = new_role
    WHERE id = c_record.requester_user_id AND role = 'pending';

  UPDATE public.instructor_claim_requests
    SET status = 'approved',
        reviewer_id = auth.uid(),
        reviewed_at = now()
    WHERE id = claim_id_input;
END;
$$;


-- ──────────────────────────────────────────────────────────────────
-- F. RPC: reject_claim_request (admin only)
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reject_claim_request(
  claim_id_input uuid,
  notes          text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  UPDATE public.instructor_claim_requests
    SET status       = 'rejected',
        reviewer_id  = auth.uid(),
        review_notes = notes,
        reviewed_at  = now()
    WHERE id = claim_id_input AND status = 'pending';
END;
$$;


-- ──────────────────────────────────────────────────────────────────
-- G. RPC: admin 強制綁定 / 解綁
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_link_instructor(
  target_instructor_id uuid,
  target_user_id       uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  matched_status text;
  new_role       text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  -- target_user_id 已綁其他 instructor 會被 instructors.user_id UNIQUE 擋住
  UPDATE public.instructors
    SET user_id = target_user_id
    WHERE id = target_instructor_id;

  SELECT employment_status::text INTO matched_status
  FROM public.instructors WHERE id = target_instructor_id;

  new_role := CASE
    WHEN matched_status IN ('frozen', 'cancelled') THEN 'pending'
    ELSE 'teacher'
  END;
  UPDATE public.users
    SET role = new_role
    WHERE id = target_user_id AND role = 'pending';
END;
$$;


CREATE OR REPLACE FUNCTION public.admin_unlink_instructor(target_instructor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Admin only';
  END IF;

  UPDATE public.instructors
    SET user_id = NULL
    WHERE id = target_instructor_id;
END;
$$;


-- ──────────────────────────────────────────────────────────────────
-- H. Reaffirm: instructors 表 RLS — Admin 全權
-- ──────────────────────────────────────────────────────────────────
-- 早期 instructors_setup.sql 已有此 policy,這裡再寫一次保險
-- (跨環境的 DB 可能漏跑,REPLACE 不會出錯)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'instructors'
      AND policyname = 'Admins can do everything on instructors'
  ) THEN
    EXECUTE $POL$
      CREATE POLICY "Admins can do everything on instructors"
        ON public.instructors FOR ALL
        USING (
          EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
        )
    $POL$;
  END IF;
END $$;


-- ──────────────────────────────────────────────────────────────────
-- I. 驗證查詢(可選)
-- ──────────────────────────────────────────────────────────────────
-- 看綁定狀態統計:
--   SELECT
--     COUNT(*) AS total,
--     COUNT(user_id) AS linked,
--     COUNT(*) - COUNT(user_id) AS unlinked
--   FROM public.instructors;
--
-- 看待認領申請:
--   SELECT * FROM public.instructor_claim_requests WHERE status = 'pending';
