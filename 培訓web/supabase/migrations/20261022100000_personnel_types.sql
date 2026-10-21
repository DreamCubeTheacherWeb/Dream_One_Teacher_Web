-- ═══════════════════════════════════════════════════════════════════
-- 2026-10-22 人員類別（personnel_types）與合作狀態（employment_status）拆開（業主需求）
--   業主有純職員夥伴：不是講師、沒有等級。原本 employment_status 把「身分」（staff／assistant／part_time）
--   和「合作狀態」（active／frozen／cancelled）混成單選，選了職員就沒辦法同時表示「已離職」。
--
--   拆法：
--     employment_status  保留，只當「合作狀態」：active／frozen／cancelled（NULL 前端視為合作中）。
--                        enum 值不刪，以 CHECK 擋掉身分值；既有 NULL 補成 active。
--     personnel_types    新增 text[]：instructor（講師）／staff（職員）／part_time（工讀計時），
--                        可複選、至少一個；既有資料全部預設 {instructor}。
--   讀 employment_status 的既有函式只判斷 frozen／cancelled（擋登入、擋回報、降權），本檔不動它們。
--   只改三個函式（其餘內容與 repo 最新定義一字不差）：
--     guard_instructor_admin_fields     非 admin 不能用非預設值新增、不能修改 personnel_types。
--     instructor_profile_is_complete    接課頻率／地區／簡介四項只對「含講師身分」的人要求。
--     ensure_my_contract_reminder       有主檔但不含講師身分的人不發合約提醒。
--
--   舊前端（還沒換版）並存：不送 personnel_types 的新增會拿到預設 {instructor}；
--   舊後台若選「職員／助教／工讀」當合作狀態會被 CHECK 擋下（預期行為，換版後就沒有這些選項）。
--   副作用：補 NULL→active 的那幾列 updated_at 會變成套用時間（set_instructors_updated_at trigger）。
--   表鎖：ALTER TABLE 要拿 instructors 的表鎖；5 秒內拿不到（例如前面有長交易）就報 lock timeout、整批回滾，
--         資料完全不變，稍後重跑即可（避免排隊等鎖時把全站對講師主檔的讀寫一起卡住）。
-- 本檔可重複執行。
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- 拿不到表鎖就放棄，不要排在長交易後面卡住全站（見檔頭）。
SET LOCAL lock_timeout = '5s';

-- ────────────────────────────────────────────────────────────────────
-- 1. 人員類別欄位：既有列全部拿到 {instructor}（常數預設值，不改寫既有列）
-- ────────────────────────────────────────────────────────────────────
ALTER TABLE public.instructors
  ADD COLUMN IF NOT EXISTS personnel_types text[] NOT NULL DEFAULT ARRAY['instructor']::text[];

COMMENT ON COLUMN public.instructors.personnel_types IS
  '人員類別（可複選、至少一個）：instructor＝講師、staff＝職員、part_time＝工讀計時。只有 admin 可改；合作狀態另見 employment_status。';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.instructors'::regclass
      AND conname = 'instructors_personnel_types_valid'
  ) THEN
    ALTER TABLE public.instructors
      ADD CONSTRAINT instructors_personnel_types_valid
      CHECK (
        cardinality(personnel_types) >= 1
        AND personnel_types <@ ARRAY['instructor', 'staff', 'part_time']::text[]
      );
  END IF;
END;
$$;


-- ────────────────────────────────────────────────────────────────────
-- 2. 合作狀態：既有 NULL 補成 active，之後只接受 active／frozen／cancelled（或 NULL）
--    以 SQL Editor（auth.uid() 為 NULL）執行時，各 guard trigger 直接放行；
--    trg_sync_instructor_portal_access 只在 frozen／cancelled 時降權，改成 active 不會動到 public.users。
-- ────────────────────────────────────────────────────────────────────
UPDATE public.instructors
   SET employment_status = 'active'
 WHERE employment_status IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.instructors'::regclass
      AND conname = 'instructors_employment_status_cooperation_only'
  ) THEN
    ALTER TABLE public.instructors
      ADD CONSTRAINT instructors_employment_status_cooperation_only
      CHECK (
        employment_status IS NULL
        OR employment_status::text IN ('active', 'frozen', 'cancelled')
      );
  END IF;
END;
$$;

COMMENT ON COLUMN public.instructors.employment_status IS
  '合作狀態：active＝合作中、frozen＝冷凍、cancelled＝已離職（NULL 視為合作中）。enum 舊身分值（staff／assistant／part_time）已由 CHECK 停用，身分改看 personnel_types。';


