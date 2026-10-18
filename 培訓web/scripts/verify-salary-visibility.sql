\set ON_ERROR_STOP on
\set QUIET on

-- ═══════════════════════════════════════════════════════════════════
-- 課程回報對齊 Google 表單：migration 20261018120000 的隔離驗證
--   第一段：模擬正式庫現況（舊 class_sessions ＋ 20260826），套新 migration 三次
--   第二段：新建庫路徑（2025_salary_system.sql → 20260826 → 20261018）
-- ═══════════════════════════════════════════════════════════════════

CREATE SCHEMA auth;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

CREATE TYPE public.instructor_role_enum AS ENUM ('S', 'A+', 'A', 'B', '實習');
CREATE TYPE public.pricing_mode_enum AS ENUM ('hourly', 'per_session', 'fixed', 'negotiable');
CREATE TYPE public.session_role_enum AS ENUM ('lead', 'assistant', 'head_judge', 'sub_judge', 'counter', 'project_lead', 'other');
CREATE TYPE public.session_status_enum AS ENUM ('pending', 'approved', 'paid');

CREATE TABLE public.users (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  name text,
  email text,
  role text
);
GRANT SELECT ON public.users TO authenticated;

CREATE TABLE public.instructors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid UNIQUE REFERENCES auth.users(id),
  full_name text NOT NULL,
  instructor_role public.instructor_role_enum,
  speed_qualification text CHECK (speed_qualification IS NULL OR speed_qualification IN ('speed_teacher', 'speed_master')),
  employment_status text DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.salary_rate_card (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  course_type text NOT NULL,
  instructor_role text,
  duration_hours numeric(4,2),
  student_count_min integer,
  student_count_max integer,
  pricing_mode public.pricing_mode_enum NOT NULL,
  rate numeric(10,2),
  effective_from date NOT NULL DEFAULT CURRENT_DATE,
  effective_to date,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id)
);

CREATE TABLE public.class_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  course_type text NOT NULL,
  course_name text,
  location text,
  instructor_id uuid REFERENCES public.instructors(id),
  instructor_name text NOT NULL,
  role_in_session public.session_role_enum DEFAULT 'lead',
  instructor_role_at_time text,
  session_date date NOT NULL,
  duration_hours numeric(5,2),
  student_count integer,
  pricing_mode public.pricing_mode_enum,
  rate_card_id uuid REFERENCES public.salary_rate_card(id),
  base_salary numeric(10,2),
  bonus numeric(10,2) DEFAULT 0,
  paid_amount numeric(10,2) DEFAULT 0,
  status public.session_status_enum DEFAULT 'approved',
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  paid_at timestamptz,
  registered_by uuid REFERENCES auth.users(id),
  registered_by_name text,
  self_review text,
  progress_note text,
  incident_report text,
  notes text,
  source text DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW public.instructor_salary_summary AS
SELECT i.id AS instructor_id, i.user_id, i.full_name, count(s.id) AS total_sessions
  FROM public.instructors i
  LEFT JOIN public.class_sessions s ON s.instructor_id = i.id
 GROUP BY i.id, i.user_id, i.full_name;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'teacher@test.local'),
  ('00000000-0000-4000-8000-000000000003', 'admin@test.local');
INSERT INTO public.users (id, name, email, role) VALUES
  ('00000000-0000-4000-8000-000000000001', '老師一', 'teacher@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000003', '管理員', 'admin@test.local', 'admin');
INSERT INTO public.instructors (id, user_id, full_name, instructor_role) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '老師一', 'A');

-- 套用 migration 前已存在的舊紀錄：新欄位要能平順補上預設值
INSERT INTO public.class_sessions (course_type, instructor_id, instructor_name, session_date)
VALUES ('onsite_1_5hr', '10000000-0000-4000-8000-000000000001', '老師一', '2026-08-01');

\ir ../supabase/migrations/20260826105841_restore_salary_workflow.sql

