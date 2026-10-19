\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

-- ═══════════════════════════════════════════════════════════════════
-- 合約範本讀取權限收緊：migration 20261019103000 的隔離驗證
--   第一段：模擬正式庫現況（contract_documents SELECT USING (true)、storage 非 signed/ 全體可讀），
--           先證明漏洞存在，套 migration 兩次，再逐角色驗證讀取範圍與前端實際查詢。
--   第二段：新建庫路徑（contracts_setup.sql 跑兩次，再疊 migration）得到同一組政策。
-- 模擬 Supabase：auth.uid()／auth.jwt() 讀 request.jwt.claims；anon／authenticated 預設拿到表級 GRANT。
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

CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  bucket_id text NOT NULL,
  name text NOT NULL,
  owner uuid
);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE
AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
GRANT USAGE ON SCHEMA storage TO authenticated, anon;
GRANT ALL ON storage.objects, storage.buckets TO authenticated, anon;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);
GRANT SELECT ON public.users TO authenticated, anon;

-- 正式庫現況：contract_documents（含 doc_category）＋ 8/19 之後的 storage 讀取政策
CREATE TABLE public.contract_documents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  doc_type text NOT NULL,
  version int NOT NULL DEFAULT 1,
  file_path text NOT NULL,
  file_name text,
  uploaded_by uuid REFERENCES auth.users(id),
  uploaded_at timestamptz DEFAULT now(),
  is_active boolean DEFAULT true,
  display_name text NOT NULL DEFAULT '',
  doc_mode text NOT NULL DEFAULT 'view_only' CHECK (doc_mode IN ('view_only', 'fill_sign')),
  sort_order int NOT NULL DEFAULT 0,
  doc_category text NOT NULL DEFAULT 'contract' CHECK (doc_category IN ('contract', 'form')),
  UNIQUE (doc_type, version)
);
-- Supabase 預設把 public 表的全部權限發給 anon 與 authenticated
GRANT ALL ON public.contract_documents TO authenticated, anon;
ALTER TABLE public.contract_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Authenticated users can read active contract documents"
  ON public.contract_documents FOR SELECT TO authenticated USING (true);
CREATE POLICY "Admins can manage contract documents"
  ON public.contract_documents FOR ALL
  USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "read contract documents scoped"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'contract-documents'
    AND (
      EXISTS (SELECT 1 FROM public.users u WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor'))
      OR ((storage.foldername(name))[1] = 'signed' AND (storage.foldername(name))[2] = (SELECT auth.uid())::text)
      OR (storage.foldername(name))[1] IS DISTINCT FROM 'signed'
    )
  );
CREATE POLICY "Admins can upload contract documents"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'contract-documents' AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));
CREATE POLICY "Users can upload own signatures"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'contract-documents' AND (storage.foldername(name))[1] = 'signed'
              AND (storage.foldername(name))[2] = auth.uid()::text);

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'teacher@test.local'),
  ('00000000-0000-4000-8000-000000000002', 'pending@test.local'),
  ('00000000-0000-4000-8000-000000000003', 'admin@test.local'),
  ('00000000-0000-4000-8000-000000000004', 'teacher2@test.local'),
  ('00000000-0000-4000-8000-000000000005', 'mentor@test.local');
INSERT INTO public.users (id, name, email, role) VALUES
  ('00000000-0000-4000-8000-000000000001', '老師一', 'teacher@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', '待審', 'pending@test.local', 'pending'),
  ('00000000-0000-4000-8000-000000000003', '管理員', 'admin@test.local', 'admin'),
  ('00000000-0000-4000-8000-000000000004', '老師二', 'teacher2@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000005', '輔導員', 'mentor@test.local', 'mentor');

