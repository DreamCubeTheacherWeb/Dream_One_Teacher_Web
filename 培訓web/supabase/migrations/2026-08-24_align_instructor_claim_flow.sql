-- 講師主檔、Google 帳號認領與新註冊審核併軌。
--
-- 主檔語意：
--   * public.instructors 是講師本人、文件、銀行、薪資與歷史資料的唯一主檔。
--   * instructors.user_id 只代表是否已被某個 Google 帳號認領，不代表這位講師是否存在。
--   * 唯一 Email 命中既有可用主檔：首次登入立即認領，不需審核。
--   * 完全未建檔的 Google 帳號：可註冊並填資料，public.users 維持 pending 等待管理員審核。
--   * frozen / cancelled：拒絕認領與講師內容存取。

BEGIN;

-- 既有 teacher_invites 只是舊版過渡佇列。若尚有 teacher 資料，先轉成最小講師主檔。
-- admin / mentor 舊資料暫時只作 staff 帳號首次登入的相容入口，不再代表講師是否存在。
INSERT INTO public.instructors (full_name, email_primary, employment_status)
SELECT
  COALESCE(NULLIF(BTRIM(ti.name), ''), split_part(BTRIM(ti.email), '@', 1)),
  lower(BTRIM(ti.email)),
  'active'::public.employment_status_enum
FROM public.teacher_invites ti
WHERE ti.role = 'teacher'
  AND NULLIF(BTRIM(ti.email), '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.instructors i
    WHERE lower(BTRIM(i.email_primary)) = lower(BTRIM(ti.email))
  );

DELETE FROM public.teacher_invites WHERE role = 'teacher';

COMMENT ON TABLE public.teacher_invites IS
  'Legacy staff-account bootstrap only. Instructor existence and recognition are owned by public.instructors.';

CREATE INDEX IF NOT EXISTS idx_instructors_normalized_primary_email
  ON public.instructors ((lower(BTRIM(email_primary))))
  WHERE NULLIF(BTRIM(email_primary), '') IS NOT NULL;


-- 前端登入後只呼叫這一個 RPC。它同時處理「已認領」、「首次認領」、
-- 「全新註冊」、「Email 衝突」與「已停用」，避免前端各自猜測。
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
   WHERE lower(BTRIM(i.email_primary)) = normalized_email;

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

COMMENT ON FUNCTION public.claim_my_precreated_instructor() IS
  'Idempotently recognizes the current Google account against one pre-created instructor master row.';


-- 保留舊 RPC 簽章給尚未更新的前端，但改由上方唯一決策點處理。
CREATE OR REPLACE FUNCTION public.link_my_instructor_by_email()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid()
      AND u.role IN ('pending', 'teacher', 'mentor', 'admin')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'registered account required';
  END IF;

  result := public.claim_my_precreated_instructor();
  IF result->>'status' = 'claimed' THEN
    RETURN (result->>'instructor_id')::uuid;
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.link_my_instructor_by_email() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_my_instructor_by_email() TO authenticated;


-- auth.users 建立後：唯一、未認領、非停用的講師立即綁定並取得 teacher；
-- 完全未建檔者建立 pending 帳號，後續填完資料等管理員審核。
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
     WHERE lower(BTRIM(i.email_primary)) = normalized_email;

    IF match_count = 1 THEN
      SELECT i.id, i.full_name, i.employment_status::text, i.user_id
        INTO matched_id, matched_name, matched_status, matched_user_id
        FROM public.instructors i
       WHERE lower(BTRIM(i.email_primary)) = normalized_email
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

    -- 防止兩個登入同時搶同一主檔時留下沒有主檔的 teacher 角色。
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


-- 講師主檔的主要 Email 是 Google 認領鍵。非管理員只能建立／維持與自己 Auth
-- Email 相同的主檔，避免 pending 帳號製造別人的重複 Email 並阻斷合法登入。
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
  -- migration/service-role 內部操作沒有 JWT，由既有資料維護流程負責。
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
     OR NEW.user_id IS DISTINCT FROM actor_id
     OR lower(BTRIM(COALESCE(NEW.email_primary, ''))) IS DISTINCT FROM actor_email THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'instructor identity email must match the signed-in Google account';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_instructor_identity_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_guard_instructor_identity_email ON public.instructors;
