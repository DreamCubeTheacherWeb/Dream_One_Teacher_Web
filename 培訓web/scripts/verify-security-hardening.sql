\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE ROLE anon;
CREATE ROLE authenticated;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
CREATE OR REPLACE FUNCTION storage.foldername(object_name text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN array_length(string_to_array(object_name, '/'), 1) > 1
      THEN (string_to_array(object_name, '/'))[1:array_length(string_to_array(object_name, '/'), 1) - 1]
    ELSE ARRAY[]::text[]
  END
$$;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  name text,
  email text,
  role text NOT NULL,
  mentor_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.instructors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE,
  full_name text, nickname text, gender text, birth_date date, id_number text,
  phone_mobile text, line_id text, address text, household_address text, email_primary text,
  teaching_freq_semester text, teaching_freq_vacation text, teaching_regions text[], bio_notes text,
  bank_account_name text, bank_name text, bank_branch text, bank_account_number text, bank_code text,
  id_front_path text, id_back_path text, photo_path text, bankbook_path text,
  bankbook_mime text, bankbook_size bigint, bankbook_uploaded_at timestamptz,
  employment_status text, instructor_role text, speed_qualification text,
  form_submitted_at timestamptz, note_internal text, teaching_regions_raw text, bank_info_raw text,
  id_front_external_url text, id_back_external_url text, photo_external_url text, bankbook_external_url text,
  wca_name text, wca_synced_at timestamptz, hide_from_leaderboard boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.class_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instructor_id uuid,
  duration_hours numeric,
  total_salary numeric,
  paid_amount numeric,
  month_label text,
  session_date date,
  status text
);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
CREATE TABLE public.courses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_published boolean NOT NULL DEFAULT false);
CREATE TABLE public.lessons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), course_id uuid, is_published boolean NOT NULL DEFAULT false);
CREATE TABLE public.contents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), lesson_id uuid, status text);
CREATE TABLE public.progress (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.assignment_feedbacks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id uuid);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, type text, title text,
  body text, link text, is_read boolean NOT NULL DEFAULT false
);
CREATE TABLE public.lesson_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, lesson_id uuid, body text
);
CREATE TABLE public.lesson_comment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), comment_id uuid, user_id uuid
);
CREATE TABLE public.instructor_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, status text
);
CREATE TABLE public.course_training_status (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE public.teacher_invites (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text);
CREATE TABLE public.wca_sync_config (id int PRIMARY KEY, secret text NOT NULL);

CREATE OR REPLACE FUNCTION public.get_wca_sync_targets(text)
RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::uuid WHERE false $$;
CREATE OR REPLACE FUNCTION public.sync_wca_results(text, jsonb)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{}'::jsonb $$;

ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignment_feedbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_comment_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instructor_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own instructor profile" ON public.instructors
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own instructor profile" ON public.instructors
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Staff can view all instructors" ON public.instructors
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('admin', 'mentor')
    )
  );
CREATE POLICY "Instructors view own sessions" ON public.class_sessions
  FOR SELECT TO authenticated USING (
    instructor_id IN (
      SELECT id FROM public.instructors WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "Staff view all sessions" ON public.class_sessions
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.users
      WHERE id = auth.uid() AND role IN ('admin', 'mentor')
    )
  );

CREATE VIEW public.instructor_salary_summary AS
SELECT
  i.id AS instructor_id,
  i.user_id,
  i.full_name,
  count(s.id) AS total_sessions,
  COALESCE(sum(s.total_salary), 0::numeric) AS total_salary
FROM public.instructors i
LEFT JOIN public.class_sessions s ON s.instructor_id = i.id
GROUP BY i.id, i.user_id, i.full_name;
CREATE POLICY "Users can upload own instructor files" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
CREATE POLICY "Users can view own instructor files" ON storage.objects
  FOR SELECT TO authenticated USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
