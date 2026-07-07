-- ═══════════════════════════════════════════════════════════════════
-- 講師榮譽榜：接課時數聚合函式（2026-07-08）可重複執行
-- ───────────────────────────────────────────────────────────────────
-- 排行榜改版：從「學習活動排名」改為「接課貢獻排名」。
-- 資料來源＝class_sessions（薪資系統的接課登記，session_date 是真實授課日）。
-- 點數與里程碑在前端用 total_hours 換算（好調公式），本檔只回傳原始數據。
--
-- 兩支函式：
--   get_teaching_leaderboard(p_year) — 每位講師的接課聚合，可依年份篩選
--   get_teaching_years()             — 有接課資料的年份清單（給年份切換器）
-- ⚠️ 若報「欄位不存在」把錯誤訊息回報我修（只讀不寫，建立失敗無副作用）。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 排行榜聚合（p_year 為 NULL＝歷屆總榜；給年份＝該年度）──────────
CREATE OR REPLACE FUNCTION public.get_teaching_leaderboard(p_year int DEFAULT NULL)
RETURNS TABLE (
  instructor_id uuid,   -- 穩定鍵（instructors.id）
  user_id       uuid,   -- 對應帳號（可能為 null＝講師尚未綁定帳號），前端用來高亮「你」
  display_name  text,
  photo_path    text,
  total_hours   numeric,  -- 接課總時數
  session_count bigint,   -- 接課場次
  student_reach bigint    -- 累積授課人次
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
  WHERE (p_year IS NULL OR EXTRACT(YEAR FROM s.session_date) = p_year)
  GROUP BY i.id, i.user_id, i.nickname, i.full_name, i.photo_path
  HAVING COUNT(s.id) > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teaching_leaderboard(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard(int) TO authenticated;


-- ── 2. 有接課資料的年份清單（新到舊）──────────────────────────────
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
  ORDER BY yr DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teaching_years() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teaching_years() TO authenticated;

-- 驗證（需登入 session；在 SQL Editor 直接跑會因 auth.uid() 為 null 而擋，屬正常）：
--   SELECT * FROM public.get_teaching_leaderboard() ORDER BY total_hours DESC;
--   SELECT * FROM public.get_teaching_leaderboard(2025);
--   SELECT * FROM public.get_teaching_years();