CREATE TRIGGER trg_guard_instructor_identity_email
BEFORE INSERT OR UPDATE OF user_id, email_primary ON public.instructors
FOR EACH ROW EXECUTE FUNCTION public.guard_instructor_identity_email();


-- Before User Created hook 只限定 Google provider。未建檔 Email 要放行，才能進入新註冊審核；
-- 已停用、重複 Email 或已被其他 Auth 帳號認領則在建帳前直接拒絕。
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
   WHERE lower(BTRIM(i.email_primary)) = normalized_email;

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

COMMENT ON FUNCTION public.hook_allow_known_google_signup(jsonb) IS
  'Before User Created hook: Google-only; unknown emails register as pending, pre-created instructors are claimed, disabled or ambiguous records are rejected.';


-- 講師被轉為凍結或停止合作時，立即將 teacher 帳號降為 pending。
-- 不自動復權，恢復合作時仍由管理員明確開啟。admin / mentor 不受講師人事狀態影響。
CREATE OR REPLACE FUNCTION public.sync_instructor_portal_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS NOT NULL
     AND NEW.employment_status::text IN ('frozen', 'cancelled') THEN
    UPDATE public.users
       SET role = 'pending'
     WHERE id = NEW.user_id
       AND role = 'teacher';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.sync_instructor_portal_access() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_sync_instructor_portal_access ON public.instructors;
CREATE TRIGGER trg_sync_instructor_portal_access
AFTER INSERT OR UPDATE OF user_id, employment_status ON public.instructors
FOR EACH ROW EXECUTE FUNCTION public.sync_instructor_portal_access();

UPDATE public.users u
   SET role = 'pending'
  FROM public.instructors i
 WHERE i.user_id = u.id
   AND i.employment_status::text IN ('frozen', 'cancelled')
   AND u.role = 'teacher';


-- 所有講師內容 RLS 已共用這個 private helper；把人事狀態一併納入，
-- 避免只靠前端登出或單次 role 降級。
CREATE OR REPLACE FUNCTION private.current_user_is_teacher()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.users u
    JOIN public.instructors i ON i.user_id = u.id
    WHERE u.id = (SELECT auth.uid())
      AND u.role = 'teacher'
      AND i.employment_status::text IS DISTINCT FROM 'frozen'
      AND i.employment_status::text IS DISTINCT FROM 'cancelled'
  );
$$;

REVOKE ALL ON FUNCTION private.current_user_is_teacher() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.current_user_is_teacher() TO authenticated;


-- 既有匯入文件有些尚保存在 *_external_url；這些也是已建檔的文件，
-- 完整度不能只看之後綁定帳號才上傳的 Storage path。photo 維持選填。
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
      AND NULLIF(BTRIM(i.teaching_freq_semester), '') IS NOT NULL
      AND NULLIF(BTRIM(i.teaching_freq_vacation), '') IS NOT NULL
      AND COALESCE(cardinality(i.teaching_regions), 0) > 0
      AND NULLIF(BTRIM(i.bio_notes), '') IS NOT NULL
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

CREATE OR REPLACE FUNCTION public.is_my_instructor_profile_complete()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.role IN ('pending', 'teacher', 'mentor', 'admin')
    )
    AND COALESCE((
      SELECT private.instructor_profile_is_complete(i.id)
      FROM public.instructors i
      WHERE i.user_id = auth.uid()
      LIMIT 1
    ), false);
$$;

REVOKE ALL ON FUNCTION public.is_my_instructor_profile_complete() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_my_instructor_profile_complete() TO authenticated;