-- ────────────────────────────────────────────────────────────────────
-- 3. 管理欄位 guard：複製 20260826140000 的定義，只加入 personnel_types 保護
-- ────────────────────────────────────────────────────────────────────
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
       OR NEW.personnel_types IS DISTINCT FROM ARRAY['instructor']::text[]
       OR NEW.hide_from_leaderboard IS DISTINCT FROM false THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'administrator-managed instructor fields cannot be set by instructors';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(
      NEW.id, NEW.created_at,
      NEW.personnel_types,
      NEW.employment_status, NEW.instructor_role, NEW.speed_qualification,
      NEW.form_submitted_at, NEW.note_internal, NEW.teaching_regions_raw,
      NEW.bank_info_raw, NEW.id_front_external_url, NEW.id_back_external_url,
      NEW.photo_external_url, NEW.bankbook_external_url, NEW.wca_name,
      NEW.wca_synced_at, NEW.hide_from_leaderboard
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.created_at,
      OLD.personnel_types,
      OLD.employment_status, OLD.instructor_role, OLD.speed_qualification,
      OLD.form_submitted_at, OLD.note_internal, OLD.teaching_regions_raw,
      OLD.bank_info_raw, OLD.id_front_external_url, OLD.id_back_external_url,
      OLD.photo_external_url, OLD.bankbook_external_url, OLD.wca_name,
      OLD.wca_synced_at, OLD.hide_from_leaderboard
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


-- ────────────────────────────────────────────────────────────────────
-- 4. 資料完整度：複製 2026-08-24 的定義，接課頻率（學期／寒暑假）、授課地區、簡介
--    四項只對「含講師身分」的人要求；凍結／離職排除、個資、證件、銀行條件不變。
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION private.instructor_profile_is_complete(target_instructor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.instructors i
    WHERE i.id = target_instructor_id
      AND i.employment_status::text IS DISTINCT FROM 'frozen'
      AND i.employment_status::text IS DISTINCT FROM 'cancelled'
      AND NULLIF(BTRIM(i.full_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.nickname), '') IS NOT NULL
      AND NULLIF(BTRIM(i.gender), '') IS NOT NULL
      AND i.birth_date IS NOT NULL
      AND NULLIF(BTRIM(i.id_number), '') IS NOT NULL
      AND NULLIF(BTRIM(i.phone_mobile), '') IS NOT NULL
      AND NULLIF(BTRIM(i.line_id), '') IS NOT NULL
      AND NULLIF(BTRIM(i.address), '') IS NOT NULL
      AND NULLIF(BTRIM(i.household_address), '') IS NOT NULL
      AND NULLIF(BTRIM(i.email_primary), '') IS NOT NULL
      AND (
        NOT ('instructor' = ANY (i.personnel_types))
        OR (
          NULLIF(BTRIM(i.teaching_freq_semester), '') IS NOT NULL
          AND NULLIF(BTRIM(i.teaching_freq_vacation), '') IS NOT NULL
          AND COALESCE(cardinality(i.teaching_regions), 0) > 0
          AND NULLIF(BTRIM(i.bio_notes), '') IS NOT NULL
        )
      )
      AND NULLIF(BTRIM(i.bank_account_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_name), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_branch), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_account_number), '') IS NOT NULL
      AND NULLIF(BTRIM(i.bank_code), '') IS NOT NULL
      AND COALESCE(
        NULLIF(BTRIM(i.id_front_path), ''),
        NULLIF(BTRIM(i.id_front_external_url), '')
      ) IS NOT NULL
      AND COALESCE(
        NULLIF(BTRIM(i.id_back_path), ''),
        NULLIF(BTRIM(i.id_back_external_url), '')
      ) IS NOT NULL
      AND COALESCE(
        NULLIF(BTRIM(i.bankbook_path), ''),
        NULLIF(BTRIM(i.bankbook_external_url), '')
      ) IS NOT NULL
  );
$$;

REVOKE ALL ON FUNCTION private.instructor_profile_is_complete(uuid) FROM PUBLIC, anon, authenticated;


-- ────────────────────────────────────────────────────────────────────
-- 5. 合約提醒：複製 20260819140407 的定義，有主檔但不含講師身分（純職員／工讀）不發提醒。
--    沒有主檔的呼叫者行為不變。
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.ensure_my_contract_reminder()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id uuid := auth.uid();
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.id = actor_id AND u.role <> 'pending'
  ) OR EXISTS (
    SELECT 1 FROM public.instructor_contracts c WHERE c.user_id = actor_id AND c.status = 'signed'
  ) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.instructors i
    WHERE i.user_id = actor_id
      AND NOT ('instructor' = ANY (i.personnel_types))
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.notifications (user_id, type, title, body, link)
  SELECT actor_id, 'contract', '尚未完成合約簽署', '請盡快前往簽署合約，完成後才算正式生效。', '/contract'
  WHERE NOT EXISTS (
    SELECT 1 FROM public.notifications n
    WHERE n.user_id = actor_id
      AND n.type = 'contract'
      AND n.link = '/contract'
      AND n.is_read = false
  );
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_my_contract_reminder() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_my_contract_reminder() TO authenticated;

COMMIT;
