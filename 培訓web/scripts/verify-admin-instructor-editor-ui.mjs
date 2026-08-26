#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4236;
const baseUrl = `http://localhost:${port}`;
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
    }));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();
const instructorId = '10000000-0000-4000-8000-000000000001';

let instructor = {
    id: instructorId,
    user_id: null,
    full_name: '林測試',
    nickname: '測試老師',
    email_primary: 'teacher@example.com',
    phone_mobile: '0912345678',
    employment_status: 'active',
    instructor_role: 'A',
    teaching_regions: ['臺北市'],
    bank_account_name: '林測試',
    bank_name: '華南銀行',
    bank_branch: '總行',
    bank_code: '0080000',
    bank_account_number: '1234567890',
    hide_from_leaderboard: false,
    created_at: now,
    updated_at: now,
};
let patchRequests = [];

const makeSession = (role) => {
    const userId = role === 'admin'
        ? '00000000-0000-4000-8000-000000000001'
        : '00000000-0000-4000-8000-000000000002';
    const user = {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: `${role}@example.com`,
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { full_name: role === 'admin' ? '測試管理員' : '測試輔導員' },
        created_at: now,
        updated_at: now,
    };
    return {
        user,
        session: {
            access_token: `mock.${role}.token`,
            refresh_token: `mock.${role}.refresh`,
            token_type: 'bearer',
            expires_in: 31536000,
            expires_at: Math.floor(Date.now() / 1000) + 31536000,
            user,
        },
        profile: { id: userId, name: user.user_metadata.full_name, email: user.email, role, created_at: now },
    };
};

const respond = (route, body, status = 200) => {
    const headers = { 'content-type': 'application/json' };
    if (Array.isArray(body)) headers['content-range'] = body.length ? `0-${body.length - 1}/${body.length}` : '*/0';
    return route.fulfill({ status, headers, body: JSON.stringify(body) });
};

const routeHandler = ({ user, session, profile }) => async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseUrl) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return respond(route, user);
        if (url.pathname.startsWith('/auth/v1/token')) return respond(route, session);
        return respond(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        if (url.pathname.endsWith('/claim_my_precreated_instructor')) return respond(route, { status: 'staff' });
        return respond(route, null);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return respond(route, {}, 404);

    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
    const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');

    if (table === 'instructors' && request.method() === 'PATCH') {
        const payload = request.postDataJSON();
        patchRequests.push({ role: profile.role, payload });
        instructor = { ...instructor, ...payload, updated_at: new Date().toISOString() };
        return respond(route, wantsObject ? instructor : [instructor]);
    }
    if (request.method() !== 'GET') return route.fulfill({ status: 204, body: '' });

    let rows = [];
    if (table === 'users') {
        rows = [profile];
    } else if (table === 'instructors') {
        const idFilter = url.searchParams.get('id');
        const userFilter = url.searchParams.get('user_id');
        if (idFilter) rows = idFilter === `eq.${instructor.id}` ? [instructor] : [];
        else if (userFilter) rows = userFilter === `eq.${instructor.user_id}` ? [instructor] : [];
        else rows = [instructor];
    } else if (table === 'contract_documents') {
        rows = [];
    }
    return respond(route, wantsObject ? (rows[0] || null) : rows);
};

async function waitForServer() {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
            const response = await fetch(baseUrl);
            if (response.ok) return;
        } catch { /* preview not ready */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('preview server timeout');
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
    await waitForServer();
    browser = await chromium.launch(existsSync(chromePath) ? { executablePath: chromePath } : {});

    const admin = makeSession('admin');
    const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await adminContext.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: admin.session });
    await adminContext.route('**/*', routeHandler(admin));
    const adminPage = await adminContext.newPage();
    await adminPage.goto(`${baseUrl}/admin/teachers`, { waitUntil: 'networkidle' });
    const unclaimedCard = adminPage.getByRole('link', { name: '主檔未認領 1，查看與編輯' });
    assert.equal(await unclaimedCard.count(), 1);
    await unclaimedCard.click();
    await adminPage.waitForURL(`${baseUrl}/admin/instructors?claim=unlinked`);
    assert.equal(await adminPage.getByRole('button', { name: '未認領 1' }).getAttribute('aria-pressed'), 'true');
    const instructorRow = adminPage.locator('tr').filter({ hasText: '林測試' }).first();
    assert.equal(await instructorRow.getByRole('link', { name: '編輯資料' }).count(), 1);
    await instructorRow.getByRole('link', { name: '編輯資料' }).click();
    await adminPage.getByRole('heading', { name: '編輯講師資料' }).waitFor();
    assert.match(adminPage.url(), new RegExp(`/admin/instructors/${instructorId}/edit$`));
    assert.equal(await adminPage.getByText('僅管理員可編輯', { exact: true }).count(), 1);
    assert.equal(await adminPage.getByText(/尚未認領帳號/).count(), 1);
    await adminPage.screenshot({ path: '/tmp/dream-one-admin-instructor-editor-desktop.png', fullPage: true });

    const nameField = adminPage.getByLabel('姓名 *');
    await nameField.fill('林管理員更新');
    await adminPage.getByLabel('管理員內部備註').fill('僅管理員可見');
    await adminPage.getByTestId('save-instructor').click();
    await adminPage.getByText('講師資料已更新。', { exact: true }).waitFor();
    assert.equal(patchRequests.length, 1);
    assert.equal(patchRequests[0].role, 'admin');
    assert.equal(patchRequests[0].payload.full_name, '林管理員更新');
    assert.equal(patchRequests[0].payload.note_internal, '僅管理員可見');
    assert.equal(Object.hasOwn(patchRequests[0].payload, 'user_id'), false);
    console.log('PASS  管理員可從帳號頁直達未認領清單，並在 user_id 為空時更新完整主檔');

    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.reload({ waitUntil: 'networkidle' });
    const overflow = await adminPage.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `mobile horizontal overflow=${overflow}`);
    assert.ok((await adminPage.getByTestId('save-instructor').boundingBox()).height >= 44);
    await adminPage.screenshot({ path: '/tmp/dream-one-admin-instructor-editor-mobile.png', fullPage: true });
    console.log('PASS  390px 編輯頁無水平溢出且主要操作熱區達 44px');
    await adminContext.close();

    const mentor = makeSession('mentor');
    const mentorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mentorContext.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: mentor.session });
    await mentorContext.route('**/*', routeHandler(mentor));
    const mentorPage = await mentorContext.newPage();
    await mentorPage.goto(`${baseUrl}/admin/instructors`, { waitUntil: 'networkidle' });
    assert.equal(await mentorPage.getByRole('link', { name: '編輯資料' }).count(), 0);
    await mentorPage.goto(`${baseUrl}/admin/instructors/${instructorId}/edit`, { waitUntil: 'networkidle' });
    await mentorPage.waitForURL(`${baseUrl}/`);
    assert.equal(patchRequests.filter((request) => request.role === 'mentor').length, 0);
    console.log('PASS  輔導員看不到編輯入口，直接網址也會被導回首頁且沒有 PATCH');
    await mentorContext.close();
} finally {
    await browser?.close();
    preview.kill('SIGTERM');
}