CREATE POLICY "Users can insert own likes" ON public.lesson_comment_likes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can view own contracts" ON public.instructor_contracts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own contracts" ON public.instructor_contracts
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid(), storage.foldername(text) TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, storage TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_wca_sync_targets(text), public.sync_wca_results(text, jsonb) TO anon, authenticated;

INSERT INTO public.wca_sync_config (id, secret) VALUES (1, 'old-test-secret');

\ir ../supabase/migrations/20260819140407_security_hardening_release.sql
\ir ../supabase/migrations/20260819153000_enable_core_rls.sql

DO $$
BEGIN
  IF (SELECT secret = 'old-test-secret' OR rotated_at IS NULL FROM public.wca_sync_config WHERE id = 1) THEN
    RAISE EXCEPTION 'WCA secret was not rotated';
  END IF;
  IF has_function_privilege('authenticated', 'public.get_wca_sync_targets(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated retained WCA RPC capability';
  END IF;
  IF NOT has_function_privilege('anon', 'public.get_wca_sync_targets(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon WCA RPC capability missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('users', 'courses', 'lessons', 'contents', 'assignments')
      AND NOT c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'core public table still has RLS disabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'instructor_salary_summary'
      AND 'security_invoker=true' = ANY (c.reloptions)
  ) THEN
    RAISE EXCEPTION 'salary view is not security_invoker';
  END IF;
END;
$$;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'teacher@test.local'),
  ('00000000-0000-4000-8000-000000000002', 'other@test.local'),
  ('00000000-0000-4000-8000-000000000003', 'admin@test.local'),
  ('00000000-0000-4000-8000-000000000004', 'mentor@test.local'),
  ('00000000-0000-4000-8000-000000000005', 'pending@test.local');
INSERT INTO public.users (id, name, email, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Teacher', 'teacher@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', 'Other', 'other@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000003', 'Admin', 'admin@test.local', 'admin'),
  ('00000000-0000-4000-8000-000000000004', 'Mentor', 'mentor@test.local', 'mentor'),
  ('00000000-0000-4000-8000-000000000005', 'Pending', 'pending@test.local', 'pending');

INSERT INTO public.instructors (
  user_id, full_name, nickname, gender, birth_date, id_number, phone_mobile, line_id,
  address, household_address, email_primary, teaching_freq_semester, teaching_freq_vacation,
  teaching_regions, bio_notes, bank_account_name, bank_name, bank_branch,
  bank_account_number, bank_code, id_front_path, id_back_path, bankbook_path, photo_path
) VALUES (
  '00000000-0000-4000-8000-000000000001', '完整講師', '小完', '男', '1990-01-01', 'A123456789',
  '0912345678', 'line', '通訊地址', '戶籍地址', 'teacher@test.local', '每週', '每週', ARRAY['臺北市'],
  '完整介紹', '完整講師', '測試銀行', '測試分行', '1234567890', '0000000',
  'instructors/00000000-0000-4000-8000-000000000001/id_front/front.png',
  'instructors/00000000-0000-4000-8000-000000000001/id_back/back.png',
  'instructors/00000000-0000-4000-8000-000000000001/bankbook/book.png', NULL
), (
  '00000000-0000-4000-8000-000000000002', '未完整講師', '小缺', '女', '1990-01-01', 'B123456789',
  '0987654321', 'line2', '通訊地址', '戶籍地址', 'other@test.local', '每週', '每週', ARRAY['臺北市'],
  '完整介紹', '未完整講師', '測試銀行', '測試分行', '1234567890', '0000000',
  NULL, NULL, NULL, NULL
);

INSERT INTO public.class_sessions (instructor_id, duration_hours, total_salary, paid_amount, month_label, session_date, status)
SELECT id, 2, 2000, 500, '2026/08', '2026-08-01', 'approved'
FROM public.instructors
WHERE user_id = '00000000-0000-4000-8000-000000000001';
INSERT INTO public.class_sessions (instructor_id, duration_hours, total_salary, paid_amount, month_label, session_date, status)
SELECT id, 3, 3000, 1000, '2026/08', '2026-08-02', 'approved'
FROM public.instructors
WHERE user_id = '00000000-0000-4000-8000-000000000002';

INSERT INTO public.courses (id, is_published) VALUES
  ('10000000-0000-4000-8000-000000000001', true),
  ('10000000-0000-4000-8000-000000000002', false);
INSERT INTO public.lessons (id, course_id, is_published) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', true),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', false);
INSERT INTO public.contents (lesson_id, status) VALUES
  ('20000000-0000-4000-8000-000000000001', 'published'),
  ('20000000-0000-4000-8000-000000000001', 'draft');
