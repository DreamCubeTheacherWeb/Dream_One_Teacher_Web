\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on

-- ═══════════════════════════════════════════════════════════════════
-- 講師簽約重開：migration 20261018180000 的隔離驗證
--   第一段：模擬正式庫現況（instructor_contracts 無 INSERT 政策、無 verified_at 欄位），
--           套 migration 兩次，再逐案驗證 submit_my_contract
--   第二段：新建庫路徑（contracts_setup.sql 跑兩次）也得到同一個函式與相同權限
-- 模擬 Supabase：auth.uid()／auth.jwt() 讀 request.jwt.claims；PostgREST 把 header 放進 request.headers。
-- ═══════════════════════════════════════════════════════════════════

DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- Supabase 預設會把新函式的 EXECUTE 發給 anon／authenticated；這裡照辦，才能證明 migration 真的收回了 anon。
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE
AS $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon;

CREATE SCHEMA storage;
CREATE TABLE storage.objects (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  bucket_id text NOT NULL,
  name text NOT NULL,
  owner uuid
);

CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);
GRANT SELECT ON public.users TO authenticated;

-- 正式庫現況（8/19 資安修補後）：contract_documents 與沒有 verified_at／verify_method 的 instructor_contracts
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

CREATE TABLE public.instructor_contracts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  filled_name text NOT NULL,
  filled_instructor_role text NOT NULL,
  filled_id_number text NOT NULL CHECK (char_length(filled_id_number) = 10),
  filled_address text NOT NULL,
  filled_phone text NOT NULL,
  signature_path text NOT NULL,
  rules_doc_version int NOT NULL DEFAULT 0,
  compensation_doc_version int NOT NULL DEFAULT 0,
  contract_doc_version int NOT NULL DEFAULT 0,
  doc_versions jsonb DEFAULT '{}',
  signed_pdf_paths jsonb DEFAULT '{}',
  signed_at timestamptz DEFAULT now(),
  ip_address text,
  user_agent text,
  status text NOT NULL DEFAULT 'signed' CHECK (status IN ('signed', 'voided')),
  signed_pdf_path text,
  created_at timestamptz DEFAULT now()
);
GRANT ALL ON public.contract_documents, public.instructor_contracts TO authenticated;
ALTER TABLE public.instructor_contracts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own contracts" ON public.instructor_contracts
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Admins can do everything on contracts" ON public.instructor_contracts
  FOR ALL USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'));

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'teacher@test.local'),
  ('00000000-0000-4000-8000-000000000002', 'pending@test.local'),
  ('00000000-0000-4000-8000-000000000003', 'admin@test.local'),
  ('00000000-0000-4000-8000-000000000004', 'teacher2@test.local');
INSERT INTO public.users (id, name, email, role) VALUES
  ('00000000-0000-4000-8000-000000000001', '老師一', 'teacher@test.local', 'teacher'),
  ('00000000-0000-4000-8000-000000000002', '待審', 'pending@test.local', 'pending'),
  ('00000000-0000-4000-8000-000000000003', '管理員', 'admin@test.local', 'admin'),
  ('00000000-0000-4000-8000-000000000004', '老師二', 'teacher2@test.local', 'teacher');

-- 三份啟用中文件（一份 fill_sign）＋ 一份已停用的舊版合約
INSERT INTO public.contract_documents (doc_type, version, file_path, display_name, doc_mode, sort_order, is_active) VALUES
  ('rules', 2, 'docs/rules_v2.pdf', '講師管理辦法', 'view_only', 1, true),
  ('compensation', 1, 'docs/compensation_v1.pdf', '講師委任報酬表', 'view_only', 2, true),
  ('contract', 3, 'docs/contract_v3.pdf', '委任契約書', 'fill_sign', 3, true),
  ('contract', 2, 'docs/contract_v2.pdf', '委任契約書（舊版）', 'fill_sign', 3, false);
