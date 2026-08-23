CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  profile_complete boolean NOT NULL DEFAULT true
);
CREATE TABLE public.instructors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  instructor_role text
);
CREATE TABLE public.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  is_published boolean NOT NULL DEFAULT false,
  "order" integer NOT NULL DEFAULT 0,
  visibility text NOT NULL DEFAULT 'all'
);
CREATE TABLE public.lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  "order" integer NOT NULL DEFAULT 0,
  is_published boolean NOT NULL DEFAULT false
);
CREATE TABLE public.contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
);
CREATE TABLE public.progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  completed boolean NOT NULL DEFAULT false
);
CREATE TABLE public.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE
);
CREATE TABLE public.course_training_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE
);
CREATE TABLE public.lesson_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  body text NOT NULL
);
CREATE TABLE public.lesson_comment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES public.lesson_comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.course_training_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_comment_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile" ON public.users FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));
CREATE POLICY "Admins can do everything on courses" ON public.courses FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Admins can do everything on lessons" ON public.lessons FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Admins can do everything on contents" ON public.contents FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Admins can do everything on progress" ON public.progress FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Admins can do everything on assignments" ON public.assignments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Admins can do everything on course_training_status" ON public.course_training_status FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Admins full access on lesson comments" ON public.lesson_comments FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));

CREATE POLICY "Approved users can view published courses" ON public.courses FOR SELECT TO authenticated USING (true);
CREATE POLICY "Approved users can view published lessons" ON public.lessons FOR SELECT TO authenticated USING (true);
CREATE POLICY "Approved users can view contents" ON public.contents FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can view own progress" ON public.progress FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own progress" ON public.progress FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own progress" ON public.progress FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can view own assignments" ON public.assignments FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own assignments" ON public.assignments FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can view own training status" ON public.course_training_status FOR SELECT TO authenticated USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Anyone can read lesson comments" ON public.lesson_comments FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can insert own comments" ON public.lesson_comments FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Anyone can read comment likes" ON public.lesson_comment_likes FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can like comments" ON public.lesson_comment_likes FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = user_id);

GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON public.users, public.instructors TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.courses, public.lessons, public.contents,
  public.progress, public.assignments, public.course_training_status,
  public.lesson_comments, public.lesson_comment_likes TO authenticated;

CREATE FUNCTION public.is_my_instructor_profile_complete()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT u.profile_complete FROM public.users u WHERE u.id = auth.uid()
  ), false)
$$;
GRANT EXECUTE ON FUNCTION public.is_my_instructor_profile_complete() TO authenticated;

INSERT INTO public.users (id, role, profile_complete) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin', true),
  ('00000000-0000-0000-0000-000000000002', 'teacher', true),
  ('00000000-0000-0000-0000-000000000003', 'teacher', true),
  ('00000000-0000-0000-0000-000000000004', 'teacher', false);
INSERT INTO public.instructors (user_id, instructor_role) VALUES
  ('00000000-0000-0000-0000-000000000002', '實習'),
  ('00000000-0000-0000-0000-000000000003', 'A'),
  ('00000000-0000-0000-0000-000000000004', 'A');
INSERT INTO public.courses (id, title, is_published, visibility)
VALUES ('10000000-0000-0000-0000-000000000001', '既有課程', true, 'all');

\ir ../supabase/migrations/20260823094617_add_course_categories.sql

INSERT INTO public.course_categories (id, title, visibility, is_published, "order") VALUES
  ('20000000-0000-0000-0000-000000000001', '公開分類', 'all', true, 1),
  ('20000000-0000-0000-0000-000000000002', '實習分類', 'intern', true, 2),
  ('20000000-0000-0000-0000-000000000003', '正式分類', 'formal', true, 3),
  ('20000000-0000-0000-0000-000000000004', '未發佈分類', 'all', false, 4);

