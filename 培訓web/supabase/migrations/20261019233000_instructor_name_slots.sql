-- 後台「新增老師（只填姓名）」空位＋老師輸入姓名直接認領（業主 2026-10-19 拍板：姓名配對到就直接綁定，錯了再由管理員處理）。
--   1. instructors.name_slot：管理員只填姓名建立的空位標記（只有 admin 能設定或更改）。
--   2. claim_instructor_name_slot(姓名)：待審核（pending）帳號輸入姓名，命中「未認領、未停用、而且沒有任何個資」的空位就直接綁定並開通成 teacher。
--      同名同姓有多個空位時，依建立先後各綁一個，互不影響。
--   3. 安全邊界：空位一旦被填入個資（手機、身分證、銀行帳號、地址、證件檔等），就不能再只靠姓名認領；
--      例如被管理員解除綁定後，原本填過的資料不會讓下一個輸入同名的人看到，只能走「姓名＋手機＋身分證末四碼」核對。
-- 可重複執行；不刪資料、不改既有 RLS。

BEGIN;

ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS name_slot boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.instructors.name_slot IS
  '後台只填姓名建立的講師空位。未認領且沒有個資時，pending 帳號可用 claim_instructor_name_slot 以姓名認領。';

CREATE INDEX IF NOT EXISTS idx_instructors_unclaimed_name_slots
  ON public.instructors ((regexp_replace(BTRIM(full_name), '\s+', '', 'g')), created_at, id)
  WHERE name_slot AND user_id IS NULL;


-- guard 以 20260826140000 版本為底，只多保護 name_slot（講師不能自己設定或更改）。
CREATE OR REPLACE FUNCTION public.guard_instructor_admin_fields()
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
    IF NEW.employment_status IS NOT NULL
       OR NEW.instructor_role IS NOT NULL
       OR NEW.speed_qualification IS NOT NULL
       OR NEW.form_submitted_at IS NOT NULL
       OR NEW.note_internal IS NOT NULL
       OR NEW.teaching_regions_raw IS NOT NULL
       OR NEW.bank_info_raw IS NOT NULL
       OR NEW.id_front_external_url IS NOT NULL
       OR NEW.id_back_external_url IS NOT NULL
       OR NEW.photo_external_url IS NOT NULL
       OR NEW.bankbook_external_url IS NOT NULL
       OR NEW.wca_name IS NOT NULL
       OR NEW.wca_synced_at IS NOT NULL
       OR NEW.hide_from_leaderboard IS DISTINCT FROM false
       OR NEW.name_slot IS DISTINCT FROM false THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'administrator-managed instructor fields cannot be set by instructors';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
      NEW.id, NEW.created_at,
      NEW.employment_status, NEW.instructor_role, NEW.speed_qualification,
      NEW.form_submitted_at, NEW.note_internal, NEW.teaching_regions_raw,
      NEW.bank_info_raw, NEW.id_front_external_url, NEW.id_back_external_url,
      NEW.photo_external_url, NEW.bankbook_external_url, NEW.wca_name,
      NEW.wca_synced_at, NEW.hide_from_leaderboard, NEW.name_slot
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.created_at,
      OLD.employment_status, OLD.instructor_role, OLD.speed_qualification,
      OLD.form_submitted_at, OLD.note_internal, OLD.teaching_regions_raw,
      OLD.bank_info_raw, OLD.id_front_external_url, OLD.id_back_external_url,
      OLD.photo_external_url, OLD.bankbook_external_url, OLD.wca_name,
      OLD.wca_synced_at, OLD.hide_from_leaderboard, OLD.name_slot
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'administrator-managed instructor fields cannot be changed by instructors';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     AND NOT (OLD.user_id IS NULL AND NEW.user_id = actor_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'instructor account link cannot be changed by instructors';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_admin_fields() FROM PUBLIC, anon, authenticated;


CREATE OR REPLACE FUNCTION public.claim_instructor_name_slot(provided_full_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id        uuid := auth.uid();
  actor_role      text;
  normalized_name text := regexp_replace(BTRIM(COALESCE(provided_full_name, '')), '\s+', '', 'g');
  matched_id      uuid;
  matched_name    text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  SELECT u.role INTO actor_role
    FROM public.users u
   WHERE u.id = actor_id;

  IF actor_role IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'pending account required';
  END IF;

  -- 已經有自己的講師資料（自建新進、或已認領）就不再認領第二筆。
  IF EXISTS (SELECT 1 FROM public.instructors i WHERE i.user_id = actor_id) THEN
    RETURN jsonb_build_object('status', 'already_linked', 'claimed_now', false);
  END IF;

  IF normalized_name = '' OR char_length(normalized_name) > 50 THEN
    RETURN jsonb_build_object('status', 'invalid_input', 'reason', '請輸入完整姓名。');
  END IF;

  -- 同名同姓多個空位：依建立先後取第一個還沒被認領的；SKIP LOCKED 讓兩人同時認領同名時各拿一個。
  SELECT i.id, i.full_name
    INTO matched_id, matched_name
    FROM public.instructors i
   WHERE i.name_slot
     AND i.user_id IS NULL
     AND regexp_replace(BTRIM(COALESCE(i.full_name, '')), '\s+', '', 'g') = normalized_name
     AND COALESCE(i.employment_status::text, 'active') NOT IN ('frozen', 'cancelled')
     AND NULLIF(BTRIM(COALESCE(i.id_number, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.phone_mobile, '')), '') IS NULL
     AND i.birth_date IS NULL
     AND NULLIF(BTRIM(COALESCE(i.address, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.household_address, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bank_account_number, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bank_info_raw, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_front_path, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_back_path, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bankbook_path, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_front_external_url, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.id_back_external_url, '')), '') IS NULL
     AND NULLIF(BTRIM(COALESCE(i.bankbook_external_url, '')), '') IS NULL
   ORDER BY i.created_at, i.id
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF matched_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'not_found',
      'reason', '名冊裡沒有可直接認領的這個姓名。'
    );
  END IF;

  UPDATE public.instructors
     SET user_id = actor_id
   WHERE id = matched_id
     AND user_id IS NULL;

  UPDATE public.users
     SET role = 'teacher',
         name = COALESCE(NULLIF(BTRIM(matched_name), ''), name)
   WHERE id = actor_id
     AND role = 'pending';

  RETURN jsonb_build_object(
    'status', 'claimed',
    'instructor_id', matched_id,
    'claimed_now', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_instructor_name_slot(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_instructor_name_slot(text) TO authenticated;

COMMENT ON FUNCTION public.claim_instructor_name_slot(text) IS
  'Pending account claims the oldest unclaimed, active, data-free name_slot instructor row whose whitespace-normalized full_name matches, then becomes teacher.';

COMMIT;
