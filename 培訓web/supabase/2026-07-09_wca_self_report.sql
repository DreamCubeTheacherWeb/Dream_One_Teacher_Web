-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  WCA 各項目成績「老師自填」
-- ───────────────────────────────────────────────────────────────────
-- 需求：個人頁的 WCA 區塊不再只填一個 WCA ID，老師要能自己填「各個項目」的
--   最佳成績（單次／平均），填完就會出現在排行榜「WCA 賽事」榜。
-- 背景：wca_results 原本「只由 admin 經 SQL Editor（service role）匯入」，前端不可寫
--   （見 2026-07-09_leaderboard_expansion.sql 的 RLS 註解）。本檔補一支
--   SECURITY DEFINER 函式讓「登入者只能改自己那一列」，維持前端無直接寫入權。
--
-- 語意（replace-my-results）：呼叫時傳入老師想保留的完整清單，函式會
--   （1）刪掉本人所有「可自填項目」的舊列，（2）重新寫入傳入的非空成績。
--   特殊格式項目（333fm 最少步、333mbf 多顆盲解）不在白名單內＝匯入列保留、
--   老師不可自填（格式難自填，避免亂填）。
-- 防濫用：停權者（instructors.hide_from_leaderboard = true）呼叫直接被擋。
-- 相依：2026-07-09_leaderboard_expansion.sql（wca_results 表）、
--       2026-07-09_leaderboard_hide.sql（hide_from_leaderboard 欄位）。
-- 冪等：CREATE OR REPLACE。
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.upsert_my_wca_results(p_results jsonb)
RETURNS void AS $$
DECLARE
  v_instructor uuid;
  v_hidden     boolean;
  -- 可自填的時間制項目白名單（與匯入排除規則一致：不含 333fm / 333mbf）
  v_allowed    text[] := ARRAY['333','222','444','555','666','777','333oh',
                               '333bf','444bf','555bf','pyram','skewb','minx','clock','sq1'];
  rec        jsonb;
  v_event    text;
  v_single   int;
  v_average  int;
BEGIN
  -- 角色守衛（鐵律）：必須登入
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  -- 只能改「自己」那一列：以 user_id 對應本人 instructor 列
  SELECT id, hide_from_leaderboard
    INTO v_instructor, v_hidden
    FROM public.instructors
   WHERE user_id = auth.uid()
   LIMIT 1;

  IF v_instructor IS NULL THEN
    RAISE EXCEPTION '找不到你的講師資料，請先儲存基本資料';
  END IF;

  -- 停權者不可送出（沿用停權旗標）
  IF COALESCE(v_hidden, false) THEN
    RAISE EXCEPTION '你的 WCA 送出資格已被停用';
  END IF;

  -- 先清掉本人所有「可自填項目」舊列（特殊格式匯入列不動）
  DELETE FROM public.wca_results
   WHERE instructor_id = v_instructor
     AND event_id = ANY(v_allowed);

  -- 逐筆寫入（跳過非白名單、兩值皆空、或超出合理範圍者）
  FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(p_results, '[]'::jsonb))
  LOOP
    v_event := rec->>'event_id';
    IF v_event IS NULL OR NOT (v_event = ANY(v_allowed)) THEN
      CONTINUE;
    END IF;

    v_single  := NULLIF(rec->>'best_single', '')::int;
    v_average := NULLIF(rec->>'best_average', '')::int;

    -- 合理範圍：1 .. 360000 centiseconds（<= 1 小時），超出視為未填
    IF v_single IS NOT NULL AND (v_single < 1 OR v_single > 360000) THEN
      v_single := NULL;
    END IF;
    IF v_average IS NOT NULL AND (v_average < 1 OR v_average > 360000) THEN
      v_average := NULL;
    END IF;

    IF v_single IS NULL AND v_average IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO public.wca_results (instructor_id, event_id, best_single, best_average, updated_at)
    VALUES (v_instructor, v_event, v_single, v_average, now())
    ON CONFLICT (instructor_id, event_id) DO UPDATE
      SET best_single  = EXCLUDED.best_single,
          best_average = EXCLUDED.best_average,
          updated_at   = now();
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL     ON FUNCTION public.upsert_my_wca_results(jsonb) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.upsert_my_wca_results(jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.upsert_my_wca_results(jsonb) TO authenticated;

-- 驗證（結構）：
--   SELECT proname FROM pg_proc WHERE proname = 'upsert_my_wca_results';
-- 驗證（行為，需登入老師 session）：填幾筆後
--   SELECT event_id, best_single, best_average FROM public.wca_results
--    WHERE instructor_id = (SELECT id FROM public.instructors WHERE user_id = auth.uid());
