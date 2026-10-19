#!/usr/bin/env node
/*
 * 回歸驗證：2026-10-20 簽約流程與表單下載的「假成功／空白文件／檔案互相覆蓋」修正。
 * 全程 mock Supabase（瀏覽器內攔截所有請求，不會連到任何真實後端）。
 *
 * F1 簽署 PDF 產生時查欄位定位失敗 → 顯示失敗、不上傳任何檔案、不呼叫簽約 RPC
 *    （另驗：定位查回來卻沒有簽名欄位也一樣擋下；正常情況仍能完成簽約）
 * F2 表單範本當前版本 0 筆欄位定位 → 預覽與批次下載都顯示明確訊息、不產生檔案、不寫下載紀錄
 * F3 批次下載遇到同名講師 → zip 內每人一份（重名加序號），不重名維持原檔名
 * F4 合約後台上傳新版：先寫入新版成功才停用舊版；兩步失敗都讓管理員看到訊息
 *    （F4d/F4e：表單模板上傳同一套順序）
 * F5 唯讀文件排在最後一步：最後一步顯示簽約表單並可送出，不會跳到空白畫面
 *
 * 用法：node scripts/verify-contract-download-fixes-20261020.mjs [--skip-build]
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4237;
const BASE = `http://localhost:${PORT}`;
const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));
const JSZip = require(path.join(APP_DIR, 'node_modules/jszip'));
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
const UID = '00000000-0000-4000-8000-000000000077';
const NOW = new Date().toISOString();

const FAKE_AUTH_USER = {
    id: UID, aud: 'authenticated', role: 'authenticated',
    email: 'contract-fix@test.local', email_confirmed_at: NOW, confirmed_at: NOW, last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '簽約修正測試員', avatar_url: '' },
    identities: [], created_at: NOW, updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.contract.fix', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.contract.fix.refresh',
    user: FAKE_AUTH_USER,
};

const baseInstructor = (overrides) => ({
    user_id: null, nickname: '', gender: '女', birth_date: '1990-01-01', id_number: 'A123456789',
    phone_mobile: '0912345678', line_id: 'x', address: '台北市測試路 1 號', household_address: '台北市測試路 1 號',
    email_primary: 'x@test.local', email_secondary: '', instructor_role: 'A',
    teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次', teaching_regions: ['臺北市'],
    bio_notes: '', bank_account_name: '測試戶名', bank_name: '測試銀行', bank_branch: '測試分行',
    bank_account_number: '1234567890', bank_code: '822123',
    photo_path: null, id_front_path: null, id_back_path: null, bankbook_path: null,
    hide_from_leaderboard: false,
    ...overrides,
});
const TEACHER = baseInstructor({
    id: 'inst-teacher', user_id: UID, full_name: '簽約修正測試員', email_primary: FAKE_AUTH_USER.email,
    nickname: '修正測試', bio_notes: '測試資料',
    photo_path: 'mock/photo.jpg', id_front_path: 'mock/id-front.jpg', id_back_path: 'mock/id-back.jpg', bankbook_path: 'mock/bankbook.jpg',
});

const DOC = (doc_type, display_name, version, sort_order, doc_mode, extra = {}) => ({
    id: `doc-${doc_type}`, doc_type, display_name, version, sort_order, doc_category: 'contract', doc_mode,
    is_active: true, file_path: `templates/${doc_type}/v${version}.pdf`, file_name: `${doc_type}.pdf`, ...extra,
});
const PRODUCTION_ORDER_DOCS = [
    DOC('rules', '講師管理辦法', 2, 1, 'view_only'),
    DOC('compensation', '講師委任報酬表', 1, 2, 'view_only'),
    DOC('contract', '委任契約書', 3, 3, 'fill_sign'),
];
const VIEW_ONLY_LAST_DOCS = [
    DOC('rules', '講師管理辦法', 2, 1, 'view_only'),
    DOC('contract', '委任契約書', 3, 2, 'fill_sign'),
    DOC('appendix', '附件：補充說明', 1, 3, 'view_only'),
];
const CONTRACT_POSITIONS = [
    { id: 'pos-signature', doc_type: 'contract', doc_version: 3, field_type: 'signature', page_number: 1, x: 300, y_from_top: 600, width: 160, height: 60, font_size: 13 },
    { id: 'pos-name', doc_type: 'contract', doc_version: 3, field_type: 'name', page_number: 1, x: 120, y_from_top: 120, width: 160, height: 24, font_size: 13 },
];
const FORM_DOCUMENT = {
    id: 'form-document-2', doc_type: 'remittance_form', display_name: '廠商匯款申請書', version: 2, sort_order: 1,
    doc_category: 'form', doc_mode: 'fill_sign', is_active: true,
    file_path: 'templates/remittance_form/v2.pdf', file_name: 'remittance-form-v2.pdf',
};
const FORM_POSITION = {
    id: 'form-position-1', doc_type: 'remittance_form', doc_version: 2, field_type: 'name',
    page_number: 1, x: 48, y_from_top: 48, width: 180, height: 28, font_size: 13,
};

const MINIMAL_PDF = Buffer.from(
    'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwMgolJUVPRgo=',
    'base64'
);

// ── 每個情境各自的 mock 設定與請求紀錄 ──
let mock;
const resetMock = (overrides = {}) => {
    mock = {
        role: 'teacher',
        contractDocs: PRODUCTION_ORDER_DOCS,
        contractPositionsForPrecheck: CONTRACT_POSITIONS, // select=field_type（送出前檢查）
        contractPositionsForGenerate: CONTRACT_POSITIONS, // select=*（產生簽署 PDF）
        failGenerateQuery: false,
        formPositions: [FORM_POSITION],
        instructors: [TEACHER],
        contractDocInsertFails: false,
        contractDocDeactivateFails: false,
        requests: [],
        ...overrides,
    };
};

function jsonRes(route, data, extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (Array.isArray(data)) headers['content-range'] = data.length ? `0-${data.length - 1}/${data.length}` : '*/0';
    return route.fulfill({ status: 200, headers, body: JSON.stringify(data) });
}
const errorRes = (route, status, message) => route.fulfill({
    status, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, code: 'MOCK', details: null, hint: null }),
});

