-- ═══════════════════════════════════════════════════════════════════
-- 綁定講師主檔「還沒啟用」的帳號，讀不到這份主檔背後的上課、報酬與徽章資料（2026-10-23 資安審查必修 1）
--
-- 問題：電子簽約線讓所有認領路徑（Email 對應、姓名＋手機＋末四碼、姓名空位）都改成「只綁不開通」——
--   綁定後 users.role 仍是 pending，要用 Email 驗證碼啟用才變 teacher。但下面幾條讀取規則只看
--   instructors.user_id = auth.uid()，不看角色：任何人用自己的 Google 登入、輸入同名就綁到空位，
--   還沒過驗證碼就能用 REST 讀這個空位原本的上課紀錄與報酬（class_sessions 的金額欄位）。
--   2026-10-23 總指揮唯讀預檢：正式庫有 128 份「未綁帳號、但已有上課紀錄」的主檔，其中 2 份四項個資全空，
--   按 20261020100000 的姓名空位判定今天就能被認領。
--
-- 修法（兩層）：
--   A. 讀取規則：凡是「經由 instructors.user_id = auth.uid() 把別張表的資料開給本人」的地方，
--      再加一個條件「本人 users.role IN ('teacher','mentor','admin')」＝private.current_user_is_approved_account()。
--      選角色而不是「有 status='active' 的啟用紀錄」的理由：
--        * 角色由伺服器控制（pending→teacher 只發生在 verify_email_otp 啟用成功、或 admin 核准／手動綁定），
--          綁定者自己改不了；
--        * 既有 teacher 不一定有啟用紀錄（D4 只補「套用當下已綁主檔」的人；之後在 /profile 自建主檔、
--          或被行政用角色下拉改成 teacher 的人都沒有），用啟用紀錄當門檻會讓這些老師看不到自己的報酬；
--        * mentor／admin 是邀請制 staff，本來就沒有啟用紀錄。
--   B. 認領判定：已有上課或報酬紀錄的姓名空位不能只靠姓名認領——寫在 20261020100000 的
--      claim_instructor_name_slot（該檔尚未上線；放在那裡，日後單獨重跑 100000 也不會把這條判定蓋掉）。
--
-- 盤點（以正式庫順序建庫後查 pg_policies／pg_proc；每條以最後一次定義的版本為底，只多加角色條件）：
--   加條件：
--     * class_sessions "Instructors view own sessions"（最後定義：20261018150000）——上課紀錄與報酬金額；
--       security_invoker 的 instructor_salary_summary（我的報酬彙總、黃卡）跟著這條走。
--     * storage.objects "Users can view files referenced by own instructor profile"（最後定義：20260826130000）——
--       主檔路徑指到的照片／證件／存摺影像（不在本人 uid 資料夾、由匯入或前一位綁定者留下的檔）。
--       本人 uid 資料夾的 "Users can view own instructor files" 不動（pending 補資料時要看自己剛上傳的檔）。
--     * badge_overrides "badge_ovr read"（最後定義：2026-07-09_badges_foundation.sql）——後台頒給這個主檔的徽章。
--       原本 roles＝public、USING auth.uid() IS NOT NULL；改成 TO authenticated（anon 本來就讀不到，因為 anon 的
--       auth.uid() 是 NULL），才能呼叫 private schema 的判斷函式。
--     * get_teacher_badge_stats(uuid)（最後定義：2026-07-09_gamify_compute.sql）——/profile「我的教學成就」用它算
--       這個主檔的總時數、堂數、學生數；未啟用者回空集合（畫面顯示全部未解鎖，不會報錯）。
--     * get_teaching_leaderboard(int)（2026-07-08_teaching_leaderboard.sql）、get_teaching_leaderboard_v2(int,text)
--       （最後定義：2026-07-09_leaderboard_hide.sql）——每位講師的教學時數與學生數；未啟用者回空集合。
--       pending 本來就進不了排行榜頁（前端導回 /pending），這裡補上資料庫端的門。
--   判定不用加：
--     * instructors 本人讀寫（"Users can view/update own instructor profile"）：pending 要在 /profile 填資料、
--       啟用前確認資料；空位能被姓名認領的前提是主檔沒有任何個資。
--     * instructor_edit_unlocks 本人讀取：只有解鎖範圍與時間，沒有個資或課務資料；pending 補資料時要靠它改被鎖的證件欄位。
--     * instructor_document_changes、class_sessions_quarantine、salary_master_rows、salary_payout_exports／items：
--       只有 admin 讀得到。
--     * instructor_contracts、contract_consent_records、contract_signing_evidence、instructor_account_activations、
--       notifications、instructor_profile_drafts、cube_solves：以 user_id（帳號）比對，不是以主檔比對，
--       綁到別人的主檔也讀不到前一位綁定者的資料。
--     * salary_rate_card、salary_report_fields／options、salary_payout_schedule、contract_documents：已限 teacher／mentor／admin。
--     * submit_my_class_session：已限 teacher／mentor／admin。ensure_my_contract_reminder：已排除 pending。
--     * get_my_activation_status、request_email_otp、verify_email_otp、is_my_instructor_profile_complete：啟用流程本身要用。
--     * get_teaching_years：只回「有課的年份」，沒有個別講師的資料。
--     * WCA／魔方計時／互動排行榜：資料來源（wca_results、公開的 cube_solves、留言按讚）本來就對所有登入者開放，
--       不是空位綁定才看得到的資料。
--
-- 套用順序：20261019233000 → 20261020100000 → 20261022120000 → 本檔，四支連續套用（見 STATUS.md）。
-- 可重複執行；不刪任何資料。
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- DROP／CREATE POLICY 要拿 class_sessions、storage.objects、badge_overrides 的表鎖；拿不到 5 秒就整批放棄
SET LOCAL lock_timeout = '5s';

