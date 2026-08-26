-- 講師主檔後台編輯權限收斂：
-- 1. admin 可管理所有講師列；mentor 只能維持既有 SELECT，不能代改其他講師。
-- 2. 即使日後誤加寬鬆 UPDATE/INSERT policy，restrictive policies 仍只放行 admin 或列本人。
-- 3. admin 可替講師替換／移除 Storage 文件；未認領時以 instructor id 建路徑，認領後本人仍可讀。

ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instructors TO authenticated;

DROP POLICY IF EXISTS "Admins can do everything on instructors" ON public.instructors;
CREATE POLICY "Admins can do everything on instructors"
  ON public.instructors
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Instructor updates limited to admins or owners" ON public.instructors;
CREATE POLICY "Instructor updates limited to admins or owners"
  ON public.instructors
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    OR EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  )
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    OR EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Instructor inserts limited to admins or owners" ON public.instructors;
CREATE POLICY "Instructor inserts limited to admins or owners"
  ON public.instructors
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    OR EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Only admins can delete instructor rows" ON public.instructors;
CREATE POLICY "Only admins can delete instructor rows"
  ON public.instructors
  AS RESTRICTIVE
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can view all instructor files" ON storage.objects;
CREATE POLICY "Admins can view all instructor files"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can upload all instructor files" ON storage.objects;
CREATE POLICY "Admins can upload all instructor files"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Admins can update all instructor files" ON storage.objects;
CREATE POLICY "Admins can update all instructor files"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  )
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "Users can view files referenced by own instructor profile" ON storage.objects;
CREATE POLICY "Users can view files referenced by own instructor profile"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1
      FROM public.instructors i
      WHERE i.user_id = (SELECT auth.uid())
        AND name IN (
          i.photo_path,
          i.id_front_path,
          i.id_back_path,
          i.bankbook_path
        )
    )
  );

-- 上述「依主檔引用讀檔」必須搭配路徑寫入限制，否則本人若猜到別人的 object path，
-- 可能先把自己的 path 欄改成該值再讀取。既有管理員匯入路徑若未變動則不受影響。
CREATE OR REPLACE FUNCTION public.guard_instructor_file_paths()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_is_admin boolean := false;
  own_prefix text;
BEGIN
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = actor_id
      AND u.role = 'admin'
  ) INTO actor_is_admin;
  IF actor_is_admin THEN
    RETURN NEW;
  END IF;

  own_prefix := 'instructors/' || actor_id::text || '/';

  IF (
    (TG_OP = 'INSERT' OR NEW.photo_path IS DISTINCT FROM OLD.photo_path)
    AND NEW.photo_path IS NOT NULL
    AND NEW.photo_path NOT LIKE own_prefix || '%'
  ) OR (
    (TG_OP = 'INSERT' OR NEW.id_front_path IS DISTINCT FROM OLD.id_front_path)
    AND NEW.id_front_path IS NOT NULL
    AND NEW.id_front_path NOT LIKE own_prefix || '%'
  ) OR (
    (TG_OP = 'INSERT' OR NEW.id_back_path IS DISTINCT FROM OLD.id_back_path)
    AND NEW.id_back_path IS NOT NULL
    AND NEW.id_back_path NOT LIKE own_prefix || '%'
  ) OR (
    (TG_OP = 'INSERT' OR NEW.bankbook_path IS DISTINCT FROM OLD.bankbook_path)
    AND NEW.bankbook_path IS NOT NULL
    AND NEW.bankbook_path NOT LIKE own_prefix || '%'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'instructor file paths must remain inside the current user folder';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_file_paths() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_instructor_file_paths ON public.instructors;
CREATE TRIGGER trg_guard_instructor_file_paths
  BEFORE INSERT OR UPDATE OF photo_path, id_front_path, id_back_path, bankbook_path
  ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_instructor_file_paths();

DROP POLICY IF EXISTS "Admins can delete all instructor files" ON storage.objects;
CREATE POLICY "Admins can delete all instructor files"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

NOTIFY pgrst, 'reload schema';
