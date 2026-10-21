\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

-- ═══════════════════════════════════════════════════════════════════
-- migration 20261022010000（課程受眾＋輔導員權限）的隔離驗證
--   第一段：照 2026-10-22 正式庫唯讀盤點的政策組合建庫（含 20260826130000 的三條 restrictive），先重現：
--           A. 資料完整的講師讀得到不屬於自己受眾（限正式／限實習）與大分類未發佈的課程、章節、內容
--           B. mentor 讀得到全部講師的身分證字號、銀行帳號、證件影像，能讀寫刪任何人的報酬紀錄；
--              mentor 改／刪別人主檔在正式庫已被 restrictive 擋住，但拿掉 restrictive 就會開
--              （"Staff can manage instructors" 是潛在漏洞）
--   第二段：套 migration 兩次，逐角色驗證受眾生效、合法講師不受影響、admin 全權、
--           mentor 不能寫主檔（即使 restrictive 不在）、讀不到主檔／敏感欄位／證件檔／報酬紀錄、
--           可經 public.mentor_instructor_directory() 讀非敏感欄位；講師本人的主檔、證件檔、報酬紀錄照舊。
-- 模擬 Supabase：auth.uid() 讀 request.jwt.claims；public 表權限預設發給 anon／authenticated，
-- public 新函式的 EXECUTE 也預設發給 anon／authenticated（所以 migration 必須明寫 REVOKE anon）。
-- private.* 與 is_my_instructor_profile_complete() 照 repo 最新定義建立（本 migration 不改它們）。
-- ═══════════════════════════════════════════════════════════════════

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;

CREATE TYPE public.instructor_role_enum AS ENUM ('S', 'A+', 'A', 'B', '實習');
CREATE TYPE public.tw_county AS ENUM ('臺北市', '新北市', '臺中市', '高雄市');
CREATE TYPE public.employment_status_enum AS ENUM ('active', 'staff', 'assistant', 'part_time', 'frozen', 'cancelled');

CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);

CREATE TABLE public.instructors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid UNIQUE REFERENCES auth.users(id),
  full_name text NOT NULL,
  nickname text,
  gender text,
  birth_date date,
  id_number text,
  phone_mobile text,
  line_id text,
  address text,
  household_address text,
  email_primary text NOT NULL DEFAULT 'x@test.local',
  teaching_freq_semester text,
  teaching_freq_vacation text,
  teaching_regions public.tw_county[] NOT NULL DEFAULT '{臺北市}',
  bio_notes text,
  bank_account_name text,
  bank_name text,
  bank_branch text,
  bank_account_number text,
  bank_code text,
  id_front_path text, id_front_external_url text,
  id_back_path text, id_back_external_url text,
  bankbook_path text, bankbook_external_url text,
  photo_path text,
  employment_status public.employment_status_enum,
  instructor_role public.instructor_role_enum,
  speed_qualification text,
  note_internal text
);

CREATE TABLE public.course_categories (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  visibility text NOT NULL DEFAULT 'all' CHECK (visibility IN ('all', 'intern', 'formal')),
  is_published boolean NOT NULL DEFAULT false,
  "order" integer NOT NULL DEFAULT 0
);
CREATE TABLE public.courses (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  is_published boolean DEFAULT false,
  "order" int DEFAULT 0,
  visibility text DEFAULT 'all',
  category_id uuid NOT NULL REFERENCES public.course_categories(id)
);
CREATE TABLE public.lessons (
  id uuid PRIMARY KEY,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  title text NOT NULL,
  "order" int DEFAULT 0,
  is_published boolean DEFAULT false
);
CREATE TABLE public.contents (
  id uuid PRIMARY KEY,
  lesson_id uuid NOT NULL REFERENCES public.lessons(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'article',
  title text NOT NULL,
  body text,
  position_data jsonb,
  "order" int DEFAULT 0,
  status text DEFAULT 'draft'
);

-- ── private helpers（照 repo 最新定義：20260819153000、2026-08-24、20260823094617） ──
CREATE SCHEMA private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE FUNCTION private.current_user_is_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS (SELECT 1 FROM public.users WHERE id = (SELECT auth.uid()) AND role IN ('admin', 'mentor')) $$;

CREATE FUNCTION private.current_user_is_teacher() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users u JOIN public.instructors i ON i.user_id = u.id
    WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher'
      AND i.employment_status::text IS DISTINCT FROM 'frozen'
      AND i.employment_status::text IS DISTINCT FROM 'cancelled'
  );
$$;

