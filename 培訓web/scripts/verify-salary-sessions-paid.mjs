#!/usr/bin/env node
// 月結匯款「匯款完成，標記為已付款」：在隔離 PostgreSQL 實跑 migration 與 RPC，斷言寫在程式裡，stdout 就是證據。
//
//   第 0 段（重現舊問題）：把被審查擋下的舊函式 mark_salary_period_paid（從 git 歷史 f907616 取出原文）套到另一個資料庫，
//     證明它會把轉帳檔沒有納入的列（異常課、缺帳號講師、管理員取消勾選的人、手動排除的課、對不到講師、匯出後才核准的晚到紀錄）
//     一起標成已付款＝永久漏匯。
//   之後各段：migration 20261022140000_mark_salary_sessions_paid.sql
//     → mark_salary_sessions_paid（只標清單內、任一不符整批取消、晚到不標、溢付不改小、批次紀錄）
//     → revert_salary_payout_batch（只還原沒被改過的列、可重跑）
//     → 權限（只有 admin、anon 無權、兩張紀錄表只有 admin 讀得到、沒有直接寫入權）、可重跑、兩人同時送。
//
// class_sessions 用 repo 裡真的建表 SQL＋migration 建（含 trg_session_anomaly、trg_class_sessions_updated_at、
// trg_guard_class_session_pricing 三個 trigger），不是手刻的假表。
// 正式庫的 SQL Editor 以「資料表擁有者（非 superuser）」身分執行，所以建好表後把擁有者換成非 superuser 的 sbadmin，
// 本次 migration 也用 sbadmin 執行；權限測試用 SET ROLE anon／authenticated + request.jwt.claims 模擬 PostgREST。
// 只連本機臨時 PostgreSQL（Unix socket，不開 TCP），不碰任何正式環境。
//
// 用法：cd 培訓web && npm run verify:salary-sessions-paid
// 注意：PostgreSQL 需要 System V 共享記憶體；在 Claude Code 的 Bash 沙盒內 initdb 會被擋
// （shmget: Operation not permitted），要在沙盒外跑（一般終端機直接跑即可）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..');
// migration 路徑可用環境變數覆蓋——只用來做「突變測試」（拿故意改壞的副本確認本腳本抓得到），平常不要設
const MIG = process.env.SESSIONS_PAID_MIGRATION_SQL || path.join(appDir, 'supabase/migrations/20261022140000_mark_salary_sessions_paid.sql');
const OLD_COMMIT = 'f907616';
const OLD_MIG_PATH = '培訓web/supabase/migrations/20261021233000_mark_salary_period_paid.sql';
const SCHEMA_MIGRATIONS = [
  '20260826105841_restore_salary_workflow.sql',
  '20261018120000_align_salary_report_with_forms.sql',
  '20261018150000_limit_instructor_salary_visibility.sql',
  '20261020150000_salary_anomaly_exact_duplicates.sql',
];

// ───────────────────────── 臨時 PostgreSQL ─────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), 'd1-sessions-paid-'));
const dataDir = path.join(dir, 'data');
const pgEnv = { ...process.env, LC_ALL: 'C', LANG: 'C', PGCLIENTENCODING: 'UTF8' };
const port = 54000 + Math.floor(Math.random() * 900);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv, ...opts });
const psqlArgs = (db, user, file) => ['-X', '-q', '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1',
  '-h', dir, '-p', String(port), '-U', user, '-d', db, '-f', file ?? '-'];

function psql(db, { sql, file, user = 'postgres' } = {}) {
  const r = sh('psql', psqlArgs(db, user, file), file ? {} : { input: sql });
  const lines = (r.stderr || '').replaceAll(repoRoot, '<repo>').split('\n');
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: lines.filter((l) => !/NOTICE:/.test(l)).join('\n').trim() };
}
function psqlAsync(db, sql, user = 'postgres') {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('psql', psqlArgs(db, user), { env: pgEnv });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({ ok: code === 0, out: out.trim(), err: err.trim(), ms: Date.now() - t0 }));
    child.stdin.end(sql);
  });
}
function must(db, sql, user) {
  const r = psql(db, { sql, user });
  if (!r.ok) throw new Error(`psql failed on ${db}: ${sql.slice(0, 160).replace(/\s+/g, ' ')}\n${r.err}`);
  return r.out;
}
function mustFile(db, file, user) {
  const r = psql(db, { file, user });
  if (!r.ok) throw new Error(`psql -f ${path.basename(file)} failed on ${db}\n${r.err}`);
  return r;
}
const roleCtx = (who) => (who.role === 'anon'
  ? '\\set VERBOSITY verbose\nSET ROLE anon;\n'
  : `\\set VERBOSITY verbose\nSET ROLE authenticated;\nSET request.jwt.claims = '${JSON.stringify({ sub: who.uid, role: 'authenticated' })}';\n`);
const asRole = (db, who, sql) => psql(db, { sql: roleCtx(who) + sql });

// ───────────────────────── 斷言 ─────────────────────────
let passCount = 0;
let failCount = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) {
    passCount += 1;
    console.log(`PASS  ${name}${detail ? `  [${detail}]` : ''}`);
  } else {
    failCount += 1;
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
  }
}
function section(title) { console.log(`\n== ${title} ==`); }
function step(name, fn) {
  return Promise.resolve().then(fn).catch((error) => check(`${name}（執行中斷）`, false, error.message));
}
const deniedMsg = (r) => !r.ok && /permission denied/i.test(r.err);
const sqlstate = (r, code) => !r.ok && new RegExp(`ERROR:\\s+${code}:`).test(r.err);
const firstLine = (s) => (s || '').split('\n').find((l) => /ERROR/.test(l)) || (s || '').split('\n')[0];

