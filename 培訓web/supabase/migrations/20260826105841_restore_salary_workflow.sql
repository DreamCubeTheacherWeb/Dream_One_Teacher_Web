-- ═══════════════════════════════════════════════════════════════════
-- 恢復課程回報與薪資登記工作流，並完整保留報酬試算快照
--
-- 本 migration 只建立本機待上線版本；正式環境需另行授權後套用。
-- 依賴：instructors、users、salary_rate_card、class_sessions 已存在。
-- ═══════════════════════════════════════════════════════════════════

-- A. 報酬表稱號統一。speed_qualification 與管理員權限已由先前 migration 建立。
UPDATE public.salary_rate_card
   SET instructor_role = '速解老師'
 WHERE instructor_role = '基礎速解講師';


-- B. 每筆薪資保留當時資格與實際採用規則，避免日後升等造成歷史重算
ALTER TABLE public.class_sessions
  ADD COLUMN IF NOT EXISTS speed_qualification_at_time text,
  ADD COLUMN IF NOT EXISTS pricing_basis text,
  ADD COLUMN IF NOT EXISTS pricing_label text,
  ADD COLUMN IF NOT EXISTS applied_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS pricing_status text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS pricing_message text,
  ADD COLUMN IF NOT EXISTS pricing_quoted_at timestamptz,
  ADD COLUMN IF NOT EXISTS manual_adjustment_reason text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_speed_qualification_snapshot_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_speed_qualification_snapshot_check
      CHECK (
        speed_qualification_at_time IS NULL
        OR speed_qualification_at_time IN ('speed_teacher', 'speed_master')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_pricing_basis_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_pricing_basis_check
      CHECK (pricing_basis IS NULL OR pricing_basis IN ('general_level', 'speed_qualification', 'manual'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.class_sessions'::regclass
       AND conname = 'class_sessions_pricing_status_check'
  ) THEN
    ALTER TABLE public.class_sessions
      ADD CONSTRAINT class_sessions_pricing_status_check
      CHECK (pricing_status IN ('legacy', 'quoted', 'needs_review', 'manual_override', 'rejected'));
  END IF;
END;
$$;

COMMENT ON COLUMN public.class_sessions.pricing_basis IS
  'general_level=一般講師等級、speed_qualification=速解專業資格、manual=人工訂價';
COMMENT ON COLUMN public.class_sessions.pricing_status IS
  'legacy=舊資料、quoted=報酬表試算、needs_review=待核薪、manual_override=人工調整、rejected=退回';
COMMENT ON COLUMN public.class_sessions.applied_rate IS
  '報酬表命中時的單價快照；最終基本薪資仍記錄於 base_salary';


-- C. 單一薪資試算入口
CREATE OR REPLACE FUNCTION public.quote_salary(
  p_instructor_id uuid,
  p_course_type text,
  p_session_date date,
  p_role_in_session text DEFAULT 'lead',
  p_duration_hours numeric DEFAULT NULL,
  p_student_count integer DEFAULT NULL
)
RETURNS TABLE (
  matched boolean,
  needs_review boolean,
  is_speed_course boolean,
  message text,
  instructor_role text,
  speed_qualification text,
  pricing_basis text,
  pricing_label text,
  rate_card_id uuid,
  pricing_mode text,
  applied_rate numeric,
  base_salary numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_instructor public.instructors%ROWTYPE;
  v_rate public.salary_rate_card%ROWTYPE;
  v_user_role text;
  v_is_staff boolean := false;
  v_is_speed boolean;
  v_lookup_label text;
  v_basis text;
  v_salary numeric;
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

  IF p_course_type IS NULL OR btrim(p_course_type) = '' THEN
    RAISE EXCEPTION 'Course type is required';
  END IF;

  IF p_session_date IS NULL THEN
    RAISE EXCEPTION 'Session date is required';
  END IF;

  IF p_session_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date THEN
    RAISE EXCEPTION '請在課程結束後再回報，日期不能晚於今天';
  END IF;

  IF p_duration_hours IS NOT NULL AND (p_duration_hours <= 0 OR p_duration_hours > 24) THEN
    RAISE EXCEPTION '時數必須大於 0 且不得超過 24 小時';
  END IF;

  IF p_student_count IS NOT NULL AND (p_student_count < 1 OR p_student_count > 999) THEN
    RAISE EXCEPTION '人數必須介於 1 至 999 人';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users
     WHERE id = auth.uid() AND role IN ('admin', 'mentor')
  ) INTO v_is_staff;

  SELECT * INTO v_instructor
    FROM public.instructors
   WHERE id = p_instructor_id
     AND (user_id = auth.uid() OR v_is_staff);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instructor not found or not allowed';
  END IF;

  IF v_instructor.employment_status IN ('frozen', 'cancelled') THEN
    RAISE EXCEPTION '這位講師目前已停用課程回報' USING ERRCODE = '42501';
  END IF;

  v_is_speed := p_course_type LIKE 'speed\_%' ESCAPE '\';
  v_basis := CASE WHEN v_is_speed THEN 'speed_qualification' ELSE 'general_level' END;
  v_lookup_label := CASE v_instructor.speed_qualification
    WHEN 'speed_teacher' THEN '速解老師'
    WHEN 'speed_master' THEN '速解大師'
    ELSE NULL
  END;

  IF NOT v_is_speed THEN
    v_lookup_label := v_instructor.instructor_role::text;
  END IF;

  IF v_lookup_label IS NULL OR btrim(v_lookup_label) = '' THEN
    RETURN QUERY SELECT
      false, true, v_is_speed,
      CASE WHEN v_is_speed
        THEN '尚未設定速解資格，已保留回報並交由管理員核薪'
        ELSE '尚未設定講師等級，已保留回報並交由管理員核薪'
      END,
      v_instructor.instructor_role::text,
      v_instructor.speed_qualification,
      v_basis,
      NULL::text,
      NULL::uuid,
      NULL::text,
      NULL::numeric,
      NULL::numeric;
    RETURN;
  END IF;

  SELECT rc.* INTO v_rate
    FROM public.salary_rate_card rc
   WHERE rc.course_type = p_course_type
     AND (rc.instructor_role = v_lookup_label OR rc.instructor_role IS NULL)
     AND rc.effective_from <= p_session_date
     AND (rc.effective_to IS NULL OR rc.effective_to >= p_session_date)
     AND (rc.duration_hours IS NULL OR (p_duration_hours IS NOT NULL AND rc.duration_hours = p_duration_hours))
     AND (rc.student_count_min IS NULL OR (p_student_count IS NOT NULL AND p_student_count >= rc.student_count_min))
     AND (rc.student_count_max IS NULL OR (p_student_count IS NOT NULL AND p_student_count <= rc.student_count_max))
   ORDER BY
     (rc.instructor_role = v_lookup_label) DESC,
     (rc.duration_hours IS NOT NULL) DESC,
     (rc.student_count_min IS NOT NULL OR rc.student_count_max IS NOT NULL) DESC,
     rc.effective_from DESC,
     rc.created_at DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      false, true, v_is_speed,
      '找不到符合日期、時數或人數的報酬規則，已交由管理員核薪',
      v_instructor.instructor_role::text,
      v_instructor.speed_qualification,
      v_basis,
      v_lookup_label,
      NULL::uuid,
      NULL::text,
      NULL::numeric,
      NULL::numeric;
    RETURN;
  END IF;

  IF v_rate.pricing_mode::text = 'negotiable' OR v_rate.rate IS NULL THEN
    RETURN QUERY SELECT
      false, true, v_is_speed,
      '此課程為議價項目，已交由管理員依書面約定核薪',
      v_instructor.instructor_role::text,
      v_instructor.speed_qualification,
      v_basis,
      COALESCE(v_rate.instructor_role, v_lookup_label),
      v_rate.id,
      v_rate.pricing_mode::text,
      v_rate.rate,
      NULL::numeric;
    RETURN;
  END IF;

  IF v_rate.pricing_mode::text = 'hourly' AND p_duration_hours IS NULL THEN
    RETURN QUERY SELECT
      false, true, v_is_speed,
      '此報酬規則需要填寫時數，已交由管理員核薪',
      v_instructor.instructor_role::text,
      v_instructor.speed_qualification,
      v_basis,
      COALESCE(v_rate.instructor_role, v_lookup_label),
      v_rate.id,
      v_rate.pricing_mode::text,
      v_rate.rate,
      NULL::numeric;
    RETURN;
  END IF;

  v_salary := CASE v_rate.pricing_mode::text
    WHEN 'hourly' THEN v_rate.rate * p_duration_hours
    WHEN 'per_session' THEN v_rate.rate
    WHEN 'fixed' THEN v_rate.rate
    ELSE NULL
  END;

  RETURN QUERY SELECT
    true, false, v_is_speed,
    '已依現行報酬表完成試算',
    v_instructor.instructor_role::text,
    v_instructor.speed_qualification,
    v_basis,
    COALESCE(v_rate.instructor_role, v_lookup_label),
    v_rate.id,
    v_rate.pricing_mode::text,
    v_rate.rate,
    round(v_salary, 2);
END;
$$;

REVOKE ALL ON FUNCTION public.quote_salary(uuid, text, date, text, numeric, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.quote_salary(uuid, text, date, text, numeric, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.quote_salary(uuid, text, date, text, numeric, integer) TO authenticated;


-- D. 講師只能透過受控 RPC 回報；身份、資格快照與試算結果均由伺服器填入
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
  p_incident_report text DEFAULT NULL
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
    'self_report'
  )
  RETURNING id INTO v_session_id;

  RETURN v_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_my_class_session(text, date, text, text, text, numeric, integer, text, text, text) TO authenticated;


-- E. 不允許把「待核薪」直接核准，也不允許無理由竄改自動試算金額
CREATE OR REPLACE FUNCTION public.guard_class_session_pricing()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.pricing_status = 'quoted' THEN
    IF NEW.base_salary IS NULL OR NEW.rate_card_id IS NULL OR NEW.pricing_quoted_at IS NULL THEN
      RAISE EXCEPTION '自動試算紀錄缺少金額、報酬規則或試算時間快照';
    END IF;
  END IF;

  IF NEW.pricing_status = 'needs_review' THEN
    IF NEW.status <> 'pending' OR NEW.base_salary IS NOT NULL THEN
      RAISE EXCEPTION '待核薪紀錄須先完成定價，不能直接核准';
    END IF;
  END IF;

  IF NEW.pricing_status = 'manual_override' THEN
    IF NEW.base_salary IS NULL OR NULLIF(btrim(NEW.manual_adjustment_reason), '') IS NULL THEN
      RAISE EXCEPTION '人工調整薪資必須填寫金額與原因';
    END IF;
    NEW.pricing_basis := 'manual';
  END IF;

  IF NEW.pricing_status = 'rejected' THEN
    IF NEW.status <> 'pending' OR NEW.base_salary IS NOT NULL THEN
      RAISE EXCEPTION '退回紀錄必須維持 pending 且不得保留薪資金額';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.base_salary IS DISTINCT FROM OLD.base_salary
     AND OLD.pricing_status IN ('quoted', 'needs_review', 'manual_override')
     AND NEW.pricing_status NOT IN ('manual_override', 'rejected')
     AND NEW.pricing_quoted_at IS NOT DISTINCT FROM OLD.pricing_quoted_at THEN
    RAISE EXCEPTION '變更試算金額時必須改為人工調整並填寫原因';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       NEW.course_type IS DISTINCT FROM OLD.course_type
       OR NEW.session_date IS DISTINCT FROM OLD.session_date
       OR NEW.duration_hours IS DISTINCT FROM OLD.duration_hours
       OR NEW.student_count IS DISTINCT FROM OLD.student_count
     )
     AND NEW.pricing_status = 'quoted'
     AND NEW.pricing_quoted_at IS NOT DISTINCT FROM OLD.pricing_quoted_at THEN
    RAISE EXCEPTION '影響薪資的課程資料已變更，請重新試算';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_class_session_pricing ON public.class_sessions;
CREATE TRIGGER trg_guard_class_session_pricing
  BEFORE INSERT OR UPDATE ON public.class_sessions
  FOR EACH ROW EXECUTE FUNCTION public.guard_class_session_pricing();

REVOKE ALL ON FUNCTION public.guard_class_session_pricing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_class_session_pricing() FROM anon;
REVOKE ALL ON FUNCTION public.guard_class_session_pricing() FROM authenticated;


-- F. View 必須用查詢者權限套用底層 RLS，避免一般 view owner 繞過限制
ALTER VIEW public.instructor_salary_summary SET (security_invoker = true);
REVOKE ALL ON public.instructor_salary_summary FROM anon;
GRANT SELECT ON public.instructor_salary_summary TO authenticated;

NOTIFY pgrst, 'reload schema';
