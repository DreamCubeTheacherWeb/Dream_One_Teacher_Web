#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4219;
const baseUrl = `http://localhost:${port}`;
const screenshotPath = path.join(os.tmpdir(), 'dream-one-google-only-auth.png');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));

const read = (relativePath) => readFileSync(path.join(appDir, relativePath), 'utf8');
const collectFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(fullPath) : [fullPath];
});

const results = [];
const check = (name, test) => {
    try {
        test();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (error) {
        results.push({ name, pass: false });
        console.error(`FAIL  ${name}\n      ${error.message}`);
    }
};

const srcFiles = collectFiles(path.join(appDir, 'src'))
    .filter((file) => /\.(js|jsx)$/.test(file));
const allSource = srcFiles.map((file) => readFileSync(file, 'utf8')).join('\n');
const teacherManager = read('src/pages/admin/TeacherManager.jsx');
const migration = read('supabase/migrations/20260814034139_google_only_invite_signup.sql');

check('前端已移除 Email／密碼登入與註冊 API', () => {
    assert.doesNotMatch(allSource, /signInWithPassword|\.auth\.signUp|signUpWithEmail|signInWithEmail|createIsolatedClient/);
    assert.equal(existsSync(path.join(appDir, 'src/pages/DevLogin.jsx')), false);
});

check('管理員建檔表單不再要求密碼', () => {
    assert.match(teacherManager, /無需另外設定密碼/);
    assert.doesNotMatch(teacherManager, /form\.password|登入密碼|密碼至少/);
    assert.match(teacherManager, /teacher_invites/);
});

check('Before User Created hook 僅允許 Google 與既有名單 Email', () => {
    assert.match(migration, /auth_provider <> 'google'/);
    assert.match(migration, /public\.teacher_invites/);
    assert.match(migration, /public\.instructors/);
    assert.match(migration, /lower\(btrim\(ti\.email\)\) = normalized_email/);
    assert.match(migration, /lower\(btrim\(i\.email_primary\)\) = normalized_email/);
});

check('Auth hook 權限只開給 supabase_auth_admin', () => {
    assert.match(migration, /SECURITY DEFINER/);
    assert.match(migration, /SET search_path = ''/);
    assert.match(migration, /REVOKE ALL ON FUNCTION[\s\S]*FROM PUBLIC/);
    assert.match(migration, /FROM anon/);
    assert.match(migration, /FROM authenticated/);
    assert.match(migration, /GRANT EXECUTE ON FUNCTION[\s\S]*TO supabase_auth_admin/);
});

const envMap = Object.fromEntries(read('.env')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
const projectRef = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();
const adminId = '00000000-0000-4000-8000-00000000000a';
const authUser = {
    id: adminId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'admin@test.local',
    email_confirmed_at: now,
    confirmed_at: now,
    last_sign_in_at: now,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '測試管理員', avatar_url: '' },
    identities: [],
    created_at: now,
    updated_at: now,
};
const session = {
    access_token: 'mock.a',
    token_type: 'bearer',
    expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    refresh_token: 'mock.r',
    user: authUser,
};
const users = [{ id: adminId, name: '測試管理員', email: 'admin@test.local', role: 'admin', created_at: now }];
const invites = [];
const authWriteRequests = [];
const inviteWrites = [];

function jsonResponse(route, data, status = 200) {
    const headers = { 'content-type': 'application/json' };
    if (Array.isArray(data)) {
        headers['content-range'] = data.length ? `0-${data.length - 1}/${data.length}` : '*/0';
    }
    return route.fulfill({ status, headers, body: JSON.stringify(data) });
}

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    if (url.pathname.startsWith('/auth/v1/')) {
        if (request.method() !== 'GET') authWriteRequests.push(`${request.method()} ${url.pathname}`);
        if (url.pathname === '/auth/v1/user') return jsonResponse(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return jsonResponse(route, session);
        return jsonResponse(route, {});
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) return jsonResponse(route, null);
    if (!url.pathname.startsWith('/rest/v1/')) return jsonResponse(route, {}, 404);

    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
    const method = request.method();
    if (method === 'POST' && table === 'teacher_invites') {
        const payload = JSON.parse(request.postData() || '{}');
        inviteWrites.push(payload);
        invites.push({ id: 'invite-0001', created_at: now, ...payload });
        return jsonResponse(route, [], 201);
    }
    if (method !== 'GET') return route.fulfill({ status: 204, body: '' });

    const accept = (await request.allHeaders()).accept || '';
    const wantsObject = accept.includes('vnd.pgrst.object+json');
    let data;
    if (table === 'users') {
        const idFilter = url.searchParams.get('id');
        const rows = idFilter ? users.filter((user) => `eq.${user.id}` === idFilter) : users;
        data = wantsObject ? (rows[0] || null) : rows;
    } else if (table === 'teacher_invites') {
        data = wantsObject ? (invites[0] || null) : invites;
    } else {
        data = wantsObject ? null : [];
    }
    return jsonResponse(route, data);
}

async function waitForServer(url, timeoutMs) {
    const startedAt = Date.now();
    for (;;) {
        try {
            const response = await fetch(url);
            if (response.ok || response.status === 404) return;
        } catch {
            // Preview server is not ready yet.
        }
        if (Date.now() - startedAt > timeoutMs) throw new Error(`server timeout: ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

if (process.env.SKIP_GOOGLE_ONLY_BUILD !== '1') {
    console.log('\n── production build ──');
    execSync('npm run build', { cwd: appDir, stdio: 'inherit' });
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
    await waitForServer(baseUrl, 15000);
    browser = await chromium.launch();

    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await adminContext.addInitScript(({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: session });
    await adminContext.route('**/*', handleRoute);
    const adminPage = await adminContext.newPage();
    const dialogs = [];
    adminPage.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.accept();
    });

    await adminPage.goto(`${baseUrl}/admin/teachers`, { waitUntil: 'networkidle', timeout: 20000 });
    await adminPage.getByRole('button', { name: '新增講師' }).click();

    const googleOnlyCopyCount = await adminPage.getByText(/無需另外設定密碼/).count();
    check('真瀏覽器顯示 Google 建檔說明且沒有密碼欄', () => {
        assert.equal(googleOnlyCopyCount, 1);
    });
    const passwordFieldCount = await adminPage.locator('input[type="password"]').count();
    check('真瀏覽器密碼欄數量為 0', () => assert.equal(passwordFieldCount, 0));

    await adminPage.screenshot({ path: screenshotPath, fullPage: true });
    authWriteRequests.length = 0;
    await adminPage.getByPlaceholder('姓名', { exact: true }).fill('  測試講師  ');
    await adminPage.getByPlaceholder('Email', { exact: true }).fill('Test.Teacher@Example.com');
    await adminPage.getByRole('button', { name: '確認建立' }).click();
    await adminPage.waitForTimeout(300);

    check('送出的登入名單資料會 trim 姓名並正規化 Email', () => {
        assert.deepEqual(inviteWrites, [{
            name: '測試講師',
            email: 'test.teacher@example.com',
            role: 'teacher',
        }]);
    });
    check('管理員建檔不會呼叫任何 Auth 寫入 API', () => assert.deepEqual(authWriteRequests, []));
    check('成功訊息指示使用相同 Email 的 Google 帳號登入', () => {
        assert.ok(dialogs.some((message) => /相同 Email 的 Google 帳號登入/.test(message)));
    });

    await adminPage.close();
    await adminContext.close();

    const publicContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await publicContext.route('**/*', handleRoute);
    const publicPage = await publicContext.newPage();
    await publicPage.goto(baseUrl, { waitUntil: 'networkidle', timeout: 20000 });
    const publicText = await publicPage.locator('body').innerText();
    check('公開頁只留下 Google 登入入口', () => {
        assert.match(publicText, /使用\s+Google(?:\s+帳號)?\s*登入/i);
        assert.doesNotMatch(publicText, /臨時登入|密碼登入|註冊一個/);
    });
    await publicPage.close();
    await publicContext.close();
} finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
}

console.log(`\nScreenshot: ${screenshotPath}`);
const passed = results.filter(({ pass }) => pass).length;
console.log(`\n=== ${passed}/${results.length} PASS ===`);
process.exit(passed === results.length ? 0 : 1);
