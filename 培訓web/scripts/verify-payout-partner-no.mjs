#!/usr/bin/env node
// 講師夥伴號碼（partner_no）：在隔離 PostgreSQL 實跑 migration，斷言寫在程式裡，stdout 就是證據。
//
//   migration 20261022093700_instructor_partner_no.sql
//   （新增欄位＋格式 CHECK、獨立 trigger 擋講師本人設定／修改、可重跑）
//
// 做法同 verify-salary-payout-schedule.mjs：migration 用非 superuser 的表擁有者 sbadmin 整檔執行
// （模擬 Supabase SQL Editor），權限測試用 SET ROLE authenticated + request.jwt.claims 模擬 PostgREST。
// 只連本機臨時 PostgreSQL（Unix socket，不開 TCP），不碰任何正式環境。
//
// 用法：cd 培訓web && node scripts/verify-payout-partner-no.mjs
// 注意：PostgreSQL 需要 System V 共享記憶體；在 Claude Code 的 Bash 沙盒內 initdb 會被擋，要在沙盒外跑。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(appDir, '..');
// 只用來做「突變測試」（拿故意改壞的副本確認本腳本抓得到），平常不要設
const MIG = process.env.PARTNER_NO_MIGRATION_SQL
  || path.join(appDir, 'supabase/migrations/20261022093700_instructor_partner_no.sql');

const dir = mkdtempSync(path.join(tmpdir(), 'd1-partner-'));
const dataDir = path.join(dir, 'data');
const pgEnv = { ...process.env, LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8', PGCLIENTENCODING: 'UTF8' };
const port = 54000 + Math.floor(Math.random() * 900);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', env: pgEnv, ...opts });

function psql(db, { sql, file, user = 'postgres' } = {}) {
  const args = ['-X', '-q', '-t', '-A', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose',
    '-h', dir, '-p', String(port), '-U', user, '-d', db, '-f', file ?? '-'];
  const r = sh('psql', args, file ? {} : { input: `\\set VERBOSITY verbose\n${sql}` });
  const lines = (r.stderr || '').replaceAll(repoRoot, '<repo>').split('\n');
  return {
    ok: r.status === 0,
    out: (r.stdout || '').trim(),
    // NOTICE（重跑時的 already exists, skipping）與 verbose 模式的 LOCATION 行不是錯誤
    err: lines.filter((l) => !/NOTICE:|^LOCATION:/.test(l)).join('\n').trim(),
  };
}
function must(db, sql, user) {
  const r = psql(db, { sql, user });
  if (!r.ok) throw new Error(`psql failed: ${sql.slice(0, 160).replace(/\s+/g, ' ')}\n${r.err}`);
  return r.out;
}
const asUser = (uid, sql) => psql('pa', {
  sql: `SET ROLE authenticated;\nSET request.jwt.claims = '${JSON.stringify({ sub: uid, role: 'authenticated' })}';\n${sql}`,
});

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
  try { fn(); } catch (error) { check(`${name}（執行中斷）`, false, error.message); }
}
const firstLine = (s) => (s || '').split('\n')[0];
const is42501 = (r) => !r.ok && /ERROR:\s+42501/.test(r.err);
const isCheckViolation = (r) => !r.ok && /ERROR:\s+23514/.test(r.err) && /instructors_partner_no_format_check/.test(r.err);

const U = {
  teacher: '00000000-0000-4000-8000-000000000001',
  teacher2: '00000000-0000-4000-8000-000000000002',
  mentor: '00000000-0000-4000-8000-000000000003',
  admin: '00000000-0000-4000-8000-000000000004',
};
const I = {
  teacher: '10000000-0000-4000-8000-000000000001',
  other: '10000000-0000-4000-8000-000000000002',
  newOwn: '10000000-0000-4000-8000-000000000003',
  newPlain: '10000000-0000-4000-8000-000000000004',
  adminMade: '10000000-0000-4000-8000-000000000005',
  service: '10000000-0000-4000-8000-000000000006',
};

