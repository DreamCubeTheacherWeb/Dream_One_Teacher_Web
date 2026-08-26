-- 恢復既有講師的本人核對流程：
--   1. Google Email 同時比對主要／備用 Email，唯一命中即直接認領。
--   2. Email 未命中的舊講師，可用姓名、完整手機與身分證末四碼核對。
--   3. 核對成功直接認領，不進新進講師審核；失敗不揭露是哪個欄位不符。

BEGIN;

CREATE INDEX IF NOT EXISTS idx_instructors_normalized_secondary_email
  ON public.instructors ((lower(BTRIM(email_secondary))))
  WHERE NULLIF(BTRIM(email_secondary), '') IS NOT NULL;

CREATE TABLE IF NOT EXISTS private.instructor_identity_claim_attempts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON TABLE private.instructor_identity_claim_attempts FROM PUBLIC, anon, authenticated;


-- 既有管理欄位 guard 原本把 user_id 也視為完全不可變，會連安全認領 RPC 一起擋下。
-- 非 admin 只額外允許「尚未認領的主檔 → 綁定目前本人」；RLS 仍禁止本人直接看到或更新未認領列。
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
       OR NEW.hide_from_leaderboard IS DISTINCT FROM false THEN
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
      NEW.wca_synced_at, NEW.hide_from_leaderboard
    ) IS DISTINCT FROM ROW(
      OLD.id, OLD.created_at,
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


CREATE OR REPLACE FUNCTION public.claim_my_precreated_instructor()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id          uuid := auth.uid();
  actor_role        text;
  normalized_email  text;
  existing_id       uuid;
  existing_status   text;
  match_count       integer := 0;
  matched_id        uuid;
  matched_user_id   uuid;
  matched_status    text;
  linked_id         uuid;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'authentication required';
  END IF;

  SELECT pu.role, lower(BTRIM(COALESCE(au.email, '')))
    INTO actor_role, normalized_email
    FROM auth.users au
    LEFT JOIN public.users pu ON pu.id = au.id
   WHERE au.id = actor_id;

  IF actor_role IS NULL
     OR actor_role NOT IN ('pending', 'teacher', 'mentor', 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'registered account required';
  END IF;

  SELECT i.id, i.employment_status::text
    INTO existing_id, existing_status
    FROM public.instructors i
   WHERE i.user_id = actor_id
   LIMIT 1;

  IF existing_id IS NOT NULL THEN
    IF existing_status IN ('frozen', 'cancelled')
       AND COALESCE(actor_role, 'pending') NOT IN ('admin', 'mentor') THEN
      UPDATE public.users
         SET role = 'pending'
       WHERE id = actor_id
         AND role = 'teacher';

      RETURN jsonb_build_object(
        'status', 'blocked',
        'instructor_id', existing_id,
        'reason', '此講師帳號已停止使用，如有疑問請聯繫管理員。'
      );
    END IF;

    RETURN jsonb_build_object(
      'status', 'claimed',
      'instructor_id', existing_id,
      'claimed_now', false
    );
  END IF;

  IF normalized_email = '' THEN
    RETURN jsonb_build_object('status', 'new', 'reason', '登入帳號沒有可用的 Email。');
  END IF;

  SELECT count(*)
    INTO match_count
    FROM public.instructors i
   WHERE lower(BTRIM(i.email_primary)) = normalized_email
      OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email;

  IF match_count = 0 THEN
    RETURN jsonb_build_object('status', 'new');
  END IF;

  IF match_count > 1 THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', '此 Email 對應多筆講師資料，請聯繫管理員確認。'
    );
  END IF;

  SELECT i.id, i.user_id, i.employment_status::text
    INTO matched_id, matched_user_id, matched_status
    FROM public.instructors i
   WHERE lower(BTRIM(i.email_primary)) = normalized_email
      OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email
   FOR UPDATE;

  IF matched_user_id IS NOT NULL AND matched_user_id <> actor_id THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', '此講師資料已由其他帳號認領，請聯繫管理員。'
    );
  END IF;

  IF matched_status IN ('frozen', 'cancelled') THEN
    IF COALESCE(actor_role, 'pending') IN ('admin', 'mentor') THEN
      RETURN jsonb_build_object('status', 'staff');
    END IF;

    RETURN jsonb_build_object(
      'status', 'blocked',
      'instructor_id', matched_id,
      'reason', '此講師帳號已停止使用，如有疑問請聯繫管理員。'
    );
  END IF;

  UPDATE public.instructors
     SET user_id = actor_id
   WHERE id = matched_id
     AND user_id IS NULL
  RETURNING id INTO linked_id;

  IF linked_id IS NULL THEN
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', '講師資料剛被其他帳號認領，請聯繫管理員。'
    );
  END IF;

  UPDATE public.users
     SET role = 'teacher'
   WHERE id = actor_id
     AND role = 'pending';

  RETURN jsonb_build_object(
    'status', 'claimed',
    'instructor_id', linked_id,
    'claimed_now', true
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_my_precreated_instructor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_my_precreated_instructor() TO authenticated;


CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text := lower(BTRIM(COALESCE(NEW.email, '')));
  match_count      integer := 0;
  matched_id       uuid;
  matched_name     text;
  matched_status   text;
  matched_user_id  uuid;
  linked_id        uuid;
  staff_invite_id  uuid;
  staff_role       text;
  staff_name       text;
  resolved_role    text := 'pending';
  resolved_name    text := NEW.raw_user_meta_data->>'full_name';
BEGIN
  IF normalized_email <> '' THEN
    SELECT ti.id, ti.role, ti.name
      INTO staff_invite_id, staff_role, staff_name
      FROM public.teacher_invites ti
     WHERE lower(BTRIM(ti.email)) = normalized_email
       AND ti.role IN ('admin', 'mentor')
     ORDER BY ti.created_at ASC
     LIMIT 1;

    SELECT count(*)
      INTO match_count
      FROM public.instructors i
     WHERE lower(BTRIM(i.email_primary)) = normalized_email
        OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email;

    IF match_count = 1 THEN
      SELECT i.id, i.full_name, i.employment_status::text, i.user_id
        INTO matched_id, matched_name, matched_status, matched_user_id
        FROM public.instructors i
       WHERE lower(BTRIM(i.email_primary)) = normalized_email
          OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email
       FOR UPDATE;

      IF matched_user_id IS NULL
         AND matched_status IS DISTINCT FROM 'frozen'
         AND matched_status IS DISTINCT FROM 'cancelled' THEN
        resolved_role := 'teacher';
        resolved_name := COALESCE(NULLIF(BTRIM(matched_name), ''), resolved_name);
      END IF;
    END IF;
  END IF;

  IF staff_invite_id IS NOT NULL THEN
    resolved_role := staff_role;
    resolved_name := COALESCE(NULLIF(BTRIM(staff_name), ''), matched_name, resolved_name);
  END IF;

  INSERT INTO public.users (id, name, email, role)
  VALUES (NEW.id, resolved_name, NEW.email, resolved_role)
  ON CONFLICT (id) DO NOTHING;

  IF matched_id IS NOT NULL
     AND matched_user_id IS NULL
     AND matched_status IS DISTINCT FROM 'frozen'
     AND matched_status IS DISTINCT FROM 'cancelled' THEN
    UPDATE public.instructors
       SET user_id = NEW.id
     WHERE id = matched_id
       AND user_id IS NULL
    RETURNING id INTO linked_id;

    IF linked_id IS NULL AND resolved_role = 'teacher' THEN
      UPDATE public.users SET role = 'pending' WHERE id = NEW.id;
    END IF;
  END IF;

  IF staff_invite_id IS NOT NULL THEN
    DELETE FROM public.teacher_invites WHERE id = staff_invite_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;


-- 新進講師建立主檔時仍須使用 Google Email；既有講師認領後則可保留舊聯絡 Email。
CREATE OR REPLACE FUNCTION public.guard_instructor_identity_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id    uuid := auth.uid();
  actor_role  text;
  actor_email text;
BEGIN
  IF actor_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT u.role, lower(BTRIM(COALESCE(au.email, '')))
    INTO actor_role, actor_email
    FROM public.users u
    JOIN auth.users au ON au.id = u.id
   WHERE u.id = actor_id;

  IF actor_role = 'admin' THEN
    RETURN NEW;
  END IF;

  IF actor_role IS NULL
     OR actor_role NOT IN ('pending', 'teacher')
     OR NEW.user_id IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'instructor identity is not owned by the signed-in account';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF lower(BTRIM(COALESCE(NEW.email_primary, ''))) IS DISTINCT FROM actor_email THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'new instructor email must match the signed-in Google account';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.user_id IS NOT NULL AND OLD.user_id IS DISTINCT FROM actor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'instructor identity is already owned by another account';
  END IF;

  IF NEW.email_primary IS DISTINCT FROM OLD.email_primary
     AND lower(BTRIM(COALESCE(NEW.email_primary, ''))) IS DISTINCT FROM actor_email THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'changed instructor email must match the signed-in Google account';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_identity_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_identity_email ON public.instructors;
CREATE TRIGGER trg_guard_instructor_identity_email
BEFORE INSERT OR UPDATE OF user_id, email_primary ON public.instructors
FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_identity_email();


CREATE OR REPLACE FUNCTION public.hook_allow_known_google_signup(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text := lower(BTRIM(COALESCE(event->'user'->>'email', '')));
  auth_provider     text := lower(COALESCE(event->'user'->'app_metadata'->>'provider', ''));
  auth_providers    jsonb := COALESCE(event->'user'->'app_metadata'->'providers', '[]'::jsonb);
  match_count       integer := 0;
  blocked_count     integer := 0;
  linked_count      integer := 0;
BEGIN
  IF auth_provider <> 'google' AND NOT (auth_providers ? 'google') THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', '請使用 Google 帳號登入。')
    );
  END IF;

  IF normalized_email = '' THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'Google 帳號未提供 Email，無法建立帳號。')
    );
  END IF;

  SELECT
    count(*),
    count(*) FILTER (WHERE i.employment_status::text IN ('frozen', 'cancelled')),
    count(*) FILTER (WHERE i.user_id IS NOT NULL)
    INTO match_count, blocked_count, linked_count
    FROM public.instructors i
   WHERE lower(BTRIM(i.email_primary)) = normalized_email
      OR lower(BTRIM(COALESCE(i.email_secondary, ''))) = normalized_email;

  IF blocked_count > 0 THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', '此講師帳號已停止使用，如有疑問請聯繫管理員。')
    );
  END IF;

  IF match_count > 1 THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object('http_code', 409, 'message', '此 Email 對應多筆講師資料，請聯繫管理員確認。')
    );
  END IF;

  IF linked_count > 0 THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object('http_code', 409, 'message', '此講師資料已由其他帳號認領，請聯繫管理員。')
    );
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.hook_allow_known_google_signup(jsonb) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_allow_known_google_signup(jsonb) TO supabase_auth_admin;


