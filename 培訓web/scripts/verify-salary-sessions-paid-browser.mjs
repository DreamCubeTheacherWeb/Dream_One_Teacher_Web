#!/usr/bin/env node
// 月結匯款頁「匯款完成，標記為已付款」＋報酬登記中心只剩提示：mock Supabase＋真瀏覽器驗證，斷言寫在程式裡，stdout 就是證據。
// 做法同 verify-payout-bank-export-browser.mjs：本機 vite dev＋本機 Chrome＋localStorage 塞假 session，
// 所有 Supabase 請求都由 page.route 攔截回假資料；白名單外的請求一律回 404 並讓腳本 FAIL，絕不放行到正式站。
// mock 的 mark_salary_sessions_paid／revert_salary_payout_batch 照 migration 20261022140000 的規則改假資料
// （逐筆核對狀態、期別、講師、金額；任一不符整批不改；已領不改小；還原只還原沒被改過的列）。
// 「今天」固定為 2026-10-22（台北）。測試資料全部是假人名、假號碼。
//
// 用法：cd 培訓web && node scripts/verify-salary-sessions-paid-browser.mjs
//       PREVIEW=1：改跑建置產物（先 npm run build，再用 vite preview 開 dist/），驗正式版打包後的行為
// 需要在沙盒外跑（綁本機 port、開 Chrome）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-22-salary-sessions-paid');
mkdirSync(shotDir, { recursive: true });
const shot = (name) => path.join(shotDir, name);
const workDir = mkdtempSync(path.join(tmpdir(), 'd1-sessions-paid-browser-'));

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = '2026-10-22T04:00:00.000Z';
const TODAY = '2026-10-22';
const MIGRATION_TEXT = '需先套用資料庫更新（20261022140000_mark_salary_sessions_paid.sql）才能標記已付款。';

// ───────────────────────── 假資料 ─────────────────────────
const ADMIN_UID = '00000000-0000-4000-8000-0000000000e1';
const I = {
    ding: '10000000-0000-4000-8000-0000000000e1',
    wang: '10000000-0000-4000-8000-0000000000e2',
    lin: '10000000-0000-4000-8000-0000000000e3',   // 解款行 6 碼 → 轉帳檔擋下
    chen: '10000000-0000-4000-8000-0000000000e4',  // 管理員取消勾選
};
const inst = (id, overrides) => ({
    id, user_id: null, instructor_role: 'A', household_address: '測試戶籍地址', address: '測試通訊地址', phone_mobile: '0900000000', ...overrides,
});
const INSTRUCTORS = [
    inst(I.ding, { full_name: '丁測一', bank_code: '0081832', bank_account_number: '00291234567890', bank_account_name: '丁測一', id_number: 'Z100000001', email_primary: 'ding@example.test', partner_no: 'A000001' }),
    inst(I.wang, { full_name: '王測二', bank_code: '0130017', bank_account_number: '01234567890123', bank_account_name: '王測二', id_number: 'Z200000002', email_primary: 'wang@example.test', partner_no: 'A036872' }),
    inst(I.lin, { full_name: '林測三', bank_code: '008183', bank_account_number: '00098765432100', bank_account_name: '林測三', id_number: 'Z100000003', email_primary: 'lin@example.test', partner_no: 'A000003' }),
    inst(I.chen, { full_name: '陳測四', bank_code: '0070937', bank_account_number: '98765432101', bank_account_name: '陳測四', id_number: 'Z200000004', email_primary: 'chen@example.test', partner_no: 'A000004' }),
];
const NAME = Object.fromEntries(INSTRUCTORS.map((row) => [row.id, row.full_name]));
let seq = 0;
const s = (courseName, instructorId, date, status, { base = 0, paid = 0, anomaly = null } = {}) => {
    seq += 1;
    return {
        id: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        instructor_id: instructorId, instructor_name: instructorId ? NAME[instructorId] : '對不到測試',
        session_date: date, course_type: 'regular_basic', course_name: courseName,
        base_salary: base, bonus: 0, total_salary: base, paid_amount: paid, status, pricing_status: 'quoted',
        is_anomaly: Boolean(anomaly), anomaly_reasons: anomaly || [], tick: 0,
    };
};
// 9 月期（8/26～9/25）
const SEED = [
    s('丁-常態課', I.ding, '2026-08-26', 'approved', { base: 1000 }),             // 納入 1000
    s('丁-部分已付', I.ding, '2026-09-10', 'approved', { base: 600, paid: 100 }),  // 納入 500
    s('丁-溢付', I.ding, '2026-09-12', 'approved', { base: 300, paid: 500 }),      // 納入 0（已領超過總額）
    s('丁-重複', I.ding, '2026-09-13', 'approved', { base: 1000, anomaly: ['同講師同日有內容完全相同的紀錄，可能重複登記'] }), // 異常 → 預設排除
    s('王-線上課', I.wang, '2026-09-01', 'approved', { base: 1200 }),             // 納入 1200
    s('王-手動排除', I.wang, '2026-09-05', 'approved', { base: 650 }),            // 管理員手動排除
    s('林-體驗課', I.lin, '2026-09-03', 'approved', { base: 900 }),               // 講師被擋
    s('陳-常態課', I.chen, '2026-09-04', 'approved', { base: 700 }),              // 講師取消勾選
    s('對不到的課', null, '2026-09-06', 'approved', { base: 350 }),               // 對不到講師
    s('丁-待核准', I.ding, '2026-09-15', 'pending', { base: 700 }),
    s('王-已付', I.wang, '2026-09-07', 'paid', { base: 900, paid: 900 }),
    s('丁-十月課', I.ding, '2026-10-05', 'approved', { base: 800 }),              // 10 月期（還沒結束）
];
const byName = (name) => world.sessions.find((row) => row.course_name === name);
const INCLUDED_NAMES = ['丁-常態課', '丁-部分已付', '丁-溢付', '王-線上課'];

