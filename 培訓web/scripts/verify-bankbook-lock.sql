\set ON_ERROR_STOP on

CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role text NOT NULL
);

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY,
  full_name text,
  bankbook_path text,
  bankbook_mime text,
  bankbook_size bigint,
  bankbook_uploaded_at timestamptz
);

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

\ir ../supabase/migrations/20260818082549_lock_instructor_bankbook_after_first_save.sql

INSERT INTO public.users (id, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', 'admin');

INSERT INTO public.instructors (id, full_name)
VALUES ('10000000-0000-4000-8000-000000000001', '測試講師');

GRANT SELECT, UPDATE ON public.instructors TO authenticated;

SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}',
  false
);
SET ROLE authenticated;

-- 一般講師第一次提交存摺可成功。
UPDATE public.instructors
SET bankbook_path = 'instructors/teacher/bankbook/first.png',
    bankbook_mime = 'image/png',
    bankbook_size = 100,
    bankbook_uploaded_at = now()
WHERE id = '10000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.instructors
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND bankbook_path = 'instructors/teacher/bankbook/first.png'
  ) THEN
    RAISE EXCEPTION '首次存摺提交未成功';
  END IF;
END;
$$;

-- 一般講師更換或移除既有存摺都必須收到 42501。
DO $$
BEGIN
  BEGIN
    UPDATE public.instructors
    SET bankbook_path = 'instructors/teacher/bankbook/replaced.png'
    WHERE id = '10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION '一般講師竟可更換既有存摺';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    UPDATE public.instructors
    SET bankbook_path = NULL,
        bankbook_mime = NULL,
        bankbook_size = NULL,
        bankbook_uploaded_at = NULL
    WHERE id = '10000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION '一般講師竟可移除既有存摺';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END;
$$;

-- 不碰存摺欄位的普通資料更新不受影響。
UPDATE public.instructors
SET full_name = '更新後講師'
WHERE id = '10000000-0000-4000-8000-000000000001';
RESET ROLE;

-- 管理員可以更換。
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}',
  false
);
SET ROLE authenticated;
UPDATE public.instructors
SET bankbook_path = 'instructors/teacher/bankbook/admin-replaced.png'
WHERE id = '10000000-0000-4000-8000-000000000001';
RESET ROLE;

-- SQL Editor / service role 沒有使用者 JWT，保留維運能力。
SELECT set_config('request.jwt.claims', '', false);
UPDATE public.instructors
SET bankbook_path = 'instructors/teacher/bankbook/service-replaced.png'
WHERE id = '10000000-0000-4000-8000-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.instructors
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND full_name = '更新後講師'
      AND bankbook_path = 'instructors/teacher/bankbook/service-replaced.png'
  ) THEN
    RAISE EXCEPTION '管理員或系統維運更新未成功';
  END IF;
END;
$$;

SELECT 'PASS: bankbook lock database guard' AS result;