-- 三份啟用中合約文件＋一份停用舊版；行政表單（匯款申請書）啟用 v2＋停用 v1 → 共 6 列
INSERT INTO public.contract_documents (doc_type, version, file_path, display_name, doc_mode, sort_order, is_active, doc_category) VALUES
  ('rules', 2, 'docs/rules_v2.pdf', '講師管理辦法', 'view_only', 1, true, 'contract'),
  ('compensation', 1, 'docs/compensation_v1.pdf', '講師委任報酬表', 'view_only', 2, true, 'contract'),
  ('contract', 3, 'docs/contract_v3.pdf', '委任契約書', 'fill_sign', 3, true, 'contract'),
  ('contract', 2, 'docs/contract_v2.pdf', '委任契約書（舊版）', 'fill_sign', 3, false, 'contract'),
  ('remittance_form', 2, 'templates/remittance_form/v2.pdf', '廠商匯款申請書', 'fill_sign', 9, true, 'form'),
  ('remittance_form', 1, 'templates/remittance_form/v1.pdf', '廠商匯款申請書（舊版）', 'fill_sign', 9, false, 'form');

-- storage：5 個非 signed/ 檔（範本，含一個 bucket 根目錄檔）＋ 老師一 2 個、老師二 1 個、待審 1 個 signed/ 檔
INSERT INTO storage.buckets (id, name, public) VALUES ('contract-documents', 'contract-documents', false);
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('contract-documents', 'docs/rules_v2.pdf'),
  ('contract-documents', 'docs/compensation_v1.pdf'),
  ('contract-documents', 'docs/contract_v3.pdf'),
  ('contract-documents', 'templates/remittance_form/v2.pdf'),
  ('contract-documents', 'root_level.pdf'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000001/signature_1.png'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000001/contract_1.pdf'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000004/signature_9.png'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000002/stray.png'),
  -- 別的 bucket 的檔案，證明政策只管 contract-documents
  ('other-bucket', 'docs/unrelated.pdf');

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
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated')::text, false);
END;
$$;

-- 以目前 session 身分執行 SQL 並回傳列數（SET ROLE 後呼叫）
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

CREATE FUNCTION t.expect_sqlstate(p_label text, p_sql text, p_sqlstate text)
RETURNS void LANGUAGE plpgsql AS $$
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
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, anon;

-- 前端實際送出的查詢（與原始碼對齊）
-- ContractSigningFlow.loadData：is_active ∧ doc_category='contract'，order sort_order, version desc
CREATE FUNCTION t.q_signing_flow() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.contract_documents WHERE is_active = true AND doc_category = 'contract'
             ORDER BY sort_order, version DESC $q$
$$;
-- ProfilePage.loadContractStatus：doc_type, version WHERE is_active ∧ doc_category='contract'
CREATE FUNCTION t.q_profile() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT doc_type, version FROM public.contract_documents WHERE is_active = true AND doc_category = 'contract' $q$
$$;
-- ContractView.loadContract：is_active，order sort_order
CREATE FUNCTION t.q_contract_view() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.contract_documents WHERE is_active = true ORDER BY sort_order $q$
$$;
-- InstructorList.loadInstructors：doc_category='form' ∧ is_active
CREATE FUNCTION t.q_instructor_list() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT doc_type, display_name, version, sort_order FROM public.contract_documents
             WHERE doc_category = 'form' AND is_active = true ORDER BY sort_order, version DESC $q$
$$;
-- DownloadCenter.loadData：doc_category='form'（全部版本）
CREATE FUNCTION t.q_download_center() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.contract_documents WHERE doc_category = 'form' ORDER BY sort_order, version DESC $q$
$$;
-- formGenerator.loadFormTemplate('remittance_form')：doc_type ∧ is_active，order version desc limit 1
CREATE FUNCTION t.q_form_template() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.contract_documents WHERE doc_type = 'remittance_form' AND is_active = true
             ORDER BY version DESC LIMIT 1 $q$
