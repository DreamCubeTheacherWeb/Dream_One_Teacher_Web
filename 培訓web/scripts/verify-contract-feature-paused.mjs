#!/usr/bin/env node
/*
 * 回歸驗證：前台講師簽約功能暫停，後台管理仍保留。
 *
 * T1 講師個人頁不顯示簽約區塊
 * T2 舊的合約通知不會顯示或計入未讀數
 * T3 講師直接開 /contract 會被導回 /profile
 * T4 講師直接開 /contract/view/:id 會被導回 /profile
 * T5 講師瀏覽過程不查詢合約資料，也不寫入合約通知
 * T6 管理員仍可查看已簽合約與進入合約後台
 *
 * 用法：node scripts/verify-contract-feature-paused.mjs
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4223;
const BASE = `http://localhost:${PORT}`;
const SCREENSHOT = '/tmp/dream-one-contract-paused-profile.png';
const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));

const envMap = Object.fromEntries(readFileSync(path.join(APP_DIR, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
const PROJECT_REF = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const UID = '00000000-0000-4000-8000-000000000031';
const NOW = new Date().toISOString();

const FAKE_AUTH_USER = {
    id: UID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'contract-pause@test.local',
    email_confirmed_at: NOW,
    confirmed_at: NOW,
    last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '簽約暫停測試員', avatar_url: '' },
    identities: [],
    created_at: NOW,
    updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.contract.pause',
    token_type: 'bearer',
    expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    refresh_token: 'mock.contract.refresh',
    user: FAKE_AUTH_USER,
};
const INSTRUCTOR = {
    id: 'instructor-contract-pause', user_id: UID,
    full_name: '簽約暫停測試員', nickname: '暫停測試', gender: '女',
    birth_date: '1990-01-01', id_number: 'A123456789', phone_mobile: '0912345678',
    line_id: 'contract-pause', address: '台北市測試路 1 號', household_address: '台北市測試路 1 號',
    email_primary: FAKE_AUTH_USER.email, email_secondary: '', instructor_role: 'A',
    teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次',
    teaching_regions: ['臺北市'], bio_notes: '測試資料',
    bank_account_name: '簽約暫停測試員', bank_name: '測試銀行', bank_branch: '測試分行',
    bank_account_number: '1234567890', bank_code: '0080000',
    photo_path: 'mock/photo.jpg', id_front_path: 'mock/id-front.jpg',
    id_back_path: 'mock/id-back.jpg', bankbook_path: 'mock/bankbook.jpg',
    hide_from_leaderboard: false,
};
const SIGNED_CONTRACT = {
    id: 'contract-1', user_id: UID, status: 'signed', signed_at: NOW,
    filled_name: '簽約暫停測試員', filled_instructor_role: 'A',
    filled_id_number: 'A123456789', filled_address: INSTRUCTOR.address,
    filled_phone: INSTRUCTOR.phone_mobile, doc_versions: {}, signed_pdf_paths: {},
    signature_path: null,
};
const NOTIFICATIONS = [
    { id: 'contract-notification', user_id: UID, type: 'contract', title: '尚未完成合約簽署', body: '請前往簽約', link: '/contract', is_read: false, created_at: NOW },
    { id: 'announcement-notification', user_id: UID, type: 'announcement', title: '一般公告仍正常顯示', body: '這是非合約通知', link: null, is_read: false, created_at: NOW },
];

let currentRole = 'teacher';
let teacherContractReads = 0;
let teacherContractNotificationWrites = 0;

function jsonRes(route, data, extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (Array.isArray(data)) headers['content-range'] = data.length ? `0-${data.length - 1}/${data.length}` : '*/0';
    return route.fulfill({ status: 200, headers, body: JSON.stringify(data) });
}

