#!/usr/bin/env node
// 合約範本讀取權限收緊（migration 20261019103000）：在隔離 PostgreSQL 實跑各角色的讀取範圍，
// 並靜態檢查前端沒有任何 pending 角色需要讀 contract_documents 的路徑。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dream-one-contract-doc-reads-'));
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
    '-d', 'postgres', '-f', path.join(appDir, 'scripts/verify-contract-document-reads.sql'),
  ], { cwd: appDir });
  process.stdout.write(verification.stdout);
  assert.match(verification.stdout, /contract document reads SQL verification passed/);
  const passCount = (verification.stdout.match(/^PASS:/gm) || []).length;
  process.stdout.write(`SQL PASS lines: ${passCount}\n`);
} finally {
  if (postgres && postgres.exitCode === null) {
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8' });
  }
  rmSync(dataDir, { recursive: true, force: true });
}

// ── 靜態檢查：migration 與 setup 同步、前端沒有 pending 需要讀 contract_documents 的路徑 ──
const migration = read('supabase/migrations/20261019103000_restrict_contract_document_reads.sql');
const setup = read('supabase/contracts_setup.sql');
for (const [label, sql] of [['migration', migration], ['contracts_setup.sql', setup]]) {
  assert.match(sql, /CREATE POLICY "Approved roles can read contract documents"/, `${label} lacks the new read policy`);
  assert.match(sql, /DROP POLICY IF EXISTS "Authenticated users can read active contract documents"/, `${label} does not drop the USING (true) policy`);
  assert.match(sql, /REVOKE ALL ON TABLE public\.contract_documents FROM anon/, `${label} does not revoke anon`);
  assert.match(sql, /CREATE POLICY "read contract documents scoped"[\s\S]*IS DISTINCT FROM 'signed'[\s\S]*role IN \('teacher', 'mentor', 'admin'\)/,
    `${label} storage policy does not gate non-signed paths by approved role`);
}
assert.doesNotMatch(setup, /ON public\.contract_documents FOR SELECT\s+TO authenticated\s+USING \(true\)/, 'contracts_setup.sql still has USING (true) on contract_documents');
process.stdout.write('PASS: migration and contracts_setup.sql both define the approved-roles read policy, drop the USING (true) policy, revoke anon, and gate template files by role\n');

// pending 可到達的路由只有 allowPending 的 /profile；/contract、/contract/view 與所有 /admin 路由會把 pending 導走。
const app = read('src/App.jsx');
assert.match(app, /if \(!allowPending && !isPrivileged && profile\.role === 'pending'\) return <Navigate to="\/pending" \/>;/);
const contractRoutes = [...app.matchAll(/<Route\s+path="(\/contract[^"]*)"\s+element=\{([\s\S]*?)\}\s*\/>/g)];
assert.ok(contractRoutes.length >= 2, 'expected /contract and /contract/view routes');
for (const [, routePath, element] of contractRoutes) {
  assert.doesNotMatch(element, /allowPending/, `${routePath} must not allow pending users`);
}
const adminRoutes = [...app.matchAll(/<Route\s+path="(\/admin[^"]*)"\s+element=\{([\s\S]*?)\}\s*\/>/g)];
for (const [, routePath, element] of adminRoutes) {
  assert.doesNotMatch(element, /allowPending/, `${routePath} must not allow pending users`);
}
process.stdout.write(`PASS: ${contractRoutes.length} /contract routes and ${adminRoutes.length} /admin routes reject pending users (no allowPending)\n`);

// ProfilePage 只在 canUseContracts 時查 contract_documents，而 canAccessInstructorContracts 排除 pending。
const flags = read('src/lib/featureFlags.js');
assert.match(flags, /const CONTRACT_ROLES = \['teacher', 'mentor'\];/);
assert.match(flags, /role === 'admin' \|\| \(INSTRUCTOR_CONTRACTS_ENABLED && CONTRACT_ROLES\.includes\(role\)\)/);
const profile = read('src/pages/ProfilePage.jsx');
assert.match(profile, /const canUseContracts = INSTRUCTOR_CONTRACTS_ENABLED && canAccessInstructorContracts\(profile\?\.role\);/);
assert.match(profile, /if \(canUseContracts\) loadContractStatus\(\);/);
assert.equal((profile.match(/\.from\(\s*'contract_documents'\s*\)/g) || []).length, 1, 'ProfilePage should query contract_documents in exactly one place');
process.stdout.write('PASS: ProfilePage queries contract_documents only inside loadContractStatus, gated by canUseContracts, which excludes pending\n');

// 其餘讀取點都在 pending 到不了的頁面
for (const file of ['src/pages/ContractSigningFlow.jsx', 'src/pages/ContractView.jsx', 'src/pages/admin/InstructorList.jsx', 'src/pages/admin/DownloadCenter.jsx', 'src/pages/admin/ContractAdmin.jsx', 'src/lib/formGenerator.js']) {
  assert.match(read(file), /contract_documents|contract-documents/, `${file} no longer references contract documents (update this check)`);
}
process.stdout.write('PASS: remaining contract_documents readers live in /contract, /contract/view, /admin/* pages or the admin-only form generator\n');