-- 後台行政表單（匯款申請書）：啟用中、fill_sign，但不屬於簽約流程，RPC 必須忽略它
INSERT INTO public.contract_documents (doc_type, version, file_path, display_name, doc_mode, sort_order, is_active, doc_category) VALUES
  ('remittance_form', 1, 'templates/remittance_form/v1.pdf', '廠商匯款申請書', 'fill_sign', 9, true, 'form');

-- 老師一已上傳的檔案；另有一個存在但屬於別人資料夾的檔案、一個含 .. 的檔名
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000001/signature_1.png'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000001/contract_1.pdf'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000001/../escape.png'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000004/signature_9.png'),
  ('contract-documents', 'signed/00000000-0000-4000-8000-000000000004/contract_9.pdf');

-- 老師一已有一筆舊的有效合約（成功案要證明它被作廢）
INSERT INTO public.instructor_contracts
  (user_id, filled_name, filled_instructor_role, filled_id_number, filled_address, filled_phone, signature_path, status)
VALUES
  ('00000000-0000-4000-8000-000000000001', '舊約', 'A', 'A000000000', '舊址', '0900000000', 'signed/old/sig.png', 'signed');

-- ── 測試輔助（schema t） ──
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, anon;

CREATE FUNCTION t.assert(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF;
END;
$$;

-- 模擬一個 PostgREST 請求的 JWT 與 header（呼叫後再 SET ROLE authenticated）
CREATE FUNCTION t.as_user(p_uid uuid, p_amr jsonb DEFAULT NULL, p_headers text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    jsonb_strip_nulls(jsonb_build_object('sub', p_uid, 'role', 'authenticated', 'amr', p_amr))::text, false);
  PERFORM set_config('request.headers', COALESCE(p_headers, ''), false);
END;
$$;

CREATE FUNCTION t.amr_otp(p_age_seconds integer, p_method text DEFAULT 'otp') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('method', p_method,
    'timestamp', floor(extract(epoch FROM now()))::bigint - p_age_seconds))
$$;

