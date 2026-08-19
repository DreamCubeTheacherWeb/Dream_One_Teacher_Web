-- Close production schema drift reported by Supabase Security Advisor.
-- These tables already had policies, but RLS itself was disabled in the live
-- project.  Rebuild the policies before enabling RLS so the admin/mentor UI
-- keeps the access it intentionally exposes.

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.current_user_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = (SELECT auth.uid())
      AND role = 'admin'
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = (SELECT auth.uid())
      AND role IN ('admin', 'mentor')
  );
$$;

CREATE OR REPLACE FUNCTION private.current_user_is_teacher()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users
    WHERE id = (SELECT auth.uid())
      AND role = 'teacher'
  );
$$;

REVOKE ALL ON FUNCTION private.current_user_is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.current_user_is_staff() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION private.current_user_is_teacher() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_user_is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_is_staff() TO authenticated;
GRANT EXECUTE ON FUNCTION private.current_user_is_teacher() TO authenticated;

-- users: avoid a recursive users -> users policy by doing role checks through
-- the private SECURITY DEFINER helpers above.  A client may only bootstrap its
-- own pending row; invited roles are assigned by handle_new_user() or an admin.
DROP POLICY IF EXISTS "Users can view own profile" ON public.users;
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.users;
DROP POLICY IF EXISTS "Admins can update all profiles" ON public.users;
DROP POLICY IF EXISTS "Users can insert own pending profile" ON public.users;
DROP POLICY IF EXISTS "Staff can view all profiles" ON public.users;
DROP POLICY IF EXISTS "Admins can manage profiles" ON public.users;

CREATE POLICY "Users can view own profile"
  ON public.users FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = id);

CREATE POLICY "Staff can view all profiles"
  ON public.users FOR SELECT TO authenticated
  USING ((SELECT private.current_user_is_staff()));

CREATE POLICY "Users can insert own pending profile"
  ON public.users FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id AND role = 'pending');

CREATE POLICY "Admins can manage profiles"
  ON public.users FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_admin()))
  WITH CHECK ((SELECT private.current_user_is_admin()));

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- courses
DROP POLICY IF EXISTS "Admins can do everything" ON public.courses;
DROP POLICY IF EXISTS "Admins can do everything on courses" ON public.courses;
DROP POLICY IF EXISTS "Approved users can view published courses" ON public.courses;
DROP POLICY IF EXISTS "Everyone can view published courses" ON public.courses;
DROP POLICY IF EXISTS "Teachers can view published courses" ON public.courses;
DROP POLICY IF EXISTS "Staff can manage courses" ON public.courses;
DROP POLICY IF EXISTS "Complete teachers can view published courses" ON public.courses;

CREATE POLICY "Staff can manage courses"
  ON public.courses FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff()))
  WITH CHECK ((SELECT private.current_user_is_staff()));

CREATE POLICY "Complete teachers can view published courses"
  ON public.courses FOR SELECT TO authenticated
  USING (
    is_published = true
    AND (SELECT private.current_user_is_teacher())
    AND (SELECT public.is_my_instructor_profile_complete())
  );

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;

-- lessons
DROP POLICY IF EXISTS "Admins can do everything on lessons" ON public.lessons;
DROP POLICY IF EXISTS "Approved users can view published lessons" ON public.lessons;
DROP POLICY IF EXISTS "Staff can manage lessons" ON public.lessons;
DROP POLICY IF EXISTS "Complete teachers can view published lessons" ON public.lessons;

CREATE POLICY "Staff can manage lessons"
  ON public.lessons FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff()))
  WITH CHECK ((SELECT private.current_user_is_staff()));

CREATE POLICY "Complete teachers can view published lessons"
  ON public.lessons FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = course_id AND c.is_published = true
    )
    AND (SELECT private.current_user_is_teacher())
    AND (SELECT public.is_my_instructor_profile_complete())
  );

ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;

-- contents
DROP POLICY IF EXISTS "Admins can do everything on contents" ON public.contents;
DROP POLICY IF EXISTS "Approved users can view contents" ON public.contents;
DROP POLICY IF EXISTS "Staff can manage contents" ON public.contents;
DROP POLICY IF EXISTS "Complete teachers can view published contents" ON public.contents;

CREATE POLICY "Staff can manage contents"
  ON public.contents FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff()))
  WITH CHECK ((SELECT private.current_user_is_staff()));

CREATE POLICY "Complete teachers can view published contents"
  ON public.contents FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1
      FROM public.lessons l
      JOIN public.courses c ON c.id = l.course_id
      WHERE l.id = lesson_id
        AND l.is_published = true
        AND c.is_published = true
    )
    AND (SELECT private.current_user_is_teacher())
    AND (SELECT public.is_my_instructor_profile_complete())
  );

ALTER TABLE public.contents ENABLE ROW LEVEL SECURITY;

-- assignments
DROP POLICY IF EXISTS "Admins can do everything on assignments" ON public.assignments;
DROP POLICY IF EXISTS "Users can view own assignments" ON public.assignments;
DROP POLICY IF EXISTS "Users can insert own assignments" ON public.assignments;
DROP POLICY IF EXISTS "Staff can view all assignments" ON public.assignments;
DROP POLICY IF EXISTS "Admins can manage assignments" ON public.assignments;

CREATE POLICY "Users can view own assignments"
  ON public.assignments FOR SELECT TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND (SELECT public.is_my_instructor_profile_complete())
  );

CREATE POLICY "Users can insert own assignments"
  ON public.assignments FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND (SELECT public.is_my_instructor_profile_complete())
  );

CREATE POLICY "Staff can view all assignments"
  ON public.assignments FOR SELECT TO authenticated
  USING ((SELECT private.current_user_is_staff()));

CREATE POLICY "Admins can manage assignments"
  ON public.assignments FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_admin()))
  WITH CHECK ((SELECT private.current_user_is_admin()));

ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_lessons_course_id ON public.lessons (course_id);
CREATE INDEX IF NOT EXISTS idx_contents_lesson_id ON public.contents (lesson_id);
CREATE INDEX IF NOT EXISTS idx_assignments_user_id ON public.assignments (user_id);

-- PostgreSQL views default to the creator's permissions.  security_invoker
-- makes the salary view obey the instructors/class_sessions RLS of its caller.
ALTER VIEW IF EXISTS public.instructor_salary_summary
  SET (security_invoker = true);
