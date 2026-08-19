-- ═══════════════════════════════════════════════════════════════════
-- 講師資料總表 — Supabase Schema Migration
-- 可直接在 Supabase SQL Editor 執行
-- ═══════════════════════════════════════════════════════════════════

-- ──────────────────────────────────────────────────────────────────
-- A1. 建立 Enum Types
-- ──────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE instructor_role_enum AS ENUM ('S', 'A+', 'A', 'B', '實習');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tw_county AS ENUM (
    -- 六都
    '臺北市','新北市','桃園市','臺中市','臺南市','高雄市',
    -- 省轄市
    '基隆市','新竹市','嘉義市',
    -- 各縣
    '新竹縣','苗栗縣','彰化縣','南投縣','雲林縣','嘉義縣',
    '屏東縣','宜蘭縣','花蓮縣','臺東縣',
    -- 離島
    '澎湖縣','金門縣','連江縣'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ──────────────────────────────────────────────────────────────────
-- A2. 建立 public.instructors 資料表
-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.instructors (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id         uuid REFERENCES auth.users NOT NULL UNIQUE,

  -- 基本資料
  full_name       text NOT NULL,
  gender          text,
  birth_date      date,
  id_number       text,

  -- 聯絡方式
  phone_mobile    text,
  phone_home      text,
  line_id         text,
  address         text,
  email_primary   text NOT NULL,
  email_secondary text,

  -- 教學資訊
  instructor_role instructor_role_enum,
  teaching_freq_semester  text,
  teaching_freq_vacation  text,
  teaching_regions        tw_county[] NOT NULL,

  -- 經歷 / 自我介紹
  bio_notes       text,

  -- Google Form 時間戳記（匯入 CSV 時使用）
  form_submitted_at timestamptz,

  -- ────── 檔案上傳欄位（僅存 storage object path） ──────

  -- 身分證正面
  id_front_path        text,
  id_front_mime        text,
  id_front_size        bigint,
  id_front_uploaded_at timestamptz,

  -- 身分證反面
  id_back_path         text,
  id_back_mime         text,
  id_back_size         bigint,
  id_back_uploaded_at  timestamptz,

  -- 講師照片
  photo_path           text,
  photo_mime           text,
  photo_size           bigint,
  photo_uploaded_at    timestamptz,

  -- 存摺封面
  bankbook_path        text,
  bankbook_mime        text,
  bankbook_size        bigint,
  bankbook_uploaded_at timestamptz,

  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,

  -- ────── Constraints ──────
  CONSTRAINT teaching_regions_min
    CHECK (cardinality(teaching_regions) >= 1),

  CONSTRAINT id_front_mime_chk
    CHECK (id_front_mime IS NULL OR id_front_mime LIKE 'image/%'),
  CONSTRAINT id_front_size_chk
    CHECK (id_front_size IS NULL OR id_front_size <= 20971520),

  CONSTRAINT id_back_mime_chk
    CHECK (id_back_mime IS NULL OR id_back_mime LIKE 'image/%'),
  CONSTRAINT id_back_size_chk
    CHECK (id_back_size IS NULL OR id_back_size <= 20971520),

  CONSTRAINT photo_mime_chk
    CHECK (photo_mime IS NULL OR photo_mime LIKE 'image/%'),
  CONSTRAINT photo_size_chk
    CHECK (photo_size IS NULL OR photo_size <= 20971520),

  CONSTRAINT bankbook_mime_chk
    CHECK (bankbook_mime IS NULL OR bankbook_mime LIKE 'image/%'),
  CONSTRAINT bankbook_size_chk
    CHECK (bankbook_size IS NULL OR bankbook_size <= 20971520)
);

-- ──────────────────────────────────────────────────────────────────
-- A3. updated_at 自動更新 Trigger
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION update_instructors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_instructors_updated_at ON public.instructors;
CREATE TRIGGER set_instructors_updated_at
  BEFORE UPDATE ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION update_instructors_updated_at();

-- ──────────────────────────────────────────────────────────────────
-- A4. RLS 政策
-- ──────────────────────────────────────────────────────────────────

ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own instructor profile"
  ON public.instructors FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own instructor profile"
  ON public.instructors FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own instructor profile"
  ON public.instructors FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Admins can do everything on instructors"
  ON public.instructors FOR ALL
  USING (
    EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- ═══════════════════════════════════════════════════════════════════
-- B. Supabase Storage — instructor_uploads bucket
-- ═══════════════════════════════════════════════════════════════════

-- B1. 建立 private bucket（20MB 限制、僅圖片）
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'instructor_uploads',
  'instructor_uploads',
  false,
  20971520,
  ARRAY['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif']
)
ON CONFLICT (id) DO NOTHING;

-- B2. Storage Policies
-- 檔案路徑規則: instructors/{user_id}/{doc_type}/{uuid}.{ext}
-- doc_type ∈ {id_front, id_back, photo, bankbook}

CREATE POLICY "Users can upload own instructor files"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

CREATE POLICY "Users can view own instructor files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

CREATE POLICY "Users can update own instructor files"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1 FROM public.instructors i
      WHERE i.user_id = auth.uid() AND NULLIF(BTRIM(i.bankbook_path), '') = name
    )
  )
  WITH CHECK (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1 FROM public.instructors i
      WHERE i.user_id = auth.uid() AND NULLIF(BTRIM(i.bankbook_path), '') = name
    )
  );

