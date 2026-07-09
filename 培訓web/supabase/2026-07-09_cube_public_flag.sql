-- ═══════════════════════════════════════════════════════════════════
-- 方塊競速：成績可見度（公開排行榜／只存自己的紀錄）（2026-07-09，可重複執行）
-- ───────────────────────────────────────────────────────────────────
-- 依賴 2026-07-08_cube_speed.sql 已建立的 public.cube_solves 與
-- public.get_cube_leaderboard(p_mode text)（該檔已套用於正式庫，不可再改）。
-- 本檔只新增一個欄位＋收斂排行榜函式的過濾條件，其餘（RLS、CHECK 約束、
-- mode 欄位邏輯）維持 2026-07-08 版不動。
--
-- 安全順序：先跑本 SQL 或先部署前端皆安全。
--   - is_public 新增時 DEFAULT true，既有成績一律視為「已公開」（向後相容，
--     排行榜排名不會因這次遷移而突然清空)。
--   - 前端若還沒部署新版，insert 不帶 is_public 欄位 → 落地為欄位預設值 true
--     （＝公開），行為與遷移前完全一致。
--   - 前端若先部署新版但 SQL 還沒跑，insert 帶 is_public 欄位會因為欄位不存在
--     而報錯；前端已內建防呆重試（拿掉 is_public 欄位重送一次），使用者體驗
--     上只是「公開設定要等資料庫更新後才會生效」，不會整個送出失敗。
-- 本檔可安全重跑：不論「從未執行過」或「已執行過一次」，重跑一次都會把資料庫
-- 收斂到本檔的最終形狀，不會報錯、不會重複建立物件。
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. 新欄位：是否公開到排行榜 ─────────────────────────────────────
-- 既有成績（欄位新增前就存在的列）一律拿到 DEFAULT true，等同「維持現況：
-- 現有排行榜排名不變」。
ALTER TABLE public.cube_solves ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT true;

-- ── 2. 排行榜函式：與 2026-07-08 版完全一致，只多一條 is_public 過濾。
--        solve_count 沿用 COUNT(cs.id)，因為 WHERE 已經先篩掉私人成績，
--        所以自然只計公開筆數，不必另外調整。──────────────────────────
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
    AND cs.is_public = true                            -- 只計公開成績（2026-07-09 新增）
  GROUP BY u.id, i.nickname, i.full_name, u.name, u.email
  ORDER BY best_ms ASC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.get_cube_leaderboard(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_cube_leaderboard(text) TO authenticated;


-- ═══════════════════════════════════════════════════════════════════
-- 驗證（SQL Editor 是 service role、不受 RLS 限制；get_cube_leaderboard 在
-- SQL Editor 直接跑會因 auth.uid() 為 null 而被擋，屬正常，需搭配應用程式
-- 的登入 session 驗證）
-- ═══════════════════════════════════════════════════════════════════
-- 1) 確認欄位已存在且既有資料預設為公開：
--      SELECT is_public, count(*) FROM public.cube_solves GROUP BY is_public;
--    遷移前既有的列應全數是 is_public = true。
--
-- 2) 插一筆私人成績（把 <某個真實 user_id> 換成 auth.users 裡任一存在的 id）：
--      INSERT INTO public.cube_solves (user_id, time_ms, move_count, mode, scramble, is_public)
--      VALUES ('<某個真實 user_id>', 23456, 62, 'virtual', 'R U2 F R2 D L2 B U', false);
--    應該成功。
--
-- 3) 排行榜函式應該看不到步驟 2 那筆私人成績（需在應用程式的登入 session 下呼叫）：
--      SELECT * FROM public.get_cube_leaderboard('virtual');
--    步驟 2 插入的 user_id 若沒有其他公開成績，不應出現在結果中；
--    若該使用者原本就有公開成績，best_ms 應維持原本公開成績中最快的一筆，
--    不會被剛才那筆私人成績（就算它更快）取代。
--
-- 4) 確認 RLS 仍只擋住別人的列（本檔未動 RLS 政策）：
--      在應用程式前端（不是 SQL Editor）以另一位使用者的登入 session 執行
--      supabase.from('cube_solves').select()
--      應該只回自己 insert 過的列（含公開與私人的都看得到，因為 RLS 是
--      per-user，不是 per-visibility；is_public 只影響 get_cube_leaderboard()
--      這個聚合函式回傳的內容，不影響本人查自己的資料）。