-- 模擬正式庫現況：class_sessions 與 salary_rate_card 的既有 RLS／政策／授權（2025_salary_system.sql）
GRANT SELECT ON public.class_sessions, public.instructors, public.instructor_salary_summary, public.salary_rate_card TO authenticated;
ALTER TABLE public.class_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Instructors view own sessions" ON public.class_sessions FOR SELECT
  USING (instructor_id IN (SELECT id FROM public.instructors WHERE user_id = auth.uid()));
CREATE POLICY "Admins manage all sessions" ON public.class_sessions FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','mentor')));
ALTER TABLE public.salary_rate_card ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Everyone authenticated can view rate card" ON public.salary_rate_card FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage rate card" ON public.salary_rate_card FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

INSERT INTO public.salary_rate_card (course_type, instructor_role, duration_hours, pricing_mode, rate, effective_from)
VALUES ('onsite_1_5hr', 'A', 1.5, 'hourly', 400, '2025-01-01');
\ir ../supabase/migrations/20261018120000_align_salary_report_with_forms.sql

-- 另一位講師，用來確認仍看不到別人的紀錄
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-000000000002', 'teacher2@test.local');
INSERT INTO public.users (id, name, email, role) VALUES ('00000000-0000-4000-8000-000000000002', '老師二', 'teacher2@test.local', 'teacher');
INSERT INTO public.instructors (id, user_id, full_name, instructor_role) VALUES
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', '老師二', 'A');
-- 只用 Google 登入、尚未核准的帳號
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-000000000004', 'pending@test.local');
INSERT INTO public.users (id, name, email, role) VALUES ('00000000-0000-4000-8000-000000000004', '路人', 'pending@test.local', 'pending');

-- 老師一：2025-12-31（門檻前）、2026-01-01（門檻當天）、2026-08-01（引導區已有）；老師二：2026-03-01
INSERT INTO public.class_sessions (course_type, instructor_id, instructor_name, session_date, base_salary) VALUES
  ('onsite_1_5hr', '10000000-0000-4000-8000-000000000001', '老師一', '2025-12-31', 600),
  ('onsite_1_5hr', '10000000-0000-4000-8000-000000000001', '老師一', '2026-01-01', 700),
  ('onsite_1_5hr', '10000000-0000-4000-8000-000000000002', '老師二', '2026-03-01', 800);
UPDATE public.class_sessions SET base_salary = 500 WHERE session_date = '2026-08-01';

-- (a) 可重複執行
\ir ../supabase/migrations/20261018150000_limit_instructor_salary_visibility.sql
\ir ../supabase/migrations/20261018150000_limit_instructor_salary_visibility.sql
\echo PASS (a) visibility migration applied twice without error

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'class_sessions' AND policyname = 'Instructors view own sessions') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one instructor SELECT policy';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'class_sessions') <> 2 THEN
    RAISE EXCEPTION 'expected 2 policies on class_sessions, got %', (SELECT count(*) FROM pg_policies WHERE tablename = 'class_sessions');
  END IF;
  IF public.instructor_salary_visible_from() <> DATE '2026-01-01' THEN
    RAISE EXCEPTION 'visible_from must be 2026-01-01';
  END IF;
  IF has_function_privilege('anon', 'public.instructor_salary_visible_from()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute visible_from';
  END IF;
END;
$$;
\echo PASS (b) policy replaced (2 policies total), threshold 2026-01-01, anon cannot execute threshold fn

-- (c) 老師一只看得到 2026-01-01 與 2026-08-01 兩筆；彙總也只算這兩筆
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
DECLARE n int; dates text; total numeric; cnt int;
BEGIN
  SELECT count(*), string_agg(session_date::text, ',' ORDER BY session_date) INTO n, dates FROM public.class_sessions;
  IF n <> 2 OR dates <> '2026-01-01,2026-08-01' THEN
    RAISE EXCEPTION 'teacher 1 should see exactly 2026-01-01 and 2026-08-01, got % (%)', n, dates;
  END IF;
  SELECT total_sessions INTO cnt FROM public.instructor_salary_summary WHERE user_id = auth.uid();
  SELECT sum(base_salary) INTO total FROM public.class_sessions;
  IF cnt <> 2 OR total <> 1200 THEN
    RAISE EXCEPTION 'summary should count 2 sessions / visible salary 1200, got % / %', cnt, total;
  END IF;
  IF EXISTS (SELECT 1 FROM public.class_sessions WHERE instructor_name = '老師二') THEN
    RAISE EXCEPTION 'teacher 1 must not see teacher 2';
  END IF;
END;
$$;
RESET ROLE;
\echo PASS (c) teacher sees only own sessions dated >= 2026-01-01; summary view follows (2 sessions / 1200); other teacher hidden

-- (d) 老師二看得到自己的 2026-03-01
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.class_sessions) <> 1
     OR (SELECT session_date FROM public.class_sessions) <> DATE '2026-03-01' THEN
    RAISE EXCEPTION 'teacher 2 should see exactly own 2026-03-01';
  END IF;
