#!/usr/bin/env node
// 講師簽約重開：在隔離 PostgreSQL 實跑 submit_my_contract 的各道關卡，並靜態檢查前端只走受控 RPC。
// 注意：SQL 段驗的是 2026-10-18 migration 本身（JWT amr 版）能在正式庫現況上正確套用；
// 2026-10-20 起現行的 submit_my_contract 是 v2（本系統 OTP＋同意紀錄＋雜湊＋證據鏈），由
// scripts/verify-claim-activation-esign.mjs 在完整 SQL 鏈上驗證。
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
// 2026-10-20 起簽約 OTP 改用本系統 OTP（request_email_otp／verify_email_otp，寄到已確認 Email），
// 不再用 Supabase Auth signInWithOtp＋JWT amr，原本的 OTP_BYPASS_FOR_TESTING 旗標已隨之移除。
// 這裡改驗：送出時必帶 v2 的 OTP／同意／雜湊參數、沒有任何繞過旗標、不再走 signInWithOtp。
// 資料庫端 v2 的實際行為（OTP_REQUIRED／CONSENT_REQUIRED／雜湊、證據鏈等）由 scripts/verify-claim-activation-esign.mjs 實跑。
for (const param of ['p_otp_challenge_id', 'p_consent_id', 'p_document_sha256', 'p_signed_pdf_sha256']) {
  assert.match(flow, new RegExp(`\\b${param}\\b`));
}
assert.doesNotMatch(flow, /OTP_BYPASS[A-Z_]*\s*=\s*true/);
assert.doesNotMatch(flow, /signInWithOtp/);
const otpDialog = read('src/components/EmailOtpDialog.jsx');
assert.match(otpDialog, /rpc\(\s*'request_email_otp'/);
assert.match(otpDialog, /rpc\(\s*'verify_email_otp'/);
assert.doesNotMatch(otpDialog, /signInWithOtp/);
process.stdout.write('PASS: submit_my_contract is called with p_otp_challenge_id / p_consent_id / p_document_sha256 / p_signed_pdf_sha256; no OTP bypass flag; Email OTP uses request_email_otp / verify_email_otp (no signInWithOtp)\n');
assert.match(read('src/lib/featureFlags.js'), /export const INSTRUCTOR_CONTRACTS_ENABLED = true;/);
process.stdout.write('PASS: INSTRUCTOR_CONTRACTS_ENABLED = true\n');
