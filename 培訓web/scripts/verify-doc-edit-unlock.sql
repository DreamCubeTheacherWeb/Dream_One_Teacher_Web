\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages = warning;
\o /dev/null

-- 驗證 20261020120000_instructor_document_edit_unlocks.sql：
-- 身分證／存摺／匯款「已有資料即鎖定」、管理員開放一次、存檔後自動鎖回、修改紀錄、舊檔保留。
-- 先套舊的存摺／匯款鎖定 migration 模擬正式庫現況，再連套兩次新 migration（可重複執行）。

CREATE SCHEMA auth;
CREATE SCHEMA storage;
CREATE ROLE anon;
CREATE ROLE authenticated;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

CREATE OR REPLACE FUNCTION storage.foldername(object_name text)
RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN array_length(string_to_array(object_name, '/'), 1) > 1
      THEN (string_to_array(object_name, '/'))[1:array_length(string_to_array(object_name, '/'), 1) - 1]
    ELSE ARRAY[]::text[]
  END
$$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role text NOT NULL,
  name text
);

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE,
  full_name text,
  photo_path text, photo_mime text, photo_size integer, photo_uploaded_at timestamptz,
  id_front_path text, id_front_mime text, id_front_size integer, id_front_uploaded_at timestamptz,
  id_back_path text, id_back_mime text, id_back_size integer, id_back_uploaded_at timestamptz,
  bankbook_path text, bankbook_mime text, bankbook_size integer, bankbook_uploaded_at timestamptz,
  photo_external_url text, id_front_external_url text, id_back_external_url text, bankbook_external_url text,
  bank_account_name text, bank_name text, bank_branch text, bank_code text, bank_account_number text
);

CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text NOT NULL,
  name text NOT NULL
);

ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own instructor profile"
  ON public.instructors FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can update own instructor profile"
  ON public.instructors FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can insert own instructor profile"
  ON public.instructors FOR INSERT TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Mentors can view all instructors"
  ON public.instructors FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role = 'mentor'));

CREATE POLICY "Users can upload own instructor files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
CREATE POLICY "Users can view own instructor files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );
-- 20260819140407 的舊版：只保護「自己現行的存摺」
CREATE POLICY "Users can update own instructor files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'instructor_uploads' AND (storage.foldername(name))[2] = auth.uid()::text)
  WITH CHECK (bucket_id = 'instructor_uploads' AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "Users can delete own instructor files"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'instructor_uploads' AND (storage.foldername(name))[2] = auth.uid()::text);

GRANT SELECT ON public.users TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instructors TO authenticated;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;

-- 模擬 PostgREST upsert：只寫 payload 有的欄位，INSERT … ON CONFLICT (user_id) DO UPDATE。
CREATE OR REPLACE FUNCTION public.test_upsert_instructor(p jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  cols text;
  sets text;
BEGIN
  SELECT string_agg(quote_ident(k), ', '), string_agg(format('%I = EXCLUDED.%I', k, k), ', ')
    INTO cols, sets
  FROM jsonb_object_keys(p) AS k;
  EXECUTE format(
    'INSERT INTO public.instructors (%s) SELECT %s FROM jsonb_populate_record(NULL::public.instructors, $1) '
    'ON CONFLICT (user_id) DO UPDATE SET %s', cols, cols, sets
  ) USING p;
END;
$$;

-- 講師畫面存檔時的 payload：DB 現有列去掉 id 與管理員專屬的匯入連結，再疊上這次的變更。
CREATE OR REPLACE FUNCTION public.test_self_payload(p_changes jsonb)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT (to_jsonb(i) - ARRAY['id', 'photo_external_url', 'id_front_external_url', 'id_back_external_url', 'bankbook_external_url'])
         || p_changes
  FROM public.instructors i
  WHERE i.user_id = auth.uid()
$$;

\ir ../supabase/migrations/20260818082549_lock_instructor_bankbook_after_first_save.sql
\ir ../supabase/migrations/20260825120000_lock_instructor_bank_account_after_first_save.sql
\ir ../supabase/migrations/20260826130000_admin_instructor_editor_access.sql
\ir ../supabase/migrations/20261020120000_instructor_document_edit_unlocks.sql
\ir ../supabase/migrations/20261020120000_instructor_document_edit_unlocks.sql
\echo PASS 01 migration 套在舊鎖定 migration 之上，連跑兩次無錯

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('trg_guard_instructor_bankbook', 'trg_guard_instructor_bank_account')) THEN
    RAISE EXCEPTION 'FAIL: 舊的存摺／匯款 trigger 仍在，會無視開放權限';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_guard_instructor_locked_documents', 'trg_log_instructor_document_changes')) <> 2 THEN
    RAISE EXCEPTION 'FAIL: 新 trigger 未建立';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
        AND policyname IN ('Users can update own instructor files', 'Users can delete own instructor files')
        AND (qual LIKE '%is_protected_instructor_file%')) <> 2 THEN
    RAISE EXCEPTION 'FAIL: storage 講師更新／刪除政策未改用 is_protected_instructor_file';
  END IF;
