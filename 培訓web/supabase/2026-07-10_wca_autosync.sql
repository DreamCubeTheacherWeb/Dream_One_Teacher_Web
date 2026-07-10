-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-10  WCA 成績自動同步（取代手動代填）
-- ───────────────────────────────────────────────────────────────────
-- 業主 2026-07-10 定案：WCA 成績改由程式每兩個月自動抓 WCA 官方最新成績，
--   不再手動代填、不要手動按鈕。抓取+解析在 GitHub Actions（scripts/wca-sync/
--   sync.mjs）跑，透過本檔兩支「秘鑰保護」的 RPC 與 DB 溝通：
--     get_wca_sync_targets(secret)          → 回傳有 WCA ID 的講師清單
--     sync_wca_results(secret, payload)     → 覆蓋制寫入各講師成績
--
-- 安全設計：不把萬能的 service_role key 交給 CI；改用「共用秘鑰」——兩支函式
--   都先比對 wca_sync_config.secret，對了才動作。秘鑰只存在 (1) 這張表、
--   (2) GitHub Actions secret，前端完全接觸不到。授予 anon 執行，但沒有秘鑰
--   一律 raise exception。寫入仍在 DB 端二次驗證項目白名單與合理範圍（縱深防禦）。
--
-- 只同步 15 個標準時間項目（與站上白名單一致）；333fm/333mbf 特殊編碼不在此列。
-- 相依：2026-07-09_leaderboard_expansion.sql（wca_results 表）。
-- 冪等：CREATE OR REPLACE + IF NOT EXISTS。
-- ═══════════════════════════════════════════════════════════════════

-- ── 秘鑰設定表（RLS 全鎖，只有 SECURITY DEFINER 函式讀得到）──
CREATE TABLE IF NOT EXISTS public.wca_sync_config (
  id     int PRIMARY KEY DEFAULT 1,
  secret text NOT NULL,
  CONSTRAINT wca_sync_config_singleton CHECK (id = 1)
);
ALTER TABLE public.wca_sync_config ENABLE ROW LEVEL SECURITY;
-- 不建任何 policy＝前端（anon/authenticated）完全讀不到；只有 definer 函式能讀。

-- 自動產生一把隨機秘鑰（避免版控裡出現已知預設值的安全陷阱）。
-- 部署後執行 `SELECT secret FROM public.wca_sync_config;` 把它讀出來，
-- 貼到 GitHub Actions 的 WCA_SYNC_SECRET（兩邊必須一致）。
INSERT INTO public.wca_sync_config (id, secret)
VALUES (1, replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
ON CONFLICT (id) DO NOTHING;
--   想自訂秘鑰（可選）：UPDATE public.wca_sync_config SET secret = '你的長亂數' WHERE id = 1;

-- 追蹤最後同步時間（講師資料頁可顯示）
ALTER TABLE public.instructors ADD COLUMN IF NOT EXISTS wca_synced_at timestamptz;

-- ── (1) 取得同步對象：有填 WCA ID 的講師 ──
CREATE OR REPLACE FUNCTION public.get_wca_sync_targets(p_secret text)
RETURNS TABLE (instructor_id uuid, wca_id text) AS $$
BEGIN
  IF p_secret IS NULL OR NOT EXISTS (SELECT 1 FROM public.wca_sync_config WHERE id = 1 AND secret = p_secret) THEN
    RAISE EXCEPTION 'invalid sync secret';
  END IF;
  RETURN QUERY
    SELECT i.id, i.wca_id
      FROM public.instructors i
     WHERE i.wca_id IS NOT NULL AND btrim(i.wca_id) <> '';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── (2) 覆蓋制寫入：payload = [{instructor_id, wca_id, name, results:[{event_id,best_single,best_average}]}] ──
CREATE OR REPLACE FUNCTION public.sync_wca_results(p_secret text, p_payload jsonb)
RETURNS jsonb AS $$
DECLARE
  v_allowed  text[] := ARRAY['333','222','444','555','666','777','333oh',
                             '333bf','444bf','555bf','pyram','skewb','minx','clock','sq1'];
  person     jsonb;
  rec        jsonb;
  v_inst     uuid;
  v_name     text;
  v_event    text;
  v_single   int;
  v_average  int;
  v_people   int := 0;
  v_rows     int := 0;
BEGIN
  IF p_secret IS NULL OR NOT EXISTS (SELECT 1 FROM public.wca_sync_config WHERE id = 1 AND secret = p_secret) THEN
    RAISE EXCEPTION 'invalid sync secret';
  END IF;

  FOR person IN SELECT * FROM jsonb_array_elements(COALESCE(p_payload, '[]'::jsonb))
  LOOP
    v_inst := NULLIF(person->>'instructor_id', '')::uuid;
    IF v_inst IS NULL THEN CONTINUE; END IF;
    v_name := person->>'name';
    v_people := v_people + 1;

    -- 覆蓋：先清該講師所有可管理項目舊列
    DELETE FROM public.wca_results
     WHERE instructor_id = v_inst AND event_id = ANY(v_allowed);

    FOR rec IN SELECT * FROM jsonb_array_elements(COALESCE(person->'results', '[]'::jsonb))
    LOOP
      v_event := rec->>'event_id';
      IF v_event IS NULL OR NOT (v_event = ANY(v_allowed)) THEN CONTINUE; END IF;
      v_single  := NULLIF(rec->>'best_single', '')::int;
      v_average := NULLIF(rec->>'best_average', '')::int;
      IF v_single IS NOT NULL AND (v_single < 1 OR v_single > 360000) THEN v_single := NULL; END IF;
      IF v_average IS NOT NULL AND (v_average < 1 OR v_average > 360000) THEN v_average := NULL; END IF;
      IF v_single IS NULL AND v_average IS NULL THEN CONTINUE; END IF;

      INSERT INTO public.wca_results (instructor_id, event_id, best_single, best_average, updated_at)
      VALUES (v_inst, v_event, v_single, v_average, now())
      ON CONFLICT (instructor_id, event_id) DO UPDATE
        SET best_single = EXCLUDED.best_single,
            best_average = EXCLUDED.best_average,
            updated_at = now();
      v_rows := v_rows + 1;
    END LOOP;

    -- 記錄官方姓名與同步時間（wca_name 供比對，synced_at 供顯示）
    UPDATE public.instructors
       SET wca_name = COALESCE(v_name, wca_name),
           wca_synced_at = now()
     WHERE id = v_inst;
  END LOOP;

  RETURN jsonb_build_object('people', v_people, 'rows', v_rows, 'at', now());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 授權：anon 可執行（但沒有秘鑰會被擋）。撤 PUBLIC 泛授權。
REVOKE ALL     ON FUNCTION public.get_wca_sync_targets(text)         FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.sync_wca_results(text, jsonb)      FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_wca_sync_targets(text)         TO anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.sync_wca_results(text, jsonb)      TO anon, authenticated;

-- 驗證（結構）：
--   SELECT proname FROM pg_proc WHERE proname IN ('get_wca_sync_targets','sync_wca_results');
-- 驗證（秘鑰擋關）：帶錯秘鑰應 raise exception
--   SELECT public.get_wca_sync_targets('wrong');   -- 期望 error: invalid sync secret
-- 驗證（真跑，需先設好秘鑰）：由 GitHub Actions 或本機帶正確秘鑰呼叫。