const parseInList = (value) => (value || '').replace(/^in\.\(/, '').replace(/\)$/, '')
    .split(',').map((item) => item.trim().replace(/^"|"$/g, '')).filter(Boolean);

async function handleRoute(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    const method = req.method();
    const pathname = url.pathname;
    const record = { method, pathname, search: url.search, body: req.postData() || '', size: req.postDataBuffer()?.length || 0 };
    mock.requests.push(record);

    if (pathname.startsWith('/auth/v1/')) {
        if (pathname === '/auth/v1/user') return jsonRes(route, FAKE_AUTH_USER);
        if (pathname.startsWith('/auth/v1/token') || pathname.startsWith('/auth/v1/verify')) return jsonRes(route, FAKE_SESSION);
        return jsonRes(route, {});
    }
    if (pathname.startsWith('/rest/v1/rpc/')) {
        if (pathname.endsWith('/submit_my_contract')) return jsonRes(route, { id: 'contract-new-1' });
        return jsonRes(route, null);
    }
    if (pathname.startsWith('/storage/v1/object/sign/') && method === 'POST') {
        return jsonRes(route, { signedURL: `${pathname.replace('/storage/v1', '')}?token=mock` });
    }
    if (pathname.startsWith('/storage/v1/object/') && (method === 'POST' || method === 'PUT')) {
        const key = pathname.replace('/storage/v1/object/', '');
        return jsonRes(route, { Id: `mock-${mock.requests.length}`, Key: key });
    }
    if (pathname.startsWith('/storage/v1/object/')) {
        return route.fulfill({ status: 200, contentType: 'application/pdf', body: MINIMAL_PDF });
    }
    if (pathname.startsWith('/rest/v1/')) {
        const table = pathname.replace('/rest/v1/', '').split('/')[0];
        const accept = (await req.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');

        if (method !== 'GET') {
            if (table === 'contract_documents' && method === 'POST' && mock.contractDocInsertFails) {
                return errorRes(route, 400, 'mock insert failed');
            }
            if (table === 'contract_documents' && method === 'PATCH' && mock.contractDocDeactivateFails) {
                return errorRes(route, 400, 'mock deactivate failed');
            }
            return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });
        }

        const profile = { id: UID, name: '簽約修正測試員', email: FAKE_AUTH_USER.email, role: mock.role, created_at: NOW };
        const one = (rows) => (wantsObject ? rows[0] ?? null : rows);
        switch (table) {
            case 'users': return jsonRes(route, one([profile]));
            case 'instructors': {
                const idFilter = url.searchParams.get('id');
                const userFilter = url.searchParams.get('user_id');
                let rows = mock.instructors;
                if (idFilter?.startsWith('in.')) {
                    const ids = parseInList(idFilter);
                    rows = rows.filter((row) => ids.includes(row.id));
                } else if (idFilter?.startsWith('eq.')) {
                    rows = rows.filter((row) => row.id === idFilter.slice(3));
                } else if (userFilter?.startsWith('eq.')) {
                    rows = rows.filter((row) => row.user_id === userFilter.slice(3));
                }
                return jsonRes(route, one(rows));
            }
            case 'contract_documents': {
                const category = url.searchParams.get('doc_category');
                const docType = url.searchParams.get('doc_type');
                if (category === 'eq.form' || docType === 'eq.remittance_form') return jsonRes(route, one([FORM_DOCUMENT]));
                return jsonRes(route, one(mock.contractDocs));
            }
            case 'contract_field_positions': {
                const docType = url.searchParams.get('doc_type');
                const select = url.searchParams.get('select');
                if (docType === 'eq.remittance_form') return jsonRes(route, one(mock.formPositions));
                if (docType === 'eq.contract') {
                    if (select === '*') {
                        if (mock.failGenerateQuery) return errorRes(route, 500, 'mock positions query failed');
                        return jsonRes(route, one(mock.contractPositionsForGenerate));
                    }
                    return jsonRes(route, one(mock.contractPositionsForPrecheck));
                }
                return jsonRes(route, one([]));
            }
            default: return jsonRes(route, wantsObject ? null : []);
        }
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

async function waitForServer(url, timeoutMs) {
    const start = Date.now();
    for (;;) {
        try { const response = await fetch(url); if (response.ok || response.status === 404) return; } catch { /* not ready */ }
        if (Date.now() - start > timeoutMs) throw new Error(`server timeout ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
}

const results = [];
const assert = (name, condition, detail = '') => {
    results.push({ name, pass: Boolean(condition), detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

async function openPage(browser, startPath) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
    await context.addInitScript(({ key, session }) => {
        window.localStorage.setItem(key, JSON.stringify(session));
    }, { key: STORAGE_KEY, session: FAKE_SESSION });
    await context.route('**/*', handleRoute);
    const page = await context.newPage();
    const dialogs = [];
    const pageErrors = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(`${BASE}${startPath}`, { waitUntil: 'networkidle', timeout: 20000 });
    return { context, page, dialogs, pageErrors };
}

const waitUntil = async (fn, timeoutMs = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return false;
};

// ── 簽約流程共用：讀完唯讀文件 → Email 驗證 → 勾同意 → 簽名 → 送出 ──
const FINISH_READING = '我已完整看完且清楚這份文件的所有內容';
async function completeSigningForm(page) {
    await page.getByRole('button', { name: '寄送驗證碼到我的信箱' }).click();
    const firstDigit = page.getByLabel('驗證碼第 1 碼');
    await firstDigit.waitFor({ timeout: 10000 });
    await firstDigit.click();
    await page.keyboard.type('123456');
    await page.getByText('本人身分已驗證', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByLabel('清楚看過所有合約文件內容，皆可遵守並配合。').check();
    await page.getByLabel('清楚且接受線上電子簽名與實體簽約具備一樣的法律效力。').check();
    await page.getByRole('button', { name: /點擊此處進行簽名/ }).click();
    const canvas = page.locator('canvas.cursor-crosshair');
    await canvas.waitFor({ timeout: 10000 });
    // 簽名板開啟 50ms 後會依容器大小重設畫布（並清空），等它重設完再簽
    await page.waitForTimeout(400);
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i += 1) {
        await page.mouse.move(box.x + 30 + i * 18, box.y + box.height / 2 + (i % 2 ? -20 : 20), { steps: 3 });
    }
    await page.mouse.up();
    await page.getByRole('button', { name: '確認簽名' }).click();
    await page.getByText('已簽名', { exact: true }).waitFor({ timeout: 10000 });
}

async function submitAndSettle(page, dialogs) {
    const submit = page.getByRole('button', { name: /確認送出簽約/ });
    const enabled = await submit.isEnabled();
    if (enabled) await submit.click();
    await waitUntil(async () => dialogs.length > 0
        || await page.getByRole('heading', { name: '簽約完成！' }).count() > 0, 15000);
    await page.waitForTimeout(300);
    return enabled;
}

const signedUploads = () => mock.requests.filter((r) => (r.method === 'POST' || r.method === 'PUT')
    && r.pathname.startsWith('/storage/v1/object/contract-documents/signed/'));
const rpcCalls = () => mock.requests.filter((r) => r.pathname === '/rest/v1/rpc/submit_my_contract');

async function scenarioSigning(browser, label, mockOverrides, expectSuccess) {
    resetMock(mockOverrides);
    const { context, page, dialogs, pageErrors } = await openPage(browser, '/contract');
    const viewOnlyCount = mock.contractDocs.filter((d) => d.doc_mode === 'view_only').length;
    for (let i = 0; i < viewOnlyCount; i += 1) {
        await page.getByRole('button', { name: FINISH_READING }).waitFor({ timeout: 15000 }).catch(async (error) => {
            console.log(`   [${label}] stuck at ${page.url()} :: ${(await page.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' / ')}`);
            throw error;
        });
        await page.getByRole('button', { name: FINISH_READING }).click();
    }
    await completeSigningForm(page);
    const submitEnabled = await submitAndSettle(page, dialogs);
    const completed = await page.getByRole('heading', { name: '簽約完成！' }).count() === 1;
    const out = { submitEnabled, completed, dialogs: [...dialogs], uploads: signedUploads(), rpc: rpcCalls(), pageErrors };
    await context.close();
    if (expectSuccess !== undefined) {
        console.log(`   [${label}] submitEnabled=${submitEnabled} completed=${completed} uploads=${out.uploads.length} rpc=${out.rpc.length} dialogs=${out.dialogs.join(' | ') || '-'}`);
    }
    return out;
}

async function main() {
    if (!process.argv.includes('--skip-build')) {
        console.log('── npm run build ──');
        execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    }
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
        cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let browser;
    try {
        await waitForServer(BASE, 45000);
        browser = await chromium.launch(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {});

        // ── F1：簽署 PDF 產生時查欄位定位 ──
        const happy = await scenarioSigning(browser, 'F1a 正常', {}, true);
        assert('F1a 對照組：欄位定位正常時可完成簽約（上傳簽名＋簽署 PDF、呼叫 RPC 一次）',
            happy.completed && happy.rpc.length === 1
            && happy.uploads.some((u) => u.pathname.endsWith('.pdf'))
            && happy.uploads.some((u) => u.pathname.endsWith('.png')),
            `completed=${happy.completed} rpc=${happy.rpc.length} uploads=${happy.uploads.map((u) => u.pathname.split('/').pop()).join(',')}`);
        const happyRpcBody = happy.rpc[0] ? JSON.parse(happy.rpc[0].body) : {};
        assert('F1b 對照組：RPC 帶 contract 的簽署 PDF 路徑與三份文件版本',
            Boolean(happyRpcBody.p_signed_pdf_paths?.contract)
            && JSON.stringify(happyRpcBody.p_doc_versions) === JSON.stringify({ rules: 2, compensation: 1, contract: 3 }),
            JSON.stringify({ paths: happyRpcBody.p_signed_pdf_paths, versions: happyRpcBody.p_doc_versions }));

        const failed = await scenarioSigning(browser, 'F1c 查詢失敗', { failGenerateQuery: true }, true);
        assert('F1c 產生 PDF 時欄位定位查詢失敗 → 不顯示「簽約完成」',
            !failed.completed, `completed=${failed.completed}`);
        assert('F1d 查詢失敗 → 不呼叫簽約 RPC', failed.rpc.length === 0, `rpc=${failed.rpc.length}`);
        assert('F1e 查詢失敗 → 不上傳任何簽署檔（簽名圖與 PDF 都不上傳）', failed.uploads.length === 0,
            failed.uploads.map((u) => u.pathname.split('/').pop()).join(',') || 'uploads=0');
        assert('F1f 查詢失敗 → 跳出失敗訊息給講師', failed.dialogs.some((m) => m.includes('簽約送出失敗') && m.includes('欄位')),
            failed.dialogs.join(' | ') || 'no dialog');

        const noSig = await scenarioSigning(browser, 'F1g 定位缺簽名', {
            contractPositionsForGenerate: CONTRACT_POSITIONS.filter((p) => p.field_type !== 'signature'),
        }, true);
        assert('F1g 產生時查回的定位沒有簽名欄位 → 擋下（不完成、不呼叫 RPC、不上傳）',
            !noSig.completed && noSig.rpc.length === 0 && noSig.uploads.length === 0
            && noSig.dialogs.some((m) => m.includes('簽名')),
            `completed=${noSig.completed} rpc=${noSig.rpc.length} uploads=${noSig.uploads.length} dialogs=${noSig.dialogs.join(' | ')}`);
        assert('F1h 簽約各情境沒有未預期的頁面錯誤',
            [happy, failed, noSig].every((r) => r.pageErrors.length === 0),
            [happy, failed, noSig].flatMap((r) => r.pageErrors).join(' | ') || 'errors=0');

        // ── F2：表單範本當前版本沒有欄位定位 ──
        resetMock({ role: 'admin', formPositions: [], instructors: [baseInstructor({ id: 'inst-a', full_name: '張空白' })] });
        {
            const { context, page, dialogs } = await openPage(browser, '/admin/download-center');
            await page.getByRole('heading', { name: '講師表單預覽與下載' }).waitFor();
            await page.getByRole('button', { name: '預覽', exact: true }).first().click();
            await waitUntil(async () => dialogs.length > 0 || await page.getByRole('dialog').count() > 0, 10000);
            const previewOpened = await page.getByRole('dialog').getByRole('heading', { name: '表單預覽' }).count() > 0;
            assert('F2a 無欄位定位 → 預覽不產生空白表單', !previewOpened, `previewOpened=${previewOpened}`);
            assert('F2b 無欄位定位 → 預覽顯示「尚未設定欄位位置」', dialogs.some((m) => m.includes('尚未設定欄位位置')),
                dialogs.join(' | ') || 'no dialog');

            if (previewOpened) await page.getByRole('button', { name: '關閉表單預覽' }).click();
            dialogs.length = 0;
            let downloaded = false;
            page.on('download', () => { downloaded = true; });
            await page.getByRole('button', { name: '全選此頁' }).click();
            await page.getByRole('button', { name: /批次下載/ }).click();
            await waitUntil(async () => dialogs.length > 0 || downloaded, 10000);
            await page.waitForTimeout(1000);
            const logWrites = mock.requests.filter((r) => r.method === 'POST' && r.pathname === '/rest/v1/instructor_form_downloads');
            assert('F2c 無欄位定位 → 批次下載不產生 zip', !downloaded, `downloaded=${downloaded}`);
            assert('F2d 無欄位定位 → 批次下載顯示「尚未設定欄位位置」', dialogs.some((m) => m.includes('尚未設定欄位位置')),
                dialogs.join(' | ') || 'no dialog');
            assert('F2e 無欄位定位 → 不寫下載紀錄', logWrites.length === 0, `logWrites=${logWrites.length}`);
            await context.close();
        }

        // ── F3：同名講師批次下載 ──
        resetMock({
            role: 'admin',
            instructors: [
                baseInstructor({ id: 'inst-wang-1', full_name: '王小明', id_number: 'A100000001' }),
                baseInstructor({ id: 'inst-wang-2', full_name: '王小明', id_number: 'A100000002' }),
                baseInstructor({ id: 'inst-li', full_name: '李大華', id_number: 'A100000003' }),
            ],
        });
        {
            const { context, page, dialogs } = await openPage(browser, '/admin/download-center');
            await page.getByRole('heading', { name: '講師表單預覽與下載' }).waitFor();
            await page.getByRole('button', { name: '全選此頁' }).click();
            const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
            await page.getByRole('button', { name: /批次下載/ }).click();
            const download = await downloadPromise;
            const zip = await JSZip.loadAsync(readFileSync(await download.path()));
            const names = Object.keys(zip.files).sort();
            const pdfHeads = await Promise.all(names.map(async (name) => (await zip.file(name).async('string')).slice(0, 5)));
            await waitUntil(async () => mock.requests.some((r) => r.method === 'POST' && r.pathname === '/rest/v1/instructor_form_downloads'), 5000);
            const logWrite = mock.requests.find((r) => r.method === 'POST' && r.pathname === '/rest/v1/instructor_form_downloads');
            const logRows = logWrite ? JSON.parse(logWrite.body) : [];
            assert('F3a 三位講師（兩位同名）→ zip 內有 3 份檔案', names.length === 3, names.join(', '));
            assert('F3b 同名第二位加序號「-2」', names.includes('王小明-廠商匯款申請書.pdf') && names.includes('王小明-廠商匯款申請書-2.pdf'),
                names.join(', '));
            assert('F3c 不重名維持原檔名', names.includes('李大華-廠商匯款申請書.pdf'), names.join(', '));
            assert('F3d zip 內每份都是 PDF', pdfHeads.every((head) => head === '%PDF-'), pdfHeads.join(','));
            assert('F3e 下載紀錄 3 筆且對應 3 位不同講師',
                logRows.length === 3 && new Set(logRows.map((row) => row.target_instructor_id)).size === 3,
                `rows=${logRows.length}`);
            assert('F3f zip 檔名份數與實際份數一致', download.suggestedFilename().includes('-3份-'), download.suggestedFilename());
            assert('F3g 批次下載沒有跳出錯誤', dialogs.length === 0, dialogs.join(' | ') || 'dialogs=0');
            await context.close();
        }

        // ── F4：合約後台上傳新版的寫入順序 ──
        const uploadContractDoc = async (overrides) => {
            resetMock({ role: 'admin', ...overrides });
            const { context, page, dialogs } = await openPage(browser, '/admin/contracts');
            await page.getByRole('heading', { name: '合約文件管理' }).waitFor();
            await page.locator('input[type="file"]').first().setInputFiles({
                name: 'rules-v-next.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF,
            });
            await waitUntil(async () => dialogs.length >= 2, 15000);
            await page.waitForTimeout(300);
            const docWrites = mock.requests
                .filter((r) => r.pathname === '/rest/v1/contract_documents' && ['POST', 'PATCH'].includes(r.method))
                .map((r) => ({ method: r.method, search: r.search, body: r.body }));
            await context.close();
            return { dialogs: [...dialogs], docWrites };
        };
        const orderOf = (writes) => writes.map((w) => w.method).join('>');

        const insertFail = await uploadContractDoc({ contractDocInsertFails: true });
        assert('F4a 新版寫入失敗 → 舊版沒有被停用（沒有送出停用請求）',
            insertFail.docWrites.length > 0 && insertFail.docWrites.every((w) => w.method !== 'PATCH'),
            orderOf(insertFail.docWrites) || 'no writes');
        assert('F4b 新版寫入失敗 → 管理員看到「上傳失敗」', insertFail.dialogs.some((m) => m.includes('上傳失敗')),
            insertFail.dialogs.slice(1).join(' | ') || 'no alert');

        const deactivateFail = await uploadContractDoc({ contractDocDeactivateFails: true });
        assert('F4c 先寫入新版、再停用舊版', orderOf(deactivateFail.docWrites) === 'POST>PATCH', orderOf(deactivateFail.docWrites));
        assert('F4d 舊版停用失敗 → 管理員看到停用失敗的提醒（不是單純「上傳成功」）',
            deactivateFail.dialogs.some((m) => m.includes('舊版') && m.includes('停用失敗')),
            deactivateFail.dialogs.slice(1).join(' | ') || 'no alert');

        const allOk = await uploadContractDoc({});
        const patch = allOk.docWrites.find((w) => w.method === 'PATCH');
        assert('F4e 兩步都成功 → 順序為寫入新版、停用舊版（id=doc-rules）且顯示上傳成功',
            orderOf(allOk.docWrites) === 'POST>PATCH' && patch?.search.includes('id=eq.doc-rules')
            && JSON.parse(patch.body).is_active === false
            && allOk.dialogs.some((m) => m.startsWith('上傳成功')),
            `${orderOf(allOk.docWrites)} ${patch?.search || ''} ${allOk.dialogs.slice(1).join(' | ')}`);

        // F4f/F4g：表單模板上傳（下載中心 → 管理表單模板）同一套順序
        const uploadFormDoc = async (overrides) => {
            resetMock({ role: 'admin', ...overrides });
            const { context, page, dialogs } = await openPage(browser, '/admin/download-center');
            await page.getByRole('heading', { name: '講師表單預覽與下載' }).waitFor();
            await page.getByRole('button', { name: /管理表單模板/ }).click();
            await page.locator('input[type="file"][accept="application/pdf"]').first().setInputFiles({
                name: 'remittance-v-next.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF,
            });
            await waitUntil(async () => dialogs.length >= 1, 15000);
            await page.waitForTimeout(300);
            const docWrites = mock.requests
                .filter((r) => r.pathname === '/rest/v1/contract_documents' && ['POST', 'PATCH'].includes(r.method))
                .map((r) => ({ method: r.method, search: r.search, body: r.body }));
            await context.close();
            return { dialogs: [...dialogs], docWrites };
        };
        const formInsertFail = await uploadFormDoc({ contractDocInsertFails: true });
        assert('F4f 表單模板新版寫入失敗 → 舊版沒有被停用且顯示上傳失敗',
            formInsertFail.docWrites.every((w) => w.method !== 'PATCH') && formInsertFail.dialogs.some((m) => m.includes('上傳失敗')),
            `${orderOf(formInsertFail.docWrites)} ${formInsertFail.dialogs.join(' | ')}`);
        const formDeactivateFail = await uploadFormDoc({ contractDocDeactivateFails: true });
        assert('F4g 表單模板先寫入新版再停用舊版；停用失敗時顯示提醒',
            orderOf(formDeactivateFail.docWrites) === 'POST>PATCH'
            && formDeactivateFail.dialogs.some((m) => m.includes('舊版') && m.includes('停用失敗')),
            `${orderOf(formDeactivateFail.docWrites)} ${formDeactivateFail.dialogs.join(' | ')}`);
        const formOk = await uploadFormDoc({});
        assert('F4h 表單模板上傳成功時提醒新版本要重新設定欄位位置',
            orderOf(formOk.docWrites) === 'POST>PATCH' && formOk.dialogs.some((m) => m.startsWith('上傳成功') && m.includes('定位欄位')),
            `${orderOf(formOk.docWrites)} ${formOk.dialogs.join(' | ')}`);

        // ── F5：唯讀文件排在最後一步 ──
        resetMock({ contractDocs: VIEW_ONLY_LAST_DOCS });
        {
            const { context, page, dialogs, pageErrors } = await openPage(browser, '/contract');
            await page.getByRole('button', { name: FINISH_READING }).waitFor({ timeout: 15000 });
            await page.getByRole('button', { name: FINISH_READING }).click();
            await page.getByRole('heading', { name: '委任契約書' }).waitFor({ timeout: 10000 });
            await page.getByRole('button', { name: /下一步/ }).click();
            await page.getByRole('heading', { name: '附件：補充說明' }).waitFor({ timeout: 10000 });
            await page.waitForTimeout(800);
            const formShown = await page.getByRole('heading', { name: '填寫契約資料' }).count() === 1;
            const finishButtonShown = await page.getByRole('button', { name: FINISH_READING }).count();
            const submitShown = await page.getByRole('button', { name: /確認送出簽約/ }).count() === 1;
            assert('F5a 最後一步是唯讀文件時，最後一步顯示簽約表單與送出按鈕', formShown && submitShown,
                `form=${formShown} submit=${submitShown}`);
            assert('F5b 最後一步不再出現會跳到空白頁的「看完」按鈕', finishButtonShown === 0, `finishButtons=${finishButtonShown}`);
            let rpcBody = {};
            let completed = false;
            if (formShown) {
                await completeSigningForm(page);
                await submitAndSettle(page, dialogs);
                completed = await page.getByRole('heading', { name: '簽約完成！' }).count() === 1;
                rpcBody = rpcCalls()[0] ? JSON.parse(rpcCalls()[0].body) : {};
            }
            assert('F5c 此排序下可完成簽約，RPC 帶三份文件版本、只有需簽署的 contract 有簽署 PDF',
                completed
                && JSON.stringify(rpcBody.p_doc_versions) === JSON.stringify({ rules: 2, contract: 3, appendix: 1 })
                && JSON.stringify(Object.keys(rpcBody.p_signed_pdf_paths || {})) === JSON.stringify(['contract']),
                `completed=${completed} ${JSON.stringify({ v: rpcBody.p_doc_versions, p: Object.keys(rpcBody.p_signed_pdf_paths || {}) })} dialogs=${dialogs.join(' | ')}`);
            assert('F5d 此排序沒有未預期的頁面錯誤', pageErrors.length === 0, pageErrors.join(' | ') || 'errors=0');
            await context.close();
        }
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }

    const passed = results.filter((result) => result.pass).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
