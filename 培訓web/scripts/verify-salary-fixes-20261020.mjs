#!/usr/bin/env node
// 2026-10-20 大檢查抓到的兩個金額 bug，用 mock Supabase 在真瀏覽器（本機 vite dev）實際操作驗證：
//   Bug A（MySalary.jsx）：管理員／輔導員的 RLS 讀得到全部報酬紀錄，「我的報酬」清單沒帶本人條件，
//        會把全體講師最近 1000 筆混進清單、月份統計與待核准橫幅。修法：清單用本人 instructor_id 限定。
//   Bug B（SalaryRegister.jsx 編輯視窗）：按過「重新試算」後再改時數／日期／人數／課程／角色，
//        舊試算沒作廢，儲存時蓋掉新輸入與手動金額。修法：定價輸入或基本報酬一變就作廢試算。
// mock 的 class_sessions 照 PostgREST 網址的 instructor_id=eq.X 真的過濾；沒帶條件就回傳全部
// （模擬管理員的 RLS），並記錄「不帶條件的查詢」次數，斷言必須為 0。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;

const userId = '00000000-0000-4000-8000-000000000081';
const ownInstructorId = '10000000-0000-4000-8000-000000000081';
const otherInstructorId = '10000000-0000-4000-8000-000000000082';
const now = new Date().toISOString();

const baseSession = {
    instructor_role_at_time: 'A', speed_qualification_at_time: null, role_in_session: 'lead',
    paid_amount: 0, bonus: 0, status: 'pending', source: 'self_report', created_at: now,
    is_anomaly: false, anomaly_reasons: [], notes: null, manual_adjustment_reason: null,
};
// 本人（管理員自己也是講師）的 2 筆、別人的 3 筆。別人的刻意有 2 筆待核准＋1 筆退回，
// 這樣 bug 出現時橫幅數字（3 筆待核准、1 筆退回）會和正確值（1 筆待核准、無退回）明顯不同。
const ownSessions = [
    { ...baseSession, id: '30000000-0000-4000-8000-000000000001', instructor_id: ownInstructorId, instructor_name: '管理員本人', course_type: 'speed_onsite', course_name: '本人-校園速解課', session_date: '2026-10-08', month_label: '2026/10', duration_hours: 1.5, student_count: 2, base_salary: null, total_salary: 0, pricing_status: 'needs_review' },
    { ...baseSession, id: '30000000-0000-4000-8000-000000000002', instructor_id: ownInstructorId, instructor_name: '管理員本人', course_type: 'camp', course_name: '本人-週末營隊', session_date: '2026-10-03', month_label: '2026/10', duration_hours: 4, student_count: 12, base_salary: 1200, total_salary: 1200, pricing_status: 'quoted', status: 'approved' },
];
const otherSessions = [
    { ...baseSession, id: '30000000-0000-4000-8000-000000000011', instructor_id: otherInstructorId, instructor_name: '其他老師', course_type: 'camp', course_name: '他人-A校課程', session_date: '2026-10-09', month_label: '2026/10', duration_hours: 2, student_count: 8, base_salary: null, total_salary: 0, pricing_status: 'needs_review' },
    { ...baseSession, id: '30000000-0000-4000-8000-000000000012', instructor_id: otherInstructorId, instructor_name: '其他老師', course_type: 'camp', course_name: '他人-B校課程', session_date: '2026-10-07', month_label: '2026/10', duration_hours: 2, student_count: 8, base_salary: null, total_salary: 0, pricing_status: 'needs_review' },
    { ...baseSession, id: '30000000-0000-4000-8000-000000000013', instructor_id: otherInstructorId, instructor_name: '其他老師', course_type: 'camp', course_name: '他人-C校課程', session_date: '2026-10-05', month_label: '2026/10', duration_hours: 2, student_count: 8, base_salary: null, total_salary: 0, pricing_status: 'rejected', pricing_message: '管理員退回：他人的退回原因' },
];
const ALL_SESSIONS = [...ownSessions, ...otherSessions];

