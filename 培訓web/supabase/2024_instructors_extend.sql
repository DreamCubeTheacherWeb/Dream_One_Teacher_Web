-- ═══════════════════════════════════════════════════════════════════
-- 講師主檔擴充 Migration
-- 目的:
--   1. 鬆綁約束以匯入歷史 Google Sheet 資料(251 位講師,多數尚未登入)
--   2. 新增 employment_status 欄位區分「業務狀態」與「等級」
--   3. 新增 17 個擴充欄位(Line / 衣服尺寸 / 匯款 / 個人經歷 / 文件外部連結 等)
--   4. 自動 link:講師日後 Google 登入時,以 email 對應已匯入的 instructors 列
--
-- 執行方式:在 Supabase Dashboard → SQL Editor 貼上後分段執行
-- 建議分 A → B → C → D 四個區塊各跑一次,跑完一段看一下訊息再下一段
-- ═══════════════════════════════════════════════════════════════════


-- ──────────────────────────────────────────────────────────────────
-- A. 鬆綁原有 NOT NULL 約束
-- ──────────────────────────────────────────────────────────────────
-- 為什麼:251 位講師大多還沒用 Google 登入過,沒有 auth.users.id;
-- 25 位工讀生沒 email;許多人沒填接課地區。
-- 這些欄位將維持必要性「軟」要求(由前端表單檢查),但 DB 層允許 NULL。

ALTER TABLE public.instructors
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.instructors
  ALTER COLUMN email_primary DROP NOT NULL;

ALTER TABLE public.instructors
  ALTER COLUMN teaching_regions DROP NOT NULL;

-- 移除「至少 1 個縣市」的 cardinality 限制
ALTER TABLE public.instructors
  DROP CONSTRAINT IF EXISTS teaching_regions_min;


-- ──────────────────────────────────────────────────────────────────
-- B. 新增 employment_status enum 與欄位
-- ──────────────────────────────────────────────────────────────────
-- 區分「業務狀態」(active/frozen/cancelled/...)與「等級」(S/A+/A/B/實習)

DO $$ BEGIN
  CREATE TYPE employment_status_enum AS ENUM (
    'active',      -- 老師(正常合作中)
    'staff',       -- 職員(全職員工,可能也教課)
    'assistant',   -- 助教
    'part_time',   -- 工讀生
    'frozen',      -- 冷凍(暫停合作)
    'cancelled'    -- 取消合作
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS employment_status employment_status_enum;


-- ──────────────────────────────────────────────────────────────────
-- C. 新增 17 個擴充欄位
-- ──────────────────────────────────────────────────────────────────
-- 全部 NULLable,匯入沒填的就保持空白

ALTER TABLE public.instructors
  -- Line / 社群
  ADD COLUMN IF NOT EXISTS line_name              text,
  ADD COLUMN IF NOT EXISTS facebook_url           text,

  -- 個人 / 教學經歷
  ADD COLUMN IF NOT EXISTS school_info            text,  -- 目前就讀學校、科系、年級
  ADD COLUMN IF NOT EXISTS bio_personal_experience text, -- 個人經歷
  ADD COLUMN IF NOT EXISTS bio_teaching_experience text, -- 授課經驗
  ADD COLUMN IF NOT EXISTS teaching_philosophy    text,  -- 教學理念

  -- 接課
  ADD COLUMN IF NOT EXISTS teaching_regions_raw   text,  -- 原始字串(雙北、新竹市等 enum 外的值)

  -- 寄物 / 衣著
  ADD COLUMN IF NOT EXISTS shirt_size             text,
  ADD COLUMN IF NOT EXISTS convenience_store_code text,
  ADD COLUMN IF NOT EXISTS convenience_store_family text,
  ADD COLUMN IF NOT EXISTS convenience_store_711  text,

  -- 薪資匯款(暫存原文,之後可拆 bank_code/account/holder)
  ADD COLUMN IF NOT EXISTS bank_info_raw          text,

  -- 備註
  ADD COLUMN IF NOT EXISTS note_to_team           text,   -- 講師對團隊的話
  ADD COLUMN IF NOT EXISTS note_internal          text,   -- 管理員內部備註(如「已開除」)

  -- 文件外部連結(歷史 Google Drive 連結,之後可遷移到 Storage)
  ADD COLUMN IF NOT EXISTS id_front_external_url  text,
  ADD COLUMN IF NOT EXISTS id_back_external_url   text,
  ADD COLUMN IF NOT EXISTS photo_external_url     text,
  ADD COLUMN IF NOT EXISTS bankbook_external_url  text;


-- ──────────────────────────────────────────────────────────────────
-- D. 自動 link Trigger:Google 登入時以 email 對應 instructors
-- ──────────────────────────────────────────────────────────────────
-- 邏輯:
--   1. 新增 auth.users 時(Google OAuth 首次登入)
--   2. 先檢查 teacher_invites(原有邏輯保留)
--   3. 再檢查 instructors:若有相同 email 且 user_id 為 NULL → 自動 link
--      並把使用者 role 升級為 'teacher'(從預設 pending)
--
-- 為什麼這樣做:251 位講師會「先有 instructors 紀錄、後有 auth 帳號」,
-- trigger 讓「日後登入」與「歷史資料」自動接起來,不需要人工 link。

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
  invite_record record;
  instructor_record record;
  resolved_role text;
  resolved_name text;
BEGIN
  -- ── Step 1: 先檢查 teacher_invites(優先順序最高)──
  SELECT * INTO invite_record FROM public.teacher_invites WHERE email = NEW.email;

  IF invite_record IS NOT NULL THEN
    resolved_role := invite_record.role;
    resolved_name := COALESCE(invite_record.name, NEW.raw_user_meta_data->>'full_name');

    INSERT INTO public.users (id, name, email, role)
    VALUES (NEW.id, resolved_name, NEW.email, resolved_role)
    ON CONFLICT (id) DO NOTHING;

    DELETE FROM public.teacher_invites WHERE email = NEW.email;
  ELSE
    -- ── Step 2: 檢查 instructors 是否有同 email 的歷史紀錄 ──
    SELECT * INTO instructor_record
    FROM public.instructors
    WHERE email_primary = NEW.email AND user_id IS NULL
    LIMIT 1;

    IF instructor_record IS NOT NULL THEN
      -- 有歷史紀錄:依 employment_status 決定 role
      resolved_role := CASE
        WHEN instructor_record.employment_status IN ('frozen', 'cancelled') THEN 'pending'
        ELSE 'teacher'
      END;
      resolved_name := COALESCE(instructor_record.full_name, NEW.raw_user_meta_data->>'full_name');

      INSERT INTO public.users (id, name, email, role)
      VALUES (NEW.id, resolved_name, NEW.email, resolved_role)
      ON CONFLICT (id) DO NOTHING;

      -- 把 auth.users.id 寫回 instructors,完成 link
      UPDATE public.instructors
      SET user_id = NEW.id
      WHERE id = instructor_record.id;
    ELSE
      -- ── Step 3: 都沒有 → 預設 pending ──
      INSERT INTO public.users (id, name, email, role)
      VALUES (NEW.id, NEW.raw_user_meta_data->>'full_name', NEW.email, 'pending')
      ON CONFLICT (id) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- trigger 本身不用重建,handle_new_user() 函式被 on_auth_user_created 引用,改函式即可生效。


-- ──────────────────────────────────────────────────────────────────
-- E. 驗證查詢(可選,跑完看看數字對不對)
-- ──────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'instructors'
-- ORDER BY ordinal_position;

-- SELECT enumlabel FROM pg_enum
-- WHERE enumtypid = 'employment_status_enum'::regtype;