const world = { sessions: [], batches: [], items: [], batchSeq: 0, mode: 'ok', rpcDelayMs: 600, register: false };
const resetWorld = ({ mode = 'ok' } = {}) => {
    world.sessions = SEED.map((row) => ({ ...row }));
    world.batches = [];
    world.items = [];
    world.batchSeq = 0;
    world.mode = mode; // ok | missing-table（批次表與函式都不存在）| missing-rpc-only（只有函式不存在）
};
const reqLog = [];
const rpcCalls = [];
const unexpected = [];
const externalBlocked = new Set();

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, data, status = 200, headers = {}) => route.fulfill({
    status, headers: { 'content-type': 'application/json', ...CORS, ...headers }, body: JSON.stringify(data),
});
const project = (row, select) => {
    if (!select || select === '*') return row;
    return Object.fromEntries(select.split(',').map((c) => c.trim()).map((column) => [column, row[column]]));
};
function compileFilters(params, allowed) {
    const tests = [];
    for (const [key, raw] of params.entries()) {
        if (['select', 'order', 'offset', 'limit'].includes(key)) continue;
        if (!allowed.has(key)) throw new Error(`unexpected param ${key}`);
        const dot = raw.indexOf('.');
        const op = raw.slice(0, dot);
        const value = raw.slice(dot + 1);
        if (op === 'eq') tests.push((row) => String(row[key]) === value);
        else if (op === 'gte') tests.push((row) => String(row[key]) >= value);
        else if (op === 'lte') tests.push((row) => String(row[key]) <= value);
        else if (op === 'lt') tests.push((row) => String(row[key]) < value);
        else throw new Error(`unexpected op ${key}=${raw}`);
    }
    return (row) => tests.every((t) => t(row));
}
const sortById = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const cents = (v) => Math.round(Number(v || 0) * 100);
const payable = (row) => Math.max(cents(row.total_salary) - cents(row.paid_amount), 0) / 100;
const fmt = (n) => `$${Number(n).toLocaleString('en-US')}`;

// ── mock 版資料庫函式（規則同 migration 20261022140000）
function mockMark(body) {
    const keys = Object.keys(body).sort().join(',');
    if (keys !== 'p_adjustments,p_expected_total,p_items,p_pay_date,p_period_end,p_period_start,p_transfer_total') return { status: 400, data: { code: 'MOCK', message: `unexpected keys ${keys}` } };
    if (body.p_period_end >= TODAY) return { status: 400, data: { code: '22023', message: '這一期還沒結束' } };
    const total = body.p_items.reduce((sum, item) => sum + cents(item.amount), 0);
    if (total !== cents(body.p_expected_total)) return { status: 400, data: { code: '22023', message: '清單金額合計與確認金額不同' } };
    const mismatches = [];
    for (const item of body.p_items) {
        const row = world.sessions.find((r) => r.id === item.id);
        const base = { id: item.id, instructor_name: row?.instructor_name ?? null, session_date: row?.session_date ?? null };
        if (!row) mismatches.push({ ...base, reason: 'not_found', message: '找不到這筆紀錄（可能已刪除）' });
        else if (row.status !== 'approved') mismatches.push({ ...base, reason: 'status', message: `狀態已不是「已核准」（現在：${row.status === 'paid' ? '已付款' : '待核准'}）` });
        else if (row.session_date < body.p_period_start || row.session_date > body.p_period_end) mismatches.push({ ...base, reason: 'period', message: `日期 ${row.session_date} 不在這一期` });
        else if (!row.instructor_id) mismatches.push({ ...base, reason: 'no_instructor', message: '沒有連到講師主檔' });
        else if (cents(payable(row)) !== cents(item.amount)) mismatches.push({ ...base, reason: 'amount', message: `應付金額已變動（下載時 ${fmt(item.amount)}，現在 ${fmt(payable(row))}）` });
    }
    if (mismatches.length) return { status: 200, data: { ok: false, marked_count: 0, mismatch_count: mismatches.length, mismatches } };
    world.batchSeq += 1;
    const id = world.batchSeq;
    const paidAt = new Date().toISOString();
    world.batches.push({
        id, period_start: body.p_period_start, period_end: body.p_period_end, item_count: body.p_items.length, total_amount: total / 100,
        transfer_total: body.p_transfer_total, pay_date: body.p_pay_date, marked_at: paidAt, marked_by_name: '測試管理員',
        reverted_count: 0, reverted_amount: 0, reverted_at: null, adjustments: body.p_adjustments,
    });
    for (const item of body.p_items) {
        const row = world.sessions.find((r) => r.id === item.id);
        const old = { status: row.status, paid_amount: row.paid_amount, paid_at: row.paid_at ?? null };
        row.status = 'paid';
        row.paid_amount = Math.max(Number(row.paid_amount || 0), Number(row.total_salary));
        row.paid_at = paidAt;
        row.tick += 1;
        world.items.push({ batch_id: id, session_id: row.id, amount: item.amount, old, tick: row.tick, reverted: false });
    }
    return { status: 200, data: { ok: true, batch_id: id, marked_count: body.p_items.length, marked_amount: total / 100, paid_at: paidAt } };
}
function mockRevert({ p_batch_id: batchId }) {
    const batch = world.batches.find((b) => b.id === batchId);
    if (!batch) return { status: 400, data: { code: '22023', message: `找不到批次 #${batchId}。` } };
    const skipped = [];
    let reverted = 0;
    let amount = 0;
    for (const item of world.items.filter((i) => i.batch_id === batchId && !i.reverted)) {
        const row = world.sessions.find((r) => r.id === item.session_id);
        if (!row || row.status !== 'paid' || row.tick !== item.tick) {
            skipped.push({ id: item.session_id, instructor_name: row?.instructor_name ?? null, session_date: row?.session_date ?? null,
                reason: !row ? 'not_found' : row.status !== 'paid' ? 'status' : 'changed',
                message: !row ? '這筆紀錄已不存在' : row.status !== 'paid' ? '已不是已付款' : '標記後被改過（已領金額、付款時間或其他欄位）' });
            continue;
        }
        Object.assign(row, item.old);
        row.tick += 1;
        item.reverted = true;
        reverted += 1;
        amount += cents(item.amount);
    }
    batch.reverted_count += reverted;
    batch.reverted_amount += amount / 100;
    if (reverted) batch.reverted_at = new Date().toISOString();
    return { status: 200, data: { batch_id: batchId, reverted_count: reverted, reverted_amount: amount / 100, skipped_count: skipped.length, skipped, remaining_count: world.items.filter((i) => i.batch_id === batchId && !i.reverted).length } };
}

