\set ON_ERROR_STOP on

CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE ROLE authenticated;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role text NOT NULL
);

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY,
  user_id uuid,
  full_name text,
  photo_path text,
  id_front_path text,
  id_back_path text,
  bankbook_path text
);

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY,
  bucket_id text NOT NULL,
  name text NOT NULL
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

CREATE ROLE anon;

ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own instructor profile"
  ON public.instructors FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own instructor profile"
  ON public.instructors FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own instructor profile"
  ON public.instructors FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Mentors can view all instructors"
  ON public.instructors FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'mentor'
    )
  );
CREATE POLICY "Admins can view all instructor files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

GRANT SELECT ON public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instructors TO authenticated;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;

\ir ../supabase/migrations/20260826130000_admin_instructor_editor_access.sql

INSERT INTO public.users (id, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'admin'),
  ('00000000-0000-4000-8000-000000000002', 'mentor'),
  ('00000000-0000-4000-8000-000000000003', 'teacher');

INSERT INTO public.instructors (id, user_id, full_name, bankbook_path) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '輔導員本人', NULL),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '目標講師', 'instructors/imported/target/bankbook.png');

INSERT INTO storage.objects (id, bucket_id, name) VALUES
  ('20000000-0000-4000-8000-000000000001', 'instructor_uploads', 'instructors/imported/target/bankbook.png'),
  ('20000000-0000-4000-8000-000000000002', 'instructor_uploads', 'instructors/imported/unused.png');

-- 輔導員可以讀總覽，但不可改其他講師；仍可維護自己的個人資料。
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}', false);
SET ROLE authenticated;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructors) <> 2 THEN
    RAISE EXCEPTION '輔導員應可讀講師總覽';
  END IF;
END;
$$;

UPDATE public.instructors
SET full_name = '不應成功'
WHERE id = '10000000-0000-4000-8000-000000000002';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.instructors
    WHERE id = '10000000-0000-4000-8000-000000000002'
      AND full_name = '不應成功'
  ) THEN
    RAISE EXCEPTION '輔導員竟可代改其他講師';
  END IF;
END;
$$;

UPDATE public.instructors
SET full_name = '輔導員本人更新'
WHERE id = '10000000-0000-4000-8000-000000000001';

RESET ROLE;

-- 被管理員上傳至非 user-id 路徑的文件，認領後講師本人仍可讀。
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated"}', false);
SET ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM storage.objects) <> 1 THEN
    RAISE EXCEPTION '講師應只能讀到自己主檔引用的 Storage 文件';
  END IF;

  BEGIN
    UPDATE public.instructors
    SET photo_path = 'instructors/imported/unused.png'
    WHERE id = '10000000-0000-4000-8000-000000000002';
    RAISE EXCEPTION '講師竟可把主檔路徑竄改成其他人的文件';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END;
$$;

INSERT INTO public.instructors (id, user_id, full_name, photo_path)
VALUES (
  '10000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000003',
  '講師本人新增',
  'instructors/00000000-0000-4000-8000-000000000003/photo/own.png'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.instructors (id, user_id, full_name, photo_path)
    VALUES (
      '10000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000003',
      '惡意路徑新增',
      'instructors/imported/unused.png'
    );
    RAISE EXCEPTION '講師竟可在新增主檔時引用其他人的文件';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

-- 管理員可更新任何講師，且可移除 instructor_uploads 內的舊檔。
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', false);
SET ROLE authenticated;
UPDATE public.instructors
SET full_name = '管理員更新成功'
WHERE id = '10000000-0000-4000-8000-000000000002';

INSERT INTO storage.objects (id, bucket_id, name)
VALUES (
  '20000000-0000-4000-8000-000000000003',
  'instructor_uploads',
  'instructors/admin/new.png'
);
UPDATE storage.objects
SET name = 'instructors/admin/updated.png'
WHERE id = '20000000-0000-4000-8000-000000000003';

DELETE FROM storage.objects
WHERE bucket_id = 'instructor_uploads';
RESET ROLE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.instructors
    WHERE id = '10000000-0000-4000-8000-000000000002'
      AND full_name = '管理員更新成功'
  ) THEN
    RAISE EXCEPTION '管理員更新其他講師失敗';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.objects) THEN
    RAISE EXCEPTION '管理員移除講師舊文件失敗';
  END IF;
END;
$$;

SELECT 'PASS: admin instructor editor RLS and storage access' AS result;
