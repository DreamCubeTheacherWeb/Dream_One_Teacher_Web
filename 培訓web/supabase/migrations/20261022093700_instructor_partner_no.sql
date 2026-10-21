-- ═══════════════════════════════════════════════════════════════════
-- 2026-10-22 講師主檔加「夥伴號碼」（財務 ERP 的供應商編號，例 A036872）
--   用途：後台「月結匯款」頁匯出銀行批次轉帳檔、供應商 CSV 時填入夥伴號碼欄。
--   來源：財務供應商分頁匯出的 CSV，由 admin 在「月結匯款」頁匯入（以身分證比對）；網站不會自行編號。
--
--   權限：admin 可讀寫；講師本人不能自己設定或修改（與其他管理欄位相同，由獨立 trigger 擋，
--         不修改既有的 guard_instructor_admin_fields）。auth.uid() 為 NULL（SQL Editor／service）放行。
--   格式：只允許大寫英數 1～20 碼（CHECK），空值代表尚未建檔。
--   不建 unique：同一號碼出現在兩位講師身上時只在畫面上警告（可能是重複建檔的同一人）。
-- 本檔可重複執行。
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS partner_no text;

ALTER TABLE public.instructors
  DROP CONSTRAINT IF EXISTS instructors_partner_no_format_check;
ALTER TABLE public.instructors
  ADD CONSTRAINT instructors_partner_no_format_check
  CHECK (partner_no IS NULL OR partner_no ~ '^[A-Z0-9]{1,20}$');

COMMENT ON COLUMN public.instructors.partner_no IS
  '財務 ERP 夥伴號碼（供應商編號，例 A036872）；由 admin 從財務供應商資料匯入，講師本人不可修改。NULL＝財務尚未建檔。';

CREATE OR REPLACE FUNCTION public.guard_instructor_partner_no()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
  actor_is_admin boolean := false;
BEGIN
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = actor_id AND u.role = 'admin'
  ) INTO actor_is_admin;
  IF actor_is_admin THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.partner_no IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'partner_no is administrator-managed and cannot be set by instructors';
    END IF;
  ELSIF NEW.partner_no IS DISTINCT FROM OLD.partner_no THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'partner_no is administrator-managed and cannot be changed by instructors';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_partner_no() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_partner_no ON public.instructors;
CREATE TRIGGER trg_guard_instructor_partner_no
  BEFORE INSERT OR UPDATE ON public.instructors
  FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_partner_no();
