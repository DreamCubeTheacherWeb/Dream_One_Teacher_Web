-- 上線前 canonical security hardening。
-- 依賴既有 instructors/contracts/comments/notifications/course schema。
-- 本檔不讀取或輸出任何既有密鑰；WCA secret 會在首次套用時自動輪替。

-- ────────────────────────────────────────────────────────────────────
-- 1. 敏感個人資料草稿改存受 RLS 保護的 server-side table
-- ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.instructor_profile_drafts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(data) = 'object')
    CHECK (octet_length(data::text) <= 131072),
  base_updated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.instructor_profile_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instructor_profile_drafts FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instructor_profile_drafts TO authenticated;

DROP POLICY IF EXISTS "Users can read own instructor draft" ON public.instructor_profile_drafts;
DROP POLICY IF EXISTS "Users can insert own instructor draft" ON public.instructor_profile_drafts;
DROP POLICY IF EXISTS "Users can update own instructor draft" ON public.instructor_profile_drafts;
DROP POLICY IF EXISTS "Users can delete own instructor draft" ON public.instructor_profile_drafts;

CREATE POLICY "Users can read own instructor draft"
  ON public.instructor_profile_drafts FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own instructor draft"
  ON public.instructor_profile_drafts FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own instructor draft"
  ON public.instructor_profile_drafts FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can delete own instructor draft"
  ON public.instructor_profile_drafts FOR DELETE TO authenticated
  USING ((SELECT auth.uid()) = user_id);


-- ────────────────────────────────────────────────────────────────────
-- 2. 講師只能更新個人欄位；管理狀態、匯入原文與同步結果由 admin/service 管理
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.guard_instructor_admin_fields()
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
    IF NEW.employment_status IS NOT NULL
       OR NEW.instructor_role IS NOT NULL
       OR NEW.speed_qualification IS NOT NULL
       OR NEW.form_submitted_at IS NOT NULL
       OR NEW.note_internal IS NOT NULL
       OR NEW.teaching_regions_raw IS NOT NULL
       OR NEW.bank_info_raw IS NOT NULL
       OR NEW.id_front_external_url IS NOT NULL
       OR NEW.id_back_external_url IS NOT NULL
       OR NEW.photo_external_url IS NOT NULL
       OR NEW.bankbook_external_url IS NOT NULL
       OR NEW.wca_name IS NOT NULL
       OR NEW.wca_synced_at IS NOT NULL
       OR NEW.hide_from_leaderboard IS DISTINCT FROM false THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'administrator-managed instructor fields cannot be set by instructors';
    END IF;
  ELSIF ROW(
      NEW.id, NEW.user_id, NEW.created_at,
      NEW.employment_status, NEW.instructor_role, NEW.speed_qualification,
      NEW.form_submitted_at, NEW.note_internal, NEW.teaching_regions_raw,
      NEW.bank_info_raw, NEW.id_front_external_url, NEW.id_back_external_url,
      NEW.photo_external_url, NEW.bankbook_external_url, NEW.wca_name,
      NEW.wca_synced_at, NEW.hide_from_leaderboard
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.user_id, OLD.created_at,
      OLD.employment_status, OLD.instructor_role, OLD.speed_qualification,
      OLD.form_submitted_at, OLD.note_internal, OLD.teaching_regions_raw,
      OLD.bank_info_raw, OLD.id_front_external_url, OLD.id_back_external_url,
      OLD.photo_external_url, OLD.bankbook_external_url, OLD.wca_name,
      OLD.wca_synced_at, OLD.hide_from_leaderboard
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'administrator-managed instructor fields cannot be changed by instructors';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_admin_fields() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_instructor_admin_fields ON public.instructors;
CREATE TRIGGER trg_guard_instructor_admin_fields
  BEFORE INSERT OR UPDATE ON public.instructors
  FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_admin_fields();

DROP POLICY IF EXISTS "Users can update own instructor profile" ON public.instructors;
CREATE POLICY "Users can update own instructor profile"
  ON public.instructors FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);


-- ────────────────────────────────────────────────────────────────────
-- 3. 已提交存摺檔案不可由本人覆寫、搬移或刪除；admin 保留受控處理能力
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can update own instructor files" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own instructor files" ON storage.objects;
DROP POLICY IF EXISTS "Admins can upload all instructor files" ON storage.objects;
DROP POLICY IF EXISTS "Admins can update all instructor files" ON storage.objects;

CREATE POLICY "Users can update own instructor files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT EXISTS (
      SELECT 1 FROM public.instructors i
      WHERE i.user_id = (SELECT auth.uid())
        AND NULLIF(BTRIM(i.bankbook_path), '') = name
    )
  )
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT EXISTS (
      SELECT 1 FROM public.instructors i
      WHERE i.user_id = (SELECT auth.uid())
        AND NULLIF(BTRIM(i.bankbook_path), '') = name
    )
  );

