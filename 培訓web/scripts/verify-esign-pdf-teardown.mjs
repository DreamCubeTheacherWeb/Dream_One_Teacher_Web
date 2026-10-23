#!/usr/bin/env node
/*
 * 回歸驗證：簽約頁的 PDF 還沒載完就被拆掉（換下一份文件、進入簽約同意頁）時，不得出現未處理的頁面錯誤，
 * 而且送出的雜湊必須等於實際下載的範本、實際上傳的簽署 PDF。
 *
 * 由來（2026-10-23）：發版候選 075d12d 的 verify:contract-download-fixes 約一半機率在 F1h／F5d 出現
 * 「Error: Worker was terminated」。成因是 PDF.js 用網址自己下載 PDF 時，文件還在載入就被拆掉，
 * PDF.js worker 內部丟出沒人接住的錯誤（Playwright 會把 worker 內未處理的錯誤算成 pageerror）。
 * 簽約線把「閱讀」改成獨立步驟、讀完就整個換到同意頁，拆掉時機剛好落在 PDF 載入中。
 *
 * 全程 mock Supabase（瀏覽器內攔截所有請求，不連任何後端）。每份範本的位元組都不同（尾端註解帶文件種類與版本），
 * 雜湊對錯文件也抓得到。
 * T1 範本 PDF 回應延遲 600ms（模擬手機網路）：三份文件依正式排序，一看完就換下一份、一到契約就前往同意頁，完成簽約
 * T2 唯讀文件排最後一步的排序，同樣延遲
 * T3 不延遲：在 0～150ms 間的隨機時間點按「看完／下一步／前往選擇簽約方式」，掃過 PDF 載入中的時間窗
 * 每輪檢查：沒有 pageerror、簽約完成且 RPC 一次、p_document_sha256 每份等於該份範本實際位元組的 SHA-256、
 *   p_signed_pdf_sha256 等於實際上傳的簽署 PDF 的 SHA-256 且該 PDF 能被 pdf-lib 讀出、所有上傳完成後才呼叫 RPC
 * T4 閱讀門檻：換到下一份唯讀文件、它還沒載入前，「看完」按鈕不可按（不能沿用上一份文件的已讀狀態）
 *
 * 用法：node scripts/verify-esign-pdf-teardown.mjs [--skip-build] [--rounds=N]（每個情境跑 N 輪，預設 3）
 */
import { existsSync, readFileSync } from 'fs';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4241;
const BASE = `http://localhost:${PORT}`;
const ROUNDS = Number((process.argv.find((arg) => arg.startsWith('--rounds=')) || '--rounds=3').split('=')[1]) || 3;
const PDF_DELAY_MS = 600;
const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));
const { PDFDocument } = require(path.join(APP_DIR, 'node_modules/pdf-lib'));
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
const UID = '00000000-0000-4000-8000-000000000078';
const NOW = new Date().toISOString();
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

const FAKE_AUTH_USER = {
    id: UID, aud: 'authenticated', role: 'authenticated',
    email: 'pdf-teardown@test.local', email_confirmed_at: NOW, confirmed_at: NOW, last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '拆卸測試員', avatar_url: '' },
    identities: [], created_at: NOW, updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.pdf.teardown', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.pdf.teardown.refresh',
    user: FAKE_AUTH_USER,
};
const TEACHER = {
    id: 'inst-teardown', user_id: UID, full_name: '拆卸測試員', nickname: '拆卸', gender: '女', birth_date: '1990-01-01',
    id_number: 'A123456789', phone_mobile: '0912345678', line_id: 'x', address: '台北市測試路 1 號',
    household_address: '台北市測試路 1 號', email_primary: FAKE_AUTH_USER.email, email_secondary: '', instructor_role: 'A',
    teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次', teaching_regions: ['臺北市'],
    bio_notes: '測試資料', bank_account_name: '測試戶名', bank_name: '測試銀行', bank_branch: '測試分行',
    bank_account_number: '1234567890', bank_code: '822123',
    photo_path: 'mock/photo.jpg', id_front_path: 'mock/id-front.jpg', id_back_path: 'mock/id-back.jpg', bankbook_path: 'mock/bankbook.jpg',
    hide_from_leaderboard: false,
};

