#!/usr/bin/env node
// 講師簽約重開：在隔離 PostgreSQL 實跑 submit_my_contract 的各道關卡，並靜態檢查前端只走受控 RPC。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dream-one-contract-signing-'));
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

  const verification = run('psql', [
    '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', dataDir, '-p', String(port), '-U', 'postgres',
    '-d', 'postgres', '-f', path.join(appDir, 'scripts/verify-contract-signing-rpc.sql'),
  ], { cwd: appDir });
  process.stdout.write(verification.stdout);
  assert.match(verification.stdout, /contract signing SQL verification passed/);
  const passCount = (verification.stdout.match(/^PASS:/gm) || []).length;
  process.stdout.write(`SQL PASS lines: ${passCount}\n`);
} finally {
  if (postgres && postgres.exitCode === null) {
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8' });
  }
  rmSync(dataDir, { recursive: true, force: true });
}

// 靜態檢查：前端只走受控 RPC，不再直接寫 instructor_contracts，也不再向第三方查 IP。
const flow = read('src/pages/ContractSigningFlow.jsx');
assert.match(flow, /rpc\(\s*'submit_my_contract'/);
assert.doesNotMatch(flow, /from\(\s*'instructor_contracts'\s*\)\s*\.\s*(insert|update|upsert|delete)/);
assert.doesNotMatch(flow, /\.update\(\s*\{\s*status:\s*'voided'/);
assert.doesNotMatch(flow, /api\.ipify\.org/);
assert.doesNotMatch(flow, /p_verified|verified_at|verify_method/);
assert.match(flow, /\.eq\(\s*'doc_category',\s*'contract'\s*\)/);
process.stdout.write("PASS: ContractSigningFlow.jsx submits only through rpc('submit_my_contract') (no direct insert/update, no ipify, no client-side verified fields) and loads only doc_category='contract' documents\n");
assert.match(flow, /const OTP_BYPASS_FOR_TESTING = false;/);
process.stdout.write('PASS: OTP_BYPASS_FOR_TESTING = false (Email verification restored)\n');
assert.match(read('src/lib/featureFlags.js'), /export const INSTRUCTOR_CONTRACTS_ENABLED = true;/);
process.stdout.write('PASS: INSTRUCTOR_CONTRACTS_ENABLED = true\n');
