#!/usr/bin/env node
// 課程受眾＋輔導員講師主檔權限（migration 20261022010000）：在隔離 PostgreSQL 上
// 先重現正式庫現況的兩個問題，再套 migration 兩次逐角色驗證；最後靜態檢查 migration 沒有
// 碰到並行分支要重定義的函式。需在沙盒外執行（要起本機 postgres）。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dream-one-rls-audience-mentor-'));
// 中文語系下 postmaster 可能因 locale 初始化變成多執行緒而拒絕啟動，固定用 C locale。
const pgEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
const EXPECTED_SQL_PASS = 12;

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', env: pgEnv, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result;
};

const read = (file) => readFileSync(path.join(appDir, file), 'utf8');

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

let postgres;
let postgresLogs = '';
try {
  run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  const port = await reservePort();
  postgres = spawn('postgres', ['-D', dataDir, '-k', dataDir, '-p', String(port), '-c', 'listen_addresses='], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: pgEnv,
  });
  postgres.stdout.on('data', (chunk) => { postgresLogs += chunk.toString(); });
  postgres.stderr.on('data', (chunk) => { postgresLogs += chunk.toString(); });

  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = spawnSync('pg_isready', ['-h', dataDir, '-p', String(port), '-U', 'postgres'], { encoding: 'utf8' });
    if (probe.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`temporary PostgreSQL did not become ready\n${postgresLogs}`);

  const verification = run('psql', [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', dataDir, '-p', String(port), '-U', 'postgres',
    '-d', 'postgres', '-f', path.join(appDir, 'scripts/verify-rls-audience-mentor.sql'),
  ], { cwd: appDir });
  process.stdout.write(verification.stdout);
  assert.match(verification.stdout, /rls audience\/mentor SQL verification passed/);
  const passCount = (verification.stdout.match(/^PASS:/gm) || []).length;
  assert.equal(passCount, EXPECTED_SQL_PASS, `expected ${EXPECTED_SQL_PASS} SQL PASS lines, got ${passCount}`);
  process.stdout.write(`SQL PASS lines: ${passCount}/${EXPECTED_SQL_PASS}\n`);
} finally {
  if (postgres && postgres.exitCode === null) {
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8', env: pgEnv });
  }
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 靜態檢查 ──
const migration = read('supabase/migrations/20261022010000_tighten_course_audience_and_mentor_access.sql');
// 並行分支 feat/personnel-types 會重定義這些函式；本 migration 不得碰
for (const fn of [
  'public.guard_instructor_admin_fields',
  'private.instructor_profile_is_complete',
  'public.ensure_my_contract_reminder',
  'private.current_user_is_teacher',
  'public.is_my_instructor_profile_complete',
]) {
  const name = fn.replace('.', '\\.');
  assert.doesNotMatch(migration, new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+${name}\\b`, 'i'), `migration must not redefine ${fn}`);
}
assert.doesNotMatch(migration, /ALTER TABLE public\.instructors/i, 'migration must not alter the instructors table');
for (const policy of ['Mentors can view all instructors', 'Mentors and admins can view all instructor profiles']) {
  assert.doesNotMatch(migration, new RegExp(`DROP POLICY IF EXISTS "${policy}"`), `"${policy}" is kept until the owner decides on DownloadCenter/InstructorList`);
}
process.stdout.write('PASS: migration does not redefine the five functions owned by other branches, does not alter instructors, and keeps the two mentor read policies\n');

// 名冊函式目前沒有前端呼叫（mentor 讀全表的政策保留中）；之後接上時本檢查要改成驗呼叫點
const { stdout: grepOut } = spawnSync('grep', ['-rl', 'mentor_instructor_directory', path.join(appDir, 'src')], { encoding: 'utf8' });
assert.equal(grepOut.trim(), '', 'frontend now calls mentor_instructor_directory; update this verification');
process.stdout.write('PASS: no frontend caller of mentor_instructor_directory yet (frontend unchanged in this release)\n');
