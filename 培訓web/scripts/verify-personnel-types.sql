-- 人員類別（personnel_types）migration 驗證：由 scripts/verify-personnel-types.mjs 在暫時 PostgreSQL 執行。
-- psql 變數：
--   apply_migration   on＝套用 20261022100000_personnel_types.sql 兩次；off＝不套用（反向對照）
--   prior_migrations  on＝先套 20261022010000（課程受眾＋輔導員權限）與 20261022093700（夥伴號碼），
--                     並跑課程可見性整合檢查（I 開頭）；off＝不套（驗證本 migration 不依賴它們）
--   baseline_sql     由 .mjs 從 repo migration 原文抽出的函式定義（合約提醒、等級 guard、updated_at）
-- 每項檢查記一列 RESULT|代碼|tag|PASS/FAIL|說明|細節：
--   tag new＝新行為（沒套 migration 時必須 FAIL）；old＝既有行為（套不套都必須 PASS）。
-- 所有檢查都在子交易內執行後回滾，互不影響。
-- 本 migration 以非 superuser 的表擁有者 sql_editor 執行（模擬 Supabase SQL Editor 的 postgres 角色）。

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
\pset tuples_only on
\pset format unaligned
\o /dev/null

-- ────────────────────────────────────────────────────────────────────
-- 0. 模擬 Supabase 基礎（auth.uid() 與正式環境同樣讀 request.jwt.claim.sub／request.jwt.claims）
-- ────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE SCHEMA storage;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION storage.foldername(object_name text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN array_length(string_to_array(object_name, '/'), 1) > 1
      THEN (string_to_array(object_name, '/'))[1:array_length(string_to_array(object_name, '/'), 1) - 1]
    ELSE ARRAY[]::text[]
  END
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
  instructor_role text,
  speed_qualification text,
  gender text,
  birth_date date,
  id_number text,
  phone_mobile text,
  line_id text,
  address text,
  household_address text,
  email_primary text,
  email_secondary text,
  teaching_freq_semester text,
  teaching_freq_vacation text,
  teaching_regions text[],
  bio_notes text,
  bank_account_name text,
  bank_name text,
  bank_branch text,
  bank_account_number text,
  bank_code text,
  photo_path text, photo_mime text, photo_size integer, photo_uploaded_at timestamptz,
  id_front_path text, id_front_mime text, id_front_size integer, id_front_uploaded_at timestamptz,
  id_back_path text, id_back_mime text, id_back_size integer, id_back_uploaded_at timestamptz,
  bankbook_path text, bankbook_mime text, bankbook_size integer, bankbook_uploaded_at timestamptz,
  id_front_external_url text,
  id_back_external_url text,
  photo_external_url text,
  bankbook_external_url text,
  form_submitted_at timestamptz,
  note_internal text,
  teaching_regions_raw text,
  bank_info_raw text,
  wca_id text,
  wca_name text,
  wca_synced_at timestamptz,
  hide_from_leaderboard boolean NOT NULL DEFAULT false,
  employment_status public.employment_status_enum,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
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
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  type text,
  title text,
  body text,
  link text,
  is_read boolean NOT NULL DEFAULT false
);
CREATE TABLE public.instructor_contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  status text
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL,
  name text NOT NULL
);
-- 課程相關（20260823094617 與 20261022010000 需要）
CREATE TABLE public.courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  visibility text NOT NULL DEFAULT 'all',
  "order" integer NOT NULL DEFAULT 0
);
CREATE TABLE public.lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  is_published boolean NOT NULL DEFAULT false,
  "order" integer NOT NULL DEFAULT 0
);
CREATE TABLE public.contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft'
);
CREATE TABLE public.progress (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, lesson_id uuid);
CREATE TABLE public.assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, lesson_id uuid);
CREATE TABLE public.course_training_status (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, course_id uuid);
CREATE TABLE public.lesson_comments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, lesson_id uuid, body text);
CREATE TABLE public.lesson_comment_likes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), comment_id uuid, user_id uuid);
CREATE TABLE public.class_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), instructor_id uuid, total_salary numeric);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Approved users can view published announcements"
  ON public.announcements FOR SELECT TO authenticated USING (published);

GRANT USAGE ON SCHEMA public, auth, storage TO authenticated, anon, supabase_auth_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT SELECT ON auth.users TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon, supabase_auth_admin;

-- 講師主檔既有 RLS（instructors_setup 起的本人政策）；admin 與 restrictive 政策由 20260826130000 建立。
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
-- public.users、課程三表與報酬紀錄照正式庫開 RLS（20260819153000）
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_sessions ENABLE ROW LEVEL SECURITY;

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
CREATE POLICY "Users can view own profile" ON public.users FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = id);
CREATE POLICY "Staff can view all profiles" ON public.users FOR SELECT TO authenticated
  USING ((SELECT private.current_user_is_staff()));

-- ────────────────────────────────────────────────────────────────────
-- 1. 正式庫現況：repo 內實際 migration 原文（不是仿寫）
-- ────────────────────────────────────────────────────────────────────
\ir ../supabase/migrations/2026-08-24_align_instructor_claim_flow.sql
\ir ../supabase/migrations/20260826130000_admin_instructor_editor_access.sql
\ir ../supabase/migrations/20260826140000_recover_existing_instructor_identity_claim.sql
\ir ../supabase/migrations/20261020120000_instructor_document_edit_unlocks.sql
-- 合約提醒（20260819140407）、等級 guard（2026-07-09_claim_id_and_role）、updated_at（instructors_setup）
-- 的函式本體由 .mjs 逐字抽出；權限與 trigger 照原檔。
\i :baseline_sql
REVOKE ALL ON FUNCTION public.ensure_my_contract_reminder() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_my_contract_reminder() TO authenticated;
REVOKE ALL ON FUNCTION public.guard_instructor_role() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER trg_guard_instructor_admin_fields
  BEFORE INSERT OR UPDATE ON public.instructors
  FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_admin_fields();
CREATE TRIGGER trg_guard_instructor_role
  BEFORE INSERT OR UPDATE ON public.instructors
  FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_role();
CREATE TRIGGER set_instructors_updated_at
  BEFORE UPDATE ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION update_instructors_updated_at();

-- 課程大分類與受眾（實際 migration 原文），再補上 20260819153000 的 staff／「Complete teachers」政策（正式庫 2026-10-22 現況）
\ir ../supabase/migrations/20260823094617_add_course_categories.sql
CREATE POLICY "Staff can manage courses" ON public.courses FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff())) WITH CHECK ((SELECT private.current_user_is_staff()));
CREATE POLICY "Complete teachers can view published courses" ON public.courses FOR SELECT TO authenticated
  USING (
    is_published = true
    AND (SELECT private.current_user_is_teacher())
    AND (SELECT public.is_my_instructor_profile_complete())
  );
CREATE POLICY "Staff can manage lessons" ON public.lessons FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff())) WITH CHECK ((SELECT private.current_user_is_staff()));
CREATE POLICY "Complete teachers can view published lessons" ON public.lessons FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (SELECT 1 FROM public.courses c WHERE c.id = course_id AND c.is_published = true)
    AND (SELECT private.current_user_is_teacher())
    AND (SELECT public.is_my_instructor_profile_complete())
  );
