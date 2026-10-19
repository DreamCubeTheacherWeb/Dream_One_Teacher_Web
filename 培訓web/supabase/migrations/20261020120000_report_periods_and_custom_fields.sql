-- ═══════════════════════════════════════════════════════════════════
-- 回報選項改「每個教學期間各一份清單」＋ 回報表單欄位可由管理員設定
--   業主 2026-10-20：「上面會有多個不同期間，像是2026寒假，然後下面就會出現對應的選單內容」
--   「整個報酬登記的地方也要可以設定欄位，新增或是刪除都要可以做到」；排序要能拖曳。
--   業主選定：每期各一份清單（新增期間時可複製上一期）、營隊梯次也掛在期間底下、
--   回報表單可加自訂欄位／隱藏非計酬欄位，算報酬用的欄位鎖住不給刪。
-- 依賴：20261018120000、20261019220000 已套用。
-- 上線順序：先套本 migration，再部署新前端。套完到部署前，舊前端照常可用（見各段說明）。
-- 本檔可重複執行。不刪任何既有資料。
--
-- 注意：本檔把 salary_report_options 的 UNIQUE (kind, value) 換成兩個部分唯一索引
--      （同一單位名稱可以出現在不同期間）。之後不要再重跑 20261018120000 的種子段
--      （它的 ON CONFLICT (kind, value) 已對不到唯一約束）。
-- ═══════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- A. 合作單位／營隊梯次掛到期間底下（period_id → 期間那一列）
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE public.salary_report_options
  ADD COLUMN IF NOT EXISTS period_id uuid REFERENCES public.salary_report_options(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.salary_report_options.period_id IS
  '合作單位與營隊梯次屬於哪個教學期間（指向 kind=term_period 的列）；期間本身為 NULL';
COMMENT ON COLUMN public.salary_report_options.term_scope IS
  '已停用（2026-10-20 起改用 period_id）。保留給套用 migration 到部署新前端之間的舊前端讀取，新資料一律為 NULL';

-- 舊的唯一約束：同 kind 不可同名。改成「期間代碼唯一」＋「同一期間內同 kind 不可同名」
ALTER TABLE public.salary_report_options DROP CONSTRAINT IF EXISTS salary_report_options_kind_value_key;
CREATE UNIQUE INDEX IF NOT EXISTS salary_report_options_period_value_key
  ON public.salary_report_options (value) WHERE kind = 'term_period';
CREATE UNIQUE INDEX IF NOT EXISTS salary_report_options_item_value_key
  ON public.salary_report_options (kind, period_id, value) WHERE period_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS salary_report_options_period_sort_idx
  ON public.salary_report_options (period_id, kind, sort_order);

-- term_scope CHECK 放寬：新資料一律 NULL；舊資料（合作單位）保留 vacation／semester
ALTER TABLE public.salary_report_options DROP CONSTRAINT IF EXISTS salary_report_options_term_scope_check;
ALTER TABLE public.salary_report_options
  ADD CONSTRAINT salary_report_options_term_scope_check
  CHECK (term_scope IS NULL OR (kind = 'partner_unit' AND term_scope IN ('vacation', 'semester')));

-- 回填：學期間清單 → 115學年度上學期；寒暑假清單 → 2026年寒假，並複製一份給 2026年暑假；營隊梯次 → 2026年暑假
DO $$
DECLARE
  v_winter uuid;
  v_semester uuid;
  v_summer uuid;
BEGIN
  SELECT id INTO v_winter   FROM public.salary_report_options WHERE kind = 'term_period' AND value = 'winter_break';
  SELECT id INTO v_semester FROM public.salary_report_options WHERE kind = 'term_period' AND value = 'semester';
  SELECT id INTO v_summer   FROM public.salary_report_options WHERE kind = 'term_period' AND value = 'summer_break';
  IF v_winter IS NULL OR v_semester IS NULL OR v_summer IS NULL THEN
    RAISE EXCEPTION '找不到 winter_break／semester／summer_break 三個期間，請先確認 20261018120000 已套用';
  END IF;

  UPDATE public.salary_report_options SET period_id = v_semester
   WHERE kind = 'partner_unit' AND period_id IS NULL AND term_scope = 'semester';
  UPDATE public.salary_report_options SET period_id = v_winter
   WHERE kind = 'partner_unit' AND period_id IS NULL AND (term_scope = 'vacation' OR term_scope IS NULL);

  -- 暑假原本和寒假共用同一份清單：只在暑假還沒有任何單位時複製一次（重跑不會再複製）。
  -- 複本 term_scope 為 NULL，舊前端依 term_scope 篩選時看不到它們，不會出現重複選項。
  IF NOT EXISTS (
    SELECT 1 FROM public.salary_report_options WHERE kind = 'partner_unit' AND period_id = v_summer
  ) THEN
    INSERT INTO public.salary_report_options (kind, value, label, sort_order, is_active, term_scope, period_id)
    SELECT 'partner_unit', src.value, src.label, src.sort_order, src.is_active, NULL, v_summer
      FROM public.salary_report_options src
     WHERE src.kind = 'partner_unit' AND src.period_id = v_winter AND src.term_scope = 'vacation';
  END IF;

  UPDATE public.salary_report_options SET period_id = v_summer
   WHERE kind = 'camp_batch' AND period_id IS NULL;
END;
$$;

-- 回填完才加：期間沒有 period_id；單位與梯次必須有
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.salary_report_options'::regclass
       AND conname = 'salary_report_options_period_check'
  ) THEN
    ALTER TABLE public.salary_report_options
      ADD CONSTRAINT salary_report_options_period_check
      CHECK (
        (kind = 'term_period' AND period_id IS NULL)
        OR (kind IN ('partner_unit', 'camp_batch') AND period_id IS NOT NULL)
      );
  END IF;