$$;
-- ContractAdmin.loadDocs：全部列
CREATE FUNCTION t.q_all_docs() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT * FROM public.contract_documents $q$
$$;
-- storage：非 signed/ 路徑（範本）／全部 bucket 內檔案
CREATE FUNCTION t.q_templates() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT name FROM storage.objects WHERE bucket_id = 'contract-documents'
             AND (storage.foldername(name))[1] IS DISTINCT FROM 'signed' $q$
$$;
CREATE FUNCTION t.q_bucket_all() RETURNS text LANGUAGE sql AS $$
  SELECT $q$ SELECT name FROM storage.objects WHERE bucket_id = 'contract-documents' $q$
$$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, anon;

-- ═══════════════════════════════════════════════════════════════════
-- 0. 先證明引導區真的重現了漏洞：pending 讀得到全部文件列與範本檔
-- ═══════════════════════════════════════════════════════════════════
SELECT t.as_user('00000000-0000-4000-8000-000000000002') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_all_docs()) = 6, 'bootstrap: pending should read all 6 contract_documents rows before migration') \gset
SELECT t.assert(t.count_rows(t.q_templates()) = 5, 'bootstrap: pending should read all 5 template objects before migration') \gset
RESET ROLE;
\echo PASS: bootstrap reproduces the hole (pending reads 6 document rows and 5 template files before migration)

-- ═══════════════════════════════════════════════════════════════════
-- 套用 migration 兩次
-- ═══════════════════════════════════════════════════════════════════
\ir ../supabase/migrations/20261019103000_restrict_contract_document_reads.sql
\ir ../supabase/migrations/20261019103000_restrict_contract_document_reads.sql
\echo PASS: migration applied twice without error

-- 1. 政策盤點：contract_documents 只剩 1 條 SELECT 政策（新名）＋管理員 FOR ALL；storage 讀取政策只有一條且含 teacher
SELECT t.assert(
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents') = 2
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents' AND cmd = 'SELECT') = 1
  AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents'
               AND policyname = 'Approved roles can read contract documents' AND cmd = 'SELECT'
               AND qual LIKE '%''teacher''%' AND qual LIKE '%''mentor''%' AND qual LIKE '%''admin''%')
  AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents'
                   AND policyname = 'Authenticated users can read active contract documents'),
  'contract_documents policies are not exactly {Approved roles SELECT, Admins FOR ALL}') \gset
SELECT t.assert(
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
     AND policyname = 'read contract documents scoped') = 1
  AND (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
         AND policyname = 'read contract documents scoped') LIKE '%''teacher''%'
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT') = 1,
  'storage read policy missing, duplicated, or lacks the teacher role check') \gset
SELECT t.assert(NOT has_table_privilege('anon', 'public.contract_documents', 'SELECT'), 'anon still has SELECT privilege on contract_documents') \gset
SELECT t.assert(has_table_privilege('authenticated', 'public.contract_documents', 'SELECT'), 'authenticated lost SELECT privilege on contract_documents') \gset
\echo PASS: exactly one SELECT policy on contract_documents (approved roles) plus admin FOR ALL; one storage read policy with teacher check; anon has no table privilege

-- 2. anon：contract_documents 直接 permission denied；storage 0 列
SELECT set_config('request.jwt.claims', '{}', false) \gset
SET ROLE anon;
SELECT t.expect_sqlstate('anon select contract_documents', t.q_all_docs(), '42501') \gset
SELECT t.assert(t.count_rows(t.q_bucket_all()) = 0, 'anon can read contract-documents storage objects') \gset
RESET ROLE;
\echo PASS: anon gets 42501 on contract_documents and 0 storage rows