CREATE POLICY "Users can delete own instructor files"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
    AND NOT EXISTS (
      SELECT 1 FROM public.instructors i
      WHERE i.user_id = (SELECT auth.uid())
        AND NULLIF(BTRIM(i.bankbook_path), '') = name
    )
  );

CREATE POLICY "Admins can upload all instructor files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin')
  );
CREATE POLICY "Admins can update all instructor files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin')
  )
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin')
  );


-- ────────────────────────────────────────────────────────────────────
-- 4. 完整度改成 DB authorization；photo_path 明確維持選填
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_my_instructor_profile_complete()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.instructors i
    WHERE i.user_id = auth.uid()
      AND NULLIF(BTRIM(i.full_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.nickname), '') IS NOT NULL
      AND NULLIF(BTRIM(i.gender), '') IS NOT NULL
      AND i.birth_date IS NOT NULL
      AND NULLIF(BTRIM(i.id_number), '') IS NOT NULL
      AND NULLIF(BTRIM(i.phone_mobile), '') IS NOT NULL
      AND NULLIF(BTRIM(i.line_id), '') IS NOT NULL
      AND NULLIF(BTRIM(i.address), '') IS NOT NULL
      AND NULLIF(BTRIM(i.household_address), '') IS NOT NULL
      AND NULLIF(BTRIM(i.email_primary), '') IS NOT NULL
      AND NULLIF(BTRIM(i.teaching_freq_semester), '') IS NOT NULL
      AND NULLIF(BTRIM(i.teaching_freq_vacation), '') IS NOT NULL
      AND COALESCE(cardinality(i.teaching_regions), 0) > 0
      AND NULLIF(BTRIM(i.bio_notes), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_account_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_branch), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_account_number), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_code), '') IS NOT NULL
      AND NULLIF(BTRIM(i.id_front_path), '') IS NOT NULL
      AND NULLIF(BTRIM(i.id_back_path), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bankbook_path), '') IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION public.is_my_instructor_profile_complete() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_instructor_profile_complete() TO authenticated;

DROP POLICY IF EXISTS "Approved users can view published courses" ON public.courses;
CREATE POLICY "Approved users can view published courses"
  ON public.courses FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher')
    AND (SELECT public.is_my_instructor_profile_complete())
  );

DROP POLICY IF EXISTS "Approved users can view published lessons" ON public.lessons;
CREATE POLICY "Approved users can view published lessons"
  ON public.lessons FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (SELECT 1 FROM public.courses c WHERE c.id = course_id AND c.is_published = true)
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher')
    AND (SELECT public.is_my_instructor_profile_complete())
  );

DROP POLICY IF EXISTS "Approved users can view contents" ON public.contents;
CREATE POLICY "Approved users can view contents"
  ON public.contents FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1
      FROM public.lessons l
      JOIN public.courses c ON c.id = l.course_id
      WHERE l.id = lesson_id AND l.is_published = true AND c.is_published = true
    )
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher')
    AND (SELECT public.is_my_instructor_profile_complete())
  );

DROP POLICY IF EXISTS "Users can view own progress" ON public.progress;
DROP POLICY IF EXISTS "Users can insert own progress" ON public.progress;
DROP POLICY IF EXISTS "Users can update own progress" ON public.progress;
CREATE POLICY "Users can view own progress" ON public.progress FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id AND (SELECT public.is_my_instructor_profile_complete()));
CREATE POLICY "Users can insert own progress" ON public.progress FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id AND (SELECT public.is_my_instructor_profile_complete()));
CREATE POLICY "Users can update own progress" ON public.progress FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id AND (SELECT public.is_my_instructor_profile_complete()))
  WITH CHECK ((SELECT auth.uid()) = user_id AND (SELECT public.is_my_instructor_profile_complete()));

DROP POLICY IF EXISTS "Users can view own assignments" ON public.assignments;
DROP POLICY IF EXISTS "Users can insert own assignments" ON public.assignments;
CREATE POLICY "Users can view own assignments" ON public.assignments FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id AND (SELECT public.is_my_instructor_profile_complete()));
CREATE POLICY "Users can insert own assignments" ON public.assignments FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id AND (SELECT public.is_my_instructor_profile_complete()));


-- ────────────────────────────────────────────────────────────────────
-- 5. 作業回饋只能由作業本人、mentor、admin 讀取
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Anyone can read feedbacks" ON public.assignment_feedbacks;
DROP POLICY IF EXISTS "Scoped assignment feedback reads" ON public.assignment_feedbacks;
CREATE POLICY "Scoped assignment feedback reads"
  ON public.assignment_feedbacks FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor'))
    OR (
      (SELECT public.is_my_instructor_profile_complete())
      AND EXISTS (
        SELECT 1 FROM public.assignments a
        WHERE a.id = assignment_feedbacks.assignment_id
          AND a.user_id = (SELECT auth.uid())
      )
    )
  );