INSERT INTO public.courses (id, category_id, title, is_published, visibility, "order") VALUES
  ('10000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '公開課程', true, 'all', 1),
  ('10000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000002', '實習課程', true, 'all', 2),
  ('10000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000003', '正式課程', true, 'all', 3),
  ('10000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000003', '分類課程條件衝突', true, 'intern', 4),
  ('10000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000004', '未發佈分類課程', true, 'all', 5);

INSERT INTO public.lessons (id, course_id, title, is_published)
SELECT ('30000000-0000-0000-0000-' || LPAD(ROW_NUMBER() OVER ()::text, 12, '0'))::uuid, id, title, true
FROM public.courses ORDER BY id;
INSERT INTO public.contents (id, lesson_id, status)
SELECT ('40000000-0000-0000-0000-' || LPAD(ROW_NUMBER() OVER ()::text, 12, '0'))::uuid, id, 'published'
FROM public.lessons ORDER BY id;
INSERT INTO public.lesson_comments (id, lesson_id, user_id, body)
SELECT ('50000000-0000-0000-0000-' || LPAD(ROW_NUMBER() OVER ()::text, 12, '0'))::uuid,
       id, '00000000-0000-0000-0000-000000000002', '留言'
FROM public.lessons ORDER BY id;
INSERT INTO public.lesson_comment_likes (comment_id, user_id)
SELECT id, '00000000-0000-0000-0000-000000000002' FROM public.lesson_comments;
INSERT INTO public.progress (user_id, lesson_id)
SELECT '00000000-0000-0000-0000-000000000002', id FROM public.lessons;
INSERT INTO public.assignments (user_id, lesson_id)
SELECT '00000000-0000-0000-0000-000000000002', id FROM public.lessons;
INSERT INTO public.course_training_status (user_id, course_id)
SELECT '00000000-0000-0000-0000-000000000002', id FROM public.courses;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.course_categories) <> 3 THEN RAISE EXCEPTION 'intern category visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.courses) <> 3 THEN RAISE EXCEPTION 'intern course visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.lessons) <> 3 THEN RAISE EXCEPTION 'intern lesson visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.contents) <> 3 THEN RAISE EXCEPTION 'intern content visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.lesson_comments) <> 3 THEN RAISE EXCEPTION 'intern comment visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.lesson_comment_likes) <> 3 THEN RAISE EXCEPTION 'intern like visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.progress) <> 3 THEN RAISE EXCEPTION 'intern progress visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.assignments) <> 3 THEN RAISE EXCEPTION 'intern assignment visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.course_training_status) <> 3 THEN RAISE EXCEPTION 'intern status visibility failed'; END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false);
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.course_categories) <> 3 THEN RAISE EXCEPTION 'formal category visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.courses) <> 3 THEN RAISE EXCEPTION 'formal course visibility failed'; END IF;
  IF EXISTS (SELECT 1 FROM public.courses WHERE title = '分類課程條件衝突') THEN RAISE EXCEPTION 'course restriction did not intersect category'; END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', false);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.course_categories) THEN RAISE EXCEPTION 'incomplete profile saw category'; END IF;
  IF EXISTS (SELECT 1 FROM public.courses) THEN RAISE EXCEPTION 'incomplete profile saw course'; END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM public.course_categories) <> 5 THEN RAISE EXCEPTION 'admin category visibility failed'; END IF;
  IF (SELECT COUNT(*) FROM public.courses) <> 6 THEN RAISE EXCEPTION 'admin course visibility failed'; END IF;
END $$;
INSERT INTO public.course_categories (title, visibility, is_published) VALUES ('管理員新增測試', 'all', false);
UPDATE public.course_categories SET title = '管理員更新測試' WHERE title = '管理員新增測試';
DELETE FROM public.course_categories WHERE title = '管理員更新測試';

RESET ROLE;
SELECT 'PASS: category backfill, CRUD grants, audience RLS, and direct-child access checks' AS result;