INSERT INTO public.assignments (id, user_id) VALUES
  ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002');
INSERT INTO public.assignment_feedbacks (assignment_id) VALUES
  ('40000000-0000-4000-8000-000000000001'),
  ('40000000-0000-4000-8000-000000000002');

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001"}', false);
SET ROLE authenticated;

DO $$
BEGIN
  IF NOT public.is_my_instructor_profile_complete() THEN
    RAISE EXCEPTION 'complete profile with optional photo was rejected';
  END IF;
  IF (SELECT count(*) FROM public.courses) <> 1 THEN
    RAISE EXCEPTION 'course publication/profile gate failed';
  END IF;
  IF (SELECT count(*) FROM public.assignment_feedbacks) <> 1 THEN
    RAISE EXCEPTION 'assignment feedback ownership scope failed';
  END IF;
  IF (SELECT count(*) FROM public.users) <> 1 THEN
    RAISE EXCEPTION 'teacher could read another public.users row';
  END IF;
  IF (SELECT count(*) FROM public.instructor_salary_summary) <> 1
     OR (SELECT total_salary FROM public.instructor_salary_summary) <> 2000 THEN
    RAISE EXCEPTION 'teacher salary view bypassed underlying RLS';
  END IF;

  UPDATE public.users SET role = 'admin' WHERE id = auth.uid();
  IF FOUND THEN
    RAISE EXCEPTION 'teacher changed own application role';
  END IF;

  BEGIN
    INSERT INTO public.courses (is_published) VALUES (false);
    RAISE EXCEPTION 'teacher created a course';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  INSERT INTO public.instructor_profile_drafts (user_id, data)
  VALUES (auth.uid(), '{"address":"own draft"}');
  IF (SELECT count(*) FROM public.instructor_profile_drafts) <> 1 THEN
    RAISE EXCEPTION 'own server-side draft was not readable';
  END IF;
  BEGIN
    INSERT INTO public.instructor_profile_drafts (user_id, data)
    VALUES ('00000000-0000-4000-8000-000000000002', '{"address":"forged"}');
    RAISE EXCEPTION 'teacher wrote another user draft';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.instructors SET employment_status = 'active'
     WHERE user_id = auth.uid();
    RAISE EXCEPTION 'teacher changed administrator-managed field';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  BEGIN
    UPDATE public.instructors SET id = gen_random_uuid()
     WHERE user_id = auth.uid();
    RAISE EXCEPTION 'teacher changed instructor row identity';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;

  UPDATE public.instructors SET full_name = '完整講師更新'
   WHERE user_id = auth.uid();

  BEGIN
    INSERT INTO public.notifications (user_id, type, title)
    VALUES (auth.uid(), 'like', 'forged');
    RAISE EXCEPTION 'teacher forged notification';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.instructor_contracts (user_id, status) VALUES (auth.uid(), 'signed');
    RAISE EXCEPTION 'teacher forged signed contract';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.delete_user_completely(auth.uid());
    RAISE EXCEPTION 'teacher invoked admin deletion RPC';
  EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
  END;
END;
$$;

RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000004"}', false);
SET ROLE authenticated;
DO $$
DECLARE
  new_course_id uuid;
  new_lesson_id uuid;
