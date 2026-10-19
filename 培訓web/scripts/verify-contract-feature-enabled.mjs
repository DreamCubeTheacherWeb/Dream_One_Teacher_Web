#!/usr/bin/env node
/*
 * 回歸驗證：2026-10-18 講師前台簽約正式重開；報酬頁、後台自動填表與下載中心維持原行為。
 *
 * T1 講師個人頁顯示簽約區塊
 * T2 合約通知會顯示並計入未讀數
 * T3 講師開 /contract 停在簽約頁：逐份閱讀（可下載範本）→ 電子簽約同意頁 → 簽署階段出現 Email 驗證（寄送驗證碼），
 *    不出現「測試模式」，也不再有「具備一樣的法律效力」這句（法遵紅燈 R1）
 * T4 講師開 /contract/view/:id 可看自己的合約
 * T5 講師瀏覽個人頁會查詢 instructor_contracts，且講師端絕不直接 POST/PATCH/DELETE instructor_contracts
 * T6 管理員合約後台仍在，上傳確認文案含「將通知所有講師」（只攔 confirm 後取消，不真的上傳）
 * T7 講師導覽列顯示「我的報酬」
 * T8 講師可使用站內課程回報與報酬明細，並保留外部表單作轉換備援
 * T9 管理員可在講師名單預覽自動填好的 PDF，確認後再下載
 * T10 表單預覽與下載會顯示匯款完整度、隱藏舊帶入提示並支援手機版
 * T11 完整簽約流程（2026-10-20 電子簽約證據）：同意 → Email 驗證碼 → 簽名 → 確認簽署；
 *     submit_my_contract 帶 4 個新參數，雜湊是 64 位小寫 hex，且＝實際下載的範本／實際上傳的成品位元組的 SHA-256；
 *     連點兩下只送一次；成功頁顯示伺服器簽署時間（台北時間）與副本通知信箱
 * T12 不同意電子簽約 → 確認視窗 → 記錄 decline_electronic → 紙本流程畫面，不進 OTP／簽名
 * T13 送出錯誤代碼對應白話訊息與下一步（DOC_VERSION_MISMATCH 回到閱讀、OTP_EXPIRED 要重新驗證、CONSENT_REQUIRED 回同意頁）
 * T14 Email 驗證視窗：各種寄送／驗證結果的訊息、手機 390px 不溢出、觸控目標 ≥ 44px
 * T16 契約版本：個人頁與契約查閱頁列出所有版本（含已作廢，標示作廢時間與原因），每份可下載
 * T15 管理員合約後台：上傳新版帶 content_sha256、舊版可補登雜湊、簽署證據（同意／OTP／雜湊／寄送紀錄）、
 *     驗證檔案完整性（竄改會抓到）、驗證證據鏈
 *
 * 截圖存 docs/verification/2026-10-18-contract-reopen/
 * 用法：node scripts/verify-contract-feature-enabled.mjs
 */
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4223;
const BASE = `http://localhost:${PORT}`;
const SHOT_DIR = path.join(APP_DIR, 'docs/verification/2026-10-18-contract-reopen');
mkdirSync(SHOT_DIR, { recursive: true });
const SCREENSHOT = path.join(SHOT_DIR, 'teacher-profile-and-notifications.png');
const SIGNING_SCREENSHOT = path.join(SHOT_DIR, 'teacher-signing-email-verification.png');
const SIGNING_MOBILE_SCREENSHOT = path.join(SHOT_DIR, 'teacher-signing-email-verification-mobile.png');
const CONTRACT_VIEW_SCREENSHOT = path.join(SHOT_DIR, 'teacher-contract-view.png');
const ADMIN_CONTRACTS_SCREENSHOT = path.join(SHOT_DIR, 'admin-contracts.png');
const ADMIN_SCREENSHOT = path.join(SHOT_DIR, 'admin-instructor-form-download.png');
const ADMIN_MOBILE_SCREENSHOT = path.join(SHOT_DIR, 'admin-instructor-form-download-mobile.png');
const DOWNLOAD_CENTER_SCREENSHOT = path.join(SHOT_DIR, 'admin-remittance-download-center.png');
const DOWNLOAD_CENTER_MOBILE_SCREENSHOT = path.join(SHOT_DIR, 'admin-remittance-download-center-mobile.png');
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
    email: 'contract-reopen@test.local',
    email_confirmed_at: NOW,
    confirmed_at: NOW,
    last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '簽約重開測試員', avatar_url: '' },
    identities: [],
    created_at: NOW,
    updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.contract.reopen',
    token_type: 'bearer',
    expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    refresh_token: 'mock.contract.refresh',
    user: FAKE_AUTH_USER,
};
const INSTRUCTOR = {
    id: 'instructor-contract-reopen', user_id: UID,
    full_name: '簽約重開測試員', nickname: '暫停測試', gender: '女',
    birth_date: '1990-01-01', id_number: 'A123456789', phone_mobile: '0912345678',
    line_id: 'contract-reopen', address: '台北市測試路 1 號', household_address: '台北市測試路 1 號',
    email_primary: FAKE_AUTH_USER.email, email_secondary: '', instructor_role: 'A',
    teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次',
    teaching_regions: ['臺北市'], bio_notes: '測試資料',
    bank_account_name: '簽約重開測試員', bank_name: '測試銀行', bank_branch: '測試分行',
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
    filled_name: '簽約重開測試員', filled_instructor_role: 'A',
    filled_id_number: 'A123456789', filled_address: INSTRUCTOR.address,
    filled_phone: INSTRUCTOR.phone_mobile, doc_versions: {}, signed_pdf_paths: {},
    signature_path: null,
};
// 重簽後被作廢的舊版（簽約紀錄不會因重簽而消失）
const VOIDED_CONTRACT = {
    id: 'contract-0', user_id: UID, status: 'voided', signed_at: '2026-10-01T02:00:00Z',
    voided_at: '2026-10-20T06:03:09Z', voided_reason: '重新簽約',
    filled_name: '簽約重開測試員', filled_instructor_role: 'A', doc_versions: { contract: 2 },
    signed_pdf_paths: { contract: 'signed/00000000-0000-4000-8000-000000000031/contract_old.pdf' }, signature_path: null,
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

// 簽約流程的三份啟用文件（前兩份只讀、最後一份需填寫簽名；doc_category 'contract'）
const CONTRACT_DOCUMENTS = [
    { id: 'doc-rules', doc_type: 'rules', display_name: '講師管理辦法', version: 2, sort_order: 1, doc_category: 'contract', doc_mode: 'view_only', is_active: true, file_path: 'templates/rules/v2.pdf', file_name: 'rules.pdf' },
    { id: 'doc-compensation', doc_type: 'compensation', display_name: '講師委任報酬表', version: 1, sort_order: 2, doc_category: 'contract', doc_mode: 'view_only', is_active: true, file_path: 'templates/compensation/v1.pdf', file_name: 'compensation.pdf' },
    { id: 'doc-contract', doc_type: 'contract', display_name: '委任契約書', version: 3, sort_order: 3, doc_category: 'contract', doc_mode: 'fill_sign', is_active: true, file_path: 'templates/contract/v3.pdf', file_name: 'contract.pdf' },
];
const CONTRACT_POSITIONS = [
    { id: 'pos-signature', doc_type: 'contract', doc_version: 3, field_type: 'signature', page_number: 1, x: 300, y_from_top: 600, width: 160, height: 60, font_size: 13 },
    { id: 'pos-name', doc_type: 'contract', doc_version: 3, field_type: 'name', page_number: 1, x: 120, y_from_top: 120, width: 160, height: 24, font_size: 13 },
];

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const MINIMAL_PDF = Buffer.from(
    'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjIwMgolJUVPRgo=',
    'base64'
);

const CONSENT_ID = '00000000-0000-4000-8000-0000000000c1';
const CHALLENGE_ID = '00000000-0000-4000-8000-0000000000d1';
const SIGNED_AT = '2026-10-20T06:03:09Z'; // 台北時間 2026-10-20 14:03:09
const MASKED_EMAIL = 'co***@example.com';

// RPC 預設回覆；各情境可覆寫。回傳 { __error: '訊息' } 代表 PostgREST 400（RAISE EXCEPTION）。
const defaultRpcHandlers = () => ({
    get_my_activation_status: () => ({ status: 'active', claim_method: 'legacy_pre_activation', has_confirmed_email: true, masked_email: MASKED_EMAIL, profile_complete: true }),
    record_contract_consent: () => ({ status: 'recorded', consent_id: CONSENT_ID, created_at: SIGNED_AT }),
    request_email_otp: () => ({ status: 'sent', challenge_id: CHALLENGE_ID, expires_at: new Date(Date.now() + 300000).toISOString(), masked_email: MASKED_EMAIL, resend_after_seconds: 60 }),
    verify_email_otp: () => ({ status: 'verified', verified_at: new Date().toISOString(), activated: false }),
    submit_my_contract: () => ({ status: 'signed', contract_id: 'contract-new', signed_at: SIGNED_AT, evidence_id: 'evidence-new', copy_email_masked: MASKED_EMAIL }),
    admin_verify_contract_evidence_chain: () => ({ ok: true, checked: 3, first_broken_id: null }),
    admin_set_document_hash: () => ({ status: 'saved' }),
});
let rpcHandlers = defaultRpcHandlers();
let rpcCalls = [];
let storageUploads = [];
let contractDocumentInserts = [];
let tamperedPaths = new Set();
const resetMockState = () => {
    rpcHandlers = defaultRpcHandlers();
    rpcCalls = [];
    storageUploads = [];
    contractDocumentInserts = [];
    tamperedPaths = new Set();
};
const callsOf = (name) => rpcCalls.filter((call) => call.name === name);

// 管理員後台「簽署證據」用的資料（對應 SIGNED_CONTRACT）
const EVIDENCE_PDF_PATH = 'signed/00000000-0000-4000-8000-000000000031/contract_1.pdf';
const EVIDENCE = {
    id: 'evidence-1', contract_id: 'contract-1', user_id: UID, bound_email: 'contract-reopen@test.local',
    doc_versions: { contract: 3 }, document_sha256: { contract: sha256(MINIMAL_PDF) },
    signed_pdf_paths: { contract: EVIDENCE_PDF_PATH }, signed_pdf_sha256: { contract: sha256(MINIMAL_PDF) },
    consent_id: CONSENT_ID, consent_at: '2026-10-20T06:00:00Z', otp_challenge_id: CHALLENGE_ID,
    otp_verified_at: '2026-10-20T06:02:00Z', signed_at: SIGNED_AT, ip_address: '203.0.113.9', user_agent: 'MockBrowser/1.0',
    previous_evidence_sha256: 'p'.repeat(64).replace(/p/g, 'a'), evidence_sha256: 'e'.repeat(64).replace(/e/g, 'b'),
    created_at: SIGNED_AT,
};
const CONSENT_RECORD = {
    id: CONSENT_ID, user_id: UID, decision: 'agree_electronic', consent_text_version: 'esign-consent-v1',
    consent_text: '[esign-consent-v1] 選擇簽約方式', created_at: '2026-10-20T06:00:00Z',
};
const DELIVERIES = [
    { id: 'mail-1', kind: 'contract_signed_copy', to_email: 'contract-reopen@test.local', subject: '簽署完成通知', requested_at: SIGNED_AT, status: 'sent', http_status: 200, provider_message_id: 'resend-123', error_text: null },
];

let currentRole = 'teacher';
let teacherContractTableReads = 0;
let teacherContractTableWrites = [];
let teacherContractNotificationWrites = 0;
let teacherSalaryReads = 0;
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
    if (pathname.startsWith('/rest/v1/rpc/')) {
        const name = pathname.split('/rpc/')[1];
        const body = req.postData() ? JSON.parse(req.postData()) : {};
        rpcCalls.push({ name, body });
        const handler = rpcHandlers[name];
        const result = handler ? handler(body) : null;
        if (result && result.__error) {
            return route.fulfill({ status: 400, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'P0001', message: result.__error, details: null, hint: null }) });
        }
        return jsonRes(route, result);
    }
    if (pathname.startsWith('/storage/v1/object/sign/') && req.method() === 'POST') {
        // createSignedUrl：回 JSON，客戶端再用這個網址抓 PDF（有 download 參數時真實 Storage 會回 attachment）
        const objectPath = decodeURIComponent(pathname.replace('/storage/v1/object/sign/contract-documents/', ''));
        return jsonRes(route, { signedURL: `/object/sign/contract-documents/${objectPath}?token=mock` });
    }
    if (pathname.startsWith('/storage/v1/object/') && (req.method() === 'POST' || req.method() === 'PUT')) {
        // 上傳：記下實際送出的位元組（multipart 內的檔案內容），供雜湊比對
        storageUploads.push({ path: decodeURIComponent(pathname.replace('/storage/v1/object/', '')), contentType: req.headers()['content-type'] || '', body: req.postDataBuffer() });
        return jsonRes(route, { Key: pathname.replace('/storage/v1/object/', ''), Id: 'mock-object-id' });
    }
    if (pathname.startsWith('/storage/v1/object/')) {
        const objectPath = decodeURIComponent(pathname.replace(/^\/storage\/v1\/object\/(sign\/)?contract-documents\//, ''));
        const headers = { 'content-type': 'application/pdf' };
        const downloadName = url.searchParams.get('download');
        if (downloadName) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
        // 竄改情境：該路徑回傳的檔案內容和簽署當下不同
        const body = tamperedPaths.has(objectPath) ? Buffer.concat([MINIMAL_PDF, Buffer.from('\n% tampered\n')]) : MINIMAL_PDF;
        return route.fulfill({ status: 200, headers, body });
    }
    if (pathname.startsWith('/rest/v1/')) {
        const table = pathname.replace('/rest/v1/', '').split('/')[0];
        const method = req.method();
        const accept = (await req.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');

        if (currentRole === 'teacher' && method === 'GET' && table === 'instructor_contracts') {
            teacherContractTableReads += 1;
        }
        if (currentRole === 'teacher' && method !== 'GET' && table === 'instructor_contracts') {
            teacherContractTableWrites.push(`${method} ${url.pathname}${url.search}`);
        }
        if (currentRole === 'teacher' && method === 'GET' && ['instructor_salary_summary', 'class_sessions'].includes(table)) {
            teacherSalaryReads += 1;
        }
        if (currentRole === 'teacher' && method !== 'GET' && table === 'notifications') {
            const body = req.postData() || '';
            if (body.includes('contract')) teacherContractNotificationWrites += 1;
        }
        if (method === 'GET' && table === 'instructors' && (url.searchParams.has('id') || url.search.includes('id=in.'))) {
            latestInstructorReads += 1;
        }
        if (method === 'POST' && table === 'contract_documents') {
            contractDocumentInserts.push(JSON.parse(req.postData() || '{}'));
        }
        if (method !== 'GET') {
            return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{"id":"new-doc-id"}' : '[]' });
        }

        const profile = { id: UID, name: '簽約重開測試員', email: FAKE_AUTH_USER.email, role: currentRole, created_at: NOW };
        let data;
        switch (table) {
            case 'users': data = wantsObject ? profile : [profile]; break;
            case 'instructors': data = wantsObject ? INSTRUCTOR : [INSTRUCTOR]; break;
            case 'instructor_salary_summary': data = wantsObject ? SALARY_SUMMARY : [SALARY_SUMMARY]; break;
            case 'class_sessions': data = []; break;
            case 'site_links': data = wantsObject ? SALARY_LINKS[0] : SALARY_LINKS; break;
            case 'instructor_contracts': data = wantsObject ? SIGNED_CONTRACT : [SIGNED_CONTRACT, VOIDED_CONTRACT]; break;
            case 'contract_documents': {
                const wantsForm = url.search.includes('doc_category=eq.form') || url.search.includes('doc_type=eq.remittance_form');
                const rows = wantsForm ? [FORM_DOCUMENT] : CONTRACT_DOCUMENTS;
                data = wantsObject ? rows[0] : rows;
                break;
            }
            case 'contract_field_positions': {
                const rows = url.search.includes('doc_type=eq.contract') ? CONTRACT_POSITIONS : [FORM_POSITION];
                data = wantsObject ? rows[0] : rows;
                break;
            }
            case 'notifications': data = wantsObject ? NOTIFICATIONS[0] : NOTIFICATIONS; break;
            case 'contract_signing_evidence': data = wantsObject ? EVIDENCE : [EVIDENCE]; break;
            case 'contract_consent_records': data = wantsObject ? CONSENT_RECORD : [CONSENT_RECORD]; break;
            case 'email_delivery_log': data = DELIVERIES; break;
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

// 從 multipart 上傳內容取出檔案位元組（和伺服器實際收到的一模一樣）
function extractMultipartFile(upload) {
    const match = /boundary=(.+)$/.exec(upload.contentType);
    if (!match || !upload.body) return upload.body;
    const delimiter = Buffer.from(`--${match[1]}`);
    const parts = [];
    let cursor = 0;
    for (;;) {
        const start = upload.body.indexOf(delimiter, cursor);
        if (start < 0) break;
        const next = upload.body.indexOf(delimiter, start + delimiter.length);
        if (next < 0) break;
        parts.push(upload.body.subarray(start + delimiter.length, next));
        cursor = next;
    }
    for (const part of parts) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd < 0) continue;
        const header = part.subarray(0, headerEnd).toString('utf8');
        if (/content-type:\s*application\/pdf/i.test(header) || /filename=/i.test(header)) {
            return part.subarray(headerEnd + 4, part.length - 2); // 去掉結尾的 \r\n
        }
    }
    return upload.body;
}

// 逐份讀完文件，停在「電子簽約同意」前
async function readThroughDocuments(page) {
    await page.goto(`${BASE}/contract`, { waitUntil: 'networkidle', timeout: 20000 });
    const finishReading = page.getByRole('button', { name: '我已完整看完且清楚這份文件的所有內容' });
    // 兩份純閱讀文件：按到「下一步」按鈕（填寫簽署那份）出現為止；PDF 載入快慢不影響結果
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await page.getByTestId('read-next').isVisible()) return;
        if (await finishReading.isVisible() && await finishReading.isEnabled()) await finishReading.click();
        await page.waitForTimeout(400);
    }
    await page.getByTestId('read-next').waitFor({ timeout: 5000 });
}

async function goToConsent(page) {
    await readThroughDocuments(page);
    await page.getByTestId('read-next').click();
    await page.getByTestId('consent-page').waitFor({ timeout: 10000 });
}

async function agreeAndEnterSignPhase(page) {
    await goToConsent(page);
    await page.getByTestId('consent-checkbox').check();
    await page.getByTestId('consent-agree').click();
    await page.getByTestId('sign-phase').waitFor({ timeout: 10000 });
}

async function verifyEmailOtp(page, code = '123456') {
    await page.getByTestId('send-otp').click();
    const dialog = page.getByTestId('email-otp-dialog');
    await dialog.waitFor({ timeout: 10000 });
    await page.locator('#email-otp-code').waitFor({ timeout: 10000 });
    await page.locator('#email-otp-code').fill(code);
    await dialog.getByRole('button', { name: '驗證', exact: true }).click();
    await page.getByTestId('contract-otp-card').getByText('本人身分已驗證').waitFor({ timeout: 10000 });
}

async function drawSignature(page) {
    await page.getByTestId('open-signature').click();
    const canvas = page.locator('canvas').last();
    await canvas.waitFor();
    await page.waitForTimeout(250);
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 40, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 40, { steps: 8 });
    await page.mouse.move(box.x + 200, box.y + 100, { steps: 8 });
    await page.mouse.up();
    await page.getByRole('button', { name: '確認簽名' }).click();
}