CREATE POLICY "Staff can manage contents" ON public.contents FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff())) WITH CHECK ((SELECT private.current_user_is_staff()));
CREATE POLICY "Complete teachers can view published contents" ON public.contents FOR SELECT TO authenticated
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
CREATE POLICY "Admins manage all sessions" ON public.class_sessions FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff())) WITH CHECK ((SELECT private.current_user_is_staff()));

-- 檔名排在本 migration 前面、正式庫尚未套用的兩支（實際原文）
\if :prior_migrations
\ir ../supabase/migrations/20261022010000_tighten_course_audience_and_mentor_access.sql
\ir ../supabase/migrations/20261022093700_instructor_partner_no.sql
\endif

-- 模擬 SQL Editor：Supabase 的 postgres 角色不是 superuser，而是這些物件的擁有者。
-- 把 public／private／auth／storage 的 schema、表、函式、enum 擁有者改成非 superuser 的 sql_editor，
-- 本 migration 之後以 SET ROLE sql_editor 執行（表擁有者不受 RLS 限制，與正式庫相同）。
DO $$
DECLARE
  r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sql_editor') THEN
    CREATE ROLE sql_editor NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  EXECUTE format('GRANT CREATE ON DATABASE %I TO sql_editor', current_database());
  FOR r IN SELECT nspname FROM pg_namespace WHERE nspname IN ('public', 'private', 'auth', 'storage') LOOP
    EXECUTE format('ALTER SCHEMA %I OWNER TO sql_editor', r.nspname);
  END LOOP;
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private', 'auth', 'storage') AND c.relkind IN ('r', 'v', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %s OWNER TO sql_editor', r.rel);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS fn
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private', 'auth', 'storage') AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO sql_editor', r.fn);
  END LOOP;
  FOR r IN
    SELECT t.oid::regtype AS typ
    FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname IN ('public', 'private', 'auth', 'storage') AND t.typtype = 'e'
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO sql_editor', r.typ);
  END LOOP;
END;
$$;

-- ────────────────────────────────────────────────────────────────────
-- 2. 種子資料：比照正式庫形狀（3 筆 NULL 狀態都連到 admin 帳號）
-- ────────────────────────────────────────────────────────────────────
INSERT INTO public.users (id, name, email, role) VALUES
  ('00000000-0000-4000-8000-0000000000a1', '管理員甲', 'admin1@example.com', 'admin'),
  ('00000000-0000-4000-8000-0000000000a2', '管理員乙', 'admin2@example.com', 'admin'),
  ('00000000-0000-4000-8000-0000000000a3', '管理員丙', 'admin3@example.com', 'admin'),
  ('00000000-0000-4000-8000-000000000011', '一般講師', 'teacher@example.com', 'teacher'),
  ('00000000-0000-4000-8000-000000000012', '純職員', 'staff@example.com', 'teacher'),
  ('00000000-0000-4000-8000-000000000013', '已簽約講師', 'signed@example.com', 'teacher'),
  ('00000000-0000-4000-8000-000000000014', '輔導員', 'mentor@example.com', 'mentor'),
  ('00000000-0000-4000-8000-000000000015', '已離職講師', 'cancelled@example.com', 'pending'),
  ('00000000-0000-4000-8000-000000000016', '無主檔講師', 'nomaster@example.com', 'teacher'),
  ('00000000-0000-4000-8000-000000000017', '新註冊者', 'new@example.com', 'pending');
INSERT INTO auth.users (id, email)
SELECT id, email FROM public.users;

INSERT INTO public.instructors (
  id, user_id, full_name, nickname, gender, birth_date, id_number, phone_mobile, line_id,
  address, household_address, email_primary, teaching_freq_semester, teaching_freq_vacation,
  teaching_regions, bio_notes, bank_account_name, bank_name, bank_branch, bank_account_number,
  bank_code, id_front_path, id_back_path, bankbook_path, employment_status, updated_at
)
SELECT
  s.id::uuid, s.user_id::uuid, s.full_name, '暱稱', '男', DATE '1990-01-01', 'A123456789',
  '0912345678', 'line-id', '通訊地址', '戶籍地址', s.email, '每週', '每週',
  ARRAY['臺北市'], '簡介', s.full_name, '測試銀行', '測試分行', '1234567890', '0001234',
  'instructors/' || COALESCE(s.user_id, s.id) || '/id_front/a.png',
  'instructors/' || COALESCE(s.user_id, s.id) || '/id_back/b.png',
  'instructors/' || COALESCE(s.user_id, s.id) || '/bankbook/c.png',
  s.status::public.employment_status_enum,
  TIMESTAMPTZ '2026-01-01 00:00:00+08'
FROM (VALUES
  ('10000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a1', '管理員甲', 'admin1@example.com', NULL),
  ('10000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a2', '管理員乙', 'admin2@example.com', NULL),
  ('10000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000a3', '管理員丙', 'admin3@example.com', NULL),
  ('10000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000011', '一般講師', 'teacher@example.com', 'active'),
  ('10000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000012', '純職員', 'staff@example.com', 'active'),
  ('10000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000013', '已簽約講師', 'signed@example.com', 'active'),
  ('10000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-000000000014', '輔導員', 'mentor@example.com', 'active'),
  ('10000000-0000-4000-8000-000000000015', '00000000-0000-4000-8000-000000000015', '已離職講師', 'cancelled@example.com', 'cancelled'),
  ('10000000-0000-4000-8000-000000000021', NULL, '未認領講師', 'unclaimed@example.com', 'active'),
  ('10000000-0000-4000-8000-000000000022', NULL, '冷凍講師', 'frozen@example.com', 'frozen')
) AS s(id, user_id, full_name, email, status);

INSERT INTO public.instructor_contracts (user_id, status)
VALUES ('00000000-0000-4000-8000-000000000013', 'signed');

-- 課程：預設大分類（20260823094617 建立，受眾 all、已發佈）下各一門 all／formal 的已發佈課程，各有已發佈章節與內容
INSERT INTO public.courses (id, title, is_published, visibility, category_id)
SELECT v.id::uuid, v.title, true, v.visibility,
       (SELECT id FROM public.course_categories WHERE title = '講師培訓課程' ORDER BY created_at LIMIT 1)
FROM (VALUES
  ('30000000-0000-4000-8000-000000000001', '全體課程', 'all'),
  ('30000000-0000-4000-8000-000000000002', '正式講師課程', 'formal')
) AS v(id, title, visibility);
INSERT INTO public.lessons (id, course_id, title, is_published) VALUES
  ('31000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000001', '全體章節', true),
  ('31000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000002', '正式章節', true);
INSERT INTO public.contents (id, lesson_id, title, status) VALUES
  ('32000000-0000-4000-8000-000000000001', '31000000-0000-4000-8000-000000000001', '全體內容', 'published'),
  ('32000000-0000-4000-8000-000000000002', '31000000-0000-4000-8000-000000000002', '正式內容', 'published');