END;
$$;
\echo PASS 02 舊 trigger 已移除、新 trigger 與 storage 政策到位

-- ── 測試資料 ──
INSERT INTO public.users (id, role, name) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'admin', '管理員甲'),
  ('00000000-0000-4000-8000-0000000000b1', 'teacher', '講師一'),
  ('00000000-0000-4000-8000-0000000000b2', 'teacher', '講師二'),
  ('00000000-0000-4000-8000-0000000000b3', 'teacher', '講師三'),
  ('00000000-0000-4000-8000-0000000000b5', 'pending', '新講師五'),
  ('00000000-0000-4000-8000-0000000000c1', 'mentor', '輔導員');

INSERT INTO public.instructors (
  id, user_id, full_name,
  id_front_path, id_front_mime, id_front_size, id_front_uploaded_at,
  id_back_path, id_back_mime, id_back_size, id_back_uploaded_at,
  bankbook_path, bankbook_mime, bankbook_size, bankbook_uploaded_at,
  photo_path,
  bank_account_name, bank_name, bank_branch, bank_code, bank_account_number
) VALUES (
  '10000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b1', '講師一',
  'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png', 'image/png', 100, '2026-08-01T00:00:00Z',
  'instructors/00000000-0000-4000-8000-0000000000b1/id_back/b.png', 'image/png', 100, '2026-08-01T00:00:00Z',
  'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/c.png', 'image/png', 100, '2026-08-01T00:00:00Z',
  'instructors/00000000-0000-4000-8000-0000000000b1/photo/p.png',
  '講師一', '台灣銀行', NULL, '0040012', '1234567890'
);

INSERT INTO public.instructors (id, user_id, full_name, id_front_external_url, bankbook_external_url) VALUES
  ('10000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b2', '講師二',
   'https://drive.google.com/open?id=front', 'https://drive.google.com/open?id=bankbook');

INSERT INTO public.instructors (id, user_id, full_name) VALUES
  ('10000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b3', '講師三'),
  ('10000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000c1', '輔導員');

INSERT INTO storage.objects (bucket_id, name) VALUES
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png'),
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/id_back/b.png'),
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/c.png'),
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/photo/p.png'),
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a2.png'),
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/id_back/b2.png'),
  ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/orphan.png');

-- 系統建資料不留紀錄以外的副作用：清掉種子資料產生的紀錄，讓後續計數從 0 開始。
DELETE FROM public.instructor_document_changes;

-- ── 講師一：沒開放時三項都改不了 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
SET ROLE authenticated;

-- 一般存檔（只改姓名、分行從 NULL 變空字串）不可誤判成改匯款：舊匯款 trigger 的 NULL／空字串 bug
SELECT public.test_upsert_instructor(public.test_self_payload('{"full_name":"講師一（改名）","bank_branch":""}'));
DO $$
BEGIN
  IF (SELECT full_name FROM public.instructors WHERE user_id = auth.uid()) <> '講師一（改名）' THEN
    RAISE EXCEPTION 'FAIL: 一般存檔未成功';
  END IF;
