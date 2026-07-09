-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  WCA 資料管理（管理員清除不實資料）
-- ───────────────────────────────────────────────────────────────────
-- 需求：老師自填 WCA 編號後可能亂填；管理員要能「清除某老師的 WCA 資料」。
--   停權（取消排名資格＋鎖住送出）＝沿用既有 instructors.hide_from_leaderboard
--   （admin 可直接 UPDATE，RLS「Admins can do everything on instructors」已允許，
--    前端也會依此旗標鎖住個人頁的 WCA 送出欄位），故本檔不另建停權欄位。
-- 本檔只補一支「清除 WCA 資料」的 admin 函式（wca_results 沒有開放前端寫，
--   需 SECURITY DEFINER 才能刪）。相依：2026-07-09_leaderboard_expansion.sql、
--   2026-07-09_leaderboard_hide.sql。冪等：CREATE OR REPLACE。
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_clear_wca(p_instructor_id uuid)
RETURNS void AS $$
BEGIN
  -- 角色守衛（鐵律：SECURITY DEFINER 必加）
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin') THEN
    RAISE EXCEPTION 'admin only';
  END IF;

  DELETE FROM public.wca_results WHERE instructor_id = p_instructor_id;
  UPDATE public.instructors
     SET wca_id = NULL, wca_name = NULL
   WHERE id = p_instructor_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE ALL ON FUNCTION public.admin_clear_wca(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_clear_wca(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_clear_wca(uuid) TO authenticated;

-- 驗證（需登入 admin session；SQL Editor 直接跑會被守衛擋，屬正常）：
--   SELECT public.admin_clear_wca('<某 instructor_id>');
-- 結構驗證：
--   SELECT proname FROM pg_proc WHERE proname = 'admin_clear_wca';
