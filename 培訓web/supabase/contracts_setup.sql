-- ═══════════════════════════════════════════════════════════════════
-- 講師線上簽約功能 — Supabase Schema Migration (v2 — 彈性化多文件)
-- 可直接在 Supabase SQL Editor 執行
-- ═══════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────
-- 1. 合約文件表（可自由新增任意數量的文件類型）
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contract_documents (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  doc_type TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  file_path TEXT NOT NULL,
  file_name TEXT,
  uploaded_by UUID REFERENCES auth.users(id),
  uploaded_at TIMESTAMPTZ DEFAULT now(),
  is_active BOOLEAN DEFAULT true,
  display_name TEXT NOT NULL DEFAULT '',
  doc_mode TEXT NOT NULL DEFAULT 'view_only' CHECK (doc_mode IN ('view_only', 'fill_sign')),
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE(doc_type, version)
);

-- 若從舊版升級：移除舊 CHECK、新增欄位（冪等）
DO $$ BEGIN
  ALTER TABLE public.contract_documents DROP CONSTRAINT IF EXISTS contract_documents_doc_type_check;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE public.contract_documents ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE public.contract_documents ADD COLUMN IF NOT EXISTS doc_mode TEXT NOT NULL DEFAULT 'view_only';
  ALTER TABLE public.contract_documents ADD CONSTRAINT contract_documents_doc_mode_check CHECK (doc_mode IN ('view_only', 'fill_sign'));
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE public.contract_documents ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0;
EXCEPTION WHEN others THEN NULL;
END $$;

-- 遷移舊資料
UPDATE public.contract_documents SET
  display_name = CASE doc_type
    WHEN 'rules' THEN '講師管理辦法'
    WHEN 'compensation' THEN '講師委任報酬表'
    WHEN 'contract' THEN '委任契約書'
    ELSE display_name
  END,
  doc_mode = CASE doc_type
    WHEN 'contract' THEN 'fill_sign'
    ELSE 'view_only'
  END,
  sort_order = CASE doc_type
    WHEN 'rules' THEN 1
    WHEN 'compensation' THEN 2
    WHEN 'contract' THEN 3
    ELSE sort_order
  END
WHERE display_name = '' OR display_name IS NULL;

ALTER TABLE public.contract_documents ENABLE ROW LEVEL SECURITY;

-- 讀取只給已核准角色（2026-10-19 收緊；pending 讀不到範本清單）。
-- 舊名政策 USING (true) 若存在一併移除，確保只剩這一條讀取政策。
DROP POLICY IF EXISTS "Authenticated users can read active contract documents" ON public.contract_documents;
DROP POLICY IF EXISTS "Approved roles can read contract documents" ON public.contract_documents;
CREATE POLICY "Approved roles can read contract documents"
  ON public.contract_documents FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.users u
       WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
    )
  );

REVOKE ALL ON TABLE public.contract_documents FROM anon;