-- ────────────────────────────────────────────────────────────────────
-- 3. 檢查工具（schema pt；記錄函式 SECURITY DEFINER，檢查函式以呼叫者身分執行）
-- ────────────────────────────────────────────────────────────────────
CREATE SCHEMA pt;
CREATE TABLE pt.results (
  seq serial PRIMARY KEY,
  code text NOT NULL,
  tag text NOT NULL CHECK (tag IN ('new', 'old')),
  descr text NOT NULL,
  ok boolean NOT NULL,
  detail text
);

CREATE FUNCTION pt.record(p_code text, p_tag text, p_descr text, p_ok boolean, p_detail text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  INSERT INTO pt.results (code, tag, descr, ok, detail)
  VALUES (p_code, p_tag, p_descr, COALESCE(p_ok, false), p_detail)
$$;

-- 執行 setup 後評估 p_check（回傳 boolean），全部回滾。
CREATE FUNCTION pt.expect_true(p_code text, p_tag text, p_descr text, p_setup text[], p_check text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := false;
  v_detail text;
  v_stmt text;
BEGIN
  BEGIN
    FOREACH v_stmt IN ARRAY COALESCE(p_setup, ARRAY[]::text[]) LOOP
      EXECUTE v_stmt;
    END LOOP;
    EXECUTE p_check INTO v_ok;
    v_detail := 'check returned ' || COALESCE(v_ok::text, 'NULL');
    RAISE EXCEPTION USING ERRCODE = 'PT001', MESSAGE = 'rollback';
  EXCEPTION
    WHEN SQLSTATE 'PT001' THEN NULL;
    WHEN OTHERS THEN
      v_ok := false;
      v_detail := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM pt.record(p_code, p_tag, p_descr, v_ok, v_detail);
END;
$$;

-- setup 必須成功；p_stmt 必須以 p_state（可再比對訊息）失敗。全部回滾。
CREATE FUNCTION pt.expect_error(
  p_code text, p_tag text, p_descr text, p_setup text[], p_stmt text, p_state text, p_message text DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_phase text := 'setup';
  v_state text;
  v_msg text;
  v_stmt text;
BEGIN
  BEGIN
    FOREACH v_stmt IN ARRAY COALESCE(p_setup, ARRAY[]::text[]) LOOP
      EXECUTE v_stmt;
    END LOOP;
    v_phase := 'statement';
    EXECUTE p_stmt;
    v_state := 'no error';
    RAISE EXCEPTION USING ERRCODE = 'PT001', MESSAGE = 'rollback';
  EXCEPTION
    WHEN SQLSTATE 'PT001' THEN NULL;
    WHEN OTHERS THEN
      v_state := SQLSTATE;
      v_msg := SQLERRM;
  END;
  PERFORM pt.record(
    p_code, p_tag, p_descr,
    v_phase = 'statement' AND v_state = p_state AND (p_message IS NULL OR v_msg = p_message),
    format('expected %s%s; got %s during %s%s', p_state,
      COALESCE(' "' || p_message || '"', ''), v_state, v_phase, COALESCE(': ' || v_msg, ''))
  );
END;
$$;

-- 以 p_actor 身分呼叫 ensure_my_contract_reminder()，比對回傳值與新增的合約通知數。全部回滾。
CREATE FUNCTION pt.expect_reminder(
  p_code text, p_tag text, p_descr text, p_setup text[], p_actor uuid, p_expected boolean, p_expected_new integer
)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_ok boolean := false;
  v_detail text;
  v_stmt text;
  v_before integer;
  v_after integer;
  v_ret boolean;
BEGIN
  BEGIN
    FOREACH v_stmt IN ARRAY COALESCE(p_setup, ARRAY[]::text[]) LOOP
      EXECUTE v_stmt;
    END LOOP;
    SELECT count(*) INTO v_before FROM public.notifications
     WHERE user_id = p_actor AND type = 'contract' AND link = '/contract';
    PERFORM set_config('request.jwt.claim.sub', p_actor::text, true);
    v_ret := public.ensure_my_contract_reminder();
    SELECT count(*) INTO v_after FROM public.notifications
     WHERE user_id = p_actor AND type = 'contract' AND link = '/contract';
    v_ok := v_ret IS NOT DISTINCT FROM p_expected AND v_after - v_before = p_expected_new;
    v_detail := format('returned %s, new contract notifications %s', v_ret, v_after - v_before);
    RAISE EXCEPTION USING ERRCODE = 'PT001', MESSAGE = 'rollback';
  EXCEPTION
    WHEN SQLSTATE 'PT001' THEN NULL;
    WHEN OTHERS THEN
      v_ok := false;
      v_detail := SQLSTATE || ': ' || SQLERRM;
  END;
  PERFORM pt.record(p_code, p_tag, p_descr, v_ok, v_detail);
END;
$$;

-- 建一筆資料齊全的未認領主檔，再依參數改人員類別／合作狀態、清空指定欄位（以 postgres、無 JWT 執行）。
CREATE FUNCTION pt.make_profile(p_id uuid, p_types text[], p_status text, p_null_fields text[])
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_field text;
BEGIN
  INSERT INTO public.instructors (
    id, full_name, nickname, gender, birth_date, id_number, phone_mobile, line_id,
    address, household_address, email_primary, teaching_freq_semester, teaching_freq_vacation,
    teaching_regions, bio_notes, bank_account_name, bank_name, bank_branch, bank_account_number,
    bank_code, id_front_path, id_back_path, bankbook_path, employment_status
  ) VALUES (
    p_id, '完整度測試', '測試', '女', DATE '1991-02-03', 'B223456789', '0922000000', 'line-test',
    '通訊地址', '戶籍地址', 'profile-' || p_id || '@example.com', '每週', '每週',
    ARRAY['新北市'], '簡介', '完整度測試', '測試銀行', '測試分行', '9876543210',
    '0005678', 'instructors/' || p_id || '/id_front/a.png', 'instructors/' || p_id || '/id_back/b.png',
    'instructors/' || p_id || '/bankbook/c.png', p_status::public.employment_status_enum
  );
  IF p_types IS NOT NULL THEN
    EXECUTE 'UPDATE public.instructors SET personnel_types = $1 WHERE id = $2' USING p_types, p_id;
  END IF;
  FOREACH v_field IN ARRAY COALESCE(p_null_fields, ARRAY[]::text[]) LOOP
    EXECUTE format('UPDATE public.instructors SET %I = NULL WHERE id = $1', v_field) USING p_id;
  END LOOP;
  RETURN p_id;
END;
$$;

CREATE FUNCTION pt.fn_key(p_oid oid)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.oid = p_oid
$$;

-- 以 SQL Editor 身分（superuser、清掉 JWT）執行一段 SQL，給 authenticated 身分的檢查做準備；回滾由呼叫端負責。
CREATE FUNCTION pt.sudo(p_sql text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_sub text := current_setting('request.jwt.claim.sub', true);
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
  EXECUTE p_sql;
  PERFORM set_config('request.jwt.claim.sub', COALESCE(v_sub, ''), true);
END;
$$;

-- 以 authenticated 身分可見的課程／章節／內容 id（RLS 生效後）
CREATE FUNCTION pt.visible_course_items()
RETURNS text[] LANGUAGE sql STABLE AS $$
  SELECT ARRAY(
    SELECT 'course:' || title FROM public.courses
    UNION ALL SELECT 'lesson:' || title FROM public.lessons
    UNION ALL SELECT 'content:' || title FROM public.contents
    ORDER BY 1
  )
$$;

GRANT USAGE ON SCHEMA pt TO authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pt TO authenticated;

-- 套用前快照：帳號角色、主檔狀態與 updated_at、所有函式本體、instructors trigger、通知與文件紀錄數。
CREATE TABLE pt.users_before AS SELECT id, role FROM public.users;
CREATE TABLE pt.instructors_before AS
  SELECT id, user_id, employment_status::text AS status, updated_at FROM public.instructors;
CREATE TABLE pt.functions_before AS
  SELECT pt.fn_key(p.oid) AS fn, md5(p.prosrc) AS md5, p.prosecdef, p.proconfig, p.proacl::text AS acl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('public', 'private', 'auth');
CREATE TABLE pt.triggers_before AS
  SELECT tgname::text, tgfoid::regprocedure::text AS fn, tgtype, tgenabled::text
  FROM pg_trigger WHERE tgrelid = 'public.instructors'::regclass AND NOT tgisinternal;
CREATE TABLE pt.counts_before AS
  SELECT (SELECT count(*) FROM public.notifications) AS notifications,
         (SELECT count(*) FROM public.instructor_document_changes) AS document_changes;

-- ────────────────────────────────────────────────────────────────────
-- 4. 套用 migration（連跑兩次；兩次之間把純職員設成 {staff}，確認重跑不會覆蓋）
-- ────────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claim.sub', '', false);
\if :apply_migration
SET ROLE sql_editor;
\ir ../supabase/migrations/20261022100000_personnel_types.sql
RESET ROLE;
UPDATE public.instructors SET personnel_types = ARRAY['staff']
 WHERE id = '10000000-0000-4000-8000-000000000012';
SET ROLE sql_editor;
\ir ../supabase/migrations/20261022100000_personnel_types.sql
RESET ROLE;
SELECT pt.record('M01', 'new', 'migration 連跑兩次都成功（可重跑；以非 superuser 擁有者 sql_editor 執行）', true, 'applied twice without error');
\else
SELECT pt.record('M01', 'new', 'migration 連跑兩次都成功（可重跑；以非 superuser 擁有者 sql_editor 執行）', false, 'reverse control: migration not applied');
\endif

-- ────────────────────────────────────────────────────────────────────
-- 5. 資料與結構（postgres 身分、auth.uid() 為 NULL＝SQL Editor）
-- ────────────────────────────────────────────────────────────────────
SELECT pt.expect_true('M02', 'new', 'personnel_types 欄位存在、NOT NULL、text[]、有欄位說明', NULL, $c$
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'instructors'
      AND column_name = 'personnel_types' AND is_nullable = 'NO' AND udt_name = '_text'
  ) AND col_description('public.instructors'::regclass,
        (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.instructors'::regclass AND attname = 'personnel_types')) IS NOT NULL
$c$);
SELECT pt.expect_true('M03', 'new', '既有列全部得到 {instructor}', NULL, $c$
  SELECT bool_and(i.personnel_types = ARRAY['instructor']::text[]) AND count(*) = 9
  FROM public.instructors i JOIN pt.instructors_before b USING (id)
  WHERE i.id <> '10000000-0000-4000-8000-000000000012'
$c$);
SELECT pt.expect_true('M04', 'new', '重跑 migration 不會把已設定的 {staff} 改回預設', NULL, $c$
  SELECT personnel_types = ARRAY['staff']::text[] FROM public.instructors
  WHERE id = '10000000-0000-4000-8000-000000000012'
$c$);
SELECT pt.expect_true('M05', 'new', '合作狀態 NULL 的 3 筆補成 active，已無 NULL', NULL, $c$
  SELECT NOT EXISTS (SELECT 1 FROM public.instructors WHERE employment_status IS NULL)
     AND (SELECT count(*) FROM public.instructors i JOIN pt.instructors_before b USING (id)
          WHERE b.status IS NULL AND i.employment_status::text = 'active') = 3
$c$);
SELECT pt.expect_true('M06', 'old', '原本非 NULL 的合作狀態一筆都沒變', NULL, $c$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.instructors i JOIN pt.instructors_before b USING (id)
    WHERE b.status IS NOT NULL AND i.employment_status::text IS DISTINCT FROM b.status
  )
$c$);
SELECT pt.expect_true('M07', 'old', '補值後 public.users.role 全部不變（3 位 admin 仍是 admin）', NULL, $c$
  SELECT NOT EXISTS (
    SELECT 1 FROM pt.users_before b LEFT JOIN public.users u USING (id)
    WHERE u.role IS DISTINCT FROM b.role
  ) AND (SELECT count(*) FROM public.users) = (SELECT count(*) FROM pt.users_before)
    AND (SELECT count(*) FROM public.users WHERE id IN (
      '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2',
      '00000000-0000-4000-8000-0000000000a3') AND role = 'admin') = 3
$c$);
SELECT pt.expect_true('M08', 'old', '套用沒有產生通知或文件修改紀錄（trigger 無副作用）', NULL, $c$
  SELECT (SELECT count(*) FROM public.notifications) = c.notifications
     AND (SELECT count(*) FROM public.instructor_document_changes) = c.document_changes
  FROM pt.counts_before c
$c$);
SELECT pt.expect_true('M09', 'old', '沒被補值的列 updated_at 不變（純職員那列是測試時另外改的，排除）', NULL, $c$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.instructors i JOIN pt.instructors_before b USING (id)
    WHERE b.status IS NOT NULL AND i.id <> '10000000-0000-4000-8000-000000000012'
      AND i.updated_at IS DISTINCT FROM b.updated_at
  )
$c$);
SELECT pt.expect_true('M10', 'new', '已知副作用：補值的 3 列 updated_at 變成套用時間', NULL, $c$
  SELECT count(*) = 3 FROM public.instructors i JOIN pt.instructors_before b USING (id)
  WHERE b.status IS NULL AND i.updated_at > b.updated_at
$c$);

SELECT pt.expect_true('F01', 'old', '三個函式維持 SECURITY DEFINER 與 search_path = ''''', NULL, $c$
  SELECT count(*) = 3 AND bool_and(p.prosecdef AND 'search_path=""' = ANY (p.proconfig))
  FROM pg_proc p
  WHERE p.oid IN (to_regprocedure('public.guard_instructor_admin_fields()'),
                  to_regprocedure('private.instructor_profile_is_complete(uuid)'),
                  to_regprocedure('public.ensure_my_contract_reminder()'))
$c$);
SELECT pt.expect_true('F02', 'old', '執行權限不變：guard／完整度不開放給 client，合約提醒只給 authenticated', NULL, $c$
  SELECT NOT has_function_privilege('authenticated', 'public.guard_instructor_admin_fields()', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.guard_instructor_admin_fields()', 'EXECUTE')
     AND NOT has_function_privilege('authenticated', 'private.instructor_profile_is_complete(uuid)', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'private.instructor_profile_is_complete(uuid)', 'EXECUTE')
     AND has_function_privilege('authenticated', 'public.ensure_my_contract_reminder()', 'EXECUTE')
     AND NOT has_function_privilege('anon', 'public.ensure_my_contract_reminder()', 'EXECUTE')
$c$);
SELECT pt.expect_true('F03', 'new', '三個指定函式本體已換成新版', NULL, $c$
  SELECT count(*) = 3 FROM pt.functions_before b
  JOIN pg_proc p ON pt.fn_key(p.oid) = b.fn
  WHERE b.fn IN ('public.guard_instructor_admin_fields()',
                 'private.instructor_profile_is_complete(target_instructor_id uuid)',
                 'public.ensure_my_contract_reminder()')
    AND md5(p.prosrc) <> b.md5
$c$);
SELECT pt.expect_true('F04', 'old', '其他函式（含 13 個讀合作狀態的）本體、權限、設定全部沒動，也沒有增減', NULL, $c$
  WITH after AS (
    SELECT pt.fn_key(p.oid) AS fn, md5(p.prosrc) AS md5, p.prosecdef, p.proconfig, p.proacl::text AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'private', 'auth')
  ), others_before AS (
    SELECT * FROM pt.functions_before
    WHERE fn NOT IN ('public.guard_instructor_admin_fields()',
                     'private.instructor_profile_is_complete(target_instructor_id uuid)',
                     'public.ensure_my_contract_reminder()')
  ), others_after AS (
    SELECT * FROM after
    WHERE fn NOT IN ('public.guard_instructor_admin_fields()',
                     'private.instructor_profile_is_complete(target_instructor_id uuid)',
                     'public.ensure_my_contract_reminder()')
  )
  SELECT NOT EXISTS (SELECT * FROM others_before EXCEPT SELECT * FROM others_after)
     AND NOT EXISTS (SELECT * FROM others_after EXCEPT SELECT * FROM others_before)
$c$);
SELECT pt.expect_true('F05', 'old', 'instructors 上的 trigger 清單不變', NULL, $c$
  WITH after AS (
    SELECT tgname::text, tgfoid::regprocedure::text AS fn, tgtype, tgenabled::text
    FROM pg_trigger WHERE tgrelid = 'public.instructors'::regclass AND NOT tgisinternal
  )
  SELECT NOT EXISTS (SELECT * FROM pt.triggers_before EXCEPT SELECT * FROM after)
     AND NOT EXISTS (SELECT * FROM after EXCEPT SELECT * FROM pt.triggers_before)
$c$);
SELECT pt.expect_true('F06', 'old', 'employment_status_enum 六個值都還在（沒刪 enum 值）', NULL, $c$
  SELECT array_agg(enumlabel::text ORDER BY enumsortorder)
       = ARRAY['active', 'staff', 'assistant', 'part_time', 'frozen', 'cancelled']
  FROM pg_enum WHERE enumtypid = 'public.employment_status_enum'::regtype
$c$);
SELECT pt.expect_true('F07', 'old', '模擬 SQL Editor：instructors 與三個函式的擁有者是非 superuser、無 BYPASSRLS 的 sql_editor', NULL, $c$
  SELECT NOT r.rolsuper AND NOT r.rolbypassrls
     AND pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.instructors'::regclass)) = 'sql_editor'
     AND (SELECT bool_and(pg_get_userbyid(p.proowner) = 'sql_editor') FROM pg_proc p
          WHERE p.oid IN (to_regprocedure('public.guard_instructor_admin_fields()'),
                          to_regprocedure('private.instructor_profile_is_complete(uuid)'),
                          to_regprocedure('public.ensure_my_contract_reminder()')))
  FROM pg_roles r WHERE r.rolname = 'sql_editor'
$c$);

-- ────────────────────────────────────────────────────────────────────
-- 6. 約束（postgres 身分）
-- ────────────────────────────────────────────────────────────────────
SELECT pt.expect_error('C01', 'new', '合作狀態拒絕 staff', NULL,
  $s$INSERT INTO public.instructors (full_name, employment_status) VALUES ('約束測試', 'staff')$s$, '23514');
SELECT pt.expect_error('C02', 'new', '合作狀態拒絕 part_time', NULL,
  $s$INSERT INTO public.instructors (full_name, employment_status) VALUES ('約束測試', 'part_time')$s$, '23514');
SELECT pt.expect_error('C03', 'new', '合作狀態拒絕 assistant', NULL,
  $s$INSERT INTO public.instructors (full_name, employment_status) VALUES ('約束測試', 'assistant')$s$, '23514');
SELECT pt.expect_error('C04', 'new', '既有列改成 staff 也被擋（UPDATE 路徑）', NULL,
  $s$UPDATE public.instructors SET employment_status = 'staff' WHERE id = '10000000-0000-4000-8000-000000000011'$s$, '23514');
SELECT pt.expect_true('C05', 'old', '合作狀態接受 active／frozen／cancelled／NULL',
  ARRAY[$s$INSERT INTO public.instructors (full_name, employment_status) VALUES
    ('約束甲', 'active'), ('約束乙', 'frozen'), ('約束丙', 'cancelled'), ('約束丁', NULL)$s$],
  $c$SELECT count(*) = 4 FROM public.instructors WHERE full_name IN ('約束甲', '約束乙', '約束丙', '約束丁')$c$);
SELECT pt.expect_error('C06', 'new', '人員類別拒絕空陣列 {}', NULL,
  $s$INSERT INTO public.instructors (full_name, personnel_types) VALUES ('約束測試', ARRAY[]::text[])$s$, '23514');
SELECT pt.expect_error('C07', 'new', '人員類別拒絕 {teacher}', NULL,
  $s$INSERT INTO public.instructors (full_name, personnel_types) VALUES ('約束測試', ARRAY['teacher'])$s$, '23514');
SELECT pt.expect_error('C08', 'new', '人員類別拒絕含 NULL 的陣列 {instructor,NULL}', NULL,
  $s$INSERT INTO public.instructors (full_name, personnel_types) VALUES ('約束測試', ARRAY['instructor', NULL])$s$, '23514');
SELECT pt.expect_error('C09', 'new', '人員類別拒絕 NULL（NOT NULL）', NULL,
  $s$INSERT INTO public.instructors (full_name, personnel_types) VALUES ('約束測試', NULL)$s$, '23502');
SELECT pt.expect_true('C10', 'new', '人員類別接受 {staff}、{instructor,staff}、{part_time}',
  ARRAY[$s$INSERT INTO public.instructors (full_name, personnel_types) VALUES
    ('類別甲', ARRAY['staff']), ('類別乙', ARRAY['instructor', 'staff']), ('類別丙', ARRAY['part_time'])$s$],
  $c$SELECT count(*) = 3 FROM public.instructors WHERE full_name IN ('類別甲', '類別乙', '類別丙')$c$);

-- ────────────────────────────────────────────────────────────────────
-- 7. guard：講師本人（authenticated＋RLS）、管理員、以及只看 trigger（postgres＋JWT，繞過 RLS）
-- ────────────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
SET ROLE authenticated;
SELECT pt.expect_error('G01', 'new', '講師不能改自己的人員類別', NULL,
  $s$UPDATE public.instructors SET personnel_types = ARRAY['instructor', 'staff'] WHERE user_id = auth.uid()$s$, '42501');
SELECT pt.expect_error('G02', 'old', '講師不能改自己的合作狀態', NULL,
  $s$UPDATE public.instructors SET employment_status = 'frozen' WHERE user_id = auth.uid()$s$, '42501');
SELECT pt.expect_error('G03', 'old', '講師不能改管理備註', NULL,
  $s$UPDATE public.instructors SET note_internal = '自己寫' WHERE user_id = auth.uid()$s$, '42501');
SELECT pt.expect_true('G04', 'old', '講師可以改自己的個人欄位',
  ARRAY[$s$UPDATE public.instructors SET nickname = '新暱稱', phone_mobile = '0911222333' WHERE user_id = auth.uid()$s$],
  $c$SELECT nickname = '新暱稱' AND phone_mobile = '0911222333' FROM public.instructors WHERE user_id = auth.uid()$c$);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000017', false);
SET ROLE authenticated;
SELECT pt.expect_error('G05', 'new', '新註冊者不能用 {staff} 新增主檔', NULL,
  $s$INSERT INTO public.instructors (user_id, full_name, email_primary, personnel_types)
     VALUES (auth.uid(), '新註冊者', 'new@example.com', ARRAY['staff'])$s$, '42501');
SELECT pt.expect_error('G06', 'old', '新註冊者不能帶合作狀態新增主檔', NULL,
  $s$INSERT INTO public.instructors (user_id, full_name, email_primary, employment_status)
     VALUES (auth.uid(), '新註冊者', 'new@example.com', 'active')$s$, '42501');
SELECT pt.expect_true('G07', 'new', '新註冊者（舊前端）不帶人員類別新增 → 拿到 {instructor}、等級被設成實習',
  ARRAY[$s$INSERT INTO public.instructors (user_id, full_name, email_primary, phone_mobile)
     VALUES (auth.uid(), '新註冊者', 'new@example.com', '0900000000')$s$],
  $c$SELECT personnel_types = ARRAY['instructor']::text[] AND instructor_role = '實習' AND employment_status IS NULL
     FROM public.instructors WHERE user_id = auth.uid()$c$);
SELECT pt.expect_true('G08', 'new', '新註冊者明確送預設值 {instructor} 也可以新增',
  ARRAY[$s$INSERT INTO public.instructors (user_id, full_name, email_primary, personnel_types)
     VALUES (auth.uid(), '新註冊者', 'new@example.com', ARRAY['instructor'])$s$],
  $c$SELECT count(*) = 1 FROM public.instructors WHERE user_id = auth.uid()$c$);
RESET ROLE;

-- 只驗 trigger 本身：postgres（繞過 RLS）＋講師 JWT。
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
SELECT pt.expect_error('G09', 'new', 'guard 本身擋講師改人員類別（不是 RLS 擋的）', NULL,
  $s$UPDATE public.instructors SET personnel_types = ARRAY['staff'] WHERE id = '10000000-0000-4000-8000-000000000011'$s$,
  '42501', 'administrator-managed instructor fields cannot be changed by instructors');
SELECT pt.expect_error('G10', 'old', 'guard 本身擋講師把主檔改綁別人', NULL,
  $s$UPDATE public.instructors SET user_id = '00000000-0000-4000-8000-000000000016' WHERE id = '10000000-0000-4000-8000-000000000011'$s$,
  '42501', 'instructor account link cannot be changed by instructors');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000014', false);
SELECT pt.expect_error('G11', 'new', 'guard 本身擋輔導員（非 admin）改人員類別', NULL,
  $s$UPDATE public.instructors SET personnel_types = ARRAY['instructor', 'staff'] WHERE id = '10000000-0000-4000-8000-000000000014'$s$,
  '42501', 'administrator-managed instructor fields cannot be changed by instructors');
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000017', false);
SELECT pt.expect_error('G12', 'new', 'guard 本身擋非 admin 用 {part_time} 新增', NULL,
  $s$INSERT INTO public.instructors (user_id, full_name, email_primary, personnel_types)
     VALUES ('00000000-0000-4000-8000-000000000017', '新註冊者', 'new@example.com', ARRAY['part_time'])$s$,
  '42501', 'administrator-managed instructor fields cannot be set by instructors');
SELECT pt.expect_true('G13', 'old', 'guard 仍放行「未認領主檔 → 綁定本人」',
  ARRAY[$s$UPDATE public.instructors SET user_id = '00000000-0000-4000-8000-000000000017'
     WHERE id = '10000000-0000-4000-8000-000000000021'$s$],
  $c$SELECT user_id = '00000000-0000-4000-8000-000000000017' FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000021'$c$);
SELECT set_config('request.jwt.claim.sub', '', false);

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', false);
SET ROLE authenticated;
SELECT pt.expect_true('G14', 'new', '管理員可以改講師的人員類別',
  ARRAY[$s$UPDATE public.instructors SET personnel_types = ARRAY['instructor', 'staff'] WHERE id = '10000000-0000-4000-8000-000000000011'$s$],
  $c$SELECT personnel_types = ARRAY['instructor', 'staff']::text[] FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000011'$c$);
SELECT pt.expect_true('G15', 'new', '管理員可以用 {staff} 新增主檔',
  ARRAY[$s$INSERT INTO public.instructors (full_name, email_primary, employment_status, personnel_types)
     VALUES ('新職員', 'new-staff@example.com', 'active', ARRAY['staff'])$s$],
  $c$SELECT personnel_types = ARRAY['staff']::text[] FROM public.instructors WHERE email_primary = 'new-staff@example.com'$c$);

-- 舊前端（還沒換版）並存
SELECT pt.expect_true('O01', 'new', '舊後台新增講師（不帶人員類別）成功並得到 {instructor}',
  ARRAY[$s$INSERT INTO public.instructors (full_name, email_primary, phone_mobile, instructor_role, employment_status)
     VALUES ('舊後台新增', 'old-admin-new@example.com', '0933000000', 'A', 'active')$s$],
  $c$SELECT personnel_types = ARRAY['instructor']::text[] FROM public.instructors WHERE email_primary = 'old-admin-new@example.com'$c$);
SELECT pt.expect_true('O02', 'old', '舊後台把合作狀態設成 NULL、再設回 active 都成功',
  ARRAY[$s$UPDATE public.instructors SET employment_status = NULL WHERE id = '10000000-0000-4000-8000-000000000014'$s$,
        $s$UPDATE public.instructors SET employment_status = 'active' WHERE id = '10000000-0000-4000-8000-000000000014'$s$],
  $c$SELECT employment_status::text = 'active' FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000014'$c$);
SELECT pt.expect_true('O03', 'old', '舊後台更新其他欄位（暱稱、等級、管理備註）成功',
  ARRAY[$s$UPDATE public.instructors SET nickname = '後台改', instructor_role = 'B', note_internal = '後台備註'
     WHERE id = '10000000-0000-4000-8000-000000000014'$s$],
  $c$SELECT nickname = '後台改' AND instructor_role = 'B' AND note_internal = '後台備註'
     FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000014'$c$);
SELECT pt.expect_error('O04', 'new', '舊後台把合作狀態選成「職員」會被 CHECK 擋（預期行為）', NULL,
  $s$UPDATE public.instructors SET employment_status = 'staff' WHERE id = '10000000-0000-4000-8000-000000000014'$s$, '23514');
SELECT pt.expect_true('O05', 'old', '管理員改成冷凍：講師帳號照舊降為 pending（同步 trigger 不受影響）',
  ARRAY[$s$UPDATE public.instructors SET employment_status = 'frozen' WHERE id = '10000000-0000-4000-8000-000000000011'$s$],
  $c$SELECT role = 'pending' FROM public.users WHERE id = '00000000-0000-4000-8000-000000000011'$c$);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
SET ROLE authenticated;
SELECT pt.expect_true('O06', 'new', '舊個人頁存檔（select * 讀回後原值送回人員類別）成功',
  ARRAY[$s$UPDATE public.instructors
     SET nickname = '舊頁存檔',
         personnel_types = (SELECT i.personnel_types FROM public.instructors i WHERE i.user_id = auth.uid())
     WHERE user_id = auth.uid()$s$],
  $c$SELECT nickname = '舊頁存檔' FROM public.instructors WHERE user_id = auth.uid()$c$);
SELECT pt.expect_true('P10', 'old', '講師本人 is_my_instructor_profile_complete()：資料齊全 → true', NULL,
  $c$SELECT public.is_my_instructor_profile_complete()$c$);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ────────────────────────────────────────────────────────────────────
-- 8. 資料完整度（postgres 身分）
-- ────────────────────────────────────────────────────────────────────
SELECT pt.expect_true('P01', 'new', '只有職員、缺接課四欄 → 完整',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000001', ARRAY['staff'], 'active',
     ARRAY['teaching_freq_semester', 'teaching_freq_vacation', 'teaching_regions', 'bio_notes'])$s$],
  $c$SELECT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000001')$c$);
SELECT pt.expect_true('P02', 'new', '只有工讀、缺接課四欄 → 完整',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000002', ARRAY['part_time'], 'active',
     ARRAY['teaching_freq_semester', 'teaching_freq_vacation', 'teaching_regions', 'bio_notes'])$s$],
  $c$SELECT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000002')$c$);
SELECT pt.expect_true('P03', 'old', '講師缺接課四欄 → 不完整（四欄各缺一欄也都不完整）',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000031', NULL, 'active',
     ARRAY['teaching_freq_semester', 'teaching_freq_vacation', 'teaching_regions', 'bio_notes'])$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000032', NULL, 'active', ARRAY['teaching_freq_semester'])$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000033', NULL, 'active', ARRAY['teaching_freq_vacation'])$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000034', NULL, 'active', ARRAY['teaching_regions'])$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000035', NULL, 'active', ARRAY['bio_notes'])$s$],
  $c$SELECT NOT bool_or(private.instructor_profile_is_complete(id)) AND count(*) = 5 FROM public.instructors
     WHERE id IN ('20000000-0000-4000-8000-000000000031', '20000000-0000-4000-8000-000000000032',
                  '20000000-0000-4000-8000-000000000033', '20000000-0000-4000-8000-000000000034',
                  '20000000-0000-4000-8000-000000000035')$c$);
SELECT pt.expect_true('P04', 'new', '講師＋職員、缺接課四欄 → 不完整（含講師身分就要填）',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000004', ARRAY['instructor', 'staff'], 'active',
     ARRAY['teaching_freq_semester', 'teaching_freq_vacation', 'teaching_regions', 'bio_notes'])$s$],
  $c$SELECT NOT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000004')$c$);
SELECT pt.expect_true('P05', 'new', '職員但冷凍 → 不完整；職員但已離職 → 不完整',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000051', ARRAY['staff'], 'frozen',
     ARRAY['teaching_freq_semester', 'teaching_freq_vacation', 'teaching_regions', 'bio_notes'])$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000052', ARRAY['staff'], 'cancelled', NULL)$s$],
  $c$SELECT NOT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000051')
       AND NOT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000052')$c$);
SELECT pt.expect_true('P06', 'new', '職員缺銀行帳號／存摺封面／身分證 → 不完整',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000061', ARRAY['staff'], 'active', ARRAY['bank_account_number'])$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000062', ARRAY['staff'], 'active', ARRAY['bankbook_path'])$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000063', ARRAY['staff'], 'active', ARRAY['id_front_path'])$s$],
  $c$SELECT NOT bool_or(private.instructor_profile_is_complete(id)) AND count(*) = 3 FROM public.instructors
     WHERE id IN ('20000000-0000-4000-8000-000000000061', '20000000-0000-4000-8000-000000000062',
                  '20000000-0000-4000-8000-000000000063')$c$);
SELECT pt.expect_true('P07', 'new', '職員缺個人資料（LINE）→ 不完整',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000007', ARRAY['staff'], 'active', ARRAY['line_id'])$s$],
  $c$SELECT NOT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000007')$c$);
SELECT pt.expect_true('P08', 'old', '資料齊全的講師 → 完整（照片選填、NULL 合作狀態視為合作中）',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000081', NULL, 'active', NULL)$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000082', NULL, NULL, NULL)$s$],
  $c$SELECT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000081')
        AND private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000082')$c$);
SELECT pt.expect_true('P09', 'old', '資料齊全但冷凍／已離職的講師 → 不完整',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000091', NULL, 'frozen', NULL)$s$,
        $s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000092', NULL, 'cancelled', NULL)$s$],
  $c$SELECT NOT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000091')
       AND NOT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000092')$c$);
SELECT pt.expect_true('P11', 'old', '證件只有匯入的雲端連結（*_external_url）也算有 → 完整',
  ARRAY[$s$SELECT pt.make_profile('20000000-0000-4000-8000-000000000111', NULL, 'active',
     ARRAY['id_front_path', 'id_back_path', 'bankbook_path'])$s$,
        $s$UPDATE public.instructors SET id_front_external_url = 'https://example.com/a', id_back_external_url = 'https://example.com/b',
           bankbook_external_url = 'https://example.com/c' WHERE id = '20000000-0000-4000-8000-000000000111'$s$],
  $c$SELECT private.instructor_profile_is_complete('20000000-0000-4000-8000-000000000111')$c$);

-- ────────────────────────────────────────────────────────────────────
-- 9. 合約提醒（postgres 呼叫 SECURITY DEFINER 函式，JWT 指定呼叫者）
-- ────────────────────────────────────────────────────────────────────
SELECT pt.expect_reminder('R01', 'new', '只有職員 → 回 false、沒有新通知', NULL,
  '00000000-0000-4000-8000-000000000012', false, 0);
SELECT pt.expect_reminder('R02', 'new', '只有工讀 → 回 false、沒有新通知',
  ARRAY[$s$UPDATE public.instructors SET personnel_types = ARRAY['part_time'] WHERE id = '10000000-0000-4000-8000-000000000011'$s$],
  '00000000-0000-4000-8000-000000000011', false, 0);
SELECT pt.expect_reminder('R03', 'old', '未簽約講師 → 回 true、新增一則合約通知', NULL,
  '00000000-0000-4000-8000-000000000011', true, 1);
SELECT pt.expect_reminder('R04', 'new', '講師＋職員、未簽約 → 回 true、新增一則通知',
  ARRAY[$s$UPDATE public.instructors SET personnel_types = ARRAY['instructor', 'staff'] WHERE id = '10000000-0000-4000-8000-000000000011'$s$],
  '00000000-0000-4000-8000-000000000011', true, 1);
SELECT pt.expect_reminder('R05', 'old', '已有未讀提醒再呼叫 → 回 false、不重複新增',
  ARRAY[$s$SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', true)$s$,
        $s$SELECT public.ensure_my_contract_reminder()$s$],
  '00000000-0000-4000-8000-000000000011', false, 0);
SELECT pt.expect_reminder('R06', 'old', '已簽約講師 → 回 false', NULL,
  '00000000-0000-4000-8000-000000000013', false, 0);
SELECT pt.expect_reminder('R07', 'old', 'pending 帳號 → 回 false', NULL,
  '00000000-0000-4000-8000-000000000015', false, 0);
SELECT pt.expect_reminder('R08', 'old', '沒有主檔的已核准帳號 → 行為不變（回 true、新增通知）', NULL,
  '00000000-0000-4000-8000-000000000016', true, 1);
SELECT pt.expect_error('R09', 'old', '未登入呼叫 → 42501', NULL,
  $s$SELECT public.ensure_my_contract_reminder()$s$, '42501', 'authentication required');

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
SET ROLE authenticated;
SELECT pt.expect_true('R10', 'old', '講師以 authenticated 身分呼叫合約提醒仍可執行', NULL,
  $c$SELECT public.ensure_my_contract_reminder()$c$);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);

-- ────────────────────────────────────────────────────────────────────
-- 10. 與 20261022010000（課程受眾）＋ 20261022093700（夥伴號碼）的整合（prior_migrations=on 才跑）
--     帳號都是 teacher、合作中；「缺接課四欄」＝學期／寒暑假頻率、授課地區、簡介清空，其餘齊全。
-- ────────────────────────────────────────────────────────────────────
\if :prior_migrations
SELECT pt.expect_true('I00', 'old', '前置 migration 已生效：夥伴號碼 trigger、名冊函式存在，「Complete teachers」舊政策已移除', NULL, $c$
  SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.instructors'::regclass AND tgname = 'trg_guard_instructor_partner_no')
     AND to_regprocedure('public.mentor_instructor_directory(uuid[])') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'Complete teachers can view published %')
     AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'courses' AND cmd = 'SELECT') = 1
$c$);

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000012', false);
SET ROLE authenticated;
SELECT pt.expect_true('I01', 'new', '純職員（無等級、缺接課四欄）讀得到受眾 all 的已發佈課程、章節、內容',
  ARRAY[$s$SELECT pt.sudo($q$UPDATE public.instructors SET personnel_types = ARRAY['staff'], instructor_role = NULL,
     teaching_freq_semester = NULL, teaching_freq_vacation = NULL, teaching_regions = NULL, bio_notes = NULL
     WHERE id = '10000000-0000-4000-8000-000000000012'$q$)$s$],
  $c$SELECT pt.visible_course_items() @> ARRAY['course:全體課程', 'lesson:全體章節', 'content:全體內容']$c$);
SELECT pt.expect_true('I02', 'new', '純職員（無等級）讀不到受眾 formal 的課程、章節、內容',
  ARRAY[$s$SELECT pt.sudo($q$UPDATE public.instructors SET personnel_types = ARRAY['staff'], instructor_role = NULL,
     teaching_freq_semester = NULL, teaching_freq_vacation = NULL, teaching_regions = NULL, bio_notes = NULL
     WHERE id = '10000000-0000-4000-8000-000000000012'$q$)$s$],
  $c$SELECT pt.visible_course_items() = ARRAY['content:全體內容', 'course:全體課程', 'lesson:全體章節']$c$);
SELECT pt.expect_true('I03', 'new', '職員有等級 B（缺接課四欄）→ formal 課程也讀得到（受眾仍只看等級）',
  ARRAY[$s$SELECT pt.sudo($q$UPDATE public.instructors SET personnel_types = ARRAY['staff'], instructor_role = 'B',
     teaching_freq_semester = NULL, teaching_freq_vacation = NULL, teaching_regions = NULL, bio_notes = NULL
     WHERE id = '10000000-0000-4000-8000-000000000012'$q$)$s$],
  $c$SELECT pt.visible_course_items() @> ARRAY['course:正式講師課程', 'lesson:正式章節', 'content:正式內容', 'course:全體課程']$c$);
SELECT pt.expect_true('I04', 'new', '職員但冷凍 → 課程、章節、內容全部讀不到',
  ARRAY[$s$SELECT pt.sudo($q$UPDATE public.instructors SET personnel_types = ARRAY['staff'], employment_status = 'frozen'
     WHERE id = '10000000-0000-4000-8000-000000000012'$q$)$s$,
        $s$SELECT pt.sudo($q$UPDATE public.users SET role = 'teacher' WHERE id = '00000000-0000-4000-8000-000000000012'$q$)$s$],
  $c$SELECT cardinality(pt.visible_course_items()) = 0$c$);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
SET ROLE authenticated;
SELECT pt.expect_true('I05', 'old', '講師（無等級、缺接課四欄）→ 課程、章節、內容全部讀不到',
  ARRAY[$s$SELECT pt.sudo($q$UPDATE public.instructors SET instructor_role = NULL,
     teaching_freq_semester = NULL, teaching_freq_vacation = NULL, teaching_regions = NULL, bio_notes = NULL
     WHERE id = '10000000-0000-4000-8000-000000000011'$q$)$s$],
  $c$SELECT cardinality(pt.visible_course_items()) = 0$c$);
SELECT pt.expect_true('I06', 'old', '資料齊全的講師（無等級）→ 只讀得到 all，讀不到 formal', NULL,
  $c$SELECT pt.visible_course_items() = ARRAY['content:全體內容', 'course:全體課程', 'lesson:全體章節']$c$);
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '', false);
\endif

-- ────────────────────────────────────────────────────────────────────
-- 11. 輸出
-- ────────────────────────────────────────────────────────────────────
\o
SELECT format('MD5|before|%s|%s', fn, md5) FROM pt.functions_before
WHERE fn IN ('public.guard_instructor_admin_fields()',
             'private.instructor_profile_is_complete(target_instructor_id uuid)',
             'public.ensure_my_contract_reminder()')
ORDER BY fn;
SELECT format('MD5|after|%s|%s', pt.fn_key(p.oid), md5(p.prosrc)) FROM pg_proc p
WHERE p.oid IN (to_regprocedure('public.guard_instructor_admin_fields()'),
                to_regprocedure('private.instructor_profile_is_complete(uuid)'),
                to_regprocedure('public.ensure_my_contract_reminder()'))
ORDER BY 1;
SELECT format('RESULT|%s|%s|%s|%s|%s', code, tag, CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END, descr, COALESCE(detail, ''))
FROM pt.results ORDER BY seq;
