#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const database = `dreamone_google_only_auth_test_${process.pid}`;
const authAdminRole = 'supabase_auth_admin';
let createdAuthAdminRole = false;
let createdDatabase = false;

const run = (command, args, options = {}) => execFileSync(command, args, {
    cwd: appDir,
    encoding: 'utf8',
    ...options,
});

try {
    const roleExists = run('psql', [
        '-d', 'postgres',
        '-Atqc',
        `SELECT 1 FROM pg_roles WHERE rolname = '${authAdminRole}'`,
    ]).trim() === '1';

    if (!roleExists) {
        run('createuser', ['--no-login', authAdminRole]);
        createdAuthAdminRole = true;
    }

    run('createdb', [database]);
    createdDatabase = true;
    run('psql', [
        '-v', 'ON_ERROR_STOP=1',
        '-d', database,
        '-f', path.join(scriptDir, 'verify-google-only-auth.sql'),
    ], { stdio: 'inherit', encoding: undefined });
} finally {
    if (createdDatabase) {
        run('dropdb', [database], { stdio: 'inherit', encoding: undefined });
    }
    if (createdAuthAdminRole) {
        run('dropuser', [authAdminRole], { stdio: 'inherit', encoding: undefined });
    }
}