// ───────────────────────── 共用 bootstrap（模擬 Supabase） ─────────────────────────
const BOOT = `
CREATE SCHEMA auth;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, sbadmin;
GRANT REFERENCES, SELECT ON auth.users TO sbadmin;
GRANT USAGE ON SCHEMA public TO authenticated, anon;
GRANT USAGE, CREATE ON SCHEMA public TO sbadmin;
-- 與 Supabase 相同：之後在 public 建的表／函式／序列預設把全部權限給 anon／authenticated（SQL 必須自己 REVOKE）
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sbadmin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sbadmin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sbadmin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE TYPE public.instructor_role_enum AS ENUM ('S', 'A+', 'A', 'B', '實習');
CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY users_select_own ON public.users FOR SELECT TO authenticated USING (id = auth.uid());
GRANT SELECT ON public.users TO authenticated;
CREATE TABLE public.instructors (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid UNIQUE REFERENCES auth.users(id),
  full_name text NOT NULL,
  instructor_role public.instructor_role_enum,
  speed_qualification text,
  employment_status text DEFAULT 'active'
);
GRANT SELECT ON public.instructors TO authenticated;
-- PostgreSQL 16 不接受 to_char 當衍生欄位；用 IMMUTABLE 包一層，讓 month_label 仍是衍生欄位
CREATE FUNCTION public._month_label(d date) RETURNS text IMMUTABLE LANGUAGE sql AS $$ SELECT to_char(d, 'YYYY/MM') $$;
`;

const U = {
  teacher: '00000000-0000-4000-8000-000000000001',
  mentor: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003',
  admin2: '00000000-0000-4000-8000-000000000004',
  pending: '00000000-0000-4000-8000-000000000005',
  ghost: '00000000-0000-4000-8000-000000000006', // 有登入帳號但 public.users 沒有對應列
};
const I1 = '10000000-0000-4000-8000-000000000001';  // 資料齊全
const I2 = '10000000-0000-4000-8000-000000000002';  // 資料齊全
const I3 = '10000000-0000-4000-8000-000000000003';  // 缺收款帳號 → 轉帳檔擋下
const I4 = '10000000-0000-4000-8000-000000000004';  // 管理員在月結匯款頁取消勾選
const authed = (uid) => ({ role: 'authenticated', uid });
const ANON = { role: 'anon' };

// 目標期別 P＝2026-08-26～2026-09-25（9 月期，一定已結束）；Q＝2026-07-26～2026-08-25（8 月期，給「同時送」用）
// key → [session_date, status, pricing_status, base_salary, bonus, paid_amount, 講師, source]
const ROWS = {
  f_start: ['2026-08-26', 'approved', 'legacy', 1000, 0, 0, I1, 'manual'],          // 檔案內：P 起點（26 日）
  f_bonus: ['2026-09-10', 'approved', 'legacy', 800, 50, 0, I1, 'self_report'],     // 檔案內：有獎金 850
  f_partial: ['2026-09-12', 'approved', 'manual_override', 600, 0, 100, I1, 'manual'], // 檔案內：先付過 100 → 本次應付 500
  f_over: ['2026-09-14', 'approved', 'legacy', 300, 0, 500, I1, 'manual'],          // 檔案內：已領 500 > 總額 300 → 本次應付 0
  f_other: ['2026-09-01', 'approved', 'legacy', 1200, 0, 0, I2, 'manual'],          // 檔案內：別的講師
  f_quoted: ['2026-09-20', 'approved', 'quoted', 450, 0, 0, I1, 'self_report'],     // 檔案內：自動試算
  f_dup1: ['2026-09-18', 'approved', 'legacy', 200, 0, 0, I2, 'manual'],            // 檔案內：一模一樣兩筆中先登記（沒標異常）那筆
  f_end: ['2026-09-25', 'approved', 'legacy', 300, 0, 0, I1, 'historical_import'],  // 檔案內：P 終點（25 日）
  x_dup2: ['2026-09-18', 'approved', 'legacy', 200, 0, 0, I2, 'manual'],            // 排除：異常標記（疑似重複）預設排除
  x_noacct: ['2026-09-03', 'approved', 'legacy', 900, 0, 0, I3, 'manual'],          // 排除：缺帳號講師被擋
  x_person: ['2026-09-04', 'approved', 'legacy', 700, 0, 0, I4, 'manual'],          // 排除：管理員取消勾選的人
  x_session: ['2026-09-05', 'approved', 'legacy', 650, 0, 0, I1, 'manual'],         // 排除：管理員手動排除的課
  x_unmatched: ['2026-09-06', 'approved', 'legacy', 350, 0, 0, null, 'manual'],     // 排除：對不到講師
  x_pending: ['2026-09-15', 'pending', 'legacy', 700, 0, 0, I1, 'self_report'],     // 待核准
  x_review: ['2026-09-16', 'pending', 'needs_review', null, 0, 0, I1, 'self_report'], // 待定價
  x_paid: ['2026-09-07', 'paid', 'legacy', 900, 0, 900, I1, 'historical_import'],   // 已付款
  x_after: ['2026-09-26', 'approved', 'legacy', 4000, 0, 0, I1, 'manual'],          // 下一期起點
  q_start: ['2026-07-26', 'approved', 'legacy', 210, 0, 0, I1, 'manual'],           // Q 起點
  q_mid: ['2026-08-10', 'approved', 'legacy', 320, 0, 0, I2, 'manual'],
  q_end: ['2026-08-25', 'approved', 'legacy', 5000, 0, 0, I1, 'manual'],            // Q 終點＝P 前一天
};
// 匯出之後才核准的晚到紀錄（P 期內）：不在轉帳檔裡
const LATE = ['2026-09-22', 'approved', 'legacy', 450, 0, 0, I1, 'manual'];
const idOf = (key) => (key === 'x_late'
  ? '20000000-0000-4000-8000-000000000999'
  : `20000000-0000-4000-8000-${String(Object.keys(ROWS).indexOf(key) + 1).padStart(12, '0')}`);
const idList = (keys) => keys.map((k) => `'${idOf(k)}'`).join(',');
const FILE = { f_start: 1000, f_bonus: 850, f_partial: 500, f_over: 0, f_other: 1200, f_quoted: 450, f_dup1: 200, f_end: 300 };
const FILE_KEYS = Object.keys(FILE);
const FILE_TOTAL = Object.values(FILE).reduce((a, b) => a + b, 0); // 4500
const EXCLUDED_KEYS = ['x_dup2', 'x_noacct', 'x_person', 'x_session', 'x_unmatched', 'x_late'];
const Q_FILE = { q_start: 210, q_mid: 320, q_end: 5000 };

