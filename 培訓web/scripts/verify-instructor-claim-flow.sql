\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE supabase_auth_admin;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TYPE public.employment_status_enum AS ENUM (
  'active', 'staff', 'assistant', 'part_time', 'frozen', 'cancelled'
);

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email text,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  name text,
  email text,
  role text NOT NULL DEFAULT 'pending',
  mentor_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.instructors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE,
  full_name text,
  nickname text,
  gender text,
  birth_date date,
  id_number text,
  phone_mobile text,
  line_id text,
  address text,
  household_address text,
  email_primary text,
  teaching_freq_semester text,
  teaching_freq_vacation text,
  teaching_regions text[],
  bio_notes text,
  bank_account_name text,
  bank_name text,
  bank_branch text,
  bank_account_number text,
  bank_code text,
  id_front_path text,
  id_back_path text,
  photo_path text,
  bankbook_path text,
  id_front_external_url text,
  id_back_external_url text,
  photo_external_url text,
  bankbook_external_url text,
  employment_status public.employment_status_enum,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.teacher_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  email text,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.announcements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  published boolean NOT NULL DEFAULT false
);
CREATE TABLE public.instructor_form_downloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  downloaded_by uuid,
  target_user_id uuid,
  doc_type text NOT NULL,
  doc_version integer NOT NULL
);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Approved users can view published announcements"
  ON public.announcements FOR SELECT TO authenticated USING (published);

GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, supabase_auth_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT ON auth.users TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon, supabase_auth_admin;

CREATE OR REPLACE FUNCTION private.current_user_is_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role IN ('admin', 'mentor')
  )
$$;

CREATE OR REPLACE FUNCTION private.current_user_is_teacher()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT false $$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

INSERT INTO public.teacher_invites (name, email, role)
VALUES
  ('舊名單講師', 'legacy@example.com', 'teacher'),
  ('既有管理員', 'staff-admin@example.com', 'admin'),
  ('既有輔導員', 'staff-mentor@example.com', 'mentor');
INSERT INTO public.instructors (full_name, email_primary, employment_status)
VALUES
  ('既有啟用講師', 'active@example.com', 'active'),
  ('凍結講師', 'blocked@example.com', 'frozen'),
  ('重複甲', 'duplicate@example.com', 'active'),
  ('重複乙', 'DUPLICATE@example.com', 'active'),
  ('已被認領講師', 'linked@example.com', 'active');
UPDATE public.instructors
SET user_id = '00000000-0000-4000-8000-000000000099'
WHERE email_primary = 'linked@example.com';

\ir ../supabase/migrations/2026-08-24_align_instructor_claim_flow.sql

DO $$
DECLARE
  result jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.teacher_invites WHERE role = 'teacher') THEN
    RAISE EXCEPTION 'legacy teacher queue was not retired';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.instructors WHERE lower(email_primary) = 'legacy@example.com'
  ) THEN
    RAISE EXCEPTION 'legacy teacher row was not migrated into instructor master';
  END IF;
  IF (SELECT count(*) FROM public.teacher_invites WHERE role IN ('admin', 'mentor')) <> 2 THEN
    RAISE EXCEPTION 'legacy staff bootstrap rows were removed before first login';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'instructors'
      AND indexname = 'idx_instructors_normalized_primary_email'
  ) THEN
    RAISE EXCEPTION 'normalized instructor email index is missing';
  END IF;

  result := public.hook_allow_known_google_signup(
    '{"user":{"email":"unknown@example.com","app_metadata":{"provider":"google","providers":["google"]}}}'::jsonb
  );
  IF result <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unknown Google signup should be allowed as pending: %', result;
  END IF;

  result := public.hook_allow_known_google_signup(
    '{"user":{"email":"active@example.com","app_metadata":{"provider":"google","providers":["google"]}}}'::jsonb
  );
  IF result <> '{}'::jsonb THEN
    RAISE EXCEPTION 'active pre-created instructor should be allowed: %', result;
  END IF;

  result := public.hook_allow_known_google_signup(
    '{"user":{"email":"unknown@example.com","app_metadata":{"provider":"email","providers":["email"]}}}'::jsonb
  );
  IF result->'error'->>'http_code' <> '403' THEN
    RAISE EXCEPTION 'non-Google signup was not rejected: %', result;
  END IF;

  result := public.hook_allow_known_google_signup(
    '{"user":{"email":"blocked@example.com","app_metadata":{"provider":"google","providers":["google"]}}}'::jsonb
  );
  IF result->'error'->>'http_code' <> '403' THEN
    RAISE EXCEPTION 'blocked instructor signup was not rejected: %', result;
  END IF;

  result := public.hook_allow_known_google_signup(
    '{"user":{"email":"duplicate@example.com","app_metadata":{"provider":"google","providers":["google"]}}}'::jsonb
  );
  IF result->'error'->>'http_code' <> '409' THEN
    RAISE EXCEPTION 'duplicate instructor email was not rejected: %', result;
  END IF;

  result := public.hook_allow_known_google_signup(
    '{"user":{"email":"linked@example.com","app_metadata":{"provider":"google","providers":["google"]}}}'::jsonb
  );
  IF result->'error'->>'http_code' <> '409' THEN
    RAISE EXCEPTION 'already-claimed instructor email was not rejected: %', result;
  END IF;
