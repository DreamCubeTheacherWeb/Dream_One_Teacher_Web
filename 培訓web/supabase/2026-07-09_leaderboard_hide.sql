-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  排行榜「不上榜」開關（隱藏特定講師，資料保留）
-- ───────────────────────────────────────────────────────────────────
-- 需求：把某講師從「前台排行榜」拿掉，但資料庫/後台仍保留（不刪資料）。
-- 做法：instructors 加 hide_from_leaderboard 旗標；三支前台排行函式加過濾。
--   → 前台（教學總/大班/小班榜、WCA 各項目榜）不再顯示被標記者；
--   → wca_results / instructors 的資料完整保留，admin 仍可查（後台管理可留）。
-- 本次標記：蘇詩文。要恢復顯示：UPDATE ... SET hide_from_leaderboard = false。
-- 冪等：可重複執行。與 2026-07-09_leaderboard_expansion.sql 相容（需先跑那份）。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 旗標欄位 ─────────────────────────────────────────────────────
ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS hide_from_leaderboard boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.instructors.hide_from_leaderboard
  IS '前台排行榜隱藏此講師（資料保留、後台仍可查）。true=不上榜。';

-- ── 2. 標記蘇詩文不上榜（資料不刪）───────────────────────────────────
UPDATE public.instructors SET hide_from_leaderboard = true WHERE full_name = '蘇詩文';


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ 3. 三支前台排行函式加「排除隱藏者」過濾（其餘邏輯與原版一致）    ║
-- ╚═══════════════════════════════════════════════════════════════╝

-- 3a. 教學排行（總/大班/小班）
CREATE OR REPLACE FUNCTION public.get_teaching_leaderboard_v2(
  p_year     int  DEFAULT NULL,
  p_category text DEFAULT 'all'
)
RETURNS TABLE (
  instructor_id uuid, user_id uuid, display_name text, photo_path text,
  total_hours numeric, session_count bigint, student_reach bigint
) AS $$
DECLARE
  big_types   text[] := ARRAY['collab_lead','collab_assistant','collab_project'];
  small_types text[] := ARRAY[
    'regular_basic','regular_advanced','online','overseas_online',
    'onsite_2hr','onsite_1_5hr','camp',
    'speed_onsite','speed_online','speed_training_lead','speed_training_assistant','speed_camp',
    'kids_lead','kids_assistant',
    'special_lecture_recorded','special_lecture_unrecorded'
  ];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  SELECT
    i.id, i.user_id,
    COALESCE(i.nickname, i.full_name, MIN(s.instructor_name), '匿名講師') AS display_name,
    i.photo_path,
    COALESCE(SUM(s.duration_hours), 0)::numeric AS total_hours,
    COUNT(s.id)::bigint AS session_count,
    COALESCE(SUM(s.student_count), 0)::bigint AS student_reach
  FROM public.instructors i
  JOIN public.class_sessions s ON s.instructor_id = i.id
  WHERE EXTRACT(YEAR FROM s.session_date) >= 2023
    AND (p_year IS NULL OR EXTRACT(YEAR FROM s.session_date) = p_year)
    AND NOT (
      COALESCE(s.location, '')    ILIKE '%科教館%' OR COALESCE(s.location, '')    ILIKE '%科博館%'
      OR COALESCE(s.course_name, '') ILIKE '%科教館%' OR COALESCE(s.course_name, '') ILIKE '%科博館%'
    )
    AND (
      p_category = 'all'
      OR (p_category = 'big'   AND s.course_type = ANY(big_types))
      OR (p_category = 'small' AND s.course_type = ANY(small_types))
    )
    AND i.hide_from_leaderboard = false            -- ← 排除不上榜者
  GROUP BY i.id, i.user_id, i.nickname, i.full_name, i.photo_path
  HAVING COUNT(s.id) > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.get_teaching_leaderboard_v2(int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard_v2(int, text) TO authenticated;


-- 3b. WCA 有成績的項目清單（下拉用）
CREATE OR REPLACE FUNCTION public.get_wca_events()
RETURNS TABLE (event_id text, single_count bigint, average_count bigint) AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  SELECT
    r.event_id,
    COUNT(*) FILTER (WHERE r.best_single  IS NOT NULL)::bigint,
    COUNT(*) FILTER (WHERE r.best_average IS NOT NULL)::bigint
  FROM public.wca_results r
  JOIN public.instructors i ON i.id = r.instructor_id     -- ← 加 join 以便過濾
  WHERE i.hide_from_leaderboard = false                   -- ← 排除不上榜者
  GROUP BY r.event_id
  HAVING COUNT(*) FILTER (WHERE r.best_single IS NOT NULL) > 0
      OR COUNT(*) FILTER (WHERE r.best_average IS NOT NULL) > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.get_wca_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wca_events() TO authenticated;


-- 3c. WCA 單一項目排行
CREATE OR REPLACE FUNCTION public.get_wca_leaderboard(
  p_event text, p_type text DEFAULT 'single'
)
RETURNS TABLE (
  rank bigint, instructor_id uuid, user_id uuid, display_name text,
  photo_path text, wca_id text, best_ms int
) AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  SELECT
    ROW_NUMBER() OVER (ORDER BY val ASC)::bigint AS rank,
    t.instructor_id, t.user_id, t.display_name, t.photo_path, t.wca_id, t.val AS best_ms
  FROM (
    SELECT
      i.id AS instructor_id, i.user_id,
      COALESCE(i.nickname, i.full_name, i.wca_name, '匿名講師') AS display_name,
      i.photo_path, i.wca_id,
      CASE WHEN p_type = 'average' THEN r.best_average ELSE r.best_single END AS val
    FROM public.wca_results r
    JOIN public.instructors i ON i.id = r.instructor_id
    WHERE r.event_id = p_event
      AND i.hide_from_leaderboard = false          -- ← 排除不上榜者
  ) t
  WHERE t.val IS NOT NULL
  ORDER BY t.val ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
REVOKE ALL ON FUNCTION public.get_wca_leaderboard(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wca_leaderboard(text, text) TO authenticated;


-- ── 驗證（需登入 session）─────────────────────────────────────────────
--   確認蘇詩文已標記：
SELECT full_name, hide_from_leaderboard, wca_id
  FROM public.instructors WHERE full_name = '蘇詩文';
--   （資料仍在，只是不上榜）確認成績列還在：
SELECT COUNT(*) AS 蘇詩文成績筆數_應仍在
  FROM public.wca_results w JOIN public.instructors i ON i.id = w.instructor_id
 WHERE i.full_name = '蘇詩文';
