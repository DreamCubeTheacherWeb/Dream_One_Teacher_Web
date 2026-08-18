-- 講師存摺封面只允許首次提交；儲存後如需更換，必須由管理員處理。
--
-- 前端會同步隱藏講師端的更換/移除入口，但這個 trigger 才是權限邊界：
-- 即使繞過畫面直接呼叫 Data API，非管理員仍不能改寫既有存摺路徑或 metadata。

CREATE OR REPLACE FUNCTION public.guard_instructor_bankbook()
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
    SELECT 1
    FROM public.users
    WHERE id = actor_id
      AND role = 'admin'
  ) INTO actor_is_admin;

  IF actor_is_admin THEN
    RETURN NEW;
  END IF;

  IF NULLIF(BTRIM(OLD.bankbook_path), '') IS NOT NULL
     AND (
       NEW.bankbook_path IS DISTINCT FROM OLD.bankbook_path
       OR NEW.bankbook_mime IS DISTINCT FROM OLD.bankbook_mime
       OR NEW.bankbook_size IS DISTINCT FROM OLD.bankbook_size
       OR NEW.bankbook_uploaded_at IS DISTINCT FROM OLD.bankbook_uploaded_at
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = '存摺封面已鎖定，如需更換請聯繫管理員。';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_bankbook() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_instructor_bankbook() FROM anon;
REVOKE ALL ON FUNCTION public.guard_instructor_bankbook() FROM authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_bankbook ON public.instructors;
CREATE TRIGGER trg_guard_instructor_bankbook
  BEFORE UPDATE OF bankbook_path, bankbook_mime, bankbook_size, bankbook_uploaded_at
  ON public.instructors
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_instructor_bankbook();
