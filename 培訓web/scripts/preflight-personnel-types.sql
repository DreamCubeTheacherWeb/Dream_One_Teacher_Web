-- ═══════════════════════════════════════════════════════════════════
-- 唯讀 preflight：正式庫套用 supabase/migrations/20261022100000_personnel_types.sql 之前執行。
-- 只有 SELECT，不改任何資料。共 6 段查詢；Supabase SQL Editor 一次只顯示最後一段的結果，
-- 請逐段選取後執行（或用 psql 整檔執行）。
--
-- 判讀（任何一項不符就「不要套用」，先回報）：
--   1. 合作狀態筆數：2026-10-22 已知 active 269、cancelled 3、NULL 3；staff／assistant／part_time／frozen 皆 0。
--   2. would_violate_status_check 必須是 0；null_status_rows 是本次會補成 active 的筆數。
--   3. NULL 狀態那幾筆：預期都已連結帳號且 role＝admin（補成 active 不會動到 public.users）。
--   4. personnel_types 欄位與兩個新約束：套用前三欄都應是 false。
--   5. 三個要改的函式：verdict 必須是「OK」。若是「不相同」代表正式庫的函式和 repo 最新定義不一樣
--      （有人在正式庫直接改過，或當初套的版本不同），本 migration 會蓋掉那個差異，不應直接套用。
--      expected_md5_after 用來在套用後重跑本檔確認（verdict 會變成「已套用」）。
--   6. instructors 上的 trigger：known_locally＝false 的 trigger 沒有在本機驗證過「補 NULL→active」的副作用，
--      有的話先看它的定義再決定。（trg_sync_instructor_name 只在改 full_name 時觸發，本次不會觸發。）
-- 預期 md5 由 scripts/verify-personnel-types.mjs 在本機暫時 PostgreSQL 套用 repo 定義後實算（X04 會比對本檔）。
-- ═══════════════════════════════════════════════════════════════════

-- 1. 合作狀態筆數
SELECT COALESCE(employment_status::text, '(NULL)') AS employment_status, count(*) AS rows
FROM public.instructors
GROUP BY 1
ORDER BY 1;

-- 2. 會違反新約束的筆數
SELECT
  count(*) FILTER (WHERE employment_status IS NOT NULL
                     AND employment_status::text NOT IN ('active', 'frozen', 'cancelled')) AS would_violate_status_check,
  count(*) FILTER (WHERE employment_status IS NULL) AS null_status_rows,
  count(*) AS total_rows
FROM public.instructors;

-- 3. 會被補成 active 的那幾筆（只列 id、是否連結帳號、帳號角色）
SELECT i.id, i.user_id IS NOT NULL AS linked, u.role AS linked_user_role
FROM public.instructors i
LEFT JOIN public.users u ON u.id = i.user_id
WHERE i.employment_status IS NULL
ORDER BY i.id;

-- 4. 新欄位／新約束是否已存在
SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'instructors' AND column_name = 'personnel_types'
  ) AS personnel_types_column_exists,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.instructors'::regclass AND conname = 'instructors_personnel_types_valid'
  ) AS personnel_types_check_exists,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.instructors'::regclass AND conname = 'instructors_employment_status_cooperation_only'
  ) AS employment_status_check_exists;

-- 5. 三個要改的函式目前的 md5(prosrc)
WITH expected(fn, expected_md5_before, expected_md5_after) AS (
  VALUES
    ('public.guard_instructor_admin_fields()', '4b4fa81750c43e4b3702d1aa2594334c', '6fd98e57970ca6ce9288132d16e11784'),
    ('private.instructor_profile_is_complete(uuid)', 'bfefc868f44ba79b6ef290989fcbe138', '2419e14e716054a5d8d341d5fd0c7406'),
    ('public.ensure_my_contract_reminder()', '9b36608b798ce589ce585c9e83c35ca2', 'fc15b8024c1c79379316921edf8b8d3e')
)
SELECT
  e.fn,
  md5(p.prosrc) AS current_md5,
  e.expected_md5_before,
  e.expected_md5_after,
  CASE
    WHEN p.oid IS NULL THEN '找不到函式：不要套用'
    WHEN md5(p.prosrc) = e.expected_md5_before THEN 'OK：與 repo 最新定義相同，可以套用'
    WHEN md5(p.prosrc) = e.expected_md5_after THEN '已套用：已是本 migration 的版本'
    ELSE '不相同：正式庫被改過，不要套用'
  END AS verdict
FROM expected e
LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.fn)
ORDER BY e.fn;

-- 6. instructors 上的 trigger（補 NULL→active 的 UPDATE 會觸發 BEFORE/AFTER UPDATE 的這些）
SELECT
  t.tgname,
  t.tgfoid::regprocedure AS trigger_function,
  t.tgenabled,
  t.tgname IN (
    'set_instructors_updated_at', 'trg_guard_instructor_role', 'trg_guard_instructor_admin_fields',
    'trg_guard_instructor_file_paths', 'trg_guard_instructor_identity_email',
    'trg_guard_instructor_locked_documents', 'trg_log_instructor_document_changes',
    'trg_sync_instructor_portal_access', 'trg_sync_instructor_name'
  ) AS known_locally
FROM pg_trigger t
WHERE t.tgrelid = 'public.instructors'::regclass
  AND NOT t.tgisinternal
ORDER BY t.tgname;
