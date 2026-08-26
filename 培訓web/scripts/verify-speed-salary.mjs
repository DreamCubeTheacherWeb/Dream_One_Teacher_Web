#!/usr/bin/env node
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const database = `dreamone_speed_salary_test_${process.pid}`;

try {
    execFileSync('createdb', [database], { stdio: 'inherit' });
    execFileSync('psql', [
        '-v', 'ON_ERROR_STOP=1',
        '-d', database,
        '-f', path.join(scriptDir, 'verify-speed-salary.sql'),
    ], { cwd: appDir, stdio: 'inherit' });
} finally {
    execFileSync('dropdb', ['--if-exists', database], { stdio: 'inherit' });
}