CREATE FUNCTION private.can_view_training_audience(required_visibility text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE COALESCE(required_visibility, 'all')
    WHEN 'all' THEN true
    WHEN 'intern' THEN EXISTS (SELECT 1 FROM public.instructors i WHERE i.user_id = auth.uid() AND i.instructor_role::text = '實習')
    WHEN 'formal' THEN EXISTS (SELECT 1 FROM public.instructors i WHERE i.user_id = auth.uid() AND i.instructor_role::text IN ('B', 'A', 'A+', 'S'))
    ELSE false
  END;
$$;

CREATE FUNCTION private.instructor_profile_is_complete(target_instructor_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.instructors i
    WHERE i.id = target_instructor_id
      AND i.employment_status::text IS DISTINCT FROM 'frozen'
      AND i.employment_status::text IS DISTINCT FROM 'cancelled'
      AND NULLIF(BTRIM(i.full_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.nickname), '') IS NOT NULL
      AND NULLIF(BTRIM(i.gender), '') IS NOT NULL
      AND i.birth_date IS NOT NULL
      AND NULLIF(BTRIM(i.id_number), '') IS NOT NULL
      AND NULLIF(BTRIM(i.phone_mobile), '') IS NOT NULL
      AND NULLIF(BTRIM(i.line_id), '') IS NOT NULL
      AND NULLIF(BTRIM(i.address), '') IS NOT NULL
      AND NULLIF(BTRIM(i.household_address), '') IS NOT NULL
      AND NULLIF(BTRIM(i.email_primary), '') IS NOT NULL
      AND NULLIF(BTRIM(i.teaching_freq_semester), '') IS NOT NULL
      AND NULLIF(BTRIM(i.teaching_freq_vacation), '') IS NOT NULL
      AND COALESCE(cardinality(i.teaching_regions), 0) > 0
      AND NULLIF(BTRIM(i.bio_notes), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_account_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_branch), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_account_number), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_code), '') IS NOT NULL
      AND COALESCE(NULLIF(BTRIM(i.id_front_path), ''), NULLIF(BTRIM(i.id_front_external_url), '')) IS NOT NULL
      AND COALESCE(NULLIF(BTRIM(i.id_back_path), ''), NULLIF(BTRIM(i.id_back_external_url), '')) IS NOT NULL
      AND COALESCE(NULLIF(BTRIM(i.bankbook_path), ''), NULLIF(BTRIM(i.bankbook_external_url), '')) IS NOT NULL
  );
$$;
REVOKE ALL ON FUNCTION private.instructor_profile_is_complete(uuid) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.is_my_instructor_profile_complete() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('pending', 'teacher', 'mentor', 'admin'))
    AND COALESCE((SELECT private.instructor_profile_is_complete(i.id) FROM public.instructors i WHERE i.user_id = auth.uid() LIMIT 1), false);
$$;
REVOKE ALL ON FUNCTION public.is_my_instructor_profile_complete() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_user_is_staff(), private.current_user_is_teacher(),
  private.can_view_training_audience(text), public.is_my_instructor_profile_complete() TO authenticated;

-- ── 正式庫 2026-10-22 的政策組合 ──
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON public.users FOR SELECT TO authenticated USING ((SELECT auth.uid()) = id);
CREATE POLICY "Staff can view all profiles" ON public.users FOR SELECT TO authenticated USING ((SELECT private.current_user_is_staff()));

ALTER TABLE public.course_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can manage course categories" ON public.course_categories FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Teachers can view available course categories" ON public.course_categories FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher')
    AND (SELECT public.is_my_instructor_profile_complete())
    AND (SELECT private.can_view_training_audience(visibility))
  );

ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage courses" ON public.courses FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff())) WITH CHECK ((SELECT private.current_user_is_staff()));
CREATE POLICY "Complete teachers can view published courses" ON public.courses FOR SELECT TO authenticated
  USING (is_published = true AND (SELECT private.current_user_is_teacher()) AND (SELECT public.is_my_instructor_profile_complete()));
CREATE POLICY "Approved users can view published courses" ON public.courses FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (SELECT 1 FROM public.course_categories category WHERE category.id = category_id
                  AND category.is_published = true AND (SELECT private.can_view_training_audience(category.visibility)))
    AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'teacher')
    AND (SELECT public.is_my_instructor_profile_complete())
    AND (SELECT private.can_view_training_audience(visibility))
  );

ALTER TABLE public.lessons ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage lessons" ON public.lessons FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff())) WITH CHECK ((SELECT private.current_user_is_staff()));
CREATE POLICY "Complete teachers can view published lessons" ON public.lessons FOR SELECT TO authenticated
  USING (
    is_published = true
    AND EXISTS (SELECT 1 FROM public.courses c WHERE c.id = course_id AND c.is_published = true)
    AND (SELECT private.current_user_is_teacher())
    AND (SELECT public.is_my_instructor_profile_complete())
  );
CREATE POLICY "Approved users can view published lessons" ON public.lessons FOR SELECT TO authenticated
  USING (is_published = true AND EXISTS (SELECT 1 FROM public.courses c WHERE c.id = course_id AND c.is_published = true));

ALTER TABLE public.contents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage contents" ON public.contents FOR ALL TO authenticated
  USING ((SELECT private.current_user_is_staff())) WITH CHECK ((SELECT private.current_user_is_staff()));
CREATE POLICY "Complete teachers can view published contents" ON public.contents FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND EXISTS (SELECT 1 FROM public.lessons l JOIN public.courses c ON c.id = l.course_id
                 WHERE l.id = lesson_id AND l.is_published = true AND c.is_published = true)
    AND (SELECT private.current_user_is_teacher())
    AND (SELECT public.is_my_instructor_profile_complete())
  );
CREATE POLICY "Approved users can view contents" ON public.contents FOR SELECT TO authenticated
  USING (status = 'published' AND EXISTS (SELECT 1 FROM public.lessons l WHERE l.id = lesson_id AND l.is_published = true));

ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own instructor profile" ON public.instructors FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own instructor profile" ON public.instructors FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own instructor profile" ON public.instructors FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Admins can do everything on instructors" ON public.instructors FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
-- 不在 repo、只在正式庫的那條
CREATE POLICY "Staff can manage instructors" ON public.instructors FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor')))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor')));
CREATE POLICY "Mentors can view all instructors" ON public.instructors FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'mentor'));
CREATE POLICY "Mentors and admins can view all instructor profiles" ON public.instructors FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'mentor')));

-- 20260826130000 的三條 restrictive（正式庫 2026-10-22 確認存在）
CREATE POLICY "Instructor updates limited to admins or owners" ON public.instructors AS RESTRICTIVE FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'))
  WITH CHECK ((SELECT auth.uid()) = user_id OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Instructor inserts limited to admins or owners" ON public.instructors AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Only admins can delete instructor rows" ON public.instructors AS RESTRICTIVE FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));

