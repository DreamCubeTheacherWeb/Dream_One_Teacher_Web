#!/usr/bin/env node
// 講師「我的報酬」匯款日 + 總表匯入紀錄標成已付款：在隔離 PostgreSQL 實跑 SQL，斷言寫在程式裡，stdout 就是證據。
//
//   A. migration 20261020150000_salary_payout_schedule.sql
//      （單列表、RLS、欄位層級 UPDATE 權限、trigger 蓋 updated_at／updated_by、可重跑不蓋掉後台已改的日期）
//   B. scripts/salary_master_import/06_mark_imported_paid.sql 與還原 96_rollback_mark_imported_paid.sql
//      （只標 historical_import 且上課日 < 2026-10-01 的列、不重算異常標記、可重跑、可還原、
//        遇 10/1 前的待定價/已退回整批擋下、交易內核對失敗整批取消）
//
// 業主在 Supabase SQL Editor 貼上的是「以資料表擁有者（非 superuser）」身分執行的整份檔案，
// 所以 SQL 檔一律用非 superuser 的 sbadmin 角色（class_sessions 的擁有者）整檔執行；
// 權限測試用 SET ROLE anon／authenticated + request.jwt.claims 模擬 PostgREST。
// 只連本機臨時 PostgreSQL（Unix socket，不開 TCP），不碰任何正式環境。
//
// 用法：cd 培訓web && npm run verify:salary-payout-schedule
// 注意：PostgreSQL 需要 System V 共享記憶體；在 Claude Code 的 Bash 沙盒內 initdb 會被擋
// （shmget: Operation not permitted），要在沙盒外跑（一般終端機直接跑即可）。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..');
// 三份 SQL 路徑可用環境變數覆蓋——只用來做「突變測試」（拿故意改壞的副本確認本腳本抓得到），平常不要設
const FILES = {
  migration: process.env.PAYDAY_MIGRATION_SQL || path.join(appDir, 'supabase/migrations/20261020150000_salary_payout_schedule.sql'),
  mark: process.env.PAYDAY_MARK_SQL || path.join(repoRoot, 'scripts/salary_master_import/06_mark_imported_paid.sql'),
  rollback: process.env.PAYDAY_ROLLBACK_SQL || path.join(repoRoot, 'scripts/salary_master_import/96_rollback_mark_imported_paid.sql'),
};
const BACKUP_TABLE = 'public.class_sessions_paid_backfill_20261020';

// ───────────────────────── 臨時 PostgreSQL ─────────────────────────
const dir = mkdtempSync(path.join(tmpdir(), 'd1-payday-'));
const dataDir = path.join(dir, 'data');
const pgEnv = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', PGCLIENTENCODING: 'UTF8' };
// 只用 Unix socket（listen_addresses 為空），port 只是 socket 檔名的一部分
const port = 54000 + Math.floor(Math.random() * 900);

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv, ...opts });

function psql(db, { sql, file, user = 'postgres' } = {}) {
  const args = ['-X', '-q', '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1',
    '-h', dir, '-p', String(port), '-U', user, '-d', db, '-f', file ?? '-'];
  const t0 = Date.now();
  const r = sh('psql', args, file ? {} : { input: sql });
  // NOTICE（例如重跑時的「already exists, skipping」）不是錯誤，分開放；路徑縮短讓輸出好讀
  const lines = (r.stderr || '').replaceAll(repoRoot, '<repo>').split('\n');
  return {
    ok: r.status === 0,
    status: r.status,
    out: (r.stdout || '').trim(),
    err: lines.filter((l) => !/NOTICE:/.test(l)).join('\n').trim(),
    notices: lines.filter((l) => /NOTICE:/.test(l)).length,
    ms: Date.now() - t0,
  };
}
// 預期成功的查詢：失敗就丟例外（會被記成 FAIL）
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
  ? 'SET ROLE anon;\n'
  : `SET ROLE authenticated;\nSET request.jwt.claims = '${JSON.stringify({ sub: who.uid, role: 'authenticated' })}';\n`);
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
// 一整段測試若意外丟例外，記一筆 FAIL 後繼續跑下一段
function step(name, fn) {
  try { fn(); } catch (error) { check(`${name}（執行中斷）`, false, error.message); }
}
const deniedMsg = (r) => !r.ok && /permission denied/i.test(r.err);
const firstLine = (s) => (s || '').split('\n')[0];

// ───────────────────────── 共用 bootstrap（模擬 Supabase） ─────────────────────────
const BOOT_COMMON = `
CREATE SCHEMA auth;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
-- 與 Supabase 的 auth.uid() 相同：讀 request.jwt.claims 的 sub
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
`;

const U = {
  teacher: '00000000-0000-4000-8000-000000000001',
  mentor: '00000000-0000-4000-8000-000000000002',
  admin: '00000000-0000-4000-8000-000000000003',
  admin2: '00000000-0000-4000-8000-000000000004',
  pending: '00000000-0000-4000-8000-000000000005',
  ghost: '00000000-0000-4000-8000-000000000006', // 有登入帳號但 public.users 沒有對應列
};
const authed = (uid) => ({ role: 'authenticated', uid });
const ANON = { role: 'anon' };

let postgres;
let postgresLogs = '';
const startedAt = Date.now();