END;
$$;
\echo PASS 03 講師一般存檔（含 NULL→空字串）不被鎖定規則誤擋，也不產生紀錄（upsert 預檢無假紀錄）

DO $$
BEGIN
  PERFORM public.test_upsert_instructor(public.test_self_payload(
    '{"id_front_path":"instructors/00000000-0000-4000-8000-0000000000b1/id_front/a2.png","id_front_uploaded_at":"2026-10-20T00:00:00Z"}'));
  RAISE EXCEPTION 'FAIL: 沒開放卻能換身分證正面';
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM NOT LIKE '%身分證照片已鎖定%' THEN RAISE EXCEPTION 'FAIL: 錯誤訊息不對：%', SQLERRM; END IF;
END;
$$;
DO $$
BEGIN
  UPDATE public.instructors SET id_back_path = NULL WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 沒開放卻能移除身分證反面';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  UPDATE public.instructors SET bankbook_path = 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/new.png' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 沒開放卻能換存摺';
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM NOT LIKE '%存摺封面已鎖定%' THEN RAISE EXCEPTION 'FAIL: 錯誤訊息不對：%', SQLERRM; END IF;
END;
$$;
DO $$
BEGIN
  UPDATE public.instructors SET bank_account_number = '9999999999' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 沒開放卻能改匯款帳號';
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM NOT LIKE '%匯款銀行資訊已鎖定%' THEN RAISE EXCEPTION 'FAIL: 錯誤訊息不對：%', SQLERRM; END IF;
END;
$$;
\echo PASS 04 沒開放時：身分證（換／移除）、存摺、匯款帳號皆被擋，訊息正確

-- 講師不能自己開放、不能動權限表、看不到修改紀錄
DO $$
BEGIN
  PERFORM public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'id_card');
  RAISE EXCEPTION 'FAIL: 講師竟能呼叫開放 RPC';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  INSERT INTO public.instructor_edit_unlocks (instructor_id, scope) VALUES ('10000000-0000-4000-8000-0000000000b1', 'id_card');
  RAISE EXCEPTION 'FAIL: 講師竟能直接新增開放權限';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  INSERT INTO public.instructor_document_changes (instructor_id, item, changed_by_role) VALUES ('10000000-0000-4000-8000-0000000000b1', 'id_front', 'admin');
  RAISE EXCEPTION 'FAIL: 講師竟能偽造修改紀錄';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_document_changes) <> 0 THEN
    RAISE EXCEPTION 'FAIL: 講師看得到修改紀錄';
  END IF;
END;
$$;
\echo PASS 05 講師不能自己開放、不能寫權限表、不能偽造或讀取修改紀錄

-- 舊檔保護：現行身分證與存摺檔不能刪、不能覆寫；未被引用的檔與大頭照照舊可刪
DELETE FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png';
DELETE FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/c.png';
-- 搬移（改名）＝Supabase 的 move；覆寫（upsert:true）同樣走 UPDATE
UPDATE storage.objects SET name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_back/moved.png'
WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_back/b.png';
UPDATE storage.objects SET bucket_id = bucket_id
WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/c.png';
DO $$
BEGIN
  INSERT INTO storage.objects (bucket_id, name)
  VALUES ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png');
  RAISE EXCEPTION 'FAIL: 講師竟能用現行身分證檔名再上傳一份（覆蓋）';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
INSERT INTO storage.objects (bucket_id, name)
VALUES ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/fresh-upload.png');
DELETE FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/orphan.png';
DELETE FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/photo/p.png';
RESET ROLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png') THEN
    RAISE EXCEPTION 'FAIL: 講師刪得掉現行身分證檔';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/c.png') THEN
    RAISE EXCEPTION 'FAIL: 講師刪得掉現行存摺檔';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/orphan.png') THEN
    RAISE EXCEPTION 'FAIL: 講師刪不掉自己未被引用的暫存檔（存檔失敗清理會壞）';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/photo/p.png') THEN
    RAISE EXCEPTION 'FAIL: 大頭照不在範圍內，講師應仍可刪';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_back/b.png')
     OR EXISTS (SELECT 1 FROM storage.objects WHERE name LIKE '%/id_back/moved.png') THEN
    RAISE EXCEPTION 'FAIL: 講師搬得動現行身分證反面檔';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/fresh-upload.png') THEN
    RAISE EXCEPTION 'FAIL: 講師上傳新檔名（正常換檔流程）被擋';
  END IF;
