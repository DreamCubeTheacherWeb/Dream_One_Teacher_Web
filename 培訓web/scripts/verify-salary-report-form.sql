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

INSERT INTO public.salary_rate_card
  (course_type, instructor_role, duration_hours, pricing_mode, rate, effective_from)
VALUES
  ('onsite_1_5hr', 'A', 1.5, 'hourly', 400, '2025-01-01'),
  ('collab_lead', 'A', NULL, 'hourly', 500, '2025-01-01'),
  ('camp', 'A', NULL, 'fixed', 3000, '2025-01-01'),
  ('camp_director_5d', NULL, NULL, 'fixed', 8000, '2025-01-01'),
  ('speed_camp', NULL, NULL, 'negotiable', NULL, '2025-01-01');

-- (a) migration 可連續重跑
\ir ../supabase/migrations/20261018120000_align_salary_report_with_forms.sql
\ir ../supabase/migrations/20261018120000_align_salary_report_with_forms.sql
\echo PASS (a) migration applied twice without error

DO $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM public.class_sessions WHERE session_date = '2026-08-01';
  IF s.transport_subsidy_requested IS DISTINCT FROM false OR s.transport_distance_km IS NOT NULL
     OR s.term_period IS NOT NULL OR s.unit_name IS NOT NULL OR s.materials_issued IS NOT NULL THEN
    RAISE EXCEPTION 'legacy row defaults are wrong: %', row_to_json(s);
  END IF;
END;
$$;
\echo PASS (a) legacy class_sessions row backfilled (transport=false, new fields NULL)

-- (b) 只剩一個 submit_my_class_session（舊簽章已移除，PostgREST 不會歧義）
DO $$
DECLARE n integer; args text;
BEGIN
  SELECT count(*), max(pg_get_function_identity_arguments(p.oid)) INTO n, args
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'submit_my_class_session';
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 submit_my_class_session, found %', n; END IF;
  IF args NOT LIKE '%p_transport_distance_km numeric' THEN
    RAISE EXCEPTION 'unexpected signature: %', args;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.submit_my_class_session(text,date,text,text,text,numeric,integer,text,text,text,text,text,text,boolean,numeric)'::regprocedure
       AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION 'submit_my_class_session lost SECURITY DEFINER or empty search_path';
  END IF;
END;
$$;
\echo PASS (b) pg_proc has exactly one submit_my_class_session (SECURITY DEFINER, empty search_path)