-- storage：instructor_uploads 的讀取政策（admin 全部、本人看主檔引用的檔、mentor 全部）
CREATE SCHEMA storage;
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL, owner uuid);
GRANT USAGE ON SCHEMA storage TO authenticated, anon;
GRANT ALL ON storage.objects TO authenticated, anon;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can view all instructor files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'instructor_uploads' AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'admin'));
CREATE POLICY "Users can view files referenced by own instructor profile" ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (SELECT 1 FROM public.instructors i WHERE i.user_id = (SELECT auth.uid())
                  AND name IN (i.photo_path, i.id_front_path, i.id_back_path, i.bankbook_path))
  );
CREATE POLICY "Mentors can view all instructor files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'instructor_uploads' AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'mentor'));

-- class_sessions：報酬紀錄（2025_salary_system 的 admin＋mentor FOR ALL、20261018150000 的本人讀取）
CREATE TABLE public.class_sessions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  instructor_id uuid NOT NULL REFERENCES public.instructors(id),
  session_date date NOT NULL,
  amount numeric NOT NULL DEFAULT 0
);
ALTER TABLE public.class_sessions ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.instructor_salary_visible_from() RETURNS date LANGUAGE sql STABLE AS $$ SELECT DATE '2026-01-01' $$;
CREATE POLICY "Admins manage all sessions" ON public.class_sessions FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'mentor')));
CREATE POLICY "Instructors view own sessions" ON public.class_sessions FOR SELECT TO authenticated
  USING (session_date >= public.instructor_salary_visible_from()
         AND instructor_id IN (SELECT id FROM public.instructors WHERE user_id = (SELECT auth.uid())));