const DOC = (doc_type, display_name, version, sort_order, doc_mode) => ({
    id: `doc-${doc_type}`, doc_type, display_name, version, sort_order, doc_category: 'contract', doc_mode,
    is_active: true, file_path: `templates/${doc_type}/v${version}.pdf`, file_name: `${doc_type}.pdf`,
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

const MINIMAL_PDF = Buffer.from(
    'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwMgolJUVPRgo=',
    'base64'
);
// 每份範本位元組都不同：尾端加一行註解（PDF 讀取器會忽略 %%EOF 之後的註解）
const templateBytesFor = (filePath) => Buffer.concat([MINIMAL_PDF, Buffer.from(`% template ${filePath}\n`)]);

let mock;
const resetMock = (overrides = {}) => {
    mock = { contractDocs: PRODUCTION_ORDER_DOCS, pdfDelayMs: 0, requests: [], uploads: [], ...overrides };
};

function jsonRes(route, data) {
    const headers = { 'content-type': 'application/json' };
    if (Array.isArray(data)) headers['content-range'] = data.length ? `0-${data.length - 1}/${data.length}` : '*/0';
    return route.fulfill({ status: 200, headers, body: JSON.stringify(data) });
}

async function handleRoute(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    const method = req.method();
    const pathname = url.pathname;
    mock.requests.push({ method, pathname, body: req.postData() || '' });

    if (pathname.startsWith('/auth/v1/')) {
        if (pathname === '/auth/v1/user') return jsonRes(route, FAKE_AUTH_USER);
        if (pathname.startsWith('/auth/v1/token') || pathname.startsWith('/auth/v1/verify')) return jsonRes(route, FAKE_SESSION);
        return jsonRes(route, {});
    }
    if (pathname.startsWith('/rest/v1/rpc/')) {
        if (pathname.endsWith('/submit_my_contract')) {
            return jsonRes(route, { status: 'signed', contract_id: 'contract-teardown-1', signed_at: NOW, evidence_id: 'evidence-teardown-1', copy_email_masked: 'pd***@test.local' });
        }
        if (pathname.endsWith('/get_my_activation_status')) {
            return jsonRes(route, { status: 'active', claim_method: 'legacy_pre_activation', has_confirmed_email: true, masked_email: 'pd***@test.local', profile_complete: true });
        }
        if (pathname.endsWith('/record_contract_consent')) return jsonRes(route, { status: 'recorded', consent_id: '00000000-0000-4000-8000-0000000000c2', created_at: NOW });
        if (pathname.endsWith('/request_email_otp')) {
            return jsonRes(route, { status: 'sent', challenge_id: '00000000-0000-4000-8000-0000000000d2', expires_at: new Date(Date.now() + 300000).toISOString(), masked_email: 'pd***@test.local', resend_after_seconds: 60 });
        }
        if (pathname.endsWith('/verify_email_otp')) return jsonRes(route, { status: 'verified', verified_at: new Date().toISOString(), activated: false });
        return jsonRes(route, null);
    }
    if (pathname.startsWith('/storage/v1/object/sign/') && method === 'POST') {
        return jsonRes(route, { signedURL: `${pathname.replace('/storage/v1', '')}?token=mock` });
    }
    if (pathname.startsWith('/storage/v1/object/') && (method === 'POST' || method === 'PUT')) {
        const key = pathname.replace(/^\/storage\/v1\/object\/contract-documents\//, '');
        mock.uploads.push({ key, contentType: (await req.allHeaders())['content-type'] || '', body: req.postDataBuffer() || Buffer.alloc(0) });
        return jsonRes(route, { Id: `mock-${mock.requests.length}`, Key: key });
    }
    if (pathname.startsWith('/storage/v1/object/')) {
        // 閱讀畫面用的是簽名網址（/object/sign/…）；簽約送出時算雜湊用的是直接下載。只延遲閱讀畫面那條。
        const filePath = pathname.replace(/^\/storage\/v1\/object\/(sign\/|authenticated\/|public\/)?contract-documents\//, '');
        if (pathname.startsWith('/storage/v1/object/sign/') && mock.pdfDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, mock.pdfDelayMs));
        }
        try {
            return await route.fulfill({ status: 200, contentType: 'application/pdf', body: templateBytesFor(filePath) });
        } catch (error) {
            if (/closed|disposed/i.test(String(error))) return undefined; // 頁面已關（延遲中被拆掉）
            throw error;
        }
    }
    if (pathname.startsWith('/rest/v1/')) {
        const table = pathname.replace('/rest/v1/', '').split('/')[0];
        const accept = (await req.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');
        if (method !== 'GET') return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });
        const one = (rows) => (wantsObject ? rows[0] ?? null : rows);
        switch (table) {
            case 'users': return jsonRes(route, one([{ id: UID, name: TEACHER.full_name, email: FAKE_AUTH_USER.email, role: 'teacher', created_at: NOW }]));
            case 'instructors': return jsonRes(route, one([TEACHER]));
            case 'contract_documents': return jsonRes(route, one(mock.contractDocs));
            case 'contract_field_positions':
                return jsonRes(route, one(url.searchParams.get('doc_type') === 'eq.contract' ? CONTRACT_POSITIONS : []));
            default: return jsonRes(route, wantsObject ? null : []);
        }
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

const portIsFree = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
});

async function waitForOwnServer(preview, url, timeoutMs) {
    const start = Date.now();
    for (;;) {
        if (preview.exitCode !== null) throw new Error(`vite preview 已結束（exit ${preview.exitCode}），可能是 port ${PORT} 被占用`);
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
const waitUntil = async (fn, timeoutMs = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await fn()) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
};

async function openPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ key, session }) => {
        window.localStorage.setItem(key, JSON.stringify(session));
    }, { key: STORAGE_KEY, session: FAKE_SESSION });
    await context.route('**/*', handleRoute);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('dialog', (dialog) => dialog.accept());
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(`${BASE}/contract`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return { context, page, pageErrors };
}