END;
$$;

-- period_id 只能指向期間列（CHECK 不能查別列，改用 trigger）
CREATE OR REPLACE FUNCTION public.guard_salary_report_option_period()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.period_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.salary_report_options p
     WHERE p.id = NEW.period_id AND p.kind = 'term_period'
  ) THEN
    RAISE EXCEPTION '所屬期間不存在' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_salary_report_option_period ON public.salary_report_options;
CREATE TRIGGER trg_salary_report_option_period
  BEFORE INSERT OR UPDATE OF period_id, kind ON public.salary_report_options
  FOR EACH ROW EXECUTE FUNCTION public.guard_salary_report_option_period();

COMMENT ON TABLE public.salary_report_options IS
  '站內課程回報的下拉選項：教學期間（term_period）各自帶一份合作單位與營隊梯次清單（period_id）；停用請改 is_active=false，不要刪除';

-- ───────────────────────────────────────────────────────────────────
-- B. 講師回報的期間不再限三個代碼（新增的期間有自己的代碼）；自訂欄位答案存 extra_fields
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE public.class_sessions DROP CONSTRAINT IF EXISTS class_sessions_term_period_check;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_term_period_length_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_term_period_length_check
      CHECK (term_period IS NULL OR char_length(term_period) BETWEEN 1 AND 200);
  END IF;
END;
$$;

ALTER TABLE public.class_sessions ADD COLUMN IF NOT EXISTS extra_fields jsonb;
COMMENT ON COLUMN public.class_sessions.extra_fields IS
  '講師回報時填的自訂欄位：{欄位代碼: {label: 當時的欄位名稱, value: 填的內容}}，名稱存快照，欄位日後改名或刪除舊紀錄仍看得懂';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_extra_fields_object_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_extra_fields_object_check
      CHECK (extra_fields IS NULL OR jsonb_typeof(extra_fields) = 'object');
  END IF;
END;
$$;

