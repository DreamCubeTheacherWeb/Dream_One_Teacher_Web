-- ═══════════════════════════════════════════════════════════════════
-- 方塊競速：cube_solves 資料表 + 排行榜函式（2026-07-08 v2，可重複執行）
-- ───────────────────────────────────────────────────────────────────
-- 這是給老師之間輕鬆較勁的娛樂功能，不是正式賽事成績。
-- ⚠️ 已知限制：計時完全在前端瀏覽器裡進行（performance.now()），使用者
-- 技術上可以直接呼叫 insert 偽造時間/步數。這個風險屬內部娛樂功能可接受。
-- 下面的 CHECK 約束只擋離譜值（例如 0 秒、負數、一百萬步），不是防作弊機制。
--
-- v2 變更（新增兩種模式：鍵盤模式 virtual／實體計時 physical）：
--   - move_count 改為 nullable（實體計時不計步數，NULL）
--   - 新增 mode 欄位（'virtual' | 'physical'，預設 'virtual'）
--   - get_cube_leaderboard() 改為 get_cube_leaderboard(p_mode text) 按模式分榜
-- 本檔案設計成可安全重跑：不論是「從未執行過」或「已執行過 v1 舊版」，重跑
-- 一次都會把資料庫收斂到 v2 的最終形狀，不會報錯、不會重複建立物件。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 資料表（新裝：直接建成 v2 形狀；已存在則此語句是 no-op，
--        形狀差異交給下面第 1.1～1.3 節的 ALTER 補齊）───────────────
CREATE TABLE IF NOT EXISTS public.cube_solves (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  time_ms     int NOT NULL CHECK (time_ms >= 3000 AND time_ms <= 3600000),
  move_count  int,
  mode        text NOT NULL DEFAULT 'virtual',
  scramble    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 1.1 舊版補救：已跑過 v1（move_count NOT NULL、沒有 mode 欄位）的資料庫，
--        把它收斂成 v2 形狀。這些指令本身也是冪等的（already-在目標狀態時
--        不報錯），所以 v2 重跑一次也安全。────────────────────────────
ALTER TABLE public.cube_solves ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'virtual';
ALTER TABLE public.cube_solves ALTER COLUMN move_count DROP NOT NULL;

-- ── 1.2 move_count 的舊 CHECK（0 < move_count < 2000）不允許 NULL，
--        換成允許 NULL 的新版本（NULL＝實體計時不計步）。名稱沿用 Postgres
--        對單欄 column-level CHECK 的預設命名規則 <table>_<column>_check，
--        DROP IF EXISTS 讓這段指令本身也可重跑。──────────────────────
ALTER TABLE public.cube_solves DROP CONSTRAINT IF EXISTS cube_solves_move_count_check;
ALTER TABLE public.cube_solves ADD CONSTRAINT cube_solves_move_count_check
  CHECK (move_count IS NULL OR (move_count BETWEEN 10 AND 2000));

-- ── 1.3 mode 的合法值限制 ──────────────────────────────────────────
ALTER TABLE public.cube_solves DROP CONSTRAINT IF EXISTS cube_solves_mode_check;
ALTER TABLE public.cube_solves ADD CONSTRAINT cube_solves_mode_check
  CHECK (mode IN ('virtual', 'physical'));

-- ── 2. RLS：enable + insert + select，共三件。刻意不開 UPDATE/DELETE
--        政策——RLS 之下沒有政策＝該指令對所有人一律被拒，不必另外寫
--        deny 政策。排行榜不靠這條 SELECT 政策開放全表，走下面第 3 節
--        的 SECURITY DEFINER 函式（只回傳名次/暱稱/最佳成績）。────────
ALTER TABLE public.cube_solves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cube_solves insert own" ON public.cube_solves;
CREATE POLICY "cube_solves insert own"
  ON public.cube_solves FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "cube_solves select own" ON public.cube_solves;
CREATE POLICY "cube_solves select own"
  ON public.cube_solves FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());


-- ── 3. 排行榜函式：每人每模式的最佳成績（SECURITY DEFINER，繞過 RLS 讀全表聚合）──
-- v1 的零參數版本已被 p_mode 版取代，先清掉避免同名不同簽章的函式並存。
DROP FUNCTION IF EXISTS public.get_cube_leaderboard();

CREATE OR REPLACE FUNCTION public.get_cube_leaderboard(p_mode text DEFAULT 'virtual')
RETURNS TABLE (
  rank         bigint,
  user_id      uuid,
  display_name text,
  best_ms      int,
  solve_count  bigint
) AS $$
BEGIN
  IF p_mode NOT IN ('virtual', 'physical') THEN
    RAISE EXCEPTION 'invalid mode: %', p_mode;
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;

  RETURN QUERY
  SELECT
    ROW_NUMBER() OVER (ORDER BY MIN(cs.time_ms) ASC) AS rank,
    u.id AS user_id,
    COALESCE(i.nickname, i.full_name, u.name, split_part(u.email, '@', 1)) AS display_name,
    MIN(cs.time_ms)::int AS best_ms,
    COUNT(cs.id)::bigint AS solve_count
  FROM public.cube_solves cs
  JOIN public.users u ON u.id = cs.user_id
  LEFT JOIN public.instructors i ON i.user_id = u.id   -- 非講師（尚未認領資料）也能上榜
  WHERE cs.mode = p_mode
  GROUP BY u.id, i.nickname, i.full_name, u.name, u.email
  ORDER BY best_ms ASC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_cube_leaderboard(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cube_leaderboard(text) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- 驗證（SQL Editor 是 service role、不受 RLS 限制；下列函式呼叫在 SQL
-- Editor 直接跑會因 auth.uid() 為 null 而被擋，屬正常，需搭配應用程式
-- 的登入 session 驗證）
-- ═══════════════════════════════════════════════════════════════════
-- 1) 插一筆鍵盤模式假資料（把 <某個真實 user_id> 換成 auth.users 裡任一存在的 id）：
--      INSERT INTO public.cube_solves (user_id, time_ms, move_count, mode, scramble)
--      VALUES ('<某個真實 user_id>', 23456, 62, 'virtual', 'R U2 F R2 D L2 B U');
--    應該成功；把 time_ms 改成 500 或 move_count 改成 99999 應該被 CHECK 擋掉。
--
-- 2) 插一筆實體計時假資料（move_count 給 NULL，模擬拿真方塊計時）：
--      INSERT INTO public.cube_solves (user_id, time_ms, move_count, mode, scramble)
--      VALUES ('<某個真實 user_id>', 15230, NULL, 'physical', NULL);
--    應該成功；把 mode 改成 'foo' 應該被 CHECK 擋掉。
--
-- 3) 排行榜函式（需在應用程式的登入 session 下呼叫，才會有 auth.uid()）：
--      SELECT * FROM public.get_cube_leaderboard('virtual');
--      SELECT * FROM public.get_cube_leaderboard('physical');
--    應該分別只看到對應模式那筆換算出的名次、暱稱、最佳成績。
--
-- 4) 確認 RLS 擋住別人的列：在應用程式前端（不是 SQL Editor）以另一位
--    使用者的登入 session 執行
--      supabase.from('cube_solves').select()
--    應該只回自己 insert 過的列，看不到步驟 1/2 那兩筆別人的資料。
