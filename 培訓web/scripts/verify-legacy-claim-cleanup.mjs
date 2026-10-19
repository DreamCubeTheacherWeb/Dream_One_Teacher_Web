#!/usr/bin/env node
// 以本機暫時 PostgreSQL 實跑 verify-legacy-claim-cleanup.sql（不碰正式庫）。
// 沙盒內 PostgreSQL 共享記憶體會被擋，請在沙盒外跑並帶 LC_ALL=C。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dream-one-legacy-claim-'));

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  }
  return result;
};

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

let postgres;
try {
  run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  const port = await reservePort();
  postgres = spawn('postgres', ['-D', dataDir, '-k', dataDir, '-p', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (spawnSync('pg_isready', ['-h', dataDir, '-p', String(port), '-U', 'postgres']).status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('temporary PostgreSQL did not become ready');
  const result = run('psql', [
    '-X', '-v', 'ON_ERROR_STOP=1', '-h', dataDir, '-p', String(port), '-U', 'postgres',
    '-d', 'postgres', '-f', path.join(appDir, 'scripts/verify-legacy-claim-cleanup.sql'),
  ], { cwd: appDir });
  const passLines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.includes('NOTICE:  PASS'));
  passLines.forEach((line) => console.log(line.replace(/^.*NOTICE:\s*/, '')));
  if (!result.stdout.includes('legacy claim cleanup SQL verification passed')) throw new Error('verification did not finish');
  console.log(`\n${passLines.length} PASS  legacy claim cleanup SQL verification passed`);
} finally {
  if (postgres && postgres.exitCode === null) spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8' });
  rmSync(dataDir, { recursive: true, force: true });
}