-- 完全未預先建檔的新註冊帳號，只有在資料齊全後才能由後台核准。
CREATE OR REPLACE FUNCTION public.approve_new_instructor_account(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_instructor_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  SELECT i.id
    INTO target_instructor_id
    FROM public.instructors i
   WHERE i.user_id = target_user_id
   LIMIT 1;

  IF target_instructor_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'instructor profile has not been created';
  END IF;

  IF NOT private.instructor_profile_is_complete(target_instructor_id) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'instructor profile is incomplete or disabled';
  END IF;

  UPDATE public.users
     SET role = 'teacher'
   WHERE id = target_user_id
     AND role = 'pending';

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'account is not pending';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.approve_new_instructor_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_new_instructor_account(uuid) TO authenticated;


-- 解開認領時先撤回 teacher 權限，避免同一個尚未重新登入的 session 暫時保留前端權限。
CREATE OR REPLACE FUNCTION public.admin_unlink_instructor(target_instructor_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  linked_user_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  SELECT i.user_id INTO linked_user_id
  FROM public.instructors i
  WHERE i.id = target_instructor_id
  FOR UPDATE;

  UPDATE public.instructors
  SET user_id = NULL
  WHERE id = target_instructor_id;

  UPDATE public.users
  SET role = 'pending'
  WHERE id = linked_user_id AND role = 'teacher';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_unlink_instructor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_unlink_instructor(uuid) TO authenticated;


-- 刪除登入帳號不得刪掉講師主檔；主檔回到未認領，薪資與既有文件仍可使用。
CREATE OR REPLACE FUNCTION public.delete_user_completely(target_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target_email text;
  delete_id uuid := target_user_id;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND u.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'admin access required';
  END IF;

  SELECT au.email INTO target_email FROM auth.users au WHERE au.id = delete_id;

  UPDATE public.instructors i SET user_id = NULL WHERE i.user_id = delete_id;
  UPDATE public.instructor_form_downloads d
     SET target_user_id = NULL
   WHERE d.target_user_id = delete_id;
  UPDATE public.instructor_form_downloads d
     SET downloaded_by = NULL
   WHERE d.downloaded_by = delete_id;
  DELETE FROM public.instructor_profile_drafts d WHERE d.user_id = delete_id;
  DELETE FROM public.instructor_contracts c WHERE c.user_id = delete_id;
  DELETE FROM public.progress p WHERE p.user_id = delete_id;
  DELETE FROM public.assignments a WHERE a.user_id = delete_id;
  DELETE FROM public.course_training_status s WHERE s.user_id = delete_id;
  DELETE FROM public.notifications n WHERE n.user_id = delete_id;
  DELETE FROM public.users u WHERE u.id = delete_id;
  IF target_email IS NOT NULL THEN
    DELETE FROM public.teacher_invites ti
    WHERE lower(BTRIM(ti.email)) = lower(BTRIM(target_email));
  END IF;
  DELETE FROM auth.users au WHERE au.id = delete_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_user_completely(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_user_completely(uuid) TO authenticated;


-- 公告是完整度例外，但仍不能讓已凍結／停止合作的 teacher 直接存取。
DROP POLICY IF EXISTS "Approved users can view published announcements" ON public.announcements;
CREATE POLICY "Approved users can view published announcements"
  ON public.announcements FOR SELECT TO authenticated
  USING (
    published = true
    AND (
      (SELECT private.current_user_is_staff())
      OR (SELECT private.current_user_is_teacher())
    )
  );


-- 表單下載稽核應指向講師主檔，而不是必須存在的登入帳號。
ALTER TABLE public.instructor_form_downloads
  ADD COLUMN IF NOT EXISTS target_instructor_id uuid
  REFERENCES public.instructors(id) ON DELETE SET NULL;

UPDATE public.instructor_form_downloads d
   SET target_instructor_id = i.id
  FROM public.instructors i
 WHERE d.target_instructor_id IS NULL
   AND d.target_user_id = i.user_id;

CREATE INDEX IF NOT EXISTS idx_instructor_form_downloads_target_instructor
  ON public.instructor_form_downloads (target_instructor_id);

COMMIT;
