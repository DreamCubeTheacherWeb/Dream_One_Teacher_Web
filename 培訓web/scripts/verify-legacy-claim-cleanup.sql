-- 驗證 20261020010000_drop_legacy_claim_rpcs.sql（本機暫時 PostgreSQL，不碰正式庫）：
-- 先重建 07 月舊認領物件並重現「pending 能搜尋未認領講師、能自己塞申請列」，
-- 再套 migration 兩次，確認舊函式與客戶端 INSERT 政策消失、其他物件不受影響；最後在沒有舊物件的庫再套一次。
\set ON_ERROR_STOP on
SET client_min_messages = notice;

CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE public.users (id uuid PRIMARY KEY, email text, name text, role text DEFAULT 'pending', created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.instructors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, full_name text, nickname text, email_primary text,
  phone_mobile text, id_number text, employment_status text DEFAULT 'active', instructor_role text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
GRANT SELECT, INSERT ON public.users, public.instructors TO authenticated;

SET client_min_messages = warning;
\ir ../supabase/2025_instructor_claim.sql
\ir ../supabase/2026-07-09_claim_auto_approve.sql
\ir ../supabase/2026-07-09_claim_id_and_role.sql
SET client_min_messages = notice;
GRANT SELECT, INSERT ON public.instructor_claim_requests TO authenticated;

INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'stranger@example.com'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@example.com');
INSERT INTO public.users (id, email, role) VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'stranger@example.com', 'pending'),
  ('00000000-0000-4000-8000-0000000000a2', 'admin@example.com', 'admin');
INSERT INTO public.instructors (id, full_name, email_primary, phone_mobile) VALUES
  ('10000000-0000-4000-8000-000000000001', '王小明', 'wang@example.com', '0912345678');

-- ── 收緊前：重現漏洞 ──
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', false) \gset ignored_
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public.search_unlinked_instructors('王');
  IF n <> 1 THEN RAISE EXCEPTION 'setup: expected pending to see 1 unlinked instructor, got %', n; END IF;
  INSERT INTO public.instructor_claim_requests (instructor_id, requester_user_id, requester_email)
  VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'stranger@example.com');
  RAISE NOTICE 'PASS setup: pending can search unlinked instructors and insert a claim row (vulnerability reproduced)';
END $$;
RESET ROLE;
DELETE FROM public.instructor_claim_requests;

-- ── 套用兩次（可重複執行）──
\ir ../supabase/migrations/20261020010000_drop_legacy_claim_rpcs.sql
\ir ../supabase/migrations/20261020010000_drop_legacy_claim_rpcs.sql

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('submit_claim_request', 'search_unlinked_instructors');
  IF n <> 0 THEN RAISE EXCEPTION 'legacy claim functions still exist: %', n; END IF;
  RAISE NOTICE 'PASS submit_claim_request and search_unlinked_instructors are gone (all overloads)';

  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'instructor_claim_requests' AND policyname = 'Users can create own claims') THEN
    RAISE EXCEPTION 'client INSERT policy still exists';
  END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename = 'instructor_claim_requests'
    AND policyname IN ('Users can view own claims', 'Admins manage all claims');
  IF n <> 2 THEN RAISE EXCEPTION 'expected own-read and admin policies to remain, got %', n; END IF;
  RAISE NOTICE 'PASS client INSERT policy removed; own-read and admin policies kept';

  SELECT count(*) INTO n FROM pg_proc WHERE pronamespace = 'public'::regnamespace
    AND proname IN ('approve_claim_request', 'reject_claim_request', 'admin_link_instructor', 'admin_unlink_instructor',
                    'link_my_instructor_by_email', 'find_unlinked_instructor_by_my_email', 'guard_instructor_role');
  IF n <> 7 THEN RAISE EXCEPTION 'unrelated functions were touched, % of 7 remain', n; END IF;
  RAISE NOTICE 'PASS the 7 other claim/admin functions are untouched';
END $$;

-- ── 收緊後：同一個 pending 帳號 ──
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000a1', false) \gset ignored_
DO $$
BEGIN
  BEGIN
    PERFORM public.search_unlinked_instructors('王');
    RAISE EXCEPTION 'search_unlinked_instructors is still callable';
  EXCEPTION WHEN undefined_function THEN
    RAISE NOTICE 'PASS pending can no longer call search_unlinked_instructors';
  END;
  BEGIN
    INSERT INTO public.instructor_claim_requests (instructor_id, requester_user_id, requester_email)
    VALUES ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1', 'stranger@example.com');
    RAISE EXCEPTION 'pending can still insert claim rows';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS pending can no longer insert claim rows (RLS)';
  END;
END $$;
RESET ROLE;

-- ── 沒有舊物件、沒有申請表的庫也能套 ──
CREATE DATABASE fresh_check;
\c fresh_check
\ir ../supabase/migrations/20261020010000_drop_legacy_claim_rpcs.sql
DO $$ BEGIN RAISE NOTICE 'PASS migration also runs on a database without the legacy objects'; END $$;

SELECT 'legacy claim cleanup SQL verification passed' AS result;