-- ── 測試資料 ──
-- 01 正式講師(B)、02 實習講師、03 資料不完整講師、04 已凍結講師(A)、05 pending（主檔完整）、06 admin、07 mentor、08 尚無主檔的新帳號
INSERT INTO auth.users (id, email)
SELECT ('00000000-0000-4000-8000-00000000000' || n)::uuid, 'u' || n || '@test.local' FROM generate_series(1, 8) n;
INSERT INTO public.users (id, name, role) VALUES
  ('00000000-0000-4000-8000-000000000001', '正式講師', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', '實習講師', 'teacher'),
  ('00000000-0000-4000-8000-000000000003', '未完成講師', 'teacher'),
  ('00000000-0000-4000-8000-000000000004', '凍結講師', 'teacher'),
  ('00000000-0000-4000-8000-000000000005', '待審', 'pending'),
  ('00000000-0000-4000-8000-000000000006', '管理員', 'admin'),
  ('00000000-0000-4000-8000-000000000007', '輔導員', 'mentor'),
  ('00000000-0000-4000-8000-000000000008', '新帳號', 'teacher');

INSERT INTO public.instructors (
  id, user_id, full_name, nickname, gender, birth_date, id_number, phone_mobile, line_id, address, household_address,
  teaching_freq_semester, teaching_freq_vacation, bio_notes, bank_account_name, bank_name, bank_branch,
  bank_account_number, bank_code, id_front_path, id_back_path, bankbook_path, employment_status, instructor_role, speed_qualification
)
SELECT
  ('10000000-0000-4000-8000-00000000000' || n)::uuid,
  ('00000000-0000-4000-8000-00000000000' || n)::uuid,
  '講師' || n, '暱稱' || n, '女', DATE '1999-01-01', 'A12345678' || n, '091234567' || n, 'line' || n, '地址' || n, '戶籍' || n,
  '每週', '每週', '備註', '戶名' || n, '銀行', '分行', '0000111122' || n, '812',
  'instructors/u' || n || '/id_front.jpg', 'instructors/u' || n || '/id_back.jpg', 'instructors/u' || n || '/bankbook.jpg',
  (CASE WHEN n = 4 THEN 'frozen' ELSE 'active' END)::public.employment_status_enum,
  (CASE n WHEN 2 THEN '實習' WHEN 4 THEN 'A' ELSE 'B' END)::public.instructor_role_enum,
  CASE WHEN n = 1 THEN '3x3' END
FROM generate_series(1, 5) n;
UPDATE public.instructors SET bank_code = NULL WHERE id = '10000000-0000-4000-8000-000000000003';
-- 5 位講師各 3 個證件檔＝15 個 instructor_uploads 物件，另 1 個別的 bucket 的檔
INSERT INTO storage.objects (bucket_id, name)
SELECT 'instructor_uploads', 'instructors/u' || n || '/' || f FROM generate_series(1, 5) n, unnest(ARRAY['id_front.jpg', 'id_back.jpg', 'bankbook.jpg']) f;
INSERT INTO storage.objects (bucket_id, name) VALUES ('other-bucket', 'x.pdf');
-- 報酬紀錄：講師 1 兩筆、講師 2 兩筆、講師 4 一筆（講師 3 無紀錄，刪主檔測試才不會撞外鍵）
INSERT INTO public.class_sessions (instructor_id, session_date, amount) VALUES
  ('10000000-0000-4000-8000-000000000001', DATE '2026-10-01', 1000),
  ('10000000-0000-4000-8000-000000000001', DATE '2026-10-08', 1200),
  ('10000000-0000-4000-8000-000000000002', DATE '2026-10-02', 800),
  ('10000000-0000-4000-8000-000000000002', DATE '2026-10-09', 800),
  ('10000000-0000-4000-8000-000000000004', DATE '2026-10-03', 900);

INSERT INTO public.course_categories (id, title, visibility, is_published, "order") VALUES
  ('c0000000-0000-4000-8000-000000000001', '全體分類', 'all', true, 0),
  ('c0000000-0000-4000-8000-000000000002', '正式講師分類', 'formal', true, 1),
  ('c0000000-0000-4000-8000-000000000003', '未發佈分類', 'all', false, 2);
-- d01 全體、d02 限正式、d03 限實習、d04 全體但在正式分類、d05 全體但分類未發佈、d06 未發佈
INSERT INTO public.courses (id, title, is_published, "order", visibility, category_id) VALUES
  ('d0000000-0000-4000-8000-000000000001', '全體課程', true, 1, 'all', 'c0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000002', '限正式課程', true, 2, 'formal', 'c0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000003', '限實習課程', true, 3, 'intern', 'c0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000004', '正式分類內課程', true, 4, 'all', 'c0000000-0000-4000-8000-000000000002'),
  ('d0000000-0000-4000-8000-000000000005', '未發佈分類內課程', true, 5, 'all', 'c0000000-0000-4000-8000-000000000003'),
  ('d0000000-0000-4000-8000-000000000006', '未發佈課程', false, 6, 'all', 'c0000000-0000-4000-8000-000000000001');
-- 每門課一個已發佈章節（e01..e06），d01 另有未發佈章節 e07
INSERT INTO public.lessons (id, course_id, title, "order", is_published)
SELECT ('e0000000-0000-4000-8000-00000000000' || n)::uuid, ('d0000000-0000-4000-8000-00000000000' || n)::uuid, '章節' || n, n, true
FROM generate_series(1, 6) n;
INSERT INTO public.lessons (id, course_id, title, "order", is_published) VALUES
  ('e0000000-0000-4000-8000-000000000007', 'd0000000-0000-4000-8000-000000000001', '未發佈章節', 7, false);
-- 每個已發佈章節一則已發佈內容（f01..f06），e01 另有草稿 f07，未發佈章節 e07 有一則已發佈內容 f08
INSERT INTO public.contents (id, lesson_id, title, status, "order")
SELECT ('f0000000-0000-4000-8000-00000000000' || n)::uuid, ('e0000000-0000-4000-8000-00000000000' || n)::uuid, '內容' || n, 'published', n
FROM generate_series(1, 6) n;
INSERT INTO public.contents (id, lesson_id, title, status, "order") VALUES
  ('f0000000-0000-4000-8000-000000000007', 'e0000000-0000-4000-8000-000000000001', '草稿', 'draft', 7),
  ('f0000000-0000-4000-8000-000000000008', 'e0000000-0000-4000-8000-000000000007', '未發佈章節內容', 'published', 8);

-- ── 測試輔助（schema t） ──
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, anon;
CREATE FUNCTION t.assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF;
END;
$$;
CREATE FUNCTION t.as_user(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, false);
END;
$$;
CREATE FUNCTION t.count_rows(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE 'SELECT count(*) FROM (' || p_sql || ') q' INTO n;
  RETURN n;
END;
$$;
CREATE FUNCTION t.exec_count(p_sql text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
CREATE FUNCTION t.expect_sqlstate(p_label text, p_sql text, p_sqlstate text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  IF v_state IS DISTINCT FROM p_sqlstate THEN
    RAISE EXCEPTION 'ASSERTION FAILED (%): expected SQLSTATE %, got % [%]', p_label, p_sqlstate, COALESCE(v_state, 'no error'), v_msg;
  END IF;
END;
$$;
-- 前端實際查詢（CourseList／LessonView／LessonDetail；只取 RLS 相關的過濾條件）
CREATE FUNCTION t.q_courses() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.courses WHERE is_published = true ORDER BY "order" $q$ $$;
CREATE FUNCTION t.q_course(p_id text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$ SELECT * FROM public.courses WHERE id = %L $q$, p_id) $$;
CREATE FUNCTION t.q_lessons() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.lessons ORDER BY "order" $q$ $$;
CREATE FUNCTION t.q_lessons_of(p_course text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$ SELECT * FROM public.lessons WHERE course_id = %L $q$, p_course) $$;
CREATE FUNCTION t.q_contents() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT lesson_id, type, title, body, position_data FROM public.contents $q$ $$;
CREATE FUNCTION t.q_contents_of(p_lesson text) RETURNS text LANGUAGE sql AS $$
  SELECT format($q$ SELECT * FROM public.contents WHERE lesson_id = %L $q$, p_lesson) $$;
CREATE FUNCTION t.q_sensitive() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT id_number, bank_account_number FROM public.instructors
             WHERE id_number IS NOT NULL AND bank_account_number IS NOT NULL $q$ $$;
CREATE FUNCTION t.q_files() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT name FROM storage.objects WHERE bucket_id = 'instructor_uploads' $q$ $$;
CREATE FUNCTION t.q_sessions() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.class_sessions $q$ $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════
-- 第一段：重現正式庫現況的兩個問題
-- ═══════════════════════════════════════════════════════════════════
-- A. 實習講師讀得到限正式課程（含章節、內容），也讀得到未發佈分類內的課程；正式講師讀得到限實習課程
SELECT t.as_user('00000000-0000-4000-8000-000000000002') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_courses()) = 5, 'bootstrap: intern teacher should read all 5 published courses before migration') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000002')) = 1, 'bootstrap: intern teacher should read the formal-only course') \gset
SELECT t.assert(t.count_rows(t.q_lessons_of('d0000000-0000-4000-8000-000000000002')) = 1, 'bootstrap: intern teacher should read the formal-only course lesson') \gset
SELECT t.assert(t.count_rows(t.q_contents_of('e0000000-0000-4000-8000-000000000002')) = 1, 'bootstrap: intern teacher should read the formal-only course content') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000005')) = 1, 'bootstrap: intern teacher should read the unpublished-category course') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000001') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000003')) = 1, 'bootstrap: formal teacher should read the intern-only course') \gset
RESET ROLE;
\echo PASS: bootstrap reproduces A (intern teacher reads the formal-only course + its lesson + content and the unpublished-category course; formal teacher reads the intern-only course)

-- B. mentor 讀得到全部講師的敏感欄位與證件檔，能讀寫刪任何人的報酬紀錄
SELECT t.as_user('00000000-0000-4000-8000-000000000007') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_sensitive()) = 5, 'bootstrap: mentor should read id_number and bank_account_number of all 5 instructors') \gset
SELECT t.assert(t.count_rows(t.q_files()) = 15, 'bootstrap: mentor should read all 15 instructor ID/bankbook files') \gset
SELECT t.assert(t.count_rows(t.q_sessions()) = 5, 'bootstrap: mentor should read all 5 class_sessions') \gset
RESET ROLE;
BEGIN;
SELECT t.as_user('00000000-0000-4000-8000-000000000007') \gset
SET ROLE authenticated;
SELECT t.assert(t.exec_count($q$ UPDATE public.class_sessions SET amount = amount + 1 $q$) = 5, 'bootstrap: mentor should UPDATE all class_sessions') \gset
SELECT t.assert(t.exec_count($q$ INSERT INTO public.class_sessions (instructor_id, session_date, amount)
                                 VALUES ('10000000-0000-4000-8000-000000000001', DATE '2026-10-15', 99999) $q$) = 1,
  'bootstrap: mentor should INSERT a class_session for another instructor') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.class_sessions WHERE instructor_id = '10000000-0000-4000-8000-000000000002' $q$) = 2,
  'bootstrap: mentor should DELETE class_sessions of another instructor') \gset