END;
$$;
\echo PASS 06 現行身分證／存摺檔講師刪不掉、搬不走、不能同名再上傳；新檔名照常上傳；未引用暫存檔與大頭照照舊可刪

-- ── 管理員開放身分證一次 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'id_card') IS NOT NULL AS granted \gset
SELECT public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'id_card') IS NOT NULL AS granted_again \gset
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_edit_unlocks
      WHERE instructor_id = '10000000-0000-4000-8000-0000000000b1' AND scope = 'id_card'
        AND consumed_at IS NULL AND revoked_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL: 連按兩次開放應只有一筆有效權限';
  END IF;
  IF (SELECT granted_by FROM public.instructor_edit_unlocks WHERE scope = 'id_card' LIMIT 1) <> '00000000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'FAIL: 開放紀錄未記下管理員';
  END IF;
END;
$$;
DO $$
BEGIN
  PERFORM public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'photo');
  RAISE EXCEPTION 'FAIL: 未知項目竟可開放';
EXCEPTION WHEN invalid_parameter_value THEN NULL;
END;
$$;
\echo PASS 07 管理員開放身分證：連按兩次只有一筆有效權限，未知項目被拒

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', false);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_edit_unlocks) <> 0 THEN
    RAISE EXCEPTION 'FAIL: 講師二看得到講師一的開放權限';
  END IF;
END;
$$;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_edit_unlocks WHERE consumed_at IS NULL AND revoked_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'FAIL: 講師一看不到自己的開放權限（畫面無法顯示已開放）';
  END IF;
END;
$$;
\echo PASS 08 講師只看得到自己的開放權限

-- 講師一同一次存檔換正反兩面：只用掉一次權限，留兩筆紀錄
SELECT public.test_upsert_instructor(public.test_self_payload(
  '{"id_front_path":"instructors/00000000-0000-4000-8000-0000000000b1/id_front/a2.png","id_front_uploaded_at":"2026-10-20T01:00:00Z",
    "id_back_path":"instructors/00000000-0000-4000-8000-0000000000b1/id_back/b2.png","id_back_uploaded_at":"2026-10-20T01:00:00Z"}'));
DO $$
BEGIN
  IF (SELECT id_front_path FROM public.instructors WHERE user_id = auth.uid()) NOT LIKE '%/a2.png' THEN
    RAISE EXCEPTION 'FAIL: 開放後仍換不了身分證';
  END IF;
  IF EXISTS (SELECT 1 FROM public.instructor_edit_unlocks WHERE consumed_at IS NULL AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL: 存檔後權限未自動用掉';
  END IF;
END;
$$;
DO $$
BEGIN
  UPDATE public.instructors SET id_front_path = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a3.png' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 用掉權限後竟可再改一次';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
\echo PASS 09 開放後講師可換正反兩面（一次存檔用掉一次權限），存檔後自動鎖回

-- 被換掉的舊檔：講師依然刪不掉（靠修改紀錄保護）
DELETE FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png';
RESET ROLE;
DO $$
DECLARE
  v_unlock uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE name = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png') THEN
    RAISE EXCEPTION 'FAIL: 被換掉的舊身分證檔被講師刪掉了';
  END IF;
  SELECT id INTO v_unlock FROM public.instructor_edit_unlocks WHERE scope = 'id_card';
  IF (SELECT count(*) FROM public.instructor_document_changes
      WHERE instructor_id = '10000000-0000-4000-8000-0000000000b1'
        AND item IN ('id_front', 'id_back')
        AND changed_by = '00000000-0000-4000-8000-0000000000b1'
        AND changed_by_role = 'instructor'
        AND instructor_document_changes.unlock_id = v_unlock) <> 2 THEN
    RAISE EXCEPTION 'FAIL: 修改紀錄應有正反兩筆、記下講師與用掉的權限';
  END IF;
  IF (SELECT old_value ->> 'path' FROM public.instructor_document_changes WHERE item = 'id_front')
       <> 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a.png'
     OR (SELECT new_value ->> 'path' FROM public.instructor_document_changes WHERE item = 'id_front')
       <> 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a2.png' THEN
    RAISE EXCEPTION 'FAIL: 修改紀錄的新舊檔路徑不對';
  END IF;
  IF (SELECT count(*) FROM public.instructor_document_changes) <> 2 THEN
    RAISE EXCEPTION 'FAIL: 修改紀錄筆數應為 2（一般存檔不該留紀錄），實際 %', (SELECT count(*) FROM public.instructor_document_changes);
  END IF;
END;
$$;
\echo PASS 10 修改紀錄記下新舊檔路徑、講師與權限；被換掉的舊檔講師刪不掉

-- ── 匯款：開放 → 改一次 → 鎖回；收回後不可改 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'bank_account') IS NOT NULL AS g1 \gset
SELECT (public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'bankbook')).id AS bankbook_unlock \gset
SELECT (public.admin_revoke_instructor_edit_unlock(:'bankbook_unlock')).revoked_at IS NOT NULL AS revoked \gset
SELECT (public.admin_revoke_instructor_edit_unlock(:'bankbook_unlock')).revoked_at IS NOT NULL AS revoked_again \gset
\if :revoked_again
\else
  \echo FAIL: 重複收回應回傳現況
  SELECT 1/0;