-- ────────────────────────────────────────────────────────────────────
-- 6. 通知 client INSERT 僅 staff；按讚與本人合約提醒由可信 DB 路徑產生
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Staff can insert notifications" ON public.notifications;
DROP POLICY IF EXISTS "notifications insert guarded" ON public.notifications;
DROP POLICY IF EXISTS "Staff-only notification inserts" ON public.notifications;
CREATE POLICY "Staff-only notification inserts"
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor'))
  );

CREATE OR REPLACE FUNCTION public.notify_lesson_comment_like()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  liked_comment record;
BEGIN
  SELECT lc.user_id, lc.body, lc.lesson_id, l.course_id
    INTO liked_comment
    FROM public.lesson_comments lc
    JOIN public.lessons l ON l.id = lc.lesson_id
   WHERE lc.id = NEW.comment_id;

  IF liked_comment.user_id IS NOT NULL AND liked_comment.user_id <> NEW.user_id THEN
    INSERT INTO public.notifications (user_id, type, title, body, link)
    VALUES (
      liked_comment.user_id,
      'like',
      '你的留言被按讚了',
      LEFT(COALESCE(liked_comment.body, '你的留言'), 50),
      format('/courses/%s/lessons/%s', liked_comment.course_id, liked_comment.lesson_id)
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.notify_lesson_comment_like() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_notify_lesson_comment_like ON public.lesson_comment_likes;
CREATE TRIGGER trg_notify_lesson_comment_like
  AFTER INSERT ON public.lesson_comment_likes
  FOR EACH ROW EXECUTE FUNCTION public.notify_lesson_comment_like();

CREATE OR REPLACE FUNCTION public.ensure_my_contract_reminder()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = actor_id AND u.role <> 'pending'
  ) OR EXISTS (
    SELECT 1 FROM public.instructor_contracts c WHERE c.user_id = actor_id AND c.status = 'signed'
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, link)
  SELECT actor_id, 'contract', '尚未完成合約簽署', '請盡快前往簽署合約，完成後才算正式生效。', '/contract'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.notifications n
    WHERE n.user_id = actor_id
      AND n.type = 'contract'
      AND n.link = '/contract'
      AND n.is_read = false
  );
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_my_contract_reminder() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_my_contract_reminder() TO authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 7. 合約完成狀態不可由 client 直接建立；簽署文件只允許本人或 staff 讀取
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can insert own contracts" ON public.instructor_contracts;

DROP POLICY IF EXISTS "Authenticated can read contract documents storage" ON storage.objects;
DROP POLICY IF EXISTS "read contract documents scoped" ON storage.objects;
CREATE POLICY "read contract documents scoped"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'contract-documents'
    AND (
      EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor'))
      OR (
        (storage.foldername(name))[1] = 'signed'
        AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
      )
      OR (storage.foldername(name))[1] IS DISTINCT FROM 'signed'
    )
  );


-- ────────────────────────────────────────────────────────────────────
-- 8. account deletion RPC 永遠以 canonical admin guard 收尾
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_user_completely(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_email text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permission denied: admin only';
  END IF;

  SELECT au.email INTO target_email FROM auth.users au WHERE au.id = target_user_id;
  DELETE FROM public.instructor_profile_drafts WHERE user_id = target_user_id;
  DELETE FROM public.instructor_contracts WHERE user_id = target_user_id;
  DELETE FROM public.instructors WHERE user_id = target_user_id;
  DELETE FROM public.progress WHERE user_id = target_user_id;
  DELETE FROM public.assignments WHERE user_id = target_user_id;
  DELETE FROM public.course_training_status WHERE user_id = target_user_id;
  DELETE FROM public.notifications WHERE user_id = target_user_id;
  DELETE FROM public.users WHERE id = target_user_id;
  IF target_email IS NOT NULL THEN
    DELETE FROM public.teacher_invites ti WHERE lower(btrim(ti.email)) = lower(btrim(target_email));
  END IF;
  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_user_completely(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_completely(uuid) TO authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 9. 使 Git 歷史中的舊 WCA capability 失效；新值只可放 DB 與 CI secret
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.wca_sync_config
  ADD COLUMN IF NOT EXISTS rotated_at timestamptz;

UPDATE public.wca_sync_config
   SET secret = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
       rotated_at = now()
 WHERE id = 1
   AND rotated_at IS NULL;

REVOKE ALL ON FUNCTION public.get_wca_sync_targets(text) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.sync_wca_results(text, jsonb) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.get_wca_sync_targets(text) TO anon;
GRANT EXECUTE ON FUNCTION public.sync_wca_results(text, jsonb) TO anon;

-- 套用後由管理員在 Supabase SQL Editor 讀取新值一次，更新 GitHub Actions
-- WCA_SYNC_SECRET；不可把值寫回 repository、issue、log 或聊天紀錄。