CREATE POLICY "Users can delete own instructor files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND (storage.foldername(name))[1] = 'instructors'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1 FROM public.instructors i
      WHERE i.user_id = auth.uid() AND NULLIF(BTRIM(i.bankbook_path), '') = name
    )
  );

CREATE POLICY "Admins can view all instructor files"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins can delete all instructor files"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'instructor_uploads'
    AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
  );

-- ═══════════════════════════════════════════════════════════════════
-- C. 欄位對照表  (CSV 原始欄位名 → DB → 型別 → 必填 → 備註)
-- ═══════════════════════════════════════════════════════════════════
--
--  CSV 原始欄位名              | DB (snake_case)             | 型別                  | 必填 | 備註
--  ─────────────────────────── | ─────────────────────────── | ───────────────────── | ──── | ─────────────────────
--  時間戳記                     | form_submitted_at           | timestamptz           | 否   | Google Form 自動產生
--  姓名                        | full_name                   | text                  | 是   |
--  性別                        | gender                      | text                  | 否   |
--  出生年月日                   | birth_date                  | date                  | 否   |
--  身分證字號                   | id_number                   | text                  | 否   | 敏感資料，建議加密
--  手機號碼                     | phone_mobile                | text                  | 否   |
--  家用電話                     | phone_home                  | text                  | 否   |
--  Line ID                     | line_id                     | text                  | 否   |
--  通訊地址                     | address                     | text                  | 否   |
--  Email                       | email_primary               | text                  | 是   | 主要聯絡 email
--  備用 Email                   | email_secondary             | text                  | 否   |
--  講師等級                     | instructor_role             | instructor_role_enum  | 否   | S / A+ / A / B / 實習
--  接課頻率（學期間）            | teaching_freq_semester      | text                  | 否   |
--  接課頻率（寒暑假）            | teaching_freq_vacation      | text                  | 否   |
--  可接課地區                   | teaching_regions            | tw_county[]           | 是   | 至少 1 個縣市
--  經歷/理念/想說的話            | bio_notes                   | text                  | 否   |
--  每年六月考核                 | (刪除)                      | —                     | —    | 不納入
--  個人臉書網址                 | (刪除)                      | —                     | —    | 不納入
--  Unnamed 欄位                | (刪除)                      | —                     | —    | 不納入
--  身分證正面照片               | id_front_path / _mime / _size / _uploaded_at  | text/text/bigint/tz | 否 | Storage path
--  身分證反面照片               | id_back_path  / _mime / _size / _uploaded_at  | text/text/bigint/tz | 否 | Storage path
--  講師照片                    | photo_path    / _mime / _size / _uploaded_at  | text/text/bigint/tz | 否 | Storage path
--  存摺封面照片                 | bankbook_path / _mime / _size / _uploaded_at  | text/text/bigint/tz | 否 | Storage path
--
-- ═══════════════════════════════════════════════════════════════════
-- D. 更嚴謹方案備註（Supabase Edge Function upload gateway）
-- ═══════════════════════════════════════════════════════════════════
-- 若需 server 端二次驗證 MIME/size，可建立 Edge Function：
--   1. 前端呼叫 Edge Function（multipart/form-data）
--   2. Edge Function 驗證 Content-Type、file.size
--   3. 驗證通過後由 service_role key 呼叫 Storage API 上傳
--   4. 回傳 storage path 給前端，前端再寫入 instructors 表
-- 此方案可防止前端繞過檢查，但增加架構複雜度，
-- 目前已透過 Storage bucket allowed_mime_types + file_size_limit 實現基礎防護。

-- ═══════════════════════════════════════════════════════════════════
-- E. 完整刪除使用者函式（含 auth.users）
-- ═══════════════════════════════════════════════════════════════════
-- 管理員從後台刪除講師時，同時清除 auth 帳號，避免「帳號已註冊」的殘留問題

CREATE OR REPLACE FUNCTION public.delete_user_completely(target_user_id uuid)
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

  DELETE FROM public.instructors WHERE user_id = target_user_id;
  DELETE FROM public.progress WHERE user_id = target_user_id;
  DELETE FROM public.assignments WHERE user_id = target_user_id;
  DELETE FROM public.course_training_status WHERE user_id = target_user_id;
  DELETE FROM public.users WHERE id = target_user_id;

  IF target_email IS NOT NULL THEN
    DELETE FROM public.teacher_invites WHERE email = target_email;
  END IF;

  DELETE FROM auth.users WHERE id = target_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

REVOKE ALL ON FUNCTION public.delete_user_completely(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_completely(uuid) TO authenticated;
