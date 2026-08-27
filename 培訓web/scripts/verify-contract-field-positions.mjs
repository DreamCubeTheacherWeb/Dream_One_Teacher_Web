#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dream-one-contract-fields-'));

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

const editorSource = readFileSync(
  path.join(appDir, 'src/components/FieldPositionEditor.jsx'),
  'utf8',
);
assert.match(editorSource, /supabase\.rpc\('replace_contract_field_positions'/);
assert.doesNotMatch(
  editorSource.slice(editorSource.indexOf('const handleSave'), editorSource.indexOf('const pageFields')),
  /\.from\('contract_field_positions'\)/,
);

let postgres;
let postgresLogs = '';
try {
  run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
  const port = await reservePort();
  postgres = spawn('postgres', ['-D', dataDir, '-k', dataDir, '-p', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  postgres.stdout.on('data', (chunk) => { postgresLogs += chunk.toString(); });
  postgres.stderr.on('data', (chunk) => { postgresLogs += chunk.toString(); });

  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = spawnSync(
      'pg_isready',
      ['-h', dataDir, '-p', String(port), '-U', 'postgres'],
      { encoding: 'utf8' },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`temporary PostgreSQL did not become ready\n${postgresLogs}`);

  const verification = run('psql', [
    '-X', '-v', 'ON_ERROR_STOP=1', '-h', dataDir, '-p', String(port), '-U', 'postgres',
    '-d', 'postgres', '-f', path.join(appDir, 'scripts/verify-contract-field-positions.sql'),
  ], { cwd: appDir });
  process.stdout.write(verification.stdout);
  process.stdout.write('PASS: field-position editor uses the atomic replacement RPC\n');
} finally {
  if (postgres && postgres.exitCode === null) {
    spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8' });
  }
  rmSync(dataDir, { recursive: true, force: true });
}