END
$$;

-- 既有 staff 帳號相容資料只在首次登入消耗，不會變成講師主檔或邀請介面。
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES
  ('00000000-0000-4000-8000-000000000003', 'staff-admin@example.com', '{"full_name":"管理員"}'),
  ('00000000-0000-4000-8000-000000000004', 'staff-mentor@example.com', '{"full_name":"輔導員"}');

DO $$
BEGIN
  IF (SELECT role FROM public.users WHERE id = '00000000-0000-4000-8000-000000000003') <> 'admin'
     OR (SELECT role FROM public.users WHERE id = '00000000-0000-4000-8000-000000000004') <> 'mentor' THEN
    RAISE EXCEPTION 'legacy staff roles were not promoted on first login';
  END IF;
  IF EXISTS (SELECT 1 FROM public.teacher_invites WHERE role IN ('admin', 'mentor')) THEN
    RAISE EXCEPTION 'consumed legacy staff bootstrap rows were not removed';
  END IF;
END
$$;

-- 唯一既有 Email 在建立 auth.users 後直接成為 teacher 並認領主檔。
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('00000000-0000-4000-8000-000000000001', 'ACTIVE@example.com', '{"full_name":"Google 名稱"}');

DO $$
BEGIN
  IF (SELECT role FROM public.users WHERE id = '00000000-0000-4000-8000-000000000001') <> 'teacher' THEN
    RAISE EXCEPTION 'pre-created instructor did not receive teacher role';
  END IF;
  IF (SELECT user_id FROM public.instructors WHERE lower(email_primary) = 'active@example.com')
     <> '00000000-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'pre-created instructor was not claimed';
  END IF;
END
$$;

-- 未建檔者先建立 pending；稍後主檔出現時，RPC 第一次認領、第二次冪等。
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES ('00000000-0000-4000-8000-000000000002', 'later@example.com', '{"full_name":"新講師"}');
INSERT INTO public.instructors (full_name, email_primary, employment_status)
VALUES ('稍後建立主檔', 'later@example.com', 'active');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false);

DO $$
DECLARE
  first_result jsonb;
  second_result jsonb;
BEGIN
  first_result := public.claim_my_precreated_instructor();
  second_result := public.claim_my_precreated_instructor();
  IF first_result->>'status' <> 'claimed' OR first_result->>'claimed_now' <> 'true' THEN
    RAISE EXCEPTION 'first claim did not claim: %', first_result;
  END IF;
  IF second_result->>'status' <> 'claimed' OR second_result->>'claimed_now' <> 'false' THEN
    RAISE EXCEPTION 'repeat claim was not idempotent: %', second_result;
  END IF;
  IF (SELECT role FROM public.users WHERE id = auth.uid()) <> 'teacher' THEN
    RAISE EXCEPTION 'claim did not promote pending account';
  END IF;
END
$$;

-- 外部匯入的三份必填文件算完整；大頭照保持選填。
UPDATE public.instructors SET
  nickname = '完整講師', gender = '女', birth_date = '1990-01-01', id_number = 'A123456789',
  phone_mobile = '0912345678', line_id = 'line', address = '通訊地址', household_address = '戶籍地址',
  teaching_freq_semester = '每週一次', teaching_freq_vacation = '每週兩次', teaching_regions = ARRAY['臺北市'],
  bio_notes = '教學經歷', bank_account_name = '稍後建立主檔', bank_name = '測試銀行', bank_branch = '測試分行',
  bank_account_number = '1234567890', bank_code = '1234567',
  id_front_external_url = 'https://example.com/front',
  id_back_external_url = 'https://example.com/back',
  bankbook_external_url = 'https://example.com/bankbook',
  photo_path = NULL, photo_external_url = NULL