-- 3. pending：文件 0 列、範本 0 檔；只剩自己 signed/ 資料夾那 1 個檔（既有規則，未放寬）
SELECT t.as_user('00000000-0000-4000-8000-000000000002') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_all_docs()) = 0, 'pending can still read contract_documents') \gset
SELECT t.assert(t.count_rows(t.q_signing_flow()) = 0, 'pending can read signing-flow documents') \gset
SELECT t.assert(t.count_rows(t.q_profile()) = 0, 'pending can read profile version check documents') \gset
SELECT t.assert(t.count_rows(t.q_templates()) = 0, 'pending can still read template files') \gset
SELECT t.assert(t.count_rows(t.q_bucket_all()) = 1, 'pending should see only its own signed/ file') \gset
SELECT t.expect_sqlstate('pending insert contract_documents',
  $q$ INSERT INTO public.contract_documents (doc_type, version, file_path) VALUES ('x', 1, 'x.pdf') $q$, '42501') \gset
RESET ROLE;
\echo PASS: pending reads 0 document rows and 0 template files (only its own signed/ folder), cannot insert

-- 4. teacher：前端五條查詢結果與收緊前相同；範本可讀；別人的 signed/ 讀不到
SELECT t.as_user('00000000-0000-4000-8000-000000000001') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_all_docs()) = 6, 'teacher should read all 6 rows (frontend filters is_active itself)') \gset
SELECT t.assert(t.count_rows(t.q_signing_flow()) = 3, 'teacher signing flow should load 3 active contract documents') \gset
SELECT t.assert(
  (SELECT string_agg(doc_type, ',' ORDER BY sort_order, version DESC)
     FROM public.contract_documents WHERE is_active = true AND doc_category = 'contract') = 'rules,compensation,contract',
  'teacher signing flow order changed') \gset
SELECT t.assert(t.count_rows(t.q_profile()) = 3, 'teacher profile version check should see 3 documents') \gset
SELECT t.assert(t.count_rows(t.q_contract_view()) = 4, 'teacher contract view should see 4 active documents (3 contract + 1 form, as before)') \gset
SELECT t.assert(t.count_rows(t.q_form_template()) = 1
  AND (SELECT version FROM public.contract_documents WHERE doc_type = 'remittance_form' AND is_active = true ORDER BY version DESC LIMIT 1) = 2,
  'teacher loadFormTemplate should resolve remittance_form v2') \gset
SELECT t.assert(t.count_rows(t.q_templates()) = 5, 'teacher should read all 5 template files') \gset
SELECT t.assert(t.count_rows(t.q_bucket_all()) = 7, 'teacher should see 5 templates + own 2 signed files only') \gset
SELECT t.assert(
  t.count_rows($q$ SELECT name FROM storage.objects WHERE bucket_id = 'contract-documents'
                   AND name LIKE 'signed/00000000-0000-4000-8000-000000000004/%' $q$) = 0,
  'teacher can read another teacher''s signed files') \gset
SELECT t.assert(
  t.count_rows($q$ SELECT name FROM storage.objects WHERE bucket_id = 'contract-documents' AND name = 'docs/contract_v3.pdf' $q$) = 1,
  'teacher cannot download the contract template') \gset
SELECT t.expect_sqlstate('teacher insert contract_documents',
  $q$ INSERT INTO public.contract_documents (doc_type, version, file_path) VALUES ('x', 1, 'x.pdf') $q$, '42501') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.contract_documents SET display_name = 'hacked' WHERE doc_type = 'rules' $q$) = 0,
  'teacher could update contract_documents') \gset
RESET ROLE;
\echo PASS: teacher sees the same rows as before (6 total; signing flow 3 in order; profile 3; contract view 4; form template v2), reads templates and own signed files only, cannot write

-- 5. mentor：文件全讀；bucket 全讀（含他人 signed/，既有規則，待業主決定）
SELECT t.as_user('00000000-0000-4000-8000-000000000005') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_all_docs()) = 6, 'mentor should read all 6 rows') \gset
SELECT t.assert(t.count_rows(t.q_instructor_list()) = 1, 'mentor instructor list should see 1 active form template') \gset
SELECT t.assert(t.count_rows(t.q_bucket_all()) = 9, 'mentor bucket read changed (expected unchanged: all 9 files)') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.contract_documents SET display_name = 'x' WHERE doc_type = 'rules' $q$) = 0,
  'mentor could update contract_documents') \gset
