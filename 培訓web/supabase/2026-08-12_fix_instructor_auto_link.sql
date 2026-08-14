-- 講師歷史主檔自動帶入修復
--
-- 根因：
--   1. handle_new_user 遇到 teacher_invites 時會直接結束該分支，不再比對 instructors。
--      因此帳號角色雖已升級，歷史講師主檔仍維持 user_id IS NULL。
--   2. 舊比對未 trim email，首次登入 trigger 也區分大小寫。
--   3. link_my_instructor_by_email 預設可被 PUBLIC 呼叫，且多筆相同 email 時會任選一筆。
--
-- 修正：
--   - invite 與 instructors 比對改為可同時完成，不再互斥。
--   - email 一律 lower(btrim(...)) 後比對。
--   - 只有「唯一一筆」未綁定主檔時才自動綁定；重複 email 留給認領流程處理。
--   - RPC 改為冪等：已綁定時回傳既有 instructor id。
--   - RPC 僅授權 authenticated，函式內仍以 auth.uid() 限定本人。


-- ── A. 首次建立 auth.users 時，同步建立 public.users 並接回唯一歷史主檔 ──

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email   text;
  invite_record      record;
  has_invite         boolean := false;
  candidate_count    integer := 0;
  matched_id         uuid;
  matched_name       text;
  matched_status     text;
  resolved_role      text;
  resolved_name      text;
BEGIN
  normalized_email := lower(btrim(COALESCE(NEW.email, '')));

  IF normalized_email <> '' THEN
    SELECT ti.*
      INTO invite_record
      FROM public.teacher_invites AS ti
     WHERE lower(btrim(ti.email)) = normalized_email
     ORDER BY ti.created_at ASC
     LIMIT 1;
    has_invite := FOUND;

    SELECT count(*)
      INTO candidate_count
      FROM public.instructors AS i
     WHERE lower(btrim(i.email_primary)) = normalized_email
       AND i.user_id IS NULL;

    IF candidate_count = 1 THEN
      SELECT i.id, i.full_name, i.employment_status::text
        INTO matched_id, matched_name, matched_status
        FROM public.instructors AS i
       WHERE lower(btrim(i.email_primary)) = normalized_email
         AND i.user_id IS NULL
       FOR UPDATE;
    END IF;
  END IF;

  IF has_invite THEN
    resolved_role := invite_record.role;
    resolved_name := COALESCE(
      NULLIF(btrim(invite_record.name), ''),
      matched_name,
      NEW.raw_user_meta_data->>'full_name'
    );
  ELSIF candidate_count = 1 THEN
    resolved_role := CASE
      WHEN matched_status IN ('frozen', 'cancelled') THEN 'pending'
      ELSE 'teacher'
    END;
    resolved_name := COALESCE(
      matched_name,
      NEW.raw_user_meta_data->>'full_name'
    );
  ELSE
    resolved_role := 'pending';
    resolved_name := NEW.raw_user_meta_data->>'full_name';
  END IF;

  INSERT INTO public.users (id, name, email, role)
  VALUES (NEW.id, resolved_name, NEW.email, resolved_role)
  ON CONFLICT (id) DO NOTHING;

  IF has_invite THEN
    DELETE FROM public.teacher_invites WHERE id = invite_record.id;
  END IF;

  IF candidate_count = 1 THEN
    UPDATE public.instructors
       SET user_id = NEW.id
     WHERE id = matched_id
       AND user_id IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;


-- ── B. 已建立帳號的 fallback：登入時補接回唯一歷史主檔 ──

CREATE OR REPLACE FUNCTION public.link_my_instructor_by_email()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  my_user_id       uuid := auth.uid();
  normalized_email text;
  existing_id      uuid;
  matched_id       uuid;
  matched_status   text;
  candidate_count  integer := 0;
BEGIN
  IF my_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT i.id
    INTO existing_id
    FROM public.instructors AS i
   WHERE i.user_id = my_user_id
   LIMIT 1;

  IF existing_id IS NOT NULL THEN
    RETURN existing_id;
  END IF;

  SELECT lower(btrim(u.email))
    INTO normalized_email
    FROM auth.users AS u
   WHERE u.id = my_user_id;

  IF normalized_email IS NULL OR normalized_email = '' THEN
    RETURN NULL;
  END IF;

  SELECT count(*)
    INTO candidate_count
    FROM public.instructors AS i
   WHERE lower(btrim(i.email_primary)) = normalized_email
     AND i.user_id IS NULL;

  -- 同一 email 若有多筆主檔，不猜測真人身分；交由姓名/手機/身分證認領流程處理。
  IF candidate_count <> 1 THEN
    RETURN NULL;
  END IF;

  SELECT i.id, i.employment_status::text
    INTO matched_id, matched_status
    FROM public.instructors AS i
   WHERE lower(btrim(i.email_primary)) = normalized_email
     AND i.user_id IS NULL
   FOR UPDATE;

  IF matched_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.instructors
     SET user_id = my_user_id
   WHERE id = matched_id
     AND user_id IS NULL
  RETURNING id INTO matched_id;

  IF matched_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE public.users
     SET role = CASE
       WHEN matched_status IN ('frozen', 'cancelled') THEN 'pending'
       ELSE 'teacher'
     END
   WHERE id = my_user_id
     AND role = 'pending';

  RETURN matched_id;
END;
$$;

REVOKE ALL ON FUNCTION public.link_my_instructor_by_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_my_instructor_by_email() FROM anon;
GRANT EXECUTE ON FUNCTION public.link_my_instructor_by_email() TO authenticated;


-- ── 套用後唯讀驗證（不含真人資料）────────────────────────────
-- SELECT p.proname, p.prosecdef, p.proconfig
--   FROM pg_proc AS p
--   JOIN pg_namespace AS n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('handle_new_user', 'link_my_instructor_by_email');
--
-- SELECT has_function_privilege('anon', 'public.link_my_instructor_by_email()', 'EXECUTE')
--        AS anon_can_execute,
--        has_function_privilege('authenticated', 'public.link_my_instructor_by_email()', 'EXECUTE')
--        AS authenticated_can_execute;
