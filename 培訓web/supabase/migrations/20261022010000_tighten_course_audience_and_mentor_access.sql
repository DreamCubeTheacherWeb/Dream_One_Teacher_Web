-- 2026-10-22 權限收斂（正式庫 2026-10-22 00:2x 唯讀盤點發現的兩個問題）。可重跑。
--
-- A. 課程受眾被繞過
--    courses／lessons／contents 各有兩條 permissive SELECT 政策（PostgreSQL 以 OR 合併）：
--    "Approved users ..."（20260823094617，含大分類已發佈＋分類／課程受眾檢查）與
--    "Complete teachers ..."（20260819153000，只看已發佈＋講師＋資料完整，沒有受眾檢查）。
--    後者讓所有資料完整的講師讀得到「限實習／限正式」課程與「大分類未發佈」的課程。
--    處理：移除三條 "Complete teachers ..."；三條 "Approved users ..." 以與正式庫相同的條件重建，
--    確保結果與正式庫現況無關、可重跑。
--    合法講師不受影響：Approved 條件＝已發佈 ∧ 大分類已發佈 ∧ 分類受眾 ∧ role='teacher'
--    ∧ is_my_instructor_profile_complete()（已排除凍結／取消）∧ 課程受眾；
--    受眾 'all' 的課程對所有資料完整的講師為真。章節／內容透過子查詢經過 courses／lessons 的 RLS。
--    admin／mentor 照舊由 "Staff can manage courses/lessons/contents" 讀寫（本檔不動）。
--
-- B. 輔導員（mentor）可寫任何講師主檔
--    正式庫 instructors 有一條不在 repo 裡的 "Staff can manage instructors" FOR ALL（admin、mentor），
--    mentor 因此可透過 API 新增／修改／刪除任何講師主檔。admin 另有
--    "Admins can do everything on instructors" FOR ALL，故直接移除 Staff 那條，並以 20260826130000
--    的同一份條件重建 admin 政策，確保移除後 admin 一定保有全權。
--
--    mentor 讀全表（身分證字號、銀行帳號等）的兩條 SELECT 政策
--    "Mentors can view all instructors"／"Mentors and admins can view all instructor profiles"
--    本檔「刻意不移除」：輔導員可進的 /admin/download-center（DownloadCenter）會用講師主檔產生
--    匯款申請書（身分證字號、銀行帳號），/admin/instructors（InstructorList）的展開明細與「預覽表單」
--    也直接顯示個資。移除前需業主決定這兩頁是否改成只限 admin。
--    先提供只回非敏感欄位的 public.mentor_instructor_directory()，業主決定後前端改用它再移除兩條政策。

-- ── A. 課程受眾 ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Complete teachers can view published courses" ON public.courses;
DROP POLICY IF EXISTS "Complete teachers can view published lessons" ON public.lessons;
DROP POLICY IF EXISTS "Complete teachers can view published contents" ON public.contents;

DROP POLICY IF EXISTS "Approved users can view published courses" ON public.courses;
CREATE POLICY "Approved users can view published courses"
  ON public.courses FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (
      SELECT 1
      FROM public.course_categories category
      WHERE category.id = category_id
        AND category.is_published = true
        AND (SELECT private.can_view_training_audience(category.visibility))
    )
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher'
    )
    AND (SELECT public.is_my_instructor_profile_complete())
    AND (SELECT private.can_view_training_audience(visibility))
  );

DROP POLICY IF EXISTS "Approved users can view published lessons" ON public.lessons;
CREATE POLICY "Approved users can view published lessons"
  ON public.lessons FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (
      SELECT 1 FROM public.courses c
      WHERE c.id = course_id AND c.is_published = true
    )
  );

DROP POLICY IF EXISTS "Approved users can view contents" ON public.contents;
CREATE POLICY "Approved users can view contents"
  ON public.contents FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (
      SELECT 1 FROM public.lessons l
      WHERE l.id = lesson_id AND l.is_published = true
    )
  );

-- ── B. 講師主檔：mentor 不可寫 ──────────────────────────────────────

DROP POLICY IF EXISTS "Staff can manage instructors" ON public.instructors;

DROP POLICY IF EXISTS "Admins can do everything on instructors" ON public.instructors;
CREATE POLICY "Admins can do everything on instructors"
  ON public.instructors
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.users u
      WHERE u.id = (SELECT auth.uid())
        AND u.role = 'admin'
    )
  );

-- ── B'. 講師名冊（非敏感欄位），給 admin／mentor 的後台頁面用 ──────────
-- 只回 id、user_id、姓名、暱稱、等級、在職狀態、接課地區、速解資格；
-- 身分證字號、生日、電話、地址、銀行資料、證件檔案路徑一律不回。
CREATE OR REPLACE FUNCTION public.mentor_instructor_directory(p_user_ids uuid[] DEFAULT NULL)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  full_name text,
  nickname text,
  instructor_role text,
  employment_status text,
  teaching_regions text[],
  speed_qualification text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.users u
    WHERE u.id = auth.uid()
      AND u.role IN ('admin', 'mentor')
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'only admins and mentors can read the instructor directory';
  END IF;

  RETURN QUERY
  SELECT
    i.id,
    i.user_id,
    i.full_name::text,
    i.nickname::text,
    i.instructor_role::text,
    i.employment_status::text,
    i.teaching_regions::text[],
    i.speed_qualification::text
  FROM public.instructors i
  WHERE p_user_ids IS NULL OR i.user_id = ANY (p_user_ids)
  ORDER BY i.full_name;
END;
$$;

-- Supabase 預設會把新函式的 EXECUTE 發給 anon，REVOKE PUBLIC 擋不到，必須明寫 anon
REVOKE ALL ON FUNCTION public.mentor_instructor_directory(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mentor_instructor_directory(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