RESET ROLE;
\echo PASS: mentor reads all 6 rows and all 9 bucket files (unchanged; signed/ visibility left for the owner to decide), cannot write

-- 6. admin：文件全讀、後台兩條查詢正常、增改刪照常
SELECT t.as_user('00000000-0000-4000-8000-000000000003') \gset
SET ROLE authenticated;
SELECT t.assert(t.count_rows(t.q_all_docs()) = 6, 'admin should read all 6 rows') \gset
SELECT t.assert(t.count_rows(t.q_instructor_list()) = 1, 'admin instructor list should see 1 active form template') \gset
SELECT t.assert(t.count_rows(t.q_download_center()) = 2, 'admin download center should see both form versions') \gset
SELECT t.assert(t.count_rows(t.q_bucket_all()) = 9, 'admin should read all 9 bucket files') \gset
SELECT t.assert(t.exec_count($q$ INSERT INTO public.contract_documents (doc_type, version, file_path, display_name)
                                  VALUES ('rules', 3, 'docs/rules_v3.pdf', '講師管理辦法 v3') $q$) = 1,
  'admin could not insert a new document version') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.contract_documents SET is_active = false WHERE doc_type = 'rules' AND version = 2 $q$) = 1,
  'admin could not deactivate an old version') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.contract_documents WHERE doc_type = 'rules' AND version = 3 $q$) = 1,
  'admin could not delete a document row') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.contract_documents SET is_active = true WHERE doc_type = 'rules' AND version = 2 $q$) = 1,
  'admin could not restore the old version') \gset
RESET ROLE;
\echo PASS: admin reads everything, instructor list 1 / download center 2, and can insert, update, delete

-- 7. 二度確認：所有拒絕案與管理員操作後，資料列數回到 6
SELECT t.assert((SELECT count(*) FROM public.contract_documents) = 6, 'row count drifted after tests') \gset
\echo PASS: contract_documents still has 6 rows after all checks

-- ═══════════════════════════════════════════════════════════════════
-- 第二段：新建庫路徑（contracts_setup.sql 連跑兩次，再疊 migration）
-- ═══════════════════════════════════════════════════════════════════
RESET ALL;
CREATE DATABASE fresh_contract_reads;
\c fresh_contract_reads
\set QUIET on
\pset tuples_only on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text NOT NULL, name text NOT NULL, owner uuid);
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE
AS $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);

\ir ../supabase/contracts_setup.sql
\ir ../supabase/contracts_setup.sql

SELECT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents') = 2
   AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents' AND cmd = 'SELECT') = 1
   AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents'
                AND policyname = 'Approved roles can read contract documents' AND qual LIKE '%''teacher''%')
   AND (SELECT qual FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
          AND policyname = 'read contract documents scoped') LIKE '%''teacher''%'
   AND NOT has_table_privilege('anon', 'public.contract_documents', 'SELECT') AS ok \gset
\if :ok
\else
  \echo FAIL: fresh-database path (contracts_setup.sql x2) does not produce the restricted read policies
  SELECT 1/0;
\endif
\echo PASS: fresh-database path (contracts_setup.sql x2) yields the same restricted read policies and no anon privilege

-- setup 之後再疊 migration 也不會重複或出錯
\ir ../supabase/migrations/20261019103000_restrict_contract_document_reads.sql
SELECT (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents') = 2
   AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT') = 1 AS ok \gset
\if :ok
\else
  \echo FAIL: migration on top of contracts_setup.sql duplicated or dropped policies
  SELECT 1/0;
\endif
\echo PASS: migration applied on top of contracts_setup.sql keeps exactly the same policy set

\echo contract document reads SQL verification passed