RESET ROLE;
ROLLBACK;
\echo PASS: bootstrap reproduces B-read (mentor reads id_number/bank_account_number of 5 instructors, 15 ID/bankbook files, all 5 class_sessions and can UPDATE 5 / INSERT 1 / DELETE 2 of them)

-- 主檔寫入：正式庫的 restrictive 已擋住 mentor；拿掉 restrictive 後 "Staff can manage instructors" 會放行
BEGIN;
SELECT t.as_user('00000000-0000-4000-8000-000000000007') \gset
SET ROLE authenticated;
SELECT t.assert(t.exec_count($q$ UPDATE public.instructors SET note_internal = 'mentor wrote this'
                                 WHERE id = '10000000-0000-4000-8000-000000000001' $q$) = 0,
  'bootstrap: restrictive policy should already block mentor UPDATE in production') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000003' $q$) = 0,
  'bootstrap: restrictive policy should already block mentor DELETE in production') \gset
SELECT t.expect_sqlstate('bootstrap mentor insert for another user under restrictive',
  $q$ INSERT INTO public.instructors (user_id, full_name) VALUES ('00000000-0000-4000-8000-000000000008', 'mentor 代建') $q$, '42501') \gset
RESET ROLE;
DROP POLICY "Instructor updates limited to admins or owners" ON public.instructors;
DROP POLICY "Instructor inserts limited to admins or owners" ON public.instructors;
DROP POLICY "Only admins can delete instructor rows" ON public.instructors;
SET ROLE authenticated;
SELECT t.assert(t.exec_count($q$ UPDATE public.instructors SET note_internal = 'mentor wrote this'
                                 WHERE id = '10000000-0000-4000-8000-000000000001' $q$) = 1,
  'bootstrap: without restrictive, Staff can manage instructors should let mentor UPDATE') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000003' $q$) = 1,
  'bootstrap: without restrictive, mentor should DELETE') \gset
RESET ROLE;
ROLLBACK;
\echo PASS: bootstrap B-write as in production: restrictive policies already block mentor UPDATE/DELETE/INSERT on other rows (0/0/42501); with them removed, "Staff can manage instructors" lets mentor UPDATE 1 and DELETE 1 (latent hole)

-- ═══════════════════════════════════════════════════════════════════
-- 第二段：套用 migration 兩次
-- ═══════════════════════════════════════════════════════════════════
\ir ../supabase/migrations/20261022010000_tighten_course_audience_and_mentor_access.sql
\ir ../supabase/migrations/20261022010000_tighten_course_audience_and_mentor_access.sql
\echo PASS: migration 20261022010000 applied twice without error

-- 1. 政策盤點
SELECT t.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'Complete teachers can view published %')
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'courses' AND cmd = 'SELECT') = 1
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lessons' AND cmd = 'SELECT') = 1
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contents' AND cmd = 'SELECT') = 1
  AND (SELECT (length(qual) - length(replace(qual, 'can_view_training_audience(', ''))) / length('can_view_training_audience(')
         FROM pg_policies WHERE tablename = 'courses' AND policyname = 'Approved users can view published courses') = 2
  AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'lessons' AND policyname = 'Approved users can view published lessons')
  AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'contents' AND policyname = 'Approved users can view contents')
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('courses', 'lessons', 'contents')
         AND policyname LIKE 'Staff can manage %' AND cmd = 'ALL') = 3,
  'course/lesson/content policies are not exactly {one Approved SELECT with two audience checks on courses, Staff FOR ALL}') \gset
