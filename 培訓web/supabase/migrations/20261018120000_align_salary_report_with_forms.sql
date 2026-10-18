-- ═══════════════════════════════════════════════════════════════════
-- 站內課程回報對齊兩份 Google 課後回報表單
--   A. B2B 合作單位課程 課後回報單：教學課程期間、上課單位、發出教材數量
--   B. 二處 B2C 直營／營隊：交通補助（單趟公里數）、營隊梯次
--
-- 依賴：20260826105841_restore_salary_workflow.sql（quote_salary、
--       submit_my_class_session 舊簽章與定價快照欄位）已套用。
-- 上線順序：先套用本 migration，再部署會傳新參數的前端。
-- 本檔可重複執行（全部使用 IF NOT EXISTS／DROP IF EXISTS／ON CONFLICT）。
-- ═══════════════════════════════════════════════════════════════════

-- A. class_sessions 新增回報欄位（全部可為 NULL；交通補助預設 false）
ALTER TABLE public.class_sessions
  ADD COLUMN IF NOT EXISTS term_period text,
  ADD COLUMN IF NOT EXISTS unit_name text,
  ADD COLUMN IF NOT EXISTS materials_issued text,
  ADD COLUMN IF NOT EXISTS transport_subsidy_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS transport_distance_km numeric(6,1);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_term_period_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_term_period_check
      CHECK (term_period IS NULL OR term_period IN ('winter_break', 'semester', 'summer_break'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_unit_name_length_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_unit_name_length_check
      CHECK (unit_name IS NULL OR char_length(unit_name) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_materials_issued_length_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_materials_issued_length_check
      CHECK (materials_issued IS NULL OR char_length(materials_issued) <= 200);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_transport_distance_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_transport_distance_check
      CHECK (
        (transport_distance_km IS NULL OR (transport_distance_km > 0 AND transport_distance_km <= 500))
        AND (transport_subsidy_requested OR transport_distance_km IS NULL)
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.class_sessions.term_period IS
  '教學課程期間（合作課）：winter_break=寒假、semester=學期間、summer_break=暑假';
COMMENT ON COLUMN public.class_sessions.unit_name IS
  '合作課＝本次上課單位名稱；營隊＝營隊梯次。選項來自 salary_report_options，選「其它」時為講師自填文字';
COMMENT ON COLUMN public.class_sessions.materials_issued IS
  '本次發出教材數量（合作課），講師自填「項目簡稱＋數字」，例：楓葉10；無則 0';
COMMENT ON COLUMN public.class_sessions.transport_subsidy_requested IS
  '直營課是否申請交通補助';
COMMENT ON COLUMN public.class_sessions.transport_distance_km IS
  '申請交通補助的單趟公里數（0 < x <= 500）；未申請時必為 NULL';


-- B. 課後回報下拉選項（教學期間、合作單位、營隊梯次）；管理員維護、講師唯讀
CREATE TABLE IF NOT EXISTS public.salary_report_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('term_period', 'partner_unit', 'camp_batch')),
  value       text NOT NULL CHECK (NULLIF(btrim(value), '') IS NOT NULL AND char_length(value) <= 200),
  label       text NOT NULL CHECK (NULLIF(btrim(label), '') IS NOT NULL AND char_length(label) <= 200),
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT salary_report_options_kind_value_key UNIQUE (kind, value)
);

COMMENT ON TABLE public.salary_report_options IS
  '站內課程回報的下拉選項（對齊 Google 課後回報表單）；停用選項請改 is_active=false，不要刪除';

CREATE INDEX IF NOT EXISTS salary_report_options_kind_sort_idx
  ON public.salary_report_options (kind, sort_order);

ALTER TABLE public.salary_report_options ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.salary_report_options FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.salary_report_options TO authenticated;

DROP POLICY IF EXISTS "Authenticated can view active salary report options" ON public.salary_report_options;
CREATE POLICY "Authenticated can view active salary report options"
  ON public.salary_report_options FOR SELECT TO authenticated
  USING (is_active = true);

DROP POLICY IF EXISTS "Admins can manage salary report options" ON public.salary_report_options;
CREATE POLICY "Admins can manage salary report options"
  ON public.salary_report_options FOR ALL TO authenticated
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

-- 種子：已存在（含管理員改過 label／停用者）一律不覆寫
INSERT INTO public.salary_report_options (kind, value, label, sort_order) VALUES
  ('term_period', 'winter_break', '寒假', 10),
  ('term_period', 'semester', '學期間', 20),
  ('term_period', 'summer_break', '暑假', 30)
ON CONFLICT (kind, value) DO NOTHING;

-- 合作單位：先寒暑假清單，再接學期間清單（表單中的分隔列不入庫）
INSERT INTO public.salary_report_options (kind, value, label, sort_order)
SELECT 'partner_unit', item.value, item.value, (item.ordinality * 10)::integer
  FROM unnest(ARRAY[
    '【基隆】三之三立敏分校',
    '【臺北】華視文教基金會',
    '【臺北】靜心小學 初階A班(1)(2) / 進階班 / 初階B班',
    '【臺北】志清國小暑假營',
    '【臺北】銘傳國小暑假營',
    '【臺北】明音奧福文理補習班 中低年 / 高年',
    '【臺北】臺北內湖上榜文理',
    '【臺北】愛蒂莫樂高遊 大直店 / 天母店',
    '【臺北】力捷文理',
    '【臺北】新生國小',
    '【臺北】十大安親班',
    '【臺北】北市樂齡示範',
    '【臺北】菓子樹教室',
    '【臺北】私立中山國小社團',
    '【新北】倍思學院 七月初學、進階 / 八月初學、進階',
    '【新北】青山康橋魔術方塊營 基礎班第一、二梯 / 進階班',
    '【新北】林口康橋魔方桌遊營 基礎班 / 進階班',
    '【新北】何嘉仁得和分校 A、B、C、D梯',
    '【新北】三之三林口校 初階',
    '【新北】竹林中小學 竹林 / 中和校區',
    '【新北】鵬展教育中心 天母 / 文山',
    '【新北】昊一美語',
    '【新北】大漢學園',
    '【桃園】群揚補習班 初階班 / 魔方三階班',
    '【桃園】晨曦文理',
    '【桃園】文青跆拳道館',
    '【新竹】新竹康橋暑期營隊 初階A、B班 / 進階A、B班',
    '【新竹】康乃薾中小學 G3-6 / G1-2 / 幼兒園A、B、C',
    '【新竹】菁采共學嘉豐校',
    '【新竹】新竹縣私立心禾苗文理',
    '【新竹】華聖頓縣政校',
    '【新竹】愛丁堡',
    '【新竹】謙鋮補習班(牽牽學習成長空間) 魔術方塊班',
    '【新竹】HAPPY KIDS',
    '【新竹】沐禾日和生活空間',
    '【苗栗】竹南山佳國小',
    '【苗栗】Live互動美語頭份建國分校 A、B班',
    '【苗栗】長頸鹿六合分校',
    '【臺中】山海屯聲暉協進會',
    '【臺中】鹿陽國小ESL課輔班',
    '【南投】南投縣竹山鎮中州國民小學(A、B組)',
    '【南投】普台國民小學',
    '【嘉義】嘉義貝斯特課照中心',
    '【嘉義】龍興武道館',
    '【臺南】樹谷生活科學館',
    '【臺南】格上斌圍棋',
    '【高雄】超優教育楠梓分校 週三班 / 週四班',
    '【宜蘭】何嘉仁羅東校 A班 / B班',
    '【週二】再興魔方高手 入門班115上',
    '【週三】再興魔方高手 進階班115上',
    '【週一】蓁凱寧文理115上',
    '【週二】青山康橋115上課間 低 / 中年級',
    '【週二】林口康橋115上課間 高年級',
    '【週二】格致中學115上魔方社國一、二、三班',
    '【週三】林口康橋115上課間 低、中年級A',
    '【週三】林口康橋115上課間 低、中年級B',
    '【週三】林口康橋115上課後 基礎班',
    '【週三】崇光高中115上課間社團',
    '【週四】青山康橋115上課間 高年級',
    '【週四】林口康橋115上課後 進階班',
    '【週四】康軒幼兒園115上空間邏輯魔數班',
    '【週一】華聖頓縣政校115上',
    '【週二】康乃薾115上魔術方塊 初階班',
    '【週二】新竹康橋115上課間 國中部',
    '【週三】弋果美語科園校115上基礎班',
    '【週三】HAPPY KIDS - 115上',
    '【週三】新竹康橋115上課間 低、中、高年。基礎',
    '【週三】新竹康橋115上課間 低、中、高年。進階',
    '【週三】新竹康橋115上課後 基礎、進階A、B',
    '【週三】曙光女中國中部115上魔方社',
    '【週四】康乃薾115上魔術方塊 進階班',
    '【週五】南瓜田幼兒園2026下半年',
    '【週末】沐禾日和生活空間',
    '【臺中 週四】明道中學魔方社115上國一/國二班',
    '【嘉義 週五】民族國小115上魔方社',
    '【臺南 週一】後甲國中魔方社115上',
    '【高雄 週日】高雄圓道禪院115上初學班',
    '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動'
  ]::text[]) WITH ORDINALITY AS item(value, ordinality)
ON CONFLICT (kind, value) DO NOTHING;

-- 寒暑假營隊梯次
INSERT INTO public.salary_report_options (kind, value, label, sort_order)
SELECT 'camp_batch', item.value, item.value, (item.ordinality * 10)::integer
  FROM unnest(ARRAY[
    '【臺北A】中山 | 7/1~7/3 三日營',
    '【臺北B】中正 | 7/4~7/5 二日營',
    '【臺北C】中山 | 7/13~7/17 五日營',
    '【臺北D】大安 | 7/18~7/19 二日營',
    '【臺北E】松山 | 7/27~7/31 五日營',
    '【臺北F】中山 | 8/1~8/2 二日營',
    '【臺北G】大同 | 8/10~8/14 五日營',
    '【臺北H】中正 | 8/15~8/16 速解營',
    '【新北C】新店 | 7/13~7/17 五日營',
    '【新北D】林口 | 7/18~7/19 二日營',
    '【新北F】永和 | 8/1~8/2 二日營',
    '【新北G】新店 | 8/10~8/14 五日營',
    '【新北I】新店 | 8/24~8/25 啟蒙營',
    '【新北J】新店 | 8/17~8/21 啟蒙營',
    '【桃園I】桃園 | 8/22~8/23 二日營',
    '【新竹A】竹北 | 7/1~7/3 三日營',
    '【新竹D】竹北 | 7/18~7/19 二日營',
    '【新竹G】北區 | 8/10~8/14 五日營',
    '【新竹H】竹北 | 8/15~8/16 速解營',
    '【臺中A】西區 | 7/1~7/3 三日營',
    '【臺中B】西區 | 7/4~7/5 二日營',
    '【臺中H】北屯 | 8/15~8/16 速解營',
    '【彰化D】員林 | 7/18~7/19 二日營',
    '【臺南A】中西區 | 7/1~7/3 三日營',
    '【臺南B】東區 | 7/4~7/5 二日營',
    '【臺南E】東區 | 7/27~7/31 五日營',
    '【臺南H】中西區 | 8/15~8/16 速解營',
    '【高雄B】左營 | 7/4~7/5 二日營',
    '【高雄E】苓雅 | 7/27~7/31 五日營',
    '【高雄F】苓雅 | 8/1~8/2 二日營',
    '【高雄H】苓雅 | 8/15~8/16 速解營'
  ]::text[]) WITH ORDINALITY AS item(value, ordinality)
ON CONFLICT (kind, value) DO NOTHING;


-- C. 受控回報 RPC 加入新參數。
-- 參數清單改變時 CREATE OR REPLACE 會另建一個同名多載函式，PostgREST 會因此呼叫歧義，
-- 所以必須先移除 20260826 的舊簽章再建立新版。
DROP FUNCTION IF EXISTS public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text);

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
  p_transport_distance_km numeric DEFAULT NULL
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

  -- 對齊 Google 課後回報表單的欄位
  IF v_term_period IS NOT NULL
     AND v_term_period NOT IN ('winter_break', 'semester', 'summer_break') THEN
    RAISE EXCEPTION '教學課程期間不正確';
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
    'self_report'
  )
  RETURNING id INTO v_session_id;

  RETURN v_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text, text, text, text, boolean, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text, text, text, text, boolean, numeric) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text, text, text, text, boolean, numeric) TO authenticated;

-- E. 體驗課（表單 B 的課程種類之一）開放站內回報：以議價模式進報酬表，不預設金額，
-- 試算會回「待核薪」，由管理員核薪時依約定填入（2026-10-18 業主指示「體驗課也可以回報」）
INSERT INTO public.salary_rate_card (course_type, instructor_role, duration_hours, pricing_mode, rate, effective_from, note)
SELECT 'trial', NULL, NULL, 'negotiable', NULL, CURRENT_DATE,
       '體驗課：2026-10-18 起開放站內回報；金額由管理員核薪時填入'
 WHERE NOT EXISTS (
   SELECT 1 FROM public.salary_rate_card
    WHERE course_type = 'trial' AND effective_to IS NULL
 );

NOTIFY pgrst, 'reload schema';
