-- ═══════════════════════════════════════════════════════════════════
-- 本機端到端測試用「Supabase 相容底座」（只給 scripts/e2e 使用，絕不套正式庫）
--
-- 目的：讓 repo 裡的 supabase/*.sql 與 supabase/migrations/*.sql 能在一個全新的
-- Homebrew PostgreSQL 叢集上照正式順序套用，並讓 PostgREST 以和 Supabase 相同的
-- 角色切換方式（authenticator → anon／authenticated／service_role）執行 RLS。
--
-- 盡量照 Supabase 官方定義：
--   * auth.uid()／auth.role()／auth.email()／auth.jwt() 讀 request.jwt.claims；
--   * storage.foldername()／filename()／extension() 與官方 storage-api 相同；
--   * public schema 的預設權限：新表、序列、函式自動 GRANT 給 anon、authenticated、
--     service_role（Supabase 新專案就是這樣，因此 migration 裡的 REVOKE 才有意義）。
-- 刻意不做：GoTrue、Storage API、Realtime 的服務本身（由 scripts/e2e/lib/gateway.mjs 假造）。
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

-- ── 角色 ──────────────────────────────────────────────────────────
CREATE ROLE anon NOLOGIN NOINHERIT;
CREATE ROLE authenticated NOLOGIN NOINHERIT;
CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
GRANT anon, authenticated, service_role TO authenticator;
CREATE ROLE supabase_auth_admin NOLOGIN NOINHERIT;
CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT;
CREATE ROLE dashboard_user NOLOGIN;

-- ── schema ───────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, supabase_auth_admin;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role, supabase_storage_admin;

-- Supabase 新專案的預設權限（以 postgres 身分建立的物件）
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage
  GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- Supabase 的 search_path 含 extensions
ALTER DATABASE postgres SET search_path = "$user", public, extensions;

-- ── auth：JWT 讀取函式（與 Supabase 官方定義相同） ──────────────────
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.email(), auth.jwt()
  TO PUBLIC, anon, authenticated, service_role, supabase_auth_admin;

-- ── auth.users（Supabase GoTrue 的實際欄位，觸發器與程式會用到的都在） ──
CREATE TABLE auth.users (
  instance_id uuid,
  id uuid NOT NULL PRIMARY KEY,
  aud varchar(255),
  role varchar(255),
  email varchar(255),
  encrypted_password varchar(255),
  email_confirmed_at timestamptz,
  invited_at timestamptz,
  confirmation_token varchar(255),
  confirmation_sent_at timestamptz,
  recovery_token varchar(255),
  recovery_sent_at timestamptz,
  email_change_token_new varchar(255),
  email_change varchar(255),
  email_change_sent_at timestamptz,
  last_sign_in_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_super_admin boolean,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  phone text UNIQUE DEFAULT NULL,
  phone_confirmed_at timestamptz,
  phone_change text DEFAULT '',
  phone_change_token varchar(255) DEFAULT '',
  phone_change_sent_at timestamptz,
  confirmed_at timestamptz GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
  email_change_token_current varchar(255) DEFAULT '',
  email_change_confirm_status smallint DEFAULT 0,
  banned_until timestamptz,
  reauthentication_token varchar(255) DEFAULT '',
  reauthentication_sent_at timestamptz,
  is_sso_user boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  is_anonymous boolean NOT NULL DEFAULT false
);
CREATE INDEX users_email_idx ON auth.users (email);
GRANT ALL ON auth.users TO supabase_auth_admin;

-- ── storage：buckets／objects 與輔助函式（與 storage-api 官方 migration 相同） ──
CREATE TABLE storage.buckets (
  id text NOT NULL PRIMARY KEY,
  name text NOT NULL,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  public boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit bigint,
  allowed_mime_types text[],
  owner_id text
);
CREATE UNIQUE INDEX bname ON storage.buckets USING btree (name);

CREATE TABLE storage.objects (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  bucket_id text REFERENCES storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(),
  metadata jsonb,
  path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  version text,
  owner_id text,
  user_metadata jsonb
);
CREATE UNIQUE INDEX bucketid_objname ON storage.objects USING btree (bucket_id, name);
CREATE INDEX name_prefix_search ON storage.objects (name text_pattern_ops);

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role, supabase_storage_admin;

CREATE OR REPLACE FUNCTION storage.foldername(name text)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1 : array_length(_parts, 1) - 1];
END
$$;

CREATE OR REPLACE FUNCTION storage.filename(name text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[array_length(_parts, 1)];
END
$$;

CREATE OR REPLACE FUNCTION storage.extension(name text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _parts text[];
  _filename text;
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  SELECT _parts[array_length(_parts, 1)] INTO _filename;
  RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$$;

GRANT EXECUTE ON FUNCTION storage.foldername(text), storage.filename(text), storage.extension(text)
  TO PUBLIC, anon, authenticated, service_role;

-- ── pg_cron 替身（Homebrew PostgreSQL 沒有 pg_cron；排程本身不在測試範圍） ──
-- 套 SQL 時 run 程式會把「CREATE EXTENSION IF NOT EXISTS pg_cron」換成註解，改用這裡的同名物件。
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (
  jobid bigserial PRIMARY KEY,
  schedule text NOT NULL,
  command text NOT NULL,
  nodename text NOT NULL DEFAULT 'localhost',
  nodeport integer NOT NULL DEFAULT 5432,
  database text NOT NULL DEFAULT current_database(),
  username text NOT NULL DEFAULT current_user,
  active boolean NOT NULL DEFAULT true,
  jobname text UNIQUE
);
CREATE TABLE cron.job_run_details (
  jobid bigint,
  runid bigserial PRIMARY KEY,
  job_pid integer,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v_id bigint;
BEGIN
  INSERT INTO cron.job (jobname, schedule, command)
  VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid INTO v_id;
  RETURN v_id;
END
$$;
CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (schedule, command) VALUES (schedule, command) RETURNING jobid
$$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = job_name;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'could not find valid entry for job ''%''', job_name;
  END IF;
  RETURN true;
END
$$;
REVOKE ALL ON SCHEMA cron FROM PUBLIC;