// Bug B 用的編輯對象：原本 2 小時、基本報酬 450、舊級別 B。
// mock 的試算每小時 300，所以「2 小時」試算＝600、「3 小時」試算＝900，都和原本的 450 不同。
const editTarget = {
    ...baseSession, id: '30000000-0000-4000-8000-000000000099', instructor_id: ownInstructorId, instructor_name: '編輯測試老師',
    course_type: 'speed_onsite', course_name: '編輯測試課', session_date: '2026-08-14', month_label: '2026/08',
    duration_hours: 2, student_count: 2, base_salary: 450, total_salary: 450, status: 'approved',
    pricing_status: 'quoted', pricing_basis: 'general_level', pricing_label: '舊級別B', pricing_message: '舊試算',
    updated_at: '2026-10-21T08:00:00.123456+00:00',
};

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'salary-fixes@test.local',
    user_metadata: { full_name: '管理員本人' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const authSession = {
    access_token: 'mock.salary.fixes', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};

// ── 每個情境會改的 mock 狀態
let appRole = 'admin';
let hasInstructorProfile = true;
let failSummary = false;
let failSessions = false;
let editMode = false;               // true：後台報酬登記頁（回傳 editTarget）；false：我的報酬頁
let quoteDelayMs = 0;
let sessionRequests = [];           // /my/salary 送出的 class_sessions GET 清單查詢
let unfilteredSessionQueries = 0;   // 沒帶 instructor_id 條件的清單查詢
let patches = [];
let serverUpdatedAt = editTarget.updated_at;  // mock 資料庫裡這筆目前的 updated_at（B7：模擬別人剛改過）
let quoteCalls = [];

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, data, status = 200, headers = {}) => route.fulfill({
    status,
    headers: {
        'content-type': 'application/json', ...CORS,
        ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}),
        ...headers,
    },
    body: JSON.stringify(data),
});

const summaryRow = () => ({
    instructor_id: ownInstructorId, user_id: userId, full_name: '管理員本人',
    total_sessions: 2, total_hours: 5.5, total_salary: 1200, total_paid: 0, total_unpaid: 1200,
    this_month_sessions: 2, this_month_salary: 1200, this_year_salary: 1200,
    pending_salary: 0, approved_unpaid_salary: 1200, paid_salary: 0,
});

function handleClassSessions(route, request, url) {
    const method = request.method();
    if (method === 'PATCH') {
        patches.push({ search: url.search, body: request.postDataJSON() });
        // 樂觀鎖：帶 updated_at=eq.X 時，只有 X 等於 mock 資料庫目前的值才算更新到 1 列，否則 0 列（同 PostgREST）
        const lock = url.searchParams.get('updated_at');
        const matched = !lock || (lock.startsWith('eq.') ? lock.slice(3) === serverUpdatedAt : lock === 'is.null' && serverUpdatedAt === null);
        const id = (url.searchParams.get('id') || '').replace(/^eq\./, '');
        if (!(request.headers().prefer || '').includes('return=representation')) return route.fulfill({ status: 204, headers: CORS, body: '' });
        return json(route, matched ? [{ id }] : []);
    }
    if (method === 'HEAD') {
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '*/1' }, body: '' });
    }
    if (method !== 'GET') return json(route, { message: 'not allowed in this test' }, 405);
    if (editMode) return json(route, [editTarget], 200, { 'content-range': '0-0/1' });

    sessionRequests.push(url.search);
    if (failSessions) return json(route, { code: '57014', message: 'timeout' }, 500);
    const filter = url.searchParams.get('instructor_id');
    let rows;
    if (filter) {
        if (!filter.startsWith('eq.')) return json(route, { message: `unexpected filter ${filter}` }, 400);
        rows = ALL_SESSIONS.filter(row => row.instructor_id === filter.slice(3));
    } else {
        unfilteredSessionQueries += 1;
        // 沒帶條件：管理員的 RLS 讀得到全部；講師的 RLS 只剩自己的
        rows = appRole === 'teacher' ? ownSessions : ALL_SESSIONS;
    }
    rows = [...rows].sort((a, b) => b.session_date.localeCompare(a.session_date));
    return json(route, rows);
}

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, authSession);
        return json(route, {});
    }
    if (url.pathname === '/rest/v1/rpc/link_my_instructor_by_email') return json(route, ownInstructorId);
    if (url.pathname === '/rest/v1/rpc/quote_salary') {
        const body = request.postDataJSON();
        quoteCalls.push(body);
        if (quoteDelayMs) await new Promise(resolve => setTimeout(resolve, quoteDelayMs));
        return json(route, [{
            matched: true, needs_review: false, is_speed_course: false, message: '已依現行報酬表完成試算',
            instructor_role: 'A', speed_qualification: null, pricing_basis: 'general_level', pricing_label: '試算級別A',
            rate_card_id: '20000000-0000-4000-8000-000000000081', pricing_mode: 'hourly', applied_rate: 300,
            base_salary: 300 * Number(body.p_duration_hours),
        }]);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);
    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        if (table === 'class_sessions') return handleClassSessions(route, request, url);
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
        if (table === 'users') {
            const row = { id: userId, name: '管理員本人', email: authUser.email, role: appRole, created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructors') {
            // 講師要通過「個人資料完整度」關卡才進得了 /my/salary，所以自己的主檔填滿（欄位照 verify-speed-salary-browser.mjs）
            const own = {
                id: ownInstructorId, user_id: userId, full_name: '編輯測試老師', nickname: '編輯測試老師', gender: '男',
                birth_date: '1990-01-01', id_number: 'A123456789', phone_mobile: '0912345678', line_id: 'fixes-test',
                address: '測試通訊地址', household_address: '測試戶籍地址', email_primary: authUser.email,
                instructor_role: 'A', speed_qualification: null, employment_status: 'active',
                teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次', teaching_regions: ['臺北市'],
                bio_notes: '測試講師', bank_account_name: '編輯測試老師', bank_name: '測試銀行', bank_branch: '測試分行',
                bank_account_number: '0000000000', bank_code: '0000000', photo_path: 'test/photo.png',
                id_front_path: 'test/id-front.png', id_back_path: 'test/id-back.png', bankbook_path: 'test/bankbook.png',
                created_at: now,
            };
            const other = { id: otherInstructorId, user_id: null, full_name: '其他老師', instructor_role: 'A', speed_qualification: null };
            const userFilter = url.searchParams.get('user_id');
            const list = userFilter ? [own, other].filter(row => `eq.${row.user_id}` === userFilter) : [own, other];
            return json(route, acceptsObject ? (list[0] ?? null) : list);
        }
        if (table === 'instructor_salary_summary') {
            if (failSummary) return json(route, { code: '57014', message: 'timeout' }, 500);
            const row = hasInstructorProfile ? summaryRow() : null;
            return json(route, acceptsObject ? row : (row ? [row] : []));
        }
        return json(route, acceptsObject ? null : []);
    }
    return json(route, {}, 404);
}

