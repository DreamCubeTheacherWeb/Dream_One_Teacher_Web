-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-10  WCA 成績改「後台代填」，關閉老師自填
-- ───────────────────────────────────────────────────────────────────
-- 需求（業主 2026-07-10 指示）：個人頁的 WCA 區塊，老師只能填「WCA 選手編號」，
--   不再自己新增項目與成績；各項目最佳成績改由 admin 在後台（WcaManager）針對
--   每位講師個別登錄。
--
-- 本檔做兩件事：
--   (1) 新增 admin 專用寫入函式 admin_upsert_wca_results(instructor, results)
--       —— replace 語意：以傳入清單覆蓋該講師「可管理項目」的舊成績。
--   (2) 撤銷老師自填函式 upsert_my_wca_results 的執行權（安全關鍵）：
--       光把前端表單移除不夠，登入者仍可直接呼叫該 RPC 塞成績；必須從後端斷掉。
--       —— 依 CLAUDE.md 權限模型：前端守衛只是體驗層，權限邊界一律靠後端。
--
-- 白名單（可管理的時間制項目，與老師自填時代一致，不含 333fm/333mbf 特殊格式匯入項）：
--   333,222,444,555,666,777,333oh,333bf,444bf,555bf,pyram,skewb,minx,clock,sq1
-- 相依：2026-07-09_leaderboard_expansion.sql（wca_results 表）、
--       2026-07-09_wca_self_report.sql（被本檔撤權的 upsert_my_wca_results）。
-- 冪等：CREATE OR REPLACE + REVOKE（可重複執行）。
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_upsert_wca_results(
  p_instructor_id uuid,
  p_results       jsonb
)
RETURNS void AS $$
DECLARE
  v_allowed  text[] := ARRAY['333','222','444','555','666','777','333oh',
                             '333bf','444bf','555bf','pyram','skewb','minx','clock','sq1'];
  rec        jsonb;
  v_event    text;
  v_single   int;
  v_average  int;
BEGIN
  -- 角色守衛（鐵律：SECURITY DEFINER 必加）：僅 admin
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  IF p_instructor_id IS NULL THEN
    RAISE EXCEPTION 'instructor id required';
  END IF;

  -- 先清掉該講師所有「可管理項目」舊列（特殊格式匯入列不動）
  DELETE FROM public.wca_results
   WHERE instructor_id = p_instructor_id
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
    VALUES (p_instructor_id, v_event, v_single, v_average, now())
    ON CONFLICT (instructor_id, event_id) DO UPDATE
      SET best_single  = EXCLUDED.best_single,
          best_average = EXCLUDED.best_average,
          updated_at   = now();
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL     ON FUNCTION public.admin_upsert_wca_results(uuid, jsonb) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.admin_upsert_wca_results(uuid, jsonb) FROM anon;
GRANT  EXECUTE ON FUNCTION public.admin_upsert_wca_results(uuid, jsonb) TO authenticated;

-- ───────────────────────────────────────────────────────────────────
-- (2) 關閉老師自填：撤銷 upsert_my_wca_results 的執行權。
--     函式本體保留（可回復），但任何一般登入者都不能再呼叫，避免繞過前端塞成績。
-- ───────────────────────────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION public.upsert_my_wca_results(jsonb) FROM authenticated;
REVOKE ALL     ON FUNCTION public.upsert_my_wca_results(jsonb) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.upsert_my_wca_results(jsonb) FROM anon;

-- 驗證（結構）：
--   SELECT proname FROM pg_proc WHERE proname IN ('admin_upsert_wca_results','upsert_my_wca_results');
-- 驗證（權限已撤）：authenticated 對 upsert_my_wca_results 應無 EXECUTE
--   SELECT has_function_privilege('authenticated', 'public.upsert_my_wca_results(jsonb)', 'EXECUTE');  -- 期望 f
-- 驗證（行為，需登入 admin session）：
--   SELECT public.admin_upsert_wca_results('<instructor_id>', '[{"event_id":"333","best_single":900,"best_average":1100}]'::jsonb);
--   SELECT event_id, best_single, best_average FROM public.wca_results WHERE instructor_id = '<instructor_id>';