-- ───────────────────────────────────────────────────────────────────
-- C. 回報表單欄位設定（每個回報版面一份）
--   source：system＝算報酬用、鎖住（只能排序）；builtin＝內建、可隱藏；custom＝管理員新增、可改可刪
--   回報類別、上課日期、課程種類、報酬項目固定在表單最上面，不在此表。
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.salary_report_fields (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  layout      text NOT NULL CHECK (layout IN ('b2c_direct', 'b2b', 'b2c_camp', 'other')),
  field_key   text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  source      text NOT NULL CHECK (source IN ('system', 'builtin', 'custom')),
  label       text NOT NULL CHECK (btrim(label) <> '' AND char_length(label) <= 60),
  field_type  text NOT NULL DEFAULT 'text' CHECK (field_type IN ('text', 'textarea', 'number', 'select', 'boolean')),
  options     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 50),
  help_text   text CHECK (help_text IS NULL OR char_length(help_text) <= 200),
  is_required boolean NOT NULL DEFAULT false,
  is_visible  boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salary_report_fields_layout_key_key UNIQUE (layout, field_key),
  CONSTRAINT salary_report_fields_custom_key_check CHECK ((source = 'custom') = (field_key LIKE 'custom\_%')),
  CONSTRAINT salary_report_fields_system_visible_check CHECK (source <> 'system' OR is_visible),
  CONSTRAINT salary_report_fields_select_options_check CHECK (field_type <> 'select' OR jsonb_array_length(options) >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS salary_report_fields_custom_key_idx
  ON public.salary_report_fields (field_key) WHERE source = 'custom';
CREATE INDEX IF NOT EXISTS salary_report_fields_layout_sort_idx
  ON public.salary_report_fields (layout, sort_order);

COMMENT ON TABLE public.salary_report_fields IS
  '講師「登記課程回報」各版面的欄位設定：system 鎖住、builtin 可隱藏、custom 可新增刪除；自訂欄位答案存 class_sessions.extra_fields';

-- 內建／系統欄位不能刪、不能改名改型別；系統欄位不能隱藏；自訂欄位代碼與版面不可改
CREATE OR REPLACE FUNCTION public.guard_salary_report_field()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.source <> 'custom' THEN
      RAISE EXCEPTION '內建欄位不能刪除，可以改成隱藏' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- migration（沒有登入身分）才能種內建欄位；後台只能新增自訂欄位
    IF NEW.source <> 'custom' AND auth.uid() IS NOT NULL THEN
      RAISE EXCEPTION '只能新增自訂欄位' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.layout IS DISTINCT FROM OLD.layout
     OR NEW.field_key IS DISTINCT FROM OLD.field_key
     OR NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION '欄位的版面與代碼不能修改' USING ERRCODE = '42501';
  END IF;

  IF OLD.source <> 'custom' AND (
       NEW.label IS DISTINCT FROM OLD.label
       OR NEW.field_type IS DISTINCT FROM OLD.field_type
       OR NEW.options IS DISTINCT FROM OLD.options
       OR NEW.help_text IS DISTINCT FROM OLD.help_text
     ) THEN
    RAISE EXCEPTION '內建欄位只能調整排序、顯示與必填' USING ERRCODE = '42501';
  END IF;

  IF OLD.source = 'system' AND NEW.is_required IS DISTINCT FROM OLD.is_required THEN
    RAISE EXCEPTION '算報酬用的欄位不能改必填設定' USING ERRCODE = '42501';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_salary_report_field ON public.salary_report_fields;
CREATE TRIGGER trg_guard_salary_report_field
  BEFORE INSERT OR UPDATE OR DELETE ON public.salary_report_fields
  FOR EACH ROW EXECUTE FUNCTION public.guard_salary_report_field();

-- 種子：照目前回報頁的欄位與順序（對齊兩份 Google 表單，2026-10-19 第二版）
INSERT INTO public.salary_report_fields (layout, field_key, source, label, is_required, sort_order)
VALUES
  ('b2b',        'term_period', 'system',  '教學課程期間',       false, 10),
  ('b2b',        'unit',        'system',  '本次上課單位',       false, 20),
  ('b2b',        'hours',       'system',  '上課時數',           false, 30),
  ('b2b',        'students',    'system',  '本次上課人數',       false, 40),
  ('b2b',        'materials',   'builtin', '本次發出教材數量',   true,  50),
  ('b2b',        'incident',    'builtin', '特殊狀況或其他問題回報', false, 60),
  ('b2c_direct', 'course_name', 'builtin', '課程名稱',           true,  10),
  ('b2c_direct', 'hours',       'system',  '上課時數',           false, 20),
  ('b2c_direct', 'students',    'system',  '實際上課人數',       false, 30),
  ('b2c_direct', 'transport',   'builtin', '交通補助',           false, 40),
  ('b2c_direct', 'incident',    'builtin', '特殊狀況回饋',       false, 50),
  ('b2c_camp',   'camp_batch',  'system',  '營隊梯次',           false, 10),
  ('b2c_camp',   'students',    'system',  '上課人數',           false, 20),
  ('b2c_camp',   'transport',   'builtin', '交通補助',           false, 30),
  ('b2c_camp',   'incident',    'builtin', '特殊狀況回饋',       false, 40),
  ('other',      'role',        'system',  '角色',               false, 10),
  ('other',      'course_name', 'builtin', '課程名稱',           false, 20),
  ('other',      'hours',       'system',  '時數',               false, 30),
  ('other',      'students',    'system',  '人數',               false, 40),
  ('other',      'location',    'builtin', '地點',               false, 50),
  ('other',      'transport',   'builtin', '交通補助',           false, 60),
  ('other',      'self_review', 'builtin', '課程自評',           false, 70),
  ('other',      'progress',    'system',  '學習進度',           false, 80),
  ('other',      'incident',    'builtin', '特殊狀況回報',       false, 90)
ON CONFLICT (layout, field_key) DO NOTHING;

ALTER TABLE public.salary_report_fields ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_report_fields FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.salary_report_fields TO authenticated;

DROP POLICY IF EXISTS "Approved roles can view visible report fields" ON public.salary_report_fields;
CREATE POLICY "Approved roles can view visible report fields"
  ON public.salary_report_fields FOR SELECT TO authenticated
  USING (
    is_visible
    AND EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
    )
  );