// 完整走到可按「確認簽署」
async function completeSigningInputs(page) {
    await agreeAndEnterSignPhase(page);
    await page.getByTestId('read-ack-checkbox').check();
    await verifyEmailOtp(page);
    await drawSignature(page);
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
        await waitForServer(BASE, 45000);
        browser = await chromium.launch(CHROME_EXECUTABLE ? { executablePath: CHROME_EXECUTABLE } : {});

        currentRole = 'teacher';
        teacherContractTableReads = 0;
        teacherContractTableWrites = [];
        teacherContractNotificationWrites = 0;
        let context = await newContext(browser);
        let page = await context.newPage();
        const consoleErrors = [];
        page.on('pageerror', (error) => consoleErrors.push(String(error)));
        await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByRole('heading', { name: '個人資料' }).waitFor();
        await page.waitForTimeout(500);

        const contractSectionCount = await page.getByText('合約簽署', { exact: true }).count();
        assert('T1 講師個人頁顯示簽約區塊', contractSectionCount === 1, `count=${contractSectionCount}`);
        assert('T1b 已有簽約紀錄時提供「查看合約」「重新簽約」入口',
            await page.getByRole('link', { name: /查看合約/ }).count() === 1
            && await page.getByRole('link', { name: /重新簽約/ }).count() >= 1);
        assert('T5a 講師瀏覽個人頁會查詢 instructor_contracts', teacherContractTableReads >= 1, `reads=${teacherContractTableReads}`);
        const compensationNavCount = await page.getByText('我的報酬', { exact: true }).count();
        const oldSalaryNavCount = await page.getByText('我的薪資', { exact: true }).count();
        assert('T7a 講師導覽列顯示我的報酬', compensationNavCount === 1, `count=${compensationNavCount}`);
        assert('T7b 講師導覽列不再顯示我的薪資', oldSalaryNavCount === 0, `count=${oldSalaryNavCount}`);

        const bellButton = page.locator('button:has(svg.lucide-bell)').first();
        const unreadBadge = (await bellButton.locator('span').first().textContent())?.trim();
        await bellButton.click();
        const contractNotificationCount = await page.getByText('尚未完成合約簽署', { exact: true }).count();
        const announcementCount = await page.getByText('一般公告仍正常顯示', { exact: true }).count();
        assert('T2a 合約通知會顯示', contractNotificationCount === 1, `count=${contractNotificationCount}`);
        assert('T2b 合約通知計入未讀數（2 則未讀）', unreadBadge === '2', `badge=${unreadBadge}`);
        assert('T2c 一般通知仍顯示', announcementCount === 1, `count=${announcementCount}`);
        await page.screenshot({ path: SCREENSHOT, fullPage: true });

        // T3：簽約頁逐份閱讀 → 電子簽約同意頁 → 簽署階段的 Email 驗證（不是測試模式、沒有「一樣的法律效力」）
        resetMockState();
        await readThroughDocuments(page);
        assert('T3f 每份文件旁有「下載這份文件」按鈕', await page.getByTestId('download-template').isVisible());
        const downloadPromise0 = page.waitForEvent('download');
        await page.getByTestId('download-template').click();
        const templateDownload = await downloadPromise0;
        assert('T3g 下載範本得到 PDF 檔（檔名含文件名稱與版本）', /委任契約書_第3版\.pdf$/.test(templateDownload.suggestedFilename()), templateDownload.suggestedFilename());
        await page.getByTestId('read-next').click();
        await page.getByTestId('consent-page').waitFor({ timeout: 10000 });
        const consentText = await page.getByTestId('consent-page').innerText();
        assert('T3h 同意頁標題「選擇簽約方式」，說明含文件清單（名稱＋第 N 版）與遮罩信箱',
            consentText.includes('選擇簽約方式') && consentText.includes('講師管理辦法（第 2 版）、講師委任報酬表（第 1 版）、委任契約書（第 3 版）') && consentText.includes(MASKED_EMAIL));
        assert('T3i 同意頁沒有「一樣的法律效力」，也沒有舊的兩個勾選句',
            !consentText.includes('一樣的法律效力') && !consentText.includes('皆可遵守並配合'));
        assert('T3j 個資告知預設展開', await page.getByTestId('privacy-notice').evaluate((node) => node.open === true)
            && (await page.getByTestId('privacy-notice').innerText()).includes('個人資料蒐集告知（電子簽約）'));
        const agreeBox = await page.getByTestId('consent-agree').boundingBox();
        const declineBox = await page.getByTestId('consent-decline').boundingBox();
        assert('T3k 「同意」「不同意」兩顆按鈕一樣大', Math.abs(agreeBox.width - declineBox.width) < 2 && Math.abs(agreeBox.height - declineBox.height) < 2,
            `agree=${Math.round(agreeBox.width)}x${Math.round(agreeBox.height)} decline=${Math.round(declineBox.width)}x${Math.round(declineBox.height)}`);
        assert('T3l 勾選框不預先打勾，未勾選前「同意」按鈕不可按、「不同意」可按',
            !(await page.getByTestId('consent-checkbox').isChecked())
            && await page.getByTestId('consent-agree').isDisabled()
            && await page.getByTestId('consent-decline').isEnabled());
        assert('T3m 還沒同意前沒有呼叫 record_contract_consent', callsOf('record_contract_consent').length === 0);
        await page.screenshot({ path: path.join(SHOT_DIR, 'teacher-consent-page.png'), fullPage: true });
        await page.getByTestId('consent-checkbox').check();
        await page.getByTestId('consent-agree').click();
        await page.getByTestId('sign-phase').waitFor({ timeout: 10000 });
        const sendCodeButton = page.getByRole('button', { name: '寄送驗證碼到我的信箱' });
        await sendCodeButton.waitFor({ timeout: 15000 });
        const stayedOnContract = new URL(page.url()).pathname === '/contract';
        const testModeCount = await page.getByText('測試模式', { exact: false }).count();
        assert('T3a 講師開簽約頁停在 /contract', stayedOnContract, `landed=${new URL(page.url()).pathname}`);
        assert('T3b 同意後的簽署階段出現 Email 驗證（寄送驗證碼按鈕）', await sendCodeButton.isVisible());
        assert('T3c 不再出現「測試模式」字樣', testModeCount === 0, `count=${testModeCount}`);
        assert('T3d 尚未完成 Email 驗證時「確認簽署」不可按，並列出還需要什麼',
            await page.getByTestId('submit-contract').isDisabled()
            && (await page.getByTestId('submit-missing').innerText()).includes('完成 Email 身分驗證'));
        assert('T3n 「確認簽署」正上方有最後確認句（含講師姓名與文件清單、伺服器時間說明）',
            await page.getByTestId('final-confirm').isVisible()
            && (await page.getByTestId('final-confirm').innerText()).includes('我是 簽約重開測試員 本人')
            && (await page.getByTestId('final-confirm').innerText()).includes('伺服器時間（台北時間）'));
        const readAckText = await page.getByTestId('read-ack-checkbox').locator('xpath=ancestor::label').innerText();
        assert('T3o 已閱讀勾選句改為 esign-read-ack-v1，不含「皆可遵守並配合」',
            readAckText.startsWith('我已完整閱讀並了解') && !readAckText.includes('遵守並配合'), readAckText);
        assert('T3p 簽署頁簽名欄標籤是「講師簽名」，不是「甲方簽名」',
            await page.getByRole('heading', { name: '講師簽名' }).count() === 1 && await page.getByText('甲方簽名', { exact: true }).count() === 0);
        await page.screenshot({ path: SIGNING_SCREENSHOT, fullPage: true });

        await page.goto(`${BASE}/contract/view/contract-1`, { waitUntil: 'networkidle', timeout: 20000 });
        const teacherCanViewOwnContract = new URL(page.url()).pathname === '/contract/view/contract-1'
            && await page.getByRole('heading', { name: '合約檢視' }).count() === 1;
        assert('T4 講師可查看自己的合約', teacherCanViewOwnContract, `landed=${new URL(page.url()).pathname}`);
        await page.screenshot({ path: CONTRACT_VIEW_SCREENSHOT, fullPage: true });
        // T16：契約查閱頁列出所有版本（含已作廢），每份可下載
        const versionsText = await page.getByTestId('contract-versions').innerText();
        assert('T16a 契約查閱頁列出有效版與已作廢舊版，作廢版標示作廢時間與原因',
            versionsText.includes('有效') && versionsText.includes('已作廢')
            && versionsText.includes('作廢時間：2026-10-20 14:03（台北時間）') && versionsText.includes('原因：重新簽約'), versionsText.replaceAll('\n', '｜'));
        const voidedDownload = page.waitForEvent('download');
        await page.getByTestId('contract-versions').locator('li').filter({ hasText: '已作廢' }).getByRole('button', { name: '委任契約書' }).click();
        const voidedFile = await voidedDownload;
        assert('T16b 已作廢的舊版也能下載（檔名含文件名稱、簽約人、簽署日期）', voidedFile.suggestedFilename() === '委任契約書_簽約重開測試員_2026-10-01.pdf', voidedFile.suggestedFilename());
        await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByTestId('contract-history').waitFor({ timeout: 10000 });
        const historyText = await page.getByTestId('contract-history').innerText();
        assert('T16c 個人頁簽約區塊列出所有版本，作廢版標示作廢時間與原因，每份有「查看與下載」',
            historyText.includes('有效') && historyText.includes('已作廢（2026-10-20 14:03（台北時間））：重新簽約')
            && await page.getByTestId('contract-history').getByRole('link', { name: '查看與下載' }).count() === 2, historyText.replaceAll('\n', '｜'));
        await page.goto(`${BASE}/contract/view/contract-1`, { waitUntil: 'networkidle', timeout: 20000 });
        teacherSalaryReads = 0;
        await page.goto(`${BASE}/my/salary`, { waitUntil: 'networkidle', timeout: 20000 });
        const compensationRouteWorks = new URL(page.url()).pathname === '/my/salary'
            && await page.getByRole('heading', { name: '我的報酬' }).count() === 1
            && await page.getByRole('link', { name: /報酬／點數確認區/ }).getAttribute('href') === 'https://example.com/compensation'
            && await page.getByRole('link', { name: /登記課程回報/ }).getAttribute('href') === '/my/salary/new';
        assert('T8a 我的報酬顯示站內回報與後台設定的確認連結', compensationRouteWorks, `landed=${new URL(page.url()).pathname}`);
        assert('T8b 我的報酬會讀取自己的站內薪資明細', teacherSalaryReads >= 2, `reads=${teacherSalaryReads}`);
        await page.getByText('仍在使用舊表單？', { exact: true }).click();
        const legacyLinksWork = await page.getByRole('link', { name: /測試直營課程表單舊表單/ }).getAttribute('href') === 'https://example.com/direct-form'
            && await page.getByRole('link', { name: /測試合作單位表單舊表單/ }).getAttribute('href') === 'https://example.com/partner-form';
        assert('T8c 舊表單作為可展開的轉換備援', legacyLinksWork, 'legacy links unavailable');
        await page.goto(`${BASE}/my/salary/new`, { waitUntil: 'networkidle', timeout: 20000 });
        const internalCompensationFormWorks = new URL(page.url()).pathname === '/my/salary/new'
            && await page.getByRole('heading', { name: '登記課程回報' }).count() === 1;
        assert('T8d 站內課程回報頁已恢復', internalCompensationFormWorks, `landed=${new URL(page.url()).pathname}`);
        assert('T5b 講師端不直接寫入 instructor_contracts（簽約只走 RPC）', teacherContractTableWrites.length === 0, teacherContractTableWrites.join(' | ') || 'writes=0');
        assert('T5c 講師瀏覽過程沒有未預期的頁面錯誤', consoleErrors.length === 0, consoleErrors.join(' | ') || 'errors=0');
        await page.close();
        await context.close();

        // T3e：手機版（390px）同意頁、簽署階段與 Email 驗證視窗可用且不橫向溢出
        resetMockState();
        context = await newContext(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await goToConsent(page);
        const consentOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert('T3e 手機版同意頁無水平溢出', consentOverflow <= 0, `overflow=${consentOverflow}`);
        const mobileButtons = await page.evaluate(() => ['consent-agree', 'consent-decline'].map((id) => {
            const box = document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect();
            return { id, width: Math.round(box.width), height: Math.round(box.height) };
        }));
        assert('T3q 手機版「同意」「不同意」按鈕等寬且觸控高度 ≥ 44px',
            mobileButtons[0].width === mobileButtons[1].width && mobileButtons.every((button) => button.height >= 44), JSON.stringify(mobileButtons));
        await page.screenshot({ path: path.join(SHOT_DIR, 'teacher-consent-page-mobile.png'), fullPage: true });
        await page.getByTestId('consent-checkbox').check();
        await page.getByTestId('consent-agree').click();
        await page.getByTestId('sign-phase').waitFor({ timeout: 10000 });
        const signMobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert('T3r 手機版簽署階段（填資料／Email 驗證／最後確認句）無水平溢出', signMobileOverflow <= 0, `overflow=${signMobileOverflow}`);
        await page.getByTestId('send-otp').click();
        await page.locator('#email-otp-code').waitFor({ timeout: 10000 });
        const dialogMetrics = await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"]').getBoundingClientRect();
            const input = document.querySelector('#email-otp-code');
            const verify = [...document.querySelectorAll('[role="dialog"] button')].find((button) => button.textContent.trim() === '驗證');
            const resend = document.querySelector('[data-testid="otp-resend"]');
            return {
                overflow: document.documentElement.scrollWidth - window.innerWidth,
                dialogRight: Math.round(dialog.right), dialogLeft: Math.round(dialog.left),
                inputHeight: Math.round(input.getBoundingClientRect().height),
                inputMode: input.getAttribute('inputmode'), autocomplete: input.getAttribute('autocomplete'),
                verifyHeight: Math.round(verify.getBoundingClientRect().height),
                resendHeight: Math.round(resend.getBoundingClientRect().height),
            };
        });
        assert('T3s 手機版 Email 驗證視窗在畫面內、無水平溢出', dialogMetrics.overflow <= 0 && dialogMetrics.dialogLeft >= 0 && dialogMetrics.dialogRight <= 390, JSON.stringify(dialogMetrics));
        assert('T3t 驗證碼輸入框 inputMode=numeric、autoComplete=one-time-code，輸入框與按鈕觸控高度 ≥ 44px',
            dialogMetrics.inputMode === 'numeric' && dialogMetrics.autocomplete === 'one-time-code'
            && dialogMetrics.inputHeight >= 44 && dialogMetrics.verifyHeight >= 44 && dialogMetrics.resendHeight >= 44, JSON.stringify(dialogMetrics));
        await page.screenshot({ path: SIGNING_MOBILE_SCREENSHOT, fullPage: true });
        await page.close();
        await context.close();

        // ═════ T11：完整簽約流程（電子簽約證據） ═════
        currentRole = 'teacher';
        resetMockState();
        context = await newContext(browser);
        page = await context.newPage();
        const flowErrors = [];
        page.on('pageerror', (error) => flowErrors.push(String(error)));
        await completeSigningInputs(page);

        const consentCall = callsOf('record_contract_consent');
        assert('T11a 同意時呼叫 record_contract_consent：agree_electronic、文案版本 esign-consent-v1、三份文件版本',
            consentCall.length === 1
            && consentCall[0].body.p_decision === 'agree_electronic'
            && consentCall[0].body.p_consent_text_version === 'esign-consent-v1'
            && JSON.stringify(consentCall[0].body.p_doc_versions) === JSON.stringify({ rules: 2, compensation: 1, contract: 3 }),
            JSON.stringify(consentCall[0]?.body));
        const otpRequests = callsOf('request_email_otp');
        const otpVerifies = callsOf('verify_email_otp');
        assert('T11b 簽約驗證碼：用途 contract_sign、只寄一次；驗證時帶 challenge id 與 6 碼',
            otpRequests.length === 1 && otpRequests[0].body.p_purpose === 'contract_sign'
            && otpVerifies.length === 1 && otpVerifies[0].body.p_challenge_id === CHALLENGE_ID && otpVerifies[0].body.p_code === '123456',
            JSON.stringify({ requests: otpRequests.map((call) => call.body), verifies: otpVerifies.map((call) => call.body) }));
        assert('T11c 驗證通過後顯示 15 分鐘內須送出的倒數', (await page.getByTestId('otp-validity').innerText()).includes('15 分鐘內'));
        assert('T11d 驗證、閱讀勾選、簽名都完成後，「確認簽署」可按', await page.getByTestId('submit-contract').isEnabled());
        await page.screenshot({ path: path.join(SHOT_DIR, 'teacher-ready-to-sign.png'), fullPage: true });

        await page.getByTestId('submit-contract').dblclick();
        await page.getByTestId('signing-complete').waitFor({ timeout: 25000 });
        const submitCalls = callsOf('submit_my_contract');
        assert('T11e 連點兩下「確認簽署」只送出一次 submit_my_contract', submitCalls.length === 1, `calls=${submitCalls.length}`);
        const submitBody = submitCalls[0]?.body || {};
        const hex64 = /^[0-9a-f]{64}$/;
        assert('T11f submit_my_contract 帶 p_otp_challenge_id、p_consent_id',
            submitBody.p_otp_challenge_id === CHALLENGE_ID && submitBody.p_consent_id === CONSENT_ID, JSON.stringify({ c: submitBody.p_otp_challenge_id, k: submitBody.p_consent_id }));
        assert('T11g p_document_sha256 涵蓋三份範本（含純閱讀的），每個都是 64 位小寫 hex',
            JSON.stringify(Object.keys(submitBody.p_document_sha256 || {}).sort()) === JSON.stringify(['compensation', 'contract', 'rules'])
            && Object.values(submitBody.p_document_sha256).every((hash) => hex64.test(hash)), JSON.stringify(submitBody.p_document_sha256));
        assert('T11h 範本雜湊＝實際下載到的範本位元組的 SHA-256（不是隨便填的）',
            Object.values(submitBody.p_document_sha256 || {}).every((hash) => hash === sha256(MINIMAL_PDF)), sha256(MINIMAL_PDF));
        const signedPdfUpload = storageUploads.find((upload) => /\/signed\/[^/]+\/contract_\d+\.pdf$/.test(upload.path));
        const uploadedPdf = signedPdfUpload ? extractMultipartFile(signedPdfUpload) : null;
        assert('T11i p_signed_pdf_sha256 是 64 位小寫 hex，且＝實際上傳的已簽署 PDF 位元組的 SHA-256',
            Boolean(uploadedPdf) && hex64.test(submitBody.p_signed_pdf_sha256?.contract || '') && submitBody.p_signed_pdf_sha256.contract === sha256(uploadedPdf),
            `declared=${submitBody.p_signed_pdf_sha256?.contract} uploaded=${uploadedPdf ? sha256(uploadedPdf) : 'none'}`);
        assert('T11j 成品 PDF 路徑與簽名都在 signed/<使用者>/ 底下',
            /^signed\/[^/]+\/contract_\d+\.pdf$/.test(submitBody.p_signed_pdf_paths?.contract || '') && /^signed\//.test(submitBody.p_signature_path || ''), JSON.stringify(submitBody.p_signed_pdf_paths));
        assert('T11k 原有參數仍照送（姓名／身分證／文件版本／UA）',
            submitBody.p_filled_name === '簽約重開測試員' && submitBody.p_filled_id_number === 'A123456789'
            && JSON.stringify(submitBody.p_doc_versions) === JSON.stringify({ rules: 2, compensation: 1, contract: 3 }) && Boolean(submitBody.p_user_agent));
        const completeText = await page.getByTestId('signing-complete').innerText();
        assert('T11l 成功頁顯示伺服器簽署時間（台北時間）', (await page.getByTestId('signed-at').innerText()) === '2026-10-20 14:03:09（台北時間）', await page.getByTestId('signed-at').innerText());
        assert('T11m 成功頁顯示「簽署完成通知已寄到」遮罩信箱', (await page.getByTestId('copy-email-note').innerText()).includes(`簽署完成通知已寄到 ${MASKED_EMAIL}`), await page.getByTestId('copy-email-note').innerText());
        assert('T11n 成功頁有「查看合約」入口', completeText.includes('查看合約'));
        await page.screenshot({ path: path.join(SHOT_DIR, 'teacher-signing-complete.png'), fullPage: true });
        assert('T11o 簽約過程沒有頁面錯誤', flowErrors.length === 0, flowErrors.join(' | ') || 'errors=0');
        await page.close();
        await context.close();

        // ═════ T12：不同意電子簽約 → 紙本 ═════
        resetMockState();
        context = await newContext(browser);
        page = await context.newPage();
        await goToConsent(page);
        await page.getByTestId('consent-decline').click();
        const declineDialog = page.getByTestId('decline-dialog');
        await declineDialog.waitFor();
        const declineText = await declineDialog.innerText();
        assert('T12a 按「不同意」跳出確認視窗：說明權利、四點流程、是同一版文件，沒有任何暗示吃虧的字眼',
            declineText.includes('你可以不使用線上簽約，這是你的權利') && declineText.includes('通知本公司行政人員')
            && declineText.includes('同一個版本：講師管理辦法（第 2 版）')
            && !/較慢|吃虧|影響.*資格/.test(declineText), declineText.slice(0, 120));
        assert('T12b 視窗有「確認改以紙本簽約」「返回」兩顆按鈕；未確認前沒有記錄任何選擇',
            await declineDialog.getByRole('button', { name: '確認改以紙本簽約' }).isVisible()
            && await declineDialog.getByRole('button', { name: '返回' }).isVisible()
            && callsOf('record_contract_consent').length === 0);
        await declineDialog.getByRole('button', { name: '返回' }).click();
        assert('T12c 按「返回」關閉視窗，仍在同意頁且不記錄', await page.getByTestId('decline-dialog').count() === 0
            && await page.getByTestId('consent-page').isVisible() && callsOf('record_contract_consent').length === 0);
        await page.getByTestId('consent-decline').click();
        await page.getByTestId('decline-confirm').click();
        await page.getByTestId('paper-flow').waitFor({ timeout: 10000 });
        const declineCalls = callsOf('record_contract_consent');
        assert('T12d 確認後記錄 decline_electronic（文案版本 esign-decline-paper-v1）',
            declineCalls.length === 1 && declineCalls[0].body.p_decision === 'decline_electronic'
            && declineCalls[0].body.p_consent_text_version === 'esign-decline-paper-v1'
            && JSON.stringify(declineCalls[0].body.p_doc_versions) === JSON.stringify({ rules: 2, compensation: 1, contract: 3 }), JSON.stringify(declineCalls[0]?.body));
        assert('T12e 紙本流程畫面：說明行政人員會聯繫，且不進 OTP／簽名',
            (await page.getByTestId('paper-flow').innerText()).includes('行政人員會主動和你聯繫')
            && await page.getByTestId('send-otp').count() === 0 && await page.getByTestId('open-signature').count() === 0
            && callsOf('request_email_otp').length === 0 && callsOf('submit_my_contract').length === 0);
        await page.screenshot({ path: path.join(SHOT_DIR, 'teacher-paper-flow.png'), fullPage: true });
        await page.close();
        await context.close();

        // ═════ T13：送出錯誤代碼 → 白話訊息與下一步 ═════
        const submitFailureScenarios = [
            {
                id: 'T13a', code: 'DOC_VERSION_MISMATCH', expected: '契約剛更新版本，請重新閱讀後再簽。',
                after: async (p) => (await p.getByTestId('flow-notice').innerText()).includes('契約剛更新版本，請重新閱讀後再簽。') && await p.getByTestId('read-phase').isVisible(),
                label: '文件剛改版 → 回到閱讀、頁面上方說明原因',
            },
            {
                id: 'T13b', code: 'OTP_EXPIRED', expected: 'Email 驗證已逾時',
                after: async (p) => (await p.getByTestId('submit-error').innerText()).includes('Email 驗證已逾時') && await p.getByTestId('send-otp').isVisible() && await p.getByTestId('sign-phase').isVisible(),
                label: 'OTP 逾時 → 留在簽署階段、驗證狀態清除要重新驗證',
            },
            {
                id: 'T13c', code: 'CONSENT_REQUIRED', expected: '電子簽約同意已失效',
                after: async (p) => (await p.getByTestId('flow-notice').innerText()).includes('電子簽約同意已失效') && await p.getByTestId('consent-page').isVisible() && !(await p.getByTestId('consent-checkbox').isChecked()),
                label: '同意逾時 → 回到同意頁並重新勾選',
            },
            {
                id: 'T13d', code: 'OTP_ALREADY_USED', expected: '已經使用過',
                after: async (p) => (await p.getByTestId('submit-error').innerText()).includes('已經使用過') && await p.getByTestId('send-otp').isVisible(),
                label: 'OTP 已用過 → 重新驗證',
            },
            {
                id: 'T13e', code: 'DOC_HASH_MISMATCH', expected: '範本檔案與登錄的內容不一致',
                after: async (p) => (await p.getByTestId('flow-notice').innerText()).includes('範本檔案與登錄的內容不一致'),
                label: '範本雜湊對不上 → 停止並說明',
            },
            {
                id: 'T13f', code: 'ACCOUNT_NOT_ACTIVE', expected: '帳號還沒有啟用',
                after: async (p) => (await p.getByTestId('submit-error').innerText()).includes('帳號還沒有啟用') && await p.getByTestId('sign-phase').isVisible(),
                label: '帳號未啟用 → 說明去個人資料頁啟用',
            },
        ];
        for (const scenario of submitFailureScenarios) {
            resetMockState();
            context = await newContext(browser);
            page = await context.newPage();
            await completeSigningInputs(page);
            rpcHandlers.submit_my_contract = () => ({ __error: scenario.code });
            await page.getByTestId('submit-contract').click();
            await page.waitForFunction(() => document.querySelector('[data-testid="submit-error"], [data-testid="flow-notice"]'), null, { timeout: 25000 });
            let ok = false;
            try { ok = await scenario.after(page); } catch { ok = false; }
            const visibleText = await page.locator('[data-testid="submit-error"], [data-testid="flow-notice"]').first().innerText().catch(() => '');
            assert(`${scenario.id} ${scenario.code}：${scenario.label}`, ok && !visibleText.includes(scenario.code) && await page.getByTestId('signing-complete').count() === 0, visibleText);
            await page.close();
            await context.close();
        }

        // ═════ T14：Email 驗證視窗的各種結果 ═════
        resetMockState();
        context = await newContext(browser);
        page = await context.newPage();
        await agreeAndEnterSignPhase(page);
        const openOtp = async (requestResult) => {
            rpcHandlers.request_email_otp = () => requestResult;
            await page.getByTestId('send-otp').click();
            await page.getByTestId('email-otp-dialog').waitFor();
            await page.waitForFunction(() => !document.querySelector('[role="dialog"] [role="status"]')?.textContent.includes('正在寄送'), null, { timeout: 8000 });
        };
        const closeOtp = async () => {
            await page.getByTestId('email-otp-dialog').getByRole('button', { name: /取消|我知道了/ }).click();
            await page.getByTestId('email-otp-dialog').waitFor({ state: 'detached' });
        };
        const noticeText = async () => (await page.getByTestId('otp-notice').innerText()).trim();

        const blockedCases = [
            ['email_not_configured', '尚未設定寄信功能'],
            ['no_confirmed_email', '尚未確認你的 Email'],
            ['rate_limited', '每小時最多 5 封'],
            ['profile_incomplete', '資料還沒填完整'],
        ];
        for (const [status, expectedText] of blockedCases) {
            await openOtp({ status });
            assert(`T14 寄送結果 ${status}：顯示白話訊息、沒有驗證碼輸入框`,
                (await noticeText()).includes(expectedText) && await page.locator('#email-otp-code').count() === 0, await noticeText());
            await closeOtp();
        }
        await openOtp({ status: 'cooldown', retry_after_seconds: 42 });
        assert('T14 寄送結果 cooldown：顯示剩餘秒數，重新寄送按鈕停用並倒數',
            (await noticeText()).includes('42 秒') && await page.getByTestId('otp-resend').isDisabled()
            && /秒後/.test(await page.getByTestId('otp-resend').innerText()), await noticeText());
        await closeOtp();

        const requestsBefore = callsOf('request_email_otp').length;
        await openOtp(defaultRpcHandlers().request_email_otp());
        assert('T14 每次開啟視窗只寄一封（不會重複呼叫）', callsOf('request_email_otp').length === requestsBefore + 1);
        assert('T14 寄出後顯示遮罩信箱、有效時間倒數、60 秒重寄冷卻',
            (await noticeText()).includes(MASKED_EMAIL)
            && /驗證碼有效時間 [45]:\d\d/.test(await page.getByTestId('otp-expiry').innerText())
            && /重新寄送（\d+ 秒後）/.test(await page.getByTestId('otp-resend').innerText())
            && await page.getByTestId('otp-resend').isDisabled(), await page.getByTestId('otp-expiry').innerText());
        const verifyButton = page.getByTestId('email-otp-dialog').getByRole('button', { name: '驗證', exact: true });
        await page.locator('#email-otp-code').fill('12345');
        assert('T14 少於 6 碼時「驗證」不可按', await verifyButton.isDisabled());
        await page.locator('#email-otp-code').fill('１２ ３４ａｂ５６７');
        assert('T14 輸入只留數字（全形轉半形、去空白與英文）、最多 6 碼', (await page.locator('#email-otp-code').inputValue()) === '123456');

        await closeOtp();
        const verifyScenarios = [
            [{ status: 'invalid', attempts_remaining: 4 }, '還可以再試 4 次', false],
            [{ status: 'expired' }, '驗證碼已過期', true],
            [{ status: 'used' }, '已經用過', true],
            [{ status: 'locked' }, '已鎖定', true],
            [{ status: 'superseded' }, '更新的驗證碼', true],
        ];
        for (const [result, expectedText, dead] of verifyScenarios) {
            await openOtp(defaultRpcHandlers().request_email_otp());
            rpcHandlers.verify_email_otp = () => result;
            await page.locator('#email-otp-code').fill('654321');
            await verifyButton.click();
            await page.getByTestId('otp-notice').filter({ hasText: expectedText }).waitFor({ timeout: 8000 });
            const inputDisabled = await page.locator('#email-otp-code').isDisabled();
            assert(`T14 驗證結果 ${result.status}：顯示「${expectedText}」，${dead ? '這組驗證碼停用、必須重新寄送' : '可繼續輸入'}`,
                inputDisabled === dead && (await page.locator('#email-otp-code').inputValue()) === '', `disabled=${inputDisabled}`);
            await closeOtp();
        }
        await openOtp(defaultRpcHandlers().request_email_otp());
        await page.getByTestId('email-otp-dialog').getByRole('button', { name: '取消' }).click();
        assert('T14 取消關閉視窗後仍是未驗證狀態，可再次寄送', await page.getByTestId('send-otp').isVisible()
            && await page.getByTestId('contract-otp-card').getByText('本人身分已驗證').count() === 0);
        await page.close();
        await context.close();

        currentRole = 'admin';
        context = await newContext(browser);
        page = await context.newPage();
        await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminProfileContractSection = await page.getByText('合約簽署', { exact: true }).count();
        assert('T1c 管理員個人頁同樣顯示簽約區塊', adminProfileContractSection === 1, `count=${adminProfileContractSection}`);

        await page.goto(`${BASE}/contract/view/contract-1`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminCanViewContract = new URL(page.url()).pathname === '/contract/view/contract-1'
            && await page.getByRole('heading', { name: '合約檢視' }).count() === 1;
        assert('T6a 管理員仍可查看已簽合約', adminCanViewContract, `landed=${new URL(page.url()).pathname}`);

        await page.goto(`${BASE}/admin/contracts`, { waitUntil: 'networkidle', timeout: 20000 });
        const adminCanOpenBackoffice = new URL(page.url()).pathname === '/admin/contracts'
            && await page.getByRole('heading', { name: '合約文件管理' }).count() === 1;
        assert('T6b 管理員合約後台仍保留', adminCanOpenBackoffice, `landed=${new URL(page.url()).pathname}`);

        // T6c：上傳新版文件的確認視窗要明講「將通知所有講師」；只攔 confirm 後取消，不真的上傳
        const dialogMessages = [];
        let acceptConfirms = false;
        page.on('dialog', (dialog) => {
            dialogMessages.push(dialog.message());
            if (acceptConfirms && dialog.type() === 'confirm') dialog.accept(); else dialog.dismiss();
        });
        await page.locator('input[type="file"]').first().setInputFiles({
            name: 'contract-v-next.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF,
        });
        await page.waitForTimeout(500);
        assert('T6c 上傳新版文件時確認文案含「將通知所有講師」',
            dialogMessages.length === 1 && dialogMessages[0].includes('將通知所有講師') && !dialogMessages[0].includes('暫停'),
            dialogMessages.join(' | ') || 'no confirm dialog');
        await page.screenshot({ path: ADMIN_CONTRACTS_SCREENSHOT, fullPage: true });

        // ═════ T15：合約後台 — 範本雜湊、簽署證據、完整性與證據鏈驗證 ═════
        resetMockState();
        assert('T15a 範本還沒有雜湊時顯示「尚未登錄雜湊」與「補登雜湊」',
            (await page.getByTestId('doc-hash-contract').innerText()).includes('尚未登錄雜湊')
            && await page.getByTestId('backfill-hash-contract').isVisible());
        await page.getByTestId('backfill-hash-contract').click();
        await page.waitForFunction(() => document.querySelector('[data-testid="backfill-hash-contract"]')?.textContent !== '計算中…', null, { timeout: 10000 });
        const backfillCalls = callsOf('admin_set_document_hash');
        assert('T15b 補登雜湊：呼叫 admin_set_document_hash，雜湊＝該範本檔的 SHA-256（64 位小寫 hex）',
            backfillCalls.length === 1 && backfillCalls[0].body.p_document_id === 'doc-contract' && backfillCalls[0].body.p_sha256 === sha256(MINIMAL_PDF),
            JSON.stringify(backfillCalls[0]?.body));

        acceptConfirms = true;
        contractDocumentInserts = [];
        await page.locator('input[type="file"]').first().setInputFiles({ name: 'rules-v3.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF });
        const insertWaitStart = Date.now();
        while (contractDocumentInserts.length === 0 && Date.now() - insertWaitStart < 8000) await page.waitForTimeout(150);
        acceptConfirms = false;
        assert('T15c 上傳新版範本時，新紀錄帶 content_sha256＝上傳檔案的 SHA-256',
            contractDocumentInserts.length >= 1 && contractDocumentInserts[0].content_sha256 === sha256(MINIMAL_PDF)
            && contractDocumentInserts[0].version === 3 && contractDocumentInserts[0].doc_type === 'rules',
            JSON.stringify(contractDocumentInserts[0]));

        await page.getByTestId(`toggle-evidence-${UID}`).click();
        await page.getByTestId('evidence-panel').waitFor({ timeout: 10000 });
        const versionChips = await page.getByRole('group', { name: '選擇契約版本' }).getByRole('button').allInnerTexts();
        assert('T15m 同一位講師有多份契約（含已作廢）時，證據區可切換版本', versionChips.length === 2 && versionChips[0].startsWith('有效') && versionChips[1].startsWith('已作廢'), versionChips.join(' | '));
        const evidenceText = await page.getByTestId('evidence-panel').innerText();
        assert('T15d 簽署證據：簽署時間（伺服器、台北時間）、綁定 Email、IP、裝置',
            evidenceText.includes('2026-10-20 14:03:09（台北時間）') && evidenceText.includes('contract-reopen@test.local')
            && evidenceText.includes('203.0.113.9') && evidenceText.includes('MockBrowser/1.0'));
        assert('T15e 簽署證據：同意紀錄（選擇、文案版本、時間）與 Email 驗證時間',
            evidenceText.includes('同意使用線上簽約') && evidenceText.includes('esign-consent-v1')
            && evidenceText.includes('2026-10-20 14:00:00（台北時間）') && evidenceText.includes('2026-10-20 14:02:00（台北時間）'));
        assert('T15f 簽署證據：範本與成品的 SHA-256、證據雜湊鏈',
            evidenceText.includes(sha256(MINIMAL_PDF)) && evidenceText.includes(EVIDENCE.previous_evidence_sha256) && evidenceText.includes(EVIDENCE.evidence_sha256));
        assert('T15g 簽署證據：通知信寄送紀錄（種類、狀態、收件人、服務商編號）',
            evidenceText.includes('簽署完成通知') && evidenceText.includes('已送出') && evidenceText.includes('resend-123'));
        await page.screenshot({ path: path.join(SHOT_DIR, 'admin-contract-evidence.png'), fullPage: true });

        await page.getByTestId('verify-files').click();
        await page.getByTestId('integrity-result').waitFor({ timeout: 15000 });
        assert('T15h 驗證檔案完整性（檔案沒被動過）→ 一致',
            (await page.getByTestId('integrity-result').innerText()).includes('檔案完整性：一致'), (await page.getByTestId('integrity-result').innerText()).slice(0, 80));
        tamperedPaths.add(EVIDENCE_PDF_PATH);
        await page.getByTestId('verify-files').click();
        await page.getByTestId('integrity-result').getByText('不一致', { exact: false }).first().waitFor({ timeout: 15000 });
        assert('T15i 簽後檔案被換掉 → 驗證抓得到（不一致）',
            (await page.getByTestId('integrity-result').innerText()).includes('檔案完整性：不一致'), (await page.getByTestId('integrity-result').innerText()).slice(0, 120));
        tamperedPaths.clear();

        await page.getByTestId('verify-chain').click();
        await page.getByTestId('chain-result').waitFor({ timeout: 10000 });
        assert('T15j 驗證證據鏈 → 完整', (await page.getByTestId('chain-result').innerText()).includes('證據鏈：完整（共檢查 3 筆'));
        rpcHandlers.admin_verify_contract_evidence_chain = () => ({ ok: false, checked: 3, first_broken_id: 'evidence-2' });
        await page.getByTestId('verify-chain').click();
        await page.getByTestId('chain-result').getByText('有斷裂').waitFor({ timeout: 10000 });
        assert('T15k 證據被改 → 證據鏈驗證指出第一筆有問題的編號',
            (await page.getByTestId('chain-result').innerText()).includes('第一筆有問題的證據編號 evidence-2'));

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
        assert('T9c 自動填表 PDF 可先預覽', await previewDialog.getByText('簽約重開測試員-廠商匯款申請書.pdf').count() === 1);
        assert('T9d 預覽前重新讀取講師最新資料', latestInstructorReads > readsBeforeInstructorPreview, `reads=${latestInstructorReads - readsBeforeInstructorPreview}`);

        const downloadPromise = page.waitForEvent('download');
        await previewDialog.getByRole('button', { name: '下載 PDF' }).click();
        const download = await downloadPromise;
        assert('T9e 預覽後可下載 PDF', download.suggestedFilename() === '簽約重開測試員-廠商匯款申請書.pdf', `file=${download.suggestedFilename()}`);
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

        resetMockState();
        context = await newContext(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await page.goto(`${BASE}/admin/contracts`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.getByRole('heading', { name: '合約文件管理' }).waitFor();
        await page.getByTestId(`toggle-evidence-mobile-${UID}`).click();
        await page.getByTestId('evidence-panel').waitFor({ timeout: 10000 });
        const evidenceMobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        const evidenceButtonHeights = await page.evaluate(() => ['verify-files', 'verify-chain'].map((id) => Math.round(document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().height)));
        assert('T15l 手機版簽署證據無水平溢出，驗證按鈕觸控高度 ≥ 44px', evidenceMobileOverflow <= 0 && evidenceButtonHeights.every((height) => height >= 44),
            `overflow=${evidenceMobileOverflow} heights=${evidenceButtonHeights}`);
        await page.screenshot({ path: path.join(SHOT_DIR, 'admin-contract-evidence-mobile.png'), fullPage: true });
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
    console.log(`screenshot dir: ${SHOT_DIR}`);
    console.log(`teacher profile screenshot: ${SCREENSHOT}`);
    console.log(`signing screenshot: ${SIGNING_SCREENSHOT}`);
    console.log(`signing mobile screenshot: ${SIGNING_MOBILE_SCREENSHOT}`);
    console.log(`contract view screenshot: ${CONTRACT_VIEW_SCREENSHOT}`);
    console.log(`admin contracts screenshot: ${ADMIN_CONTRACTS_SCREENSHOT}`);
    console.log(`admin screenshot: ${ADMIN_SCREENSHOT}`);
    console.log(`admin mobile screenshot: ${ADMIN_MOBILE_SCREENSHOT}`);
    console.log(`download center screenshot: ${DOWNLOAD_CENTER_SCREENSHOT}`);
    console.log(`download center mobile screenshot: ${DOWNLOAD_CENTER_MOBILE_SCREENSHOT}`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => { console.error(error); process.exit(1); });