const results = [];
const check = (name, condition, detail = '') => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? `  ← ${detail}` : ''}`);
};

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

const waitUntil = async (condition, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
};

async function newPage(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: authSession });
    await context.route('**/*', handleRoute);
    return { context, page: await context.newPage() };
}

function resetState() {
    appRole = 'admin';
    hasInstructorProfile = true;
    failSummary = false;
    failSessions = false;
    editMode = false;
    quoteDelayMs = 0;
    sessionRequests = [];
    unfilteredSessionQueries = 0;
    patches = [];
    quoteCalls = [];
    serverUpdatedAt = editTarget.updated_at;
}

// ── Bug A：我的報酬
async function openMySalary(browser, { role, profile = true, summaryFails = false, sessionsFail = false }) {
    resetState();
    appRole = role;
    hasInstructorProfile = profile;
    failSummary = summaryFails;
    failSessions = sessionsFail;
    const ctx = await newPage(browser);
    await ctx.page.goto(`${base}/my/salary`, { waitUntil: 'networkidle' });
    await ctx.page.getByRole('heading', { name: '我的報酬' }).waitFor();
    return ctx;
}

// ── Bug B：後台報酬登記的編輯視窗
async function openEditModal(browser) {
    resetState();
    editMode = true;
    const ctx = await newPage(browser);
    await ctx.page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
    await ctx.page.getByRole('heading', { name: '報酬登記中心' }).waitFor();
    await ctx.page.locator(`tr[aria-label="開啟 ${editTarget.instructor_name} ${editTarget.session_date} 報酬紀錄"]`).click();
    const dialog = ctx.page.getByRole('dialog');
    await dialog.getByRole('heading', { name: '審核 / 編輯報酬紀錄' }).waitFor();
    ctx.dialog = dialog;
    return ctx;
}

const field = (dialog, label) => dialog.getByLabel(label, { exact: true });
// 下拉選單被包在 <label> 裡，label 文字會連選項一起算，exact 比對對不上，改用 label 內含的標題文字找
const selectField = (dialog, label) => dialog.locator('label').filter({ has: dialog.page().getByText(label, { exact: true }) }).locator('select');
const quotePanel = (dialog) => dialog.getByText('報酬表試算完成');
const recalcButton = (dialog) => dialog.getByRole('button', { name: /重新依報酬表試算/ });
const saveButton = (dialog) => dialog.getByRole('button', { name: '儲存', exact: true });

async function recalc(dialog) {
    await recalcButton(dialog).click();
    await quotePanel(dialog).waitFor();
}

async function saveAndGetPatch(dialog) {
    const before = patches.length;
    await saveButton(dialog).click();
    const sent = await waitUntil(() => patches.length === before + 1);
    return sent ? patches[patches.length - 1].body : null;
}

async function saveExpectingError(dialog, pattern) {
    const before = patches.length;
    await saveButton(dialog).click();
    const alert = dialog.getByRole('alert');
    await alert.waitFor();
    const text = await alert.innerText();
    await new Promise(resolve => setTimeout(resolve, 300));   // 多等一下，確認真的沒有送出 PATCH
    return { matched: pattern.test(text), text, sent: patches.length - before };
}

let base = '';

async function run() {
    const port = await reservePort();
    base = `http://127.0.0.1:${port}`;
    const viteBin = path.join(appDir, 'node_modules', '.bin', 'vite');
    const vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite dev pid=${vite.pid} port=${port}`);
    let viteLog = '';
    vite.stdout.on('data', chunk => { viteLog += chunk; });
    vite.stderr.on('data', chunk => { viteLog += chunk; });
    let browser;
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* dev server starting */ }
            if (Date.now() > deadline) throw new Error(`vite dev did not start\n${viteLog}`);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});

        // ════════ Bug A：我的報酬只看本人 ════════
        let ctx = await openMySalary(browser, { role: 'admin' });
        let text = await ctx.page.locator('body').innerText();
        check('A1 管理員（有講師主檔）：清單查詢至少送出一次', sessionRequests.length >= 1, `requests=${sessionRequests.length}`);
        check('A1 管理員：每個清單查詢網址都帶 instructor_id=eq.<本人講師id>',
            sessionRequests.length > 0 && sessionRequests.every(search => new URLSearchParams(search).get('instructor_id') === `eq.${ownInstructorId}`),
            sessionRequests.join(' | '));
        check('A1 管理員：沒有任何不帶條件的清單查詢', unfilteredSessionQueries === 0, `unfiltered=${unfilteredSessionQueries}`);
        check('A1 管理員：畫面只顯示本人 2 筆紀錄，不含別人的',
            text.includes('本人-校園速解課') && text.includes('本人-週末營隊') && !text.includes('他人-'));
        check('A1 管理員：待核准橫幅是本人的 1 筆（不是全體的 3 筆），且沒有別人的退回橫幅',
            text.includes('有 1 筆回報正在等待管理員核准') && !text.includes('筆回報被退回') && !text.includes('他人的退回原因'), text.match(/有 \d+ 筆回報[^\n]*/g)?.join(' / '));
        const monthTile = await ctx.page.locator('button', { hasText: '2026/10' }).first().innerText();
        check('A1 管理員：月份統計 2026/10 是本人的 2 場（不是全體 5 場）', /2 場/.test(monthTile), monthTile.replace(/\n/g, ' '));
        await ctx.context.close();

        ctx = await openMySalary(browser, { role: 'admin', profile: false });
        text = await ctx.page.locator('body').innerText();
        check('A2 管理員（沒有講師主檔）：顯示「還沒有報酬紀錄」空狀態', text.includes('還沒有報酬紀錄'));
        check('A2 管理員（沒有講師主檔）：完全沒有送出 class_sessions 清單查詢', sessionRequests.length === 0, `requests=${sessionRequests.join(' | ')}`);
        check('A2 管理員（沒有講師主檔）：畫面沒有任何別人的紀錄', !text.includes('他人-') && !text.includes('本人-'));
        await ctx.context.close();

        ctx = await openMySalary(browser, { role: 'teacher' });
        text = await ctx.page.locator('body').innerText();
        check('A3 講師：清單查詢帶本人 instructor_id 且沒有不帶條件的查詢',
            sessionRequests.length >= 1 && unfilteredSessionQueries === 0
            && sessionRequests.every(search => new URLSearchParams(search).get('instructor_id') === `eq.${ownInstructorId}`),
            sessionRequests.join(' | '));
        check('A3 講師：畫面行為不變（本人 2 筆、1 筆待核准橫幅、彙總卡仍顯示）',
            text.includes('本人-校園速解課') && text.includes('本人-週末營隊') && !text.includes('他人-')
            && text.includes('有 1 筆回報正在等待管理員核准') && text.includes('本月報酬') && text.includes('$1,200'));
        await ctx.context.close();

        ctx = await openMySalary(browser, { role: 'admin', summaryFails: true });
        text = await ctx.page.locator('body').innerText();
        check('A4 彙總查詢失敗：顯示載入失敗訊息且不送清單查詢', text.includes('報酬資料暫時無法載入') && sessionRequests.length === 0);
        await ctx.context.close();

        ctx = await openMySalary(browser, { role: 'admin', sessionsFail: true });
        text = await ctx.page.locator('body').innerText();
        check('A4 清單查詢失敗：顯示載入失敗訊息（不是假裝沒有紀錄）', text.includes('報酬資料暫時無法載入') && !text.includes('還沒有報酬紀錄'));
        await ctx.context.close();

        // ════════ Bug B：編輯視窗的試算作廢 ════════
        // B1 沒改定價輸入：試算結果照常存入（行為不變）
        ctx = await openEditModal(browser);
        let { dialog } = ctx;
        check('B1 開啟編輯視窗：原始基本報酬 450、時數 2', await field(dialog, '基本報酬').inputValue() === '450' && await field(dialog, '時數').inputValue() === '2');
        await recalc(dialog);
        check('B1 重新試算後基本報酬欄帶入試算值 600', await field(dialog, '基本報酬').inputValue() === '600');
        let body = await saveAndGetPatch(dialog);
        check('B1 沒改定價輸入：PATCH 帶試算結果（base_salary 600、pricing_label 試算級別A、quoted、時數 2）',
            body && body.base_salary === 600 && body.pricing_label === '試算級別A' && body.pricing_status === 'quoted' && body.duration_hours === 2,
            JSON.stringify(body));
        await ctx.context.close();

        // B2 試算後改時數：舊試算作廢，不能存；重新試算後才存新金額
        ctx = await openEditModal(browser);
        ({ dialog } = ctx);
        await recalc(dialog);
        await field(dialog, '時數').fill('3');
        check('B2 試算後改時數 2→3：舊試算面板立刻消失', await quotePanel(dialog).count() === 0);
        let attempt = await saveExpectingError(dialog, /請先重新依報酬表試算/);
        check('B2 改時數後直接儲存：要求重新試算，沒有送出 PATCH（舊的 600 不會被存下）', attempt.matched && attempt.sent === 0, `${attempt.text} sent=${attempt.sent}`);
        await recalc(dialog);
        check('B2 改時數後重新試算：基本報酬欄變 900', await field(dialog, '基本報酬').inputValue() === '900');
        body = await saveAndGetPatch(dialog);
        check('B2 重新試算後儲存：PATCH 是 3 小時的 900 與試算依據',
            body && body.base_salary === 900 && body.duration_hours === 3 && body.pricing_label === '試算級別A',
            JSON.stringify(body));
        await ctx.context.close();

        // B3 試算後手動改金額：不能被舊試算蓋掉，也不能標成「依報酬表試算」
        ctx = await openEditModal(browser);
        ({ dialog } = ctx);
        await recalc(dialog);
        await field(dialog, '基本報酬').fill('777');
        check('B3 試算後手動改基本報酬：舊試算面板消失', await quotePanel(dialog).count() === 0);
        attempt = await saveExpectingError(dialog, /勾選人工調整/);
        check('B3 手動改金額沒勾人工調整：要求勾選並填原因，沒有送出 PATCH', attempt.matched && attempt.sent === 0, `${attempt.text} sent=${attempt.sent}`);
        await dialog.getByLabel('人工調整基本報酬').check();
        await dialog.getByLabel('人工調整原因*').fill('依專案書面約定');
        body = await saveAndGetPatch(dialog);
        check('B3 勾人工調整後儲存：PATCH 是手動的 777，標「人工調整」，不是舊試算的 600／試算級別A',
            body && body.base_salary === 777 && body.pricing_status === 'manual_override' && body.pricing_label === '人工調整'
            && body.manual_adjustment_reason === '依專案書面約定',
            JSON.stringify(body));
        await ctx.context.close();

        // B4 其他定價輸入（日期、人數、課程類型、角色）也會作廢試算
        ctx = await openEditModal(browser);
        ({ dialog } = ctx);
        const pricingEdits = [
            ['日期', () => field(dialog, '日期').fill('2026-08-13')],
            ['人數', () => field(dialog, '人數').fill('5')],
            ['課程類型', () => selectField(dialog, '課程類型').selectOption('camp')],
            ['角色', () => selectField(dialog, '角色').selectOption('assistant')],
        ];
        for (const [label, edit] of pricingEdits) {
            await recalc(dialog);
            await edit();
            check(`B4 試算後改「${label}」：舊試算面板消失`, await quotePanel(dialog).count() === 0);
        }
        await ctx.context.close();

        // B5 沒碰定價輸入、只改獎金／備註／課程名稱／已付款金額：試算保留，儲存時照常帶入
        ctx = await openEditModal(browser);
        ({ dialog } = ctx);
        await recalc(dialog);
        await field(dialog, '獎金').fill('50');
        await field(dialog, '已付款金額').fill('100');
        await field(dialog, '課程名稱').fill('改個名字');
        await field(dialog, '備註').fill('備註一下');
        check('B5 只改獎金／已付款／課程名稱／備註：試算面板保留', await quotePanel(dialog).count() === 1);
        body = await saveAndGetPatch(dialog);
        check('B5 儲存：試算結果照常存入（base_salary 600、試算級別A、bonus 50、course_name 已更新）',
            body && body.base_salary === 600 && body.pricing_label === '試算級別A' && body.bonus === 50 && body.course_name === '改個名字',
            JSON.stringify(body));
        await ctx.context.close();

        // B6 試算還在路上時就改了時數：晚到的舊試算要丟掉，不能蓋掉新輸入
        ctx = await openEditModal(browser);
        ({ dialog } = ctx);
        quoteDelayMs = 900;
        await recalcButton(dialog).click();
        await field(dialog, '時數').fill('3');
        await dialog.getByRole('button', { name: /重新依報酬表試算/ }).waitFor();   // 舊試算回來、按鈕恢復
        check('B6 試算送出時用的是 2 小時（舊輸入）', quoteCalls.length === 1 && Number(quoteCalls[0].p_duration_hours) === 2, JSON.stringify(quoteCalls));
        check('B6 晚到的舊試算被丟掉：沒有試算面板、基本報酬欄仍是原本的 450', await quotePanel(dialog).count() === 0 && await field(dialog, '基本報酬').inputValue() === '450');
        attempt = await saveExpectingError(dialog, /請先重新依報酬表試算/);
        check('B6 儲存：要求重新試算，沒有送出 PATCH', attempt.matched && attempt.sent === 0, `${attempt.text} sent=${attempt.sent}`);
        await ctx.context.close();

        // B7 樂觀鎖：開視窗之後這筆被別人改了（例如月結匯款剛把它標成已付款）→ 存檔不能用舊畫面蓋掉
        ctx = await openEditModal(browser);
        ({ dialog } = ctx);
        await field(dialog, '備註').fill('舊畫面上改的備註');
        serverUpdatedAt = '2026-10-22T06:30:00.654321+00:00';
        const beforeStale = patches.length;
        await saveButton(dialog).click();
        const staleAlert = dialog.getByRole('alert');
        await staleAlert.waitFor();
        const staleText = await staleAlert.innerText();
        const stalePatch = patches[beforeStale];
        check('B7 存檔的 PATCH 帶「開視窗時讀到的 updated_at」當條件', Boolean(stalePatch)
            && new URLSearchParams(stalePatch.search).get('updated_at') === `eq.${editTarget.updated_at}`, stalePatch?.search);
        check('B7 被別人改過（0 列被更新）：顯示「這筆紀錄已被其他人修改…這次沒有儲存」，視窗留著不關',
            /這筆紀錄已被其他人修改（例如剛被標記已付款），這次沒有儲存/.test(staleText) && await dialog.isVisible(), staleText);
        serverUpdatedAt = editTarget.updated_at;
        await ctx.context.close();
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }

    const passed = results.filter(Boolean).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    process.exitCode = passed === results.length ? 0 : 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