-- ──────────────────────────────────────────────────────────────────
-- 0. 判斷函式：本人是不是已核准的帳號（teacher／mentor／admin）
-- ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.current_user_is_approved_account()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.users u
     WHERE u.id = (SELECT auth.uid())
       AND u.role IN ('teacher', 'mentor', 'admin')
  );
$$;

COMMENT ON FUNCTION private.current_user_is_approved_account() IS
  '本人 users.role 是 teacher／mentor／admin。綁定講師主檔但還沒用 Email 驗證碼啟用的帳號（pending）回 false。'
  '凡是經由 instructors.user_id = auth.uid() 開放主檔關聯資料的讀取規則都要加這個條件（20261023100000）。';

-- Supabase 的預設權限會自動把新函式的 EXECUTE 給 anon，REVOKE PUBLIC 擋不到，必須明寫 anon
REVOKE ALL ON FUNCTION private.current_user_is_approved_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_user_is_approved_account() TO authenticated;

-- ──────────────────────────────────────────────────────────────────
-- 1. 上課紀錄與報酬（底：20261018150000）
-- ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Instructors view own sessions" ON public.class_sessions;
CREATE POLICY "Instructors view own sessions"
  ON public.class_sessions FOR SELECT TO authenticated
  USING (
    session_date >= public.instructor_salary_visible_from()
    AND instructor_id IN (
      SELECT id FROM public.instructors WHERE user_id = (SELECT auth.uid())
    )
    AND (SELECT private.current_user_is_approved_account())
  );

-- ──────────────────────────────────────────────────────────────────
-- 2. 主檔路徑指到的影像（底：20260826130000）
-- ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can view files referenced by own instructor profile" ON storage.objects;
CREATE POLICY "Users can view files referenced by own instructor profile"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (
      SELECT 1
      FROM public.instructors i
      WHERE i.user_id = (SELECT auth.uid())
        AND name IN (
          i.photo_path,
          i.id_front_path,
          i.id_back_path,
          i.bankbook_path
        )
    )
    AND (SELECT private.current_user_is_approved_account())
  );

-- ──────────────────────────────────────────────────────────────────
-- 3. 後台頒發的徽章（底：2026-07-09_badges_foundation.sql）
-- ──────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "badge_ovr read" ON public.badge_overrides;
CREATE POLICY "badge_ovr read" ON public.badge_overrides FOR SELECT
  TO authenticated
  USING ((SELECT private.current_user_is_approved_account()));

-- ──────────────────────────────────────────────────────────────────
-- 4. 由上課紀錄算出來的統計函式：未啟用者回空集合
--    函式本體照最後定義的版本原樣保留，只在「必須登入」之後多一段角色檢查。
-- ──────────────────────────────────────────────────────────────────

-- 4.1 成就統計（底：2026-07-09_gamify_compute.sql）
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

  -- 2026-10-23：綁定主檔但還沒啟用（pending）的帳號看不到任何講師的統計
  IF NOT (SELECT private.current_user_is_approved_account()) THEN
    RETURN;
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

-- 4.2 教學排行榜 v1（底：2026-07-08_teaching_leaderboard.sql；前端已改用 v2，但仍可呼叫）
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

  -- 2026-10-23：綁定主檔但還沒啟用（pending）的帳號看不到排行榜
  IF NOT (SELECT private.current_user_is_approved_account()) THEN
    RETURN;
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

-- 4.3 教學排行榜 v2（底：2026-07-09_leaderboard_hide.sql）
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

  -- 2026-10-23：綁定主檔但還沒啟用（pending）的帳號看不到排行榜
  IF NOT (SELECT private.current_user_is_approved_account()) THEN
    RETURN;
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

-- 權限照 20260819160000：只給 authenticated（Supabase 預設會把 EXECUTE 給 anon，要明寫 REVOKE anon）
REVOKE ALL ON FUNCTION public.get_teacher_badge_stats(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_teaching_leaderboard(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_teaching_leaderboard_v2(integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_teacher_badge_stats(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_teaching_leaderboard_v2(integer, text) TO authenticated;

COMMIT;