try {
  // initdb 的 --no-locale 讓資料庫本身用 C；LC_ALL 只影響 postmaster 啟動行為
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

  // 非 superuser、擁有 class_sessions／新資料表的角色：模擬 Supabase SQL Editor 的 postgres 角色
  must('postgres', `
    CREATE ROLE sbadmin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE DATABASE pa;
    CREATE DATABASE tpl_b;
  `);

  // ═══════════════════════════════════════════════════════════════════
  // A. migration 20261020150000_salary_payout_schedule.sql
  // ═══════════════════════════════════════════════════════════════════
  section('A. migration 20261020150000_salary_payout_schedule.sql');
  const MIG = FILES.migration;
  const SCHED = 'public.salary_payout_schedule';
  const readSched = () => must('pa', `SELECT count(*) || '|' || coalesce(string_agg(to_char(next_payday,'YYYY-MM-DD') || '|' || regular_day, ';'), '') FROM ${SCHED}`);

  step('A bootstrap', () => {
    must('pa', `${BOOT_COMMON}
      CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);
      ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
      CREATE POLICY users_select_own ON public.users FOR SELECT TO authenticated USING (id = auth.uid());
      GRANT SELECT ON public.users TO authenticated;
      INSERT INTO auth.users (id, email) VALUES
        ('${U.teacher}', 'teacher@test.local'), ('${U.mentor}', 'mentor@test.local'),
        ('${U.admin}', 'admin@test.local'), ('${U.admin2}', 'admin2@test.local'),
        ('${U.pending}', 'pending@test.local'), ('${U.ghost}', 'ghost@test.local');
      INSERT INTO public.users (id, name, email, role) VALUES
        ('${U.teacher}', '講師', 'teacher@test.local', 'teacher'),
        ('${U.mentor}', '導師', 'mentor@test.local', 'mentor'),
        ('${U.admin}', '管理員一', 'admin@test.local', 'admin'),
        ('${U.admin2}', '管理員二', 'admin2@test.local', 'admin'),
        ('${U.pending}', '待審', 'pending@test.local', 'pending');
    `);
  });

  step('A1 apply twice', () => {
    const r1 = psql('pa', { file: MIG, user: 'sbadmin' });
    check('A1a migration 第一次套用成功（非 superuser 擁有者身分）', r1.ok, r1.err);
    const r2 = psql('pa', { file: MIG, user: 'sbadmin' });
    check('A1b migration 連續第二次套用成功', r2.ok, r2.err);
    check('A1c 只有 1 列，next_payday=2026-11-10、regular_day=10', readSched() === '1|2026-11-10|10', readSched());
  });

  step('A2 reapply keeps admin edit', () => {
    const upd = asRole('pa', authed(U.admin),
      `WITH u AS (UPDATE ${SCHED} SET next_payday = DATE '2026-12-10', regular_day = 15 RETURNING 1) SELECT count(*) FROM u;`);
    check('A2a admin 把匯款日改成 2026-12-10、每月固定日改 15', upd.ok && upd.out === '1', upd.err || upd.out);
    const r3 = psql('pa', { file: MIG, user: 'sbadmin' });
    check('A2b 後台改過之後第三次重套仍成功', r3.ok, r3.err);
    check('A2c 重套後值沒被蓋回預設（仍是 2026-12-10／15，仍只有 1 列）', readSched() === '1|2026-12-10|15', readSched());
  });

  step('A3 catalog', () => {
    const q = (s) => must('pa', s);
    check('A3a RLS 已啟用', q(`SELECT relrowsecurity FROM pg_class WHERE oid = '${SCHED}'::regclass`) === 't');
    check('A3b 剛好 2 條 policy（SELECT／UPDATE），重套沒有重複',
      q(`SELECT string_agg(cmd, ',' ORDER BY cmd) FROM pg_policies WHERE schemaname='public' AND tablename='salary_payout_schedule'`) === 'SELECT,UPDATE');
    check('A3c 剛好 1 個 trigger（BEFORE UPDATE）',
      q(`SELECT count(*) FROM pg_trigger WHERE tgrelid='${SCHED}'::regclass AND NOT tgisinternal`) === '1');
    check('A3d anon 對該表沒有任何表層權限',
      q(`SELECT bool_or(has_table_privilege('anon','${SCHED}',p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`) === 'f');
    check('A3e authenticated 表層只有 SELECT（沒有 INSERT／DELETE／TRUNCATE）',
      q(`SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('authenticated','${SCHED}',p)`) === 'SELECT');
    check('A3f authenticated 只能更新 next_payday、regular_day 兩欄（id／updated_at／updated_by 不行）',
      q(`SELECT string_agg(c, ',' ORDER BY c) FROM unnest(ARRAY['id','next_payday','regular_day','updated_at','updated_by']) c WHERE has_column_privilege('authenticated','${SCHED}',c,'UPDATE')`) === 'next_payday,regular_day');
    check('A3g stamp trigger 函式 anon／authenticated 都不能直接 EXECUTE',
      q(`SELECT has_function_privilege('anon','public.stamp_salary_payout_schedule()','EXECUTE') OR has_function_privilege('authenticated','public.stamp_salary_payout_schedule()','EXECUTE')`) === 'f');
  });

  step('A4 select visibility', () => {
    const sel = (who) => asRole('pa', who, `SELECT count(*) FROM ${SCHED};`);
    for (const [label, uid] of [['teacher', U.teacher], ['mentor', U.mentor], ['admin', U.admin]]) {
      const r = sel(authed(uid));
      check(`A4 ${label} 讀得到那 1 列`, r.ok && r.out === '1', r.err || r.out);
    }
    const p = sel(authed(U.pending));
    check('A4d role=pending 的使用者讀到 0 列', p.ok && p.out === '0', p.err || p.out);
    const g = sel(authed(U.ghost));
    check('A4e 有登入帳號但 public.users 沒列的人讀到 0 列', g.ok && g.out === '0', g.err || g.out);
    const a = sel(ANON);
    check('A4f anon 直接 SELECT 被拒（permission denied）', deniedMsg(a), a.err || a.out);
  });

  step('A5 non-admin cannot update', () => {
    const before = readSched();
    for (const [label, uid] of [['teacher', U.teacher], ['mentor', U.mentor], ['pending', U.pending], ['ghost', U.ghost]]) {
      const r = asRole('pa', authed(uid),
        `WITH u AS (UPDATE ${SCHED} SET next_payday = DATE '2030-01-01' RETURNING 1) SELECT count(*) FROM u;`);
      const blocked = (r.ok && r.out === '0') || deniedMsg(r) || (!r.ok && /row-level security/i.test(r.err));
      check(`A5 ${label} UPDATE next_payday 被擋（0 列受影響或被拒）`, blocked && readSched() === before,
        r.ok ? `affected=${r.out}` : firstLine(r.err));
    }
    const a = asRole('pa', ANON, `UPDATE ${SCHED} SET next_payday = DATE '2030-01-01';`);
    check('A5e anon UPDATE 被拒且值不變', deniedMsg(a) && readSched() === before, firstLine(a.err));
  });

  step('A6 admin update + stamping', () => {
    const before = must('pa', `SELECT updated_at::text FROM ${SCHED}`);
    must('pa', 'SELECT pg_sleep(0.05)');
    const r = asRole('pa', authed(U.admin),
      `WITH u AS (UPDATE ${SCHED} SET next_payday = DATE '2027-01-11', regular_day = 11 RETURNING 1) SELECT count(*) FROM u;`);
    check('A6a admin UPDATE next_payday＋regular_day 成功（1 列）', r.ok && r.out === '1', r.err || r.out);
    check('A6b 值確實改成 2027-01-11／11', readSched() === '1|2027-01-11|11', readSched());
    check('A6c updated_by 自動等於該 admin 的 uid',
      must('pa', `SELECT updated_by::text FROM ${SCHED}`) === U.admin);
    check('A6d updated_at 有更新（比改之前新）',
      must('pa', `SELECT updated_at > '${before}'::timestamptz FROM ${SCHED}`) === 't', `before=${before}`);
    must('pa', 'SELECT pg_sleep(0.05)');
    const r2 = asRole('pa', authed(U.admin2),
      `WITH u AS (UPDATE ${SCHED} SET regular_day = 12 RETURNING 1) SELECT count(*) FROM u;`);
    check('A6e 換另一位 admin 改 → updated_by 跟著換成他（不是舊值）',
      r2.ok && r2.out === '1' && must('pa', `SELECT updated_by::text FROM ${SCHED}`) === U.admin2, r2.err);
  });

  step('A7 admin column guard', () => {
    const snapshot = must('pa', `SELECT to_jsonb(s)::text FROM ${SCHED} s`);
    const cases = [
      ['updated_by', `UPDATE ${SCHED} SET updated_by = '${U.teacher}'`],
      ['id', `UPDATE ${SCHED} SET id = false`],
      ['updated_at', `UPDATE ${SCHED} SET updated_at = now() - interval '1 year'`],
    ];
    for (const [col, sql] of cases) {
      const r = asRole('pa', authed(U.admin), `${sql};`);
      check(`A7 admin 直接 UPDATE ${col} 被拒（欄位層級權限）`, deniedMsg(r), firstLine(r.err));
    }
    check('A7d 被拒之後整列資料完全沒變', must('pa', `SELECT to_jsonb(s)::text FROM ${SCHED} s`) === snapshot);
  });

  step('A8 no insert/delete', () => {
    const ins = asRole('pa', authed(U.admin),
      `INSERT INTO ${SCHED} (id, next_payday, regular_day) VALUES (false, DATE '2030-01-01', 10);`);
    check('A8a admin INSERT 第二列被拒', deniedMsg(ins), firstLine(ins.err));
    const del = asRole('pa', authed(U.admin), `DELETE FROM ${SCHED};`);
    check('A8b admin DELETE 那一列被拒', deniedMsg(del), firstLine(del.err));
    const insT = asRole('pa', authed(U.teacher),
      `INSERT INTO ${SCHED} (id, next_payday, regular_day) VALUES (false, DATE '2030-01-01', 10);`);
    const delT = asRole('pa', authed(U.teacher), `DELETE FROM ${SCHED};`);
    check('A8c teacher INSERT／DELETE 也都被拒', deniedMsg(insT) && deniedMsg(delT), `${firstLine(insT.err)} / ${firstLine(delT.err)}`);
    check('A8d 整張表仍然只有 1 列', must('pa', `SELECT count(*) FROM ${SCHED}`) === '1');
  });

  step('A9 check constraint', () => {
    const before = readSched();
    for (const bad of [29, 0, -1]) {
      const r = asRole('pa', authed(U.admin), `UPDATE ${SCHED} SET regular_day = ${bad};`);
      check(`A9 regular_day=${bad} 被 CHECK 擋下`, !r.ok && /check constraint|violates/i.test(r.err), firstLine(r.err));
    }
    const nul = asRole('pa', authed(U.admin), `UPDATE ${SCHED} SET next_payday = NULL;`);
    check('A9d next_payday=NULL 被 NOT NULL 擋下', !nul.ok && /not-null|null value/i.test(nul.err), firstLine(nul.err));
    check('A9e 被擋之後值沒變', readSched() === before, readSched());
    const lo = asRole('pa', authed(U.admin), `WITH u AS (UPDATE ${SCHED} SET regular_day = 1 RETURNING 1) SELECT count(*) FROM u;`);
    const hi = asRole('pa', authed(U.admin), `WITH u AS (UPDATE ${SCHED} SET regular_day = 28 RETURNING 1) SELECT count(*) FROM u;`);
    check('A9f 邊界值 1 與 28 可以寫入', lo.ok && lo.out === '1' && hi.ok && hi.out === '1' && readSched().endsWith('|28'), `${lo.err}${hi.err}`);
  });

  // ═══════════════════════════════════════════════════════════════════
  // B. 06_mark_imported_paid.sql／96_rollback_mark_imported_paid.sql
  // ═══════════════════════════════════════════════════════════════════
  section('B. 06_mark_imported_paid.sql／96_rollback_mark_imported_paid.sql');

  // B 的 schema：照正式庫的 migration 鏈（含 trg_session_anomaly、pricing guard、updated_at trigger）建一份樣板，
  // 各情境用 CREATE DATABASE ... TEMPLATE 複製，互不污染。
  const appliedChain = [];
  step('B bootstrap template', () => {
    must('tpl_b', `${BOOT_COMMON}
      CREATE TYPE public.instructor_role_enum AS ENUM ('S', 'A+', 'A', 'B', '實習');
      CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, email text, role text);
      CREATE TABLE public.instructors (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id uuid UNIQUE REFERENCES auth.users(id),
        full_name text NOT NULL,
        instructor_role public.instructor_role_enum,
        speed_qualification text,
        employment_status text DEFAULT 'active'
      );
      GRANT SELECT ON public.users, public.instructors TO authenticated;
      -- PostgreSQL 16 不接受 to_char 當衍生欄位；用 IMMUTABLE 包一層，month_label 仍是衍生欄位
      CREATE FUNCTION public._month_label(d date) RETURNS text IMMUTABLE LANGUAGE sql AS $$ SELECT to_char(d, 'YYYY/MM') $$;
    `);
    const baseSql = readFileSync(path.join(appDir, 'supabase/2025_salary_system.sql'), 'utf8');
    const target = "to_char(session_date, 'YYYY/MM')";
    if (!baseSql.includes(target)) throw new Error('month_label workaround target not found in 2025_salary_system.sql');
    const basePath = path.join(dir, 'base_2025_salary_system.sql');
    writeFileSync(basePath, baseSql.replace(target, 'public._month_label(session_date)'));
    mustFile('tpl_b', basePath);
    appliedChain.push('2025_salary_system.sql');
    for (const mig of [
      '20260826105841_restore_salary_workflow.sql',
      '20261018120000_align_salary_report_with_forms.sql',
      '20261018150000_limit_instructor_salary_visibility.sql',
      '20261019120000_salary_master_quarantine.sql',
      '20261019220000_partner_units_by_term_and_period_labels.sql',
      '20261020130000_report_periods_and_custom_fields.sql',
    ]) {
      mustFile('tpl_b', path.join(appDir, 'supabase/migrations', mig));
      appliedChain.push(mig);
    }
    // 正式庫的 class_sessions 由 postgres（非 superuser）擁有：照這個擁有關係跑 06／96
    must('tpl_b', `ALTER TABLE public.class_sessions OWNER TO sbadmin;`);
    const trg = must('tpl_b', `SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid='public.class_sessions'::regclass AND NOT tgisinternal`);
    check('B0 樣板庫：class_sessions 具備正式庫的三個 trigger（updated_at／pricing guard／異常偵測）',
      trg === 'trg_class_sessions_updated_at,trg_guard_class_session_pricing,trg_session_anomaly', trg);
    check('B0b 樣板庫：class_sessions 擁有者是非 superuser 的 sbadmin',
      must('tpl_b', `SELECT r.rolname || ',' || r.rolsuper::text FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.class_sessions'::regclass`) === 'sbadmin,false');
  });
  must('postgres', `CREATE DATABASE scn_main TEMPLATE tpl_b; CREATE DATABASE scn_blocked TEMPLATE tpl_b; CREATE DATABASE scn_guard TEMPLATE tpl_b; CREATE DATABASE scn_scale TEMPLATE tpl_b;`);

  // 06 只標「上課日 < 2026-10-01」的匯入列（業主：10 月的課 11/10 才匯）
  const CUTOFF = '2026-10-01';
  const isHist = (r) => r.source === 'historical_import';
  const inScope = (r) => isHist(r) && r.session_date < CUTOFF; // jsonb 的日期是 'YYYY-MM-DD'，字串比較即可
  const outScope = (r) => isHist(r) && r.session_date >= CUTOFF;

  // ── 假資料 ──
  const I1 = '10000000-0000-4000-8000-000000000001';
  const I2 = '10000000-0000-4000-8000-000000000002';
  const rid = (n) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
  const insertRow = (row) => {
    const r = {
      course_type: 'onsite_1_5hr', course_name: null, instructor: I1, session_date: '2026-03-01', duration_hours: 1.5,
      base_salary: 0, bonus: 0, paid_amount: 0, status: 'approved', paid_at: null, source: 'historical_import',
      pricing_status: 'legacy', manual_adjustment_reason: null, ...row,
    };
    return `INSERT INTO public.class_sessions (id, course_type, course_name, instructor_id, instructor_name, session_date, duration_hours,
      base_salary, bonus, paid_amount, status, paid_at, source, pricing_status, manual_adjustment_reason)
      VALUES (${lit(r.id)}, ${lit(r.course_type)}, ${lit(r.course_name)}, ${lit(r.instructor)}, ${lit(r.instructor === I1 ? '講師甲' : '講師乙')},
      ${lit(r.session_date)}, ${lit(r.duration_hours)}, ${lit(r.base_salary)}, ${lit(r.bonus)}, ${lit(r.paid_amount)}, ${lit(r.status)},
      ${lit(r.paid_at)}, ${lit(r.source)}, ${lit(r.pricing_status)}, ${lit(r.manual_adjustment_reason)});`;
  };
  const seedInstructors = `INSERT INTO public.instructors (id, full_name) VALUES ('${I1}', '講師甲'), ('${I2}', '講師乙');`;

  const ID = {
    h01: rid(1), h02: rid(2), h03: rid(3), h04: rid(4), h05: rid(5), h06: rid(6), h07: rid(7), h08: rid(8),
    h09: rid(9), h10: rid(10), h11: rid(11), h12: rid(12), d1: rid(13), d2: rid(14),
    e1: rid(15), e2: rid(16), e3: rid(17), e4: rid(18),
    m1: rid(21), m2: rid(22), m3: rid(23), s1: rid(24), n1: rid(25),
  };
  const MAIN_ROWS = [
    // ── historical_import、上課日 < 10/1（06 要標成已付款）──
    { id: ID.h01, course_name: 'C1', base_salary: 1000, session_date: '2026-03-01' }, // approved、已領 0
    { id: ID.h02, course_name: 'C2', base_salary: 800, bonus: 200, session_date: '2026-03-02' }, // 含獎金（total 1000）
    { id: ID.h03, course_name: 'C3', base_salary: 500, paid_amount: 500, status: 'paid', paid_at: '2026-04-01 09:00:00+08', session_date: '2026-03-03' }, // 已付且金額相等：不該被動
    { id: ID.h04, course_name: 'C4', base_salary: 700, paid_amount: 300, paid_at: '2026-03-31 10:00:00+08', session_date: '2026-03-04' }, // 已領金額非 0 但不等於 total
    { id: ID.h05, course_name: 'C5', base_salary: 400, paid_amount: 100, status: 'paid', paid_at: '2026-04-02 09:00:00+08', session_date: '2026-03-05' }, // status 已是 paid 但金額不符
    { id: ID.h06, course_name: 'C6', base_salary: 900, paid_amount: null, session_date: '2026-03-06' }, // 已領金額 NULL
    { id: ID.h07, course_name: 'C7', base_salary: 450, bonus: 50, status: 'pending', session_date: '2026-03-07' }, // 舊版 pending
    { id: ID.h08, course_name: 'C8', base_salary: 0, duration_hours: 2, session_date: '2026-03-08' }, // 本來就異常：有時數但薪資 0
    { id: ID.h09, course_name: 'C9', base_salary: 650, session_date: '2026-03-09' }, // 之後用 UPDATE 造出「人工異常標記」
    { id: ID.h10, course_name: 'C10', base_salary: 300, session_date: '2019-05-05' }, // 本來就異常：2020 年前
    { id: ID.h12, course_name: 'C12', base_salary: 600, pricing_status: 'manual_override', manual_adjustment_reason: '人工調整測試', session_date: '2026-03-12' }, // 會過 pricing guard 的 UPDATE 路徑
    { id: ID.d1, course_name: 'DupCourse', instructor: I2, base_salary: 1200, session_date: '2026-03-15' }, // 重複列的先到那筆
    { id: ID.d2, course_name: 'DupCourse', instructor: I2, base_salary: 1200, session_date: '2026-03-15' }, // 後到那筆（insert 時被標成異常）
    { id: ID.e1, course_name: 'E1', base_salary: 1000, session_date: '2026-09-30' }, // 邊界：9/30 要被標成已付款
    // ── historical_import、上課日 >= 10/1（06 不准動）──
    { id: ID.h11, course_name: 'C11', base_salary: 300, session_date: '2099-01-01' }, // 本來就異常：日期太遠；不動
    { id: ID.e2, course_name: 'E2', base_salary: 1000, session_date: '2026-10-01' }, // 邊界：10/1 不能動
    { id: ID.e3, course_name: 'E3', base_salary: 700, bonus: 50, paid_amount: 100, session_date: '2026-10-15' }, // 10 月、已領非 0：不動
    { id: ID.e4, course_name: 'E4', base_salary: 500, session_date: '2026-10-31' },
    // ── 非 historical_import：06 一律不准動 ──
    { id: ID.m1, source: 'manual', course_name: 'M1', instructor: I2, base_salary: 1000, session_date: '2026-03-20' },
    { id: ID.m2, source: 'manual', status: 'pending', course_name: 'M2', instructor: I2, base_salary: 500, session_date: '2026-03-21' },
    { id: ID.m3, source: 'manual', status: 'pending', course_name: 'M3', instructor: I2, base_salary: null, pricing_status: 'needs_review', session_date: '2026-03-22' }, // 手動的待定價不該擋 06
    { id: ID.s1, source: 'self_report', course_name: 'S1', instructor: I2, base_salary: 800, session_date: '2026-03-23' },
    { id: ID.n1, source: null, course_name: 'N1', instructor: I2, base_salary: 300, session_date: '2026-03-24' },
  ];

  const snap = (db) => {
    const arr = JSON.parse(must(db, `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id), '[]'::jsonb) FROM public.class_sessions t`));
    return new Map(arr.map((r) => [r.id, r]));
  };
  const backupRows = (db) => JSON.parse(must(db, `SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.session_id), '[]'::jsonb) FROM ${BACKUP_TABLE} b`));
  const diffKeys = (a, b) => Object.keys({ ...a, ...b }).filter((k) => !isDeepStrictEqual(a[k], b[k]));
  const tgState = (db, name = 'trg_session_anomaly') =>
    must(db, `SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.class_sessions'::regclass AND tgname='${name}'`);
  const sameMap = (a, b) => a.size === b.size && [...a.keys()].every((k) => isDeepStrictEqual(a.get(k), b.get(k)));
  const ts = (v) => (v === null || v === undefined ? null : new Date(v).getTime());
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  const noBackupTable = (db) => must(db, `SELECT to_regclass('${BACKUP_TABLE}') IS NULL`) === 't';
  // 06／96 在 COMMIT 之後印的核對表：來源|狀態|筆數|報酬合計|未付金額|最早上課日|最晚上課日|已備份原值筆數（96 只有前 5 欄）
  const parseSummary = (out) => out.split('\n').filter(Boolean).map((l) => {
    const c = l.split('|');
    return { source: c[0], status: c[1], count: Number(c[2]), total: c[3], unpaid: c[4], minDate: c[5], maxDate: c[6], backups: c[7] };
  });
  const histSummary = (out) => parseSummary(out).filter((s) => s.source === 'historical_import');
  const SUMMARY_NOTE = (out) => out.split('\n').filter((l) => l.startsWith('historical')).join(' // ');

  let pre;
  let needs;
  let post;
  let bk1;

  step('B1 fixture', () => {
    must('scn_main', seedInstructors + MAIN_ROWS.map(insertRow).join('\n'));
    // 造出「人工異常標記」：必須在 trigger 停用下才寫得進去（否則 trigger 會立刻重算掉）
    must('scn_main', `
      ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
      UPDATE public.class_sessions SET is_anomaly = true, anomaly_reasons = ARRAY['人工標記'] WHERE id = '${ID.h09}';
      ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
    `);
    pre = snap('scn_main');
    const hist = [...pre.values()].filter(isHist);
    needs = hist.filter((r) => inScope(r) && (r.status !== 'paid' || r.paid_amount === null || Number(r.paid_amount) !== Number(r.total_salary)));
    check('B1a 假資料到位：historical_import 18 筆（10/1 前 14、10/1 起 4）、其他來源 5 筆（含手動待定價、source=NULL）',
      hist.length === 18 && hist.filter(inScope).length === 14 && hist.filter(outScope).length === 4 && pre.size === 23,
      `hist=${hist.length} in=${hist.filter(inScope).length} out=${hist.filter(outScope).length} total=${pre.size}`);
    check('B1b 預計要被改的 10/1 前匯入列有 13 筆（只有已付且金額相等的 h03 不用改）',
      needs.length === 13 && !needs.some((r) => r.id === ID.h03), `needs=${needs.length}`);
    check('B1c 日期邊界到位：e1=2026-09-30（範圍內）、e2=2026-10-01（範圍外），都是 approved 未付',
      pre.get(ID.e1).session_date === '2026-09-30' && inScope(pre.get(ID.e1)) && pre.get(ID.e2).session_date === '2026-10-01'
      && outScope(pre.get(ID.e2)) && pre.get(ID.e1).status === 'approved' && pre.get(ID.e2).status === 'approved');
    check('B1d 重複列狀態：先到的 d1 is_anomaly=false、後到的 d2 is_anomaly=true（只有一筆異常）',
      pre.get(ID.d1).is_anomaly === false && pre.get(ID.d2).is_anomaly === true, `d1=${pre.get(ID.d1).is_anomaly} d2=${pre.get(ID.d2).is_anomaly}`);
    check('B1e 其他既有異常標記就位（h08 時數無薪、h09 人工標記、h10 日期異常、h11 2099 年）',
      pre.get(ID.h08).is_anomaly && pre.get(ID.h09).is_anomaly && isDeepStrictEqual(pre.get(ID.h09).anomaly_reasons, ['人工標記'])
      && pre.get(ID.h10).is_anomaly && pre.get(ID.h11).is_anomaly, '');
    check('B1f 執行前 trg_session_anomaly 是啟用狀態（tgenabled=O）', tgState('scn_main') === 'O');
    // 對照組：如果 trigger 沒被暫停，只改付款狀態就會把 d1 也重算成異常——證明下面「異常標記不變」的斷言抓得到這個問題
    const control = must('scn_main', `
      BEGIN;
      UPDATE public.class_sessions SET status = 'paid', paid_amount = total_salary WHERE id = '${ID.d1}';
      SELECT is_anomaly FROM public.class_sessions WHERE id = '${ID.d1}';
      ROLLBACK;
    `);
    check('B1g 對照組：若不暫停 trigger，d1 會被重算成異常（斷言有效性證明；已 ROLLBACK）',
      control.split('\n').includes('t') && sameMap(pre, snap('scn_main')), control);
  });

  step('B2 first run of 06', () => {
    const r = psql('scn_main', { file: FILES.mark, user: 'sbadmin' });
    check('B2a 06 整檔執行成功（非 superuser 擁有者身分）', r.ok, r.err);
    post = snap('scn_main');
    const inRows = [...post.values()].filter(inScope);
    check('B2b 10/1 前的匯入列全部 status=paid 且 paid_amount=total_salary（14/14）',
      inRows.length === 14 && inRows.every((x) => x.status === 'paid' && num(x.paid_amount) === num(x.total_salary)),
      inRows.filter((x) => !(x.status === 'paid' && num(x.paid_amount) === num(x.total_salary))).map((x) => x.id).join(','));
    const outPre = [...pre.values()].filter(outScope);
    const outChanged = outPre.filter((p) => !isDeepStrictEqual(p, post.get(p.id)));
    check('B2c 10/1（含）以後的 4 筆匯入列整列完全沒變（連 updated_at 都沒變；含 2099 年的 h11）',
      outPre.length === 4 && outChanged.length === 0, outChanged.map((p) => `${p.id}:${diffKeys(p, post.get(p.id))}`).join(' | '));
    check('B2d 邊界：2026-09-30 的 e1 被標成已付款、2026-10-01 的 e2 維持 approved／已領 0',
      post.get(ID.e1).status === 'paid' && num(post.get(ID.e1).paid_amount) === num(post.get(ID.e1).total_salary)
      && post.get(ID.e2).status === 'approved' && num(post.get(ID.e2).paid_amount) === 0 && isDeepStrictEqual(pre.get(ID.e2), post.get(ID.e2)),
      `e1=${post.get(ID.e1).status}/${post.get(ID.e1).paid_amount} e2=${post.get(ID.e2).status}/${post.get(ID.e2).paid_amount}`);
    const badNeeds = needs.filter((p) => {
      const d = diffKeys(p, post.get(p.id));
      return d.some((k) => !['status', 'paid_amount', 'updated_at'].includes(k)) || !d.includes('updated_at');
    });
    check('B2e 被改的 13 筆只有 status／paid_amount（及 updated_at）變動，paid_at 等其他欄位完全沒動',
      badNeeds.length === 0, badNeeds.map((p) => `${p.id}:${diffKeys(p, post.get(p.id))}`).join(' | '));
    check('B2f paid_at 原樣保留（h04 原有時間、h01 仍為 NULL）',
      ts(post.get(ID.h04).paid_at) === ts(pre.get(ID.h04).paid_at) && post.get(ID.h04).paid_at !== null && post.get(ID.h01).paid_at === null);
    check('B2g 本來就已付且金額相等的 h03 整列完全沒被碰（連 updated_at 都沒變）',
      isDeepStrictEqual(pre.get(ID.h03), post.get(ID.h03)));
    const nonHist = [...pre.values()].filter((p) => !isHist(p));
    check('B2h 非 historical_import 的 5 筆（manual 核准／pending／待定價、self_report、source=NULL）整列完全沒變',
      nonHist.length === 5 && nonHist.every((p) => isDeepStrictEqual(p, post.get(p.id))),
      nonHist.filter((p) => !isDeepStrictEqual(p, post.get(p.id))).map((p) => p.id).join(','));
    const anomalyChanged = [...pre.values()].filter((p) => !isDeepStrictEqual(
      [p.is_anomaly, p.anomaly_reasons], [post.get(p.id).is_anomaly, post.get(p.id).anomaly_reasons]));
    check('B2i 每一列的 is_anomaly／anomaly_reasons 與執行前一模一樣（23/23）',
      anomalyChanged.length === 0, anomalyChanged.map((p) => p.id).join(','));
    check('B2j 重複列沒有被重算成兩筆都異常（d1=false、d2=true，人工標記 h09 仍在）',
      post.get(ID.d1).is_anomaly === false && post.get(ID.d2).is_anomaly === true
      && post.get(ID.h09).is_anomaly === true && isDeepStrictEqual(post.get(ID.h09).anomaly_reasons, ['人工標記']),
      `d1=${post.get(ID.d1).is_anomaly} d2=${post.get(ID.d2).is_anomaly}`);
    check('B2k 執行後 trg_session_anomaly 仍是啟用（tgenabled=O），其他兩個 trigger 也沒被動',
      tgState('scn_main') === 'O' && tgState('scn_main', 'trg_guard_class_session_pricing') === 'O'
      && tgState('scn_main', 'trg_class_sessions_updated_at') === 'O');

    bk1 = backupRows('scn_main');
    const expectIds = needs.map((p) => p.id).sort();
    check('B2l 備份表筆數＝實際被改的列數（13），且不含 h03、不含任何 10/1 以後的列',
      bk1.length === 13 && isDeepStrictEqual(bk1.map((b) => b.session_id).sort(), expectIds), `backup=${bk1.length}`);
    const badBackup = bk1.filter((b) => {
      const p = pre.get(b.session_id);
      return b.old_status !== p.status || num(b.old_paid_amount) !== num(p.paid_amount) || ts(b.old_paid_at) !== ts(p.paid_at);
    });
    check('B2m 備份內容是執行前的原值（status／paid_amount／paid_at 逐列相同，含 NULL）',
      badBackup.length === 0, badBackup.map((b) => b.session_id).join(','));
    check('B2n 備份表已啟用 RLS，且 anon／authenticated 完全沒有權限（網站讀不到）',
      must('scn_main', `SELECT relrowsecurity FROM pg_class WHERE oid='${BACKUP_TABLE}'::regclass`) === 't'
      && must('scn_main', `SELECT bool_or(has_table_privilege(r, '${BACKUP_TABLE}', p)) FROM unnest(ARRAY['anon','authenticated']) r, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`) === 'f');

    const hs = histSummary(r.out);
    const paidLine = hs.find((s) => s.status === 'paid');
    const apprLine = hs.find((s) => s.status === 'approved');
    check('B2o 核對表（COMMIT 之後）：historical_import 只有兩列——paid（14 筆、未付 0、最晚 2026-09-30）與 approved（4 筆、最早 2026-10-01 起、仍有未付）；已備份 13',
      hs.length === 2 && paidLine && apprLine
      && paidLine.count === 14 && Number(paidLine.unpaid) === 0 && paidLine.maxDate === '2026-09-30' && paidLine.backups === '13'
      && apprLine.count === 4 && Number(apprLine.unpaid) > 0 && apprLine.minDate >= CUTOFF, SUMMARY_NOTE(r.out));
    const sum = parseSummary(r.out);
    check('B2p 核對表也看得到其他來源沒被改（manual 仍有 approved 1／pending 2 筆、未付金額仍在）',
      sum.some((s) => s.source === 'manual' && s.status === 'approved' && s.count === 1 && Number(s.unpaid) > 0)
      && sum.some((s) => s.source === 'manual' && s.status === 'pending' && s.count === 2), r.out);
  });

  step('B3 rerun 06', () => {
    const r = psql('scn_main', { file: FILES.mark, user: 'sbadmin' });
    const post2 = snap('scn_main');
    check('B3a 重跑 06 成功', r.ok, r.err);
    check('B3b 重跑後沒有任何列再被改（23 列整列逐欄、連 updated_at 都相同）', sameMap(post, post2),
      [...post.keys()].filter((k) => !isDeepStrictEqual(post.get(k), post2.get(k))).join(','));
    check('B3c 重跑後備份表內容完全不變（筆數 13、原值、backed_up_at 都相同）', isDeepStrictEqual(bk1, backupRows('scn_main')));
    const hs = histSummary(r.out);
    check('B3d 重跑的核對表仍是 paid（14、未付 0）＋ approved（4，10/1 起）兩列',
      hs.length === 2 && hs.some((s) => s.status === 'paid' && s.count === 14 && Number(s.unpaid) === 0 && s.backups === '13')
      && hs.some((s) => s.status === 'approved' && s.count === 4 && s.minDate >= CUTOFF), SUMMARY_NOTE(r.out));
    check('B3e 重跑後 trg_session_anomaly 仍啟用', tgState('scn_main') === 'O');
  });

  step('B4 rerun after manual edit keeps original backup', () => {
    // 模擬：06 之後有人把 h01 手動改回未付、並填了一個匯款日（trigger 暫停以免動到異常標記），再重跑 06
    must('scn_main', `
      ALTER TABLE public.class_sessions DISABLE TRIGGER trg_session_anomaly;
      UPDATE public.class_sessions SET status = 'approved', paid_amount = 123, paid_at = TIMESTAMPTZ '2026-06-01 12:00:00+08' WHERE id = '${ID.h01}';
      ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;
    `);
    const mid = snap('scn_main');
    const r = psql('scn_main', { file: FILES.mark, user: 'sbadmin' });
    const post3 = snap('scn_main');
    check('B4a 手動改回未付後重跑 06 成功', r.ok, r.err);
    const h = post3.get(ID.h01);
    check('B4b h01 被重新標成 paid、paid_amount=total_salary', h.status === 'paid' && num(h.paid_amount) === num(h.total_salary));
    check('B4c 06 不會動 paid_at：h01 手動填的匯款日（2026-06-01）重跑後原樣保留',
      ts(h.paid_at) === ts('2026-06-01T12:00:00+08:00'), String(h.paid_at));
    const others = [...mid.keys()].filter((k) => k !== ID.h01 && !isDeepStrictEqual(mid.get(k), post3.get(k)));
    check('B4d 其他 22 列重跑時完全沒被碰', others.length === 0, others.join(','));
    const bk3 = backupRows('scn_main');
    const b01 = bk3.find((b) => b.session_id === ID.h01);
    check('B4e 備份表仍是「最初原值」（approved／0／NULL），沒有被手動改的 123 蓋掉；筆數仍 13',
      bk3.length === 13 && b01.old_status === 'approved' && num(b01.old_paid_amount) === 0 && b01.old_paid_at === null
      && isDeepStrictEqual(bk3, bk1), JSON.stringify(b01));
    post = post3;
  });

  step('B5 rollback 96', () => {
    const r = psql('scn_main', { file: FILES.rollback, user: 'sbadmin' });
    const postR = snap('scn_main');
    check('B5a 96 還原執行成功', r.ok, r.err);
    const bad = needs.filter((p) => {
      const q = postR.get(p.id);
      return q.status !== p.status || num(q.paid_amount) !== num(p.paid_amount) || ts(q.paid_at) !== ts(p.paid_at);
    });
    check('B5b 被改過的 13 筆 status／paid_amount／paid_at 逐列回到最初原值（含 h06 的 NULL、h04 的 paid_at、h01 手動填的匯款日被清回 NULL）',
      bad.length === 0, bad.map((p) => `${p.id}:${postR.get(p.id).status}/${postR.get(p.id).paid_amount}`).join(' | '));
    check('B5c 本來就已付的 h03 還原後仍是 paid／500（沒被誤動）',
      postR.get(ID.h03).status === 'paid' && num(postR.get(ID.h03).paid_amount) === 500);
    const nonHist = [...pre.values()].filter((p) => !isHist(p));
    check('B5d 非 historical_import 的 5 筆整列仍與最初完全相同', nonHist.every((p) => isDeepStrictEqual(p, postR.get(p.id))));
    const outPre = [...pre.values()].filter(outScope);
    check('B5e 10/1 以後的 4 筆匯入列整列仍與最初完全相同（還原也沒碰它們）', outPre.every((p) => isDeepStrictEqual(p, postR.get(p.id))));
    const anomalyChanged = [...pre.values()].filter((p) => !isDeepStrictEqual(
      [p.is_anomaly, p.anomaly_reasons], [postR.get(p.id).is_anomaly, postR.get(p.id).anomaly_reasons]));
    check('B5f 還原後每一列 is_anomaly／anomaly_reasons 仍與最初相同（23/23）', anomalyChanged.length === 0, anomalyChanged.map((p) => p.id).join(','));
    check('B5g 還原後 trg_session_anomaly 仍啟用（tgenabled=O）', tgState('scn_main') === 'O');
    check('B5h 還原後備份表保留不刪（13 筆原值不變）', isDeepStrictEqual(backupRows('scn_main'), bk1));
    const sum = histSummary(r.out);
    const expectCounts = {};
    for (const p of pre.values()) if (isHist(p)) expectCounts[p.status] = (expectCounts[p.status] || 0) + 1;
    const gotCounts = Object.fromEntries(sum.map((s) => [s.status, s.count]));
    check('B5i 96 的核對表（COMMIT 之後）：historical_import 各狀態筆數與最初一致', isDeepStrictEqual(gotCounts, expectCounts), JSON.stringify(gotCounts));

    // 還原後可以再標一次已付款（備份仍是最初原值）
    const again = psql('scn_main', { file: FILES.mark, user: 'sbadmin' });
    const postAgain = snap('scn_main');
    const inOk = [...postAgain.values()].filter(inScope).every((x) => x.status === 'paid' && num(x.paid_amount) === num(x.total_salary));
    const outStill = outPre.every((p) => isDeepStrictEqual(p, postAgain.get(p.id)));
    check('B5j 還原後再跑 06 成功：10/1 前再度全部已付款、10/1 以後仍不動，備份仍是最初原值',
      again.ok && inOk && outStill && isDeepStrictEqual(backupRows('scn_main'), bk1), again.err);
    check('B5k 來回一輪後異常標記仍與最初相同、trigger 仍啟用',
      [...pre.values()].every((p) => isDeepStrictEqual([p.is_anomaly, p.anomaly_reasons], [postAgain.get(p.id).is_anomaly, postAgain.get(p.id).anomaly_reasons]))
      && tgState('scn_main') === 'O');
  });

  step('B6 blocked scenario (pricing guard has the date cap too)', () => {
    const db = 'scn_blocked';
    const rows = [
      { id: rid(101), course_name: 'B1', base_salary: 1000, session_date: '2026-04-01' }, // 正常：會被標成已付款
      { id: rid(102), course_name: 'B2', status: 'pending', base_salary: null, pricing_status: 'needs_review', session_date: '2026-09-30' }, // 範圍內的待定價：擋
      { id: rid(103), source: 'manual', course_name: 'B3', base_salary: 700, session_date: '2026-04-03' },
      { id: rid(105), course_name: 'B5', status: 'pending', base_salary: null, pricing_status: 'needs_review', session_date: '2026-10-01' }, // 邊界 10/1 的待定價：不算
      { id: rid(106), course_name: 'B6', status: 'pending', base_salary: null, pricing_status: 'rejected', session_date: '2026-10-20' }, // 10 月的已退回：不算
    ];
    must(db, seedInstructors + rows.map(insertRow).join('\n'));
    const preB = snap(db);
    const r = psql(db, { file: FILES.mark, user: 'sbadmin' });
    check('B6a 10/1 前含 1 筆待定價（needs_review，9/30）→ 06 報錯停下', !r.ok, r.err || '(竟然成功)');
    check('B6b 錯誤訊息是「有 1 筆…」：只算 9/30 那筆，10/1 的待定價與 10/20 的已退回不算進去',
      /有 1 筆匯入紀錄是待定價或已退回/.test(r.err), firstLine(r.err));
    check('B6c 整批沒有任何列被改（5 列整列逐欄相同，連同一批裡正常的 approved 列也沒被標成已付款）', sameMap(preB, snap(db)));
    check('B6d 備份表不存在（CREATE TABLE 在同一個交易裡，一起回滾）', noBackupTable(db));
    check('B6e 報錯後 trg_session_anomaly 仍是啟用（沒有停用到一半的殘留）', tgState(db) === 'O');
    must(db, insertRow({ id: rid(104), course_name: 'B4', status: 'pending', base_salary: null, pricing_status: 'rejected', session_date: '2026-04-04' }));
    const r2 = psql(db, { file: FILES.mark, user: 'sbadmin' });
    check('B6f 再加 1 筆 10/1 前的已退回（rejected）→ 仍報錯，訊息數字變 2，且仍然零變動',
      !r2.ok && /有 2 筆匯入紀錄是待定價或已退回/.test(r2.err) && noBackupTable(db)
      && must(db, `SELECT count(*) FROM public.class_sessions WHERE status = 'paid'`) === '0', firstLine(r2.err));
    // 把兩筆 10/1 前的擋路列拿掉：只剩 10/1 以後的待定價／已退回 → 不能擋 06
    must(db, `DELETE FROM public.class_sessions WHERE id IN ('${rid(102)}', '${rid(104)}')`);
    const preC = snap(db);
    const r3 = psql(db, { file: FILES.mark, user: 'sbadmin' });
    const postC = snap(db);
    check('B6g 只剩 10/1（含）以後的待定價／已退回匯入列時，06 不被擋、整檔成功', r3.ok, r3.err);
    check('B6h 此時 B1 被標成已付款；10/1 的待定價、10/20 的已退回、manual 的 B3 整列不變',
      postC.get(rid(101)).status === 'paid' && num(postC.get(rid(101)).paid_amount) === 1000
      && [rid(105), rid(106), rid(103)].every((k) => isDeepStrictEqual(preC.get(k), postC.get(k))));
  });

  step('B7 production-scale rehearsal', () => {
    const db = 'scn_scale';
    must(db, `
      INSERT INTO public.instructors (id, full_name) SELECT gen_random_uuid(), 'S講師' || g FROM generate_series(1, 60) g;
      CREATE TEMP TABLE ins AS SELECT id, full_name, row_number() OVER (ORDER BY full_name) AS rn FROM public.instructors;
      INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, role_in_session, session_date,
          duration_hours, base_salary, bonus, paid_amount, status, source)
        SELECT 'onsite_1_5hr', 'Course ' || (g % 7), i.id, i.full_name, 'lead', DATE '2025-01-01' + (g % 400), 1.5,
               500 + (g % 9) * 100, (g % 5) * 50,
               CASE WHEN g IN (10, 20, 30) THEN 500 + (g % 9) * 100 + (g % 5) * 50 ELSE 0 END,
               (CASE WHEN g IN (10, 20, 30) THEN 'paid' ELSE 'approved' END)::public.session_status_enum, 'historical_import'
          FROM generate_series(1, 5489) g JOIN ins i ON i.rn = (g % 60) + 1;
      -- 再補 40 筆「同講師同日同課名」的重複列（insert 時被 trigger 標成異常，模擬總表裡的重複登記）
      INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, role_in_session, session_date,
          duration_hours, base_salary, bonus, paid_amount, status, source)
        SELECT course_type, course_name, instructor_id, instructor_name, role_in_session, session_date,
               duration_hours, base_salary, bonus, 0, 'approved', 'historical_import'
          FROM (SELECT * FROM public.class_sessions WHERE source = 'historical_import' AND status = 'approved' ORDER BY session_date, instructor_name, course_name LIMIT 40) x;
      -- 10 月的 6 筆（上課日 10/5～10/25，06 不准動）
      INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, role_in_session, session_date,
          duration_hours, base_salary, bonus, paid_amount, status, source)
        SELECT 'onsite_1_5hr', 'Oct ' || g, i.id, i.full_name, 'lead', DATE '2026-10-01' + g * 4, 1.5, 800, 0, 0, 'approved', 'historical_import'
          FROM generate_series(1, 6) g JOIN ins i ON i.rn = g + 1;
      -- 站上自己回報與手動登記的列
      INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, session_date, base_salary, status, source)
        SELECT 'onsite_1_5hr', 'Self ' || g, (SELECT id FROM ins WHERE rn = 1), 'S講師1', DATE '2026-05-01' + g, 500, 'approved', 'self_report'
          FROM generate_series(1, 25) g;
    `);
    const stats = () => must(db, `SELECT
        count(*) FILTER (WHERE source = 'historical_import') || '|' ||
        count(*) FILTER (WHERE source = 'historical_import' AND status = 'paid') || '|' ||
        count(*) FILTER (WHERE source = 'historical_import' AND session_date < DATE '${CUTOFF}' AND (status <> 'paid' OR paid_amount IS DISTINCT FROM total_salary)) || '|' ||
        count(*) FILTER (WHERE is_anomaly) || '|' ||
        md5(string_agg(id::text || is_anomaly::text || anomaly_reasons::text, ',' ORDER BY id)) || '|' ||
        md5(string_agg(id::text || status::text || coalesce(paid_amount::text, 'n') || coalesce(paid_at::text, 'n') || updated_at::text, ',' ORDER BY id) FILTER (WHERE source <> 'historical_import')) || '|' ||
        md5(string_agg(to_jsonb(c)::text, ',' ORDER BY id) FILTER (WHERE source = 'historical_import' AND session_date >= DATE '${CUTOFF}'))
      FROM public.class_sessions c`);
    const before = stats().split('|');
    check('B7a 規模假資料：historical_import 5,535 筆（3 筆已付、10/1 前待標 5,526 筆、10 月 6 筆）、異常標記 40 筆（重複列）',
      before[0] === '5535' && before[1] === '3' && before[2] === '5526' && before[3] === '40', before.slice(0, 4).join('|'));
    const r = psql(db, { file: FILES.mark, user: 'sbadmin' });
    const after = stats().split('|');
    check('B7b 5,535 筆規模下 06 成功', r.ok, r.err);
    check('B7c 執行後 10/1 前 5,529 筆全部 paid（總 paid=5,529）、沒有任何一筆範圍內金額不符', after[0] === '5535' && after[1] === '5529' && after[2] === '0', after.slice(0, 3).join('|'));
    check('B7d 異常標記（40 筆）逐列雜湊、self_report 列雜湊、10 月 6 筆整列雜湊都與執行前相同',
      after[3] === '40' && after[4] === before[4] && after[5] === before[5] && after[6] === before[6]);
    const hs = histSummary(r.out);
    check('B7e 核對表：historical_import 兩列——paid（5,529、未付 0、備份 5,526）與 approved（6、10/1 起）',
      hs.length === 2 && hs.some((s) => s.status === 'paid' && s.count === 5529 && Number(s.unpaid) === 0 && s.backups === '5526')
      && hs.some((s) => s.status === 'approved' && s.count === 6 && s.minDate >= CUTOFF), JSON.stringify(hs));
    check('B7f 備份筆數 5526、trg_session_anomaly 仍啟用、整段耗時 < 30 秒',
      must(db, `SELECT count(*) FROM ${BACKUP_TABLE}`) === '5526' && tgState(db) === 'O' && r.ms < 30000, `${r.ms}ms`);
    const rb = psql(db, { file: FILES.rollback, user: 'sbadmin' });
    const afterRb = stats().split('|');
    check('B7g 規模下 96 還原成功：5,526 筆回到未付、3 筆原本已付的不變、異常標記與 10 月 6 筆雜湊不變',
      rb.ok && afterRb[1] === '3' && afterRb[2] === '5526' && afterRb[4] === before[4] && afterRb[6] === before[6], rb.err || afterRb.join('|'));
  });

  // ── 交易內核對自測：拿「真正的 06／96」做出兩種壞掉的副本，確認 SQL 自己的核對會擋下、整批不留痕跡 ──
  step('B8 in-transaction verification self-test', () => {
    const db = 'scn_guard';
    const g = { g1: rid(201), g2: rid(202), g3: rid(203), g4: rid(204), g5: rid(205) };
    must(db, seedInstructors + [
      { id: g.g1, course_name: 'G1', base_salary: 1000, session_date: '2026-03-01' },
      { id: g.g2, course_name: 'G2', base_salary: 800, session_date: '2026-03-02' },
      { id: g.g3, course_name: 'G3', base_salary: 500, session_date: '2026-09-30' },
      { id: g.g4, course_name: 'G4', base_salary: 500, session_date: '2026-10-01' },
      { id: g.g5, source: 'manual', course_name: 'G5', base_salary: 300, session_date: '2026-03-03' },
    ].map(insertRow).join('\n'));
    const preG = snap(db);
    const makeMutant = (name, srcFile, from, to) => {
      const text = readFileSync(srcFile, 'utf8');
      if (!text.includes(from)) return null;
      const out = path.join(dir, name);
      writeFileSync(out, text.replace(from, to));
      return out;
    };

    // 壞掉 1：UPDATE 多一個排除條件，漏改 g1 一列 → 範圍內還有未付 → SQL 內核對要 RAISE，整批取消
    const m1 = makeMutant('06_skip_one_row.sql', FILES.mark,
      "         paid_amount = s.total_salary\n   WHERE s.source = 'historical_import'",
      `         paid_amount = s.total_salary\n   WHERE s.id <> '${g.g1}' AND s.source = 'historical_import'`);
    check('B8a 能從真正的 06 做出「UPDATE 漏改一列」的壞副本（找不到錨點代表 06 改版了，需更新本腳本）', m1 !== null);
    if (m1) {
      const r = psql(db, { file: m1, user: 'sbadmin' });
      check('B8b 漏改一列 → 交易內核對報錯「核對失敗：還有 1 筆 10/1 以前的匯入紀錄未標成已付款，整批取消」',
        !r.ok && /核對失敗：還有 1 筆 10\/1 以前的匯入紀錄未標成已付款/.test(r.err), firstLine(r.err));
      check('B8c 整批不變：5 列整列逐欄相同（其他列也沒被標成已付款）、備份表不存在、trigger 仍啟用',
        sameMap(preG, snap(db)) && noBackupTable(db) && tgState(db) === 'O');
    }

    // 壞掉 2：忘了把異常偵測 trigger 恢復 → 內核對要 RAISE，整批取消（連「停用」都被一起回滾）
    const m2 = makeMutant('06_no_reenable.sql', FILES.mark,
      '  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;\n', '');
    check('B8d 能從真正的 06 做出「忘了恢復 trigger」的壞副本', m2 !== null);
    if (m2) {
      const r = psql(db, { file: m2, user: 'sbadmin' });
      check('B8e 忘了恢復 trigger → 交易內核對報錯「核對失敗：異常偵測 trigger 沒有恢復（狀態 D）」',
        !r.ok && /核對失敗：異常偵測 trigger 沒有恢復（狀態 D）/.test(r.err), firstLine(r.err));
      check('B8f 整批不變：5 列逐欄相同、備份表不存在、trg_session_anomaly 回到啟用（停用也被回滾）',
        sameMap(preG, snap(db)) && noBackupTable(db) && tgState(db) === 'O');
    }

    // 真正的 06 在同一份資料上沒問題，才能拿來測 96 的壞副本
    const ok = psql(db, { file: FILES.mark, user: 'sbadmin' });
    const postG = snap(db);
    check('B8g 同一份資料用真正的 06 執行成功：g1、g2、g3（9/30）被標成已付款，g4（10/1）與 manual 的 g5 不動',
      ok.ok && [g.g1, g.g2, g.g3].every((k) => postG.get(k).status === 'paid')
      && isDeepStrictEqual(preG.get(g.g4), postG.get(g.g4)) && isDeepStrictEqual(preG.get(g.g5), postG.get(g.g5)), ok.err);

    // 壞掉 3：96 忘了恢復 trigger → 96 的內核對要 RAISE，還原整批取消（資料仍是已付款）
    const m3 = makeMutant('96_no_reenable.sql', FILES.rollback,
      '  ALTER TABLE public.class_sessions ENABLE TRIGGER trg_session_anomaly;\n', '');
    check('B8h 能從真正的 96 做出「忘了恢復 trigger」的壞副本', m3 !== null);
    if (m3) {
      const r = psql(db, { file: m3, user: 'sbadmin' });
      check('B8i 96 忘了恢復 trigger → 報錯「核對失敗：異常偵測 trigger 沒有恢復」，還原整批取消（資料維持 06 之後的狀態）、trigger 仍啟用',
        !r.ok && /核對失敗：異常偵測 trigger 沒有恢復/.test(r.err) && sameMap(postG, snap(db)) && tgState(db) === 'O', firstLine(r.err));
    }
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
  console.log('ALL PASS: salary payout schedule + imported-paid backfill SQL verified on isolated PostgreSQL');
}