\endif

SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
SELECT public.test_upsert_instructor(public.test_self_payload('{"bank_account_number":"5555566666","bank_branch":"信義分行"}'));
DO $$
BEGIN
  UPDATE public.instructors SET bank_account_number = '7777777777' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 匯款用掉權限後竟可再改';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  UPDATE public.instructors SET bankbook_path = 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/new.png' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 已收回的存摺開放竟仍有效';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT bank_account_number FROM public.instructors WHERE id = '10000000-0000-4000-8000-0000000000b1') <> '5555566666' THEN
    RAISE EXCEPTION 'FAIL: 開放後匯款沒改成功';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.instructor_document_changes
    WHERE item = 'bank_account' AND unlock_id IS NOT NULL
      AND old_value ->> 'bank_account_number' = '1234567890'
      AND new_value ->> 'bank_account_number' = '5555566666'
      AND new_value ->> 'bank_branch' = '信義分行'
      AND NOT (old_value ? 'bank_branch')
  ) THEN
    RAISE EXCEPTION 'FAIL: 匯款修改紀錄內容不對';
  END IF;
END;
$$;
\echo PASS 11 匯款開放一次改一次後鎖回；存摺開放被收回後無效，重複收回不報錯

-- ── 匯入雲端連結也算已有資料（補漏洞）；完全沒資料的項目可首次填寫 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b2","role":"authenticated"}', false);
SET ROLE authenticated;
DO $$
BEGIN
  UPDATE public.instructors SET id_front_path = 'instructors/00000000-0000-4000-8000-0000000000b2/id_front/x.png' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 已有匯入身分證連結，講師竟可另傳一份';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  UPDATE public.instructors SET bankbook_path = 'instructors/00000000-0000-4000-8000-0000000000b2/bankbook/x.png' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 已有匯入存摺連結，講師竟可另傳一份（原漏洞）';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
SELECT public.test_upsert_instructor(public.test_self_payload(
  '{"id_back_path":"instructors/00000000-0000-4000-8000-0000000000b2/id_back/first.png","id_back_mime":"image/png","bank_account_number":"1111111111","bank_account_name":"講師二"}'));
