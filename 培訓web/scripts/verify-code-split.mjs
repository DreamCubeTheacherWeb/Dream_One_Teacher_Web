#!/usr/bin/env node
/*
 * 驗證：整站改成「依頁面拆檔（React.lazy）」之後，沒有任何一頁壞掉。
 *
 * 做法：npm run build → vite preview 跑「建置產物」→ mock Supabase（不連任何真實後端）→ 真瀏覽器逐一打開
 * App.jsx 裡的每一條路由，五種身分各走一遍：
 *   admin（全部頁面）／mentor（staffOnly 可進、adminOnly 被導回首頁）／teacher（講師頁可進、後台被導回首頁）／
 *   pending（只能進 /profile、/pending，其他導去 /pending）／anonymous（受保護頁導回首頁）
 * 每一頁都斷言：目標文字出現（或被導到正確網址）、console 沒有 error、沒有 pageerror、沒有 4xx/5xx 或載入失敗的請求、
 * 沒有跳出 alert。另外驗：
 *   S  建置產物：入口 chunk gzip ≤ 260KB、頁面確實拆成很多 chunk、入口不靜態相依頁面 chunk
 *   G  守衛先於下載：講師打開後台網址，連後台頁面的 JS 檔都不會被下載
 *   H  首頁（未登入）不下載大型套件（pdf-lib／quill／pdf.js／jszip）
 *   N  未知網址顯示「找不到這個頁面」，且「回首頁」連結可用
 *   P  vite:preloadError：換版後舊分頁載不到頁面檔 → 自動重新整理一次後恢復；永遠載不到 → 只重整一次、不無限重整，
 *      並顯示錯誤提示（導覽列仍在）
 *
 * 用法：node scripts/verify-code-split.mjs
 * 環境變數 PROBE=1：只印每頁的 h1 與開頭文字（寫斷言用的偵察模式）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PROBE = process.env.PROBE === '1';

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();

// ───────────────────────── 假資料 ─────────────────────────
const IDS = {
    admin: '00000000-0000-4000-8000-0000000000a1',
    mentor: '00000000-0000-4000-8000-0000000000a2',
    teacher: '00000000-0000-4000-8000-0000000000a3',
    pending: '00000000-0000-4000-8000-0000000000a4',
};
const COURSE_ID = '10000000-0000-4000-8000-000000000001';
const CATEGORY_ID = '10000000-0000-4000-8000-000000000002';
const LESSON_ID = '10000000-0000-4000-8000-000000000003';
const ANNOUNCEMENT_ID = '10000000-0000-4000-8000-000000000004';
const CONTRACT_ID = '10000000-0000-4000-8000-000000000005';
const INSTRUCTOR_ID = '10000000-0000-4000-8000-000000000006';

const authUserOf = (id, label) => ({
    id, aud: 'authenticated', role: 'authenticated', email: `${label}@test.local`,
    email_confirmed_at: now, confirmed_at: now, last_sign_in_at: now,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: `${label}測試員`, avatar_url: '' }, identities: [], created_at: now, updated_at: now,
});
const sessionOf = (user) => ({
    access_token: 'mock.code.split', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.refresh', user,
});
const PERSONAS = {};
for (const role of ['admin', 'mentor', 'teacher', 'pending']) {
    const authUser = authUserOf(IDS[role], role);
    PERSONAS[role] = { role, id: IDS[role], authUser, session: sessionOf(authUser) };
}
PERSONAS.anonymous = { role: 'anonymous', id: null, authUser: null, session: null };

const USERS = ['admin', 'mentor', 'teacher', 'pending'].map(role => ({
    id: IDS[role], name: `${role}測試員`, email: `${role}@test.local`, role, created_at: now, updated_at: now, mentor_name: null,
}));
const completeInstructor = (userId, id, fullName) => ({
    id, user_id: userId, full_name: fullName, nickname: '小測', gender: '女', birth_date: '1990-01-01',
    id_number: 'A123456789', phone_mobile: '0912345678', line_id: 'line-test', address: '臺北市測試路 1 號',
    household_address: '臺北市測試路 1 號', email_primary: 'teacher@test.local', email_secondary: '',
    instructor_role: 'A', teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次',
    teaching_regions: ['臺北市'], bio_notes: '測試資料', bank_account_name: fullName, bank_name: '測試銀行',
    bank_branch: '測試分行', bank_account_number: '1234567890', bank_code: '822123',
    photo_path: 'mock/photo.jpg', id_front_path: 'mock/id-front.jpg', id_back_path: 'mock/id-back.jpg',
    bankbook_path: 'mock/bankbook.jpg', id_front_url: 'x', id_back_url: 'x', bankbook_url: 'x',
    employment_status: 'active', hide_from_leaderboard: false, speed_qualification: null, created_at: now,
});
const INSTRUCTORS = [
    completeInstructor(IDS.teacher, INSTRUCTOR_ID, '分檔測試講師'),
    { ...completeInstructor(null, '10000000-0000-4000-8000-000000000007', '尚未綁定講師'), email_primary: 'unlinked@test.local' },
];
const CONTRACT_DOCUMENTS = [
    { id: 'doc-rules', doc_type: 'rules', display_name: '講師管理辦法', version: 2, sort_order: 1, doc_category: 'contract', doc_mode: 'view_only', is_active: true, file_path: 'templates/rules/v2.pdf', file_name: 'rules.pdf' },
    { id: 'doc-compensation', doc_type: 'compensation', display_name: '講師委任報酬表', version: 1, sort_order: 2, doc_category: 'contract', doc_mode: 'view_only', is_active: true, file_path: 'templates/compensation/v1.pdf', file_name: 'compensation.pdf' },
    { id: 'doc-contract', doc_type: 'contract', display_name: '委任契約書', version: 3, sort_order: 3, doc_category: 'contract', doc_mode: 'fill_sign', is_active: true, file_path: 'templates/contract/v3.pdf', file_name: 'contract.pdf' },
];
const SEED = {
    users: USERS,
    instructors: INSTRUCTORS,
    course_categories: [{ id: CATEGORY_ID, title: '分檔測試大分類', visibility: 'all', is_published: true, order: 1, created_at: now }],
    courses: [{ id: COURSE_ID, title: '分檔測試課程', description: '分檔測試用課程', category_id: CATEGORY_ID, is_published: true, order: 1, created_at: now }],
    lessons: [{ id: LESSON_ID, course_id: COURSE_ID, title: '分檔測試單元', order: 1, requires_assignment: false, created_at: now }],
    announcements: [{ id: ANNOUNCEMENT_ID, title: '分檔測試公告', content: '公告內文', body: '公告內文', tag: '公告', published: true, created_at: now }],
    // 同一份合約掛在講師與 mentor 名下（合約檢視頁對非 admin 會加 user_id 篩選）
    instructor_contracts: [IDS.teacher, IDS.mentor, IDS.admin].map(userId => ({
        id: CONTRACT_ID, user_id: userId, status: 'signed', signed_at: now, filled_name: '分檔測試講師',
        filled_instructor_role: 'A', filled_id_number: 'A123456789', filled_address: '臺北市測試路 1 號',
        filled_phone: '0912345678', doc_versions: {}, signed_pdf_paths: {}, signature_path: null,
    })),
    contract_documents: CONTRACT_DOCUMENTS,
    contract_field_positions: [
        { id: 'pos-signature', doc_type: 'contract', doc_version: 3, field_type: 'signature', page_number: 1, x: 300, y_from_top: 600, width: 160, height: 60, font_size: 13 },
        { id: 'pos-name', doc_type: 'contract', doc_version: 3, field_type: 'name', page_number: 1, x: 120, y_from_top: 120, width: 160, height: 24, font_size: 13 },
    ],
    site_links: [{ key: 'salary_direct', label: '測試表單', description: '測試', url: 'https://example.com/form' }],
    instructor_salary_summary: [{
        user_id: IDS.teacher, full_name: '分檔測試講師', this_month_salary: 0, this_month_sessions: 0, this_year_salary: 0,
        total_unpaid: 0, total_paid: 0, total_salary: 0, total_sessions: 0, total_hours: 0, pending_salary: 0, approved_unpaid_salary: 0,
    }],
};
const MINIMAL_PDF = Buffer.from(
    'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwMgolJUVPRgo=',
    'base64'
);

const json = (route, data, status = 200) => route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}) },
    body: JSON.stringify(data),
});

// 只處理「欄位=eq.值」這種篩選；其他條件（in、order、limit）一律忽略，回傳整張假表
const queryRows = (table, url) => {
    let rows = SEED[table] || [];
    for (const [key, value] of url.searchParams) {
        if (!value.startsWith('eq.')) continue;
        const wanted = value.slice(3);
        if (rows.length && !(key in rows[0])) continue;
        rows = rows.filter(row => String(row[key]) === wanted);
    }
    return rows;
};

function makeHandler(persona) {
    return async function handleRoute(route) {
        const request = route.request();
        const url = new URL(request.url());
        if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
        // 字型：回空樣式表，不真的連網，也不讓失敗的外部請求污染 console
        if (url.hostname === 'fonts.googleapis.com') return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
        if (url.hostname === 'fonts.gstatic.com') return route.fulfill({ status: 200, contentType: 'font/woff2', body: '' });
        if (!url.hostname.endsWith('.supabase.co')) return route.abort();
        // 只要有任何請求會打到 supabase.co，一律在這裡被假資料接住（不會真的出網路）
        if (url.pathname.startsWith('/auth/v1/')) {
            if (url.pathname === '/auth/v1/user') return json(route, persona.authUser);
            if (url.pathname.startsWith('/auth/v1/token')) return json(route, persona.session);
            return json(route, {});
        }
        if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, []);
        if (url.pathname.startsWith('/storage/v1/object/sign/') && request.method() === 'POST') {
            return json(route, { signedURL: `${url.pathname.replace('/storage/v1', '')}?token=mock` });
        }
        if (url.pathname.startsWith('/storage/v1/object/')) {
            return route.fulfill({ status: 200, contentType: 'application/pdf', body: MINIMAL_PDF });
        }
        if (url.pathname.startsWith('/storage/v1/')) return json(route, []);
        if (url.pathname.startsWith('/rest/v1/')) {
            const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
            const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
            if (request.method() !== 'GET') return json(route, wantsObject ? {} : [], 201);
            const rows = queryRows(table, url);
            return json(route, wantsObject ? (rows[0] ?? null) : rows);
        }
        return json(route, {}, 404);
    };
}

// ───────────────────────── 路由表 ─────────────────────────
// expect：頁面上要出現的文字（RegExp，比對 body.innerText）；redirect：預期被導向的網址 pathname
const route = (p, expect, access = 'any') => ({ path: p, expect, access });
const ROUTES = [
    route('/', /提升教學專業/),
    route('/privacy', /隱私權政策/),
    route('/terms', /服務條款/),
    route('/pending', /帳號審核中/, 'pending-page'),
    route(`/announcements/${ANNOUNCEMENT_ID}`, /分檔測試公告/, 'approved'),
    route('/profile', /歡迎加入|個人資料/, 'allowPending'),
    route('/courses', /分檔測試大分類/, 'user'),
    route('/leaderboard', /講師榮譽榜/, 'user'),
    route('/cube', /方塊競速/, 'user'),
    route(`/courses/${COURSE_ID}`, /分檔測試課程/, 'user'),
    route(`/courses/${COURSE_ID}/lessons/${LESSON_ID}`, /分檔測試單元/, 'user'),
    route('/admin', /後台管理總覽/, 'staff'),
    route(`/admin/cms/${COURSE_ID}`, /課程基本資訊/, 'staff'),
    route('/admin/course-categories', /課程大分類/, 'admin'),
    route('/admin/assignments', /作業審核中心/, 'staff'),
    route('/admin/teachers', /帳號審核與權限/, 'admin'),
    route('/admin/progress', /培訓進度總覽/, 'staff'),
    route('/admin/announcements', /佈告欄管理/, 'admin'),
    route('/admin/instructors', /講師資料總覽/, 'staff'),
    route(`/admin/instructors/${INSTRUCTOR_ID}/edit`, /編輯講師資料/, 'admin'),
    route('/contract', /講師管理辦法/, 'contract'),
    route(`/contract/view/${CONTRACT_ID}`, /合約檢視/, 'contract'),
    route('/admin/contracts', /合約文件管理/, 'admin'),
    // 2026-10-22 起報酬與表單（含身分證、銀行資料）只限 admin
    route('/admin/salary', /報酬登記中心/, 'admin'),
    route('/admin/salary/export', /報酬供應商 CSV 匯出/, 'admin'),
    route('/admin/salary/options', /回報選項管理/, 'admin'),
    route('/admin/download-center', /講師表單預覽與下載/, 'admin'),
    route('/admin/badges', /徽章管理/, 'admin'),
    route('/admin/salary-links', /網站連結管理/, 'admin'),
    route('/admin/notifications', /廣播通知/, 'admin'),
    route('/my/salary', /我的報酬/, 'user'),
    route('/my/salary/new', /登記課程回報/, 'user'),
];
// /admin/claims 是純導向（不經守衛）→ 對有權限者落在 /admin/instructors
const CLAIMS = '/admin/claims';

// 這個身分打開這條路由，預期看到什麼：{ expect } 或 { redirect }
function expectationFor(role, r) {
    const approved = ['admin', 'mentor', 'teacher'].includes(role);
    switch (r.access) {
        case 'any':
            // 待審帳號被導到 /pending（含首頁與公開頁），這是改動前就有的行為
            return role === 'pending' ? { redirect: '/pending' } : { expect: r.expect };
        case 'pending-page':
            // 只有待審帳號留在 /pending；其他人（含訪客）被頁面本身導回首頁
            return role === 'pending' ? { expect: r.expect } : { redirect: '/' };
        case 'allowPending':
            return role === 'anonymous' ? { redirect: '/' } : { expect: r.expect };
        case 'approved':
            return approved ? { expect: r.expect } : { redirect: role === 'pending' ? '/pending' : '/' };
        case 'user':
            if (role === 'anonymous') return { redirect: '/' };
            return role === 'pending' ? { redirect: '/pending' } : { expect: r.expect };
        case 'staff':
            if (role === 'anonymous') return { redirect: '/' };
            if (role === 'pending') return { redirect: '/pending' };
            return ['admin', 'mentor'].includes(role) ? { expect: r.expect } : { redirect: '/' };
        case 'admin':
            if (role === 'anonymous') return { redirect: '/' };
            if (role === 'pending') return { redirect: '/pending' };
            return role === 'admin' ? { expect: r.expect } : { redirect: '/' };
        case 'contract':
            if (role === 'anonymous') return { redirect: '/' };
            if (role === 'pending') return { redirect: '/pending' };
            // 簽約入口只開給 admin／teacher／mentor；其餘導回 /profile（此處三種已核准角色都進得去）
            return { expect: r.expect };
        default: return null;
    }
}

// ───────────────────────── 工具 ─────────────────────────
const results = [];
const check = (name, condition, detail = '') => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});
const gzipSize = (file) => zlib.gzipSync(readFileSync(file), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function newPage(browser, persona, base, watchers) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    if (persona.session) {
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: persona.session });
    }
    await context.route('**/*', makeHandler(persona));
    // 即時連線（WebSocket）一律擋掉，確保不會連到任何真實 Supabase
    await context.routeWebSocket(/.*/, ws => ws.close());
    const page = await context.newPage();
    page.on('dialog', async (dialog) => { watchers.dialogs.push(dialog.message()); await dialog.dismiss(); });
    page.on('console', (msg) => { if (msg.type() === 'error') watchers.errors.push(msg.text()); });
    page.on('pageerror', (error) => watchers.pageErrors.push(String(error)));
    page.on('response', (response) => {
        const u = new URL(response.url());
        if (u.origin === base && response.status() >= 400) watchers.badResponses.push(`${response.status()} ${u.pathname}`);
        if (u.origin === base && u.pathname.endsWith('.js')) watchers.jsFiles.add(u.pathname.split('/').pop());
    });
    page.on('requestfailed', (request) => {
        const u = new URL(request.url());
        // ERR_ABORTED＝頁面跳轉時被瀏覽器取消的請求，不算失敗
        if (u.origin === base && !/ERR_ABORTED/.test(request.failure()?.errorText || '')) watchers.badResponses.push(`failed ${u.pathname}`);
    });
    return { context, page };
}
const newWatchers = () => ({ errors: [], pageErrors: [], badResponses: [], dialogs: [], jsFiles: new Set() });
const resetWatchers = (w) => { w.errors.length = 0; w.pageErrors.length = 0; w.badResponses.length = 0; w.dialogs.length = 0; };

