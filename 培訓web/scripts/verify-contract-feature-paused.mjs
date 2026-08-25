#!/usr/bin/env node
/*
 * 回歸驗證：前台講師簽約停用、報酬頁啟用，後台管理仍保留。
 *
 * T1 講師個人頁不顯示簽約區塊
 * T2 舊的合約通知不會顯示或計入未讀數
 * T3 講師直接開 /contract 會被導回 /profile
 * T4 講師直接開 /contract/view/:id 會被導回 /profile
 * T5 講師瀏覽過程不查詢合約資料，也不寫入合約通知
 * T6 管理員仍可查看已簽合約與進入合約後台
 * T7 講師導覽列顯示「我的報酬」
 * T8 講師可開啟後台設定的外部報酬連結，站內課程回報頁維持關閉
 * T9 管理員可在講師名單預覽自動填好的 PDF，確認後再下載
 * T10 表單預覽與下載會顯示匯款完整度、隱藏舊帶入提示並支援手機版
 *
 * 用法：node scripts/verify-contract-feature-paused.mjs
 */
import { existsSync, readFileSync } from 'fs';
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
const ADMIN_SCREENSHOT = '/tmp/dream-one-instructor-form-download.png';
const ADMIN_MOBILE_SCREENSHOT = '/tmp/dream-one-instructor-form-download-mobile.png';
const DOWNLOAD_CENTER_SCREENSHOT = '/tmp/dream-one-remittance-download-center.png';
const DOWNLOAD_CENTER_MOBILE_SCREENSHOT = '/tmp/dream-one-remittance-download-center-mobile.png';
const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));
const CHROME_EXECUTABLE = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
].find((candidate) => candidate && existsSync(candidate));

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
    bank_account_number: '1234567890', bank_code: '822123',
    photo_path: 'mock/photo.jpg', id_front_path: 'mock/id-front.jpg',
    id_back_path: 'mock/id-back.jpg', bankbook_path: 'mock/bankbook.jpg',
    hide_from_leaderboard: false,
};
const SALARY_SUMMARY = {
    user_id: UID,
    full_name: INSTRUCTOR.full_name,
    this_month_salary: 0,
    this_month_sessions: 0,
    this_year_salary: 0,
    total_unpaid: 0,
    total_paid: 0,
    total_salary: 0,
    total_sessions: 0,
    total_hours: 0,
    pending_salary: 0,
    approved_unpaid_salary: 0,
};
const SALARY_LINKS = [
    {
        key: 'salary_direct',
        label: '測試直營課程表單',
        description: '從 site_links 動態載入',
        url: 'https://example.com/direct-form',
    },
    {
        key: 'salary_partner',
        label: '測試合作單位表單',
        description: '從 site_links 動態載入',
        url: 'https://example.com/partner-form',
    },
    {
        key: 'salary_points',
        label: '測試報酬確認連結',
        description: '從 site_links 動態載入',
        url: 'https://example.com/compensation',
    },
];
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
const FORM_DOCUMENT = {
    id: 'form-document-1',
    doc_type: 'remittance_form',
    display_name: '廠商匯款申請書',
    version: 1,
    sort_order: 1,
    doc_category: 'form',
    doc_mode: 'fill_sign',
    is_active: true,
    file_path: 'templates/remittance_form/v1.pdf',
    file_name: 'remittance-form.pdf',
};
const FORM_POSITION = {
    id: 'form-position-1',
    doc_type: FORM_DOCUMENT.doc_type,
    doc_version: FORM_DOCUMENT.version,
    field_type: 'name',
    page_number: 1,
    x: 48,
    y_from_top: 48,
    width: 180,
    height: 28,
    font_size: 13,
};

const MINIMAL_PDF = Buffer.from(
    'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwMgolJUVPRgo=',
    'base64'
);

