-- 課程大分類與分類層級可見權限。
-- 上線順序：先套用本 migration，再部署會查詢 course_categories/category_id 的前端。

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION private.can_view_training_audience(required_visibility text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE COALESCE(required_visibility, 'all')
    WHEN 'all' THEN true
    WHEN 'intern' THEN EXISTS (
      SELECT 1
      FROM public.instructors i
      WHERE i.user_id = auth.uid()
        AND i.instructor_role::text = '實習'
    )
    WHEN 'formal' THEN EXISTS (
      SELECT 1
      FROM public.instructors i
      WHERE i.user_id = auth.uid()
        AND i.instructor_role::text IN ('B', 'A', 'A+', 'S')
    )
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION private.can_view_training_audience(text) FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;
GRANT EXECUTE ON FUNCTION private.can_view_training_audience(text) TO authenticated;

CREATE TABLE public.course_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL CHECK (NULLIF(BTRIM(title), '') IS NOT NULL),
  description text,
  visibility text NOT NULL DEFAULT 'all'
    CHECK (visibility IN ('all', 'intern', 'formal')),
  is_published boolean NOT NULL DEFAULT false,
  "order" integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.course_categories ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.course_categories FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.course_categories TO authenticated;

CREATE POLICY "Admins can manage course categories"
  ON public.course_categories FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

CREATE POLICY "Teachers can view available course categories"
  ON public.course_categories FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher'
    )
    AND (SELECT public.is_my_instructor_profile_complete())
    AND (SELECT private.can_view_training_audience(visibility))
  );

CREATE INDEX course_categories_published_order_idx
  ON public.course_categories (is_published, "order");

-- 所有既有課程先歸入一個已發佈的預設大分類，避免 migration 後課程消失。
INSERT INTO public.course_categories (title, description, visibility, is_published, "order")
VALUES ('講師培訓課程', '既有培訓課程', 'all', true, 0);

ALTER TABLE public.courses ADD COLUMN category_id uuid;

UPDATE public.courses
SET category_id = (
  SELECT id
  FROM public.course_categories
  WHERE title = '講師培訓課程'
  ORDER BY created_at
  LIMIT 1
)
WHERE category_id IS NULL;

ALTER TABLE public.courses
  ALTER COLUMN category_id SET NOT NULL,
  ADD CONSTRAINT courses_category_id_fkey
    FOREIGN KEY (category_id)
    REFERENCES public.course_categories(id)
    ON DELETE RESTRICT;

CREATE INDEX courses_category_order_idx
  ON public.courses (category_id, "order");

-- 分類與課程本身的限制會相交；例如「正式」分類中的「實習」課程不會被任何一般講師讀到。
DROP POLICY IF EXISTS "Approved users can view published courses" ON public.courses;
CREATE POLICY "Approved users can view published courses"
  ON public.courses FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (
      SELECT 1
      FROM public.course_categories category
      WHERE category.id = category_id
        AND category.is_published = true
        AND (SELECT private.can_view_training_audience(category.visibility))
    )
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher'
    )
    AND (SELECT public.is_my_instructor_profile_complete())
    AND (SELECT private.can_view_training_audience(visibility))
  );

-- 章節、內容與使用者衍生資料都必須經過可見課程，避免知道 UUID 後直接繞過大分類。
DROP POLICY IF EXISTS "Approved users can view published lessons" ON public.lessons;
CREATE POLICY "Approved users can view published lessons"
  ON public.lessons FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = course_id AND c.is_published = true
    )
  );

DROP POLICY IF EXISTS "Approved users can view contents" ON public.contents;
CREATE POLICY "Approved users can view contents"
  ON public.contents FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.lessons l
      WHERE l.id = lesson_id AND l.is_published = true
    )
  );

DROP POLICY IF EXISTS "Users can view own progress" ON public.progress;
DROP POLICY IF EXISTS "Users can insert own progress" ON public.progress;
DROP POLICY IF EXISTS "Users can update own progress" ON public.progress;
CREATE POLICY "Users can view own progress"
  ON public.progress FOR SELECT TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id)
  );
CREATE POLICY "Users can insert own progress"
  ON public.progress FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id)
  );
CREATE POLICY "Users can update own progress"
  ON public.progress FOR UPDATE TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id)
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id)
  );

DROP POLICY IF EXISTS "Users can view own assignments" ON public.assignments;
DROP POLICY IF EXISTS "Users can insert own assignments" ON public.assignments;
CREATE POLICY "Users can view own assignments"
  ON public.assignments FOR SELECT TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id)
  );
CREATE POLICY "Users can insert own assignments"
  ON public.assignments FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id)
  );

DROP POLICY IF EXISTS "Users can view own training status" ON public.course_training_status;
CREATE POLICY "Users can view own training status"
  ON public.course_training_status FOR SELECT TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.courses c WHERE c.id = course_id)
  );

DROP POLICY IF EXISTS "Anyone can read lesson comments" ON public.lesson_comments;
DROP POLICY IF EXISTS "Users can insert own comments" ON public.lesson_comments;
CREATE POLICY "Anyone can read lesson comments"
  ON public.lesson_comments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id));
CREATE POLICY "Users can insert own comments"
  ON public.lesson_comments FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id)
  );

DROP POLICY IF EXISTS "Anyone can read comment likes" ON public.lesson_comment_likes;
DROP POLICY IF EXISTS "Users can like comments" ON public.lesson_comment_likes;
CREATE POLICY "Anyone can read comment likes"
  ON public.lesson_comment_likes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.lesson_comments c WHERE c.id = comment_id));
CREATE POLICY "Users can like comments"
  ON public.lesson_comment_likes FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND EXISTS (SELECT 1 FROM public.lesson_comments c WHERE c.id = comment_id)
  );
