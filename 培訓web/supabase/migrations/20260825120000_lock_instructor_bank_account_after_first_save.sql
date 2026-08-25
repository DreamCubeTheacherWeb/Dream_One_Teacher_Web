-- 講師匯款銀行資訊（戶名／銀行別／分行／代碼／帳號）只允許首次填寫；
-- 儲存後如需修改，講師須於講師群組提出，由管理員處理。
-- 與 20260818 的存摺封面鎖定同一模式：前端只是體驗層，這個 trigger 才是權限邊界。

CREATE OR REPLACE FUNCTION public.guard_instructor_bank_account()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_is_admin boolean := false;
BEGIN
  -- SQL Editor / service role / 受控資料匯入沒有使用者 JWT，保留系統維運能力。
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users WHERE id = actor_id AND role = 'admin'
  ) INTO actor_is_admin;

  IF actor_is_admin THEN
    RETURN NEW;
  END IF;

  -- 以「已有銀行帳號」視為已完成首次填寫，之後五個欄位一律鎖定。
  IF NULLIF(BTRIM(OLD.bank_account_number), '') IS NOT NULL
     AND (
       NEW.bank_account_name   IS DISTINCT FROM OLD.bank_account_name
       OR NEW.bank_name        IS DISTINCT FROM OLD.bank_name
       OR NEW.bank_branch      IS DISTINCT FROM OLD.bank_branch
       OR NEW.bank_code        IS DISTINCT FROM OLD.bank_code
       OR NEW.bank_account_number IS DISTINCT FROM OLD.bank_account_number
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '匯款銀行資訊已鎖定，如需修改請於講師群組提出。';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_bank_account() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_instructor_bank_account() FROM anon;
REVOKE ALL ON FUNCTION public.guard_instructor_bank_account() FROM authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_bank_account ON public.instructors;
CREATE TRIGGER trg_guard_instructor_bank_account
  BEFORE UPDATE OF bank_account_name, bank_name, bank_branch, bank_code, bank_account_number
  ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_instructor_bank_account();
