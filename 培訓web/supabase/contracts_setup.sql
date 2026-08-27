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

DO $$ BEGIN
  CREATE POLICY "Authenticated users can read active contract documents"
    ON public.contract_documents FOR SELECT
    TO authenticated
    USING (true);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

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
-- 前台簽約功能恢復前，必須改由可信 RPC / Edge Function 驗證 OTP 與文件 hash 後建立。
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
CREATE POLICY "read contract documents scoped"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'contract-documents'
    AND (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'mentor'))
      OR (
        (storage.foldername(name))[1] = 'signed'
        AND (storage.foldername(name))[2] = auth.uid()::text
      )
      OR (storage.foldername(name))[1] IS DISTINCT FROM 'signed'
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
