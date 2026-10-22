#!/usr/bin/env node
// 後台「本期匯款完成」：在隔離 PostgreSQL 實跑 migration 與 RPC，斷言寫在程式裡，stdout 就是證據。
//
//   migration 20261021233000_mark_salary_period_paid.sql → public.mark_salary_period_paid(p_period_start, p_period_end)
//   （只有 admin、只動區間內已核准、邊界 25／26 日、可重跑、兩人同時按不重複、還沒結束的期別擋下、
//    筆數或金額與確認框不同就整批取消）
//
// class_sessions 用 repo 裡真的建表 SQL＋migration 建（含 trg_session_anomaly、trg_class_sessions_updated_at、
// trg_guard_class_session_pricing 三個 trigger），不是手刻的假表。
// 正式庫的 SQL Editor 以「資料表擁有者（非 superuser）」身分執行，所以建好表後把擁有者換成非 superuser 的 sbadmin，
// 本次 migration 也用 sbadmin 執行；權限測試用 SET ROLE anon／authenticated + request.jwt.claims 模擬 PostgREST。
// 只連本機臨時 PostgreSQL（Unix socket，不開 TCP），不碰任何正式環境。
//
// 用法：cd 培訓web && npm run verify:salary-period-paid
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
const MIG = process.env.PERIOD_PAID_MIGRATION_SQL || path.join(appDir, 'supabase/migrations/20261021233000_mark_salary_period_paid.sql');
const SCHEMA_MIGRATIONS = [
  '20260826105841_restore_salary_workflow.sql',
  '20261018120000_align_salary_report_with_forms.sql',
  '20261018150000_limit_instructor_salary_visibility.sql',
  '20261020150000_salary_anomaly_exact_duplicates.sql',
];

// ───────────────────────── 臨時 PostgreSQL ─────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), 'd1-period-paid-'));
const dataDir = path.join(dir, 'data');
const pgEnv = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', PGCLIENTENCODING: 'UTF8' };
// 只用 Unix socket（listen_addresses 為空），port 只是 socket 檔名的一部分
const port = 54000 + Math.floor(Math.random() * 900);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv, ...opts });
const psqlArgs = (db, user, file) => ['-X', '-q', '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1',
  '-h', dir, '-p', String(port), '-U', user, '-d', db, '-f', file ?? '-'];

function psql(db, { sql, file, user = 'postgres' } = {}) {
  const t0 = Date.now();
  const r = sh('psql', psqlArgs(db, user, file), file ? {} : { input: sql });
  const lines = (r.stderr || '').replaceAll(repoRoot, '<repo>').split('\n');
  return {
    ok: r.status === 0,
    out: (r.stdout || '').trim(),
    err: lines.filter((l) => !/NOTICE:/.test(l)).join('\n').trim(),
    ms: Date.now() - t0,
  };
}
// 背景執行（測「兩位管理員同時按」用）：回傳 Promise
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
// VERBOSITY verbose：錯誤訊息帶 SQLSTATE（「ERROR:  42501: …」），才驗得到錯誤代碼
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
-- 與 Supabase 相同：之後在 public 建的表／函式預設把全部權限給 anon／authenticated（SQL 必須自己 REVOKE）
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sbadmin IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE sbadmin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
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
-- PostgreSQL 16 不接受 to_char 當衍生欄位；用 IMMUTABLE 包一層，讓 month_label 仍是衍生欄位（與 rehearse_local.py 相同）
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
const I1 = '10000000-0000-4000-8000-000000000001';
const I2 = '10000000-0000-4000-8000-000000000002';
const authed = (uid) => ({ role: 'authenticated', uid });
const ANON = { role: 'anon' };
const DB = 'pp';
const FN = 'public.mark_salary_period_paid(date, date, integer, numeric)';
const call = (start, end, ...expected) => `SELECT public.mark_salary_period_paid(${[start, end, ...expected].join(', ')})::text;`;
const parse = (r) => { try { return JSON.parse(r.out.split('\n').pop()); } catch { return null; } };