SELECT t.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'instructors' AND policyname = 'Staff can manage instructors')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'instructors' AND cmd IN ('ALL', 'INSERT', 'UPDATE', 'DELETE')
                    AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%mentor%')
  AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'instructors' AND policyname = 'Admins can do everything on instructors'
                AND cmd = 'ALL' AND qual LIKE '%''admin''%' AND with_check LIKE '%''admin''%'),
  'instructors still has a write policy mentioning mentor, or the admin FOR ALL policy is missing') \gset
SELECT t.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('instructors', 'class_sessions')
                AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%mentor%')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
                    AND qual LIKE '%instructor_uploads%' AND qual LIKE '%mentor%')
  AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'class_sessions' AND policyname = 'Admins manage all sessions'
                AND cmd = 'ALL' AND qual LIKE '%''admin''%' AND with_check LIKE '%''admin''%')
  AND EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'class_sessions' AND policyname = 'Instructors view own sessions')
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND policyname IN
         ('Admins can view all instructor files', 'Users can view files referenced by own instructor profile')) = 2
  AND (SELECT count(*) FROM pg_policies WHERE tablename = 'instructors' AND permissive = 'RESTRICTIVE') = 3
  AND (SELECT count(*) FROM pg_policies WHERE tablename = 'instructors' AND cmd = 'SELECT') = 1,
  'a policy on instructors/class_sessions/instructor_uploads still mentions mentor, or admin/own/restrictive policies changed') \gset
SELECT t.assert(
  (SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
     FROM pg_proc p WHERE p.oid = 'public.mentor_instructor_directory(uuid[])'::regprocedure)
  AND NOT has_function_privilege('anon', 'public.mentor_instructor_directory(uuid[])', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.mentor_instructor_directory(uuid[])', 'EXECUTE')
  AND (SELECT array_to_string(p.proargnames, ',') FROM pg_proc p WHERE p.oid = 'public.mentor_instructor_directory(uuid[])'::regprocedure)
      = 'p_user_ids,id,user_id,full_name,nickname,instructor_role,employment_status,teaching_regions,speed_qualification',
  'mentor_instructor_directory is not SECURITY DEFINER with empty search_path, anon can execute it, or its columns changed') \gset
\echo PASS: no Complete-teachers policies left; courses/lessons/contents each have one Approved SELECT (courses checks audience twice) plus Staff FOR ALL; no policy on instructors, class_sessions or instructor_uploads mentions mentor (instructors keeps admin FOR ALL, own SELECT and the 3 restrictive policies; class_sessions admin-only FOR ALL plus own read; storage keeps admin and own read); directory function is SECURITY DEFINER with empty search_path, anon cannot execute, returns only 8 non-sensitive columns

-- 2. 受眾生效：正式講師 d01、d02、d04；實習講師 d01、d03
SELECT t.as_user('00000000-0000-4000-8000-000000000001') \gset
SET ROLE authenticated;
SELECT t.assert(
  (SELECT array_agg(id ORDER BY id)::text FROM public.courses WHERE is_published = true)
    = '{d0000000-0000-4000-8000-000000000001,d0000000-0000-4000-8000-000000000002,d0000000-0000-4000-8000-000000000004}',
  'formal teacher should see exactly the all, formal-only and formal-category courses') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000003')) = 0, 'formal teacher still reads the intern-only course') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000005')) = 0, 'formal teacher still reads the unpublished-category course') \gset
SELECT t.assert(t.count_rows(t.q_lessons()) = 3, 'formal teacher should see 3 lessons') \gset
SELECT t.assert(t.count_rows(t.q_contents()) = 3, 'formal teacher should see 3 contents') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000002') \gset
SELECT t.assert(
  (SELECT array_agg(id ORDER BY id)::text FROM public.courses WHERE is_published = true)
    = '{d0000000-0000-4000-8000-000000000001,d0000000-0000-4000-8000-000000000003}',
  'intern teacher should see exactly the all and intern-only courses') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000002')) = 0, 'intern teacher still reads the formal-only course') \gset
SELECT t.assert(t.count_rows(t.q_lessons_of('d0000000-0000-4000-8000-000000000002')) = 0, 'intern teacher still reads the formal-only lesson') \gset
SELECT t.assert(t.count_rows(t.q_contents_of('e0000000-0000-4000-8000-000000000002')) = 0, 'intern teacher still reads the formal-only content') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000004')) = 0, 'intern teacher still reads the course inside the formal category') \gset
SELECT t.assert(t.count_rows(t.q_lessons()) = 2 AND t.count_rows(t.q_contents()) = 2, 'intern teacher should see 2 lessons and 2 contents') \gset
RESET ROLE;
\echo PASS: audience enforced (formal teacher: all/formal/formal-category = 3 courses, 3 lessons, 3 contents; intern teacher: all/intern = 2, 2, 2; restricted and unpublished-category courses, lessons, contents return 0)

-- 3. 受眾 all 的課程：兩種講師照常看得到課程、章節（LessonView）、內容（LessonDetail）；未發佈章節與草稿仍看不到
SELECT t.as_user('00000000-0000-4000-8000-000000000001') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000001')) = 1
  AND t.count_rows(t.q_lessons_of('d0000000-0000-4000-8000-000000000001')) = 1
  AND t.count_rows(t.q_contents_of('e0000000-0000-4000-8000-000000000001')) = 1
  AND t.count_rows(t.q_contents_of('e0000000-0000-4000-8000-000000000007')) = 0,
  'formal teacher lost access to the all-audience course, its published lesson or content (or sees unpublished/draft)') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000002') \gset
