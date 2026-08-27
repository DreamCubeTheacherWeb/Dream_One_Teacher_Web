CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;

CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  role text NOT NULL
);

CREATE TABLE public.contract_field_positions (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  doc_type text NOT NULL,
  doc_version integer NOT NULL,
  field_type text NOT NULL,
  page_number integer NOT NULL,
  x double precision NOT NULL,
  y_from_top double precision NOT NULL,
  width double precision NOT NULL CHECK (width > 0),
  height double precision NOT NULL,
  font_size double precision DEFAULT 13,
  created_at timestamptz DEFAULT now(),
  UNIQUE (doc_type, doc_version, field_type, page_number)
);

GRANT USAGE ON SCHEMA public, auth TO authenticated;
GRANT SELECT ON public.users TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.contract_field_positions TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

INSERT INTO public.users (id, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'admin'),
  ('00000000-0000-0000-0000-000000000002', 'teacher');

INSERT INTO public.contract_field_positions (
  doc_type, doc_version, field_type, page_number, x, y_from_top, width, height
) VALUES
  ('remittance', 1, 'name', 1, 10, 10, 100, 20),
  ('remittance', 2, 'name', 1, 20, 20, 100, 20);

\ir ../supabase/migrations/20260827105756_allow_duplicate_contract_field_positions.sql
\ir ../supabase/migrations/20260827105756_allow_duplicate_contract_field_positions.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'public.contract_field_positions'::regclass
      AND constraint_row.contype = 'u'
  ) THEN
    RAISE EXCEPTION 'field-position unique constraint still exists';
  END IF;

  IF to_regclass('public.contract_field_positions_doc_type_version_idx') IS NULL THEN
    RAISE EXCEPTION 'non-unique document lookup index was not created';
  END IF;

  IF has_function_privilege(
    'anon',
    'public.replace_contract_field_positions(text, integer, jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'anon can execute field-position replacement RPC';
  END IF;

  IF NOT has_function_privilege(
    'authenticated',
    'public.replace_contract_field_positions(text, integer, jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'authenticated role cannot execute field-position replacement RPC';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

SELECT public.replace_contract_field_positions(
  'remittance',
  1,
  '[
    {"field_type":"name","page_number":1,"x":10,"y_from_top":10,"width":100,"height":20,"font_size":13},
    {"field_type":"name","page_number":1,"x":210,"y_from_top":10,"width":100,"height":20,"font_size":13}
  ]'::jsonb
);

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM public.contract_field_positions
    WHERE doc_type = 'remittance'
      AND doc_version = 1
      AND field_type = 'name'
      AND page_number = 1
  ) <> 2 THEN
    RAISE EXCEPTION 'same-page duplicate fields were not saved';
  END IF;

  IF (
    SELECT count(*)
    FROM public.contract_field_positions
    WHERE doc_type = 'remittance'
      AND doc_version = 2
  ) <> 1 THEN
    RAISE EXCEPTION 'replacement changed another document version';
  END IF;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM public.replace_contract_field_positions(
      'remittance',
      1,
      '[
        {"field_type":"name","page_number":1,"x":30,"y_from_top":30,"width":-1,"height":20,"font_size":13}
      ]'::jsonb
    );
    RAISE EXCEPTION 'invalid replacement unexpectedly succeeded';
  EXCEPTION
    WHEN check_violation THEN NULL;
  END;

  IF (
    SELECT count(*)
    FROM public.contract_field_positions
    WHERE doc_type = 'remittance'
      AND doc_version = 1
  ) <> 2 THEN
    RAISE EXCEPTION 'failed replacement did not roll back the delete';
  END IF;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);

DO $$
BEGIN
  BEGIN
    PERFORM public.replace_contract_field_positions('remittance', 1, '[]'::jsonb);
    RAISE EXCEPTION 'non-admin replacement unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;

  IF (
    SELECT count(*)
    FROM public.contract_field_positions
    WHERE doc_type = 'remittance'
      AND doc_version = 1
  ) <> 2 THEN
    RAISE EXCEPTION 'non-admin replacement changed saved positions';
  END IF;
END;
$$;

SELECT 'PASS: duplicate contract fields, atomic rollback, and RPC authorization' AS result;