const FINISH_READING = '我已完整看完且清楚這份文件的所有內容';
const FINISH_READING_LAST = '我已看完，前往選擇簽約方式';
const jitter = (maxMs) => (maxMs ? Math.floor(Math.random() * maxMs) : 0);

// 一看到可以按的「看完／下一步／前往選擇簽約方式」就按（可加 0～maxJitter 毫秒的隨機等待），直到出現同意頁
async function readThroughFast(page, maxJitter) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        if (await page.getByTestId('consent-page').isVisible()) return true;
        for (const name of [FINISH_READING, FINISH_READING_LAST]) {
            const button = page.getByRole('button', { name, exact: true });
            if (await button.isVisible() && await button.isEnabled()) {
                await page.waitForTimeout(jitter(maxJitter));
                await button.click();
                break;
            }
        }
        const readNext = page.getByTestId('read-next');
        if (await readNext.isVisible()) {
            await page.waitForTimeout(jitter(maxJitter));
            await readNext.click();
        }
        await page.waitForTimeout(20);
    }
    return false;
}

async function completeSigningForm(page) {
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('consent-agree').click();
    await page.getByTestId('sign-phase').waitFor({ timeout: 10000 });
    await page.getByTestId('read-ack-checkbox').check();
    await page.getByTestId('send-otp').click();
    const dialog = page.getByTestId('email-otp-dialog');
    await dialog.waitFor({ timeout: 10000 });
    await page.locator('#email-otp-code').waitFor({ timeout: 10000 });
    await page.locator('#email-otp-code').fill('123456');
    await dialog.getByRole('button', { name: '驗證', exact: true }).click();
    await page.getByTestId('contract-otp-card').getByText('本人身分已驗證').waitFor({ timeout: 10000 });
    await page.getByTestId('open-signature').click();
    const canvas = page.locator('canvas').last();
    await canvas.waitFor({ timeout: 10000 });
    await page.waitForTimeout(400); // 簽名板開啟後會依容器大小重設畫布（並清空），等它重設完再簽
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 12; i += 1) {
        await page.mouse.move(box.x + 30 + i * 18, box.y + box.height / 2 + (i % 2 ? -20 : 20), { steps: 3 });
    }
    await page.mouse.up();
    await page.getByRole('button', { name: '確認簽名' }).click();
    const submit = page.getByTestId('submit-contract');
    await waitUntil(async () => submit.isEnabled(), 5000);
    await submit.click();
    await waitUntil(async () => await page.getByTestId('signing-complete').count() > 0
        || await page.getByTestId('submit-error').count() > 0, 25000);
}