-- (c) anon 對 RPC 與選項表沒有任何權限；authenticated 可執行 RPC
DO $$
DECLARE priv text;
BEGIN
  IF has_function_privilege('anon', 'public.submit_my_class_session(text,date,text,text,text,numeric,integer,text,text,text,text,text,text,boolean,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute submit_my_class_session';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.submit_my_class_session(text,date,text,text,text,numeric,integer,text,text,text,text,text,text,boolean,numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute submit_my_class_session';
  END IF;
  FOREACH priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
    IF has_table_privilege('anon', 'public.salary_report_options', priv) THEN
      RAISE EXCEPTION 'anon has % on salary_report_options', priv;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.salary_report_options'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'salary_report_options RLS is disabled';
  END IF;
END;
$$;

SET ROLE anon;
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM count(*) FROM public.salary_report_options;
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon could read salary_report_options'; END IF;
  denied := false;
  BEGIN
    PERFORM public.submit_my_class_session('onsite_1_5hr', '2026-08-14');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'anon could call submit_my_class_session'; END IF;
END;
$$;
RESET ROLE;
\echo PASS (c) anon has no privilege on RPC or salary_report_options (catalog + live attempt)

-- (f) 種子筆數符合清單（已重跑兩次仍不重複）
DO $$
DECLARE n_term integer; n_unit integer; n_camp integer; n_other integer;
BEGIN
  SELECT count(*) FILTER (WHERE kind = 'term_period'),
         count(*) FILTER (WHERE kind = 'partner_unit'),
         count(*) FILTER (WHERE kind = 'camp_batch'),
         count(*) FILTER (WHERE value LIKE '%↓↓%')
    INTO n_term, n_unit, n_camp, n_other
    FROM public.salary_report_options;
  IF n_term <> 3 OR n_unit <> 78 OR n_camp <> 31 OR n_other <> 0 THEN
    RAISE EXCEPTION 'seed counts wrong: term=% unit=% camp=% separator=%', n_term, n_unit, n_camp, n_other;
  END IF;
  IF (SELECT string_agg(value || '=' || label, ',' ORDER BY sort_order)
        FROM public.salary_report_options WHERE kind = 'term_period')
     <> 'winter_break=寒假,semester=學期間,summer_break=暑假' THEN
    RAISE EXCEPTION 'term_period seeds wrong';
  END IF;
  IF (SELECT value FROM public.salary_report_options WHERE kind = 'partner_unit' ORDER BY sort_order LIMIT 1)
     <> '【基隆】三之三立敏分校'
     OR (SELECT value FROM public.salary_report_options WHERE kind = 'partner_unit' ORDER BY sort_order DESC LIMIT 1)
     <> '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動'
     OR (SELECT value FROM public.salary_report_options WHERE kind = 'camp_batch' ORDER BY sort_order DESC LIMIT 1)
     <> '【高雄H】苓雅 | 8/15~8/16 速解營' THEN
    RAISE EXCEPTION 'seed order wrong';
  END IF;
END;
$$;

-- 管理員改過的 label／停用狀態，重跑 migration 不會被覆寫
UPDATE public.salary_report_options SET label = '寒假（改名）' WHERE kind = 'term_period' AND value = 'winter_break';
UPDATE public.salary_report_options SET is_active = false WHERE kind = 'camp_batch' AND value = '【臺北A】中山 | 7/1~7/3 三日營';
\ir ../supabase/migrations/20261018120000_align_salary_report_with_forms.sql
DO $$
BEGIN
  IF (SELECT count(*) FROM public.salary_report_options) <> 112 THEN
    RAISE EXCEPTION 'third run duplicated seeds';
  END IF;
  IF (SELECT label FROM public.salary_report_options WHERE kind = 'term_period' AND value = 'winter_break') <> '寒假（改名）'
     OR (SELECT is_active FROM public.salary_report_options WHERE value = '【臺北A】中山 | 7/1~7/3 三日營') THEN
    RAISE EXCEPTION 'rerun overwrote admin edits';
  END IF;
END;
$$;
\echo PASS (f) seeds term_period=3 partner_unit=78 camp_batch=31 (total 112), order kept, rerun keeps admin edits

-- 選項表 RLS：講師只讀啟用中的選項、不能寫；管理員可讀全部並管理
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
DECLARE denied boolean := false; n integer;
BEGIN
  SELECT count(*) INTO n FROM public.salary_report_options;
  IF n <> 111 THEN RAISE EXCEPTION 'teacher should see 111 active options, saw %', n; END IF;
  BEGIN
    INSERT INTO public.salary_report_options (kind, value, label) VALUES ('camp_batch', '偽造梯次', '偽造梯次');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'teacher could insert option'; END IF;
  UPDATE public.salary_report_options SET label = 'hacked' WHERE kind = 'term_period';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'teacher updated % options', n; END IF;
  DELETE FROM public.salary_report_options WHERE kind = 'partner_unit';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'teacher deleted % options', n; END IF;
END;
$$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000003', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.salary_report_options;
  IF n <> 112 THEN RAISE EXCEPTION 'admin should see all 112 options, saw %', n; END IF;
  INSERT INTO public.salary_report_options (kind, value, label, sort_order) VALUES ('camp_batch', '管理員新增梯次', '管理員新增梯次', 999);
  UPDATE public.salary_report_options SET is_active = true WHERE value = '【臺北A】中山 | 7/1~7/3 三日營';
  DELETE FROM public.salary_report_options WHERE value = '管理員新增梯次';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'admin delete failed'; END IF;
END;
$$;
RESET ROLE;
\echo PASS RLS teacher reads only active options and cannot insert/update/delete; admin manages all

-- (d) 資料品質邊界：以登入講師身分（authenticated）呼叫
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false) AS jwt_sub \gset
SET ROLE authenticated;
DO $$
DECLARE
  test_case text[];
  denied boolean;
  err text;
BEGIN
  FOREACH test_case SLICE 1 IN ARRAY ARRAY[
    ARRAY['合作課缺上課單位',
      $q$SELECT public.submit_my_class_session(p_course_type => 'collab_lead', p_session_date => '2026-08-14', p_duration_hours => 2, p_student_count => 10, p_term_period => 'semester')$q$,
      '%請選擇本次上課單位%'],
    ARRAY['合作課只填空白單位',
      $q$SELECT public.submit_my_class_session(p_course_type => 'collab_lead', p_session_date => '2026-08-14', p_term_period => 'semester', p_unit_name => '   ')$q$,
      '%請選擇本次上課單位%'],
    ARRAY['合作課缺教學期間',
      $q$SELECT public.submit_my_class_session(p_course_type => 'collab_lead', p_session_date => '2026-08-14', p_unit_name => '【臺北】新生國小')$q$,
      '%請選擇教學課程期間%'],
    ARRAY['教學期間值不在清單',
      $q$SELECT public.submit_my_class_session(p_course_type => 'collab_lead', p_session_date => '2026-08-14', p_unit_name => '【臺北】新生國小', p_term_period => 'spring')$q$,
      '%教學課程期間不正確%'],
    ARRAY['營隊缺梯次',
      $q$SELECT public.submit_my_class_session(p_course_type => 'camp', p_session_date => '2026-08-14', p_student_count => 8)$q$,
      '%請選擇營隊梯次%'],
    ARRAY['營隊負責人缺梯次',
      $q$SELECT public.submit_my_class_session(p_course_type => 'camp_director_5d', p_session_date => '2026-08-14', p_role_in_session => 'project_lead')$q$,
      '%請選擇營隊梯次%'],
    ARRAY['速解營隊缺梯次',
      $q$SELECT public.submit_my_class_session(p_course_type => 'speed_camp', p_session_date => '2026-08-14')$q$,
      '%請選擇營隊梯次%'],
    ARRAY['交通補助勾了沒填公里數',
      $q$SELECT public.submit_my_class_session(p_course_type => 'onsite_1_5hr', p_session_date => '2026-08-14', p_transport_subsidy_requested => true)$q$,
      '%請填寫單趟公里數%'],
    ARRAY['交通補助公里數為 0',
      $q$SELECT public.submit_my_class_session(p_course_type => 'onsite_1_5hr', p_session_date => '2026-08-14', p_transport_subsidy_requested => true, p_transport_distance_km => 0)$q$,
      '%大於 0 且不超過 500%'],
    ARRAY['交通補助公里數四捨五入後為 0',
      $q$SELECT public.submit_my_class_session(p_course_type => 'onsite_1_5hr', p_session_date => '2026-08-14', p_transport_subsidy_requested => true, p_transport_distance_km => 0.04)$q$,
      '%大於 0 且不超過 500%'],
    ARRAY['交通補助公里數超過 500',
      $q$SELECT public.submit_my_class_session(p_course_type => 'onsite_1_5hr', p_session_date => '2026-08-14', p_transport_subsidy_requested => true, p_transport_distance_km => 500.1)$q$,
      '%大於 0 且不超過 500%'],
    ARRAY['交通補助負公里數',
      $q$SELECT public.submit_my_class_session(p_course_type => 'onsite_1_5hr', p_session_date => '2026-08-14', p_transport_subsidy_requested => true, p_transport_distance_km => -5)$q$,
      '%大於 0 且不超過 500%'],
    ARRAY['上課單位超過 200 字',
      $q$SELECT public.submit_my_class_session(p_course_type => 'collab_lead', p_session_date => '2026-08-14', p_term_period => 'semester', p_unit_name => repeat('單', 201))$q$,
      '%不得超過 200 字%'],
    ARRAY['教材數量超過 200 字',
      $q$SELECT public.submit_my_class_session(p_course_type => 'collab_lead', p_session_date => '2026-08-14', p_term_period => 'semester', p_unit_name => '【臺北】新生國小', p_materials_issued => repeat('楓', 201))$q$,
      '%不得超過 200 字%'],
    ARRAY['既有驗證仍在：未來日期',
      $q$SELECT public.submit_my_class_session(p_course_type => 'onsite_1_5hr', p_session_date => '2099-01-01')$q$,
      '%日期不能晚於今天%']
  ] LOOP
    denied := false;
    err := NULL;
    BEGIN
      EXECUTE test_case[2];
    EXCEPTION WHEN OTHERS THEN
      err := SQLERRM;
      denied := SQLERRM LIKE test_case[3];
    END;
    IF NOT denied THEN
      RAISE EXCEPTION '% was not rejected as expected (error: %)', test_case[1], COALESCE(err, 'none');
    END IF;
    RAISE NOTICE 'PASS (d) rejected: %', test_case[1];
  END LOOP;
END;
$$;
RESET ROLE;
\echo PASS (d) collab missing unit/term, camp missing batch, transport km missing/0/<0.05/>500/negative, >200 chars all rejected

DO $$
BEGIN
  IF (SELECT count(*) FROM public.class_sessions WHERE source = 'self_report') <> 0 THEN
    RAISE EXCEPTION 'rejected submissions left rows behind';
  END IF;
END;
$$;

-- (e) 三種課型各送一筆成功回報，並檢查新欄位值
SET ROLE authenticated;
SELECT public.submit_my_class_session(
  p_course_type => 'onsite_1_5hr', p_session_date => '2026-08-14', p_course_name => '王小明',
  p_duration_hours => 1.5, p_student_count => 2,
  p_transport_subsidy_requested => true, p_transport_distance_km => 12.35,
  p_incident_report => '交通補助測試'
) AS direct_id \gset
SELECT public.submit_my_class_session(
  p_course_type => 'onsite_1_5hr', p_session_date => '2026-08-13', p_course_name => '李小華',
  p_duration_hours => 1.5, p_student_count => 1,
  p_transport_subsidy_requested => false, p_transport_distance_km => 30,
  p_term_period => NULL
) AS direct_no_subsidy_id \gset
SELECT public.submit_my_class_session(
  p_course_type => 'collab_lead', p_session_date => '2026-08-12', p_role_in_session => 'lead',
  p_duration_hours => 2, p_student_count => 18,
  p_term_period => 'semester', p_unit_name => '  【週二】再興魔方高手 入門班115上  ',
  p_materials_issued => '楓葉10'
) AS collab_id \gset
SELECT public.submit_my_class_session(
  p_course_type => 'camp', p_session_date => '2026-08-11', p_student_count => 8,
  p_unit_name => '【臺北A】中山 | 7/1~7/3 三日營'
) AS camp_id \gset
-- 舊前端的 10 個位置參數呼叫仍可用（直營課），新欄位走預設值
SELECT public.submit_my_class_session(
  'onsite_1_5hr', '2026-08-10', 'lead', '舊前端', '台北', 1.5, 2, NULL, NULL, NULL
) AS legacy_id \gset
-- 體驗課：migration 以議價模式種入報酬表，可回報、金額待核薪
SELECT public.submit_my_class_session(
  p_course_type => 'trial', p_session_date => '2026-08-09', p_course_name => '王小明 體驗',
  p_duration_hours => 1, p_student_count => 1
) AS trial_id \gset
RESET ROLE;

DO $$
DECLARE s record;
BEGIN
  SELECT * INTO s FROM public.class_sessions WHERE source = 'self_report' AND session_date = '2026-08-14';
  IF NOT s.transport_subsidy_requested OR s.transport_distance_km <> 12.4
     OR s.term_period IS NOT NULL OR s.unit_name IS NOT NULL OR s.materials_issued IS NOT NULL
     OR s.pricing_status <> 'quoted' OR s.base_salary <> 600 OR s.source <> 'self_report' THEN
    RAISE EXCEPTION 'direct submission wrong: %', row_to_json(s);
  END IF;

  SELECT * INTO s FROM public.class_sessions WHERE source = 'self_report' AND session_date = '2026-08-13';
  IF s.transport_subsidy_requested OR s.transport_distance_km IS NOT NULL THEN
    RAISE EXCEPTION 'requested=false must store NULL distance: %', row_to_json(s);
  END IF;

  SELECT * INTO s FROM public.class_sessions WHERE source = 'self_report' AND session_date = '2026-08-12';
  IF s.term_period <> 'semester' OR s.unit_name <> '【週二】再興魔方高手 入門班115上'
     OR s.materials_issued <> '楓葉10' OR s.transport_subsidy_requested OR s.transport_distance_km IS NOT NULL
     OR s.base_salary <> 1000 THEN
    RAISE EXCEPTION 'collab submission wrong: %', row_to_json(s);
  END IF;

  SELECT * INTO s FROM public.class_sessions WHERE source = 'self_report' AND session_date = '2026-08-11';
  IF s.unit_name <> '【臺北A】中山 | 7/1~7/3 三日營' OR s.term_period IS NOT NULL
     OR s.transport_subsidy_requested OR s.base_salary <> 3000 THEN
    RAISE EXCEPTION 'camp submission wrong: %', row_to_json(s);
  END IF;

  SELECT * INTO s FROM public.class_sessions WHERE source = 'self_report' AND session_date = '2026-08-10';
  IF s.transport_subsidy_requested OR s.transport_distance_km IS NOT NULL OR s.course_name <> '舊前端' THEN
    RAISE EXCEPTION 'legacy positional call wrong: %', row_to_json(s);
  END IF;

  SELECT * INTO s FROM public.class_sessions WHERE source = 'self_report' AND session_date = '2026-08-09';
  IF s.course_type <> 'trial' OR s.pricing_status <> 'needs_review' OR s.base_salary IS NOT NULL THEN
    RAISE EXCEPTION 'trial submission should be needs_review with no amount: %', row_to_json(s);
  END IF;
  IF (SELECT count(*) FROM public.salary_rate_card WHERE course_type = 'trial' AND effective_to IS NULL) <> 1 THEN
    RAISE EXCEPTION 'trial rate card row must exist exactly once after reruns';
  END IF;
END;
$$;
\echo PASS (e) direct (km 12.35 -> 12.4), direct requested=false (km forced NULL), collab, camp, trial(needs_review) each stored correctly; legacy 10-arg call still works

-- 資料表 CHECK 也擋得住繞過 RPC 的直接寫入（例如管理員後台）
DO $$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    UPDATE public.class_sessions SET transport_distance_km = 10 WHERE id = (
      SELECT id FROM public.class_sessions WHERE course_name = '李小華'
    );
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'distance without request accepted by table'; END IF;
  denied := false;
  BEGIN
    UPDATE public.class_sessions SET term_period = 'spring' WHERE course_name = '李小華';
  EXCEPTION WHEN check_violation THEN denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'invalid term_period accepted by table'; END IF;
END;
$$;
\echo PASS table CHECK constraints block distance-without-request and invalid term_period


-- (g) 2026-10-19：合作單位分寒暑假／學期間、期間文字照表單（migration 20261019220000）
--     先把暑假的文字改成管理員自訂，確認 migration 不覆寫；再連跑兩次
UPDATE public.salary_report_options SET label = '自訂暑假' WHERE kind = 'term_period' AND value = 'summer_break';
\ir ../supabase/migrations/20261019220000_partner_units_by_term_and_period_labels.sql
\ir ../supabase/migrations/20261019220000_partner_units_by_term_and_period_labels.sql
DO $$
DECLARE n_vac integer; n_sem integer; n_null integer; l_w text; l_s text; l_u text; n_sem_115 integer;
BEGIN
  SELECT count(*) FILTER (WHERE term_scope = 'vacation'),
         count(*) FILTER (WHERE term_scope = 'semester'),
         count(*) FILTER (WHERE term_scope IS NULL)
    INTO n_vac, n_sem, n_null
    FROM public.salary_report_options WHERE kind = 'partner_unit';
  SELECT count(*) INTO n_sem_115 FROM public.salary_report_options
   WHERE kind = 'partner_unit' AND value LIKE '%115上%' AND term_scope <> 'semester';
  SELECT label INTO l_w FROM public.salary_report_options WHERE kind = 'term_period' AND value = 'winter_break';
  SELECT label INTO l_s FROM public.salary_report_options WHERE kind = 'term_period' AND value = 'semester';
  SELECT label INTO l_u FROM public.salary_report_options WHERE kind = 'term_period' AND value = 'summer_break';
  IF n_vac <> 48 OR n_sem <> 30 OR n_null <> 0 OR n_sem_115 <> 0 THEN
    RAISE EXCEPTION 'term_scope backfill wrong: vacation=% semester=% null=% mis115=%', n_vac, n_sem, n_null, n_sem_115;
  END IF;
  IF l_w <> '寒假（改名）' OR l_s <> '115學年度上學期' OR l_u <> '自訂暑假' THEN
    RAISE EXCEPTION 'term_period labels wrong: % / % / %', l_w, l_s, l_u;
  END IF;
  IF (SELECT count(*) FROM public.salary_report_options WHERE kind <> 'partner_unit' AND term_scope IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'non partner rows got term_scope';
  END IF;
END;
$$;
\echo PASS (g) term_scope backfill 48/30, 115上 rows all semester, default period label updated, admin-renamed labels kept, migration idempotent

-- CHECK：合作單位沒有組別、或非合作單位帶組別，都會被擋
DO $$
BEGIN
  BEGIN
    INSERT INTO public.salary_report_options (kind, value, label, sort_order) VALUES ('partner_unit', '沒組別的單位', '沒組別的單位', 9990);
    RAISE EXCEPTION 'partner_unit without term_scope was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.salary_report_options (kind, value, label, sort_order, term_scope) VALUES ('partner_unit', '怪組別', '怪組別', 9991, 'weekend');
    RAISE EXCEPTION 'partner_unit with bad term_scope was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.salary_report_options (kind, value, label, sort_order, term_scope) VALUES ('camp_batch', '帶組別的梯次', '帶組別的梯次', 9992, 'vacation');
    RAISE EXCEPTION 'camp_batch with term_scope was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.salary_report_options (kind, value, label, sort_order, term_scope) VALUES ('partner_unit', '【新竹】新學期單位115下', '【新竹】新學期單位115下', 790, 'semester');
  DELETE FROM public.salary_report_options WHERE value = '【新竹】新學期單位115下';
END;
$$;
\echo PASS (h) term_scope CHECK blocks missing/invalid scope and scope on other kinds; valid insert works

-- ═══════════════════════════════════════════════════════════════════
-- 第二段：新建庫路徑（2025_salary_system.sql 已同步新欄位與選項表）
-- ═══════════════════════════════════════════════════════════════════
CREATE DATABASE salary_report_fresh;
\connect salary_report_fresh
\set QUIET on

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.instructor_role_enum AS ENUM ('S', 'A+', 'A', 'B', '實習');
CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);
CREATE TABLE public.instructors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid UNIQUE REFERENCES auth.users(id),
  full_name text NOT NULL,
  instructor_role public.instructor_role_enum,
  speed_qualification text,
  employment_status text DEFAULT 'active'
);

