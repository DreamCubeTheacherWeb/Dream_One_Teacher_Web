#!/usr/bin/env node
// 講師「我的報酬」匯款日：在隔離 PostgreSQL 實跑 migration，斷言寫在程式裡，stdout 就是證據。
//
//   migration 20261020160000_salary_payout_schedule.sql
//   （單列表、RLS、欄位層級 UPDATE 權限、trigger 蓋 updated_at／updated_by、可重跑不蓋掉後台已改的日期）
//
// 業主在 Supabase SQL Editor 貼上的是「以資料表擁有者（非 superuser）」身分執行的整份檔案，
// 所以 migration 用非 superuser 的 sbadmin 角色整檔執行；
// 權限測試用 SET ROLE anon／authenticated + request.jwt.claims 模擬 PostgREST。
// 只連本機臨時 PostgreSQL（Unix socket，不開 TCP），不碰任何正式環境。
//
// 用法：cd 培訓web && npm run verify:salary-payout-schedule
// 注意：PostgreSQL 需要 System V 共享記憶體；在 Claude Code 的 Bash 沙盒內 initdb 會被擋
// （shmget: Operation not permitted），要在沙盒外跑（一般終端機直接跑即可）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..');
// migration 路徑可用環境變數覆蓋——只用來做「突變測試」（拿故意改壞的副本確認本腳本抓得到），平常不要設
const FILES = {
  migration: process.env.PAYDAY_MIGRATION_SQL || path.join(appDir, 'supabase/migrations/20261020160000_salary_payout_schedule.sql'),
};

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

  // 非 superuser、擁有新資料表的角色：模擬 Supabase SQL Editor 的 postgres 角色
  must('postgres', `
    CREATE ROLE sbadmin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    CREATE DATABASE pa;
  `);

  // ═══════════════════════════════════════════════════════════════════
  // migration 20261020160000_salary_payout_schedule.sql
  // ═══════════════════════════════════════════════════════════════════
  section('migration 20261020160000_salary_payout_schedule.sql');
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
  console.log('ALL PASS: salary payout schedule migration verified on isolated PostgreSQL');
}
