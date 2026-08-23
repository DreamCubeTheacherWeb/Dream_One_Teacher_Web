#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4221;
const baseUrl = `http://127.0.0.1:${port}`;
const now = new Date().toISOString();
const userId = '00000000-0000-4000-8000-000000000001';
const announcement = {
    id: 'internal-announcement',
    title: '講師限定公告',
    content: '<p>僅限已核准帳號閱讀</p>',
    tag: '重要公告',
    pinned: true,
    published: true,
    created_at: now,
};
const completeInstructor = {
    id: '00000000-0000-4000-8000-000000000002',
    user_id: userId,
    full_name: '測試講師',
    nickname: '測試講師',
    gender: '測試',
    birth_date: '2000-01-01',
    id_number: 'A123456789',
    phone_mobile: '0900000000',
    line_id: 'teacher',
    address: '地址',
    household_address: '戶籍地址',
    email_primary: 'teacher@test.local',
    teaching_freq_semester: '1',
    teaching_freq_vacation: '1',
    bio_notes: '簡介',
    bank_account_name: '測試講師',
    bank_name: '銀行',
    bank_branch: '分行',
    bank_account_number: '123',
    bank_code: '000',
    teaching_regions: ['臺北市'],
    id_front_path: 'id/front.png',
    id_back_path: 'id/back.png',
    bankbook_path: 'bank/book.png',
    photo_path: null,
};

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));

const jsonResponse = (route, data, status = 200) => route.fulfill({
    status,
    headers: {
        'content-type': 'application/json',
        'content-range': Array.isArray(data) && data.length ? `0-${data.length - 1}/${data.length}` : '*/0',
    },
    body: JSON.stringify(data),
});

const authState = (role) => {
    const user = {
        id: userId,
        aud: 'authenticated',
        role: 'authenticated',
        email: 'teacher@test.local',
        email_confirmed_at: now,
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { full_name: '測試講師' },
        identities: [],
        created_at: now,
        updated_at: now,
    };
    const session = {
        access_token: 'mock.access.token',
        token_type: 'bearer',
        expires_in: 31536000,
        expires_at: Math.floor(Date.now() / 1000) + 31536000,
        refresh_token: 'mock.refresh.token',
        user,
    };
    return {
        user,
        session,
        profile: { id: userId, name: '測試講師', email: user.email, role, created_at: now },
    };
};

const makeRouteHandler = (role, counters) => {
    const auth = role ? authState(role) : null;
    return async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
        if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.abort();
        if (!url.hostname.endsWith('.supabase.co')) return route.abort();

        if (url.pathname === '/auth/v1/user') {
            return auth ? jsonResponse(route, auth.user) : jsonResponse(route, {}, 401);
        }
        if (url.pathname.startsWith('/auth/v1/')) {
            return jsonResponse(route, auth?.session || {});
        }
        if (url.pathname.startsWith('/rest/v1/rpc/')) return jsonResponse(route, null);
        if (!url.pathname.startsWith('/rest/v1/')) return jsonResponse(route, {}, 404);

        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = (await request.allHeaders()).accept?.includes('vnd.pgrst.object+json');
        if (table === 'announcements') {
            counters.announcementReads += 1;
            return jsonResponse(route, acceptsObject ? announcement : [announcement]);
        }
        if (table === 'users') return jsonResponse(route, auth ? (acceptsObject ? auth.profile : [auth.profile]) : []);
        if (table === 'instructors') return jsonResponse(route, acceptsObject ? completeInstructor : [completeInstructor]);
        return jsonResponse(route, acceptsObject ? null : []);
    };
};

const waitForServer = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
        try {
            const response = await fetch(baseUrl);
            if (response.ok) return;
        } catch { /* preview 尚未啟動 */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Vite preview did not start');
};

const inspect = async (browser, { role = null, pathName = '/' }) => {
    const counters = { announcementReads: 0 };
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    if (role) {
        await context.addInitScript(({ key, session }) => {
            window.localStorage.setItem(key, JSON.stringify(session));
        }, { key: storageKey, session: authState(role).session });
    }
    await context.route('**/*', makeRouteHandler(role, counters));
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`${baseUrl}${pathName}`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(500);
    const result = {
        pathName: new URL(page.url()).pathname,
        bulletinCount: await page.getByRole('heading', { name: '佈告欄', exact: true }).count(),
        titleCount: await page.getByText(announcement.title, { exact: true }).count(),
        announcementReads: counters.announcementReads,
        pageErrors,
    };
    await context.close();
    return result;
};

const expect = (condition, message, detail) => {
    if (!condition) throw new Error(`${message}: ${JSON.stringify(detail)}`);
    process.stdout.write(`PASS ${message}\n`);
};

execSync('npm run build', { cwd: appDir, stdio: 'inherit' });
const preview = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
    await waitForServer();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });

    const anonymousHome = await inspect(browser, {});
    expect(anonymousHome.bulletinCount === 0 && anonymousHome.announcementReads === 0 && anonymousHome.pageErrors.length === 0,
        '未登入首頁不顯示也不讀取公告', anonymousHome);

    const anonymousDetail = await inspect(browser, { pathName: '/announcements/internal-announcement' });
    expect(anonymousDetail.pathName === '/' && anonymousDetail.announcementReads === 0 && anonymousDetail.pageErrors.length === 0,
        '未登入者不能用網址直接讀取公告', anonymousDetail);

    const pendingHome = await inspect(browser, { role: 'pending' });
    expect(pendingHome.pathName === '/pending' && pendingHome.bulletinCount === 0 && pendingHome.announcementReads === 0 && pendingHome.pageErrors.length === 0,
        '待審核帳號首頁不顯示也不讀取公告', pendingHome);

    const pendingDetail = await inspect(browser, { role: 'pending', pathName: '/announcements/internal-announcement' });
    expect(pendingDetail.pathName === '/pending' && pendingDetail.announcementReads === 0 && pendingDetail.pageErrors.length === 0,
        '待審核帳號不能用網址直接讀取公告', pendingDetail);

    const teacherHome = await inspect(browser, { role: 'teacher' });
    expect(teacherHome.pathName === '/' && teacherHome.bulletinCount === 1 && teacherHome.titleCount === 1 && teacherHome.announcementReads > 0 && teacherHome.pageErrors.length === 0,
        '已核准講師可在首頁看到公告', teacherHome);

    const teacherDetail = await inspect(browser, { role: 'teacher', pathName: '/announcements/internal-announcement' });
    expect(teacherDetail.pathName === '/announcements/internal-announcement' && teacherDetail.titleCount === 1 && teacherDetail.announcementReads > 0 && teacherDetail.pageErrors.length === 0,
        '已核准講師可開啟公告詳情', teacherDetail);
} finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
}
