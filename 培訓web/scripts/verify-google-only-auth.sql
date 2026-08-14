CREATE TABLE public.teacher_invites (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL,
  role text NOT NULL
);

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY,
  email_primary text,
  user_id uuid
);

\ir ../supabase/migrations/20260814034139_google_only_invite_signup.sql

INSERT INTO public.teacher_invites (id, name, email, role)
VALUES ('00000000-0000-4000-8000-000000000001', '受邀講師', ' Invited@Example.com ', 'teacher');

INSERT INTO public.instructors (id, email_primary, user_id)
VALUES
  ('00000000-0000-4000-8000-000000000002', 'History@Example.com', NULL),
  ('00000000-0000-4000-8000-000000000003', 'linked@example.com', '00000000-0000-4000-8000-000000000099');

DO $$
DECLARE
  hook_result jsonb;
BEGIN
  hook_result := public.hook_allow_known_google_signup(
    '{"user":{"email":"invited@example.com","app_metadata":{"provider":"google"}}}'::jsonb
  );
  IF hook_result <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invited Google email should be allowed: %', hook_result;
  END IF;

  hook_result := public.hook_allow_known_google_signup(
    '{"user":{"email":" HISTORY@example.COM ","app_metadata":{"provider":"google"}}}'::jsonb
  );
  IF hook_result <> '{}'::jsonb THEN
    RAISE EXCEPTION 'unlinked historical instructor should be allowed: %', hook_result;
  END IF;

  hook_result := public.hook_allow_known_google_signup(
    '{"user":{"email":"unknown@example.com","app_metadata":{"provider":"google"}}}'::jsonb
  );
  IF hook_result->'error'->>'http_code' <> '403' THEN
    RAISE EXCEPTION 'unknown email should be rejected: %', hook_result;
  END IF;

  hook_result := public.hook_allow_known_google_signup(
    '{"user":{"email":"invited@example.com","app_metadata":{"provider":"email"}}}'::jsonb
  );
  IF hook_result->'error'->>'http_code' <> '403' THEN
    RAISE EXCEPTION 'non-Google provider should be rejected: %', hook_result;
  END IF;

  hook_result := public.hook_allow_known_google_signup(
    '{"user":{"email":"linked@example.com","app_metadata":{"provider":"google"}}}'::jsonb
  );
  IF hook_result->'error'->>'http_code' <> '403' THEN
    RAISE EXCEPTION 'already-linked instructor must not create a second Auth user: %', hook_result;
  END IF;

  IF has_function_privilege('anon', 'public.hook_allow_known_google_signup(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute Auth hook';
  END IF;
  IF has_function_privilege('authenticated', 'public.hook_allow_known_google_signup(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must not execute Auth hook';
  END IF;
  IF NOT has_schema_privilege('supabase_auth_admin', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'supabase_auth_admin must use public schema';
  END IF;
  IF NOT has_function_privilege('supabase_auth_admin', 'public.hook_allow_known_google_signup(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'supabase_auth_admin must execute Auth hook';
  END IF;
END;
$$;

SELECT 'google-only Auth hook: 9/9 PASS' AS result;