BEGIN
  IF (SELECT count(*) FROM public.users) <> 5 THEN
    RAISE EXCEPTION 'mentor could not read staff user directory';
  END IF;
  IF (SELECT count(*) FROM public.courses) <> 2 THEN
    RAISE EXCEPTION 'mentor could not read draft courses';
  END IF;
  IF (SELECT count(*) FROM public.assignments) <> 2 THEN
    RAISE EXCEPTION 'mentor could not read assignments';
  END IF;
  IF (SELECT count(*) FROM public.instructor_salary_summary) <> 2 THEN
    RAISE EXCEPTION 'mentor could not read staff salary summary';
  END IF;

  INSERT INTO public.courses (is_published) VALUES (false) RETURNING id INTO new_course_id;
  INSERT INTO public.lessons (course_id, is_published) VALUES (new_course_id, false) RETURNING id INTO new_lesson_id;
  INSERT INTO public.contents (lesson_id, status) VALUES (new_lesson_id, 'draft');
  DELETE FROM public.contents WHERE lesson_id = new_lesson_id;
  DELETE FROM public.lessons WHERE id = new_lesson_id;
  DELETE FROM public.courses WHERE id = new_course_id;

  UPDATE public.users SET role = 'admin'
   WHERE id = '00000000-0000-4000-8000-000000000002';
  IF FOUND THEN
    RAISE EXCEPTION 'mentor escalated another user role';
  END IF;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003"}', false);
SET ROLE authenticated;
DO $$
BEGIN
  UPDATE public.users SET mentor_name = 'Mentor'
   WHERE id = '00000000-0000-4000-8000-000000000001';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admin could not manage user profiles';
  END IF;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001"}', false);

INSERT INTO public.lesson_comments (id, user_id, lesson_id, body) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '20000000-0000-4000-8000-000000000001',
  '真實留言'
);

SET ROLE authenticated;
INSERT INTO public.lesson_comment_likes (comment_id, user_id) VALUES (
  '30000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001'
);
SELECT public.ensure_my_contract_reminder();
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.notifications
     WHERE user_id = '00000000-0000-4000-8000-000000000002'
       AND type = 'like' AND body = '真實留言'
  ) THEN
    RAISE EXCEPTION 'trusted like notification was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.notifications
     WHERE user_id = '00000000-0000-4000-8000-000000000001'
       AND type = 'contract' AND link = '/contract'
  ) THEN
    RAISE EXCEPTION 'trusted contract reminder was not created';
  END IF;
END;
$$;

INSERT INTO storage.objects (bucket_id, name) VALUES
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-000000000001/bankbook/book.png'),
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-000000000001/photo/replaceable.png');

SET ROLE authenticated;
DELETE FROM storage.objects
 WHERE name = 'instructors/00000000-0000-4000-8000-000000000001/bankbook/book.png';
DELETE FROM storage.objects
 WHERE name = 'instructors/00000000-0000-4000-8000-000000000001/photo/replaceable.png';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects
     WHERE name = 'instructors/00000000-0000-4000-8000-000000000001/bankbook/book.png'
  ) THEN
    RAISE EXCEPTION 'saved bankbook object was deleted by owner';
  END IF;
  IF EXISTS (
    SELECT 1 FROM storage.objects
     WHERE name = 'instructors/00000000-0000-4000-8000-000000000001/photo/replaceable.png'
  ) THEN
    RAISE EXCEPTION 'ordinary owner object could not be deleted';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000002"}', false);
SET ROLE authenticated;
DO $$
BEGIN
  IF public.is_my_instructor_profile_complete() THEN
    RAISE EXCEPTION 'incomplete profile was accepted';
  END IF;
  IF EXISTS (SELECT 1 FROM public.courses) THEN
    RAISE EXCEPTION 'incomplete teacher could read course';
  END IF;
END;
$$;
RESET ROLE;

SELECT 'PASS: canonical security migration and authorization behavior' AS result;