SELECT t.assert(t.count_rows(t.q_course('d0000000-0000-4000-8000-000000000001')) = 1
  AND t.count_rows(t.q_lessons_of('d0000000-0000-4000-8000-000000000001')) = 1
  AND t.count_rows(t.q_contents_of('e0000000-0000-4000-8000-000000000001')) = 1,
  'intern teacher lost access to the all-audience course, its lesson or content') \gset
RESET ROLE;
\echo PASS: all-audience course stays readable for both teacher levels (course 1, published lesson 1, published content 1; unpublished lesson and draft hidden)

-- 4. pending、資料不完整、已凍結：全部 0
SELECT t.as_user('00000000-0000-4000-8000-000000000005') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_courses()) = 0 AND t.count_rows(t.q_lessons()) = 0 AND t.count_rows(t.q_contents()) = 0, 'pending reads courses/lessons/contents') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000003') \gset
SELECT t.assert(t.count_rows(t.q_courses()) = 0 AND t.count_rows(t.q_lessons()) = 0 AND t.count_rows(t.q_contents()) = 0, 'incomplete teacher reads courses/lessons/contents') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000004') \gset
SELECT t.assert(t.count_rows(t.q_courses()) = 0 AND t.count_rows(t.q_lessons()) = 0 AND t.count_rows(t.q_contents()) = 0, 'frozen teacher reads courses/lessons/contents') \gset
RESET ROLE;
\echo PASS: pending, incomplete-profile and frozen teachers read 0 courses, 0 lessons, 0 contents

-- 5. admin：課程全權不變（6／7／8 列，含未發佈與草稿）；講師主檔讀寫刪全權
SELECT t.as_user('00000000-0000-4000-8000-000000000006') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows('SELECT * FROM public.courses') = 6 AND t.count_rows(t.q_lessons()) = 7 AND t.count_rows(t.q_contents()) = 8,
  'admin should read all 6 courses, 7 lessons, 8 contents') \gset
SELECT t.assert(t.count_rows('SELECT * FROM public.instructors') = 5 AND t.count_rows(t.q_sensitive()) = 5, 'admin should read all instructors with sensitive fields') \gset
SELECT t.assert(t.count_rows(t.q_files()) = 15, 'admin should read all 15 instructor files') \gset
SELECT t.assert(t.count_rows(t.q_sessions()) = 5, 'admin should read all 5 class_sessions') \gset
RESET ROLE;
BEGIN;
SELECT t.as_user('00000000-0000-4000-8000-000000000006') \gset
SET ROLE authenticated;
SELECT t.assert(t.exec_count($q$ UPDATE public.courses SET title = 'admin edit' WHERE id = 'd0000000-0000-4000-8000-000000000002' $q$) = 1, 'admin cannot edit a course') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.instructors SET note_internal = 'admin' WHERE id = '10000000-0000-4000-8000-000000000001' $q$) = 1, 'admin cannot UPDATE an instructor') \gset
SELECT t.assert(t.exec_count($q$ INSERT INTO public.instructors (user_id, full_name) VALUES ('00000000-0000-4000-8000-000000000008', 'admin 建檔') $q$) = 1, 'admin cannot INSERT an instructor') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.class_sessions SET amount = amount + 1 $q$) = 5, 'admin cannot UPDATE class_sessions') \gset
SELECT t.assert(t.exec_count($q$ INSERT INTO public.class_sessions (instructor_id, session_date, amount)
                                 VALUES ('10000000-0000-4000-8000-000000000002', DATE '2026-10-16', 500) $q$) = 1, 'admin cannot INSERT a class_session') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.class_sessions WHERE instructor_id = '10000000-0000-4000-8000-000000000004' $q$) = 1, 'admin cannot DELETE a class_session') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000003' $q$) = 1, 'admin cannot DELETE an instructor') \gset
RESET ROLE;
ROLLBACK;
\echo PASS: admin keeps full access (reads 6 courses / 7 lessons / 8 contents, 5 instructors with sensitive fields, 15 instructor files, 5 class_sessions; edits a course; UPDATE/INSERT/DELETE instructors 1/1/1; class_sessions UPDATE 5, INSERT 1, DELETE 1)

-- 6. mentor：不能寫主檔（restrictive 在或不在都一樣）、讀不到主檔／敏感欄位／證件檔、報酬紀錄不能讀寫；課程後台照舊
SELECT t.as_user('00000000-0000-4000-8000-000000000007') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows('SELECT * FROM public.instructors') = 0, 'mentor still reads instructor rows directly') \gset
SELECT t.assert(t.count_rows(t.q_sensitive()) = 0, 'mentor still reads id_number/bank_account_number') \gset
SELECT t.assert(t.count_rows(t.q_files()) = 0, 'mentor still reads instructor ID/bankbook files') \gset
SELECT t.assert(t.count_rows(t.q_sessions()) = 0, 'mentor still reads class_sessions') \gset
SELECT t.assert(t.count_rows('SELECT * FROM public.courses') = 6, 'mentor lost the course CMS read access') \gset
RESET ROLE;
\echo PASS: mentor reads 0 instructor rows, 0 sensitive values, 0 instructor files, 0 class_sessions; course CMS access unchanged (6 courses)

BEGIN;
SELECT t.as_user('00000000-0000-4000-8000-000000000007') \gset
SET ROLE authenticated;
SELECT t.assert(t.exec_count($q$ UPDATE public.class_sessions SET amount = amount + 1 $q$) = 0, 'mentor can still UPDATE class_sessions') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.class_sessions $q$) = 0, 'mentor can still DELETE class_sessions') \gset
SELECT t.expect_sqlstate('mentor insert class_session',
  $q$ INSERT INTO public.class_sessions (instructor_id, session_date, amount) VALUES ('10000000-0000-4000-8000-000000000001', DATE '2026-10-15', 99999) $q$, '42501') \gset
