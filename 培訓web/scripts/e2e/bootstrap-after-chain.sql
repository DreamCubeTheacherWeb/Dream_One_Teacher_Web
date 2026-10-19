-- ═══════════════════════════════════════════════════════════════════
-- 底座的第二段：repo 全部 SQL 套完之後才執行（只給 scripts/e2e 的瀏覽器測試用，不改 repo SQL）。
--
-- 1. public.users.role 的 CHECK：repo 的 supabase/setup.sql:8 建表時只允許 pending/teacher/admin，
--    之後沒有任何 migration 把 mentor 加進去，但前端與 RLS 到處用 mentor（正式庫是在版控外改過的）。
--    這裡比照資料庫層測試（scripts/verify-claim-activation-esign.mjs:400）把 mentor 補上，才能測輔導員視角。
--    這個表要等 setup.sql 建好才存在，所以不能放在 bootstrap.sql。
-- ═══════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check
  CHECK (role IN ('pending', 'teacher', 'mentor', 'admin'));

-- 2. 同一個落差也出現在 public.teacher_invites.role（supabase/setup.sql:173 只允許 pending/teacher/admin）：
--    handle_new_user 會把名單上 role='mentor' 的 Email 建成輔導員，所以名單也要能放 mentor。
ALTER TABLE public.teacher_invites DROP CONSTRAINT IF EXISTS teacher_invites_role_check;
ALTER TABLE public.teacher_invites ADD CONSTRAINT teacher_invites_role_check
  CHECK (role IN ('pending', 'teacher', 'mentor', 'admin'));
