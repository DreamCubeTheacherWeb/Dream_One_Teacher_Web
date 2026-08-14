-- Google-only 帳號建立白名單
--
-- 使用方式：套用本 migration 後，至 Supabase Dashboard
-- Authentication → Hooks → Before User Created，選擇此 Postgres 函式：
-- public.hook_allow_known_google_signup
--
-- Auth hook 必須在 auth.users 建立前執行，才能讓未列名單的 Google Email
-- 在資料庫層被拒絕，而不是先建立 pending 帳號後才靠前端隱藏功能。

CREATE OR REPLACE FUNCTION public.hook_allow_known_google_signup(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  normalized_email text := lower(btrim(COALESCE(event->'user'->>'email', '')));
  auth_provider     text := lower(COALESCE(event->'user'->'app_metadata'->>'provider', ''));
  is_known_email    boolean := false;
BEGIN
  IF auth_provider <> 'google' THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', '請使用 Google 帳號登入。'
      )
    );
  END IF;

  IF normalized_email <> '' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.teacher_invites AS ti
       WHERE lower(btrim(ti.email)) = normalized_email
      UNION ALL
      SELECT 1
        FROM public.instructors AS i
       WHERE lower(btrim(i.email_primary)) = normalized_email
         AND i.user_id IS NULL
    )
      INTO is_known_email;
  END IF;

  IF NOT is_known_email THEN
    RETURN jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', '此 Email 尚未由管理員建立，請聯繫管理員。'
      )
    );
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

REVOKE ALL ON FUNCTION public.hook_allow_known_google_signup(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hook_allow_known_google_signup(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.hook_allow_known_google_signup(jsonb) FROM authenticated;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_allow_known_google_signup(jsonb) TO supabase_auth_admin;

COMMENT ON FUNCTION public.hook_allow_known_google_signup(jsonb) IS
  'Before User Created hook: only pre-approved Google emails may create Auth users.';