DROP POLICY IF EXISTS "Admins can manage report fields" ON public.salary_report_fields;
CREATE POLICY "Admins can manage report fields"
  ON public.salary_report_fields FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'
    )
  );

-- ───────────────────────────────────────────────────────────────────
-- D. 拖曳排序：一次送整份清單的新順序，單一交易寫回（排序值 10、20、30…）
--    SECURITY INVOKER：照呼叫者身分走 RLS，函式內再擋非管理員
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reorder_salary_report_options(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_lists integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION '只有管理員可以調整排序' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION '排序清單不正確';
  END IF;
  IF cardinality(p_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_ids) AS x) THEN
    RAISE EXCEPTION '排序清單有重複項目';
  END IF;

  -- 只能排同一份清單（同一種類、同一期間）
  SELECT count(DISTINCT (o.kind, o.period_id)) INTO v_lists
    FROM public.salary_report_options o
   WHERE o.id = ANY (p_ids);
  IF v_lists <> 1 THEN
    RAISE EXCEPTION '一次只能排序同一份清單';
  END IF;

  UPDATE public.salary_report_options o
     SET sort_order = (t.ord * 10)::integer
    FROM unnest(p_ids) WITH ORDINALITY AS t(id, ord)
   WHERE o.id = t.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(p_ids) THEN
    RAISE EXCEPTION '清單已被其他人修改，請重新整理後再排序';
  END IF;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.reorder_salary_report_fields(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_layouts integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION '只有管理員可以調整排序' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 OR cardinality(p_ids) > 200 THEN
    RAISE EXCEPTION '排序清單不正確';
  END IF;
  IF cardinality(p_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_ids) AS x) THEN
    RAISE EXCEPTION '排序清單有重複項目';
  END IF;

  SELECT count(DISTINCT f.layout) INTO v_layouts
    FROM public.salary_report_fields f
   WHERE f.id = ANY (p_ids);
  IF v_layouts <> 1 THEN
    RAISE EXCEPTION '一次只能排序同一個版面的欄位';
  END IF;

  UPDATE public.salary_report_fields f
     SET sort_order = (t.ord * 10)::integer
    FROM unnest(p_ids) WITH ORDINALITY AS t(id, ord)
   WHERE f.id = t.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> cardinality(p_ids) THEN
    RAISE EXCEPTION '欄位已被其他人修改，請重新整理後再排序';
  END IF;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reorder_salary_report_options(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reorder_salary_report_fields(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reorder_salary_report_options(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_salary_report_fields(uuid[]) TO authenticated;

-- ───────────────────────────────────────────────────────────────────
-- E. 講師送出回報：期間改查選項表（啟用中的期間才可選）、加自訂欄位答案 p_extra_fields
--    同名多載會讓 PostgREST 呼叫歧義，先移除 15 參數舊版。新參數有預設值，
--    舊前端（具名呼叫、不帶 p_extra_fields）在部署前仍可正常送出。
--    其餘內容與 20261018120000 版相同。
-- ───────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text, text, text, text, boolean, numeric);

CREATE OR REPLACE FUNCTION public.submit_my_class_session(
  p_course_type text,
  p_session_date date,
  p_role_in_session text DEFAULT 'lead',
  p_course_name text DEFAULT NULL,
  p_location text DEFAULT NULL,
  p_duration_hours numeric DEFAULT NULL,
  p_student_count integer DEFAULT NULL,
  p_self_review text DEFAULT NULL,
  p_progress_note text DEFAULT NULL,
  p_incident_report text DEFAULT NULL,
  p_term_period text DEFAULT NULL,
  p_unit_name text DEFAULT NULL,
  p_materials_issued text DEFAULT NULL,
  p_transport_subsidy_requested boolean DEFAULT false,
  p_transport_distance_km numeric DEFAULT NULL,
  p_extra_fields jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_instructor public.instructors%ROWTYPE;
  v_quote record;
  v_session_id uuid;
  v_registered_name text;
  v_user_role text;
  v_term_period text := NULLIF(btrim(p_term_period), '');
  v_unit_name text := NULLIF(btrim(p_unit_name), '');
  v_materials_issued text := NULLIF(btrim(p_materials_issued), '');
  v_transport_requested boolean := COALESCE(p_transport_subsidy_requested, false);
  v_transport_distance numeric(6,1);
  v_is_collab boolean;
  v_is_camp boolean;
  v_extra jsonb := NULL;
  v_entry record;
  v_field_label text;
  v_answer_text text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '請先登入後再試' USING ERRCODE = '42501';
  END IF;

  SELECT role::text INTO v_user_role
    FROM public.users
   WHERE id = auth.uid();

  IF v_user_role IS NULL OR v_user_role NOT IN ('teacher', 'mentor', 'admin') THEN
    RAISE EXCEPTION '僅限已通過審核的講師或工作人員使用' USING ERRCODE = '42501';
  END IF;

  IF p_course_type IS NULL OR btrim(p_course_type) = '' OR p_session_date IS NULL THEN
    RAISE EXCEPTION 'Course type and session date are required';
  END IF;

  IF p_session_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date THEN
    RAISE EXCEPTION '請在課程結束後再回報，日期不能晚於今天';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.salary_rate_card WHERE course_type = p_course_type
  ) THEN
    RAISE EXCEPTION '不支援的課程類型';
  END IF;

  IF p_duration_hours IS NOT NULL AND (p_duration_hours <= 0 OR p_duration_hours > 24) THEN
    RAISE EXCEPTION '時數必須大於 0 且不得超過 24 小時';
  END IF;

  IF p_student_count IS NOT NULL AND (p_student_count < 1 OR p_student_count > 999) THEN
    RAISE EXCEPTION '人數必須介於 1 至 999 人';
  END IF;

  IF char_length(COALESCE(p_course_name, '')) > 160
     OR char_length(COALESCE(p_location, '')) > 160
     OR char_length(COALESCE(p_self_review, '')) > 4000
     OR char_length(COALESCE(p_progress_note, '')) > 4000
     OR char_length(COALESCE(p_incident_report, '')) > 4000 THEN
    RAISE EXCEPTION '回報內容超過允許長度';
  END IF;

  IF p_course_type IN ('regular_basic', 'regular_advanced')
     AND NULLIF(btrim(p_progress_note), '') IS NULL THEN
    RAISE EXCEPTION '常態課請填寫學習進度';
  END IF;

  -- 教學課程期間：必須是選項表裡啟用中的期間（期間可由管理員新增，不再寫死三個代碼）
  IF v_term_period IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.salary_report_options o
     WHERE o.kind = 'term_period' AND o.value = v_term_period AND o.is_active
  ) THEN
    RAISE EXCEPTION '教學課程期間不正確或已停用，請重新整理頁面後再選一次';
  END IF;

  IF char_length(COALESCE(v_unit_name, '')) > 200
     OR char_length(COALESCE(v_materials_issued, '')) > 200 THEN
    RAISE EXCEPTION '上課單位／營隊梯次或教材數量不得超過 200 字';
  END IF;

  IF v_transport_requested THEN
    IF p_transport_distance_km IS NULL THEN
      RAISE EXCEPTION '申請交通補助請填寫單趟公里數';
    END IF;
    v_transport_distance := round(p_transport_distance_km, 1);
    IF v_transport_distance <= 0 OR v_transport_distance > 500 THEN
      RAISE EXCEPTION '單趟公里數必須大於 0 且不超過 500 公里';
    END IF;
  ELSE
    v_transport_distance := NULL;
  END IF;

  v_is_collab := p_course_type LIKE 'collab\_%' ESCAPE '\';
  v_is_camp := p_course_type IN ('camp', 'speed_camp')
    OR p_course_type LIKE 'camp\_director\_%' ESCAPE '\';

  IF v_is_collab AND v_term_period IS NULL THEN
    RAISE EXCEPTION '合作課程請選擇教學課程期間';
  END IF;

  IF v_is_collab AND v_unit_name IS NULL THEN
    RAISE EXCEPTION '合作課程請選擇本次上課單位';
  END IF;

  IF v_is_camp AND v_unit_name IS NULL THEN
    RAISE EXCEPTION '營隊課程請選擇營隊梯次';
  END IF;

  -- 自訂欄位：只收顯示中的自訂欄位；欄位名稱以資料庫為準存快照（不信任前端送來的名稱）
  IF p_extra_fields IS NOT NULL AND jsonb_typeof(p_extra_fields) <> 'null' THEN
    IF jsonb_typeof(p_extra_fields) <> 'object' THEN
      RAISE EXCEPTION '自訂欄位格式不正確';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_extra_fields)) > 30 THEN
      RAISE EXCEPTION '自訂欄位數量過多';
    END IF;
    FOR v_entry IN SELECT key, value FROM jsonb_each(p_extra_fields) LOOP
      IF jsonb_typeof(v_entry.value) NOT IN ('string', 'number', 'boolean', 'null') THEN
        RAISE EXCEPTION '自訂欄位「%」的內容格式不正確', v_entry.key;
      END IF;
      CONTINUE WHEN jsonb_typeof(v_entry.value) = 'null'
        OR (jsonb_typeof(v_entry.value) = 'string' AND btrim(v_entry.value #>> '{}') = '');
      v_answer_text := v_entry.value #>> '{}';
      IF char_length(v_answer_text) > 2000 THEN
        RAISE EXCEPTION '自訂欄位內容不得超過 2000 字';
      END IF;
      SELECT f.label INTO v_field_label
        FROM public.salary_report_fields f
       WHERE f.field_key = v_entry.key AND f.source = 'custom' AND f.is_visible
       LIMIT 1;
      IF v_field_label IS NULL THEN
        RAISE EXCEPTION '回報表單的欄位已更新，請重新整理頁面後再送出';
      END IF;
      v_extra := COALESCE(v_extra, '{}'::jsonb)
        || jsonb_build_object(v_entry.key, jsonb_build_object(
             'label', v_field_label,
             'value', CASE WHEN jsonb_typeof(v_entry.value) = 'string'
                           THEN to_jsonb(btrim(v_answer_text))
                           ELSE v_entry.value END
           ));
    END LOOP;
  END IF;

  SELECT * INTO v_instructor
    FROM public.instructors
   WHERE user_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instructor profile not found';
  END IF;

  IF v_instructor.employment_status IN ('frozen', 'cancelled') THEN
    RAISE EXCEPTION '您目前無法送出課程回報，請聯絡管理員' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_quote
    FROM public.quote_salary(
      v_instructor.id,
      p_course_type,
      p_session_date,
      p_role_in_session,
      p_duration_hours,
      p_student_count
    );

  SELECT COALESCE(NULLIF(name, ''), email)
    INTO v_registered_name
    FROM public.users
   WHERE id = auth.uid();

  INSERT INTO public.class_sessions (
    instructor_id,
    instructor_name,
    instructor_role_at_time,
    speed_qualification_at_time,
    course_type,
    course_name,
    location,
    session_date,
    role_in_session,
    duration_hours,
    student_count,
    pricing_mode,
    rate_card_id,
    pricing_basis,
    pricing_label,
    applied_rate,
    base_salary,
    pricing_status,
    pricing_message,
    pricing_quoted_at,
    status,
    registered_by,
    registered_by_name,
    self_review,
    progress_note,
    incident_report,
    term_period,
    unit_name,
    materials_issued,
    transport_subsidy_requested,
    transport_distance_km,
    extra_fields,
    source
  ) VALUES (
    v_instructor.id,
    v_instructor.full_name,
    v_instructor.instructor_role::text,
    v_instructor.speed_qualification,
    p_course_type,
    NULLIF(btrim(p_course_name), ''),
    NULLIF(btrim(p_location), ''),
    p_session_date,
    p_role_in_session::public.session_role_enum,
    p_duration_hours,
    p_student_count,
    v_quote.pricing_mode::public.pricing_mode_enum,
    v_quote.rate_card_id,
    v_quote.pricing_basis,
    v_quote.pricing_label,
    v_quote.applied_rate,
    v_quote.base_salary,
    CASE WHEN v_quote.needs_review THEN 'needs_review' ELSE 'quoted' END,
    v_quote.message,
    now(),
    'pending',
    auth.uid(),
    v_registered_name,
    NULLIF(btrim(p_self_review), ''),
    NULLIF(btrim(p_progress_note), ''),
    NULLIF(btrim(p_incident_report), ''),
    v_term_period,
    v_unit_name,
    v_materials_issued,
    v_transport_requested,
    v_transport_distance,
    v_extra,
    'self_report'
  )
  RETURNING id INTO v_session_id;

  RETURN v_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text, text, text, text, boolean, numeric, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text, text, text, text, boolean, numeric, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text, text, text, text, boolean, numeric, jsonb) TO authenticated;