-- 由 verify-salary-report-form.mjs 傳入：2025_salary_system.sql 的副本（僅 month_label 改為一般欄位，見 mjs 註解）
\i :base_sql
\ir ../supabase/migrations/20260826105841_restore_salary_workflow.sql
\ir ../supabase/migrations/20261018120000_align_salary_report_with_forms.sql
\ir ../supabase/migrations/20261018120000_align_salary_report_with_forms.sql
\ir ../supabase/migrations/20261019220000_partner_units_by_term_and_period_labels.sql
\ir ../supabase/migrations/20261019220000_partner_units_by_term_and_period_labels.sql

INSERT INTO auth.users (id, email) VALUES ('00000000-0000-4000-8000-000000000001', 'teacher@test.local');
INSERT INTO public.users (id, name, email, role) VALUES ('00000000-0000-4000-8000-000000000001', '老師一', 'teacher@test.local', 'teacher');
INSERT INTO public.instructors (id, user_id, full_name, instructor_role) VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '老師一', 'A');
INSERT INTO public.salary_rate_card (course_type, instructor_role, pricing_mode, rate, effective_from)
VALUES ('collab_lead', 'A', 'hourly', 500, '2025-01-01');

SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', false) AS jwt_sub \gset
SELECT public.submit_my_class_session(
  p_course_type => 'collab_lead', p_session_date => '2026-08-12', p_duration_hours => 2,
  p_term_period => 'summer_break', p_unit_name => '【新竹】愛丁堡', p_materials_issued => '0'
) AS fresh_id \gset

