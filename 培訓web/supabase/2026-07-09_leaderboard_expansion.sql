-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  排行榜擴充：教學(總/大班/小班) + WCA 世界賽成績
-- ───────────────────────────────────────────────────────────────────
-- 本檔做三件事，皆冪等（可重複執行）、皆遵本專案權限慣例（SECURITY DEFINER
--   內含 auth 守衛、REVOKE ALL FROM PUBLIC + GRANT authenticated）：
--   (1) 教學排行分類版 get_teaching_leaderboard_v2(p_year, p_category)
--       —— category = 'all' | 'big'(合作大班) | 'small'(自家小班)
--   (2) instructors 加 wca_id / wca_name 欄位；新建 wca_results 表（每人每項目最佳成績）
--   (3) WCA 排行函式 get_wca_events() / get_wca_leaderboard(p_event, p_type)
-- ⚠️ 只讀不寫使用者資料；建表/函式失敗無副作用。若報「欄位不存在」把訊息回報我修。
-- ⚠️ wca_results 的實際成績資料「不在」本檔——本檔只建結構。成績由離線比對清單
--    經業主確認後，另出一份 INSERT SQL 匯入（見 scripts/wca-import/）。
-- ═══════════════════════════════════════════════════════════════════


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ (1) 教學排行分類版                                              ║
-- ╚═══════════════════════════════════════════════════════════════╝
-- 課程分類（單一事實來源，對照 src/lib/constants.js 的 COURSE_LABELS）：
--   big   = 合作機構（大班課）: collab_lead / collab_assistant / collab_project
--   small = 自家教學課（小班課）: 實體常態(初/進階)、線上/國外一對一、到府(2hr/1.5hr)、
--           冬夏令營、速解(到府/線上/培訓主講/培訓助教/營隊)、幼兒啟蒙(主/助)、特殊講座(有/無紀錄)
--   其餘（camp_director_* / cert_sub_judge / counter / event_booth / other）＝非授課角色，
--         計入 'all' 總時數榜，但不進大/小班榜。
--   ⚠️ 業主若要調整某類課歸屬，改下面兩個陣列即可（big_types / small_types）。
CREATE OR REPLACE FUNCTION public.get_teaching_leaderboard_v2(
  p_year     int  DEFAULT NULL,
  p_category text DEFAULT 'all'          -- 'all' | 'big' | 'small'
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
    AND (                                                         -- 課程分類過濾
      p_category = 'all'
      OR (p_category = 'big'   AND s.course_type = ANY(big_types))
      OR (p_category = 'small' AND s.course_type = ANY(small_types))
    )
  GROUP BY i.id, i.user_id, i.nickname, i.full_name, i.photo_path
  HAVING COUNT(s.id) > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_teaching_leaderboard_v2(int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard_v2(int, text) TO authenticated;


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ (2) WCA 欄位與成績表                                            ║
-- ╚═══════════════════════════════════════════════════════════════╝
-- 講師主檔加 WCA 綁定欄位（wca_id＝官方選手編號如 2012WUZH01；wca_name＝官方登記顯示名）
ALTER TABLE public.instructors ADD COLUMN IF NOT EXISTS wca_id   text;
ALTER TABLE public.instructors ADD COLUMN IF NOT EXISTS wca_name text;
COMMENT ON COLUMN public.instructors.wca_id   IS 'WCA 官方選手編號（如 2012WUZH01），經人工核對後綁定';
COMMENT ON COLUMN public.instructors.wca_name IS 'WCA 官方登記顯示名（羅馬拼音，供核對/顯示）';

-- 每位講師、每個項目的最佳成績（single / average）。時間單位＝百分之一秒(centiseconds)，
--   與 WCA 匯出一致；DNF/DNS 不存（存 NULL 或直接不建列）。前端負責格式化為 mm:ss.cs。
CREATE TABLE IF NOT EXISTS public.wca_results (
  id            bigserial PRIMARY KEY,
  instructor_id uuid NOT NULL REFERENCES public.instructors(id) ON DELETE CASCADE,
  event_id      text NOT NULL,                 -- '333' '222' '444' '333oh' 'pyram' ...
  best_single   int,                           -- centiseconds；無則 NULL
  best_average  int,                           -- centiseconds；無則 NULL
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instructor_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_wca_results_event ON public.wca_results (event_id);

-- RLS：登入者可讀（排行榜要用）；「不」開放前端寫入——成績只由 admin 經 SQL Editor
--   （service role，繞過 RLS）匯入，故不建 INSERT/UPDATE 政策＝預設拒絕，安全。
ALTER TABLE public.wca_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated can read wca_results" ON public.wca_results;
CREATE POLICY "Authenticated can read wca_results"
  ON public.wca_results FOR SELECT
  USING (auth.uid() IS NOT NULL);


-- ╔═══════════════════════════════════════════════════════════════╗
-- ║ (3) WCA 排行函式                                                ║
-- ╚═══════════════════════════════════════════════════════════════╝
-- 3a. 有成績的項目清單（給前端下拉選單用）——只回我們老師實際有成績的項目，
--     附各項目有幾人（single/average 分別計）。回傳順序照 sort_order。
CREATE OR REPLACE FUNCTION public.get_wca_events()
RETURNS TABLE (
  event_id     text,
  single_count bigint,
  average_count bigint
) AS $$
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
  GROUP BY r.event_id
  HAVING COUNT(*) FILTER (WHERE r.best_single IS NOT NULL) > 0
      OR COUNT(*) FILTER (WHERE r.best_average IS NOT NULL) > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_wca_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wca_events() TO authenticated;


-- 3b. 單一項目排行（p_type = 'single' | 'average'）。成績越小越前面；NULL 不列入。
CREATE OR REPLACE FUNCTION public.get_wca_leaderboard(
  p_event text,
  p_type  text DEFAULT 'single'          -- 'single' | 'average'
)
RETURNS TABLE (
  rank         bigint,
  instructor_id uuid,
  user_id      uuid,
  display_name text,
  photo_path   text,
  wca_id       text,
  best_ms      int                         -- centiseconds
) AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  SELECT
    ROW_NUMBER() OVER (ORDER BY val ASC)::bigint AS rank,
    t.instructor_id,
    t.user_id,
    t.display_name,
    t.photo_path,
    t.wca_id,
    t.val AS best_ms
  FROM (
    SELECT
      i.id AS instructor_id,
      i.user_id,
      COALESCE(i.nickname, i.full_name, i.wca_name, '匿名講師') AS display_name,
      i.photo_path,
      i.wca_id,
      CASE WHEN p_type = 'average' THEN r.best_average ELSE r.best_single END AS val
    FROM public.wca_results r
    JOIN public.instructors i ON i.id = r.instructor_id
    WHERE r.event_id = p_event
  ) t
  WHERE t.val IS NOT NULL
  ORDER BY t.val ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_wca_leaderboard(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_wca_leaderboard(text, text) TO authenticated;


-- ── 驗證（需登入 session；SQL Editor 直接跑會因 auth.uid()=null 被擋，屬正常）──────
--   SELECT * FROM public.get_teaching_leaderboard_v2(NULL, 'big')   ORDER BY total_hours DESC;
--   SELECT * FROM public.get_teaching_leaderboard_v2(NULL, 'small') ORDER BY total_hours DESC;
--   SELECT * FROM public.get_wca_events();
--   SELECT * FROM public.get_wca_leaderboard('333', 'single');
-- 結構驗證（不需登入，可直接在 SQL Editor 跑）：
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name='instructors' AND column_name IN ('wca_id','wca_name');
--   SELECT policyname FROM pg_policies WHERE tablename='wca_results';