const authUser = () => ({
    id: ADMIN_UID, aud: 'authenticated', role: 'authenticated', email: 'admin@example.test',
    user_metadata: { full_name: '測試管理員' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
});
const sessionFor = () => ({
    access_token: `mock.${ADMIN_UID}`, refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(new Date('2030-01-01T00:00:00Z').getTime() / 1000), user: authUser(),
});

async function handleSupabase(route, request, url) {
    const method = request.method();
    const params = new URLSearchParams(url.search);
    reqLog.push({ method, path: url.pathname, search: url.search });
    const headers = await request.allHeaders();
    const acceptsObject = (headers.accept || '').includes('vnd.pgrst.object+json');
    const wantsCount = (headers.prefer || '').includes('count=exact');
    const reject = (why) => {
        unexpected.push(`${method} ${url.pathname}${url.search}  (${why})`);
        return json(route, { code: 'MOCK_UNEXPECTED', message: `verify script did not expect: ${why}` }, 404);
    };

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser());
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, sessionFor());
        return json(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.replace('/rest/v1/rpc/', '');
        if (['claim_my_precreated_instructor', 'ensure_my_contract_reminder'].includes(name) && method === 'POST') return json(route, null);
        if (['mark_salary_sessions_paid', 'revert_salary_payout_batch'].includes(name) && method === 'POST') {
            const body = request.postDataJSON();
            rpcCalls.push({ name, body, at: Date.now() });
            await new Promise((r) => setTimeout(r, world.rpcDelayMs));
            if (world.mode !== 'ok') {
                return json(route, { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null }, 404);
            }
            const result = name === 'mark_salary_sessions_paid' ? mockMark(body) : mockRevert(body);
            return json(route, result.data, result.status);
        }
        return reject(`rpc ${name}`);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return reject('not a rest/auth path');
    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];

    if (table === 'users' && method === 'GET') {
        const row = { id: ADMIN_UID, name: '測試管理員', email: 'admin@example.test', role: 'admin', created_at: now };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'salary_payout_schedule' && method === 'GET') {
        const row = { next_payday: '2026-11-10', regular_day: 10 };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'salary_payout_batches' && method === 'GET') {
        if (world.mode === 'missing-table') return json(route, { code: 'PGRST205', message: "Could not find the table 'public.salary_payout_batches' in the schema cache", details: null, hint: null }, 404);
        let rows;
        try { rows = world.batches.filter(compileFilters(params, new Set(['period_start', 'period_end']))); } catch (error) { return reject(error.message); }
        if (params.get('order') !== 'id.desc') return reject(`batches order ${params.get('order')}`);
        rows = [...rows].sort((a, b) => b.id - a.id).slice(0, Number(params.get('limit') || 1000)).map((row) => project(row, params.get('select')));
        return json(route, rows);
    }
    if (table === 'instructors' && method === 'GET') {
        if (params.get('user_id')) return json(route, acceptsObject ? null : []);
        if (world.register) return json(route, INSTRUCTORS.map((row) => ({ id: row.id, full_name: row.full_name, instructor_role: 'A', speed_qualification: null, personnel_type: 'instructor' })));
        const select = params.get('select') || '';
        const offset = Number(params.get('offset') || 0);
        const page = sortById(INSTRUCTORS).slice(offset, offset + 1000).map((row) => project(row, select));
        return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/*` });
    }
    if (table === 'class_sessions') {
        if (!['GET', 'HEAD'].includes(method)) return reject(`class_sessions ${method}`);
        if (world.register) {  // 報酬登記中心：只驗提示，不驗清單 → 一律回空
            if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '*/0' }, body: '' });
            return json(route, [], 200, { 'content-range': '*/0' });
        }
        let rows;
        try { rows = sortById(world.sessions.filter(compileFilters(params, new Set(['status', 'session_date'])))); } catch (error) { return reject(error.message); }
        if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `*/${wantsCount ? rows.length : '*'}` }, body: '' });
        const offset = Number(params.get('offset') || 0);
        const limit = Math.min(params.has('limit') ? Number(params.get('limit')) : Infinity, 1000);
        const page = rows.slice(offset, offset + limit).map((row) => project(row, params.get('select')));
        return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/${wantsCount ? rows.length : '*'}` });
    }
    if (['site_links', 'notifications', 'salary_report_options', 'announcements', 'instructor_uploads'].includes(table) && ['GET', 'HEAD'].includes(method)) {
        if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '*/0' }, body: '' });
        return json(route, acceptsObject ? null : []);
    }
    return reject(`table ${table} ${method}`);
}
async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (url.hostname.includes('supabase')) return handleSupabase(route, request, url);
    externalBlocked.add(url.hostname);
    return route.abort();
}

// ───────────────────────── 工具 ─────────────────────────
const results = [];
const check = (name, condition, detail = '') => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? `  ← ${detail}` : ''}`);
};
const section = (title) => console.log(`\n── ${title}`);
const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});
const pageErrors = [];
async function newContext(browser, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', acceptDownloads: true });
    await context.addInitScript(({ key, value }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: sessionFor() });
    await context.clock.setFixedTime(new Date(`${TODAY}T12:00:00+08:00`));
    await context.route('**/*', handleRoute);
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    return { context, page };
}
const testId = (page, id) => page.getByTestId(id);
const lbl = (page, name) => page.getByLabel(name, { exact: true });
const text = async (locator) => ((await locator.textContent()) || '').trim();
async function waitText(locator, expected, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let last = '';
    while (Date.now() < deadline) {
        last = await text(locator).catch(() => '');
        if (expected instanceof RegExp ? expected.test(last) : last === expected) return last;
        await new Promise((r) => setTimeout(r, 100));
    }
    return last;
}
const markButton = (page) => page.getByRole('button', { name: '匯款完成，標記為已付款', exact: true });
async function openPayout(page, base, { period = '2026/09' } = {}) {
    await page.goto(`${base}/admin/salary/payout`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '月結匯款', exact: true }).waitFor({ timeout: 15000 });
    await lbl(page, '丁測一 納入匯款').waitFor({ timeout: 15000 }).catch(() => {});
    if (period && (await lbl(page, '期別').inputValue()) !== period) {
        await lbl(page, '期別').selectOption(period);
        await lbl(page, '丁測一 納入匯款').waitFor({ timeout: 15000 });
        await page.waitForLoadState('networkidle');
    }
}
async function prepareEdits(page) {
    await lbl(page, '付款帳號').fill('123456789012');
    await lbl(page, '付款分行').fill('0456');
    await page.getByRole('button', { name: '王測二 展開明細' }).click();
    await lbl(page, '2026-09-05 王-手動排除 排除').check();
    await lbl(page, '陳測四 納入匯款').uncheck();
    await lbl(page, '王測二 調整金額').fill('-200');
    await lbl(page, '王測二 調整原因').fill('扣回溢付');
}
async function downloadVia(page, buttonName) {
    const promise = page.waitForEvent('download', { timeout: 10000 });
    await page.getByRole('button', { name: buttonName }).click();
    const download = await promise;
    const target = path.join(workDir, `${Date.now()}-${download.suggestedFilename()}`);
    await download.saveAs(target);
    return { name: download.suggestedFilename(), bytes: readFileSync(target) };
}
const csvRows = (bytes) => bytes.toString('utf8').slice(1).split('\r\n').slice(1, -1).map((line) => line.split(','));

