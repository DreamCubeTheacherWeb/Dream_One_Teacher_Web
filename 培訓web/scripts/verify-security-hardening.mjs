#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(appDir, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'dream-one-security-hardening-'));
const read = (base, relativePath) => readFileSync(path.join(base, relativePath), 'utf8');

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

const profilePage = read(appDir, 'src/pages/ProfilePage.jsx');
const authContext = read(appDir, 'src/context/AuthContext.jsx');
const lessonDetail = read(appDir, 'src/pages/LessonDetail.jsx');
const layout = read(appDir, 'src/components/Layout.jsx');
const documentViewer = read(appDir, 'src/components/DocumentViewer.jsx');
const filledFormPreview = read(appDir, 'src/components/FilledFormPreviewModal.jsx');
const instructorList = read(appDir, 'src/pages/admin/InstructorList.jsx');
const downloadCenter = read(appDir, 'src/pages/admin/DownloadCenter.jsx');
const dockerfile = read(repoDir, 'Dockerfile');

assert.doesNotMatch(profilePage, /localStorage\.setItem\([^\n]*profile_draft_/);
assert.match(authContext, /localStorage\.removeItem\(key\)/);
assert.doesNotMatch(lessonDetail, /from\(['"]notifications['"]\)\.insert/);
assert.match(layout, /rpc\(['"]ensure_my_contract_reminder['"]\)/);
assert.doesNotMatch(documentViewer, /unpkg\.com/);
assert.match(documentViewer, /fileData\s*\?\s*\{\s*data:\s*fileData\s*\}\s*:\s*fileUrl/);
assert.match(filledFormPreview, /fileData=\{preview\.bytes\}/);
assert.match(instructorList, /setFormPreview\(\{\s*url,\s*bytes,/);
assert.match(downloadCenter, /setFormPreview\(\{\s*url,\s*bytes,/);
assert.doesNotMatch(dockerfile, /^COPY \. \.$/m);

for (const script of ['import_instructors.py', 'import_salary_history.py', 'push_rate_card.py']) {
    const source = read(repoDir, `scripts/${script}`);
    assert.doesNotMatch(source, /CERT_NONE|check_hostname\s*=\s*False/);
}
console.log('PASS: static client, Docker, PDF worker, and TLS checks');

let postgres;
try {
    run('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
    const port = await reservePort();
    postgres = spawn('postgres', ['-D', dataDir, '-k', dataDir, '-p', String(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const probe = spawnSync('pg_isready', ['-h', dataDir, '-p', String(port), '-U', 'postgres'], { encoding: 'utf8' });
        if (probe.status === 0) {
            ready = true;
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('temporary PostgreSQL did not become ready');

    const verification = run('psql', [
        '-X', '-v', 'ON_ERROR_STOP=1', '-h', dataDir, '-p', String(port), '-U', 'postgres',
        '-d', 'postgres', '-f', path.join(appDir, 'scripts/verify-security-hardening.sql'),
    ], { cwd: appDir });
    process.stdout.write(verification.stdout);
} finally {
    if (postgres && postgres.exitCode === null) {
        spawnSync('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop'], { encoding: 'utf8' });
    }
    rmSync(dataDir, { recursive: true, force: true });
}
