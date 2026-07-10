-- ═══════════════════════════════════════════════════════════════════
-- 2026-07-10  講師姓名同步：instructors.full_name → users.name
-- ───────────────────────────────────────────────────────────────────
-- 問題（業主 2026-07-10 回報）：個人頁把姓名從「大大」改成「懶懶」後，後台
--   「講師名單管理」(TeacherManager) 仍顯示舊名「大大」。
--
-- 根因：一個人的名字存在兩處且無同步——
--   (1) users.name          ：Google OAuth 首次登入時由 handle_new_user 帶入，
--                             之後永不更新。後台講師表、認領審核清單讀這一份。
--   (2) instructors.full_name：個人頁 (ProfilePage) 存檔唯一寫入的姓名欄。
--   個人頁只 upsert instructors.full_name，從不寫 users.name，兩者間無 trigger
--   /RPC 同步 → users.name 永遠停在註冊時的舊名。
--
-- 本檔做兩件事：
--   (1) 新增 AFTER INSERT/UPDATE trigger：只要 instructors.full_name 有變（或新
--       建 instructor 列），就把對應 users.name 同步成同一個名字。以後改個人頁
--       姓名，後台顯示自動跟著更新。
--   (2) 一次性回填：把現有所有「兩份對不上」的登入帳號（含業主的懶懶）補正。
--
-- 設計說明：
--   - 只在 full_name 非空白時才同步，避免用空字串蓋掉既有 users.name。
--   - user_id 具 UNIQUE（一人一列），同步目標唯一、無歧義。
--   - trigger 更新的是 users（非 instructors），不會遞迴、不會與既有
--     set_instructors_updated_at / guard_instructor_role trigger 打架。
--   - SECURITY DEFINER：以函式擁有者身分寫入，繞過 users 的 RLS。
-- 相依：setup.sql (users.name)、instructors_setup.sql (instructors.full_name/user_id)。
-- 冪等：CREATE OR REPLACE + DROP TRIGGER IF EXISTS + 回填本身天生冪等（可重複執行）。
-- ═══════════════════════════════════════════════════════════════════

-- (1) 同步函式 + trigger ------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_instructor_name_to_users()
RETURNS trigger AS $$
BEGIN
  IF NEW.user_id IS NOT NULL
     AND NEW.full_name IS NOT NULL
     AND btrim(NEW.full_name) <> '' THEN
    UPDATE public.users
       SET name = NEW.full_name
     WHERE id = NEW.user_id
       AND name IS DISTINCT FROM NEW.full_name;   -- 沒變就不寫，省去無意義的 UPDATE
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS trg_sync_instructor_name ON public.instructors;
CREATE TRIGGER trg_sync_instructor_name
AFTER INSERT OR UPDATE OF full_name ON public.instructors
FOR EACH ROW
EXECUTE FUNCTION public.sync_instructor_name_to_users();

-- (2) 一次性回填：修正現有所有對不上的登入帳號 --------------------------
UPDATE public.users u
   SET name = i.full_name
  FROM public.instructors i
 WHERE i.user_id = u.id
   AND i.full_name IS NOT NULL
   AND btrim(i.full_name) <> ''
   AND u.name IS DISTINCT FROM i.full_name;

-- ───────────────────────────────────────────────────────────────────
-- 驗證：
--   (a) trigger 存在：
--       SELECT tgname FROM pg_trigger WHERE tgname = 'trg_sync_instructor_name';
--   (b) 業主帳號已同步（應回「懶懶」）：
--       SELECT u.name, i.full_name FROM public.users u
--       JOIN public.instructors i ON i.user_id = u.id
--       WHERE u.email = 'lazy@dreamcube.tw';
--   (c) 已無殘留對不上（應回 0 列）：
--       SELECT u.email, u.name, i.full_name FROM public.users u
--       JOIN public.instructors i ON i.user_id = u.id
--       WHERE btrim(i.full_name) <> '' AND u.name IS DISTINCT FROM i.full_name;
