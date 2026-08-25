\set ON_ERROR_STOP on

CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;

CREATE TABLE public.users (id uuid PRIMARY KEY, role text NOT NULL);

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY,
  full_name text,
  bank_account_name text,
  bank_name text,
  bank_branch text,
  bank_code text,
  bank_account_number text
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

\ir ../supabase/migrations/20260825120000_lock_instructor_bank_account_after_first_save.sql

INSERT INTO public.users (id, role) VALUES
  ('00000000-0000-4000-8000-000000000001', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', 'admin');
INSERT INTO public.instructors (id, full_name) VALUES ('10000000-0000-4000-8000-000000000001', '測試講師');
GRANT SELECT, UPDATE ON public.instructors TO authenticated;

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', false);
SET ROLE authenticated;

-- 首次填寫可成功（允許分兩次填：先填戶名等，帳號還沒填時不鎖）。
UPDATE public.instructors SET bank_account_name = '測試講師', bank_name = '華南銀行'
WHERE id = '10000000-0000-4000-8000-000000000001';
UPDATE public.instructors SET bank_branch = '仁愛分行', bank_code = '0080123', bank_account_number = '123456789012'
WHERE id = '10000000-0000-4000-8000-000000000001';

-- 帳號存在後，五個欄位任一改動都必須收到 42501。
DO $$
DECLARE stmt text;
BEGIN
  FOREACH stmt IN ARRAY ARRAY[
    $q$SET bank_account_name = '別人'$q$,
    $q$SET bank_name = '台新銀行'$q$,
    $q$SET bank_branch = '信義分行'$q$,
    $q$SET bank_code = '812000'$q$,
    $q$SET bank_account_number = '999'$q$,
    $q$SET bank_account_number = NULL$q$
  ] LOOP
    BEGIN
      EXECUTE 'UPDATE public.instructors ' || stmt || $w$ WHERE id = '10000000-0000-4000-8000-000000000001'$w$;
      RAISE EXCEPTION '一般講師竟可修改匯款資訊：%', stmt;
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END LOOP;
END $$;

-- 不碰匯款欄位的普通更新不受影響。
UPDATE public.instructors SET full_name = '更新後講師' WHERE id = '10000000-0000-4000-8000-000000000001';
RESET ROLE;

-- 管理員可改。
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated"}', false);
SET ROLE authenticated;
UPDATE public.instructors SET bank_account_number = '555' WHERE id = '10000000-0000-4000-8000-000000000001';
RESET ROLE;

-- service role / SQL Editor 可改。
SELECT set_config('request.jwt.claims', '', false);
UPDATE public.instructors SET bank_name = '維運改' WHERE id = '10000000-0000-4000-8000-000000000001';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000001'
    AND full_name = '更新後講師' AND bank_account_number = '555' AND bank_name = '維運改' AND bank_account_name = '測試講師') THEN
    RAISE EXCEPTION '管理員或系統維運更新未成功';
  END IF;
END $$;

SELECT 'PASS: bank account lock database guard' AS result;