DO $$
BEGIN
  IF (SELECT id_back_path FROM public.instructors WHERE user_id = auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'FAIL: 沒有資料的身分證反面應可首次上傳';
  END IF;
END;
$$;
DO $$
BEGIN
  UPDATE public.instructors SET id_back_path = 'instructors/00000000-0000-4000-8000-0000000000b2/id_back/second.png' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 首次上傳後竟可再改';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
\echo PASS 12 匯入的雲端連結也算已有資料（存摺漏洞已補）；沒資料的項目可首次填寫、填完即鎖

-- ── 全新講師第一次存檔（真的 INSERT）：可填，且留下首次提交紀錄 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b5","role":"authenticated"}', false);
SELECT public.test_upsert_instructor(jsonb_build_object(
  'user_id', '00000000-0000-4000-8000-0000000000b5', 'full_name', '新講師五',
  'id_front_path', 'instructors/00000000-0000-4000-8000-0000000000b5/id_front/n.png',
  'bankbook_path', 'instructors/00000000-0000-4000-8000-0000000000b5/bankbook/n.png',
  'bank_account_number', '2222222222'));
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_document_changes c
      JOIN public.instructors i ON i.id = c.instructor_id
      WHERE i.user_id = '00000000-0000-4000-8000-0000000000b5'
        AND c.old_value = '{}'::jsonb AND c.changed_by_role = 'instructor') <> 3 THEN
    RAISE EXCEPTION 'FAIL: 新講師首次提交應留下身分證正面、存摺、匯款三筆紀錄';
  END IF;
END;
$$;
\echo PASS 13 新講師第一次存檔可填，留下首次提交紀錄

-- ── 管理員與系統：不受鎖定，修改照樣留紀錄 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
SET ROLE authenticated;
UPDATE public.instructors SET bankbook_path = 'instructors/10000000-0000-4000-8000-0000000000b1/bankbook/admin.png'
WHERE id = '10000000-0000-4000-8000-0000000000b1';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.instructor_document_changes
                 WHERE item = 'bankbook' AND changed_by_role = 'admin' AND unlock_id IS NULL
                   AND changed_by = '00000000-0000-4000-8000-0000000000a1') THEN
    RAISE EXCEPTION 'FAIL: 管理員代換存摺未留紀錄';
  END IF;
  IF (SELECT count(*) FROM public.instructor_document_changes WHERE instructor_id = '10000000-0000-4000-8000-0000000000b1') < 4 THEN
    RAISE EXCEPTION 'FAIL: 管理員應讀得到所有修改紀錄';
  END IF;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);
UPDATE public.instructors SET id_front_external_url = 'https://drive.google.com/open?id=reimport'
WHERE id = '10000000-0000-4000-8000-0000000000b2';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.instructor_document_changes
                 WHERE item = 'id_front' AND changed_by_role = 'system' AND changed_by IS NULL
                   AND new_value ->> 'external_url' = 'https://drive.google.com/open?id=reimport') THEN
    RAISE EXCEPTION 'FAIL: 系統匯入未留紀錄';
  END IF;
END;
$$;
\echo PASS 14 管理員與系統（SQL Editor／匯入）不受鎖定，修改照樣留紀錄

-- ── 輔導員與未登入 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000c1","role":"authenticated"}', false);
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'bankbook');
  RAISE EXCEPTION 'FAIL: 輔導員竟能開放';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_document_changes) <> 0 THEN
    RAISE EXCEPTION 'FAIL: 輔導員看得到修改紀錄（含帳號）';
  END IF;
  IF (SELECT count(*) FROM public.instructor_edit_unlocks) <> 0 THEN
    RAISE EXCEPTION 'FAIL: 輔導員看得到別人的開放權限';
  END IF;
END;
$$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '', false);
SET ROLE anon;
DO $$
BEGIN
  PERFORM 1 FROM public.instructor_edit_unlocks;
  RAISE EXCEPTION 'FAIL: 未登入竟可讀開放權限表';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  PERFORM 1 FROM public.instructor_document_changes;
  RAISE EXCEPTION 'FAIL: 未登入竟可讀修改紀錄';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  PERFORM public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'bankbook');
  RAISE EXCEPTION 'FAIL: 未登入竟可呼叫開放 RPC';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