// multipart/form-data（supabase-js 上傳 Blob 的格式）取出檔案那一段的位元組；不是 multipart 就是原始位元組
function uploadedFileBytes(upload) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(upload.contentType);
    if (!match) return upload.body;
    const boundary = Buffer.from(`--${match[1] || match[2]}`);
    let index = upload.body.indexOf(boundary);
    while (index !== -1) {
        const next = upload.body.indexOf(boundary, index + boundary.length);
        if (next === -1) break;
        const part = upload.body.subarray(index + boundary.length + 2, next - 2);
        const separator = part.indexOf('\r\n\r\n');
        if (/filename=/.test(part.subarray(0, separator).toString())) return part.subarray(separator + 4);
        index = next;
    }
    return null;
}

// 送出的證據雜湊 vs 實際位元組
async function checkEvidence() {
    const rpcCalls = mock.requests.filter((r) => r.pathname === '/rest/v1/rpc/submit_my_contract');
    if (rpcCalls.length !== 1) return [`submit_my_contract 呼叫 ${rpcCalls.length} 次`];
    const body = JSON.parse(rpcCalls[0].body);
    const problems = [];
    for (const doc of mock.contractDocs) {
        const expected = sha256(templateBytesFor(doc.file_path));
        if (body.p_document_sha256?.[doc.doc_type] !== expected) {
            problems.push(`範本 ${doc.doc_type}: 送出 ${String(body.p_document_sha256?.[doc.doc_type]).slice(0, 12)} ≠ 實際 ${expected.slice(0, 12)}`);
        }
    }
    const signedPaths = body.p_signed_pdf_paths || {};
    if (JSON.stringify(Object.keys(signedPaths)) !== JSON.stringify(['contract'])) problems.push(`簽署 PDF 路徑 ${JSON.stringify(signedPaths)}`);
    for (const [docType, filePath] of Object.entries(signedPaths)) {
        const upload = mock.uploads.find((u) => u.key === filePath);
        const bytes = upload && uploadedFileBytes(upload);
        if (!bytes) { problems.push(`${docType}: 找不到上傳的 ${filePath}`); continue; }
        if (body.p_signed_pdf_sha256?.[docType] !== sha256(bytes)) {
            problems.push(`簽署 ${docType}: 送出 ${String(body.p_signed_pdf_sha256?.[docType]).slice(0, 12)} ≠ 上傳 ${sha256(bytes).slice(0, 12)}`);
        }
        try {
            const pdf = await PDFDocument.load(bytes);
            if (pdf.getPageCount() < 1) problems.push(`簽署 ${docType}: 0 頁`);
        } catch (error) { problems.push(`簽署 ${docType}: pdf-lib 讀不出（${error.message}）`); }
    }
    if (!mock.uploads.some((u) => u.key === body.p_signature_path)) problems.push(`簽名圖 ${body.p_signature_path} 沒有上傳`);
    const rpcIndex = mock.requests.findIndex((r) => r.pathname === '/rest/v1/rpc/submit_my_contract');
    const lastUpload = mock.requests.reduce((last, r, i) => ((r.method === 'POST' || r.method === 'PUT')
        && r.pathname.startsWith('/storage/v1/object/contract-documents/signed/') ? i : last), -1);
    if (!(lastUpload >= 0 && lastUpload < rpcIndex)) problems.push(`上傳順序：最後一筆上傳 #${lastUpload}、RPC #${rpcIndex}`);
    return problems;
}