// 模擬 Supabase：auth schema、anon／authenticated／service_role、與正式庫相同語意的 instructors RLS
const BOOT = `
CREATE SCHEMA auth;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role, sbadmin;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon, service_role, sbadmin;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT USAGE, CREATE ON SCHEMA public TO sbadmin;

CREATE TABLE public.users (id uuid PRIMARY KEY REFERENCES auth.users(id), name text, role text);
GRANT SELECT ON public.users TO authenticated, sbadmin;
INSERT INTO auth.users (id, email) VALUES
  ('${U.teacher}', 't1@test.local'), ('${U.teacher2}', 't2@test.local'),
  ('${U.mentor}', 'm@test.local'), ('${U.admin}', 'a@test.local');
INSERT INTO public.users (id, name, role) VALUES
  ('${U.teacher}', '測試講師甲', 'teacher'), ('${U.teacher2}', '測試講師乙', 'teacher'),
  ('${U.mentor}', '測試輔導員', 'mentor'), ('${U.admin}', '測試管理員', 'admin');

CREATE TABLE public.instructors (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id),
  full_name text NOT NULL,
  phone_mobile text,
  id_number text
);
ALTER TABLE public.instructors OWNER TO sbadmin;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instructors TO authenticated, service_role;
ALTER TABLE public.instructors ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_all ON public.instructors FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'admin'));
CREATE POLICY own_select ON public.instructors FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY mentor_select ON public.instructors FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role = 'mentor'));
CREATE POLICY own_update ON public.instructors FOR UPDATE TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY own_insert ON public.instructors FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

INSERT INTO public.instructors (id, user_id, full_name, phone_mobile, id_number) VALUES
  ('${I.teacher}', '${U.teacher}', '測試講師甲', '0900000001', 'Z100000001'),
  ('${I.other}', '${U.teacher2}', '測試講師乙', '0900000002', 'Z200000002');
`;

const read = (id) => must('pa', `SELECT coalesce(partner_no, '<null>') || '|' || coalesce(phone_mobile, '') FROM public.instructors WHERE id = '${id}'`);