async function visit(page, base, watchers, persona, pathName, expectation) {
    resetWatchers(watchers);
    await page.goto(`${base}${pathName}`, { waitUntil: 'networkidle' });
    let ok = true;
    let detail = '';
    if (PROBE) {
        await page.waitForTimeout(800);
        const info = await page.evaluate(() => ({ path: location.pathname, h1: [...document.querySelectorAll('h1')].map(h => h.innerText.trim()), text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 140) }));
        console.log(`PROBE ${persona.role} ${pathName} -> ${info.path} h1=${JSON.stringify(info.h1)} text="${info.text}"`);
        return;
    }
    try {
        if (expectation.redirect) {
            await page.waitForURL(u => new URL(u).pathname === expectation.redirect, { timeout: 8000 });
        } else {
            await page.waitForFunction(src => new RegExp(src).test(document.body.innerText), expectation.expect.source, { timeout: 10000 });
        }
    } catch {
        ok = false;
        detail = expectation.redirect
            ? `沒有被導到 ${expectation.redirect}，目前在 ${new URL(page.url()).pathname}`
            : `沒出現 ${expectation.expect}，h1=${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('h1')].map(h => h.innerText.trim())))}`;
    }
    await page.waitForTimeout(350); // 讓延後才發生的錯誤有機會浮現
    const problems = [];
    if (watchers.errors.length) problems.push(`console error x${watchers.errors.length}: ${watchers.errors[0].slice(0, 160)}`);
    if (watchers.pageErrors.length) problems.push(`pageerror: ${watchers.pageErrors[0].slice(0, 160)}`);
    if (watchers.badResponses.length) problems.push(`請求失敗: ${watchers.badResponses.slice(0, 3).join(', ')}`);
    if (watchers.dialogs.length) problems.push(`跳出 alert: ${watchers.dialogs[0].slice(0, 80)}`);
    const label = expectation.redirect ? `→ 導向 ${expectation.redirect}` : `顯示 ${expectation.expect}`;
    check(`${persona.role.padEnd(9)} ${pathName.replace(/[0-9a-f-]{36}/g, ':id')}  ${label}`, ok && !problems.length, [detail, ...problems].filter(Boolean).join(' | '));
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
    console.log('── npm run build ──');
    execSync('npm run build', { cwd: appDir, stdio: 'inherit' });

    // S：建置產物
    const distDir = path.join(appDir, 'dist');
    const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
    const entryName = html.match(/<script type="module"[^>]*src="\/assets\/([^"]+\.js)"/)[1];
    const entryFile = path.join(distDir, 'assets', entryName);
    const entryGz = gzipSize(entryFile);
    const jsChunks = readdirSync(path.join(distDir, 'assets')).filter(f => f.endsWith('.js'));
    const entrySource = readFileSync(entryFile, 'utf8');
    const staticImports = [...entrySource.matchAll(/(?:^|[;}])import(?:[^"'(]*?from)?\s*"\.\/([^"]+\.js)"/g)].map(m => m[1]);
    console.log(`入口 chunk ${entryName}  raw=${kb(readFileSync(entryFile).length)}  gzip=${kb(entryGz)}；JS chunk 共 ${jsChunks.length} 個`);
    check('S1 入口 chunk gzip ≤ 260KB', entryGz <= 260 * 1024, kb(entryGz));
    check('S2 頁面已拆成 ≥ 30 個 JS chunk', jsChunks.length >= 30, `${jsChunks.length} 個`);
    check('S3 入口 chunk 不靜態相依其他 chunk（首屏只載入口）', staticImports.length === 0, staticImports.join(',') || '無');
    check('S4 index.html 沒有預載頁面 chunk', !/rel="modulepreload"/.test(html));

    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const preview = spawn(path.join(appDir, 'node_modules/.bin/vite'), ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite preview pid=${preview.pid} port=${port}`);
    let previewLog = '';
    preview.stdout.on('data', c => { previewLog += c; });
    preview.stderr.on('data', c => { previewLog += c; });
    let browser;
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* 啟動中 */ }
            if (Date.now() > deadline) throw new Error(`vite preview 沒起來\n${previewLog}`);
            await new Promise(r => setTimeout(r, 250));
        }
        // 身分核對：我們打到的必須是剛 build 的產物
        const served = await (await fetch(base)).text();
        if (!served.includes(entryName)) throw new Error('preview 服務的不是剛建置的 dist，中止');

        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});

        // H：未登入首頁不下載大型套件
        {
            const watchers = newWatchers();
            const { context, page } = await newPage(browser, PERSONAS.anonymous, base, watchers);
            await page.goto(`${base}/`, { waitUntil: 'networkidle' });
            const totalJs = [...watchers.jsFiles];
            console.log(`未登入首頁載入的 JS：${totalJs.join(', ')}`);
            check('H1 未登入首頁只載入口 chunk（不下載其他頁面或大型套件）', totalJs.length === 1 && totalJs[0] === entryName, totalJs.join(','));
            await context.close();
        }

        // 五種身分逐一打開每條路由
        const personaOrder = (process.env.ROLES ? process.env.ROLES.split(',') : ['admin', 'mentor', 'teacher', 'pending', 'anonymous']);
        const adminChunkPattern = /^(Dashboard|CMSManager|CategoryManager|AssignmentReview|TeacherManager|ProgressOverview|AnnouncementManager|InstructorList|AdminInstructorEdit|ContractAdmin|SalaryRegister|SalaryVendorExport|SalaryReportOptionsManager|DownloadCenter|BadgeManager|SalaryLinksManager|NotificationManager)-/;
        for (const role of personaOrder) {
            const persona = PERSONAS[role];
            const watchers = newWatchers();
            const { context, page } = await newPage(browser, persona, base, watchers);
            for (const r of ROUTES) {
                const expectation = PROBE ? { expect: r.expect } : expectationFor(role, r);
                if (!expectation) continue;
                await visit(page, base, watchers, persona, r.path, expectation);
            }
            if (!PROBE) {
                // /admin/claims：純導向到 /admin/instructors（再經守衛）
                const claimsExpectation = ['admin', 'mentor'].includes(role)
                    ? { expect: /講師資料總覽/ }
                    : { redirect: role === 'pending' ? '/pending' : '/' };
                await visit(page, base, watchers, persona, CLAIMS, claimsExpectation);
                // 未知網址
                // （待審帳號在站內任何網址都會被導去 /pending，這是改動前就有的行為）
                const notFoundExpectation = role === 'pending' ? { redirect: '/pending' } : { expect: /找不到這個頁面/ };
                await visit(page, base, watchers, persona, '/no-such-page', notFoundExpectation);
                await visit(page, base, watchers, persona, '/admin/no-such-page', notFoundExpectation);
            }
            // G：講師／待審／訪客被守衛擋下的後台網址，不應下載任何後台頁面 chunk
            if (!PROBE && ['teacher', 'pending', 'anonymous'].includes(role)) {
                const leaked = [...watchers.jsFiles].filter(f => adminChunkPattern.test(f));
                check(`G ${role.padEnd(9)} 打開所有後台網址後，沒有下載任何後台頁面的 JS 檔`, leaked.length === 0, leaked.join(',') || `已載入 ${watchers.jsFiles.size} 個 JS`);
            }
            await context.close();
        }

        if (!PROBE) {
            // N：找不到頁面的「回首頁」連結
            {
                const watchers = newWatchers();
                const { context, page } = await newPage(browser, PERSONAS.teacher, base, watchers);
                await page.goto(`${base}/definitely/not/here`, { waitUntil: 'networkidle' });
                await page.getByRole('link', { name: /回首頁/ }).click();
                await page.waitForURL(u => new URL(u).pathname === '/', { timeout: 8000 });
                check('N1 找不到頁面的「回首頁」連結可回到首頁', new URL(page.url()).pathname === '/');
                await context.close();
            }

            // P：vite:preloadError
            const chunkPattern = /\/assets\/CourseList-[^/]+\.js$/;
            {   // P1：舊分頁第一次載不到頁面檔（模擬換版後檔名已不存在）→ 自動重新整理一次後恢復
                const watchers = newWatchers();
                const { context, page } = await newPage(browser, PERSONAS.teacher, base, watchers);
                let chunkRequests = 0;
                let documentLoads = 0;
                page.on('request', req => { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) documentLoads += 1; });
                await context.route(chunkPattern, (r) => {
                    chunkRequests += 1;
                    return chunkRequests === 1 ? r.fulfill({ status: 404, body: 'gone' }) : r.fallback();
                });
                await page.goto(`${base}/leaderboard`, { waitUntil: 'networkidle' });
                await page.getByText(/榮譽榜|排行/).first().waitFor({ timeout: 10000 });
                // 站內導覽到 /courses（觸發 CourseList chunk 的第一次下載 → 404）
                await page.evaluate(() => { window.history.pushState({}, '', '/courses'); window.dispatchEvent(new PopStateEvent('popstate')); });
                await page.waitForFunction(() => /我的課程|分檔測試課程|分檔測試大分類/.test(document.body.innerText), null, { timeout: 15000 });
                const flag = await page.evaluate(() => sessionStorage.getItem('chunk-reload-at'));
                check('P1 換版後舊分頁載不到頁面檔：自動重新整理一次後頁面恢復', documentLoads === 2 && chunkRequests >= 2 && Boolean(flag),
                    `文件載入 ${documentLoads} 次、頁面檔請求 ${chunkRequests} 次、旗標=${flag ? '有' : '無'}`);
                await context.close();
            }
            {   // P2：永遠載不到 → 只重整一次（不無限重整），並顯示錯誤提示，導覽列還在
                const watchers = newWatchers();
                const { context, page } = await newPage(browser, PERSONAS.teacher, base, watchers);
                let documentLoads = 0;
                page.on('request', req => { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) documentLoads += 1; });
                await context.route(chunkPattern, r => r.fulfill({ status: 404, body: 'gone' }));
                await page.goto(`${base}/leaderboard`, { waitUntil: 'networkidle' });
                await page.getByText(/榮譽榜|排行/).first().waitFor({ timeout: 10000 });
                await page.evaluate(() => { window.history.pushState({}, '', '/courses'); window.dispatchEvent(new PopStateEvent('popstate')); });
                await page.getByText('這個頁面暫時無法顯示').waitFor({ timeout: 15000 });
                await page.waitForTimeout(2500); // 多等一下，確認沒有第二次、第三次重整
                const navVisible = await page.locator('nav, header').first().isVisible().catch(() => false);
                check('P2 永遠載不到時只自動重新整理一次，不無限重整', documentLoads === 2, `文件載入 ${documentLoads} 次`);
                check('P3 載入失敗時顯示錯誤提示且導覽列仍在（不是整頁空白）', navVisible);
                await context.close();
            }
        }
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }
    if (PROBE) return;
    const passed = results.filter(Boolean).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    process.exit(passed === results.length ? 0 : 1);
}
main().catch((error) => { console.error(error); process.exit(1); });
