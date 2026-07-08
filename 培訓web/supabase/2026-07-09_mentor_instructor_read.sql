-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-09  mentor（輔導員）可讀講師名冊
-- 背景：/admin/instructors 頁面 mentor 進得去（App.jsx staffOnly），但 instructors
--       表的 RLS 只給 admin 全表讀（instructors_setup.sql:154-158），mentor 開頁近乎空白。
-- 範圍：只開 SELECT（看名冊）。新增/編輯/綁定仍限 admin——輔導員若日後需要編輯，另開政策。
-- 冪等：可重複執行。
-- ═══════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Mentors can view all instructors" ON public.instructors;
CREATE POLICY "Mentors can view all instructors"
  ON public.instructors FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'mentor')
  );

-- 讓 API 立即認得新政策（清 schema cache）
NOTIFY pgrst, 'reload schema';

-- ── 驗證：跑完應看到 instructors 表上有這條政策 ─────────────────────
-- SELECT policyname FROM pg_policies
-- WHERE tablename = 'instructors' AND policyname = 'Mentors can view all instructors';