// 測試資料：目標期別 P＝2026-08-26～2026-09-25（9 月期，一定已結束）；另一期 Q＝2026-07-26～2026-08-25 給「同時按」用
// key → [session_date, status, pricing_status, base_salary, bonus, paid_amount, 講師, source]
const ROWS = {
  q_before: ['2026-07-25', 'approved', 'legacy', 333, 0, 0, I1, 'manual'],      // Q 期前一天：Q 不動
  q_start: ['2026-07-26', 'approved', 'legacy', 210, 0, 0, I1, 'manual'],       // Q 起點
  q_mid: ['2026-08-10', 'approved', 'legacy', 320, 0, 0, I2, 'manual'],
  p_before: ['2026-08-25', 'approved', 'legacy', 5000, 0, 0, I1, 'manual'],     // P 前一天（25 日）：P 不動；屬 Q 終點
  p_start: ['2026-08-26', 'approved', 'legacy', 1000, 0, 0, I1, 'manual'],      // P 起點（26 日）
  p_bonus: ['2026-09-10', 'approved', 'legacy', 800, 50, 0, I1, 'self_report'], // 有獎金：total 850
  p_partial: ['2026-09-12', 'approved', 'manual_override', 600, 0, 100, I1, 'manual'], // 先付過 100 → 標完 paid_amount 600
  p_other: ['2026-09-01', 'approved', 'legacy', 1200, 0, 0, I2, 'manual'],      // 別的講師也要一起標
  p_quoted: ['2026-09-20', 'approved', 'quoted', 450, 0, 0, I1, 'self_report'], // 自動試算的回報
  p_dup1: ['2026-09-18', 'approved', 'legacy', 200, 0, 0, I2, 'manual'],        // 一模一樣的兩筆（先登記那筆原本沒標異常）
  p_dup2: ['2026-09-18', 'approved', 'legacy', 200, 0, 0, I2, 'manual'],
  p_end: ['2026-09-25', 'approved', 'legacy', 300, 0, 0, I1, 'historical_import'], // P 終點（25 日），總表匯入
  p_after: ['2026-09-26', 'approved', 'legacy', 4000, 0, 0, I1, 'manual'],      // P 後一天（26 日）：不動
  p_pending: ['2026-09-15', 'pending', 'legacy', 700, 0, 0, I1, 'self_report'], // 待核准：不動
  p_review: ['2026-09-16', 'pending', 'needs_review', null, 0, 0, I1, 'self_report'], // 待定價：不動
  p_rejected: ['2026-09-17', 'pending', 'rejected', null, 0, 0, I1, 'self_report'],   // 退回：不動
  p_paid: ['2026-09-05', 'paid', 'legacy', 900, 0, 900, I1, 'historical_import'],     // 已付款（像 06 標過的列）：不動
  recent: ['2026-10-05', 'approved', 'legacy', 777, 0, 0, I1, 'manual'],         // 目前這一期：不動
};
const P_MARK = ['p_start', 'p_bonus', 'p_partial', 'p_other', 'p_quoted', 'p_dup1', 'p_dup2', 'p_end'];
const P_AMOUNT = 1000 + 850 + 600 + 1200 + 450 + 200 + 200 + 300; // 4800
const Q_MARK = ['q_start', 'q_mid', 'p_before'];
const Q_AMOUNT = 210 + 320 + 5000;
const idOf = (key) => `20000000-0000-4000-8000-${String(Object.keys(ROWS).indexOf(key) + 1).padStart(12, '0')}`;
const idList = (keys) => keys.map((k) => `'${idOf(k)}'`).join(',');
const rowsMd5 = (keys) => must(DB, `SELECT md5(string_agg(to_jsonb(cs)::text, E'\\n' ORDER BY id)) FROM public.class_sessions cs WHERE id IN (${idList(keys)})`);
const tableMd5 = () => must(DB, `SELECT md5(string_agg(to_jsonb(cs)::text, E'\\n' ORDER BY id)) FROM public.class_sessions cs`);
const statusOf = (key) => must(DB, `SELECT status || '|' || paid_amount || '|' || total_salary FROM public.class_sessions WHERE id = '${idOf(key)}'`);

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

  must('postgres', `CREATE ROLE sbadmin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE DATABASE ${DB};`);

  section('bootstrap：repo 的建表 SQL＋migration 建 class_sessions');
  await step('S bootstrap', () => {
    must(DB, BOOT);
    const base = readFileSync(path.join(appDir, 'supabase/2025_salary_system.sql'), 'utf8');
    const target = "to_char(session_date, 'YYYY/MM')";
    if (!base.includes(target)) throw new Error('month_label expression not found');
    const basePath = path.join(dir, 'base.sql');
    writeFileSync(basePath, base.replace(target, 'public._month_label(session_date)'));
    mustFile(DB, basePath);
    for (const file of SCHEMA_MIGRATIONS) mustFile(DB, path.join(appDir, 'supabase/migrations', file));
    // 正式庫：表擁有者是非 superuser 的 postgres 角色 → 這裡換成 sbadmin
    must(DB, `ALTER TABLE public.class_sessions OWNER TO sbadmin; ALTER TABLE public.users OWNER TO sbadmin;
      ALTER TABLE public.instructors OWNER TO sbadmin; ALTER TABLE public.salary_rate_card OWNER TO sbadmin;`);
    must(DB, `
      INSERT INTO auth.users (id, email) VALUES
        ('${U.teacher}', 'teacher@test.local'), ('${U.mentor}', 'mentor@test.local'),
        ('${U.admin}', 'admin@test.local'), ('${U.admin2}', 'admin2@test.local'),
        ('${U.pending}', 'pending@test.local'), ('${U.ghost}', 'ghost@test.local');
      INSERT INTO public.users (id, name, email, role) VALUES
        ('${U.teacher}', '講師', 'teacher@test.local', 'teacher'), ('${U.mentor}', '導師', 'mentor@test.local', 'mentor'),
        ('${U.admin}', '管理員一', 'admin@test.local', 'admin'), ('${U.admin2}', '管理員二', 'admin2@test.local', 'admin'),
        ('${U.pending}', '待審', 'pending@test.local', 'pending');
      INSERT INTO public.instructors (id, user_id, full_name, instructor_role) VALUES
        ('${I1}', '${U.teacher}', '測試講師一', 'A'), ('${I2}', NULL, '測試講師二', 'B');
      INSERT INTO public.salary_rate_card (id, course_type, pricing_mode, rate)
        VALUES ('30000000-0000-4000-8000-000000000001', 'regular_basic', 'hourly', 300);
    `);
    const values = Object.entries(ROWS).map(([key, [date, status, pricing, base, bonus, paid, inst, source]]) => `(
      '${idOf(key)}', 'regular_basic', '同一堂課', '${inst}', '${inst === I1 ? '測試講師一' : '測試講師二'}', DATE '${date}', 1.5, 3,
      ${base === null ? 'NULL' : base}, ${bonus}, ${paid}, '${status}'::public.session_status_enum, '${pricing}', '${source}',
      ${pricing === 'quoted' ? "'30000000-0000-4000-8000-000000000001'::uuid, now()" : 'NULL, NULL'},
      ${pricing === 'manual_override' ? "'測試人工調整'" : 'NULL'},
      ${status === 'paid' ? "TIMESTAMPTZ '2026-09-30 10:00+08'" : 'NULL'}
    )`).join(',\n');
    must(DB, `INSERT INTO public.class_sessions (id, course_type, course_name, instructor_id, instructor_name, session_date,
        duration_hours, student_count, base_salary, bonus, paid_amount, status, pricing_status, source,
        rate_card_id, pricing_quoted_at, manual_adjustment_reason, paid_at)
      VALUES ${values};
      -- 讓 updated_at 都停在「很久以前」，之後被改到就看得出來（暫停 trigger 才改得到；異常標記也維持新增當下的結果）
      ALTER TABLE public.class_sessions DISABLE TRIGGER trg_class_sessions_updated_at;
      ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
      UPDATE public.class_sessions SET updated_at = TIMESTAMPTZ '2026-10-01 09:00+08';
      ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
      ALTER TABLE public.class_sessions ENABLE TRIGGER trg_class_sessions_updated_at;`);
    const triggers = must(DB, `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal`);
    check('S1 class_sessions 用 repo SQL 建好，有 3 個 trigger（anomaly／guard pricing／updated_at）',
      triggers === 'trg_class_sessions_updated_at,trg_guard_class_session_pricing,trg_session_anomaly', triggers);
    const dupFlags = must(DB, `SELECT string_agg(is_anomaly::text, ',' ORDER BY id) FROM public.class_sessions WHERE id IN (${idList(['p_dup1', 'p_dup2'])})`);
    check('S2 一模一樣的兩筆：先登記那筆沒標異常、後登記那筆有標（新增時只比對已存在的列）', dupFlags === 'false,true', dupFlags);
  });

  section('migration 20261021233000_mark_salary_period_paid.sql');
  await step('M1 apply twice', () => {
    const r1 = psql(DB, { file: MIG, user: 'sbadmin' });
    check('M1a migration 第一次套用成功（非 superuser 表擁有者身分）', r1.ok, r1.err);
    const r2 = psql(DB, { file: MIG, user: 'sbadmin' });
    check('M1b migration 連續第二次套用成功（可重跑）', r2.ok, r2.err);
    check('M1c 只有一個 mark_salary_period_paid（4 個參數，後兩個選填）',
      must(DB, `SELECT string_agg(oid::regprocedure::text || '/' || pronargdefaults, ',') FROM pg_proc WHERE proname = 'mark_salary_period_paid'`)
        === 'mark_salary_period_paid(date,date,integer,numeric)/2');
  });

  await step('M2 catalog', () => {
    const q = (s) => must(DB, s);
    check('M2a 函式是 SECURITY DEFINER、擁有者 sbadmin（非 superuser）',
      q(`SELECT prosecdef || '|' || pg_get_userbyid(proowner) FROM pg_proc WHERE oid = '${FN}'::regprocedure`) === 'true|sbadmin');
    check('M2b search_path 固定為空字串', q(`SELECT array_to_string(proconfig, ',') FROM pg_proc WHERE oid = '${FN}'::regprocedure`) === 'search_path=""');
    check('M2c anon 不能執行', q(`SELECT has_function_privilege('anon', '${FN}', 'EXECUTE')`) === 'f');
    check('M2d PUBLIC 沒有執行權（ACL 裡沒有 =X/）', !/(^|[{,])=X\//.test(q(`SELECT proacl::text FROM pg_proc WHERE oid = '${FN}'::regprocedure`)),
      q(`SELECT proacl::text FROM pg_proc WHERE oid = '${FN}'::regprocedure`));
    check('M2e authenticated 可以呼叫（是否 admin 由函式內檢查）', q(`SELECT has_function_privilege('authenticated', '${FN}', 'EXECUTE')`) === 't');
  });

  section('權限：只有 admin');
  await step('R non-admin', () => {
    const before = tableMd5();
    const a = asRole(DB, ANON, call("DATE '2026-08-26'", "DATE '2026-09-25'"));
    check('R1 anon 呼叫被拒（permission denied for function）', deniedMsg(a), firstLine(a.err));
    for (const [label, uid] of [['teacher', U.teacher], ['mentor', U.mentor], ['pending', U.pending], ['ghost（沒有 users 列）', U.ghost]]) {
      const r = asRole(DB, authed(uid), call("DATE '2026-08-26'", "DATE '2026-09-25'"));
      check(`R2 ${label} 呼叫回 42501「只有管理員可以標記匯款完成。」`, sqlstate(r, '42501') && /只有管理員可以標記匯款完成/.test(r.err), firstLine(r.err) || r.out);
    }
    check('R3 被拒之後整張表完全沒變（含 updated_at）', tableMd5() === before);
  });

  section('參數檢查（admin 也擋）');
  await step('V validation', () => {
    const before = tableMd5();
    const cases = [
      ['起日 NULL', call('NULL', "DATE '2026-09-25'"), /期間起訖日不正確/],
      ['迄日 NULL', call("DATE '2026-08-26'", 'NULL'), /期間起訖日不正確/],
      ['迄日早於起日', call("DATE '2026-09-25'", "DATE '2026-08-26'"), /期間起訖日不正確/],
      ['區間 55 天（超過一期）', call("DATE '2026-08-01'", "DATE '2026-09-25'"), /一次只能標記一期/],
      ['區間 32 天（1/25～2/25，比最長的一期多一天）', call("DATE '2026-01-25'", "DATE '2026-02-25'"), /一次只能標記一期/],
      ['迄日＝台北今天（這期還沒結束）', call("(now() AT TIME ZONE 'Asia/Taipei')::date - 20", "(now() AT TIME ZONE 'Asia/Taipei')::date"), /結束後才能標記已付款/],
      ['迄日＝台北明天', call("(now() AT TIME ZONE 'Asia/Taipei')::date - 20", "(now() AT TIME ZONE 'Asia/Taipei')::date + 1"), /結束後才能標記已付款/],
    ];
    for (const [label, sql, pattern] of cases) {
      const r = asRole(DB, authed(U.admin), sql);
      check(`V ${label} → 22023`, sqlstate(r, '22023') && pattern.test(r.err), firstLine(r.err) || r.out);
    }
    // 連線時區設成檀香山（比台北晚 18 小時），「今天」仍以台北為準
    const hnl = asRole(DB, authed(U.admin), `SET TIME ZONE 'Pacific/Honolulu';\n${call("(now() AT TIME ZONE 'Asia/Taipei')::date - 20", "(now() AT TIME ZONE 'Asia/Taipei')::date")}`);
    check('V 連線時區是檀香山也照台北日期判斷（迄日＝台北今天仍擋）', sqlstate(hnl, '22023'), firstLine(hnl.err) || hnl.out);
    const ok31 = asRole(DB, authed(U.admin), `BEGIN;\n${call("DATE '2025-12-26'", "DATE '2026-01-25'")}\nROLLBACK;`);
    check('V 最長的一期（12/26～1/25，31 天）可以執行（預演後取消）', ok31.ok && parse(ok31) !== null, firstLine(ok31.err) || ok31.out);
    const yesterday = asRole(DB, authed(U.admin), `BEGIN;\n${call("(now() AT TIME ZONE 'Asia/Taipei')::date - 20", "(now() AT TIME ZONE 'Asia/Taipei')::date - 1")}\nROLLBACK;`);
    check('V 迄日＝台北昨天（這期剛結束）可以執行（預演後取消）', yesterday.ok && parse(yesterday) !== null, firstLine(yesterday.err) || yesterday.out);
    check('V 以上被擋／取消之後整張表完全沒變', tableMd5() === before);
  });

  section('確認框的筆數／金額跟實際不同 → 整批取消');
  await step('E expected guard', () => {
    const before = tableMd5();
    const wrongCount = asRole(DB, authed(U.admin), call("DATE '2026-08-26'", "DATE '2026-09-25'", 7, 4800));
    check('E1 確認時 7 筆、實際 8 筆 → 22023「剛剛有變動（確認時 7 筆、$4,800，現在 8 筆、$4,800）…沒有標記任何紀錄」',
      sqlstate(wrongCount, '22023') && /剛剛有變動（確認時 7 筆、\$4,800，現在 8 筆、\$4,800），這次沒有標記任何紀錄/.test(wrongCount.err), firstLine(wrongCount.err) || wrongCount.out);
    const wrongAmount = asRole(DB, authed(U.admin), call("DATE '2026-08-26'", "DATE '2026-09-25'", 8, 4300));
    check('E2 筆數相同但金額不同（確認時 $4,300、實際 $4,800）→ 22023、沒有標記', sqlstate(wrongAmount, '22023') && /剛剛有變動/.test(wrongAmount.err),
      firstLine(wrongAmount.err) || wrongAmount.out);
    check('E3 兩次都整批取消：整張表完全沒變（含 updated_at）', tableMd5() === before);
  });

  section('admin 標記 9 月期（2026-08-26～2026-09-25）');
  await step('A mark', () => {
    const untouched = Object.keys(ROWS).filter((k) => !P_MARK.includes(k));
    const untouchedBefore = rowsMd5(untouched);
    const r = asRole(DB, authed(U.admin), call("DATE '2026-08-26'", "DATE '2026-09-25'"));
    const result = parse(r);
    check(`A1 回傳 8 筆、$${P_AMOUNT}`, r.ok && result?.marked_count === 8 && Number(result?.marked_amount) === P_AMOUNT, r.err || r.out);
    const marked = must(DB, `SELECT count(*) FILTER (WHERE status = 'paid' AND paid_amount = total_salary)
        || '|' || count(DISTINCT paid_at) || '|' || bool_and(updated_at > TIMESTAMPTZ '2026-10-01 09:00+08')
        || '|' || bool_and(paid_at = '${result?.paid_at}'::timestamptz)
      FROM public.class_sessions WHERE id IN (${idList(P_MARK)})`);
    check('A2 這 8 筆都變成已付款、已領＝總額、paid_at 同一個時間（＝回傳的 paid_at）、updated_at 有更新', marked === '8|1|true|true', marked);
    check('A3 有獎金那筆：已領＝底薪＋獎金 850', statusOf('p_bonus') === 'paid|850.00|850.00', statusOf('p_bonus'));
    check('A4 先付過 100 的那筆：已領改成總額 600（本期匯款＝付清）', statusOf('p_partial') === 'paid|600.00|600.00', statusOf('p_partial'));
    check('A5 別的講師、自動試算、總表匯入的已核准列也都標到了',
      ['p_other', 'p_quoted', 'p_end'].every((k) => statusOf(k).startsWith('paid|')));
    check('A6 邊界：8/25（25 日）與 9/26（26 日）都沒動', statusOf('p_before') === 'approved|0.00|5000.00' && statusOf('p_after') === 'approved|0.00|4000.00',
      `${statusOf('p_before')} / ${statusOf('p_after')}`);
    check('A7 待核准、待定價、退回、已付款、目前這一期的列，整列（含 updated_at）完全沒變', rowsMd5(untouched) === untouchedBefore);
    check('A8 已付款那筆（像 06 標過的列）updated_at 仍是原值 → 96 還原腳本照樣認得它「之後沒人改過」',
      must(DB, `SELECT updated_at = TIMESTAMPTZ '2026-10-01 09:00+08' AND paid_at = TIMESTAMPTZ '2026-09-30 10:00+08' FROM public.class_sessions WHERE id = '${idOf('p_paid')}'`) === 't');
    check('A9 trigger 照常跑：一模一樣的兩筆標完後依現行規則重算，兩筆都標異常（原本只有後登記那筆）',
      must(DB, `SELECT string_agg(is_anomaly::text, ',' ORDER BY id) FROM public.class_sessions WHERE id IN (${idList(['p_dup1', 'p_dup2'])})`) === 'true,true');
    check('A10 三個 trigger 仍是啟用狀態（函式沒有停用 trigger）',
      must(DB, `SELECT string_agg(tgenabled::text, '' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.class_sessions'::regclass AND NOT tgisinternal`) === 'OOO');
  });

  section('重跑');
  await step('B rerun', () => {
    const before = tableMd5();
    const r = asRole(DB, authed(U.admin), call("DATE '2026-08-26'", "DATE '2026-09-25'"));
    const result = parse(r);
    check('B1 同一期再按一次 → 0 筆、$0', r.ok && result?.marked_count === 0 && Number(result?.marked_amount) === 0, r.err || r.out);
    check('B2 重跑後整張表完全沒變（沒有任何列的 updated_at 被碰到）', tableMd5() === before);
    must(DB, `UPDATE public.class_sessions SET status = 'approved' WHERE id = '${idOf('p_pending')}'`);
    const again = parse(asRole(DB, authed(U.admin), call("DATE '2026-08-26'", "DATE '2026-09-25'", 1, 700)));
    check('B3 之後核准了一筆待核准（700）→ 再按一次（確認框 1 筆 $700）只標那 1 筆', again?.marked_count === 1 && Number(again?.marked_amount) === 700
      && statusOf('p_pending') === 'paid|700.00|700.00', JSON.stringify(again));
    // 模擬早期兩個參數的草稿還留在資料庫：重套後應該只剩新版
    must(DB, `CREATE FUNCTION public.mark_salary_period_paid(p_period_start date, p_period_end date) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;`, 'sbadmin');
    const reapply = psql(DB, { file: MIG, user: 'sbadmin' });
    check('B4 用過之後（且有兩參數舊草稿）再重套 migration 仍成功，只剩新版、anon 仍不能執行', reapply.ok
      && must(DB, `SELECT count(*) FROM pg_proc WHERE proname = 'mark_salary_period_paid'`) === '1'
      && must(DB, `SELECT has_function_privilege('anon', '${FN}', 'EXECUTE')`) === 'f', reapply.err);
  });

  section('兩位管理員同時按（8 月期 2026-07-26～2026-08-25）');
  await step('C concurrent', async () => {
    const qBefore = rowsMd5(['q_before']);
    // A：標完先不提交，睡 1.5 秒；B 在這期間按同一期
    const first = psqlAsync(DB, `${roleCtx(authed(U.admin))}BEGIN;\n${call("DATE '2026-07-26'", "DATE '2026-08-25'")}\nSELECT pg_sleep(1.5);\nCOMMIT;`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await psqlAsync(DB, roleCtx(authed(U.admin2)) + call("DATE '2026-07-26'", "DATE '2026-08-25'"));
    const firstResult = await first;
    const a = JSON.parse(firstResult.out.split('\n').find((l) => l.startsWith('{')) || 'null');
    const b = JSON.parse(second.out.split('\n').find((l) => l.startsWith('{')) || 'null');
    check(`C1 先按的那位標到 3 筆、$${Q_AMOUNT}（含 8/25 那筆）`, firstResult.ok && a?.marked_count === 3 && Number(a?.marked_amount) === Q_AMOUNT, firstResult.err || firstResult.out);
    check('C2 後按的那位等前一位完成後回 0 筆（不會重複標、金額不會算兩次）', second.ok && b?.marked_count === 0 && second.ms >= 700,
      `ms=${second.ms} ${second.err || second.out}`);
    const rows = must(DB, `SELECT count(*) FILTER (WHERE status = 'paid') || '|' || count(DISTINCT paid_at) FROM public.class_sessions WHERE id IN (${idList(Q_MARK)})`);
    check('C3 那 3 筆都是已付款、paid_at 只有一個（只被標一次）', rows === '3|1', rows);
    check('C4 Q 期前一天（7/25）沒動', rowsMd5(['q_before']) === qBefore);
    const before = tableMd5();
    const late = asRole(DB, authed(U.admin2), call("DATE '2026-07-26'", "DATE '2026-08-25'", 3, Q_AMOUNT));
    check('C5 後按的那位若帶著自己確認框的 3 筆送出 → 22023「剛剛有變動（…現在 0 筆、$0）」、資料不變',
      sqlstate(late, '22023') && /現在 0 筆、\$0/.test(late.err) && tableMd5() === before, firstLine(late.err) || late.out);
  });
} catch (error) {
  check('腳本本身執行中斷', false, error.stack || error.message);
} finally {
  if (postgres && postgres.exitCode === null) {
    // 只停自己起的那顆（用自己的 data dir）
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8', env: pgEnv });
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
  console.log('ALL PASS: mark_salary_period_paid verified on isolated PostgreSQL');
}