async function handleRoute(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    const pathname = url.pathname;
    if (pathname.startsWith('/auth/v1/')) {
        if (pathname === '/auth/v1/user') return jsonRes(route, FAKE_AUTH_USER);
        if (pathname.startsWith('/auth/v1/token')) return jsonRes(route, FAKE_SESSION);
        return jsonRes(route, {});
    }
    if (pathname.startsWith('/rest/v1/rpc/')) return jsonRes(route, null);
    if (pathname.startsWith('/rest/v1/')) {
        const table = pathname.replace('/rest/v1/', '').split('/')[0];
        const method = req.method();
        const accept = (await req.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');

        if (currentRole === 'teacher' && method === 'GET' && ['instructor_contracts', 'contract_documents'].includes(table)) {
            teacherContractReads += 1;
        }
        if (currentRole === 'teacher' && method !== 'GET' && table === 'notifications') {
            const body = req.postData() || '';
            if (body.includes('contract')) teacherContractNotificationWrites += 1;
        }
        if (method !== 'GET') {
            return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });
        }

        const profile = { id: UID, name: '簽約暫停測試員', email: FAKE_AUTH_USER.email, role: currentRole, created_at: NOW };
        let data;
        switch (table) {
            case 'users': data = wantsObject ? profile : [profile]; break;
            case 'instructors': data = wantsObject ? INSTRUCTOR : [INSTRUCTOR]; break;
            case 'instructor_contracts': data = wantsObject ? SIGNED_CONTRACT : [SIGNED_CONTRACT]; break;
            case 'notifications': data = wantsObject ? NOTIFICATIONS[0] : NOTIFICATIONS; break;
            case 'instructor_claim_requests': data = wantsObject ? null : []; break;
            default: data = wantsObject ? null : [];
        }
        return jsonRes(route, data);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

async function waitForServer(url, timeoutMs) {
    const start = Date.now();
    for (;;) {
        try { const response = await fetch(url); if (response.ok || response.status === 404) return; } catch { /* server not ready */ }
        if (Date.now() - start > timeoutMs) throw new Error(`server timeout ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
}

const results = [];
const assert = (name, condition, detail = '') => {
    results.push({ name, pass: Boolean(condition), detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function newContext(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ key, session }) => {
        window.localStorage.setItem(key, JSON.stringify(session));
    }, { key: STORAGE_KEY, session: FAKE_SESSION });
    await context.route('**/*', handleRoute);
    return context;
}

async function main() {
    console.log('── npm run build ──');
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
        cwd: APP_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let browser;
    try {
        await waitForServer(BASE, 15000);
        browser = await chromium.launch();

        currentRole = 'teacher';
        teacherContractReads = 0;
        teacherContractNotificationWrites = 0;
        let context = await newContext(browser);
        let page = await context.newPage();
        await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByRole('heading', { name: '個人資料' }).waitFor();
        await page.waitForTimeout(500);

        const contractSectionCount = await page.getByText('合約簽署', { exact: true }).count();
        assert('T1 講師個人頁隱藏簽約區塊', contractSectionCount === 0, `count=${contractSectionCount}`);

        await page.locator('button:has(svg.lucide-bell)').first().click();
        const oldContractNotificationCount = await page.getByText('尚未完成合約簽署', { exact: true }).count();
        const announcementCount = await page.getByText('一般公告仍正常顯示', { exact: true }).count();
        assert('T2a 舊合約通知已隱藏', oldContractNotificationCount === 0, `count=${oldContractNotificationCount}`);
        assert('T2b 非合約通知仍顯示', announcementCount === 1, `count=${announcementCount}`);
        await page.screenshot({ path: SCREENSHOT, fullPage: true });

        await page.goto(`${BASE}/contract`, { waitUntil: 'networkidle', timeout: 20000 });
        assert('T3 講師直連簽約頁導回個人頁', new URL(page.url()).pathname === '/profile', `landed=${new URL(page.url()).pathname}`);

        await page.goto(`${BASE}/contract/view/contract-1`, { waitUntil: 'networkidle', timeout: 20000 });
        assert('T4 講師直連合約檢視頁導回個人頁', new URL(page.url()).pathname === '/profile', `landed=${new URL(page.url()).pathname}`);
        assert('T5a 講師端未查詢合約資料', teacherContractReads === 0, `reads=${teacherContractReads}`);
        assert('T5b 講師端未寫入合約通知', teacherContractNotificationWrites === 0, `writes=${teacherContractNotificationWrites}`);
        await page.close();
        await context.close();

        currentRole = 'admin';
        context = await newContext(browser);
        page = await context.newPage();
        await page.goto(`${BASE}/contract/view/contract-1`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminCanViewContract = new URL(page.url()).pathname === '/contract/view/contract-1'
            && await page.getByRole('heading', { name: '合約檢視' }).count() === 1;
        assert('T6a 管理員仍可查看已簽合約', adminCanViewContract, `landed=${new URL(page.url()).pathname}`);

        await page.goto(`${BASE}/admin/contracts`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminCanOpenBackoffice = new URL(page.url()).pathname === '/admin/contracts'
            && await page.getByRole('heading', { name: '合約文件管理' }).count() === 1;
        assert('T6b 管理員合約後台仍保留', adminCanOpenBackoffice, `landed=${new URL(page.url()).pathname}`);
        await page.close();
        await context.close();
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }

    const passed = results.filter((result) => result.pass).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    console.log(`screenshot: ${SCREENSHOT}`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