RESET ROLE;
-- 拿掉三條 restrictive，證明 mentor 不能寫主檔不再依賴它們
DROP POLICY "Instructor updates limited to admins or owners" ON public.instructors;
DROP POLICY "Instructor inserts limited to admins or owners" ON public.instructors;
DROP POLICY "Only admins can delete instructor rows" ON public.instructors;
SET ROLE authenticated;
SELECT t.assert(t.exec_count($q$ UPDATE public.instructors SET note_internal = 'mentor wrote this' WHERE id = '10000000-0000-4000-8000-000000000001' $q$) = 0,
  'mentor can still UPDATE another instructor') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.instructors SET instructor_role = 'S' $q$) = 0, 'mentor can still bulk UPDATE instructors') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000003' $q$) = 0,
  'mentor can still DELETE another instructor') \gset
SELECT t.expect_sqlstate('mentor insert for another user',
  $q$ INSERT INTO public.instructors (user_id, full_name) VALUES ('00000000-0000-4000-8000-000000000008', 'mentor 代建') $q$, '42501') \gset
RESET ROLE;
SELECT t.assert((SELECT count(*) FROM public.class_sessions) = 5 AND (SELECT sum(amount) FROM public.class_sessions) = 4700
  AND (SELECT note_internal FROM public.instructors WHERE id = '10000000-0000-4000-8000-000000000001') IS NULL
  AND (SELECT count(*) FROM public.instructors) = 5 AND (SELECT count(*) FROM public.instructors WHERE instructor_role = 'S') = 0,
  'mentor write attempts changed data') \gset
ROLLBACK;
\echo PASS: mentor class_sessions UPDATE 0 / DELETE 0 / INSERT 42501; with the 3 restrictive policies removed, mentor instructor UPDATE (single and bulk) 0, DELETE 0, INSERT 42501; data unchanged

-- 7. 講師本人：仍可讀、改自己的主檔，改不到別人
BEGIN;
SELECT t.as_user('00000000-0000-4000-8000-000000000001') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows('SELECT * FROM public.instructors') = 1, 'teacher should read only own instructor row') \gset
SELECT t.assert(t.count_rows(t.q_files()) = 3, 'teacher should read only own 3 files') \gset
SELECT t.assert(t.count_rows(t.q_sessions()) = 2, 'teacher should read only own 2 class_sessions') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.class_sessions SET amount = 0 $q$) = 0, 'teacher can UPDATE class_sessions') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.instructors SET nickname = '新暱稱' WHERE user_id = '00000000-0000-4000-8000-000000000001' $q$) = 1, 'teacher cannot update own row') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.instructors SET nickname = 'x' WHERE id = '10000000-0000-4000-8000-000000000002' $q$) = 0, 'teacher can update another row') \gset
RESET ROLE;
ROLLBACK;
\echo PASS: teacher reads only own instructor row, 3 own files and 2 own class_sessions; updates own row (1), cannot update another (0) or any class_session (0)

-- 8. 名冊函式：admin、mentor 讀得到 5 列非敏感欄位、可依 user_id 篩；講師、pending、未登入、anon 被擋
SELECT t.as_user('00000000-0000-4000-8000-000000000007') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows('SELECT * FROM public.mentor_instructor_directory()') = 5, 'mentor should get all 5 directory rows') \gset
SELECT t.assert(
  (SELECT bool_and(NOT (to_jsonb(d) ?| ARRAY['id_number', 'bank_account_number', 'bank_account_name', 'bank_name', 'bank_branch', 'bank_code',
                                             'birth_date', 'phone_mobile', 'address', 'household_address', 'line_id',
                                             'id_front_path', 'id_back_path', 'bankbook_path', 'note_internal', 'gender']))
     FROM public.mentor_instructor_directory() d),
  'directory leaks a sensitive column') \gset
SELECT t.assert(
  (SELECT full_name || '|' || nickname || '|' || instructor_role || '|' || employment_status || '|' || array_to_string(teaching_regions, ',') || '|' || speed_qualification
     FROM public.mentor_instructor_directory(ARRAY['00000000-0000-4000-8000-000000000001'::uuid])) = '講師1|暱稱1|B|active|臺北市|3x3',
  'directory row for user 01 has wrong non-sensitive values') \gset
SELECT t.assert(t.count_rows($q$ SELECT * FROM public.mentor_instructor_directory(ARRAY['00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000002'::uuid]) $q$) = 2,
  'directory user_id filter should return 2 rows') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000006') \gset
SELECT t.assert(t.count_rows('SELECT * FROM public.mentor_instructor_directory()') = 5, 'admin should get all 5 directory rows') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000001') \gset
SELECT t.expect_sqlstate('teacher calls directory', 'SELECT * FROM public.mentor_instructor_directory()', '42501') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000005') \gset
SELECT t.expect_sqlstate('pending calls directory', 'SELECT * FROM public.mentor_instructor_directory()', '42501') \gset
SELECT set_config('request.jwt.claims', '{}', false) \gset
SELECT t.expect_sqlstate('no uid calls directory', 'SELECT * FROM public.mentor_instructor_directory()', '42501') \gset
RESET ROLE;
SET ROLE anon;
SELECT t.expect_sqlstate('anon calls directory', 'SELECT * FROM public.mentor_instructor_directory()', '42501') \gset
RESET ROLE;
\echo PASS: directory gives admin and mentor 5 rows with only non-sensitive columns (values correct, user_id filter works); teacher, pending, missing uid and anon get 42501

\echo rls audience/mentor SQL verification passed
