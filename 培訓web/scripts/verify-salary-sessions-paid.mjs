#!/usr/bin/env node
// 月結匯款「下載時存匯出紀錄 → 對某一份匯出標記已付款 → 可還原」：在隔離 PostgreSQL 實跑 migration 與 RPC，
// 斷言寫在程式裡，stdout 就是證據。
//
//   第 0 段（重現舊問題）：把被審查擋下的舊函式 mark_salary_period_paid（從 git 歷史 f907616 取出原文）套到另一個資料庫，
//     證明它會把轉帳檔沒有納入的列（異常課、缺帳號講師、管理員取消勾選的人、手動排除的課、對不到講師、匯出後才核准的晚到紀錄）
//     一起標成已付款＝永久漏匯。
//   之後各段：migration 20261022140000_mark_salary_sessions_paid.sql
//     → record_salary_payout_export（下載時存清單；逐筆核對已核准／期別／講師／金額，不符不存）
//     → mark_salary_payout_export_paid（清單從資料庫拿；匯出後才核准的不標、匯出後換講師整份擋、另一個連線隔天標也行、
//        同期兩份重疊後標的整份擋、溢付不改小、舊值留底）
//     → revert_salary_payout_export（只還原該份、只還原沒被改過的列、可重跑）
//     → 權限（只有 admin、anon 無權、mentor 碰不到、兩張紀錄表只有 admin 讀、沒有直接寫入權）、可重跑、兩人同時按。
//
// class_sessions 用 repo 裡真的建表 SQL＋migration 建（含 trg_session_anomaly、trg_class_sessions_updated_at、
// trg_guard_class_session_pricing 三個 trigger），不是手刻的假表。
// 正式庫的 SQL Editor 以「資料表擁有者（非 superuser）」身分執行，所以建好表後把擁有者換成非 superuser 的 sbadmin，
// 本次 migration 也用 sbadmin 執行；權限測試用 SET ROLE anon／authenticated + request.jwt.claims 模擬 PostgREST。
// 只連本機臨時 PostgreSQL（Unix socket，不開 TCP），不碰任何正式環境。
//
// 用法：cd 培訓web && npm run verify:salary-sessions-paid
// 突變測試：SESSIONS_PAID_MIGRATION_SQL=<故意改壞的 migration 副本> 再跑一次，應該要有 FAIL。
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
const NAMES = { [I1]: '測試講師一', [I2]: '測試講師二', [I3]: '缺帳號講師', [I4]: '取消勾選講師' };
const authed = (uid) => ({ role: 'authenticated', uid });
const ANON = { role: 'anon' };

// P＝2026-08-26～2026-09-25（9 月期）；Q＝2026-07-26～2026-08-25（8 月期）；R＝2026-06-26～2026-07-25（7 月期，給「兩份重疊」用）
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
  r_a: ['2026-07-01', 'approved', 'legacy', 100, 0, 0, I1, 'manual'],               // R：只在第一份
  r_b: ['2026-07-02', 'approved', 'legacy', 200, 0, 0, I1, 'manual'],               // R：兩份都有（重疊）
  r_c: ['2026-07-03', 'approved', 'legacy', 300, 0, 0, I2, 'manual'],               // R：只在第二份
};
// 匯出之後才核准的晚到紀錄（P 期內）：不在轉帳檔裡
const LATE = ['2026-09-22', 'approved', 'legacy', 450, 0, 0, I1, 'manual'];
const SPECIAL_IDS = { x_late: '20000000-0000-4000-8000-000000000999', x_nullstatus: '20000000-0000-4000-8000-000000000998' };
const idOf = (key) => SPECIAL_IDS[key] ?? `20000000-0000-4000-8000-${String(Object.keys(ROWS).indexOf(key) + 1).padStart(12, '0')}`;
const instOf = (key) => (key === 'x_late' ? LATE[6] : ROWS[key]?.[6]);
const idList = (keys) => keys.map((k) => `'${idOf(k)}'`).join(',');
const FILE = { f_start: 1000, f_bonus: 850, f_partial: 500, f_over: 0, f_other: 1200, f_quoted: 450, f_dup1: 200, f_end: 300 };
const FILE_KEYS = Object.keys(FILE);
const FILE_TOTAL = Object.values(FILE).reduce((a, b) => a + b, 0); // 4500
const FILE_ADJ = { [I1]: { amount: -500, reason: '扣回上期溢付' } };  // 轉帳檔總額 4000
const EXCLUDED_KEYS = ['x_dup2', 'x_noacct', 'x_person', 'x_session', 'x_unmatched', 'x_late'];
const Q_FILE = { q_start: 210, q_mid: 320, q_end: 5000 };

