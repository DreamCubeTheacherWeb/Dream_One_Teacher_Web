-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  遊戲化擴充 第 2 波：後端計算層
-- ───────────────────────────────────────────────────────────────────
-- 本檔做兩件事，皆冪等（CREATE OR REPLACE，可重複執行）、皆遵本專案權限慣例
--   （SECURITY DEFINER 內含 auth.uid() 守衛、REVOKE ALL FROM PUBLIC + GRANT
--   authenticated、LANGUAGE plpgsql SECURITY DEFINER SET search_path = public）：
--   (A) get_teacher_badge_stats(p_instructor_id) —— 算「一位」老師的成就統計，
--       給前端成就牆依門檻判斷徽章解鎖（門檻定義見 badge_definitions 表）。
--   (B) 三支新排行榜：
--       get_wca_allaround_leaderboard()   —— WCA 全能分（Kinch 式簡化版）
--       get_interaction_leaderboard()     —— 互動排行（被讚數／留言數）
--       get_teaching_leaderboard_v2(...)  —— 擴充：新增 online/speed/kids 三個分類
--
-- ⚠️ 相依（必須先跑過，否則會報「欄位/表不存在」）：
--   1. instructors_setup.sql               （instructors 表）
--   2. 2025_salary_system.sql               （class_sessions 表）
--   3. comments_likes_setup.sql             （nickname 欄位、lesson_comment_likes 表）
--   4. 2026-07-07_gamification.sql          （lesson_comments 已存在的假設）
--   5. 2026-07-08_cube_speed.sql             （cube_solves 表，mode='virtual'/'physical'）
--   6. 2026-07-09_leaderboard_expansion.sql  （wca_results 表、wca_id/wca_name 欄位）
--   7. 2026-07-09_leaderboard_hide.sql       （hide_from_leaderboard 欄位；本檔的
--                                              get_teaching_leaderboard_v2 CREATE OR
--                                              REPLACE 是接著這份最新版本繼續擴充）
-- ⚠️ 只讀不寫使用者資料（is_founder/其他統計皆即時算出，不落地）；建函式失敗無副作用。
--    若報「欄位不存在」，把錯誤訊息回報即可（只讀函式，安全重跑）。
-- ═══════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ (A) 成就統計：get_teacher_badge_stats(p_instructor_id)          ║
-- ╚═══════════════════════════════════════════════════════════════╝
-- 回傳「一列」（就算該講師完全沒資料，也一定回一列，數值型別預設 0/false/NULL，
-- 靠純量子查詢＋COALESCE 達成，不靠 FROM 表格 JOIN 導致零列問題）。
--
-- 設計說明（簡化之處，寫在這裡而非散落註解）：
--   • streak_months：以「該講師最近一次接課的月份」為錨點，往前數連續有課的
--     月份數（islands-and-gaps：把月份依新到舊排序，rn=排名，
--     grp_key = 月份 + rn 個月，同一段連續月份 grp_key 會相同）。
--     ⚠️ 錨點是「最近一次接課」而不是「今天所在月份」——如果講師 3 個月沒接課，
--     streak_months 仍會回傳「最近那段」的連續月數，不會因為現在沒課而歸零。
--     這是照題目「由近往前數連續月數」的字面定義；若日後要改成「必須含當月
--     才算 streak 存活」，把錨點換成 date_trunc('month', now()) 即可。
--   • is_founder／founder_ids：取「全體講師」form_submitted_at 最早的 20 位
--     （NULLS LAST，未填表單者不會被誤判為創始元老），刻意不套 hide_from_leaderboard
--     過濾——這是個人成就（歷史事實），不是公開排行榜項目，跟「要不要上排行榜」
--     的顯示開關無關。若要改成「隱藏者不佔創始 20 個名額」也只要在 founder_ids
--     的 SELECT 加一個 JOIN 條件。
--   • cube_keyboard_solves 用 mode = 'virtual'（已核對 CubeTimer.jsx：virtual＝
--     鍵盤模式・虛擬方塊；physical＝實體計時，不算鍵盤解）。
-- ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_teacher_badge_stats(p_instructor_id uuid)
RETURNS TABLE (
  total_hours           numeric,
  session_count         bigint,
  student_reach         bigint,
  course_type_count     int,
  lead_count            bigint,
  assistant_count       bigint,
  max_day_sessions      int,
  max_session_hours     numeric,
  region_count          int,
  has_offshore_region   boolean,
  tenure_years          int,
  instructor_level      text,
  is_founder            boolean,
  wca_event_count       int,
  wca_333_single        int,
  wca_has_bf            boolean,
  wca_has_bigcube       boolean,
  cube_best_ms          int,
  cube_keyboard_solves  bigint,
  has_night_solve       boolean,
  streak_months         int
) AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  SELECT i.user_id INTO v_user_id FROM public.instructors i WHERE i.id = p_instructor_id;

  RETURN QUERY
  WITH filtered_sessions AS (
    -- 標準教學統計過濾：與 get_teaching_leaderboard_v2 一致
    -- （2023 年起、排除科教館／科博館），只看這位講師
    SELECT s.*
    FROM public.class_sessions s
    WHERE s.instructor_id = p_instructor_id
      AND EXTRACT(YEAR FROM s.session_date) >= 2023
      AND NOT (
        COALESCE(s.location, '')    ILIKE '%科教館%' OR COALESCE(s.location, '')    ILIKE '%科博館%'
        OR COALESCE(s.course_name, '') ILIKE '%科教館%' OR COALESCE(s.course_name, '') ILIKE '%科博館%'
      )
  ),
  day_counts AS (
    SELECT session_date AS d, COUNT(*) AS cnt
    FROM filtered_sessions
    GROUP BY session_date
  ),
  months_taught AS (
    SELECT DISTINCT date_trunc('month', session_date)::date AS m
    FROM filtered_sessions
  ),
  streak_ranked AS (
    SELECT m, ROW_NUMBER() OVER (ORDER BY m DESC) AS rn
    FROM months_taught
  ),
  streak_keyed AS (
    -- 連續月份會有相同 grp_key（見上方設計說明）
    SELECT m, rn, (m + (rn || ' months')::interval) AS grp_key
    FROM streak_ranked
  ),
  founder_ids AS (
    SELECT id FROM public.instructors
    ORDER BY form_submitted_at ASC NULLS LAST
    LIMIT 20
  )
  SELECT
    (SELECT COALESCE(SUM(fs.duration_hours), 0) FROM filtered_sessions fs)::numeric            AS total_hours,
    (SELECT COUNT(*) FROM filtered_sessions)::bigint                                            AS session_count,
    (SELECT COALESCE(SUM(fs.student_count), 0) FROM filtered_sessions fs)::bigint               AS student_reach,
    (SELECT COUNT(DISTINCT fs.course_type) FROM filtered_sessions fs)::int                      AS course_type_count,
    (SELECT COUNT(*) FROM filtered_sessions WHERE role_in_session = 'lead')::bigint             AS lead_count,
    (SELECT COUNT(*) FROM filtered_sessions WHERE role_in_session = 'assistant')::bigint        AS assistant_count,
    COALESCE((SELECT MAX(cnt) FROM day_counts), 0)::int                                         AS max_day_sessions,
    COALESCE((SELECT MAX(fs.duration_hours) FROM filtered_sessions fs), 0)::numeric             AS max_session_hours,
    COALESCE((
      SELECT array_length(i.teaching_regions, 1)
      FROM public.instructors i WHERE i.id = p_instructor_id
    ), 0)::int                                                                                  AS region_count,
    COALESCE((
      SELECT i.teaching_regions::text[] && ARRAY['澎湖縣','金門縣','連江縣','綠島','蘭嶼']::text[]
      FROM public.instructors i WHERE i.id = p_instructor_id
    ), false)                                                                                   AS has_offshore_region,
    COALESCE((
      SELECT EXTRACT(YEAR FROM age(now(), i.form_submitted_at))::int
      FROM public.instructors i WHERE i.id = p_instructor_id
    ), 0)                                                                                        AS tenure_years,
    (SELECT i.instructor_role::text FROM public.instructors i WHERE i.id = p_instructor_id)      AS instructor_level,
    (p_instructor_id IN (SELECT id FROM founder_ids))                                            AS is_founder,
    (SELECT COUNT(DISTINCT r.event_id) FROM public.wca_results r
      WHERE r.instructor_id = p_instructor_id)::int                                              AS wca_event_count,
    (SELECT r.best_single FROM public.wca_results r
      WHERE r.instructor_id = p_instructor_id AND r.event_id = '333' LIMIT 1)                    AS wca_333_single,
    EXISTS (
      SELECT 1 FROM public.wca_results r
      WHERE r.instructor_id = p_instructor_id AND r.event_id IN ('333bf','444bf','555bf')
    )                                                                                             AS wca_has_bf,
    EXISTS (
      SELECT 1 FROM public.wca_results r
      WHERE r.instructor_id = p_instructor_id AND r.event_id IN ('666','777')
    )                                                                                             AS wca_has_bigcube,
    (SELECT MIN(cs.time_ms) FROM public.cube_solves cs WHERE cs.user_id = v_user_id)              AS cube_best_ms,
    (SELECT COUNT(*) FROM public.cube_solves cs
      WHERE cs.user_id = v_user_id AND cs.mode = 'virtual')::bigint                               AS cube_keyboard_solves,
    EXISTS (
      SELECT 1 FROM public.cube_solves cs
      WHERE cs.user_id = v_user_id
        AND EXTRACT(HOUR FROM cs.created_at AT TIME ZONE 'Asia/Taipei') BETWEEN 0 AND 4
    )                                                                                              AS has_night_solve,
    COALESCE((
      SELECT COUNT(*) FROM streak_keyed sk
      WHERE sk.grp_key = (SELECT grp_key FROM streak_keyed WHERE rn = 1)
    ), 0)::int                                                                                     AS streak_months
  ;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teacher_badge_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teacher_badge_stats(uuid) TO authenticated;


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ (B-1) WCA 全能排行：get_wca_allaround_leaderboard()             ║
-- ╚═══════════════════════════════════════════════════════════════╝
-- Kinch 式簡化全能分：
--   1. 只看「未被隱藏講師」且 best_single 有值的成績，組成 visible_results。
--   2. event_mins：每個項目在這個池子裡的最快 best_single（＝該項目滿分基準）。
--   3. 對某講師、某項目：ratio = min_e / 他的 best_single（0~1，沒成績不計入 SUM，
--      效果等同「缺項算 0」——因為分母是「全部項目數」而不是「他有成績的項目數」）。
--   4. score = SUM(ratio) / 全部項目數 × 100（兩位小數），越大越前面。
--   5. 只納入至少 1 項成績的講師（INNER JOIN ratios 天然達成）。
CREATE OR REPLACE FUNCTION public.get_wca_allaround_leaderboard()
RETURNS TABLE (
  rank          bigint,
  instructor_id uuid,
  user_id       uuid,
  display_name  text,
  photo_path    text,
  wca_id        text,
  score         numeric
) AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  WITH visible_results AS (
    SELECT r.instructor_id, r.event_id, r.best_single
    FROM public.wca_results r
    JOIN public.instructors i ON i.id = r.instructor_id
    WHERE i.hide_from_leaderboard = false
      AND r.best_single IS NOT NULL
  ),
  event_mins AS (
    SELECT event_id, MIN(best_single) AS min_single
    FROM visible_results
    GROUP BY event_id
  ),
  pool_size AS (
    SELECT COUNT(*)::numeric AS n FROM event_mins
  ),
  ratios AS (
    SELECT
      vr.instructor_id,
      -- NULLIF 防呆：萬一未來資料有 0(理論上不可能的成績)，讓該筆不計入 SUM
      -- 而不是讓整支函式因除以零而炸掉
      SUM(em.min_single::numeric / NULLIF(vr.best_single, 0)::numeric) AS sum_ratio
    FROM visible_results vr
    JOIN event_mins em ON em.event_id = vr.event_id
    GROUP BY vr.instructor_id
  )
  SELECT
    ROW_NUMBER() OVER (ORDER BY t.score DESC)::bigint AS rank,
    t.instructor_id, t.user_id, t.display_name, t.photo_path, t.wca_id, t.score
  FROM (
    SELECT
      i.id AS instructor_id,
      i.user_id,
      COALESCE(i.nickname, i.full_name, i.wca_name, '匿名講師') AS display_name,
      i.photo_path,
      i.wca_id,
      ROUND((COALESCE(r.sum_ratio, 0) / (SELECT n FROM pool_size)) * 100, 2) AS score
    FROM public.instructors i
    JOIN ratios r ON r.instructor_id = i.id      -- 只納入至少 1 項成績的講師
    WHERE i.hide_from_leaderboard = false
  ) t
  ORDER BY t.score DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_wca_allaround_leaderboard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wca_allaround_leaderboard() TO authenticated;


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ (B-2) 互動排行：get_interaction_leaderboard()                   ║
-- ╚═══════════════════════════════════════════════════════════════╝
-- 依「被讚數」為主排序，讚數相同再比留言數。只納入有 user_id 且有互動
-- （讚或留言至少一項 > 0）的講師；join 方式沿用 get_teacher_stats 的寫法
-- （lesson_comments.user_id、lesson_comment_likes.comment_id → lesson_comments.id）。
CREATE OR REPLACE FUNCTION public.get_interaction_leaderboard()
RETURNS TABLE (
  rank            bigint,
  instructor_id   uuid,
  user_id         uuid,
  display_name    text,
  photo_path      text,
  likes_received  bigint,
  comments_count  bigint
) AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  WITH comment_counts AS (
    SELECT lcm.user_id, COUNT(*) AS cnt
    FROM public.lesson_comments lcm
    GROUP BY lcm.user_id
  ),
  like_counts AS (
    SELECT lc.user_id, COUNT(*) AS cnt
    FROM public.lesson_comment_likes lcl
    JOIN public.lesson_comments lc ON lc.id = lcl.comment_id
    GROUP BY lc.user_id
  )
  SELECT
    ROW_NUMBER() OVER (ORDER BY t.likes_received DESC, t.comments_count DESC)::bigint AS rank,
    t.instructor_id, t.user_id, t.display_name, t.photo_path, t.likes_received, t.comments_count
  FROM (
    SELECT
      i.id AS instructor_id,
      i.user_id,
      COALESCE(i.nickname, i.full_name, '匿名講師') AS display_name,
      i.photo_path,
      COALESCE(lk.cnt, 0)::bigint AS likes_received,
      COALESCE(cm.cnt, 0)::bigint AS comments_count
    FROM public.instructors i
    LEFT JOIN like_counts    lk ON lk.user_id = i.user_id
    LEFT JOIN comment_counts cm ON cm.user_id = i.user_id
    WHERE i.hide_from_leaderboard = false
      AND i.user_id IS NOT NULL
      AND (COALESCE(lk.cnt, 0) > 0 OR COALESCE(cm.cnt, 0) > 0)
  ) t
  ORDER BY t.likes_received DESC, t.comments_count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_interaction_leaderboard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_interaction_leaderboard() TO authenticated;


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ (B-3) 擴充 get_teaching_leaderboard_v2：新增 online/speed/kids   ║
-- ╚═══════════════════════════════════════════════════════════════╝
-- 沿用 2026-07-09_leaderboard_hide.sql 的最新版本（含 hide_from_leaderboard
-- 過濾），只新增三個 category 值，其餘邏輯（≥2023、排除科教館/科博館、
-- big/small/all 分類、回傳欄位）完全不變。CREATE OR REPLACE 整支重新定義。
CREATE OR REPLACE FUNCTION public.get_teaching_leaderboard_v2(
  p_year     int  DEFAULT NULL,
  p_category text DEFAULT 'all'          -- 'all' | 'big' | 'small' | 'online' | 'speed' | 'kids'
)
RETURNS TABLE (
  instructor_id uuid,
  user_id       uuid,
  display_name  text,
  photo_path    text,
  total_hours   numeric,
  session_count bigint,
  student_reach bigint
) AS $$
DECLARE
  big_types    text[] := ARRAY['collab_lead','collab_assistant','collab_project'];
  small_types  text[] := ARRAY[
    'regular_basic','regular_advanced','online','overseas_online',
    'onsite_2hr','onsite_1_5hr','camp',
    'speed_onsite','speed_online','speed_training_lead','speed_training_assistant','speed_camp',
    'kids_lead','kids_assistant',
    'special_lecture_recorded','special_lecture_unrecorded'
  ];
  online_types text[] := ARRAY['online','overseas_online','speed_online'];
  speed_types  text[] := ARRAY[
    'speed_onsite','speed_online','speed_training_lead','speed_training_assistant','speed_camp'
  ];
  kids_types   text[] := ARRAY['kids_lead','kids_assistant'];
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
  WHERE EXTRACT(YEAR FROM s.session_date) >= 2023
    AND (p_year IS NULL OR EXTRACT(YEAR FROM s.session_date) = p_year)
    AND NOT (
      COALESCE(s.location, '')    ILIKE '%科教館%' OR COALESCE(s.location, '')    ILIKE '%科博館%'
      OR COALESCE(s.course_name, '') ILIKE '%科教館%' OR COALESCE(s.course_name, '') ILIKE '%科博館%'
    )
    AND (
      p_category = 'all'
      OR (p_category = 'big'    AND s.course_type = ANY(big_types))
      OR (p_category = 'small'  AND s.course_type = ANY(small_types))
      OR (p_category = 'online' AND s.course_type = ANY(online_types))
      OR (p_category = 'speed'  AND s.course_type = ANY(speed_types))
      -- 幼兒課：實際資料沒有 kids_* 課程種類，幼兒課掛在合作/營隊/到府下、靠課名辨識
      -- （關鍵字可調；kids_types 保留給未來若改用課程種類）
      OR (p_category = 'kids'   AND (
        s.course_type = ANY(kids_types)
        OR s.course_name ILIKE '%幼兒%' OR s.course_name ILIKE '%兒童%'
        OR s.course_name ILIKE '%幼校%' OR s.course_name ILIKE '%親子%'
        OR s.course_name ILIKE '%蒙特梭利%' OR s.course_name ILIKE '%啟蒙%'
        OR s.course_name ILIKE '%Kids%'
        OR s.course_name ILIKE '%安親%' OR s.course_name ILIKE '%課後照顧%'  -- 業主確認納入
      ))
    )
    AND i.hide_from_leaderboard = false
  GROUP BY i.id, i.user_id, i.nickname, i.full_name, i.photo_path
  HAVING COUNT(s.id) > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teaching_leaderboard_v2(int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard_v2(int, text) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- 驗證（需在應用程式的登入 session 下呼叫；SQL Editor 直接跑會因
-- auth.uid() 為 null 被擋，屬正常）
-- ═══════════════════════════════════════════════════════════════════
--   SELECT * FROM public.get_teacher_badge_stats('<某個真實 instructor_id>');
--   SELECT * FROM public.get_wca_allaround_leaderboard();
--   SELECT * FROM public.get_interaction_leaderboard();
--   SELECT * FROM public.get_teaching_leaderboard_v2(NULL, 'online');
--   SELECT * FROM public.get_teaching_leaderboard_v2(NULL, 'speed');
--   SELECT * FROM public.get_teaching_leaderboard_v2(NULL, 'kids');
-- 結構驗證（不需登入，可直接在 SQL Editor 跑）：
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('get_teacher_badge_stats','get_wca_allaround_leaderboard',
--      'get_interaction_leaderboard','get_teaching_leaderboard_v2');
