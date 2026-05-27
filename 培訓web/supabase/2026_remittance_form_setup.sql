-- ═══════════════════════════════════════════════════════════════════
-- 講師匯款申請書自動填表系統 — Migration
--
-- 為什麼存在：延伸現有合約簽署系統的「PDF 模板 + 欄位定位 + 自動填入」
-- 基礎建設，新增「匯款申請書」這份不需要簽名、但需要嵌入圖片
-- （身分證、存摺）的表單。同時補上 instructors 表缺的銀行欄位。
--
-- 執行順序：A → B → C → D，分段在 Supabase SQL Editor 跑。
-- ═══════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────
-- A. instructors 表新增銀行資訊欄位
-- ──────────────────────────────────────────────────────────────────
-- 這 5 個欄位是匯款申請書必填、但現有表單沒收的資訊。
-- 全部 NULLable，由前端表單做必填檢查（與其他欄位一致的做法）。

ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS bank_account_name   text,  -- 匯款戶名（務必與身分證名字相同）
  ADD COLUMN IF NOT EXISTS bank_name           text,  -- 銀行別（中文）
  ADD COLUMN IF NOT EXISTS bank_branch         text,  -- 分行別
  ADD COLUMN IF NOT EXISTS bank_account_number text,  -- 帳號（含檢查碼）
  ADD COLUMN IF NOT EXISTS bank_code           text;  -- 匯款銀行代碼（共 7 碼）

COMMENT ON COLUMN public.instructors.bank_account_name   IS '匯款戶名 — 必須與身分證姓名相同';
COMMENT ON COLUMN public.instructors.bank_code           IS '匯款銀行代碼，共 7 碼數字';


-- ──────────────────────────────────────────────────────────────────
-- B. contract_documents 加 doc_category 區分「合約」與「表單」
-- ──────────────────────────────────────────────────────────────────
-- 為什麼：避免匯款申請書這類「行政表單」混進簽約流程的 dropdown。
-- 'contract' = 需要講師簽署的合約類文件（沿用現有）
-- 'form'     = 後台單方面填發的行政表單（如匯款申請書）

ALTER TABLE public.contract_documents
  ADD COLUMN IF NOT EXISTS doc_category text NOT NULL DEFAULT 'contract';

DO $$ BEGIN
  ALTER TABLE public.contract_documents
    ADD CONSTRAINT contract_documents_doc_category_check
    CHECK (doc_category IN ('contract', 'form'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ──────────────────────────────────────────────────────────────────
-- C. 為 contract_field_positions 新增圖片欄位支援
-- ──────────────────────────────────────────────────────────────────
-- field_type 已是 TEXT 不需要改 schema。新支援的值：
--   'photo'           → instructors.photo_path (大頭照)
--   'id_front_image'  → instructors.id_front_path
--   'id_back_image'   → instructors.id_back_path
--   'bankbook_image'  → instructors.bankbook_path
--
-- 以及新支援的純文字欄位：
--   'bank_account_name'   / 'bank_name'    / 'bank_branch'
--   'bank_account_number' / 'bank_code'
--   'nickname'            / 'email_primary'
--
-- 此區塊不需要 DDL 變更，只是文件記錄。


-- ──────────────────────────────────────────────────────────────────
-- D. instructor_form_downloads 下載紀錄表（稽核用）
-- ──────────────────────────────────────────────────────────────────
-- 為什麼：身分證、銀行帳號是敏感資料，記錄誰下載了誰的表單，
-- 出事時可以追蹤。

CREATE TABLE IF NOT EXISTS public.instructor_form_downloads (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  downloaded_by   uuid REFERENCES auth.users(id),
  target_user_id  uuid REFERENCES auth.users(id),
  doc_type        text NOT NULL,
  doc_version     int  NOT NULL,
  downloaded_at   timestamptz DEFAULT now()
);

ALTER TABLE public.instructor_form_downloads ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Admins can read all download logs"
    ON public.instructor_form_downloads FOR SELECT
    USING (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'mentor'))
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Admins can insert download logs"
    ON public.instructor_form_downloads FOR INSERT
    TO authenticated
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'mentor'))
      AND downloaded_by = auth.uid()
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ──────────────────────────────────────────────────────────────────
-- E. Admin 讀取 instructors 表的 RLS（讓下載中心可以撈所有人）
-- ──────────────────────────────────────────────────────────────────
-- 原本只有 admin 的 ALL policy，這裡確保 mentor 也能讀（mentor 通常會
-- 處理下載中心的工作）。若已存在 admin 的 ALL policy 不影響。

DO $$ BEGIN
  CREATE POLICY "Mentors and admins can view all instructor profiles"
    ON public.instructors FOR SELECT
    TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin', 'mentor'))
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;


-- ──────────────────────────────────────────────────────────────────
-- F. Admin 讀取講師上傳的私人檔案（身分證、存摺）
-- ──────────────────────────────────────────────────────────────────
-- 原本只有 admin 的 SELECT policy，mentor 也需要才能在下載中心抓圖。

DO $$ BEGIN
  CREATE POLICY "Mentors can view all instructor files"
    ON storage.objects FOR SELECT
    TO authenticated
    USING (
      bucket_id = 'instructor_uploads'
      AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'mentor')
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