let postgres;
const startedAt = Date.now();
let postgresLogs = '';
try {
  const init = sh('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  if (init.status !== 0) throw new Error(`initdb failed\n${init.stdout}${init.stderr}`);
  postgres = spawn('postgres', ['-D', dataDir, '-k', dir, '-p', String(port), '-c', 'listen_addresses=', '-c', 'fsync=off'], {
    stdio: ['ignore', 'pipe', 'pipe'], env: pgEnv,
  });
  postgres.stdout.on('data', (c) => { postgresLogs += c.toString(); });
  postgres.stderr.on('data', (c) => { postgresLogs += c.toString(); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sh('pg_isready', ['-h', dir, '-p', String(port), '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`temporary PostgreSQL did not become ready\n${postgresLogs}`);
  console.log(`temporary PostgreSQL ready (socket dir ${dir.replace(tmpdir(), '$TMPDIR')}, pid ${postgres.pid})`);

  must('postgres', 'CREATE ROLE sbadmin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; CREATE DATABASE pa;');
  must('pa', BOOT);

  section('A. migration 可重跑');
  step('A', () => {
    const r1 = psql('pa', { file: MIG, user: 'sbadmin' });
    check('A1 第一次套用成功（非 superuser 表擁有者身分）', r1.ok, r1.err);
    const r2 = psql('pa', { file: MIG, user: 'sbadmin' });
    check('A2 連續第二次套用成功', r2.ok, r2.err);
    const q = (s) => must('pa', s);
    check('A3 欄位 partner_no 存在且型別為 text',
      q(`SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='instructors' AND column_name='partner_no'`) === 'text');
    check('A4 格式 CHECK 只有 1 條（重跑沒有重複）',
      q(`SELECT count(*) FROM pg_constraint WHERE conrelid='public.instructors'::regclass AND conname='instructors_partner_no_format_check'`) === '1');
    check('A5 partner_no trigger 只有 1 個（BEFORE INSERT OR UPDATE）',
      q(`SELECT count(*) || '|' || bool_and((tgtype & 2) <> 0 AND (tgtype & 4) <> 0 AND (tgtype & 16) <> 0) FROM pg_trigger WHERE tgrelid='public.instructors'::regclass AND tgname='trg_guard_instructor_partner_no'`) === '1|true');
    check('A6 trigger 函式 anon／authenticated 不能直接 EXECUTE',
      q(`SELECT has_function_privilege('anon','public.guard_instructor_partner_no()','EXECUTE') OR has_function_privilege('authenticated','public.guard_instructor_partner_no()','EXECUTE')`) === 'f');
    check('A7 欄位有 COMMENT',
      q(`SELECT col_description('public.instructors'::regclass, (SELECT attnum FROM pg_attribute WHERE attrelid='public.instructors'::regclass AND attname='partner_no')) IS NOT NULL`) === 't');
    check('A8 沒有建 unique（同號碼可存在兩位講師身上，只在畫面警告）',
      q(`SELECT count(*) FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid='public.instructors'::regclass AND i.indisunique AND a.attname='partner_no'`) === '0');
    check('A9 既有資料沒被動到（partner_no 全為 NULL、電話不變）',
      read(I.teacher) === '<null>|0900000001' && read(I.other) === '<null>|0900000002', `${read(I.teacher)} / ${read(I.other)}`);
  });

  section('B. admin 可設定');
  step('B', () => {
    const r = asUser(U.admin, `WITH u AS (UPDATE public.instructors SET partner_no = 'A036872' WHERE id = '${I.teacher}' RETURNING 1) SELECT count(*) FROM u;`);
    check('B1 admin 設定講師甲的 partner_no = A036872（1 列）', r.ok && r.out === '1', r.err || r.out);
    check('B2 值確實寫入', read(I.teacher) === 'A036872|0900000001', read(I.teacher));
    const r2 = asUser(U.admin, `WITH u AS (UPDATE public.instructors SET partner_no = 'B000001' WHERE id = '${I.teacher}' RETURNING 1) SELECT count(*) FROM u;`);
    check('B3 admin 可修改為另一個號碼', r2.ok && r2.out === '1' && read(I.teacher) === 'B000001|0900000001', r2.err || read(I.teacher));
    const r3 = asUser(U.admin, `WITH u AS (UPDATE public.instructors SET partner_no = 'A036872' WHERE id = '${I.teacher}' RETURNING 1) SELECT count(*) FROM u;`);
    check('B4 admin 改回 A036872', r3.ok && r3.out === '1' && read(I.teacher) === 'A036872|0900000001', r3.err);
    const ins = asUser(U.admin, `INSERT INTO public.instructors (id, full_name, partner_no) VALUES ('${I.adminMade}', '測試後台建檔', 'C000123');`);
    check('B5 admin INSERT 時可直接帶 partner_no', ins.ok && read(I.adminMade) === 'C000123|', ins.err || read(I.adminMade));
    const dup = asUser(U.admin, `WITH u AS (UPDATE public.instructors SET partner_no = 'A036872' WHERE id = '${I.adminMade}' RETURNING 1) SELECT count(*) FROM u;`);
    check('B6 同號碼可設在第二位講師身上（沒有 unique，畫面上警告）', dup.ok && dup.out === '1', dup.err);
    asUser(U.admin, `UPDATE public.instructors SET partner_no = 'C000123' WHERE id = '${I.adminMade}';`);
  });

  section('C. 講師本人不能改，但其他欄位照常');
  step('C', () => {
    const before = read(I.teacher);
    const r = asUser(U.teacher, `UPDATE public.instructors SET partner_no = 'Z999999' WHERE id = '${I.teacher}';`);
    check('C1 講師本人改自己的 partner_no 被擋（SQLSTATE 42501）', is42501(r), firstLine(r.err));
    check('C2 被擋後值不變', read(I.teacher) === before, read(I.teacher));
    const clear = asUser(U.teacher, `UPDATE public.instructors SET partner_no = NULL WHERE id = '${I.teacher}';`);
    check('C3 講師本人把自己的 partner_no 清成 NULL 也被擋（42501）', is42501(clear) && read(I.teacher) === before, firstLine(clear.err));
    const phone = asUser(U.teacher, `WITH u AS (UPDATE public.instructors SET phone_mobile = '0911111111' WHERE id = '${I.teacher}' RETURNING 1) SELECT count(*) FROM u;`);
    check('C4 講師本人改自己的電話仍可以（1 列）', phone.ok && phone.out === '1', phone.err || phone.out);
    check('C5 電話已更新、partner_no 沒被動到', read(I.teacher) === 'A036872|0911111111', read(I.teacher));
    const same = asUser(U.teacher, `WITH u AS (UPDATE public.instructors SET phone_mobile = '0922222222', partner_no = 'A036872' WHERE id = '${I.teacher}' RETURNING 1) SELECT count(*) FROM u;`);
    check('C6 存檔時帶回原本的 partner_no（值沒變）不會被誤擋', same.ok && same.out === '1' && read(I.teacher) === 'A036872|0922222222', same.err || read(I.teacher));
    const mentor = asUser(U.mentor, `WITH u AS (UPDATE public.instructors SET partner_no = 'M000001' WHERE id = '${I.other}' RETURNING 1) SELECT count(*) FROM u;`);
    check('C7 輔導員改別人的 partner_no：0 列受影響或被拒，值不變',
      ((mentor.ok && mentor.out === '0') || is42501(mentor) || /permission denied/i.test(mentor.err)) && read(I.other) === '<null>|0900000002',
      mentor.ok ? `affected=${mentor.out}` : firstLine(mentor.err));
  });

  section('D. 講師 INSERT');
  step('D', () => {
    // 講師乙 已有一列；用講師甲的帳號新建（RLS own_insert 允許 user_id = 自己）
    const bad = asUser(U.teacher, `INSERT INTO public.instructors (id, user_id, full_name, partner_no) VALUES ('${I.newOwn}', '${U.teacher}', '測試自建', 'A000001');`);
    check('D1 講師 INSERT 時帶 partner_no 被擋（42501）', is42501(bad), firstLine(bad.err));
    check('D2 被擋的列沒有寫進去', must('pa', `SELECT count(*) FROM public.instructors WHERE id = '${I.newOwn}'`) === '0');
    const ok = asUser(U.teacher, `INSERT INTO public.instructors (id, user_id, full_name) VALUES ('${I.newPlain}', '${U.teacher}', '測試自建二');`);
    check('D3 講師 INSERT 不帶 partner_no 仍可以（對照組）', ok.ok && read(I.newPlain) === '<null>|', ok.err || read(I.newPlain));
  });

  section('E. 格式 CHECK');
  step('E', () => {
    const before = read(I.other);
    for (const [label, value] of [
      ['小寫 a036872', "'a036872'"], ['含連字號 A-0368', "'A-0368'"], ['空字串', "''"],
      ['含空白 A 036872', "'A 036872'"], ['21 碼', `'${'A'.repeat(21)}'`], ['中文 需新增1', "'需新增1'"],
    ]) {
      const r = asUser(U.admin, `UPDATE public.instructors SET partner_no = ${value} WHERE id = '${I.other}';`);
      check(`E ${label} 被 CHECK 擋（23514）`, isCheckViolation(r), firstLine(r.err));
    }
    check('E7 被擋之後值不變', read(I.other) === before, read(I.other));
    const edge = asUser(U.admin, `WITH u AS (UPDATE public.instructors SET partner_no = '${'9'.repeat(20)}' WHERE id = '${I.other}' RETURNING 1) SELECT count(*) FROM u;`);
    check('E8 邊界 20 碼數字可寫入', edge.ok && edge.out === '1', edge.err);
    const one = asUser(U.admin, `WITH u AS (UPDATE public.instructors SET partner_no = 'X' WHERE id = '${I.other}' RETURNING 1) SELECT count(*) FROM u;`);
    check('E9 邊界 1 碼可寫入', one.ok && one.out === '1', one.err);
    const nul = asUser(U.admin, `WITH u AS (UPDATE public.instructors SET partner_no = NULL WHERE id = '${I.other}' RETURNING 1) SELECT count(*) FROM u;`);
    check('E10 NULL 可寫入（尚未建檔）', nul.ok && nul.out === '1' && read(I.other) === '<null>|0900000002', nul.err);
  });

  section('F. auth.uid() 為 NULL 時放行');
  step('F', () => {
    const editor = psql('pa', { sql: `SELECT auth.uid() IS NULL; WITH u AS (UPDATE public.instructors SET partner_no = 'S000001' WHERE id = '${I.other}' RETURNING 1) SELECT count(*) FROM u;`, user: 'sbadmin' });
    check('F1 SQL Editor（表擁有者、沒有 JWT）可設定 partner_no', editor.ok && editor.out === 't\n1' && read(I.other) === 'S000001|0900000002', editor.err || editor.out);
    const svc = psql('pa', { sql: `SET ROLE service_role; SELECT auth.uid() IS NULL; WITH u AS (UPDATE public.instructors SET partner_no = 'S000002' WHERE id = '${I.other}' RETURNING 1) SELECT count(*) FROM u;` });
    check('F2 service_role（沒有使用者 JWT）可設定 partner_no', svc.ok && svc.out === 't\n1' && read(I.other) === 'S000002|0900000002', svc.err || svc.out);
    const svcIns = psql('pa', { sql: `SET ROLE service_role; INSERT INTO public.instructors (id, full_name, partner_no) VALUES ('${I.service}', '測試服務建檔', 'S000003');` });
    check('F3 service_role INSERT 時可帶 partner_no', svcIns.ok && read(I.service) === 'S000003|', svcIns.err || read(I.service));
  });
} catch (error) {
  check('腳本本身執行中斷', false, error.stack || error.message);
} finally {
  if (postgres && postgres.exitCode === null) {
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8', env: pgEnv });
  }
  rmSync(dir, { recursive: true, force: true });
}

const total = passCount + failCount;
console.log(`\n${'-'.repeat(60)}`);
console.log(`Total checks: ${total}   PASS: ${passCount}   FAIL: ${failCount}   (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
console.log(`RESULT ${passCount}/${total}`);
if (failCount > 0) {
  console.log('FAILED:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
} else {
  console.log('ALL PASS: instructor partner_no migration verified on isolated PostgreSQL');
}
