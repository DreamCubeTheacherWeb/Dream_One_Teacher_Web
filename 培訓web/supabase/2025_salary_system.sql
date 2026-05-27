-- ═══════════════════════════════════════════════════════════════════
-- 薪資系統 Schema Migration
--
-- 設計重點:
--   1. salary_rate_card — 報酬表,版本化,管理員可調
--   2. class_sessions   — 每場課一筆(主講 / 助教各自一筆),含薪資、狀態、異常
--   3. class_series     — 系列課(可選,把多場 sessions 群組)
--   4. instructor_salary_summary (VIEW) — 講師看自己薪資頁的聚合查詢
--
-- 跑法:Supabase SQL Editor,分 A → B → C → D → E 五段
-- ═══════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────
-- A. ENUM 類型
-- ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE session_status_enum AS ENUM (
    'pending',   -- 待核准(預留給未來自動排課用)
    'approved',  -- 已核准(管理員手動登記預設值)
    'paid'       -- 已付款
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE pricing_mode_enum AS ENUM (
    'hourly',       -- 時薪 × 時數
    'per_session',  -- 一節固定費 × 節數
    'fixed',        -- 整場固定金額(如營隊負責人)
    'negotiable'    -- 自由金額(如合作課程專案)
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE session_role_enum AS ENUM (
    'lead',         -- 主講
    'assistant',    -- 助教
    'head_judge',   -- 主裁判
    'sub_judge',    -- 助理裁判
    'counter',      -- 櫃台人員
    'project_lead', -- 營隊負責人
    'other'         -- 其他
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ──────────────────────────────────────────────────────────────────
-- B. salary_rate_card — 報酬表(版本化)
-- ──────────────────────────────────────────────────────────────────
-- 一筆代表「某課程類型 × 某等級 × 某時數 × 某人數區間」的單價
-- 計薪時依 effective_from / effective_to 找出當下生效那一筆

CREATE TABLE IF NOT EXISTS public.salary_rate_card (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 報酬表的「橫軸」
  course_type     text NOT NULL,                   -- 例 '實體教室常態課程_初階'、'到府課程_1.5hr'
  instructor_role text,                            -- S/A+/A/B/實習,或 '速解大師'/'基礎速解講師',null = 不分等級
  duration_hours  numeric(4,2),                    -- 1.5, 2, 8...; null = 不論時數
  student_count_min int,                           -- 1, 4, 5...; null = 不論人數
  student_count_max int,                           -- inclusive,如 8 表示「7 或 8 人」

  -- 計薪規則
  pricing_mode    pricing_mode_enum NOT NULL,
  rate            numeric(10,2),                   -- 時薪 / 場次費 / 固定金額;negotiable 可為 null

  -- 版本控制
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,                            -- null 表示目前生效

  note            text,
  created_at      timestamptz DEFAULT now() NOT NULL,
  created_by      uuid REFERENCES auth.users
);

CREATE INDEX IF NOT EXISTS idx_rate_card_lookup
  ON public.salary_rate_card (course_type, instructor_role, effective_from);

ALTER TABLE public.salary_rate_card ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Everyone authenticated can view rate card"
  ON public.salary_rate_card FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage rate card"
  ON public.salary_rate_card FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────
-- C. class_series — 系列課(可選)
-- ──────────────────────────────────────────────────────────────────
-- 例:「2025 春季 OO 國小週二班」這種一個系列下多個 session 的情境
-- 若是單堂課,可不設,直接建 class_sessions

CREATE TABLE IF NOT EXISTS public.class_series (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  name          text NOT NULL,
  location      text,
  organization  text,                 -- 合作學校/單位
  start_date    date,
  end_date      date,
  notes         text,
  created_by    uuid REFERENCES auth.users,
  created_at    timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE public.class_series ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view series"
  ON public.class_series FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins manage series"
  ON public.class_series FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));


-- ──────────────────────────────────────────────────────────────────
-- D. class_sessions — 每場課一筆(主講 / 助教各自一筆)
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.class_sessions (
  id                uuid DEFAULT gen_random_uuid() PRIMARY KEY,

  -- 課程歸屬
  series_id         uuid REFERENCES public.class_series(id) ON DELETE SET NULL,
  course_type       text NOT NULL,
  course_name       text,
  location          text,

  -- 講師
  instructor_id     uuid REFERENCES public.instructors(id) ON DELETE SET NULL,
  instructor_name   text NOT NULL,        -- 冗餘:歷史匯入時 instructor_id 可能對不到,留姓名作為 fallback
  role_in_session   session_role_enum DEFAULT 'lead',
  instructor_role_at_time text,           -- 當時等級(S/A+/A/B/實習...)歷史用
  -- 為什麼留 instructor_role_at_time:講師升等了之後,歷史薪資不能改用新等級重算

  -- 時間
  session_date      date NOT NULL,
  month_label       text GENERATED ALWAYS AS (to_char(session_date, 'YYYY/MM')) STORED,
  -- month_label 是衍生欄位,方便月份篩選查詢加 index

  duration_hours    numeric(5,2),
  student_count     int,

  -- 薪資
  pricing_mode      pricing_mode_enum,
  rate_card_id      uuid REFERENCES public.salary_rate_card(id) ON DELETE SET NULL,
  base_salary       numeric(10,2) DEFAULT 0,
  bonus             numeric(10,2) DEFAULT 0,
  total_salary      numeric(10,2) GENERATED ALWAYS AS (COALESCE(base_salary, 0) + COALESCE(bonus, 0)) STORED,
  paid_amount       numeric(10,2) DEFAULT 0,

  -- 狀態
  status            session_status_enum DEFAULT 'approved',
  approved_by       uuid REFERENCES auth.users,
  approved_at       timestamptz,
  paid_at           timestamptz,

  -- 登記人
  registered_by     uuid REFERENCES auth.users,
  registered_by_name text,

  -- 講師回報
  self_review       text,    -- 課程自評
  progress_note     text,    -- 學習進度(常態課必填)
  incident_report   text,    -- 特殊狀況回報
  notes             text,    -- 一般備註

  -- 異常標記
  is_anomaly        boolean DEFAULT false,
  anomaly_reasons   text[] DEFAULT '{}',

  -- 來源
  source            text DEFAULT 'manual',  -- 'manual' / 'historical_import' / 'auto_scheduled'

  created_at        timestamptz DEFAULT now() NOT NULL,
  updated_at        timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_instructor ON public.class_sessions (instructor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_date ON public.class_sessions (session_date DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_month ON public.class_sessions (month_label);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON public.class_sessions (status);
CREATE INDEX IF NOT EXISTS idx_sessions_anomaly ON public.class_sessions (is_anomaly) WHERE is_anomaly = true;

-- updated_at 自動更新
CREATE OR REPLACE FUNCTION set_class_sessions_updated_at()
RETURNS trigger AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_class_sessions_updated_at ON public.class_sessions;
CREATE TRIGGER trg_class_sessions_updated_at
  BEFORE UPDATE ON public.class_sessions
  FOR EACH ROW EXECUTE FUNCTION set_class_sessions_updated_at();

ALTER TABLE public.class_sessions ENABLE ROW LEVEL SECURITY;

-- 講師看自己的
CREATE POLICY "Instructors view own sessions"
  ON public.class_sessions FOR SELECT
  USING (
    instructor_id IN (
      SELECT id FROM public.instructors WHERE user_id = auth.uid()
    )
  );

-- 管理員/mentor 可以做任何事
CREATE POLICY "Admins manage all sessions"
  ON public.class_sessions FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','mentor'))
  );


-- ──────────────────────────────────────────────────────────────────
-- E. VIEW:講師薪資總覽(給講師頁用)
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.instructor_salary_summary AS
SELECT
  i.id AS instructor_id,
  i.user_id,
  i.full_name,

  -- 累計
  count(s.id) AS total_sessions,
  COALESCE(sum(s.duration_hours), 0) AS total_hours,
  COALESCE(sum(s.total_salary), 0) AS total_salary,
  COALESCE(sum(s.paid_amount), 0) AS total_paid,
  COALESCE(sum(s.total_salary) - sum(s.paid_amount), 0) AS total_unpaid,

  -- 本月
  count(s.id) FILTER (
    WHERE s.month_label = to_char(now(), 'YYYY/MM')
  ) AS this_month_sessions,
  COALESCE(sum(s.total_salary) FILTER (
    WHERE s.month_label = to_char(now(), 'YYYY/MM')
  ), 0) AS this_month_salary,

  -- 今年
  COALESCE(sum(s.total_salary) FILTER (
    WHERE EXTRACT(YEAR FROM s.session_date) = EXTRACT(YEAR FROM now())
  ), 0) AS this_year_salary,

  -- 分桶
  COALESCE(sum(s.total_salary) FILTER (WHERE s.status = 'pending'), 0) AS pending_salary,
  COALESCE(sum(s.total_salary) FILTER (WHERE s.status = 'approved'), 0) AS approved_unpaid_salary,
  COALESCE(sum(s.total_salary) FILTER (WHERE s.status = 'paid'), 0) AS paid_salary
FROM public.instructors i
LEFT JOIN public.class_sessions s ON s.instructor_id = i.id
GROUP BY i.id, i.user_id, i.full_name;

-- View 的權限直接繼承底層表的 RLS,所以講師只看得到自己的


-- ──────────────────────────────────────────────────────────────────
-- F. 異常偵測:寫個 function,新增/更新 session 時自動標記
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.detect_session_anomaly()
RETURNS trigger AS $$
DECLARE
  reasons text[] := '{}';
  duplicate_count int;
BEGIN
  -- 規則 1:同講師同日期同課程名(可能重複登記)
  IF NEW.instructor_id IS NOT NULL AND NEW.course_name IS NOT NULL THEN
    SELECT count(*) INTO duplicate_count
    FROM public.class_sessions
    WHERE instructor_id = NEW.instructor_id
      AND session_date = NEW.session_date
      AND course_name = NEW.course_name
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid);
    IF duplicate_count > 0 THEN
      reasons := array_append(reasons, '同講師同日同課程名可能重複');
    END IF;
  END IF;

  -- 規則 2:月份在 2020 之前
  IF NEW.session_date < DATE '2020-01-01' THEN
    reasons := array_append(reasons, '日期早於 2020 年');
  END IF;

  -- 規則 3:日期晚於當月底 + 1 個月(預排允許,過遠就警示)
  IF NEW.session_date > (CURRENT_DATE + INTERVAL '2 months')::date THEN
    reasons := array_append(reasons, '日期超過 2 個月後');
  END IF;

  -- 規則 4:薪資 0 但時數 > 0(可能漏填)
  IF COALESCE(NEW.duration_hours, 0) > 0
     AND COALESCE(NEW.base_salary, 0) = 0
     AND COALESCE(NEW.bonus, 0) = 0 THEN
    reasons := array_append(reasons, '有時數但薪資為 0');
  END IF;

  NEW.is_anomaly := cardinality(reasons) > 0;
  NEW.anomaly_reasons := reasons;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_session_anomaly ON public.class_sessions;
CREATE TRIGGER trg_session_anomaly
  BEFORE INSERT OR UPDATE ON public.class_sessions
  FOR EACH ROW EXECUTE FUNCTION public.detect_session_anomaly();


-- ═══════════════════════════════════════════════════════════════════
-- 驗證查詢
-- ═══════════════════════════════════════════════════════════════════
-- 跑完後可以執行:
--
-- SELECT count(*) FROM public.class_sessions;       -- 0
-- SELECT count(*) FROM public.salary_rate_card;     -- 0(下一步再灌報酬表)
-- SELECT * FROM public.instructor_salary_summary LIMIT 3;