let currentRole = 'teacher';
let teacherContractReads = 0;
let teacherContractNotificationWrites = 0;
let latestInstructorReads = 0;

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
    if (pathname.startsWith('/storage/v1/object/')) {
        return route.fulfill({ status: 200, contentType: 'application/pdf', body: MINIMAL_PDF });
    }
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
        if (method === 'GET' && table === 'instructors' && (url.searchParams.has('id') || url.search.includes('id=in.'))) {
            latestInstructorReads += 1;
        }
        if (method !== 'GET') {
            return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });
        }

        const profile = { id: UID, name: '簽約暫停測試員', email: FAKE_AUTH_USER.email, role: currentRole, created_at: NOW };
        let data;
        switch (table) {
            case 'users': data = wantsObject ? profile : [profile]; break;
            case 'instructors': data = wantsObject ? INSTRUCTOR : [INSTRUCTOR]; break;
            case 'instructor_salary_summary': data = wantsObject ? SALARY_SUMMARY : [SALARY_SUMMARY]; break;
            case 'class_sessions': data = []; break;
            case 'site_links': data = wantsObject ? SALARY_LINKS[0] : SALARY_LINKS; break;
            case 'instructor_contracts': data = wantsObject ? SIGNED_CONTRACT : [SIGNED_CONTRACT]; break;
            case 'contract_documents': data = wantsObject ? FORM_DOCUMENT : [FORM_DOCUMENT]; break;
            case 'contract_field_positions': data = wantsObject ? FORM_POSITION : [FORM_POSITION]; break;
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

async function newContext(browser, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport });
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
        browser = await chromium.launch(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {});

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
        const compensationNavCount = await page.getByText('我的報酬', { exact: true }).count();
        const oldSalaryNavCount = await page.getByText('我的薪資', { exact: true }).count();
        assert('T7a 講師導覽列顯示我的報酬', compensationNavCount === 1, `count=${compensationNavCount}`);
        assert('T7b 講師導覽列不再顯示我的薪資', oldSalaryNavCount === 0, `count=${oldSalaryNavCount}`);

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
        await page.goto(`${BASE}/my/salary`, { waitUntil: 'networkidle', timeout: 20000 });
        const compensationRouteWorks = new URL(page.url()).pathname === '/my/salary'
            && await page.getByRole('heading', { name: '我的報酬' }).count() === 1
            && await page.getByRole('link', { name: /測試直營課程表單/ }).getAttribute('href') === 'https://example.com/direct-form'
            && await page.getByRole('link', { name: /測試合作單位表單/ }).getAttribute('href') === 'https://example.com/partner-form'
            && await page.getByRole('link', { name: /測試報酬確認連結/ }).getAttribute('href') === 'https://example.com/compensation';
        assert('T8a 我的報酬顯示後台設定的三個外部連結', compensationRouteWorks, `landed=${new URL(page.url()).pathname}`);
        const salaryDataReads = await page.evaluate(() => performance.getEntriesByType('resource')
            .filter((entry) => /\/rest\/v1\/(instructor_salary_summary|class_sessions)/.test(entry.name)).length);
        assert('T8b 外部連結頁不讀取站內薪資明細', salaryDataReads === 0, `reads=${salaryDataReads}`);
        await page.goto(`${BASE}/my/salary/new`, { waitUntil: 'networkidle', timeout: 20000 });
        const internalCompensationFormClosed = new URL(page.url()).pathname === '/my/salary'
            && await page.getByRole('heading', { name: '我的報酬' }).count() === 1
            && await page.getByRole('heading', { name: '登記課程回報' }).count() === 0;
        assert('T8c 站內課程回報頁導回我的報酬', internalCompensationFormClosed, `landed=${new URL(page.url()).pathname}`);
        assert('T5a 講師端未查詢合約資料', teacherContractReads === 0, `reads=${teacherContractReads}`);
        assert('T5b 講師端未寫入合約通知', teacherContractNotificationWrites === 0, `writes=${teacherContractNotificationWrites}`);
        await page.close();
        await context.close();

        currentRole = 'admin';
        context = await newContext(browser);
        page = await context.newPage();
        await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminProfileContractSection = await page.getByText('合約簽署', { exact: true }).count();
        assert('T1b 停用期間管理員個人頁也隱藏講師簽約區塊', adminProfileContractSection === 0, `count=${adminProfileContractSection}`);

        await page.goto(`${BASE}/contract/view/contract-1`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminCanViewContract = new URL(page.url()).pathname === '/contract/view/contract-1'
            && await page.getByRole('heading', { name: '合約檢視' }).count() === 1;
        assert('T6a 管理員仍可查看已簽合約', adminCanViewContract, `landed=${new URL(page.url()).pathname}`);

        await page.goto(`${BASE}/admin/contracts`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminCanOpenBackoffice = new URL(page.url()).pathname === '/admin/contracts'
            && await page.getByRole('heading', { name: '合約文件管理' }).count() === 1;
        assert('T6b 管理員合約後台仍保留', adminCanOpenBackoffice, `landed=${new URL(page.url()).pathname}`);

        await page.goto(`${BASE}/admin/instructors`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByRole('heading', { name: '講師資料總覽' }).waitFor();
        const templateOption = await page.getByRole('option', { name: '廠商匯款申請書' }).count();
        const previewButtons = page.getByRole('button', { name: '預覽表單' });
        assert('T9a 講師名單提供自動填表模板', templateOption === 1, `count=${templateOption}`);
        assert('T9b 講師名單提供逐位預覽按鈕', await previewButtons.count() === 1, `count=${await previewButtons.count()}`);

        const readsBeforeInstructorPreview = latestInstructorReads;
        await previewButtons.first().click();
        const previewDialog = page.getByRole('dialog');
        await previewDialog.getByRole('heading', { name: '表單預覽' }).waitFor();
        assert('T9c 自動填表 PDF 可先預覽', await previewDialog.getByText('簽約暫停測試員-廠商匯款申請書.pdf').count() === 1);
        assert('T9d 預覽前重新讀取講師最新資料', latestInstructorReads > readsBeforeInstructorPreview, `reads=${latestInstructorReads - readsBeforeInstructorPreview}`);

        const downloadPromise = page.waitForEvent('download');
        await previewDialog.getByRole('button', { name: '下載 PDF' }).click();
        const download = await downloadPromise;
        assert('T9e 預覽後可下載 PDF', download.suggestedFilename() === '簽約暫停測試員-廠商匯款申請書.pdf', `file=${download.suggestedFilename()}`);
        const generatedPdfSize = readFileSync(await download.path()).length;
        assert('T9f 下載 PDF 已嵌入講師資料', generatedPdfSize > MINIMAL_PDF.length, `bytes=${generatedPdfSize}`);
        await page.screenshot({ path: ADMIN_SCREENSHOT, fullPage: true });
        await page.close();
        await context.close();

        context = await newContext(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await page.goto(`${BASE}/admin/instructors`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByRole('heading', { name: '講師資料總覽' }).waitFor();
        const mobilePreviewButton = page.getByRole('button', { name: '預覽表單' });
        const mobilePreviewVisible = await mobilePreviewButton.isVisible();
        await mobilePreviewButton.click();
        const mobilePreviewDialog = page.getByRole('dialog');
        await mobilePreviewDialog.getByRole('heading', { name: '表單預覽' }).waitFor();
        await page.locator('.react-pdf__Page__canvas').waitFor({ timeout: 15000 });
        const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert('T9g 手機版講師名單可預覽表單', mobilePreviewVisible, `visible=${mobilePreviewVisible}`);
        assert('T9h 手機版預覽無水平溢出', mobileOverflow <= 0, `overflow=${mobileOverflow}`);
        await page.screenshot({ path: ADMIN_MOBILE_SCREENSHOT, fullPage: true });
        await page.close();
        await context.close();

        context = await newContext(browser);
        page = await context.newPage();
        await page.goto(`${BASE}/admin/download-center`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByRole('heading', { name: '講師表單預覽與下載' }).waitFor();
        assert('T10a 下載中心顯示匯款資料完成狀態', await page.getByText('匯款資料完成狀態', { exact: true }).count() === 1);
        assert('T10b 六碼銀行代碼列入資料齊全', await page.getByRole('button', { name: '資料齊全 1 位' }).count() === 1);
        assert('T10c 尚未完整名單可直接篩選', await page.getByRole('button', { name: '尚未完整 0 位' }).count() === 1);
        assert('T10d 不再顯示舊資料帶入提示', await page.getByText('可從既有資料帶入', { exact: true }).count() === 0);
        assert('T10e 不再顯示舊匯款帳戶資料標籤', await page.getByText('舊匯款帳戶資料', { exact: true }).count() === 0);
        await page.getByRole('button', { name: '預覽', exact: true }).click();
        const downloadCenterPreview = page.getByRole('dialog');
        await downloadCenterPreview.getByRole('heading', { name: '表單預覽' }).waitFor();
        assert('T10f 下載中心的逐位表單可預覽', await downloadCenterPreview.getByRole('button', { name: '下載 PDF' }).count() === 1);
        await downloadCenterPreview.getByRole('button', { name: '關閉表單預覽' }).click();
        await page.getByRole('button', { name: '尚未完整 0 位' }).click();
        assert('T10g 匯款未完整篩選會更新名單', await page.getByText('沒有符合條件的講師', { exact: true }).count() === 1);
        await page.screenshot({ path: DOWNLOAD_CENTER_SCREENSHOT, fullPage: true });
        await page.close();
        await context.close();

        context = await newContext(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await page.goto(`${BASE}/admin/download-center`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByRole('heading', { name: '講師表單預覽與下載' }).waitFor();
        await page.getByRole('button', { name: '預覽', exact: true }).click();
        await page.getByRole('dialog').getByRole('heading', { name: '表單預覽' }).waitFor();
        await page.locator('.react-pdf__Page__canvas').waitFor({ timeout: 15000 });
        const downloadCenterOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert('T10h 手機版表單預覽無水平溢出', downloadCenterOverflow <= 0, `overflow=${downloadCenterOverflow}`);
        await page.screenshot({ path: DOWNLOAD_CENTER_MOBILE_SCREENSHOT, fullPage: true });
        await page.close();
        await context.close();
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }

    const passed = results.filter((result) => result.pass).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    console.log(`screenshot: ${SCREENSHOT}`);
    console.log(`admin screenshot: ${ADMIN_SCREENSHOT}`);
    console.log(`admin mobile screenshot: ${ADMIN_MOBILE_SCREENSHOT}`);
    console.log(`download center screenshot: ${DOWNLOAD_CENTER_SCREENSHOT}`);
    console.log(`download center mobile screenshot: ${DOWNLOAD_CENTER_MOBILE_SCREENSHOT}`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
