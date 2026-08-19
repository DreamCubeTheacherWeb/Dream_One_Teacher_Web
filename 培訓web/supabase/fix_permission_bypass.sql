-- ═══════════════════════════════════════════════════════════════════
-- 權限繞過修正腳本（請在 Supabase SQL Editor 執行）
-- ═══════════════════════════════════════════════════════════════════
-- 問題：自我註冊的講師填完資料後直接取得 teacher 角色，跳過審核
-- 原因：teacher_invites 有殘留紀錄，導致 handle_new_user trigger 誤判
-- ═══════════════════════════════════════════════════════════════════

-- 1. 更新 delete_user_completely：刪除帳號時一併清除 teacher_invites
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

-- 2. 立即修正 lazydragon0247@gmail.com：清除殘留 invite 並重設為 pending
DELETE FROM public.teacher_invites WHERE email = 'lazydragon0247@gmail.com';
UPDATE public.users SET role = 'pending' WHERE email = 'lazydragon0247@gmail.com';