CREATE OR REPLACE FUNCTION public.claim_existing_instructor_by_identity(
  provided_full_name text,
  provided_phone_mobile text,
  provided_id_last_four text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor_id          uuid := auth.uid();
  actor_role        text;
  normalized_name   text := regexp_replace(BTRIM(COALESCE(provided_full_name, '')), '\s+', '', 'g');
  normalized_phone  text := regexp_replace(COALESCE(provided_phone_mobile, ''), '\D', '', 'g');
  normalized_last4  text := BTRIM(COALESCE(provided_id_last_four, ''));
  attempt_count     integer;
  attempt_lock      timestamptz;
  match_count       integer := 0;
  matched_id        uuid;
  matched_name      text;
  matched_user_id   uuid;
  linked_id         uuid;
  next_attempts     integer;
  next_lock         timestamptz;
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

  IF EXISTS (SELECT 1 FROM public.instructors i WHERE i.user_id = actor_id) THEN
    RETURN jsonb_build_object('status', 'claimed', 'claimed_now', false);
  END IF;

  IF normalized_name = ''
     OR length(normalized_phone) < 8
     OR length(normalized_phone) > 15
     OR normalized_last4 !~ '^[0-9]{4}$' THEN
    RETURN jsonb_build_object(
      'status', 'invalid_input',
      'reason', '請輸入完整姓名、完整手機號碼與身分證末四碼。'
    );
  END IF;

  INSERT INTO private.instructor_identity_claim_attempts (user_id)
  VALUES (actor_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT a.failed_attempts, a.locked_until
    INTO attempt_count, attempt_lock
    FROM private.instructor_identity_claim_attempts a
   WHERE a.user_id = actor_id
   FOR UPDATE;

  IF attempt_lock IS NOT NULL AND attempt_lock > now() THEN
    RETURN jsonb_build_object(
      'status', 'locked',
      'reason', '核對嘗試次數過多，請 24 小時後再試或聯繫管理員。',
      'locked_until', attempt_lock
    );
  END IF;

  IF attempt_lock IS NOT NULL AND attempt_lock <= now() THEN
    attempt_count := 0;
    UPDATE private.instructor_identity_claim_attempts
       SET failed_attempts = 0, locked_until = NULL, updated_at = now()
     WHERE user_id = actor_id;
  END IF;

  SELECT count(*)
    INTO match_count
    FROM public.instructors i
   WHERE regexp_replace(BTRIM(COALESCE(i.full_name, '')), '\s+', '', 'g') = normalized_name
     AND regexp_replace(COALESCE(i.phone_mobile, ''), '\D', '', 'g') = normalized_phone
     AND right(regexp_replace(upper(COALESCE(i.id_number, '')), '[^A-Z0-9]', '', 'g'), 4) = normalized_last4
     AND i.employment_status::text NOT IN ('frozen', 'cancelled');

  IF match_count = 1 THEN
    SELECT i.id, i.full_name, i.user_id
      INTO matched_id, matched_name, matched_user_id
      FROM public.instructors i
     WHERE regexp_replace(BTRIM(COALESCE(i.full_name, '')), '\s+', '', 'g') = normalized_name
       AND regexp_replace(COALESCE(i.phone_mobile, ''), '\D', '', 'g') = normalized_phone
       AND right(regexp_replace(upper(COALESCE(i.id_number, '')), '[^A-Z0-9]', '', 'g'), 4) = normalized_last4
       AND i.employment_status::text NOT IN ('frozen', 'cancelled')
     FOR UPDATE;

    IF matched_user_id IS NULL THEN
      UPDATE public.instructors
         SET user_id = actor_id
       WHERE id = matched_id
         AND user_id IS NULL
      RETURNING id INTO linked_id;
    END IF;
  END IF;

  IF linked_id IS NOT NULL THEN
    UPDATE public.users
       SET role = 'teacher',
           name = COALESCE(NULLIF(BTRIM(matched_name), ''), name)
     WHERE id = actor_id
       AND role = 'pending';

    DELETE FROM private.instructor_identity_claim_attempts WHERE user_id = actor_id;

    RETURN jsonb_build_object(
      'status', 'claimed',
      'instructor_id', linked_id,
      'claimed_now', true
    );
  END IF;

  next_attempts := attempt_count + 1;
  next_lock := CASE WHEN next_attempts >= 5 THEN now() + interval '24 hours' ELSE NULL END;

  UPDATE private.instructor_identity_claim_attempts
     SET failed_attempts = CASE WHEN next_attempts >= 5 THEN 5 ELSE next_attempts END,
         locked_until = next_lock,
         updated_at = now()
   WHERE user_id = actor_id;

  IF next_lock IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'locked',
      'reason', '核對嘗試次數過多，請 24 小時後再試或聯繫管理員。',
      'locked_until', next_lock
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'not_found',
    'reason', '資料核對未通過，請確認三項資料與原講師主檔一致。',
    'attempts_remaining', 5 - next_attempts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_existing_instructor_by_identity(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_existing_instructor_by_identity(text, text, text) TO authenticated;

COMMENT ON FUNCTION public.claim_existing_instructor_by_identity(text, text, text) IS
  'Claims one active, unclaimed instructor row after exact name, full mobile number and ID last-four verification. Failures are rate-limited and do not reveal field-level matches.';

COMMIT;