async function signingRound(browser, { docs, delayMs, maxJitter }) {
    resetMock({ contractDocs: docs, pdfDelayMs: delayMs });
    const { context, page, pageErrors } = await openPage(browser);
    let reached = false;
    let completed = false;
    try {
        reached = await readThroughFast(page, maxJitter);
        if (reached) {
            await completeSigningForm(page);
            completed = await page.getByTestId('signing-complete').count() === 1;
        }
        await page.waitForTimeout(500); // 讓拆掉的 worker 有時間把錯誤報上來
    } finally {
        await context.close();
    }
    const evidence = completed ? await checkEvidence() : ['沒有完成簽約'];
    return { reached, completed, pageErrors, evidence };
}

async function runScenario(browser, label, options) {
    const rounds = [];
    for (let i = 0; i < ROUNDS; i += 1) rounds.push(await signingRound(browser, options));
    const errors = rounds.flatMap((r) => r.pageErrors);
    const evidenceProblems = rounds.flatMap((r) => r.evidence);
    assert(`${label}：${ROUNDS} 輪都完成簽約`, rounds.every((r) => r.completed), rounds.map((r) => (r.completed ? 'ok' : 'x')).join(''));
    assert(`${label}：${ROUNDS} 輪都沒有未預期的頁面錯誤`, errors.length === 0, errors.join(' | ') || 'errors=0');
    assert(`${label}：送出的範本／簽署 PDF 雜湊等於實際位元組、上傳完成才送 RPC`, evidenceProblems.length === 0,
        evidenceProblems.join(' | ') || `${ROUNDS} 輪全部相符`);
}

async function main() {
    if (!process.argv.includes('--skip-build')) {
        console.log('── npm run build ──');
        execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    }
    if (!await portIsFree(PORT)) throw new Error(`port ${PORT} 已被其他程序占用，不跑（避免測到別人的伺服器）`);
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser;
    try {
        await waitForOwnServer(preview, BASE, 45000);
        browser = await chromium.launch(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {});

        await runScenario(browser, 'T1 正式排序＋PDF 延遲', { docs: PRODUCTION_ORDER_DOCS, delayMs: PDF_DELAY_MS, maxJitter: 0 });
        await runScenario(browser, 'T2 唯讀文件排最後＋PDF 延遲', { docs: VIEW_ONLY_LAST_DOCS, delayMs: PDF_DELAY_MS, maxJitter: 0 });
        await runScenario(browser, 'T3 正式排序＋0～150ms 隨機時間點換步驟', { docs: PRODUCTION_ORDER_DOCS, delayMs: 0, maxJitter: 150 });

        // T4：看完第一份 → 第二份還在載入（延遲中）時，「看完」按鈕不可按
        resetMock({ contractDocs: PRODUCTION_ORDER_DOCS, pdfDelayMs: PDF_DELAY_MS });
        {
            const { context, page, pageErrors } = await openPage(browser);
            const finish = page.getByRole('button', { name: FINISH_READING, exact: true });
            await waitUntil(async () => await finish.isVisible() && await finish.isEnabled(), 15000);
            await finish.click();
            await page.getByRole('heading', { name: '講師委任報酬表' }).waitFor({ timeout: 10000 });
            const enabledWhileLoading = await finish.isVisible() && await finish.isEnabled();
            const enabledAfterLoad = await waitUntil(async () => await finish.isVisible() && await finish.isEnabled(), 15000);
            await page.waitForTimeout(300);
            await context.close();
            assert('T4 換到第二份唯讀文件、還沒載入前「看完」按鈕不可按；載入後才可按',
                !enabledWhileLoading && enabledAfterLoad && pageErrors.length === 0,
                `載入中可按=${enabledWhileLoading} 載入後可按=${enabledAfterLoad} errors=${pageErrors.join(' | ') || 0}`);
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