RESET ROLE;
\echo PASS 15 輔導員不能開放、讀不到紀錄；未登入完全碰不到

-- ── 用掉後可再開放一次（第二輪） ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'id_card') IS NOT NULL AS g2 \gset
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
UPDATE public.instructors SET id_front_path = 'instructors/00000000-0000-4000-8000-0000000000b1/id_front/a3.png' WHERE user_id = auth.uid();
RESET ROLE;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_edit_unlocks WHERE scope = 'id_card' AND consumed_at IS NOT NULL) <> 2 THEN
    RAISE EXCEPTION 'FAIL: 第二輪開放應可再用一次';
  END IF;
END;
$$;
\echo PASS 16 用掉後管理員可再開放一次，講師可再改一次

-- ── 先指向不存在的檔名、鎖定後再上傳：上傳也要擋（資安審查建議 2）──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b3","role":"authenticated"}', false);
SET ROLE authenticated;
UPDATE public.instructors SET id_front_path = 'instructors/00000000-0000-4000-8000-0000000000b3/id_front/ghost.png' WHERE user_id = auth.uid();
DO $$
BEGIN
  INSERT INTO storage.objects (bucket_id, name)
  VALUES ('instructor_uploads', 'instructors/00000000-0000-4000-8000-0000000000b3/id_front/ghost.png');
  RAISE EXCEPTION 'FAIL: 鎖定後竟能把任意圖片上傳到已被引用的檔名（不用開放就換掉證件）';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
RESET ROLE;
\echo PASS 17 已被引用但還不存在的檔名，講師不能事後再上傳

-- ── 開放 72 小時後過期：過期不能用，重新開放可再用 ──
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
SET ROLE authenticated;
SELECT (public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'bankbook')).expires_at
         BETWEEN now() + interval '71 hours' AND now() + interval '73 hours' AS expiry_72h \gset
\if :expiry_72h
\else
  \echo FAIL: 開放期限不是 72 小時
  SELECT 1/0;
\endif
RESET ROLE;
UPDATE public.instructor_edit_unlocks SET expires_at = now() - interval '1 minute'
WHERE instructor_id = '10000000-0000-4000-8000-0000000000b1' AND scope = 'bankbook' AND consumed_at IS NULL AND revoked_at IS NULL;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
SET ROLE authenticated;
DO $$
BEGIN
  UPDATE public.instructors SET bankbook_path = 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/late.png' WHERE user_id = auth.uid();
  RAISE EXCEPTION 'FAIL: 過期的開放竟仍有效';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END;
$$;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.instructor_edit_unlocks
      WHERE scope = 'bankbook' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()) <> 0 THEN
    RAISE EXCEPTION 'FAIL: 講師端查詢應看不到已過期的開放';
  END IF;
END;
$$;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', false);
SELECT public.admin_grant_instructor_edit_unlock('10000000-0000-4000-8000-0000000000b1', 'bankbook') IS NOT NULL AS regranted \gset
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000b1","role":"authenticated"}', false);
UPDATE public.instructors SET bankbook_path = 'instructors/00000000-0000-4000-8000-0000000000b1/bankbook/late.png' WHERE user_id = auth.uid();
RESET ROLE;
DO $$
BEGIN
  IF (SELECT bankbook_path FROM public.instructors WHERE id = '10000000-0000-4000-8000-0000000000b1') NOT LIKE '%/late.png' THEN
    RAISE EXCEPTION 'FAIL: 重新開放後仍改不了';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.instructor_edit_unlocks
                 WHERE scope = 'bankbook' AND revoked_at IS NOT NULL AND revoked_by IS NULL AND consumed_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL: 過期那筆應被標成自然過期（revoked_by 為 NULL）';
  END IF;
END;
$$;
\echo PASS 18 開放 72 小時後過期失效；過期後管理員可重新開放，講師可再改一次

\echo ALL PASS: verify-doc-edit-unlock
