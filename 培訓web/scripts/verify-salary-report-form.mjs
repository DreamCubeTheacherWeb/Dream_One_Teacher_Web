#!/usr/bin/env node
// 課程回報對齊 Google 表單：在隔離 PostgreSQL 實跑 migration 與 RPC 邊界，並檢查前端只走受控 RPC。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dream-one-salary-report-form-'));
// 中文語系下 postmaster 可能因 locale 初始化變成多執行緒而拒絕啟動，固定用 C locale。
const pgEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };

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

  // 既有問題（非本次引入）：2025_salary_system.sql 的 month_label 以 to_char() 當 generated column，
  // PostgreSQL 16 判定 to_char 非 IMMUTABLE 而拒絕建表。新建庫路徑測試只把這一行換成一般欄位，
  // 其餘內容（含本次同步的新欄位、約束與選項表）原樣套用。
  const baseSql = read('supabase/2025_salary_system.sql');
  const generatedMonthLabel = "GENERATED ALWAYS AS (to_char(session_date, 'YYYY/MM')) STORED";
  assert.ok(baseSql.includes(generatedMonthLabel), 'month_label workaround target not found');
  const baseSqlPath = path.join(dataDir, 'base_2025_salary_system.sql');
  writeFileSync(baseSqlPath, baseSql.replace(generatedMonthLabel, ''));

  const verification = run('psql', [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-v', `base_sql=${baseSqlPath}`, '-h', dataDir, '-p', String(port), '-U', 'postgres',
    '-d', 'postgres', '-f', path.join(appDir, 'scripts/verify-salary-report-form.sql'),
  ], { cwd: appDir });
  process.stdout.write(verification.stdout);
  const notices = (verification.stderr || '').split('\n').filter((line) => line.includes('PASS (d)'));
  for (const line of notices) process.stdout.write(`${line.replace(/^.*NOTICE:\s*/, '  ')}\n`);
  assert.match(verification.stdout, /salary report form SQL verification passed/);
  process.stdout.write('PASS: salary report form verification complete\n');
} finally {
  if (postgres && postgres.exitCode === null) {
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8' });
  }
  rmSync(dataDir, { recursive: true, force: true });
}

const reportPage = read('src/pages/MySalaryNew.jsx');
assert.match(reportPage, /supabase\.rpc\('submit_my_class_session'/);
assert.doesNotMatch(reportPage, /from\('class_sessions'\)\.insert/);
assert.match(reportPage, /from\('salary_report_options'\)/);
for (const param of ['p_term_period', 'p_unit_name', 'p_materials_issued', 'p_transport_subsidy_requested', 'p_transport_distance_km']) {
  assert.match(read('src/lib/salaryReportForm.js'), new RegExp(param));
}
process.stdout.write('PASS: report page reads salary_report_options and submits new fields only through the RPC\n');