CREATE FUNCTION t.call_submit(p_sig text, p_pdfs jsonb, p_versions jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  RETURN public.submit_my_contract('王小明', 'A', 'A123456789', '台北市信義區某路 1 號', '0912345678',
    p_sig, p_pdfs, p_versions, 'UA/1.0');
END;
$$;

CREATE FUNCTION t.expect_error(p_label text, p_expected text, p_sqlstate text, p_sig text, p_pdfs jsonb, p_versions jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg text; v_state text;
BEGIN
  BEGIN
    PERFORM t.call_submit(p_sig, p_pdfs, p_versions);
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM; v_state := SQLSTATE;
  END;
  IF v_msg IS NULL THEN
    RAISE EXCEPTION 'ASSERTION FAILED (%): expected error %, but call succeeded', p_label, p_expected;
  END IF;
  IF v_msg <> p_expected OR v_state <> p_sqlstate THEN
    RAISE EXCEPTION 'ASSERTION FAILED (%): expected % [%], got % [%]', p_label, p_expected, p_sqlstate, v_msg, v_state;
  END IF;
END;
$$;

-- 執行任意 SQL 並要求以指定 SQLSTATE 失敗
CREATE FUNCTION t.expect_sqlstate(p_label text, p_sql text, p_sqlstate text, p_message text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  IF v_state IS DISTINCT FROM p_sqlstate OR (p_message IS NOT NULL AND v_msg IS DISTINCT FROM p_message) THEN
    RAISE EXCEPTION 'ASSERTION FAILED (%): expected % [%], got % [%]', p_label, p_message, p_sqlstate, v_msg, COALESCE(v_state, 'no error');
  END IF;
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

-- ═══════════════════════════════════════════════════════════════════
-- 套用 migration 兩次
-- ═══════════════════════════════════════════════════════════════════
\ir ../supabase/migrations/20261018180000_reopen_instructor_contract_signing.sql
\ir ../supabase/migrations/20261018180000_reopen_instructor_contract_signing.sql
\echo PASS: migration applied twice without error

-- 1. pg_proc 只有一個 submit_my_contract（SECURITY DEFINER、空 search_path），並補上 audit 欄位
SELECT t.assert(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'submit_my_contract') = 1,
  'expected exactly one submit_my_contract') \gset
SELECT t.assert(
  EXISTS (SELECT 1 FROM pg_proc p
           WHERE p.oid = 'public.submit_my_contract(text,text,text,text,text,text,jsonb,jsonb,text)'::regprocedure
             AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']),
  'submit_my_contract must be SECURITY DEFINER with empty search_path') \gset
SELECT t.assert(
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'instructor_contracts'
      AND column_name IN ('verified_at', 'verify_method')) = 2,
  'verified_at/verify_method columns missing') \gset
\echo PASS: pg_proc has exactly one submit_my_contract (SECURITY DEFINER, empty search_path); verified_at/verify_method columns exist

-- 2. 權限：anon 不能執行、authenticated 可以
SELECT t.assert(NOT has_function_privilege('anon', 'public.submit_my_contract(text,text,text,text,text,text,jsonb,jsonb,text)', 'EXECUTE'),
  'anon can execute submit_my_contract') \gset
SELECT t.assert(has_function_privilege('authenticated', 'public.submit_my_contract(text,text,text,text,text,text,jsonb,jsonb,text)', 'EXECUTE'),
  'authenticated cannot execute submit_my_contract') \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000001', t.amr_otp(60)) \gset
SET ROLE anon;
SELECT t.expect_sqlstate('anon call', $q$ SELECT public.submit_my_contract('a','b','c','d','e','f','{}'::jsonb,'{}'::jsonb,'u') $q$, '42501') \gset
RESET ROLE;
\echo PASS: anon has no EXECUTE and cannot call it; authenticated has EXECUTE

-- 3. pending 角色被拒絕（即使有新鮮的 Email 驗證）
SELECT t.as_user('00000000-0000-4000-8000-000000000002', t.amr_otp(60)) \gset
SET ROLE authenticated;
SELECT t.expect_error('pending role', 'role not allowed', '42501',
  'signed/00000000-0000-4000-8000-000000000002/signature_1.png', '{"contract":"x.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
-- 未登入（沒有 sub）
SELECT set_config('request.jwt.claims', '{}', false) \gset
SET ROLE authenticated;
SELECT t.expect_error('no auth', 'authentication required', '42501',
  'signed/x/signature_1.png', '{}'::jsonb, '{}'::jsonb) \gset
RESET ROLE;
\echo PASS: pending role and unauthenticated caller are rejected

-- 4. teacher 沒有 amr、或只有 oauth（Google 登入）→ EMAIL_VERIFICATION_REQUIRED
SELECT t.as_user('00000000-0000-4000-8000-000000000001', NULL) \gset
SET ROLE authenticated;
SELECT t.expect_error('no amr', 'EMAIL_VERIFICATION_REQUIRED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
SELECT t.as_user('00000000-0000-4000-8000-000000000001', t.amr_otp(10, 'oauth')) \gset
SET ROLE authenticated;
SELECT t.expect_error('oauth only', 'EMAIL_VERIFICATION_REQUIRED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
\echo PASS: teacher without amr (or with oauth-only amr) gets EMAIL_VERIFICATION_REQUIRED

-- 5. amr 是 otp 但 2 小時前 → EMAIL_VERIFICATION_REQUIRED
SELECT t.as_user('00000000-0000-4000-8000-000000000001', t.amr_otp(7200)) \gset
SET ROLE authenticated;
SELECT t.expect_error('stale otp', 'EMAIL_VERIFICATION_REQUIRED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
\echo PASS: otp verification 2 hours old is rejected (30 minute window)

-- 6. 驗證新鮮但 doc_versions 是舊版／缺文件 → DOC_VERSION_MISMATCH
SELECT t.as_user('00000000-0000-4000-8000-000000000001', t.amr_otp(60)) \gset
SET ROLE authenticated;
SELECT t.expect_error('old contract version', 'DOC_VERSION_MISMATCH', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":2}'::jsonb) \gset
SELECT t.expect_error('missing rules version', 'DOC_VERSION_MISMATCH', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
\echo PASS: stale or missing doc_versions rejected with DOC_VERSION_MISMATCH

-- 7. 路徑不在自己的 signed/<uid>/ 底下、或含 .. → FILE_NOT_UPLOADED（即使那個檔案確實存在）
SET ROLE authenticated;
SELECT t.expect_error('other users folder', 'FILE_NOT_UPLOADED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000004/signature_9.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
SELECT t.expect_error('pdf in other users folder', 'FILE_NOT_UPLOADED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000004/contract_9.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
SELECT t.expect_error('dot-dot path', 'FILE_NOT_UPLOADED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/../escape.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
SELECT t.expect_error('wrong extension', 'FILE_NOT_UPLOADED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/contract_1.pdf',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
\echo PASS: paths outside signed/<uid>/, with .., or with wrong extension rejected (FILE_NOT_UPLOADED)

-- 8. 路徑格式對但 storage.objects 沒有 → FILE_NOT_UPLOADED
SET ROLE authenticated;
SELECT t.expect_error('signature not uploaded', 'FILE_NOT_UPLOADED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/not_uploaded.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
SELECT t.expect_error('pdf not uploaded', 'FILE_NOT_UPLOADED', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/not_uploaded.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
\echo PASS: well-formed paths missing from storage.objects rejected (FILE_NOT_UPLOADED)

-- 9. fill_sign 文件缺 signed pdf → SIGNED_PDF_MISSING
SET ROLE authenticated;
SELECT t.expect_error('missing signed pdf', 'SIGNED_PDF_MISSING', 'P0001',
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb) \gset
RESET ROLE;
-- 輸入清洗：空白姓名、身分證長度不對、姓名過長 → INVALID_INPUT
SET ROLE authenticated;
SELECT t.expect_sqlstate('blank name', $q$ SELECT public.submit_my_contract('   ', 'A', 'A123456789', 'addr', '0912', 'signed/x/s.png', '{}'::jsonb, '{}'::jsonb, 'u') $q$, 'P0001', 'INVALID_INPUT') \gset
SELECT t.expect_sqlstate('short id number', $q$ SELECT public.submit_my_contract('王', 'A', 'A12345', 'addr', '0912', 'signed/x/s.png', '{}'::jsonb, '{}'::jsonb, 'u') $q$, 'P0001', 'INVALID_INPUT') \gset
SELECT t.expect_sqlstate('over-long name', format($q$ SELECT public.submit_my_contract(%L, 'A', 'A123456789', 'addr', '0912', 'signed/x/s.png', '{}'::jsonb, '{}'::jsonb, 'u') $q$, repeat('名', 101)), 'P0001', 'INVALID_INPUT') \gset
RESET ROLE;
\echo PASS: fill_sign document without signed pdf rejected (SIGNED_PDF_MISSING); blank / short / over-long inputs rejected (INVALID_INPUT)

-- 沒有任何拒絕案寫入資料：老師一仍只有最初那一筆
SELECT t.assert((SELECT count(*) FROM public.instructor_contracts WHERE user_id = '00000000-0000-4000-8000-000000000001') = 1,
  'a rejected call left rows behind') \gset
SELECT t.assert((SELECT count(*) FROM public.instructor_contracts WHERE status = 'voided') = 0,
  'a rejected call voided an old contract') \gset
\echo PASS: all rejected calls left instructor_contracts untouched

-- 10. 成功案：作廢舊約＋新增新約，IP 取自 x-forwarded-for 第一段
SELECT floor(extract(epoch FROM now()))::bigint - 120 AS ts \gset
SELECT t.as_user('00000000-0000-4000-8000-000000000001',
  jsonb_build_array(jsonb_build_object('method', 'otp', 'timestamp', :ts)),
  '{"x-forwarded-for":"1.2.3.4, 10.0.0.1"}') \gset
SET ROLE authenticated;
SELECT t.call_submit(
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb)::text AS res \gset
RESET ROLE;

SELECT t.assert((:'res'::jsonb ->> 'id') IS NOT NULL, 'result has no id') \gset
SELECT t.assert(
  EXISTS (SELECT 1 FROM public.instructor_contracts c
           WHERE c.id = (:'res'::jsonb ->> 'id')::uuid
             AND c.user_id = '00000000-0000-4000-8000-000000000001'
             AND c.status = 'signed'
             AND c.verify_method = 'email_otp'
             AND c.verified_at = to_timestamp(:ts)
             AND c.ip_address = '1.2.3.4'
             AND c.user_agent = 'UA/1.0'
             AND c.filled_name = '王小明'
             AND c.rules_doc_version = 2 AND c.compensation_doc_version = 1 AND c.contract_doc_version = 3
             AND c.signed_pdf_path = 'signed/00000000-0000-4000-8000-000000000001/contract_1.pdf'
             AND c.signature_path = 'signed/00000000-0000-4000-8000-000000000001/signature_1.png'
             AND c.doc_versions = '{"rules":2,"compensation":1,"contract":3}'::jsonb),
  'new contract row has wrong content') \gset
SELECT t.assert((:'res'::jsonb ->> 'status') = 'signed' AND (:'res'::jsonb ->> 'verify_method') = 'email_otp',
  'returned jsonb is not the new row') \gset
SELECT t.assert((SELECT status FROM public.instructor_contracts WHERE signature_path = 'signed/old/sig.png') = 'voided',
  'old contract was not voided') \gset
SELECT t.assert((SELECT count(*) FROM public.instructor_contracts
                  WHERE user_id = '00000000-0000-4000-8000-000000000001' AND status = 'signed') = 1,
  'expected exactly one signed contract') \gset
\echo PASS: success case returns the new row (status signed, email_otp, verified_at = amr timestamp, ip 1.2.3.4); old contract voided; exactly one signed

-- 再簽一次：舊的新約被作廢，仍然只有一筆 signed；cf-connecting-ip 優先於 x-forwarded-for；magiclink 也算 Email 驗證
SELECT t.as_user('00000000-0000-4000-8000-000000000001', t.amr_otp(30, 'magiclink'),
  '{"cf-connecting-ip":"203.0.113.7","x-forwarded-for":"1.2.3.4"}') \gset
SET ROLE authenticated;
SELECT t.call_submit(
  'signed/00000000-0000-4000-8000-000000000001/signature_1.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000001/contract_1.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb)::text AS res2 \gset
RESET ROLE;
SELECT t.assert(
  (SELECT count(*) FROM public.instructor_contracts WHERE user_id = '00000000-0000-4000-8000-000000000001' AND status = 'signed') = 1
  AND (SELECT count(*) FROM public.instructor_contracts WHERE user_id = '00000000-0000-4000-8000-000000000001' AND status = 'voided') = 2
  AND (SELECT ip_address FROM public.instructor_contracts WHERE id = (:'res2'::jsonb ->> 'id')::uuid) = '203.0.113.7',
  'second submission did not void the first / ip priority wrong') \gset
\echo PASS: resubmission voids the previous contract (1 signed, 2 voided); cf-connecting-ip beats x-forwarded-for; magiclink accepted

-- 沒有 request.headers 時 IP 為 NULL，不報錯
SELECT t.as_user('00000000-0000-4000-8000-000000000004', t.amr_otp(30), NULL) \gset
SET ROLE authenticated;
SELECT public.submit_my_contract('老師二', 'B', 'B123456789', '高雄市', '0922333444',
  'signed/00000000-0000-4000-8000-000000000004/signature_9.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000004/contract_9.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb, repeat('x', 900))::text AS res3 \gset
RESET ROLE;
SELECT t.assert(
  (SELECT ip_address IS NULL AND char_length(user_agent) = 500 FROM public.instructor_contracts
    WHERE id = (:'res3'::jsonb ->> 'id')::uuid),
  'missing headers must give NULL ip and over-long user agent must be truncated to 500') \gset
-- header 不是合法 JSON 也不報錯
SELECT t.as_user('00000000-0000-4000-8000-000000000004', t.amr_otp(30), 'not json') \gset
SET ROLE authenticated;
SELECT t.call_submit(
  'signed/00000000-0000-4000-8000-000000000004/signature_9.png',
  '{"contract":"signed/00000000-0000-4000-8000-000000000004/contract_9.pdf"}'::jsonb,
  '{"rules":2,"compensation":1,"contract":3}'::jsonb)::text AS res4 \gset
RESET ROLE;
SELECT t.assert((SELECT ip_address IS NULL FROM public.instructor_contracts WHERE id = (:'res4'::jsonb ->> 'id')::uuid),
  'invalid header JSON must give NULL ip') \gset
\echo PASS: missing or malformed request.headers gives NULL ip; user agent truncated to 500

-- 11. authenticated 直接 INSERT／UPDATE／DELETE instructor_contracts 仍被 RLS 擋下；沒有 INSERT 政策
SELECT t.as_user('00000000-0000-4000-8000-000000000001', t.amr_otp(30)) \gset
SET ROLE authenticated;
SELECT t.expect_sqlstate('direct insert',
  $q$ INSERT INTO public.instructor_contracts
       (user_id, filled_name, filled_instructor_role, filled_id_number, filled_address, filled_phone, signature_path)
     VALUES ('00000000-0000-4000-8000-000000000001', 'x', 'A', 'A123456789', 'x', 'x', 'signed/x/sig.png') $q$,
  '42501') \gset
SELECT t.assert(t.exec_count($q$ UPDATE public.instructor_contracts SET status = 'voided' WHERE user_id = '00000000-0000-4000-8000-000000000001' $q$) = 0,
  'teacher could update own contracts') \gset
SELECT t.assert(t.exec_count($q$ DELETE FROM public.instructor_contracts WHERE user_id = '00000000-0000-4000-8000-000000000001' $q$) = 0,
  'teacher could delete own contracts') \gset
RESET ROLE;
SELECT t.assert(
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'instructor_contracts' AND cmd = 'INSERT')
  AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'instructor_contracts') = 2,
  'instructor_contracts must keep only the select policy and the admin policy') \gset
\echo PASS: authenticated direct INSERT is rejected by RLS; UPDATE/DELETE touch 0 rows; no INSERT policy exists

-- ═══════════════════════════════════════════════════════════════════
-- 第二段：新建庫路徑（contracts_setup.sql 連跑兩次）
-- ═══════════════════════════════════════════════════════════════════
RESET ALL;
CREATE DATABASE fresh_contracts;
\c fresh_contracts
\set QUIET on
\pset tuples_only on

CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
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

SELECT count(*) = 1
   AND bool_and(p.prosecdef)
   AND bool_and(NOT has_function_privilege('anon', p.oid, 'EXECUTE'))
   AND bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) AS ok
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'submit_my_contract' \gset
\if :ok
\else
  \echo FAIL: fresh-database path lacks a correct submit_my_contract
  SELECT 1/0;
\endif
SELECT count(*) = 2
   AND count(*) FILTER (WHERE cmd = 'INSERT') = 0 AS ok
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'instructor_contracts' \gset
\if :ok
\else
  \echo FAIL: fresh-database instructor_contracts policies are wrong
  SELECT 1/0;
\endif
SELECT count(*) = 2 AS ok FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'instructor_contracts'
   AND column_name IN ('verified_at', 'verify_method') \gset
\if :ok
\else
  \echo FAIL: fresh-database instructor_contracts lacks audit columns
  SELECT 1/0;
\endif
\echo PASS: fresh-database path (contracts_setup.sql x2) yields one correct submit_my_contract, no INSERT policy, audit columns

\echo contract signing SQL verification passed
