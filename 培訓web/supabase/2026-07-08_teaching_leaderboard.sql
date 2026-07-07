-- ═══════════════════════════════════════════════════════════════════
-- 講師榮譽榜：接課時數聚合函式（2026-07-08，可重複執行）
-- ───────────────────────────────────────────────────────────────────
-- 排行榜＝接課時數排名（單一維度）。資料源＝class_sessions（薪資系統接課登記）。
-- 過濾規則（依業主要求）：
--   1. 只計 2023 年（含）以後的接課——2023 前為錯誤資料，一律排除。
--   2. 排除科教館 / 科博館的場次（比對 location 與 course_name 是否含這兩個關鍵字）。
-- ⚠️ 若科教館/科博館其實記在別的欄位（非 location/course_name），回報我調整。
-- ⚠️ 若報「欄位不存在」把錯誤訊息回報我修（只讀不寫，建立失敗無副作用）。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 排行榜聚合（p_year 為 NULL＝歷屆總榜；給年份＝該年度，僅 2023+）──────
CREATE OR REPLACE FUNCTION public.get_teaching_leaderboard(p_year int DEFAULT NULL)
RETURNS TABLE (
  instructor_id uuid,
  user_id       uuid,
  display_name  text,
  photo_path    text,
  total_hours   numeric,
  session_count bigint,
  student_reach bigint
) AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  SELECT
    i.id,
    i.user_id,
    COALESCE(i.nickname, i.full_name, MIN(s.instructor_name), '匿名講師') AS display_name,
    i.photo_path,
    COALESCE(SUM(s.duration_hours), 0)::numeric AS total_hours,
    COUNT(s.id)::bigint AS session_count,
    COALESCE(SUM(s.student_count), 0)::bigint AS student_reach
  FROM public.instructors i
  JOIN public.class_sessions s ON s.instructor_id = i.id
  WHERE EXTRACT(YEAR FROM s.session_date) >= 2023                 -- 只算 2023 年起
    AND (p_year IS NULL OR EXTRACT(YEAR FROM s.session_date) = p_year)
    AND NOT (                                                     -- 排除科教館 / 科博館
      COALESCE(s.location, '')    ILIKE '%科教館%' OR COALESCE(s.location, '')    ILIKE '%科博館%'
      OR COALESCE(s.course_name, '') ILIKE '%科教館%' OR COALESCE(s.course_name, '') ILIKE '%科博館%'
    )
  GROUP BY i.id, i.user_id, i.nickname, i.full_name, i.photo_path
  HAVING COUNT(s.id) > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teaching_leaderboard(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard(int) TO authenticated;


-- ── 2. 年份清單（2023 起、且排除只有科教館/科博館的年份）──────────────────
CREATE OR REPLACE FUNCTION public.get_teaching_years()
RETURNS TABLE (yr int) AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  SELECT DISTINCT EXTRACT(YEAR FROM s.session_date)::int AS yr
  FROM public.class_sessions s
  WHERE s.session_date IS NOT NULL
    AND EXTRACT(YEAR FROM s.session_date) >= 2023
    AND NOT (
      COALESCE(s.location, '')    ILIKE '%科教館%' OR COALESCE(s.location, '')    ILIKE '%科博館%'
      OR COALESCE(s.course_name, '') ILIKE '%科教館%' OR COALESCE(s.course_name, '') ILIKE '%科博館%'
    )
  ORDER BY yr DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teaching_years() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teaching_years() TO authenticated;

-- 驗證（需登入 session；SQL Editor 直接跑會因 auth.uid() 為 null 而擋，屬正常）：
--   SELECT * FROM public.get_teaching_leaderboard() ORDER BY total_hours DESC;
--   SELECT * FROM public.get_teaching_years();