DO $$ BEGIN
  CREATE POLICY "Admins can manage contract documents"
    ON public.contract_documents FOR ALL
    USING (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────
-- 1.5 合約欄位定位表（管理員在 PDF 上拖拉設定的欄位位置）
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.contract_field_positions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  doc_type TEXT NOT NULL,
  doc_version INT NOT NULL,
  field_type TEXT NOT NULL,
  page_number INT NOT NULL,
  x FLOAT NOT NULL,
  y_from_top FLOAT NOT NULL,
  width FLOAT NOT NULL,
  height FLOAT NOT NULL,
  font_size FLOAT DEFAULT 13,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 舊版建表檔會產生這組自動命名的唯一約束；重跑 setup 時也要可正確移除。
DO $$
DECLARE
  matching_constraint text;
BEGIN
  FOR matching_constraint IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.contract_field_positions'::regclass
      AND constraint_row.contype = 'u'
      AND (
        SELECT array_agg(attribute_row.attname::text ORDER BY constraint_key.ordinality)
        FROM unnest(constraint_row.conkey) WITH ORDINALITY
          AS constraint_key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = constraint_key.attnum
      ) = ARRAY['doc_type', 'doc_version', 'field_type', 'page_number']::text[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.contract_field_positions DROP CONSTRAINT %I',
      matching_constraint
    );
  END LOOP;
END;
$$;

CREATE INDEX IF NOT EXISTS contract_field_positions_doc_type_version_idx
  ON public.contract_field_positions (doc_type, doc_version);

ALTER TABLE public.contract_field_positions ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Authenticated users can read field positions"
    ON public.contract_field_positions FOR SELECT
    TO authenticated
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins can manage field positions"
    ON public.contract_field_positions FOR ALL
    USING (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 同一個欄位可在同頁重複擺放；以單一交易取代前端分開刪除與新增。
CREATE OR REPLACE FUNCTION public.replace_contract_field_positions(
  p_doc_type text,
  p_doc_version integer,
  p_positions jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF (SELECT auth.uid()) IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.users user_row
    WHERE user_row.id = (SELECT auth.uid())
      AND user_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'admin access required to replace contract field positions';
  END IF;

  IF NULLIF(btrim(p_doc_type), '') IS NULL
     OR p_doc_version IS NULL
     OR p_doc_version < 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'document type and positive document version are required';
  END IF;

  IF p_positions IS NULL OR jsonb_typeof(p_positions) <> 'array' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'positions must be a JSON array';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(p_doc_type),
    p_doc_version
  );

  DELETE FROM public.contract_field_positions
  WHERE doc_type = p_doc_type
    AND doc_version = p_doc_version;

  INSERT INTO public.contract_field_positions (
    doc_type,
    doc_version,
    field_type,
    page_number,
    x,
    y_from_top,
    width,
    height,
    font_size
  )
  SELECT
    p_doc_type,
    p_doc_version,
    position_row.field_type,
    position_row.page_number,
    position_row.x,
    position_row.y_from_top,
    position_row.width,
    position_row.height,
    position_row.font_size
  FROM jsonb_to_recordset(p_positions) AS position_row(
    field_type text,
    page_number integer,
    x double precision,
    y_from_top double precision,
    width double precision,
    height double precision,
    font_size double precision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.replace_contract_field_positions(text, integer, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_contract_field_positions(text, integer, jsonb)
  TO authenticated;

-- ──────────────────────────────────────────────────────────────────
-- 2. 講師簽約紀錄表
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.instructor_contracts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id),

  filled_name TEXT NOT NULL,
  filled_instructor_role TEXT NOT NULL,
  filled_id_number TEXT NOT NULL CHECK (char_length(filled_id_number) = 10),
  filled_address TEXT NOT NULL,
  filled_phone TEXT NOT NULL,

  signature_path TEXT NOT NULL,

  rules_doc_version INT NOT NULL DEFAULT 0,
  compensation_doc_version INT NOT NULL DEFAULT 0,
  contract_doc_version INT NOT NULL DEFAULT 0,

  doc_versions JSONB DEFAULT '{}',
  signed_pdf_paths JSONB DEFAULT '{}',

  signed_at TIMESTAMPTZ DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT,

  status TEXT NOT NULL DEFAULT 'signed' CHECK (status IN ('signed', 'voided')),

  signed_pdf_path TEXT,

  created_at TIMESTAMPTZ DEFAULT now()
);

-- 若從舊版升級：新增 JSONB 欄位（冪等）
DO $$ BEGIN
  ALTER TABLE public.instructor_contracts ADD COLUMN IF NOT EXISTS doc_versions JSONB DEFAULT '{}';
EXCEPTION WHEN others THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE public.instructor_contracts ADD COLUMN IF NOT EXISTS signed_pdf_paths JSONB DEFAULT '{}';
EXCEPTION WHEN others THEN NULL;
END $$;

-- 將舊資料的固定三欄版本號搬入 JSONB
UPDATE public.instructor_contracts SET
  doc_versions = jsonb_build_object(
    'rules', rules_doc_version,
    'compensation', compensation_doc_version,
    'contract', contract_doc_version
  )
WHERE doc_versions = '{}'::jsonb AND rules_doc_version IS NOT NULL AND rules_doc_version > 0;

ALTER TABLE public.instructor_contracts ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can view own contracts"
    ON public.instructor_contracts FOR SELECT
    TO authenticated
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 合約完成紀錄屬法律／稽核資料，不接受 client 直接 INSERT。
-- 前台簽約（2026-10-18 重開）一律改由可信 RPC public.submit_my_contract 建立（見本檔第 5 節與
-- migrations/20261018180000_reopen_instructor_contract_signing.sql）：函式內驗證 JWT 的 Email 驗證、
-- 文件版本與已上傳檔案。不可為了方便再加回 INSERT policy。
DROP POLICY IF EXISTS "Users can insert own contracts" ON public.instructor_contracts;

DO $$ BEGIN
  CREATE POLICY "Admins can do everything on contracts"
    ON public.instructor_contracts FOR ALL
    USING (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────
-- 3. Storage Bucket: contract-documents (private)
-- ──────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contract-documents',
  'contract-documents',
  false,
  52428800,
  ARRAY['application/pdf', 'image/png', 'image/jpeg']
)
ON CONFLICT (id) DO NOTHING;

-- Storage Policies

DROP POLICY IF EXISTS "Authenticated can read contract documents storage" ON storage.objects;
DROP POLICY IF EXISTS "read contract documents scoped" ON storage.objects;
-- 本人 signed/<uid>/、admin／mentor 整個 bucket、範本等非 signed/ 路徑只給已核准角色
-- （2026-10-19 收緊：pending 讀不到範本檔）。
CREATE POLICY "read contract documents scoped"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'contract-documents'
    AND (
      (
        (storage.foldername(name))[1] = 'signed'
        AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
      )
      OR EXISTS (
        SELECT 1 FROM public.users u
         WHERE u.id = (SELECT auth.uid()) AND u.role IN ('admin', 'mentor')
      )
      OR (
        (storage.foldername(name))[1] IS DISTINCT FROM 'signed'
        AND EXISTS (
          SELECT 1 FROM public.users u
           WHERE u.id = (SELECT auth.uid()) AND u.role IN ('teacher', 'mentor', 'admin')
        )
      )
    )
  );

DO $$ BEGIN
  CREATE POLICY "Admins can upload contract documents"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'contract-documents'
      AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins can update contract documents storage"
    ON storage.objects FOR UPDATE
    TO authenticated
    USING (
      bucket_id = 'contract-documents'
      AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins can delete contract documents storage"
    ON storage.objects FOR DELETE
    TO authenticated
    USING (
      bucket_id = 'contract-documents'
      AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can upload own signatures"
    ON storage.objects FOR INSERT
    TO authenticated
    WITH CHECK (
      bucket_id = 'contract-documents'
      AND (storage.foldername(name))[1] = 'signed'
      AND (storage.foldername(name))[2] = auth.uid()::text
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────
-- 4. 更新 delete_user_completely 函式以包含合約紀錄
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION delete_user_completely(target_user_id uuid)
RETURNS void AS $$
DECLARE
  target_email text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'permission denied: admin only';
  END IF;

  SELECT email INTO target_email FROM auth.users WHERE id = target_user_id;

  DELETE FROM public.instructor_contracts WHERE user_id = target_user_id;
  DELETE FROM public.instructors WHERE user_id = target_user_id;
  DELETE FROM public.progress WHERE user_id = target_user_id;
  DELETE FROM public.assignments WHERE user_id = target_user_id;
  DELETE FROM public.course_training_status WHERE user_id = target_user_id;
  DELETE FROM public.notifications WHERE user_id = target_user_id;
  DELETE FROM public.users WHERE id = target_user_id;

  IF target_email IS NOT NULL THEN
    DELETE FROM public.teacher_invites WHERE email = target_email;
  END IF;

  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE ALL ON FUNCTION public.delete_user_completely(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_completely(uuid) TO authenticated;

-- ──────────────────────────────────────────────────────────────────
-- 5. 講師簽約的可信寫入通道 submit_my_contract（2026-10-18，與 migrations/20261018180000 同一份定義）
-- ──────────────────────────────────────────────────────────────────

-- 7/07 的 supabase/2026-07-07_esign_verification.sql 可能尚未套進正式庫，這裡冪等補上。
ALTER TABLE public.instructor_contracts
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verify_method text;

-- 先移除同名的所有多載，避免 PostgREST 呼叫歧義。
DO $$
DECLARE
  old_function record;
BEGIN
  FOR old_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'submit_my_contract'
  LOOP
    EXECUTE format('DROP FUNCTION %s', old_function.signature);
  END LOOP;
END;
$$;

CREATE FUNCTION public.submit_my_contract(
  p_filled_name text,
  p_filled_instructor_role text,
  p_filled_id_number text,
  p_filled_address text,
  p_filled_phone text,
  p_signature_path text,
  p_signed_pdf_paths jsonb,
  p_doc_versions jsonb,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_amr jsonb;
  v_verified_epoch numeric;
  v_name text := NULLIF(btrim(p_filled_name), '');
  v_instructor_role text := NULLIF(btrim(p_filled_instructor_role), '');
  v_id_number text := NULLIF(btrim(p_filled_id_number), '');
  v_address text := NULLIF(btrim(p_filled_address), '');
  v_phone text := NULLIF(btrim(p_filled_phone), '');
  v_user_agent text := NULLIF(left(btrim(COALESCE(p_user_agent, '')), 500), '');
  v_prefix text;
  v_path text;
  v_doc record;
  v_headers jsonb;
  v_ip text;
  v_row public.instructor_contracts%ROWTYPE;
BEGIN
  -- a. 必須登入
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  -- b. 角色必須存在且已通過審核（非 pending）
  SELECT user_row.role::text INTO v_role
  FROM public.users user_row
  WHERE user_row.id = v_uid;

  IF v_role IS NULL OR v_role = 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'role not allowed';
  END IF;

  -- c. Email 身分驗證：只認 JWT amr 裡 otp／magiclink 且 30 分鐘內的紀錄
  v_amr := auth.jwt() -> 'amr';
  IF v_amr IS NOT NULL AND jsonb_typeof(v_amr) = 'array' THEN
    SELECT max(
             CASE
               WHEN jsonb_typeof(amr_item.item -> 'timestamp') = 'number'
                 THEN (amr_item.item ->> 'timestamp')::numeric
               ELSE NULL
             END
           )
    INTO v_verified_epoch
    FROM jsonb_array_elements(v_amr) AS amr_item(item)
    WHERE jsonb_typeof(amr_item.item) = 'object'
      AND amr_item.item ->> 'method' IN ('otp', 'magiclink');
  END IF;

  IF v_verified_epoch IS NULL
     OR v_verified_epoch < extract(epoch FROM pg_catalog.now()) - 1800 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'EMAIL_VERIFICATION_REQUIRED';
  END IF;

  -- d. 輸入清洗與長度限制
  IF v_name IS NULL OR v_instructor_role IS NULL OR v_id_number IS NULL
     OR v_address IS NULL OR v_phone IS NULL
     OR char_length(v_id_number) <> 10
     OR char_length(v_name) > 100
     OR char_length(v_instructor_role) > 50
     OR char_length(v_address) > 300
     OR char_length(v_phone) > 30
     OR p_signature_path IS NULL
     OR p_signed_pdf_paths IS NULL OR jsonb_typeof(p_signed_pdf_paths) <> 'object'
     OR p_doc_versions IS NULL OR jsonb_typeof(p_doc_versions) <> 'object'
     OR char_length(p_signed_pdf_paths::text) > 8000
     OR char_length(p_doc_versions::text) > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_INPUT';
  END IF;

  -- e. 文件版本：每種啟用中的文件，送來的版本必須等於目前啟用版本
  --    （同一 doc_type 若有多筆啟用，與前台一致取最高版本）
  -- 行政表單（doc_category = 'form'，如匯款申請書）不屬於簽約流程；用 to_jsonb 取欄位，
  -- 讓尚未加 doc_category 欄位的環境也能執行。
  IF NOT EXISTS (
    SELECT 1 FROM public.contract_documents document_row
    WHERE document_row.is_active = true
      AND COALESCE(to_jsonb(document_row) ->> 'doc_category', 'contract') <> 'form'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NO_ACTIVE_DOCUMENTS';
  END IF;

  FOR v_doc IN
    SELECT DISTINCT ON (document_row.doc_type)
           document_row.doc_type, document_row.version, document_row.doc_mode
    FROM public.contract_documents document_row
    WHERE document_row.is_active = true
      AND COALESCE(to_jsonb(document_row) ->> 'doc_category', 'contract') <> 'form'
    ORDER BY document_row.doc_type, document_row.version DESC
  LOOP
    IF (p_doc_versions ->> v_doc.doc_type) IS DISTINCT FROM v_doc.version::text THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'DOC_VERSION_MISMATCH';
    END IF;
    IF v_doc.doc_mode = 'fill_sign'
       AND NULLIF(p_signed_pdf_paths ->> v_doc.doc_type, '') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'SIGNED_PDF_MISSING';
    END IF;
  END LOOP;

  -- f. 檔案路徑：只能是自己 signed/<uid>/ 底下、副檔名正確、且確實已上傳
  v_prefix := 'signed/' || v_uid::text || '/';

  IF left(p_signature_path, char_length(v_prefix)) <> v_prefix
     OR position('..' IN p_signature_path) > 0
     OR right(p_signature_path, 4) <> '.png'
     OR NOT EXISTS (
       SELECT 1 FROM storage.objects object_row
       WHERE object_row.bucket_id = 'contract-documents'
         AND object_row.name = p_signature_path
     ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FILE_NOT_UPLOADED';
  END IF;

  FOR v_path IN
    SELECT path_item.value FROM jsonb_each_text(p_signed_pdf_paths) AS path_item(key, value)
  LOOP
    IF v_path IS NULL
       OR left(v_path, char_length(v_prefix)) <> v_prefix
       OR position('..' IN v_path) > 0
       OR right(v_path, 4) <> '.pdf'
       OR NOT EXISTS (
         SELECT 1 FROM storage.objects object_row
         WHERE object_row.bucket_id = 'contract-documents'
           AND object_row.name = v_path
       ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'FILE_NOT_UPLOADED';
    END IF;
  END LOOP;

  -- g. IP：由伺服器端 request header 取得（PostgREST 會把 header 放進 request.headers）
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  IF v_headers IS NOT NULL AND jsonb_typeof(v_headers) = 'object' THEN
    v_ip := NULLIF(btrim(v_headers ->> 'cf-connecting-ip'), '');
    IF v_ip IS NULL THEN
      v_ip := NULLIF(btrim(split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
    END IF;
    v_ip := left(v_ip, 64);
  END IF;

  -- h. 同一交易：作廢該使用者舊的有效合約，再新增這一份
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('submit_my_contract'),
    pg_catalog.hashtext(v_uid::text)
  );

  UPDATE public.instructor_contracts contract_row
  SET status = 'voided'
  WHERE contract_row.user_id = v_uid
    AND contract_row.status = 'signed';

  INSERT INTO public.instructor_contracts (
    user_id,
    filled_name,
    filled_instructor_role,
    filled_id_number,
    filled_address,
    filled_phone,
    signature_path,
    rules_doc_version,
    compensation_doc_version,
    contract_doc_version,
    doc_versions,
    signed_pdf_paths,
    signed_pdf_path,
    signed_at,
    ip_address,
    user_agent,
    verified_at,
    verify_method,
    status
  )
  VALUES (
    v_uid,
    v_name,
    v_instructor_role,
    v_id_number,
    v_address,
    v_phone,
    p_signature_path,
    CASE WHEN (p_doc_versions ->> 'rules') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'rules')::integer ELSE 0 END,
    CASE WHEN (p_doc_versions ->> 'compensation') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'compensation')::integer ELSE 0 END,
    CASE WHEN (p_doc_versions ->> 'contract') ~ '^[0-9]{1,9}$' THEN (p_doc_versions ->> 'contract')::integer ELSE 0 END,
    p_doc_versions,
    p_signed_pdf_paths,
    (SELECT path_item.value
       FROM jsonb_each_text(p_signed_pdf_paths) WITH ORDINALITY AS path_item(key, value, ordinality)
      ORDER BY path_item.ordinality
      LIMIT 1),
    pg_catalog.now(),
    v_ip,
    v_user_agent,
    to_timestamp(v_verified_epoch::double precision),
    'email_otp',
    'signed'
  )
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$$;

-- i. 只有登入者能呼叫
REVOKE ALL ON FUNCTION public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text)
  TO authenticated;

COMMENT ON FUNCTION public.submit_my_contract(text, text, text, text, text, text, jsonb, jsonb, text) IS
  '講師簽約的唯一寫入通道：驗證 JWT amr 的 Email 驗證（30 分鐘內）、文件版本與已上傳檔案後，作廢舊約並建立新約。';