DO $$
DECLARE n_constraints integer; n_proc integer; s record;
BEGIN
  SELECT count(*) INTO n_constraints FROM pg_constraint
   WHERE conrelid = 'public.class_sessions'::regclass
     AND conname IN ('class_sessions_term_period_check', 'class_sessions_unit_name_length_check',
                     'class_sessions_materials_issued_length_check', 'class_sessions_transport_distance_check');
  SELECT count(*) INTO n_proc FROM pg_proc WHERE proname = 'submit_my_class_session';
  SELECT * INTO s FROM public.class_sessions WHERE source = 'self_report' AND session_date = '2026-08-12';
  IF n_constraints <> 4 OR n_proc <> 1 OR (SELECT count(*) FROM public.salary_report_options) <> 112
     OR (SELECT count(*) FROM public.salary_report_options WHERE kind = 'partner_unit' AND term_scope = 'vacation') <> 48
     OR (SELECT count(*) FROM public.salary_report_options WHERE kind = 'partner_unit' AND term_scope = 'semester') <> 30
     OR s.term_period <> 'summer_break' OR s.unit_name <> '【新竹】愛丁堡' OR s.materials_issued <> '0' THEN
    RAISE EXCEPTION 'fresh base path wrong: constraints=% proc=% row=%', n_constraints, n_proc, row_to_json(s);
  END IF;
END;
$$;
\echo PASS fresh base path: 2025_salary_system.sql -> 20260826 -> 20261018 (x2) -> 20261019 (x2) works, 4 constraints, 1 RPC, 112 options (48 vacation / 30 semester)

\echo salary report form SQL verification passed