// ───────────────────────── 主流程 ─────────────────────────
async function run() {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const preview = process.env.PREVIEW === '1';
    const viteArgs = [...(preview ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    const vite = spawn(path.join(appDir, 'node_modules', '.bin', 'vite'), viteArgs, { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite ${preview ? 'preview（建置產物 dist/）' : 'dev'} pid=${vite.pid} port=${port}`);
    let viteLog = '';
    vite.stdout.on('data', (chunk) => { viteLog += chunk; });
    vite.stderr.on('data', (chunk) => { viteLog += chunk; });
    let browser;
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
            if (Date.now() > deadline) throw new Error(`vite dev did not start\n${viteLog}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        // 伺服器身分：這個 port 上只有本腳本剛起的 vite，cwd＝本 worktree
        const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1)));
        const unescapeLsof = (value) => {
            const bytes = [];
            for (let i = 0; i < value.length; i += 1) {
                if (value[i] === '\\' && value[i + 1] === 'x' && /^[0-9a-f]{2}$/i.test(value.slice(i + 2, i + 4))) {
                    bytes.push(parseInt(value.slice(i + 2, i + 4), 16));
                    i += 3;
                } else bytes.push(...Buffer.from(value[i], 'utf8'));
            }
            return Buffer.from(bytes).toString('utf8');
        };
        const cwdOf = (pid) => unescapeLsof((spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.startsWith('n')) || '').slice(1));
        const sameDir = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
        const owned = listeners.length > 0 && listeners.every((pid) => pid === vite.pid && sameDir(cwdOf(pid), appDir));
        check(`伺服器身分：port ${port} 只有本腳本起的 vite（pid ${vite.pid}），cwd＝本 worktree`, owned, `listeners=${listeners} cwd=${listeners.map(cwdOf)}`);
        if (!owned) throw new Error('port 上的伺服器不是本 worktree 的，停止驗證');
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});

        // ════════ 1. 主流程：下載 → 標記 → 還原 ════════
        section('1. 桌機 1280：預設期別還沒結束 → 切到 9 月期 → 下載轉帳檔 → 標記 → 還原');
        resetWorld();
        let { context, page } = await newContext(browser);
        await openPayout(page, base, { period: null });
        check('月結匯款頁出現「匯款完成，標記為已付款」區塊', await testId(page, 'payout-mark-paid').isVisible());
        check('預設期別 2026/10 還沒結束：按鈕停用、說明「這一期到 10/25 才結束，結束後才能標記已付款。」',
            (await lbl(page, '期別').inputValue()) === '2026/10' && await markButton(page).isDisabled()
            && (await waitText(testId(page, 'payout-mark-paid-reason'), '這一期到 10/25 才結束，結束後才能標記已付款。')) === '這一期到 10/25 才結束，結束後才能標記已付款。');
        check('橫幅改成指向本頁標記（不再叫人去報酬登記中心標整期）',
            (await text(testId(page, 'payout-first-version-warning'))).includes('請在本頁下方「匯款完成，標記為已付款」標記：只會標記你下載的那份轉帳檔裡的課'));
        await lbl(page, '期別').selectOption('2026/09');
        await lbl(page, '丁測一 納入匯款').waitFor({ timeout: 15000 });
        check('切到 9 月期（已結束）但還沒下載：按鈕停用、說明要先下載轉帳檔',
            await markButton(page).isDisabled() && /^請先下載這一期的轉帳檔（CSV 或 Excel）/.test(await waitText(testId(page, 'payout-mark-paid-reason'), /^請先下載/)));
        check('這一期還沒有標記紀錄', (await waitText(testId(page, 'payout-batches-empty'), '這一期還沒有標記過。')) === '這一期還沒有標記過。');

        await prepareEdits(page);
        const csv = await downloadVia(page, '轉帳檔 CSV');
        const rows = csvRows(csv.bytes);
        const fileTotal = rows.reduce((sum, row) => sum + Number(row[7]), 0);
        check('轉帳檔 CSV：2 人（丁 1500、王 1000）、總額 $2,500；林（解款行 6 碼）、陳（取消勾選）不在檔案裡',
            rows.map((row) => `${row[6]}:${row[7]}`).join() === '丁測一:1500,王測二:1000' && fileTotal === 2500, rows.map((row) => `${row[6]}:${row[7]}`).join());
        check('下載後按鈕可以按，摘要寫明這份檔案（CSV）：2 位講師、4 筆課，課程應付 $2,700',
            await markButton(page).isEnabled() && /^這份轉帳檔（CSV，2026\/10\/22 \d{2}:\d{2} 下載）：2 位講師、4 筆課，課程應付 \$2,700。$/.test(await text(testId(page, 'payout-mark-paid-summary'))),
            await text(testId(page, 'payout-mark-paid-summary')).catch(() => ''));

        await markButton(page).click();
        const confirm = testId(page, 'payout-mark-paid-confirm');
        await confirm.waitFor({ timeout: 5000 });
        check('確認框：2 位講師、4 筆課、課程應付合計 $2,700',
            (await text(testId(page, 'payout-mark-paid-confirm-main'))) === '確定把這份轉帳檔納入的 2 位講師、4 筆課標記為已付款嗎？課程應付合計 $2,700。');
        const transferText = await text(testId(page, 'payout-mark-paid-confirm-transfer'));
        check('確認框的轉帳檔總額＝下載的 CSV 總額 $2,500，並說明人工調整 -$200 不寫進課的已領金額',
            transferText === '轉帳檔總額 $2,500（含人工調整 -$200；人工調整不會寫進任何一堂課的已領金額，只記在這一批的紀錄裡）。' && transferText.includes(`$${fileTotal.toLocaleString('en-US')}`), transferText);
        check('確認框：1 筆應付 $0（已領超過總額）標記後不改小',
            (await text(testId(page, 'payout-mark-paid-confirm-zero'))) === '其中 1 筆本次應付 $0（之前已記錄付清，1 筆已領超過總額），標記後已領金額不會改小。');
        const excludedItems = await testId(page, 'payout-mark-paid-confirm-excluded').locator('li').allTextContents();
        check('確認框列出被排除的 5 筆與原因（異常、手動排除、對不到講師、被擋下的講師、取消勾選的講師）',
            (await text(testId(page, 'payout-mark-paid-confirm-excluded'))).startsWith('這次不會標記（維持已核准，下次匯款會再出現），共 5 筆：')
            && excludedItems.join('|') === ['異常標記預設排除 1 筆（$1,000）', '手動排除的課 1 筆（$650）', '對不到講師 1 筆（$350）',
                '資料不全被擋下的講師 1 位、1 筆（$900）：解款行有誤 1 位', '取消勾選的講師 1 位、1 筆（$700）'].join('|'), excludedItems.join('|'));
        await page.screenshot({ path: shot('desktop-1280-confirm.png'), fullPage: false });
        await confirm.screenshot({ path: shot('desktop-1280-confirm-box.png') });

        rpcCalls.length = 0;
        await page.getByRole('button', { name: '確認標記 4 筆' }).dblclick();
        const okMessage = await waitText(testId(page, 'payout-mark-paid-message'), /^已標記為已付款/);
        const markCalls = rpcCalls.filter((c) => c.name === 'mark_salary_sessions_paid');
        check('連點兩下只送出 1 次 mark_salary_sessions_paid', markCalls.length === 1, `calls=${markCalls.length}`);
        const sent = markCalls[0]?.body || {};
        const expectedIds = INCLUDED_NAMES.map((name) => byName(name).id).sort();
        check('送出的清單＝轉帳檔納入的 4 堂課（被排除、被擋、取消勾選、對不到、別期、待核准的 id 一個都沒有）',
            JSON.stringify((sent.p_items || []).map((item) => item.id).sort()) === JSON.stringify(expectedIds), JSON.stringify(sent.p_items));
        check('每筆金額＝轉帳檔的本次應付（1000／500／0／1200），合計 2700、轉帳檔總額 2500、付款日 2026-10-10、期別 8/26～9/25',
            JSON.stringify(Object.fromEntries((sent.p_items || []).map((item) => [world.sessions.find((r) => r.id === item.id)?.course_name, item.amount])))
                === JSON.stringify({ '丁-常態課': 1000, '丁-部分已付': 500, '丁-溢付': 0, '王-線上課': 1200 })
            && sent.p_expected_total === 2700 && sent.p_transfer_total === 2500 && sent.p_pay_date === '2026-10-10'
            && sent.p_period_start === '2026-08-26' && sent.p_period_end === '2026-09-25', JSON.stringify(sent));
        check('人工調整一起送去記錄（王測二 -200、原因）', JSON.stringify(sent.p_adjustments) === JSON.stringify([{ instructor_id: I.wang, name: '王測二', amount: -200, reason: '扣回溢付' }]), JSON.stringify(sent.p_adjustments));
        check('完成訊息顯示批次編號：「已標記為已付款：批次 #1，4 筆、課程應付 $2,700（期間 8/26～9/25）…」',
            okMessage.startsWith('已標記為已付款：批次 #1，4 筆、課程應付 $2,700（期間 8/26～9/25）。標錯了可以按「還原這一批」。'), okMessage);
        check('mock 資料庫：只有那 4 筆變已付款，溢付那筆已領仍 500；其他已核准的列沒動',
            INCLUDED_NAMES.every((name) => byName(name).status === 'paid') && byName('丁-溢付').paid_amount === 500
            && ['丁-重複', '王-手動排除', '林-體驗課', '陳-常態課', '對不到的課', '丁-十月課'].every((name) => byName(name).status === 'approved'));
        await waitText(testId(page, 'payout-stats-period'), /已付 5 筆/);
        check('頁面重新讀取：本期「已付 5 筆」，標過的課不再出現在匯款名單（王測二展開的明細只剩手動排除那堂）',
            (await text(testId(page, 'payout-stats-period'))).includes('已付 5 筆')
            && (await page.getByText('王-線上課', { exact: true }).count()) === 0 && (await page.getByText('王-手動排除', { exact: true }).count()) === 1);
        const batchRow = testId(page, 'payout-batch-1');
        await batchRow.waitFor({ timeout: 5000 });
        check('標記紀錄列出批次 #1：4 筆、$2,700、有效、有「還原這一批」', /#1.*測試管理員.*4.*\$2,700.*有效.*還原這一批/.test((await text(batchRow)).replace(/\s+/g, '')), await text(batchRow));
        check('標記完成後按鈕回到停用（要再下載才能標）', await markButton(page).isDisabled());
        await page.screenshot({ path: shot('desktop-1280-after-mark.png'), fullPage: false });

        // 標記後有人改了一筆（模擬）→ 還原時這筆不該被還原
        byName('丁-常態課').tick += 1;
        await page.getByRole('button', { name: '還原這一批（#1）' }).click();
        await testId(page, 'payout-revert-confirm').waitFor({ timeout: 5000 });
        check('還原確認框：批次 #1、4 筆會改回標記前的狀態', (await text(testId(page, 'payout-revert-confirm'))).includes('確定還原批次 #1 嗎？這批還沒還原的 4 筆會改回標記前的狀態'));
        await page.getByRole('button', { name: '確認還原批次 #1' }).click();
        const revertMessage = await waitText(testId(page, 'payout-mark-paid-message'), /^批次 #1 已還原/);
        check('還原結果：3 筆、$1,700 還原；被改過的 1 筆列出來沒還原',
            revertMessage.startsWith('批次 #1 已還原 3 筆、$1,700，這些紀錄回到標記前的狀態，下次匯款會再出現。另有 1 筆沒有還原：')
            && revertMessage.includes('丁測一・2026-08-26：標記後被改過（已領金額、付款時間或其他欄位）'), revertMessage);
        check('mock 資料庫：3 筆回到已核准、已領原值（部分已付 100、溢付 500），被改過那筆仍已付款',
            ['丁-部分已付', '丁-溢付', '王-線上課'].every((name) => byName(name).status === 'approved')
            && byName('丁-部分已付').paid_amount === 100 && byName('丁-溢付').paid_amount === 500 && byName('丁-常態課').status === 'paid');
        await waitText(testId(page, 'payout-batch-1'), /已還原 3\/4 筆/);
        check('批次 #1 狀態「已還原 3/4 筆」，仍有還原按鈕', (await text(testId(page, 'payout-batch-1'))).includes('已還原 3/4 筆')
            && (await page.getByRole('button', { name: '還原批次 #1' }).count()) === 1);
        await page.screenshot({ path: shot('desktop-1280-after-revert.png'), fullPage: false });
        await context.close();

        // ════════ 2. 下載後有變動要重新下載；清單和資料庫不符整批不改 ════════
        section('2. 下載後改了調整金額 → 停用；重新下載 Excel → 可按；資料庫已被別人改 → 整批不改');
        resetWorld();
        ({ context, page } = await newContext(browser));
        await openPayout(page, base);
        await prepareEdits(page);
        await downloadVia(page, '轉帳檔 CSV');
        check('下載後可按', await markButton(page).isEnabled());
        await lbl(page, '丁測一 調整金額').fill('100');
        await lbl(page, '丁測一 調整原因').fill('補交通');
        check('下載後改了調整金額：按鈕停用、說明要重新下載',
            await markButton(page).isDisabled() && (await text(testId(page, 'payout-mark-paid-reason'))).startsWith('下載後名單或金額有變動'));
        await downloadVia(page, '完整 Excel（四分頁）');
        check('重新下載（Excel）後又可以按，摘要寫 Excel',
            await markButton(page).isEnabled() && (await text(testId(page, 'payout-mark-paid-summary'))).startsWith('這份轉帳檔（Excel，'));
        // 下載之後，資料庫裡有人先把其中一筆標成已付款
        byName('丁-常態課').status = 'paid';
        await markButton(page).click();
        check('確認框的轉帳檔總額跟著新下載的檔案：$2,600（人工調整合計 -$100）',
            (await text(testId(page, 'payout-mark-paid-confirm-transfer'))).startsWith('轉帳檔總額 $2,600（含人工調整 -$100；'),
            await text(testId(page, 'payout-mark-paid-confirm-transfer')).catch(() => ''));
        rpcCalls.length = 0;
        await page.getByRole('button', { name: '確認標記 4 筆' }).click();
        const mismatch = await waitText(testId(page, 'payout-mark-paid-message'), /^這份清單有/);
        check('資料庫回不符：顯示「這份清單有 1 筆和資料庫目前不符，這次沒有標記任何紀錄」並列出哪一筆、為什麼',
            mismatch.startsWith('這份清單有 1 筆和資料庫目前不符，這次沒有標記任何紀錄。請按上方「重新整理」，確認後重新下載轉帳檔再標記：')
            && mismatch.includes('丁測一・2026-08-26：狀態已不是「已核准」（現在：已付款）')
            && (await testId(page, 'payout-mark-paid-message').getAttribute('role')) === 'alert', mismatch);
        check('整批不改：沒有建批次、其他 3 筆仍是已核准', world.batches.length === 0
            && ['丁-部分已付', '丁-溢付', '王-線上課'].every((name) => byName(name).status === 'approved'));
        await context.close();

        // ════════ 3. 資料庫更新還沒套 ════════
        section('3. 資料庫更新還沒套：批次表不存在 → 提示並停用；函式不存在 → 按下去提示');
        resetWorld({ mode: 'missing-table' });
        ({ context, page } = await newContext(browser));
        await openPayout(page, base);
        await prepareEdits(page);
        await downloadVia(page, '轉帳檔 CSV');
        check(`批次表不存在：說明「${MIGRATION_TEXT}」、按鈕停用`,
            (await waitText(testId(page, 'payout-mark-paid-reason'), MIGRATION_TEXT)) === MIGRATION_TEXT && await markButton(page).isDisabled()
            && (await text(testId(page, 'payout-batches-missing'))) === MIGRATION_TEXT);
        await page.screenshot({ path: shot('desktop-1280-migration-missing.png'), fullPage: false });
        await context.close();
        resetWorld();  // 批次表在，只有函式不存在
        ({ context, page } = await newContext(browser));
        await openPayout(page, base);
        await prepareEdits(page);
        await downloadVia(page, '轉帳檔 CSV');
        world.mode = 'missing-rpc-only';
        await markButton(page).click();
        await page.getByRole('button', { name: '確認標記 4 筆' }).click();
        check('函式不存在（PGRST202）：按下後顯示「需先套用資料庫更新…」，資料沒變',
            (await waitText(testId(page, 'payout-mark-paid-message'), MIGRATION_TEXT)) === MIGRATION_TEXT
            && world.batches.length === 0 && INCLUDED_NAMES.every((name) => byName(name).status === 'approved'));
        await context.close();

        // ════════ 4. 手機 390 ════════
        section('4. 手機 390：確認框不撐破版面');
        resetWorld();
        ({ context, page } = await newContext(browser, { width: 390, height: 844 }));
        await openPayout(page, base);
        await prepareEdits(page);
        await downloadVia(page, '轉帳檔 CSV');
        await markButton(page).scrollIntoViewIfNeeded();
        await markButton(page).click();
        await testId(page, 'payout-mark-paid-confirm').waitFor({ timeout: 5000 });
        await testId(page, 'payout-mark-paid-confirm').scrollIntoViewIfNeeded();
        const [scrollWidth, innerWidth] = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
        const box = await testId(page, 'payout-mark-paid-confirm').boundingBox();
        check('390 寬：頁面沒有橫向捲動、確認框在螢幕寬度內', scrollWidth <= innerWidth && box && box.x >= 0 && box.x + box.width <= innerWidth, `scroll=${scrollWidth} inner=${innerWidth} box=${JSON.stringify(box)}`);
        const confirmBtn = await page.getByRole('button', { name: '確認標記 4 筆' }).boundingBox();
        check('390 寬：確認按鈕高度 ≥ 44px', confirmBtn && confirmBtn.height >= 44, JSON.stringify(confirmBtn));
        await testId(page, 'payout-mark-paid-confirm').screenshot({ path: shot('mobile-390-confirm.png') });
        await context.close();

        // ════════ 5. 報酬登記中心只剩提示 ════════
        section('5. 報酬登記中心：沒有「全部已核准」一鍵標的入口，只剩連到月結匯款頁的提示');
        resetWorld();
        world.register = true;
        ({ context, page } = await newContext(browser));
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor({ timeout: 15000 });
        const hint = testId(page, 'salary-mark-paid-hint');
        await hint.waitFor({ timeout: 10000 });
        check('提示文字：本期匯款完成要到月結匯款頁標記，只標轉帳檔裡的紀錄',
            (await text(hint)).replace(/\s+/g, '') === '本期匯款完成，要標「已付款」？請到月結匯款下載轉帳檔，銀行匯款完成後在同一頁標記：只會標記轉帳檔裡的紀錄，被排除或被擋下的講師不會被標，標錯可以整批還原。', await text(hint));
        check('沒有「本期匯款完成」按鈕、沒有舊的整期標記區塊',
            (await page.getByRole('button', { name: /本期匯款完成|標記為已付款/ }).count()) === 0
            && (await page.locator('section[aria-labelledby="salary-period-paid-title"]').count()) === 0);
        await hint.screenshot({ path: shot('salary-register-hint.png') });
        world.register = false;
        await hint.getByRole('link', { name: '月結匯款' }).click();
        await page.getByRole('heading', { name: '月結匯款', exact: true }).waitFor({ timeout: 15000 });
        check('點提示裡的「月結匯款」會到 /admin/salary/payout', new URL(page.url()).pathname === '/admin/salary/payout', page.url());
        check('整個流程沒有呼叫任何「整期標記」的舊函式', !reqLog.some((r) => r.path.includes('mark_salary_period_paid')));
        await context.close();

        check('全程沒有白名單外的 Supabase 請求', unexpected.length === 0, unexpected.join('\n        '));
        check('全程沒有頁面錯誤（pageerror）', pageErrors.length === 0, pageErrors.join('\n        '));
        console.log(`(外部網域一律擋下：${[...externalBlocked].join(', ') || '無'})`);
    } finally {
        await browser?.close();
        vite.kill('SIGTERM');  // 只停自己起的 vite
        rmSync(workDir, { recursive: true, force: true });
    }
}

try {
    await run();
} catch (error) {
    check('腳本本身執行中斷', false, error.stack || error.message);
}
const pass = results.filter(Boolean).length;
console.log(`\n${'-'.repeat(60)}`);
console.log(`RESULT ${pass}/${results.length}`);
console.log(`截圖：${path.relative(appDir, shotDir)}/`);
if (pass !== results.length) process.exitCode = 1;