END;
$$;
RESET ROLE;
\echo PASS (d) another teacher sees only own 2026 session

-- (e) 管理員看全部 4 筆（含 2025-12-31）
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.class_sessions) <> 4 THEN
    RAISE EXCEPTION 'admin should see all 4 sessions, got %', (SELECT count(*) FROM public.class_sessions);
  END IF;
END;
$$;
RESET ROLE;
\echo PASS (e) admin still sees all sessions including pre-2026

-- (f) anon 什麼都看不到
SELECT set_config('request.jwt.claim.sub', '', false) AS jwt_sub \gset
SET ROLE anon;
DO $$
DECLARE n int := -1;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.class_sessions;
  EXCEPTION WHEN insufficient_privilege THEN n := 0;
  END;
  IF n <> 0 THEN RAISE EXCEPTION 'anon must see nothing, got %', n; END IF;
END;
$$;
RESET ROLE;
\echo PASS (f) anon sees nothing

-- (g) 講師仍可透過 RPC 回報（SECURITY DEFINER 不受新政策影響），且回報後自己看得到
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false) AS jwt_sub \gset
SET ROLE authenticated;
SELECT public.submit_my_class_session(p_course_type => 'onsite_1_5hr', p_session_date => '2026-09-01', p_duration_hours => 1.5, p_student_count => 2) AS new_id \gset
DO $$
BEGIN
  IF (SELECT count(*) FROM public.class_sessions WHERE session_date = '2026-09-01') <> 1 THEN
    RAISE EXCEPTION 'teacher should see the session just submitted';
  END IF;
END;
$$;
RESET ROLE;
\echo PASS (g) submit RPC still works and the new session is visible to its owner

-- (h) pending 帳號讀不到報酬表與選項表；teacher 讀得到
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000004', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.salary_rate_card) <> 0 THEN RAISE EXCEPTION 'pending must not read rate card'; END IF;
  IF (SELECT count(*) FROM public.salary_report_options) <> 0 THEN RAISE EXCEPTION 'pending must not read report options'; END IF;
  IF (SELECT count(*) FROM public.class_sessions) <> 0 THEN RAISE EXCEPTION 'pending must not read sessions'; END IF;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.salary_rate_card) < 1 THEN RAISE EXCEPTION 'teacher must read rate card'; END IF;
  IF (SELECT count(*) FROM public.salary_report_options) <> 112 THEN RAISE EXCEPTION 'teacher must read 112 active options'; END IF;
END;
$$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE tablename = 'salary_rate_card' AND cmd = 'SELECT') <> 1
     OR (SELECT count(*) FROM pg_policies WHERE tablename = 'salary_report_options' AND cmd = 'SELECT') <> 1 THEN
    RAISE EXCEPTION 'reference tables must each have exactly one SELECT policy';
  END IF;
END;
$$;
\echo PASS (h) pending account cannot read rate card / report options / sessions; teacher can; one SELECT policy each

\echo salary visibility SQL verification passed
