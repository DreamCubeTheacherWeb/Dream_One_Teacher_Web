#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4241;
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

const instructors = [
    {
        id: '10000000-0000-4000-8000-000000000001', full_name: '王小明', instructor_role: 'A',
        id_number: 'A123456789', household_address: '臺北市信義區一號', address: '臺北市大安區二號',
        phone_mobile: '0912345678', bank_code: '0080001', bank_account_number: '001234567890',
        email_primary: 'wang@example.com', user_id: null,
    },
    {
        id: '10000000-0000-4000-8000-000000000002', full_name: '李小華', instructor_role: 'B',
        id_number: 'B223456789', household_address: '新北市板橋區三號', address: '新北市新店區四號',
        phone_mobile: '0922345678', bank_code: null, bank_account_number: '009876543210',
        email_primary: 'lee@example.com', user_id: null,
    },
    {
        id: '10000000-0000-4000-8000-000000000003', full_name: '陳小美', instructor_role: 'S',
        id_number: 'C223456789', household_address: '桃園市中壢區五號', address: '桃園市桃園區六號',
        phone_mobile: '0932345678', bank_code: '8120002', bank_account_number: '000000001234',
        email_primary: 'chen@example.com', user_id: null,
    },
];
const sessions = [
    { id: '20000000-0000-4000-8000-000000000001', instructor_id: instructors[0].id, session_date: '2026-06-05' },
    { id: '20000000-0000-4000-8000-000000000002', instructor_id: instructors[0].id, session_date: '2026-06-20' },
    { id: '20000000-0000-4000-8000-000000000003', instructor_id: instructors[1].id, session_date: '2026-06-18' },
    { id: '20000000-0000-4000-8000-000000000004', instructor_id: instructors[2].id, session_date: '2026-07-02' },
];

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
    if (request.method() !== 'GET') return route.fulfill({ status: 204, body: '' });

    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
    const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
    let rows = [];
    if (table === 'users') rows = [profile];
    else if (table === 'instructors') {
        const userFilter = url.searchParams.get('user_id');
        rows = userFilter ? [] : instructors;
    } else if (table === 'class_sessions') rows = sessions;
    else if (table === 'courses' || table === 'assignments' || table === 'site_links') rows = [];
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
    const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    await adminContext.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: admin.session });
    await adminContext.route('**/*', routeHandler(admin));
    const page = await adminContext.newPage();
    await page.goto(`${baseUrl}/admin/salary/export`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '報酬供應商 CSV 匯出' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '匯出 3 位老師' }).count(), 1);
    assert.equal(await page.getByText('1 位待補資料', { exact: true }).count(), 1);

    await page.getByLabel('課程日期起').fill('2026-06-01');
    await page.getByLabel('課程日期迄').fill('2026-06-30');
    assert.equal(await page.getByRole('button', { name: '匯出 2 位老師' }).count(), 1);

    await page.getByLabel('目前講師等級').selectOption('A');
    assert.equal(await page.getByRole('button', { name: '匯出 1 位老師' }).count(), 1);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '匯出 1 位老師' }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), '夢想講師供應商_2026-06-01-2026-06-30_20260826.csv');
    const downloadPath = await download.path();
    const csv = readFileSync(downloadPath, 'utf8');
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    assert.match(csv, /＊群組Z004\/Z007個人\/Z008公司,夥伴號碼/);
    assert.match(csv, /Z007,,王小明,王小明,TW,A123456789/);
    assert.doesNotMatch(csv, /李小華|陳小美/);
    await page.screenshot({ path: '/private/tmp/dream-one-salary-vendor-export-desktop.png', fullPage: true });
    console.log('PASS  管理員可依日期與等級縮小到單一老師，下載相同 16 欄供應商 CSV');

    await page.getByLabel('目前講師等級').selectOption('');
    await page.getByLabel('搜尋老師').fill('陳小美');
    await page.getByRole('button', { name: '選取搜尋結果' }).click();
    assert.equal(await page.getByText('已勾選 1 位。', { exact: false }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '匯出 0 位老師' }).count(), 1);
    await page.getByLabel('課程日期起').fill('2026-07-01');
    await page.getByLabel('課程日期迄').fill('2026-07-31');
    assert.equal(await page.getByRole('button', { name: '匯出 1 位老師' }).count(), 1);
    console.log('PASS  可搜尋並複選指定老師，日期區間會再與老師條件交集');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `mobile horizontal overflow=${overflow}`);
    const exportButton = page.getByRole('button', { name: /匯出 3 位老師/ });
    assert.ok((await exportButton.boundingBox()).height >= 44);
    await page.screenshot({ path: '/private/tmp/dream-one-salary-vendor-export-mobile.png', fullPage: true });
    console.log('PASS  390px 畫面無水平溢出，主要匯出操作熱區達 44px');
    await adminContext.close();

    const mentor = makeSession('mentor');
    const mentorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await mentorContext.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: mentor.session });
    await mentorContext.route('**/*', routeHandler(mentor));
    const mentorPage = await mentorContext.newPage();
    await mentorPage.goto(`${baseUrl}/admin/salary/export`, { waitUntil: 'networkidle' });
    await mentorPage.waitForURL(`${baseUrl}/`);
    assert.equal(await mentorPage.getByRole('heading', { name: '報酬供應商 CSV 匯出' }).count(), 0);
    console.log('PASS  輔導員直接開啟敏感匯出網址會被導回首頁');
    await mentorContext.close();
} finally {
    await browser?.close();
    preview.kill('SIGTERM');
}