const DB = 'pp';
const DB_OLD = 'old';
const P = ["DATE '2026-08-26'", "DATE '2026-09-25'"];
const Q = ["DATE '2026-07-26'", "DATE '2026-08-25'"];
const R = ["DATE '2026-06-26'", "DATE '2026-07-25'"];
const FN = {
  record: 'public.record_salary_payout_export(date, date, jsonb, jsonb, numeric, date, text, jsonb)',
  mark: 'public.mark_salary_payout_export_paid(bigint, integer, numeric)',
  revert: 'public.revert_salary_payout_export(bigint)',
};
const HELPER = 'public.salary_payout_item_mismatches(jsonb, date, date)';
const sqlText = (s) => `'${String(s).replaceAll("'", "''")}'`;
const jsonArg = (v) => `${sqlText(JSON.stringify(v))}::jsonb`;
// 轉帳檔內容 → { items, people, total }（每位講師實付＝他的課加總＋人工調整，跟前端 buildMarkPaidPlan 一樣）
function payload(entries, { adjustments = {}, instructorOverride = {} } = {}) {
  const items = Object.entries(entries).map(([key, amount]) => ({ id: key.startsWith('ghost') ? '20000000-0000-4000-8000-00000000dead' : idOf(key),
    instructor_id: instructorOverride[key] ?? instOf(key) ?? I1, amount }));
  const cents = new Map();
  for (const item of items) cents.set(item.instructor_id, (cents.get(item.instructor_id) || 0) + Math.round(item.amount * 100));
  for (const inst of Object.keys(adjustments)) if (!cents.has(inst)) cents.set(inst, 0);
  const people = [...cents].map(([inst, sum]) => {
    const adj = adjustments[inst]?.amount ?? 0;
    return { instructor_id: inst, name: NAMES[inst] || '講師', amount: (sum + adj * 100) / 100, adjustment: adj, adjustment_reason: adjustments[inst]?.reason ?? null };
  });
  return { items, people, total: people.reduce((sum, p) => sum + Math.round(p.amount * 100), 0) / 100 };
}
const record = ([start, end], pl, { expected = pl.total, payDate = 'NULL', kind = "'csv'", exclusions = "'[]'::jsonb", items, people } = {}) => (
  `SELECT public.record_salary_payout_export(${start}, ${end}, ${items ?? jsonArg(pl.items)}, ${people ?? jsonArg(pl.people)}, ${expected}, ${payDate}, ${kind}, ${exclusions})::text;`
);
const mark = (id, count, amount) => `SELECT public.mark_salary_payout_export_paid(${id}, ${count}, ${amount})::text;`;
const revert = (id) => `SELECT public.revert_salary_payout_export(${id})::text;`;
const parse = (r) => { try { return JSON.parse(r.out.split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return null; } };
const rowsMd5 = (db, keys) => must(db, `SELECT md5(string_agg(to_jsonb(cs)::text, E'\\n' ORDER BY id)) FROM public.class_sessions cs WHERE id IN (${idList(keys)})`);
const tableMd5 = (db = DB) => must(db, `SELECT md5(string_agg(to_jsonb(cs)::text, E'\\n' ORDER BY id)) FROM public.class_sessions cs`);
const auditMd5 = () => must(DB, `SELECT md5(COALESCE((SELECT string_agg(to_jsonb(e)::text, E'\\n' ORDER BY id) FROM public.salary_payout_exports e), '')
  || COALESCE((SELECT string_agg(to_jsonb(i)::text, E'\\n' ORDER BY export_id, session_id) FROM public.salary_payout_export_items i), ''))`);
const statusOf = (db, key) => must(db, `SELECT status || '|' || paid_amount || '|' || total_salary FROM public.class_sessions WHERE id = '${idOf(key)}'`);
const exportCount = () => Number(must(DB, 'SELECT count(*) FROM public.salary_payout_exports'));
const asAdmin = (sql) => asRole(DB, authed(U.admin), sql);

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
  freezeUpdatedAt(db);
}
function freezeUpdatedAt(db, where = 'true') {
  must(db, `
    ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;
    ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
    UPDATE public.class_sessions SET updated_at = TIMESTAMPTZ '2026-10-01 09:00+08' WHERE ${where};
    ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
    ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;`);
}
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
    // 模擬舊函式（整期標）與第一版（吃前端清單）曾被套進這個資料庫：新 migration 要把它們移除
    must(DB, `CREATE FUNCTION public.mark_salary_period_paid(p_period_start date, p_period_end date, p_expected_count integer DEFAULT NULL, p_expected_amount numeric DEFAULT NULL)
      RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.mark_salary_period_paid(p_period_start date, p_period_end date) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.mark_salary_sessions_paid(date, date, jsonb, numeric, date, numeric, jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.revert_salary_payout_batch(bigint) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`, 'sbadmin');
  });

  section('migration 20261022140000_mark_salary_sessions_paid.sql');
  await step('M1 apply twice', () => {
    const r1 = psql(DB, { file: MIG, user: 'sbadmin' });
    check('M1a migration 第一次套用成功（非 superuser 表擁有者身分）', r1.ok, r1.err);
    const r2 = psql(DB, { file: MIG, user: 'sbadmin' });
    check('M1b migration 連續第二次套用成功（可重跑）', r2.ok, r2.err);
    check('M1c 舊的「整期一起標」與第一版「吃前端清單」的函式全部被移除',
      must(DB, "SELECT count(*) FROM pg_proc WHERE proname IN ('mark_salary_period_paid', 'mark_salary_sessions_paid', 'revert_salary_payout_batch')") === '0');
    check('M1d 新函式各只有一個版本',
      must(DB, "SELECT string_agg(proname || '/' || pronargs, ',' ORDER BY proname) FROM pg_proc WHERE proname IN ('record_salary_payout_export', 'mark_salary_payout_export_paid', 'revert_salary_payout_export', 'salary_payout_item_mismatches')")
        === 'mark_salary_payout_export_paid/3,record_salary_payout_export/8,revert_salary_payout_export/1,salary_payout_item_mismatches/3');
  });

  await step('M2 catalog', () => {
    const q = (s) => must(DB, s);
    for (const fn of Object.values(FN)) {
      const short = fn.split('(')[0].replace('public.', '');
      check(`M2a ${short}：SECURITY DEFINER、擁有者 sbadmin（非 superuser）`,
        q(`SELECT prosecdef || '|' || pg_get_userbyid(proowner) FROM pg_proc WHERE oid = '${fn}'::regprocedure`) === 'true|sbadmin');
      check(`M2b ${short}：search_path 固定為空字串`, q(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${fn}'::regprocedure`) === 'search_path=""');
      check(`M2c ${short}：anon 不能執行`, q(`SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')`) === 'f');
      const acl = q(`SELECT proacl::text FROM pg_proc WHERE oid = '${fn}'::regprocedure`);
      check(`M2d ${short}：PUBLIC 沒有執行權（ACL 裡沒有 =X/）`, !/(^|[{,])=X\//.test(acl), acl);
      check(`M2e ${short}：authenticated 可以呼叫（是否 admin 由函式內檢查）`, q(`SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE')`) === 't');
    }
    check('M2f 內部核對函式 salary_payout_item_mismatches：anon、authenticated 都不能直接呼叫，search_path 固定為空字串',
      q(`SELECT has_function_privilege('anon', '${HELPER}', 'EXECUTE') OR has_function_privilege('authenticated', '${HELPER}', 'EXECUTE')`) === 'f'
        && q(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${HELPER}'::regprocedure`) === 'search_path=""');
    for (const table of ['salary_payout_exports', 'salary_payout_export_items']) {
      check(`M3a ${table}：RLS 已啟用`, q(`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${table}'::regclass`) === 't');
      check(`M3b ${table}：anon 沒有任何權限`,
        q(`SELECT bool_or(has_table_privilege('anon', 'public.${table}', p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p`) === 'f');
      check(`M3c ${table}：authenticated 只有 SELECT（沒有 INSERT／UPDATE／DELETE）`,
        q(`SELECT string_agg(p, ',') FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege('authenticated', 'public.${table}', p)`) === 'SELECT');
    }
    const seq = q("SELECT pg_get_serial_sequence('public.salary_payout_exports', 'id')");
    check('M3d 匯出編號序列：anon／authenticated 都不能用（不能自己 nextval）',
      q(`SELECT has_sequence_privilege('anon', '${seq}', 'USAGE') OR has_sequence_privilege('authenticated', '${seq}', 'USAGE')`) === 'f', seq);
  });

  const filePayload = payload(FILE, { adjustments: FILE_ADJ });
  section('權限：只有 admin');
  await step('R non-admin', () => {
    const before = tableMd5();
    for (const [label, sql] of [['存匯出', record(P, filePayload)], ['標記', mark(1, 8, FILE_TOTAL)], ['還原', revert(1)]]) {
      const a = asRole(DB, ANON, sql);
      check(`R1 anon 呼叫${label}被拒（permission denied for function）`, deniedMsg(a), firstLine(a.err));
    }
    for (const [label, uid] of [['teacher', U.teacher], ['mentor', U.mentor], ['pending', U.pending], ['ghost（沒有 users 列）', U.ghost]]) {
      const r1 = asRole(DB, authed(uid), record(P, filePayload));
      const r2 = asRole(DB, authed(uid), mark(1, 8, FILE_TOTAL));
      const r3 = asRole(DB, authed(uid), revert(1));
      check(`R2 ${label}：存匯出／標記／還原都回 42501`, sqlstate(r1, '42501') && sqlstate(r2, '42501') && sqlstate(r3, '42501')
        && /只有管理員可以建立匯出紀錄/.test(r1.err) && /只有管理員可以標記已付款/.test(r2.err), `${firstLine(r1.err)} / ${firstLine(r2.err)} / ${firstLine(r3.err)}`);
    }
    const ins = asAdmin("INSERT INTO public.salary_payout_exports (period_start, period_end, item_count, people_count, total_amount, transfer_total, people) VALUES ('2026-08-26', '2026-09-25', 0, 1, 0, 0, '[]');");
    check('R3 admin 也不能直接寫匯出紀錄表（只能經函式）', deniedMsg(ins), firstLine(ins.err));
    const helper = asAdmin(`SELECT public.salary_payout_item_mismatches('[]'::jsonb, DATE '2026-08-26', DATE '2026-09-25');`);
    check('R4 admin 也不能直接呼叫內部核對函式', deniedMsg(helper), firstLine(helper.err));
    check('R5 以上被拒之後整張表完全沒變（含 updated_at）、沒有任何匯出紀錄', tableMd5() === before && exportCount() === 0);
  });

  section('存匯出：參數檢查（admin 也擋，22023，什麼都不存）');
  await step('V validation', () => {
    const before = tableMd5();
    const pl = filePayload;
    const firstItem = pl.items[0];
    const person = (overrides) => [{ ...pl.people.find((p) => p.instructor_id === I1), ...overrides }, ...pl.people.filter((p) => p.instructor_id !== I1)];
    const cases = [
      ['起日 NULL', record(['NULL', P[1]], pl), /期間起訖日不正確/],
      ['迄日早於起日', record([P[1], P[0]], pl), /期間起訖日不正確/],
      ['區間 32 天', record(["DATE '2026-01-25'", "DATE '2026-02-25'"], pl), /一次只能匯出一期/],
      ['檔案類型不是 csv／xlsx', record(P, pl, { kind: "'pdf'" }), /檔案類型不正確/],
      ['課的清單不是陣列', record(P, pl, { items: jsonArg(firstItem) }), /課的清單格式不正確/],
      ['某一筆 id 不是 uuid', record(P, pl, { items: jsonArg([{ ...firstItem, id: 'abc' }, ...pl.items.slice(1)]) }), /課的清單格式不正確（1 筆）/],
      ['某一筆缺講師', record(P, pl, { items: jsonArg([{ id: firstItem.id, amount: firstItem.amount }, ...pl.items.slice(1)]) }), /課的清單格式不正確（1 筆）/],
      ['某一筆金額是字串', record(P, pl, { items: jsonArg([{ ...firstItem, amount: '1000' }, ...pl.items.slice(1)]) }), /課的清單格式不正確/],
      ['某一筆金額負數', record(P, pl, { items: jsonArg([{ ...firstItem, amount: -1 }, ...pl.items.slice(1)]) }), /課的清單格式不正確/],
      ['某一筆金額三位小數', record(P, pl, { items: jsonArg([{ ...firstItem, amount: 1000.001 }, ...pl.items.slice(1)]) }), /課的清單格式不正確/],
      ['同一堂出現兩次', record(P, pl, { items: jsonArg([...pl.items, firstItem]) }), /課的清單裡有重複的紀錄/],
      ['講師清單空白', record(P, pl, { people: "'[]'::jsonb" }), /這份檔案沒有任何講師/],
      ['講師實付 0', record(P, pl, { people: jsonArg(person({ amount: 0 })) }), /講師清單格式不正確（1 位）/],
      ['有人工調整但沒寫原因', record(P, pl, { people: jsonArg(person({ adjustment_reason: '' })) }), /講師清單格式不正確（1 位）/],
      ['同一位講師出現兩次', record(P, pl, { people: jsonArg([...pl.people, pl.people[0]]) }), /講師清單裡有重複的講師/],
      ['有課的講師不在講師清單', record(P, pl, { people: jsonArg(pl.people.filter((p) => p.instructor_id === I1)) }), /有課的講師不在講師清單裡/],
      ['講師實付≠他的課加總＋人工調整', record(P, pl, { people: jsonArg(person({ amount: 3001 })) }), /講師實付和他的課加總＋人工調整不一致/],
      ['轉帳檔總額和講師實付合計不同', record(P, pl, { expected: 3999 }), /講師實付合計（\$4,000）與轉帳檔總額（\$3,999）不同/],
      ['排除摘要不是文字陣列', record(P, pl, { exclusions: "'[1]'::jsonb" }), /排除摘要格式不正確/],
    ];
    for (const [label, sql, pattern] of cases) {
      const r = asAdmin(sql);
      check(`V ${label} → 22023`, sqlstate(r, '22023') && pattern.test(r.err), firstLine(r.err) || r.out);
    }
    check('V 以上全部被擋：整張表完全沒變、沒有任何匯出紀錄', tableMd5() === before && exportCount() === 0);
  });

  section('存匯出：清單和資料庫不符 → 不存（ok=false，逐筆列原因）');
  await step('E record mismatch', () => {
    // 狀態是 NULL 的課（欄位允許 NULL）：NULL <> 'approved' 會得到 NULL，若用 <> 比較就會被當成「沒有不符」而放行
    must(DB, `INSERT INTO public.class_sessions (id, course_type, course_name, instructor_id, instructor_name, session_date, duration_hours, student_count,
        base_salary, bonus, paid_amount, status, pricing_status, source)
      VALUES ('${idOf('x_nullstatus')}', 'regular_basic', '狀態空白的課', '${I1}', '測試講師一', DATE '2026-09-08', 1.5, 3, 640, 0, 0, NULL, 'legacy', 'manual')`);
    check('E0 準備：資料庫裡有一筆狀態為 NULL 的課（9/8、講師一、$640）',
      must(DB, `SELECT (status IS NULL)::text || '|' || total_salary FROM public.class_sessions WHERE id = '${idOf('x_nullstatus')}'`) === 'true|640.00');
    const before = tableMd5();
    const cases = [
      ['混進待核准的列', { ...FILE, x_pending: 700 }, {}, 'status', /狀態已不是「已核准」（現在：待核准）/],
      ['混進已付款的列', { ...FILE, x_paid: 0 }, {}, 'status', /現在：已付款/],
      ['混進狀態為 NULL 的列（金額、講師、期別都對）', { ...FILE, x_nullstatus: 640 }, { instructorOverride: { x_nullstatus: I1 } }, 'status', /狀態已不是「已核准」（現在：未設定）/],
      ['混進別期的列（9/26）', { ...FILE, x_after: 4000 }, {}, 'period', /日期 2026-09-26 不在這一期/],
      ['混進對不到講師的列', { ...FILE, x_unmatched: 350 }, { instructorOverride: { x_unmatched: I1 } }, 'instructor', /已沒有連到講師主檔/],
      ['某一堂的講師和資料庫不同', FILE, { instructorOverride: { f_start: I2 } }, 'instructor', /講師和下載時不同（現在：測試講師一）/],
      ['某一筆金額和現在不同', { ...FILE, f_start: 999 }, {}, 'amount', /應付金額已變動（下載時 \$999，現在 \$1,000）/],
      ['某一筆已不存在', { ...FILE, ghost: 100 }, {}, 'not_found', /找不到這筆紀錄/],
    ];
    for (const [label, entries, opts, reason, pattern] of cases) {
      const r = asAdmin(record(P, payload(entries, { adjustments: FILE_ADJ, ...opts })));
      const result = parse(r);
      const hit = result?.mismatches?.[0];
      check(`E ${label} → ok=false、1 筆不符（${reason}）`,
        r.ok && result?.ok === false && result?.mismatch_count === 1 && hit?.reason === reason && pattern.test(hit?.message || ''), r.err || r.out);
    }
    check('E 以上全部沒存：整張表完全沒變、沒有任何匯出紀錄', tableMd5() === before && exportCount() === 0);
  });

  let e1;
  section('存匯出 #1（9 月期：2 位講師的課 8 筆、課程應付 $4,500、人工調整 -$500、轉帳檔總額 $4,000）');
  await step('X record', () => {
    const before = tableMd5();
    const exclusions = jsonArg(['異常標記預設排除 1 筆（$200）', '資料不全被擋下的講師 1 位、1 筆（$900）：缺帳號 1 位']);
    const r = asAdmin(record(P, filePayload, { payDate: "DATE '2026-10-10'", exclusions }));
    const result = parse(r);
    e1 = result?.export_id;
    check('X1 回傳 ok、匯出編號、8 筆、2 位講師、課程應付 $4,500、轉帳檔總額 $4,000',
      r.ok && result?.ok === true && Number.isInteger(e1) && result.item_count === 8 && result.people_count === 2
        && Number(result.total_amount) === FILE_TOTAL && Number(result.transfer_total) === 4000, r.err || r.out);
    check('X2 存匯出不會改任何報酬紀錄（整張表含 updated_at 完全沒變）', tableMd5() === before);
    const row = must(DB, `SELECT period_start || '|' || period_end || '|' || item_count || '|' || people_count || '|' || total_amount || '|' || transfer_total
        || '|' || pay_date || '|' || file_kind || '|' || exported_by || '|' || exported_by_name || '|' || (marked_at IS NULL) || '|' || jsonb_array_length(exclusions)
        || '|' || (SELECT string_agg((p ->> 'name') || ':' || (p ->> 'amount') || ':' || (p ->> 'adjustment'), ',' ORDER BY p ->> 'name') FROM jsonb_array_elements(people) p)
      FROM public.salary_payout_exports WHERE id = ${e1}`);
    check('X3 匯出紀錄：期別、筆數、人數、金額、付款日、檔案類型、誰下載（id＋姓名）、還沒標記、排除摘要、每位講師實付與人工調整',
      row === `2026-08-26|2026-09-25|8|2|4500.00|4000.00|2026-10-10|csv|${U.admin}|管理員一|true|2|測試講師一:2600:-500,測試講師二:1400:0`, row);
    const items = must(DB, `SELECT count(*) || '|' || sum(amount) || '|' || bool_and(old_status IS NULL AND new_paid_at IS NULL)
        || '|' || count(*) FILTER (WHERE instructor_id = '${I2}') FROM public.salary_payout_export_items WHERE export_id = ${e1}`);
    check('X4 清單 8 筆存進資料庫（含每堂的講師與應付金額），還沒有標記前後的值', items === '8|4500.00|true|2', items);
  });

  section('紀錄表只有 admin 讀得到（mentor 也碰不到）');
  await step('L read access', () => {
    const t = asRole(DB, authed(U.teacher), 'SELECT count(*) FROM public.salary_payout_exports; SELECT count(*) FROM public.salary_payout_export_items;');
    check('L1 講師查兩張表都是 0 筆（RLS 擋掉）', t.ok && t.out.split('\n').join(',') === '0,0', t.err || t.out);
    const m = asRole(DB, authed(U.mentor), 'SELECT count(*) FROM public.salary_payout_exports; SELECT count(*) FROM public.salary_payout_export_items;');
    check('L2 輔導員查兩張表都是 0 筆', m.ok && m.out.split('\n').join(',') === '0,0', m.err || m.out);
    const a = asRole(DB, ANON, 'SELECT count(*) FROM public.salary_payout_exports;');
    check('L3 anon 查匯出紀錄被拒（permission denied）', deniedMsg(a), firstLine(a.err));
    const ad = asAdmin('SELECT count(*) FROM public.salary_payout_exports; SELECT count(*) FROM public.salary_payout_export_items;');
    check('L4 admin 看得到 1 份匯出、8 筆清單', ad.ok && ad.out.split('\n').join(',') === '1,8', ad.err || ad.out);
  });

  section('標記：確認值不對 → 擋下');
  await step('K mark guards', () => {
    const before = tableMd5();
    const audit = auditMd5();
    const cases = [
      ['確認筆數不同（7 筆）', mark(e1, 7, FILE_TOTAL), /確認的筆數／金額（7 筆、\$4,500）和匯出 #\d+（8 筆、\$4,500）不同/],
      ['確認金額不同（$4,499）', mark(e1, 8, 4499), /確認的筆數／金額（8 筆、\$4,499）/],
      ['匯出編號不存在', mark(999999, 8, FILE_TOTAL), /找不到匯出 #999999/],
    ];
    for (const [label, sql, pattern] of cases) {
      const r = asAdmin(sql);
      check(`K ${label} → 22023、沒有標記`, sqlstate(r, '22023') && pattern.test(r.err), firstLine(r.err) || r.out);
    }
    const future = psql(DB, { sql: `\\set VERBOSITY verbose
BEGIN;
UPDATE public.salary_payout_exports SET period_end = (now() AT TIME ZONE 'Asia/Taipei')::date WHERE id = ${e1};
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '${JSON.stringify({ sub: U.admin, role: 'authenticated' })}';
${mark(e1, 8, FILE_TOTAL)}
ROLLBACK;` });
    check('K 這一期還沒結束（迄日＝台北今天）→ 22023「結束後才能標記已付款」', sqlstate(future, '22023') && /結束後才能標記已付款/.test(future.err), firstLine(future.err) || future.out);
    check('K 以上全部擋下：報酬紀錄與匯出紀錄完全沒變', tableMd5() === before && auditMd5() === audit);
  });

  section('隔天、另一個連線、另一位管理員直接標記昨天那份（之間又核准了一筆晚到的）');
  await step('A mark', () => {
    insertRows(DB, [['x_late', LATE]]);  // 匯出之後才核准：不在匯出 #1 裡
    freezeUpdatedAt(DB, `id = '${idOf('x_late')}'`);
    const untouchedKeys = [...Object.keys(ROWS).filter((k) => !FILE_KEYS.includes(k)), 'x_late'];
    const untouchedBefore = rowsMd5(DB, untouchedKeys);
    const r = asRole(DB, authed(U.admin2), mark(e1, 8, FILE_TOTAL));
    const result = parse(r);
    check('A1 管理員二（不同連線）只用匯出編號＋確認值就標記成功：8 筆、$4,500', r.ok && result?.ok === true && result.export_id === e1
      && result.marked_count === 8 && Number(result.marked_amount) === FILE_TOTAL, r.err || r.out);
    const marked = must(DB, `SELECT count(*) FILTER (WHERE status = 'paid') || '|' || count(DISTINCT paid_at) || '|' || bool_and(updated_at > TIMESTAMPTZ '2026-10-01 09:00+08')
        || '|' || bool_and(paid_at = '${result?.paid_at}'::timestamptz) FROM public.class_sessions WHERE id IN (${idList(FILE_KEYS)})`);
    check('A2 匯出 #1 裡的 8 筆都變成已付款、paid_at 同一個時間、updated_at 有更新', marked === '8|1|true|true', marked);
    check('A3 一般列：已領＝總額（有獎金那筆 850）', statusOf(DB, 'f_bonus') === 'paid|850.00|850.00' && statusOf(DB, 'f_start') === 'paid|1000.00|1000.00');
    check('A4 先付過 100 的那筆：已領改成總額 600', statusOf(DB, 'f_partial') === 'paid|600.00|600.00', statusOf(DB, 'f_partial'));
    check('A5 已領 500 超過總額 300 的那筆：已領維持 500，沒有被改小', statusOf(DB, 'f_over') === 'paid|500.00|300.00', statusOf(DB, 'f_over'));
    check('A6 匯出 #1 沒納入的列（異常課、缺帳號講師、取消勾選的人、手動排除的課、對不到講師）、匯出之後才核准的那筆、其他期別：整列完全沒變',
      rowsMd5(DB, untouchedKeys) === untouchedBefore);
    check('A7 匯出之後才核准的那筆仍是「已核准」', statusOf(DB, 'x_late') === 'approved|0.00|450.00', statusOf(DB, 'x_late'));
    const row = must(DB, `SELECT marked_by || '|' || marked_by_name || '|' || marked_count || '|' || marked_amount || '|' || (marked_at = '${result?.paid_at}'::timestamptz)
      FROM public.salary_payout_exports WHERE id = ${e1}`);
    check('A8 匯出紀錄記上標記人（管理員二）、筆數、金額、時間', row === `${U.admin2}|管理員二|8|4500.00|true`, row);
    const items = must(DB, `SELECT string_agg(s.k || ':' || i.amount || ':' || i.old_status || ':' || i.old_paid_amount || ':' || COALESCE(i.old_paid_at::text, '-') || ':' || i.new_paid_amount
          || ':' || (i.new_updated_at = cs.updated_at), ',' ORDER BY s.k)
      FROM public.salary_payout_export_items i
      JOIN public.class_sessions cs ON cs.id = i.session_id
      JOIN (VALUES ${FILE_KEYS.map((k) => `('${idOf(k)}'::uuid, '${k}')`).join(',')}) AS s(id, k) ON s.id = i.session_id
      WHERE i.export_id = ${e1}`);
    const expectedItems = ['f_bonus:850.00:approved:0.00:-:850.00:true', 'f_dup1:200.00:approved:0.00:-:200.00:true', 'f_end:300.00:approved:0.00:-:300.00:true',
      'f_other:1200.00:approved:0.00:-:1200.00:true', 'f_over:0.00:approved:500.00:-:500.00:true', 'f_partial:500.00:approved:100.00:-:600.00:true',
      'f_quoted:450.00:approved:0.00:-:450.00:true', 'f_start:1000.00:approved:0.00:-:1000.00:true'].join(',');
    check('A9 清單每筆補上：當時應付、舊狀態／舊已領／舊付款時間、新已領、標完當下的 updated_at', items === expectedItems, items);
    check('A10 三個 trigger 仍是啟用狀態', must(DB, `SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal`) === 'OOO');
  });

  section('同一份再標一次 → 擋下');
  await step('B rerun', () => {
    const before = tableMd5();
    const audit = auditMd5();
    const r = asAdmin(mark(e1, 8, FILE_TOTAL));
    check('B1 匯出 #1 再標一次 → 22023「已經標記過已付款，不能再標一次」', sqlstate(r, '22023') && /已經標記過已付款/.test(r.err), firstLine(r.err) || r.out);
    check('B2 報酬紀錄與匯出紀錄完全沒變', tableMd5() === before && auditMd5() === audit);
  });

  let e2;
  section('匯出後把課從講師 A 改到講師 B（金額不變）→ 標記整份被擋');
  await step('I instructor changed', () => {
    const r = parse(asAdmin(record(Q, payload(Q_FILE))));
    e2 = r?.export_id;
    check('I1 存 8 月期匯出 #2（3 筆、$5,530）', r?.ok === true && r.item_count === 3, JSON.stringify(r));
    must(DB, `UPDATE public.class_sessions SET instructor_id = '${I1}', instructor_name = '測試講師一' WHERE id = '${idOf('q_mid')}'`);
    const before = tableMd5();
    const audit = auditMd5();
    const m = asAdmin(mark(e2, 3, 5530));
    const result = parse(m);
    check('I2 標記 → ok=false、1 筆不符（instructor：講師和下載時不同）、0 筆標記',
      m.ok && result?.ok === false && result.marked_count === 0 && result.mismatch_count === 1 && result.mismatches[0].reason === 'instructor'
        && result.mismatches[0].id === idOf('q_mid') && /講師和下載時不同（現在：測試講師一）/.test(result.mismatches[0].message), m.err || m.out);
    check('I3 整份被擋：同一份另外 2 筆也沒被標、匯出紀錄仍是「未標記」', tableMd5() === before && auditMd5() === audit
      && statusOf(DB, 'q_start').startsWith('approved|') && statusOf(DB, 'q_end').startsWith('approved|'));
    check('I4 擋完沒有殘留鎖（另一個連線馬上可以改這些列）',
      must(DB, `SET lock_timeout = '1s'; BEGIN; UPDATE public.class_sessions SET notes = notes WHERE id IN (${idList(Object.keys(Q_FILE))}); ROLLBACK; SELECT 'ok';`).endsWith('ok'));
    must(DB, `UPDATE public.class_sessions SET instructor_id = '${I2}', instructor_name = '測試講師二' WHERE id = '${idOf('q_mid')}'`);
  });

  section('兩位管理員同時標記同一份（匯出 #2，講師已改回）');
  await step('C concurrent', async () => {
    const first = psqlAsync(DB, `${roleCtx(authed(U.admin))}BEGIN;\n${mark(e2, 3, 5530)}\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await psqlAsync(DB, roleCtx(authed(U.admin2)) + mark(e2, 3, 5530));
    const firstResult = await first;
    const a = JSON.parse(firstResult.out.split('\n').find((l) => l.startsWith('{')) || 'null');
    check('C1 先按的那位標到 3 筆、$5,530', firstResult.ok && a?.ok === true && a.marked_count === 3 && Number(a.marked_amount) === 5530, firstResult.err || firstResult.out);
    check('C2 後按的那位等前一位完成後 → 22023「已經標記過」、不會重複標', !second.ok && /22023/.test(second.err) && /已經標記過已付款/.test(second.err) && second.ms >= 700,
      `ms=${second.ms} ${second.err || second.out}`);
    check('C3 3 筆 paid_at 只有一個', must(DB, `SELECT count(DISTINCT paid_at) FROM public.class_sessions WHERE id IN (${idList(Object.keys(Q_FILE))})`) === '1');
  });

  let e3;
  let e4;
  section('同一期兩份匯出有重疊的課（7 月期：#3＝a＋b、#4＝b＋c）');
  await step('O overlap', () => {
    const r3 = parse(asAdmin(record(R, payload({ r_a: 100, r_b: 200 }))));
    const r4 = parse(asAdmin(record(R, payload({ r_b: 200, r_c: 300 }))));
    e3 = r3?.export_id;
    e4 = r4?.export_id;
    check('O1 兩份都存得進去（存的當下 3 筆都是已核准）', r3?.ok === true && r4?.ok === true && e4 > e3, `${JSON.stringify(r3)} ${JSON.stringify(r4)}`);
    const m3 = parse(asAdmin(mark(e3, 2, 300)));
    check('O2 先標 #3 成功（a、b 變已付款）', m3?.ok === true && statusOf(DB, 'r_a').startsWith('paid|') && statusOf(DB, 'r_b').startsWith('paid|'), JSON.stringify(m3));
    const before = tableMd5();
    const m4 = parse(asAdmin(mark(e4, 2, 500)));
    check('O3 再標 #4 → ok=false（b 已是已付款）、整份被擋：c 仍是已核准', m4?.ok === false && m4.mismatch_count === 1 && m4.mismatches[0].id === idOf('r_b')
      && m4.mismatches[0].reason === 'status' && tableMd5() === before && statusOf(DB, 'r_c') === 'approved|0.00|300.00', JSON.stringify(m4));
    check('O4 #4 仍是「未標記」', must(DB, `SELECT marked_at IS NULL FROM public.salary_payout_exports WHERE id = ${e4}`) === 't');
  });

  section('還原：只還原該份、只還原沒被改過的列');
  await step('D revert', () => {
    must(DB, `UPDATE public.class_sessions SET notes = '標記後補的備註' WHERE id = '${idOf('f_bonus')}'`);  // 標記後有人改了這筆
    const othersBefore = rowsMd5(DB, ['x_late', 'x_dup2', 'x_noacct', 'q_start', 'r_a', 'r_b']);
    const r = asAdmin(revert(e1));
    const result = parse(r);
    check('D1 還原匯出 #1：7 筆、$3,650，1 筆（標記後被改過）沒還原、列出原因',
      r.ok && result?.reverted_count === 7 && Number(result.reverted_amount) === 3650 && result.skipped_count === 1
        && result.skipped[0].id === idOf('f_bonus') && result.skipped[0].reason === 'changed' && result.remaining_count === 1, r.err || r.out);
    const restored = ['f_start', 'f_partial', 'f_over', 'f_other', 'f_quoted', 'f_dup1', 'f_end'].map((k) => `${k}=${statusOf(DB, k)}`).join(' ');
    check('D2 被還原的 7 筆回到標記前：已核准、已領原值（先付 100 那筆回 100、溢付那筆仍 500）',
      restored === 'f_start=approved|0.00|1000.00 f_partial=approved|100.00|600.00 f_over=approved|500.00|300.00 f_other=approved|0.00|1200.00 f_quoted=approved|0.00|450.00 f_dup1=approved|0.00|200.00 f_end=approved|0.00|300.00',
      restored);
    check('D3 被還原的列 paid_at 回到 NULL', must(DB, `SELECT bool_and(paid_at IS NULL) FROM public.class_sessions WHERE id IN (${idList(['f_start', 'f_partial', 'f_over', 'f_end'])})`) === 't');
    check('D4 被改過的那筆維持已付款', statusOf(DB, 'f_bonus') === 'paid|850.00|850.00', statusOf(DB, 'f_bonus'));
    check('D5 只還原該份：匯出 #3 標的 a、b 與其他列完全沒動', rowsMd5(DB, ['x_late', 'x_dup2', 'x_noacct', 'q_start', 'r_a', 'r_b']) === othersBefore);
    const row = must(DB, `SELECT reverted_count || '|' || reverted_amount || '|' || reverted_by_name || '|' || (reverted_at IS NOT NULL) || '|' || (marked_at IS NOT NULL) FROM public.salary_payout_exports WHERE id = ${e1}`);
    check('D6 匯出紀錄：已還原 7 筆、$3,650、還原者、還原時間（標記紀錄保留）', row === '7|3650.00|管理員一|true|true', row);
    const before = tableMd5();
    const again = parse(asAdmin(revert(e1)));
    check('D7 再按一次還原（可重跑）：0 筆還原、仍回報那 1 筆、資料完全沒變',
      again?.reverted_count === 0 && again.skipped_count === 1 && again.remaining_count === 1 && tableMd5() === before, JSON.stringify(again));
    const unmarked = asAdmin(revert(e4));
    check('D8 還原「未標記」的匯出 #4 → 22023「還沒標記已付款，不需要還原」', sqlstate(unmarked, '22023') && /還沒標記已付款/.test(unmarked.err), firstLine(unmarked.err));
    const missing = asAdmin(revert(999999));
    check('D9 還原不存在的匯出 → 22023', sqlstate(missing, '22023') && /找不到匯出 #999999/.test(missing.err), firstLine(missing.err));
    const remark = asAdmin(mark(e1, 8, FILE_TOTAL));
    check('D10 還原過的匯出不能再標一次（要重新下載一份）', sqlstate(remark, '22023') && /已經標記過/.test(remark.err), firstLine(remark.err));
  });

  section('還原後重新下載再標、刪除列的還原');
  await step('F re-export', () => {
    const r = parse(asAdmin(record(P, payload({ f_start: 1000, f_partial: 500, f_end: 300 }))));
    const m = parse(asAdmin(mark(r?.export_id, 3, 1800)));
    check('F1 重新下載（新匯出）→ 標記成功（3 筆、$1,800）', r?.ok === true && m?.ok === true && m.marked_count === 3, `${JSON.stringify(r)} ${JSON.stringify(m)}`);
    const before = tableMd5();
    const old = parse(asAdmin(revert(e1)));
    check('F2 再還原匯出 #1：不會碰到新匯出標的列', old?.reverted_count === 0 && tableMd5() === before, JSON.stringify(old));
    must(DB, `DELETE FROM public.class_sessions WHERE id = '${idOf('f_end')}'`);
    must(DB, `UPDATE public.class_sessions SET status = NULL WHERE id = '${idOf('f_partial')}'`);  // 標記後狀態被清成 NULL
    const del = parse(asAdmin(revert(r?.export_id)));
    const reasons = (del?.skipped || []).map((x) => `${x.id === idOf('f_end') ? 'f_end' : x.id === idOf('f_partial') ? 'f_partial' : x.id}:${x.reason}`).sort().join(',');
    check('F3 標記後被刪掉的列回報「這筆紀錄已不存在」、狀態被清成 NULL 的列回報「已不是已付款（現在：未設定）」，只有沒被動過的 1 筆照常還原',
      del?.reverted_count === 1 && del.skipped_count === 2 && reasons === 'f_end:not_found,f_partial:status'
        && del.skipped.some((x) => /已不是已付款（現在：未設定）/.test(x.message)) && statusOf(DB, 'f_start').startsWith('approved|'), JSON.stringify(del));
    check('F4 匯出清單仍保留被刪除那筆（沒有外鍵連帶刪除）',
      must(DB, `SELECT count(*) FROM public.salary_payout_export_items WHERE export_id = ${r?.export_id} AND session_id = '${idOf('f_end')}'`) === '1');
  });

  section('用過之後再重套 migration');
  await step('G reapply', () => {
    const audit = auditMd5();
    const r = psql(DB, { file: MIG, user: 'sbadmin' });
    check('G1 已有匯出紀錄時重套 migration 仍成功、紀錄完全保留、anon 仍不能執行',
      r.ok && auditMd5() === audit && must(DB, `SELECT has_function_privilege('anon', '${FN.mark}', 'EXECUTE')`) === 'f', r.err);
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
  console.log('ALL PASS: record / mark / revert salary payout export verified on isolated PostgreSQL');
}
