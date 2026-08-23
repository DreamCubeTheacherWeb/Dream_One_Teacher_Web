-- 公告是講師資源站內部內容：匿名與待審核帳號不得讀取。
BEGIN;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Everyone can view published announcements" ON public.announcements;
DROP POLICY IF EXISTS "Approved users can view published announcements" ON public.announcements;

REVOKE ALL ON public.announcements FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.announcements TO authenticated;

CREATE POLICY "Approved users can view published announcements"
  ON public.announcements
  FOR SELECT
  TO authenticated
  USING (
    published = true
    AND EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role IN ('teacher', 'mentor', 'admin')
    )
  );

COMMIT;