const DB = 'pp';
const DB_OLD = 'old';
const FN_MARK = 'public.mark_salary_sessions_paid(date, date, jsonb, numeric, date, numeric, jsonb)';
const FN_REVERT = 'public.revert_salary_payout_batch(bigint)';
const itemsJson = (entries) => JSON.stringify(Object.entries(entries).map(([key, amount]) => ({ id: idOf(key), amount })));
const sqlText = (s) => `'${String(s).replaceAll("'", "''")}'`;
const mark = (start, end, items, expected, { payDate = 'NULL', transfer = 'NULL', adjustments = "'[]'::jsonb" } = {}) => (
  `SELECT public.mark_salary_sessions_paid(${start}, ${end}, ${items}, ${expected}, ${payDate}, ${transfer}, ${adjustments})::text;`
);
const markP = (entries, expected = Object.values(entries).reduce((a, b) => a + b, 0), extra) => mark(
  "DATE '2026-08-26'", "DATE '2026-09-25'", `${sqlText(itemsJson(entries))}::jsonb`, expected, extra,
);
const revert = (id) => `SELECT public.revert_salary_payout_batch(${id})::text;`;
const parse = (r) => { try { return JSON.parse(r.out.split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return null; } };
const rowsMd5 = (db, keys) => must(db, `SELECT md5(string_agg(to_jsonb(cs)::text, E'\\n' ORDER BY id)) FROM public.class_sessions cs WHERE id IN (${idList(keys)})`);
const tableMd5 = (db = DB) => must(db, `SELECT md5(string_agg(to_jsonb(cs)::text, E'\\n' ORDER BY id)) FROM public.class_sessions cs`);
const auditMd5 = () => must(DB, `SELECT md5(COALESCE((SELECT string_agg(to_jsonb(b)::text, E'\\n' ORDER BY id) FROM public.salary_payout_batches b), '')
  || COALESCE((SELECT string_agg(to_jsonb(i)::text, E'\\n' ORDER BY batch_id, session_id) FROM public.salary_payout_batch_items i), ''))`);
const statusOf = (db, key) => must(db, `SELECT status || '|' || paid_amount || '|' || total_salary FROM public.class_sessions WHERE id = '${idOf(key)}'`);
const batchCount = () => Number(must(DB, 'SELECT count(*) FROM public.salary_payout_batches'));

function seed(db) {
  must(db, BOOT);
  const base = readFileSync(path.join(appDir, 'supabase/2025_salary_system.sql'), 'utf8');
  const target = "to_char(session_date, 'YYYY/MM')";
  if (!base.includes(target)) throw new Error('month_label expression not found');
  const basePath = path.join(dir, `base-${db}.sql`);
  writeFileSync(basePath, base.replace(target, 'public._month_label(session_date)'));
  mustFile(db, basePath);
  for (const file of SCHEMA_MIGRATIONS) mustFile(db, path.join(appDir, 'supabase/migrations', file));
  must(db, `ALTER TABLE public.class_sessions OWNER TO sbadmin; ALTER TABLE public.users OWNER TO sbadmin;
    ALTER TABLE public.instructors OWNER TO sbadmin; ALTER TABLE public.salary_rate_card OWNER TO sbadmin;`);
  must(db, `
    INSERT INTO auth.users (id, email) VALUES
      ('${U.teacher}', 'teacher@test.local'), ('${U.mentor}', 'mentor@test.local'),
      ('${U.admin}', 'admin@test.local'), ('${U.admin2}', 'admin2@test.local'),
      ('${U.pending}', 'pending@test.local'), ('${U.ghost}', 'ghost@test.local');
    INSERT INTO public.users (id, name, email, role) VALUES
      ('${U.teacher}', '講師', 'teacher@test.local', 'teacher'), ('${U.mentor}', '導師', 'mentor@test.local', 'mentor'),
      ('${U.admin}', '管理員一', 'admin@test.local', 'admin'), ('${U.admin2}', '管理員二', 'admin2@test.local', 'admin'),
      ('${U.pending}', '待審', 'pending@test.local', 'pending');
    INSERT INTO public.instructors (id, user_id, full_name, instructor_role) VALUES
      ('${I1}', '${U.teacher}', '測試講師一', 'A'), ('${I2}', NULL, '測試講師二', 'B'),
      ('${I3}', NULL, '缺帳號講師', 'B'), ('${I4}', NULL, '取消勾選講師', 'B');
    INSERT INTO public.salary_rate_card (id, course_type, pricing_mode, rate)
      VALUES ('30000000-0000-4000-8000-000000000001', 'regular_basic', 'hourly', 300);
  `);
  insertRows(db, Object.entries(ROWS));
  must(db, `
    ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;
    ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
    UPDATE public.class_sessions SET updated_at = TIMESTAMPTZ '2026-10-01 09:00+08';
    ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
    ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;`);
}
const NAMES = { [I1]: '測試講師一', [I2]: '測試講師二', [I3]: '缺帳號講師', [I4]: '取消勾選講師' };
function insertRows(db, entries) {
  const values = entries.map(([key, [date, status, pricing, base, bonus, paid, inst, source]]) => `(
    '${idOf(key)}', 'regular_basic', '同一堂課', ${inst ? `'${inst}'` : 'NULL'}, '${inst ? NAMES[inst] : '對不到測試'}', DATE '${date}', 1.5, 3,
    ${base === null ? 'NULL' : base}, ${bonus}, ${paid}, '${status}'::public.session_status_enum, '${pricing}', '${source}',
    ${pricing === 'quoted' ? "'30000000-0000-4000-8000-000000000001'::uuid, now()" : 'NULL, NULL'},
    ${pricing === 'manual_override' ? "'測試人工調整'" : 'NULL'},
    ${status === 'paid' ? "TIMESTAMPTZ '2026-09-30 10:00+08'" : 'NULL'}
  )`).join(',\n');
  must(db, `INSERT INTO public.class_sessions (id, course_type, course_name, instructor_id, instructor_name, session_date,
      duration_hours, student_count, base_salary, bonus, paid_amount, status, pricing_status, source,
      rate_card_id, pricing_quoted_at, manual_adjustment_reason, paid_at)
    VALUES ${values};`);
}

let postgres;
let postgresLogs = '';
const startedAt = Date.now();

try {
  const init = sh('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  if (init.status !== 0) throw new Error(`initdb failed\n${init.stdout}${init.stderr}`);
  postgres = spawn('postgres', ['-D', dataDir, '-k', dir, '-p', String(port), '-c', 'listen_addresses=', '-c', 'fsync=off'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: pgEnv,
  });
  postgres.stdout.on('data', (c) => { postgresLogs += c.toString(); });
  postgres.stderr.on('data', (c) => { postgresLogs += c.toString(); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = sh('pg_isready', ['-h', dir, '-p', String(port), '-U', 'postgres']);
    if (probe.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`temporary PostgreSQL did not become ready\n${postgresLogs}`);
  must('postgres', `CREATE ROLE sbadmin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE DATABASE ${DB}; CREATE DATABASE ${DB_OLD};`);

  // ════════ 0. 重現舊問題 ════════
  section(`0. 重現舊問題：被擋下的舊函式 mark_salary_period_paid（git ${OLD_COMMIT}）把轉帳檔沒納入的列也標成已付款`);
  await step('O old behaviour', () => {
    seed(DB_OLD);
    insertRows(DB_OLD, [['x_late', LATE]]);
    const old = spawnSync('git', ['-c', 'core.quotepath=false', 'show', `${OLD_COMMIT}:${OLD_MIG_PATH}`], { cwd: repoRoot, encoding: 'utf8' });
    if (old.status !== 0) throw new Error(`git show failed: ${old.stderr}`);
    const oldPath = path.join(dir, 'old-mark-salary-period-paid.sql');
    writeFileSync(oldPath, old.stdout);
    check('O1 從 git 歷史取出舊 migration 原文並套用成功', psql(DB_OLD, { file: oldPath, user: 'sbadmin' }).ok);
    const r = asRole(DB_OLD, authed(U.admin), "SELECT public.mark_salary_period_paid(DATE '2026-08-26', DATE '2026-09-25')::text;");
    const result = parse(r);
    const expectedOld = FILE_KEYS.length + EXCLUDED_KEYS.length;
    check(`O2 舊函式一次標了 ${expectedOld} 筆（轉帳檔只有 ${FILE_KEYS.length} 筆）`, r.ok && result?.marked_count === expectedOld, r.err || r.out);
    const leaked = EXCLUDED_KEYS.filter((key) => statusOf(DB_OLD, key).startsWith('paid|'));
    check('O3 問題重現：異常課、缺帳號講師、取消勾選的人、手動排除的課、對不到講師、匯出後才核准的晚到紀錄，全部被標成已付款',
      leaked.length === EXCLUDED_KEYS.length, `被標成已付款：${leaked.join(',')}`);
    const unpaid = Number(must(DB_OLD, "SELECT count(*) FROM public.class_sessions WHERE status = 'approved' AND session_date BETWEEN '2026-08-26' AND '2026-09-25'"));
    check('O4 問題重現：標完後這一期已核准未付款剩 0 筆 → 下次匯款檔再也看不到這些沒匯的錢（永久漏匯）', unpaid === 0, `剩 ${unpaid} 筆`);
  });

  // ════════ 新版 ════════
  section('bootstrap：repo 的建表 SQL＋migration 建 class_sessions');
  await step('S bootstrap', () => {
    seed(DB);
    const triggers = must(DB, `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal`);
    check('S1 class_sessions 用 repo SQL 建好，有 3 個 trigger（anomaly／guard pricing／updated_at）',
      triggers === 'trg_class_sessions_updated_at,trg_guard_class_session_pricing,trg_session_anomaly', triggers);
    const flags = must(DB, `SELECT string_agg(is_anomaly::text, ',' ORDER BY id) FROM public.class_sessions WHERE id IN (${idList(['f_dup1', 'x_dup2'])})`);
    check('S2 一模一樣的兩筆：先登記那筆沒標異常、後登記那筆有標（轉帳檔預設排除異常那筆）', flags === 'false,true', flags);
    // 模擬舊函式曾被套進這個資料庫：新 migration 要把它移除
    must(DB, `CREATE FUNCTION public.mark_salary_period_paid(p_period_start date, p_period_end date, p_expected_count integer DEFAULT NULL, p_expected_amount numeric DEFAULT NULL)
      RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.mark_salary_period_paid(p_period_start date, p_period_end date) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`, 'sbadmin');
  });

  section('migration 20261022140000_mark_salary_sessions_paid.sql');
  await step('M1 apply twice', () => {
    const r1 = psql(DB, { file: MIG, user: 'sbadmin' });
    check('M1a migration 第一次套用成功（非 superuser 表擁有者身分）', r1.ok, r1.err);
    const r2 = psql(DB, { file: MIG, user: 'sbadmin' });
    check('M1b migration 連續第二次套用成功（可重跑）', r2.ok, r2.err);
    check('M1c 舊的「整期一起標」函式 mark_salary_period_paid 兩個版本都被移除',
      must(DB, "SELECT count(*) FROM pg_proc WHERE proname = 'mark_salary_period_paid'") === '0');
    check('M1d 新函式各只有一個版本',
      must(DB, "SELECT string_agg(proname || '/' || pronargs, ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('mark_salary_sessions_paid', 'revert_salary_payout_batch')")
        === 'mark_salary_sessions_paid/7,revert_salary_payout_batch/1');
  });

  await step('M2 catalog', () => {
    const q = (s) => must(DB, s);
    for (const fn of [FN_MARK, FN_REVERT]) {
      const short = fn.split('(')[0].replace('public.', '');
      check(`M2a ${short}：SECURITY DEFINER、擁有者 sbadmin（非 superuser）`,
        q(`SELECT prosecdef || '|' || pg_get_userbyid(proowner) FROM pg_proc WHERE oid = '${fn}'::regprocedure`) === 'true|sbadmin');
      check(`M2b ${short}：search_path 固定為空字串`, q(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${fn}'::regprocedure`) === 'search_path=""');
      check(`M2c ${short}：anon 不能執行`, q(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')`) === 'f');
      const acl = q(`SELECT proacl::text FROM pg_proc WHERE oid = '${fn}'::regprocedure`);
      check(`M2d ${short}：PUBLIC 沒有執行權（ACL 裡沒有 =X/）`, !/(^|[{,])=X\//.test(acl), acl);
      check(`M2e ${short}：authenticated 可以呼叫（是否 admin 由函式內檢查）`, q(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE')`) === 't');
    }
    for (const table of ['salary_payout_batches', 'salary_payout_batch_items']) {
      check(`M3a ${table}：RLS 已啟用`, q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${table}'::regclass`) === 't');
      check(`M3b ${table}：anon 沒有任何權限`,
        q(`SELECT bool_or(has_table_privilege('anon', 'public.${table}', p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`) === 'f');
      check(`M3c ${table}：authenticated 只有 SELECT（沒有 INSERT／UPDATE／DELETE）`,
        q(`SELECT string_agg(p, ',') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege('authenticated', 'public.${table}', p)`) === 'SELECT');
    }
    const seq = q("SELECT pg_get_serial_sequence('public.salary_payout_batches', 'id')");
    check('M3d 批次編號序列：anon／authenticated 都不能用（不能自己 nextval）',
      q(`SELECT has_sequence_privilege('anon', '${seq}', 'USAGE') OR has_sequence_privilege('authenticated', '${seq}', 'USAGE')`) === 'f', seq);
  });

  section('權限：只有 admin');
  await step('R non-admin', () => {
    const before = tableMd5();
    const a1 = asRole(DB, ANON, markP(FILE));
    check('R1 anon 呼叫標記被拒（permission denied for function）', deniedMsg(a1), firstLine(a1.err));
    const a2 = asRole(DB, ANON, revert(1));
    check('R2 anon 呼叫還原被拒（permission denied for function）', deniedMsg(a2), firstLine(a2.err));
    for (const [label, uid] of [['teacher', U.teacher], ['mentor', U.mentor], ['pending', U.pending], ['ghost（沒有 users 列）', U.ghost]]) {
      const r = asRole(DB, authed(uid), markP(FILE));
      check(`R3 ${label} 標記 → 42501「只有管理員可以標記已付款。」`, sqlstate(r, '42501') && /只有管理員可以標記已付款/.test(r.err), firstLine(r.err) || r.out);
      const v = asRole(DB, authed(uid), revert(1));
      check(`R4 ${label} 還原 → 42501`, sqlstate(v, '42501'), firstLine(v.err) || v.out);
    }
    const ins = asRole(DB, authed(U.admin), "INSERT INTO public.salary_payout_batches (period_start, period_end, item_count, total_amount) VALUES ('2026-08-26', '2026-09-25', 1, 1);");
    check('R5 admin 也不能直接寫批次紀錄表（只能經函式）', deniedMsg(ins), firstLine(ins.err));
    check('R6 以上被拒之後整張表完全沒變（含 updated_at）、沒有任何批次紀錄', tableMd5() === before && batchCount() === 0);
  });

  section('參數檢查（admin 也擋，22023，什麼都不改）');
  await step('V validation', () => {
    const before = tableMd5();
    const P = ["DATE '2026-08-26'", "DATE '2026-09-25'"];
    const items = `${sqlText(itemsJson(FILE))}::jsonb`;
    const one = (obj) => `${sqlText(JSON.stringify(obj))}::jsonb`;
    const id1 = idOf('f_start');
    const cases = [
      ['起日 NULL', mark('NULL', P[1], items, FILE_TOTAL), /期間起訖日不正確/],
      ['迄日早於起日', mark(P[1], P[0], items, FILE_TOTAL), /期間起訖日不正確/],
      ['區間 32 天（比最長的一期多一天）', mark("DATE '2026-01-25'", "DATE '2026-02-25'", items, FILE_TOTAL), /一次只能標記一期/],
      ['迄日＝台北今天（這期還沒結束）', mark("(now() AT TIME ZONE 'Asia/Taipei')::date - 20", "(now() AT TIME ZONE 'Asia/Taipei')::date", items, FILE_TOTAL), /結束後才能標記已付款/],
      ['清單 NULL', mark(P[0], P[1], 'NULL', 0), /沒有要標記的紀錄/],
      ['清單是空陣列', mark(P[0], P[1], "'[]'::jsonb", 0), /沒有要標記的紀錄/],
      ['清單不是陣列', mark(P[0], P[1], one({ id: id1, amount: 1000 }), 1000), /沒有要標記的紀錄/],
      ['id 不是 uuid', mark(P[0], P[1], one([{ id: 'abc', amount: 1000 }]), 1000), /清單格式不正確（1 筆）/],
      ['金額是字串', mark(P[0], P[1], one([{ id: id1, amount: '1000' }]), 1000), /清單格式不正確/],
      ['金額負數', mark(P[0], P[1], one([{ id: id1, amount: -1 }]), -1), /清單格式不正確/],
      ['金額三位小數', mark(P[0], P[1], one([{ id: id1, amount: 1000.001 }]), 1000.001), /清單格式不正確/],
      ['同一筆出現兩次', mark(P[0], P[1], one([{ id: id1, amount: 1000 }, { id: id1, amount: 1000 }]), 2000), /清單裡有重複的紀錄/],
      ['確認金額與清單合計不同', mark(P[0], P[1], items, FILE_TOTAL - 1), /清單金額合計（\$4,500）與確認金額（\$4,499）不同/],
      ['確認金額 NULL', mark(P[0], P[1], items, 'NULL'), /與確認金額（\$\?）不同/],
      ['人工調整不是陣列', mark(P[0], P[1], items, FILE_TOTAL, { adjustments: "'{}'::jsonb" }), /人工調整紀錄格式不正確/],
    ];
    for (const [label, sql, pattern] of cases) {
      const r = asRole(DB, authed(U.admin), sql);
      check(`V ${label} → 22023`, sqlstate(r, '22023') && pattern.test(r.err), firstLine(r.err) || r.out);
    }
    const hnl = asRole(DB, authed(U.admin), `SET TIME ZONE 'Pacific/Honolulu';\n${mark("(now() AT TIME ZONE 'Asia/Taipei')::date - 20", "(now() AT TIME ZONE 'Asia/Taipei')::date", items, FILE_TOTAL)}`);
    check('V 連線時區是檀香山也照台北日期判斷（迄日＝台北今天仍擋）', sqlstate(hnl, '22023'), firstLine(hnl.err) || hnl.out);
    check('V 以上全部被擋：整張表完全沒變、沒有任何批次紀錄', tableMd5() === before && batchCount() === 0);
  });

  section('清單和資料庫不符 → 整批取消（ok=false，逐筆列原因，什麼都不改）');
  await step('E mismatch', () => {
    const before = tableMd5();
    const cases = [
      ['清單混進待核准的列', { ...FILE, x_pending: 700 }, 'status', /狀態已不是「已核准」（現在：待核准）/],
      ['清單混進已付款的列', { ...FILE, x_paid: 0 }, 'status', /現在：已付款/],
      ['清單混進別期的列（9/26）', { ...FILE, x_after: 4000 }, 'period', /日期 2026-09-26 不在這一期/],
      ['清單混進對不到講師的列', { ...FILE, x_unmatched: 350 }, 'no_instructor', /沒有連到講師主檔/],
      ['某一筆金額和現在不同（下載後被改價）', { ...FILE, f_start: 999 }, 'amount', /應付金額已變動（下載時 \$999，現在 \$1,000）/],
      ['某一筆已不存在', { ...FILE, ghost: 100 }, 'not_found', /找不到這筆紀錄/],
    ];
    for (const [label, entries, reason, pattern] of cases) {
      const items = Object.entries(entries).map(([key, amount]) => ({ id: key === 'ghost' ? '20000000-0000-4000-8000-00000000dead' : idOf(key), amount }));
      const total = items.reduce((sum, item) => sum + item.amount, 0);
      const r = asRole(DB, authed(U.admin), mark("DATE '2026-08-26'", "DATE '2026-09-25'", `${sqlText(JSON.stringify(items))}::jsonb`, total));
      const result = parse(r);
      const hit = result?.mismatches?.[0];
      check(`E ${label} → ok=false、1 筆不符（${reason}）、0 筆標記`,
        r.ok && result?.ok === false && result?.marked_count === 0 && result?.mismatch_count === 1 && hit?.reason === reason && pattern.test(hit?.message || ''),
        r.err || r.out);
    }
    const multi = asRole(DB, authed(U.admin), markP({ ...FILE, x_pending: 700, x_after: 4000, f_bonus: 1 }));
    const m = parse(multi);
    check('E 一次有 3 筆不符：3 筆都列出來（照清單順序），每筆附講師、日期、目前金額',
      m?.ok === false && m?.mismatch_count === 3 && m.mismatches.map((x) => x.reason).join(',') === 'amount,status,period'
        && m.mismatches[0].instructor_name === '測試講師一' && m.mismatches[0].session_date === '2026-09-10' && Number(m.mismatches[0].current_amount) === 850,
      multi.err || multi.out);
    check('E 以上全部整批取消：整張表完全沒變（含 updated_at）、沒有任何批次紀錄', tableMd5() === before && batchCount() === 0);
    check('E 不符的呼叫結束後沒有殘留鎖（另一個連線可以馬上改這些列）',
      must(DB, `SET lock_timeout = '1s'; BEGIN; UPDATE public.class_sessions SET notes = notes WHERE id IN (${idList(FILE_KEYS)}); ROLLBACK; SELECT 'ok';`).endsWith('ok'));
  });

  let batch1;
  let paidAt1;
  section('admin 標記 9 月期這份轉帳檔（8 筆、課程應付 $4,500）；匯出後又核准了一筆晚到的');
  await step('A mark', () => {
    insertRows(DB, [['x_late', LATE]]);  // 匯出之後才核准：不在轉帳檔裡
    must(DB, `ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;
      UPDATE public.class_sessions SET updated_at = TIMESTAMPTZ '2026-10-01 09:00+08' WHERE id = '${idOf('x_late')}';
      ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;`);
    const untouchedKeys = [...Object.keys(ROWS).filter((k) => !FILE_KEYS.includes(k)), 'x_late'];
    const untouchedBefore = rowsMd5(DB, untouchedKeys);
    const adjustments = JSON.stringify([{ instructor_id: I1, name: '測試講師一', amount: -500, reason: '扣回上期溢付' }]);
    const r = asRole(DB, authed(U.admin), markP(FILE, FILE_TOTAL, { payDate: "DATE '2026-10-10'", transfer: FILE_TOTAL - 500, adjustments: `${sqlText(adjustments)}::jsonb` }));
    const result = parse(r);
    batch1 = result?.batch_id;
    paidAt1 = result?.paid_at;
    check(`A1 回傳 ok、批次編號、${FILE_KEYS.length} 筆、$${FILE_TOTAL}`, r.ok && result?.ok === true && Number.isInteger(batch1)
      && result?.marked_count === FILE_KEYS.length && Number(result?.marked_amount) === FILE_TOTAL, r.err || r.out);
    const marked = must(DB, `SELECT count(*) FILTER (WHERE status = 'paid') || '|' || count(DISTINCT paid_at) || '|' || bool_and(updated_at > TIMESTAMPTZ '2026-10-01 09:00+08')
        || '|' || bool_and(paid_at = '${paidAt1}'::timestamptz)
      FROM public.class_sessions WHERE id IN (${idList(FILE_KEYS)})`);
    check('A2 清單內 8 筆都變成已付款、paid_at 同一個時間（＝回傳的 paid_at）、updated_at 有更新', marked === '8|1|true|true', marked);
    check('A3 一般列：已領＝總額（有獎金那筆 850）', statusOf(DB, 'f_bonus') === 'paid|850.00|850.00' && statusOf(DB, 'f_start') === 'paid|1000.00|1000.00',
      `${statusOf(DB, 'f_bonus')} / ${statusOf(DB, 'f_start')}`);
    check('A4 先付過 100 的那筆：已領改成總額 600（本次匯 500＝付清）', statusOf(DB, 'f_partial') === 'paid|600.00|600.00', statusOf(DB, 'f_partial'));
    check('A5 已領 500 超過總額 300 的那筆：已領維持 500，沒有被改小', statusOf(DB, 'f_over') === 'paid|500.00|300.00', statusOf(DB, 'f_over'));
    check('A6 轉帳檔沒納入的列（異常課、缺帳號講師、取消勾選的人、手動排除的課、對不到講師、晚到的已核准）與其他期別、待核准、已付款的列：整列（含 updated_at）完全沒變',
      rowsMd5(DB, untouchedKeys) === untouchedBefore);
    check('A7 晚到的已核准那筆仍是「已核准」，下次匯款檔會出現', statusOf(DB, 'x_late') === 'approved|0.00|450.00', statusOf(DB, 'x_late'));
    const batch = must(DB, `SELECT period_start || '|' || period_end || '|' || item_count || '|' || total_amount || '|' || pay_date || '|' || transfer_total
        || '|' || marked_by || '|' || marked_by_name || '|' || (marked_at = '${paidAt1}'::timestamptz) || '|' || (adjustments -> 0 ->> 'reason') || '|' || reverted_count
      FROM public.salary_payout_batches WHERE id = ${batch1}`);
    check('A8 批次紀錄：期別、8 筆、$4,500、付款日、轉帳檔總額 $4,000、誰（id＋姓名）、何時、人工調整原因、尚未還原',
      batch === `2026-08-26|2026-09-25|8|4500.00|2026-10-10|4000.00|${U.admin}|管理員一|true|扣回上期溢付|0`, batch);
    const items = must(DB, `SELECT string_agg(s.k || ':' || i.amount || ':' || i.old_status || ':' || i.old_paid_amount || ':' || COALESCE(i.old_paid_at::text, '-') || ':' || i.new_paid_amount
          || ':' || (i.new_updated_at = cs.updated_at), ',' ORDER BY s.k)
      FROM public.salary_payout_batch_items i
      JOIN public.class_sessions cs ON cs.id = i.session_id
      JOIN (VALUES ${FILE_KEYS.map((k) => `('${idOf(k)}'::uuid, '${k}')`).join(',')}) AS s(id, k) ON s.id = i.session_id
      WHERE i.batch_id = ${batch1}`);
    const expectedItems = ['f_bonus:850.00:approved:0.00:-:850.00:true', 'f_dup1:200.00:approved:0.00:-:200.00:true', 'f_end:300.00:approved:0.00:-:300.00:true',
      'f_other:1200.00:approved:0.00:-:1200.00:true', 'f_over:0.00:approved:500.00:-:500.00:true', 'f_partial:500.00:approved:100.00:-:600.00:true',
      'f_quoted:450.00:approved:0.00:-:450.00:true', 'f_start:1000.00:approved:0.00:-:1000.00:true'].join(',');
    check('A9 每列批次明細：當時應付、舊狀態／舊已領／舊付款時間、新已領、標完當下的 updated_at', items === expectedItems, items);
    check('A10 三個 trigger 仍是啟用狀態（函式沒有停用 trigger）',
      must(DB, `SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal`) === 'OOO');
  });

  section('紀錄表只有 admin 讀得到');
  await step('L read access', () => {
    const t = asRole(DB, authed(U.teacher), 'SELECT count(*) FROM public.salary_payout_batches; SELECT count(*) FROM public.salary_payout_batch_items;');
    check('L1 講師查兩張表都是 0 筆（RLS 擋掉）', t.ok && t.out.split('\n').join(',') === '0,0', t.err || t.out);
    const m = asRole(DB, authed(U.mentor), 'SELECT count(*) FROM public.salary_payout_batches;');
    check('L2 輔導員查批次表 0 筆', m.ok && m.out === '0', m.err || m.out);
    const a = asRole(DB, ANON, 'SELECT count(*) FROM public.salary_payout_batches;');
    check('L3 anon 查批次表被拒（permission denied）', deniedMsg(a), firstLine(a.err));
    const ad = asRole(DB, authed(U.admin), 'SELECT count(*) FROM public.salary_payout_batches; SELECT count(*) FROM public.salary_payout_batch_items;');
    check('L4 admin 看得到 1 批、8 筆明細', ad.ok && ad.out.split('\n').join(',') === '1,8', ad.err || ad.out);
  });

  section('重送同一份清單（已標過）→ 整批取消');
  await step('B rerun', () => {
    const before = tableMd5();
    const audit = auditMd5();
    const r = asRole(DB, authed(U.admin), markP(FILE));
    const result = parse(r);
    check('B1 同一份再送一次 → ok=false、8 筆都是「現在：已付款」、0 筆標記',
      r.ok && result?.ok === false && result?.mismatch_count === 8 && result.mismatches.every((x) => x.reason === 'status'), r.err || r.out);
    check('B2 整張表與批次紀錄完全沒變（沒有多一批）', tableMd5() === before && auditMd5() === audit);
  });

  section('兩位管理員同時送 8 月期同一份清單（3 筆、$5,530）');
  await step('C concurrent', async () => {
    const qSql = mark("DATE '2026-07-26'", "DATE '2026-08-25'", `${sqlText(itemsJson(Q_FILE))}::jsonb`, 5530);
    const first = psqlAsync(DB, `${roleCtx(authed(U.admin))}BEGIN;\n${qSql}\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await psqlAsync(DB, roleCtx(authed(U.admin2)) + qSql);
    const firstResult = await first;
    const a = JSON.parse(firstResult.out.split('\n').find((l) => l.startsWith('{')) || 'null');
    const b = JSON.parse(second.out.split('\n').find((l) => l.startsWith('{')) || 'null');
    check('C1 先送的那位標到 3 筆、$5,530', firstResult.ok && a?.ok === true && a?.marked_count === 3 && Number(a?.marked_amount) === 5530, firstResult.err || firstResult.out);
    check('C2 後送的那位等前一位完成後 → ok=false（3 筆都已付款）、不會重複標', second.ok && b?.ok === false && b?.mismatch_count === 3 && second.ms >= 700,
      `ms=${second.ms} ${second.err || second.out}`);
    check('C3 8 月期只有 1 批、3 筆 paid_at 只有一個',
      must(DB, "SELECT count(*) FROM public.salary_payout_batches WHERE period_start = '2026-07-26'") === '1'
        && must(DB, `SELECT count(DISTINCT paid_at) FROM public.class_sessions WHERE id IN (${idList(Object.keys(Q_FILE))})`) === '1');
  });

  section('還原一批：只還原沒被改過的列');
  await step('D revert', () => {
    // 標記後有人改了 f_bonus 的備註（updated_at 會變）→ 這筆不該被還原
    must(DB, `UPDATE public.class_sessions SET notes = '標記後補的備註' WHERE id = '${idOf('f_bonus')}'`);
    const beforeOthers = rowsMd5(DB, ['x_late', 'x_dup2', 'x_noacct', 'q_start']);
    const r = asRole(DB, authed(U.admin), revert(batch1));
    const result = parse(r);
    check('D1 還原回 7 筆、$3,650，1 筆（標記後被改過）沒還原、列出原因',
      r.ok && result?.reverted_count === 7 && Number(result?.reverted_amount) === 3650 && result?.skipped_count === 1
        && result.skipped[0].id === idOf('f_bonus') && result.skipped[0].reason === 'changed' && /標記後被改過/.test(result.skipped[0].message) && result.remaining_count === 1,
      r.err || r.out);
    const restored = ['f_start', 'f_partial', 'f_over', 'f_other', 'f_quoted', 'f_dup1', 'f_end'].map((k) => `${k}=${statusOf(DB, k)}`).join(' ');
    check('D2 被還原的 7 筆回到標記前：已核准、已領原值（先付 100 那筆回 100、溢付那筆仍 500）',
      restored === 'f_start=approved|0.00|1000.00 f_partial=approved|100.00|600.00 f_over=approved|500.00|300.00 f_other=approved|0.00|1200.00 f_quoted=approved|0.00|450.00 f_dup1=approved|0.00|200.00 f_end=approved|0.00|300.00',
      restored);
    check('D3 被還原的列 paid_at 回到 NULL', must(DB, `SELECT bool_and(paid_at IS NULL) FROM public.class_sessions WHERE id IN (${idList(['f_start', 'f_partial', 'f_over', 'f_end'])})`) === 't');
    check('D4 被改過的那筆維持已付款（沒被還原）', statusOf(DB, 'f_bonus') === 'paid|850.00|850.00', statusOf(DB, 'f_bonus'));
    check('D5 不屬於這批的列完全沒動', rowsMd5(DB, ['x_late', 'x_dup2', 'x_noacct', 'q_start']) === beforeOthers);
    const batch = must(DB, `SELECT reverted_count || '|' || reverted_amount || '|' || reverted_by_name || '|' || (reverted_at IS NOT NULL) FROM public.salary_payout_batches WHERE id = ${batch1}`);
    check('D6 批次紀錄：已還原 7 筆、$3,650、還原者姓名、還原時間', batch === '7|3650.00|管理員一|true', batch);
    check('D7 明細：7 筆有還原時間、被改過那筆沒有',
      must(DB, `SELECT count(*) FILTER (WHERE reverted_at IS NOT NULL) || '|' || count(*) FILTER (WHERE reverted_at IS NULL AND session_id = '${idOf('f_bonus')}') FROM public.salary_payout_batch_items WHERE batch_id = ${batch1}`) === '7|1');
    const before = tableMd5();
    const again = parse(asRole(DB, authed(U.admin), revert(batch1)));
    check('D8 再按一次還原（可重跑）：0 筆還原、仍回報那 1 筆、資料完全沒變',
      again?.reverted_count === 0 && again?.skipped_count === 1 && again?.remaining_count === 1 && tableMd5() === before, JSON.stringify(again));
    const missing = asRole(DB, authed(U.admin), revert(999999));
    check('D9 還原不存在的批次 → 22023「找不到批次 #999999。」', sqlstate(missing, '22023') && /找不到批次 #999999/.test(missing.err), firstLine(missing.err));
  });

  section('還原後重新標記、刪除列的還原');
  await step('F re-mark', () => {
    const remark = { f_start: 1000, f_partial: 500, f_end: 300 };
    const r = parse(asRole(DB, authed(U.admin), markP(remark)));
    check('F1 還原的列回到「已核准」後可以再標一批（3 筆、$1,800）', r?.ok === true && r?.marked_count === 3 && r?.batch_id > batch1, JSON.stringify(r));
    const batch3 = r?.batch_id;
    const before = tableMd5();
    const old = parse(asRole(DB, authed(U.admin), revert(batch1)));
    check('F2 再還原第一批：不會碰到第二次標記的列（它們屬於新的一批）', old?.reverted_count === 0 && tableMd5() === before, JSON.stringify(old));
    must(DB, `DELETE FROM public.class_sessions WHERE id = '${idOf('f_end')}'`);
    const del = parse(asRole(DB, authed(U.admin), revert(batch3)));
    check('F3 標記後被刪掉的列：還原時回報「這筆紀錄已不存在」，其他 2 筆照常還原',
      del?.reverted_count === 2 && del?.skipped_count === 1 && del.skipped[0].reason === 'not_found' && /已不存在/.test(del.skipped[0].message), JSON.stringify(del));
    check('F4 批次明細仍保留被刪除那筆的紀錄（沒有外鍵連帶刪除）',
      must(DB, `SELECT count(*) FROM public.salary_payout_batch_items WHERE batch_id = ${batch3} AND session_id = '${idOf('f_end')}'`) === '1');
  });

  section('用過之後再重套 migration');
  await step('G reapply', () => {
    const audit = auditMd5();
    const r = psql(DB, { file: MIG, user: 'sbadmin' });
    check('G1 已有批次紀錄時重套 migration 仍成功、紀錄完全保留、anon 仍不能執行',
      r.ok && auditMd5() === audit && must(DB, `SELECT has_function_privilege('anon', '${FN_MARK}', 'EXECUTE')`) === 'f', r.err);
  });
} catch (error) {
  check('腳本本身執行中斷', false, error.stack || error.message);
} finally {
  if (postgres && postgres.exitCode === null) {
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8', env: pgEnv });  // 只停自己起的那顆
  }
  rmSync(dir, { recursive: true, force: true });
}

const total = passCount + failCount;
console.log(`\n${'-'.repeat(60)}`);
console.log(`Total checks: ${total}   PASS: ${passCount}   FAIL: ${failCount}   (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
if (failCount > 0) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('ALL PASS: mark_salary_sessions_paid / revert_salary_payout_batch verified on isolated PostgreSQL');
}
