-- ═══════════════════════════════════════════════════════════════════
-- 講師端薪資／回報紀錄可見範圍：只看 2026-01-01 起的課程；參考表只給已核准角色讀
--   業主 2026-10-18 指示：「講師薪資可以看到的資料範圍先從 2026 年一月開始就好，
--   那之前的有些可能還要整理」。
--   做法：把日期門檻放在一個函式裡，RLS 政策引用它；之後要往前開放，只需
--   重新 CREATE OR REPLACE 這個函式改日期，不必重寫政策。
--   admin／mentor 不受影響（仍走 "Admins manage all sessions"）。
--   instructor_salary_summary 為 security_invoker view，會自動只彙總講師看得到的紀錄。
--   SECURITY DEFINER 函式（submit_my_class_session、quote_salary、排行榜）不受 RLS 影響。
-- 本檔可重複執行。
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.instructor_salary_visible_from()
RETURNS date
LANGUAGE sql
STABLE
SET search_path = ''
AS $$ SELECT DATE '2026-01-01' $$;

COMMENT ON FUNCTION public.instructor_salary_visible_from() IS
  '講師端可見的最早課程日期（含）。要往前開放：CREATE OR REPLACE 改回傳日期即可。';

-- Supabase 的預設權限會自動把新函式的 EXECUTE 給 anon，REVOKE PUBLIC 擋不到，必須明寫 anon
REVOKE ALL ON FUNCTION public.instructor_salary_visible_from() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.instructor_salary_visible_from() TO authenticated;

DROP POLICY IF EXISTS "Instructors view own sessions" ON public.class_sessions;
CREATE POLICY "Instructors view own sessions"
  ON public.class_sessions FOR SELECT TO authenticated
  USING (
    session_date >= public.instructor_salary_visible_from()
    AND instructor_id IN (
      SELECT id FROM public.instructors WHERE user_id = (SELECT auth.uid())
    )
  );

-- ── 參考表只給已核准角色讀（2026-10-18 資安審查：Google 登入即自動建 pending 帳號，
--    原政策 TO authenticated USING (true) 等於對任何人開放報酬表與合作單位清單）
DROP POLICY IF EXISTS "Everyone authenticated can view rate card" ON public.salary_rate_card;
DROP POLICY IF EXISTS "Approved roles can view rate card" ON public.salary_rate_card;
CREATE POLICY "Approved roles can view rate card"
  ON public.salary_rate_card FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
    )
  );

DROP POLICY IF EXISTS "Authenticated can view active salary report options" ON public.salary_report_options;
DROP POLICY IF EXISTS "Approved roles can view active salary report options" ON public.salary_report_options;
CREATE POLICY "Approved roles can view active salary report options"
  ON public.salary_report_options FOR SELECT TO authenticated
  USING (
    is_active = true
    AND EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
    )
  );

NOTIFY pgrst, 'reload schema';
