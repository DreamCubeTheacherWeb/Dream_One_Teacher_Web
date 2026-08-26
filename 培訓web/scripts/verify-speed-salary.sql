\set ON_ERROR_STOP on

CREATE SCHEMA auth;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

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

\ir ../supabase/migrations/20260826105841_restore_salary_workflow.sql
-- migration 必須可安全重跑（SQL Editor／部署補跑時不重複建立 constraint 或 trigger）。
\ir ../supabase/migrations/20260826105841_restore_salary_workflow.sql

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'teacher1@test.local'),
  ('00000000-0000-4000-8000-000000000002', 'teacher2@test.local'),
  ('00000000-0000-4000-8000-000000000003', 'admin@test.local');
INSERT INTO public.users (id, name, email, role) VALUES
  ('00000000-0000-4000-8000-000000000001', '老師一', 'teacher1@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', '老師二', 'teacher2@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000003', '管理員', 'admin@test.local', 'admin');
INSERT INTO public.instructors (id, user_id, full_name, instructor_role, speed_qualification) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '老師一', 'A', 'speed_master'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000002', '老師二', 'B', NULL);

INSERT INTO public.salary_rate_card
  (course_type, instructor_role, duration_hours, student_count_min, student_count_max, pricing_mode, rate, effective_from)
VALUES
  ('regular_basic', 'A', 1.5, 2, 2, 'hourly', 300, '2025-01-01'),
  ('speed_onsite', '速解大師', 1.5, 2, 2, 'hourly', 900, '2025-01-01'),
  ('speed_training_lead', NULL, 2, 1, 3, 'hourly', 700, '2025-01-01');

-- 一般課依一般等級；速解課依速解資格；速解通用費率仍要求已取得資格。
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false);
DO $$
DECLARE q record;
BEGIN
  SELECT * INTO q FROM public.quote_salary(
    '10000000-0000-4000-8000-000000000001', 'regular_basic', '2026-08-14', 'lead', 1.5, 2
  );
  IF NOT q.matched OR q.pricing_basis <> 'general_level' OR q.base_salary <> 450 THEN
    RAISE EXCEPTION 'general level quote failed: %', row_to_json(q);
  END IF;

  SELECT * INTO q FROM public.quote_salary(
    '10000000-0000-4000-8000-000000000001', 'speed_onsite', '2026-08-14', 'lead', 1.5, 2
  );
  IF NOT q.matched OR q.pricing_label <> '速解大師' OR q.base_salary <> 1350 THEN
    RAISE EXCEPTION 'speed qualification quote failed: %', row_to_json(q);
  END IF;

  SELECT * INTO q FROM public.quote_salary(
    '10000000-0000-4000-8000-000000000001', 'speed_training_lead', '2026-08-14', 'lead', 2, 2
  );
  IF NOT q.matched OR q.pricing_basis <> 'speed_qualification' OR q.base_salary <> 1400 THEN
    RAISE EXCEPTION 'generic speed quote failed: %', row_to_json(q);
  END IF;
END;
$$;

-- 資料品質邊界在資料庫入口一併擋下。
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM public.quote_salary(
      '10000000-0000-4000-8000-000000000001', 'regular_basic', '2099-01-01', 'lead', 1.5, 2
    );
  EXCEPTION WHEN OTHERS THEN
    denied := SQLERRM LIKE '%日期不能晚於今天%';
  END;
  IF NOT denied THEN RAISE EXCEPTION 'future session quote was accepted'; END IF;

  denied := false;
  BEGIN
    PERFORM public.submit_my_class_session(
      'regular_basic', '2026-08-14', 'lead', '常態課', '台北', 1.5, 2, NULL, NULL, NULL
    );
  EXCEPTION WHEN OTHERS THEN
    denied := SQLERRM LIKE '%學習進度%';
  END;
  IF NOT denied THEN RAISE EXCEPTION 'regular class without progress was accepted'; END IF;

  denied := false;
  BEGIN
    PERFORM public.submit_my_class_session(
      'regular_basic', '2026-08-14', 'lead', '常態課', '台北', -1, 2, NULL, '進度', NULL
    );
  EXCEPTION WHEN OTHERS THEN
    denied := SQLERRM LIKE '%時數%';
  END;
  IF NOT denied THEN RAISE EXCEPTION 'negative duration was accepted'; END IF;

  denied := false;
  BEGIN
    PERFORM public.submit_my_class_session(
      'unknown_course', '2026-08-14', 'lead', '未知課程', '台北', 1, 2, NULL, NULL, NULL
    );
  EXCEPTION WHEN OTHERS THEN
    denied := SQLERRM LIKE '%不支援的課程類型%';
  END;
  IF NOT denied THEN RAISE EXCEPTION 'unsupported course type was accepted'; END IF;
END;
$$;

-- 不可試算別人的薪資。
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM * FROM public.quote_salary(
      '10000000-0000-4000-8000-000000000002', 'regular_basic', '2026-08-14', 'lead', 1.5, 2
    );
  EXCEPTION WHEN OTHERS THEN
    denied := SQLERRM LIKE '%not allowed%';
  END;
  IF NOT denied THEN RAISE EXCEPTION 'cross-instructor quote was not denied'; END IF;
END;
$$;

-- 受控回報會保存資格與費率快照。
SELECT public.submit_my_class_session(
  'speed_onsite', '2026-08-14', 'lead', '速解測試課', '台北', 1.5, 2, '順利', NULL, NULL
);

DO $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM public.class_sessions WHERE instructor_id = '10000000-0000-4000-8000-000000000001';
  IF s.pricing_status <> 'quoted' OR s.status <> 'pending' OR s.base_salary <> 1350
     OR s.speed_qualification_at_time <> 'speed_master' OR s.pricing_label <> '速解大師' THEN
    RAISE EXCEPTION 'server submission snapshot failed: %', row_to_json(s);
  END IF;
END;
$$;

-- 未取得速解資格仍可回報，但金額必須為 NULL / 待核薪，不能被誤記為 0。
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000002', false);
SELECT public.submit_my_class_session(
  'speed_onsite', '2026-08-14', 'lead', '待核薪測試課', '台北', 1.5, 2, NULL, NULL, NULL
);

DO $$
DECLARE s record; blocked boolean := false;
BEGIN
  SELECT * INTO s FROM public.class_sessions WHERE instructor_id = '10000000-0000-4000-8000-000000000002';
  IF s.pricing_status <> 'needs_review' OR s.status <> 'pending' OR s.base_salary IS NOT NULL THEN
    RAISE EXCEPTION 'missing qualification was not preserved as pending: %', row_to_json(s);
  END IF;

  BEGIN
    UPDATE public.class_sessions SET status = 'approved' WHERE id = s.id;
  EXCEPTION WHEN OTHERS THEN
    blocked := SQLERRM LIKE '%不能直接核准%';
  END;
  IF NOT blocked THEN RAISE EXCEPTION 'unpriced session was approved'; END IF;
END;
$$;

-- RPC 與 view 權限採最小授權。
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.quote_salary(uuid,text,date,text,numeric,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute quote_salary';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.quote_salary(uuid,text,date,text,numeric,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute quote_salary';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.instructor_salary_summary'::regclass
       AND reloptions @> ARRAY['security_invoker=true']
  ) THEN
    RAISE EXCEPTION 'salary summary view is not security_invoker';
  END IF;
END;
$$;

SELECT 'speed salary SQL verification passed' AS result;