WHERE user_id = '00000000-0000-4000-8000-000000000002';

DO $$
BEGIN
  IF NOT public.is_my_instructor_profile_complete() THEN
    RAISE EXCEPTION 'external imported documents were not counted as complete';
  END IF;
END
$$;

-- 停用狀態立即降權，且同一帳號再次登入時仍被拒絕。
UPDATE public.instructors
SET employment_status = 'frozen'
WHERE user_id = '00000000-0000-4000-8000-000000000002';

DO $$
DECLARE
  result jsonb;
BEGIN
  IF (SELECT role FROM public.users WHERE id = auth.uid()) <> 'pending' THEN
    RAISE EXCEPTION 'frozen instructor role was not downgraded';
  END IF;
  result := public.claim_my_precreated_instructor();
  IF result->>'status' <> 'blocked' THEN
    RAISE EXCEPTION 'frozen claimed instructor was not blocked: %', result;
  END IF;
END
$$;

-- 真正的新註冊者：資料完整前 RPC 不可核准，補齊後才可核准。
INSERT INTO auth.users (id, email, raw_user_meta_data)
VALUES
  ('00000000-0000-4000-8000-000000000010', 'admin@example.com', '{"full_name":"管理員"}'),
  ('00000000-0000-4000-8000-000000000011', 'new@example.com', '{"full_name":"全新講師"}');
UPDATE public.users SET role = 'admin' WHERE id = '00000000-0000-4000-8000-000000000010';
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
INSERT INTO public.instructors (user_id, full_name, email_primary)
VALUES ('00000000-0000-4000-8000-000000000011', '全新講師', 'new@example.com');

DO $$
BEGIN
  BEGIN
    UPDATE public.instructors
       SET email_primary = 'active@example.com'
     WHERE user_id = auth.uid();
    RAISE EXCEPTION 'pending account forged another instructor identity email';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000010', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.approve_new_instructor_account('00000000-0000-4000-8000-000000000011');
    RAISE EXCEPTION 'incomplete new instructor was approved';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

UPDATE public.instructors SET
  nickname = '新講師', gender = '男', birth_date = '1992-02-02', id_number = 'B123456789',
  phone_mobile = '0987654321', line_id = 'new-line', address = '通訊地址', household_address = '戶籍地址',
  teaching_freq_semester = '每週一次', teaching_freq_vacation = '每週一次', teaching_regions = ARRAY['新北市'],
  bio_notes = '教學理念', bank_account_name = '全新講師', bank_name = '測試銀行', bank_branch = '測試分行',
  bank_account_number = '9876543210', bank_code = '7654321',
  id_front_path = 'front.jpg', id_back_path = 'back.jpg', bankbook_path = 'bankbook.jpg'
WHERE user_id = '00000000-0000-4000-8000-000000000011';
SELECT public.approve_new_instructor_account('00000000-0000-4000-8000-000000000011');

-- 管理員解除認領時保留主檔並暫停帳號；同 Email 下次登入會再次自動認領。
SELECT public.admin_unlink_instructor(
  (SELECT id FROM public.instructors WHERE email_primary = 'new@example.com')
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.instructors
    WHERE email_primary = 'new@example.com' AND user_id IS NULL
  ) THEN
    RAISE EXCEPTION 'unlink deleted or retained the account link on instructor master';
  END IF;
  IF (SELECT role FROM public.users WHERE id = '00000000-0000-4000-8000-000000000011') <> 'pending' THEN
    RAISE EXCEPTION 'unlink did not suspend the old teacher session';
  END IF;
END
$$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
DO $$
DECLARE
  result jsonb;
BEGIN
  result := public.claim_my_precreated_instructor();
  IF result->>'status' <> 'claimed' OR result->>'claimed_now' <> 'true' THEN
    RAISE EXCEPTION 'same Google account did not reclaim after admin unlink: %', result;
  END IF;
END
$$;

DO $$
BEGIN
  IF (SELECT role FROM public.users WHERE id = '00000000-0000-4000-8000-000000000011') <> 'teacher' THEN
    RAISE EXCEPTION 'complete new instructor was not approved';
  END IF;
  IF has_function_privilege('anon', 'public.claim_my_precreated_instructor()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute claim RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.claim_my_precreated_instructor()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute claim RPC';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'instructor_form_downloads'
      AND column_name = 'target_instructor_id'
  ) THEN
    RAISE EXCEPTION 'download audit is still account-only';
  END IF;
END
$$;

SELECT 'PASS: instructor claim flow migration and authorization checks' AS result;
