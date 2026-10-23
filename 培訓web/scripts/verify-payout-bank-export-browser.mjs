#!/usr/bin/env node
// 後台「月結匯款」（/admin/salary/payout）：mock Supabase＋真瀏覽器驗證，斷言寫在程式裡，stdout 就是證據。
// 做法同 verify-salary-payday-browser.mjs：本機 vite dev＋本機 Chrome＋localStorage 塞假 session，
// 所有 Supabase 請求都由 page.route 攔截回假資料；白名單外的請求一律回 404 並讓腳本 FAIL，絕不放行到正式站。
// 「今天」固定為 2026-10-22（台北）。測試資料全部是假人名、假號碼。
// 下載的 CSV／xlsx 都攔下來在 node 端解開檢查（xlsx 用 jszip 解開、xmllint 檢查每個 XML、
// 有 qlmanage 時再用 macOS Quick Look（Apple 的 Office 解析器）讀一次）。
//
// 用法：cd 培訓web && node scripts/verify-payout-bank-export-browser.mjs
// 需要在沙盒外跑（綁本機 port、開 Chrome、Quick Look）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const JSZip = require(path.join(appDir, 'node_modules/jszip'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-22-payout-bank-export');
mkdirSync(shotDir, { recursive: true });
const shot = (name) => path.join(shotDir, name);
const workDir = mkdtempSync(path.join(tmpdir(), 'd1-payout-browser-'));

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = '2026-10-22T04:00:00.000Z';

// ───────────────────────── 假資料 ─────────────────────────
const ADMIN_UID = '00000000-0000-4000-8000-0000000000c1';
const MENTOR_UID = '00000000-0000-4000-8000-0000000000c2';
const I = {
    ding: '10000000-0000-4000-8000-0000000000d1',   // 丁 2 畫
    wang: '10000000-0000-4000-8000-0000000000d2',   // 王 4 畫
    jiang: '10000000-0000-4000-8000-0000000000d3',  // 江 6 畫
    lin: '10000000-0000-4000-8000-0000000000d4',    // 林 8 畫（解款行 6 碼 → 阻擋）
    chen: '10000000-0000-4000-8000-0000000000d5',   // 陳 11 畫
    zhou: '10000000-0000-4000-8000-0000000000d6',   // 本期沒有課
};
const baseInstructor = (id, overrides) => ({
    id, user_id: null, instructor_role: 'A', household_address: '測試戶籍地址', address: '測試通訊地址', phone_mobile: '0900000000',
    partner_no: null, ...overrides,
});
const INSTRUCTORS_SEED = [
    baseInstructor(I.ding, { full_name: '丁測一', bank_code: '0081832', bank_account_number: '00291234567890', bank_account_name: '丁測一', id_number: 'Z100000001', email_primary: 'ding@example.test' }),
    baseInstructor(I.wang, { full_name: '王測二', bank_code: '0130017', bank_account_number: '0123-456-789012', bank_account_name: '王測二', id_number: 'Z200000002', email_primary: 'wang@example.test', partner_no: 'A036872' }),
    baseInstructor(I.jiang, { full_name: '江測五', bank_code: '8120345', bank_account_number: '00012345678901', bank_account_name: '江測五', id_number: 'Ｚ１００００００５', email_primary: 'jiang@example.test' }),
    baseInstructor(I.lin, { full_name: '林測三', bank_code: '008183', bank_account_number: '00098765432100', bank_account_name: '林測三', id_number: 'Z100000003', email_primary: 'lin@example.test' }),
    baseInstructor(I.chen, { full_name: '陳測四', bank_code: '0070937', bank_account_number: '98765432101', bank_account_name: '陳測四媽媽', id_number: ' z200000004 ', email_primary: '' }),
    baseInstructor(I.zhou, { full_name: '周測六', bank_code: '0081832', bank_account_number: '00291234567899', bank_account_name: '周測六', id_number: 'Z100000006', email_primary: 'zhou@example.test' }),
];
let seq = 0;
const s = (courseName, instructorId, date, status, { base = 0, bonus = 0, paid = 0, pricing = 'quoted', name, anomaly = null } = {}) => {
    seq += 1;
    return {
        id: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        instructor_id: instructorId, instructor_name: name || INSTRUCTORS_SEED.find((i) => i.id === instructorId)?.full_name || '對不到測試',
        session_date: date, course_type: 'regular_basic', course_name: courseName,
        base_salary: base, bonus, total_salary: base + bonus, paid_amount: paid, status, pricing_status: pricing,
        is_anomaly: Boolean(anomaly), anomaly_reasons: anomaly || [],
    };
};
const SESSIONS = [
    // ── 10 月期（9/26～10/25）已核准：丁 2300、王 1100（部分已付＋待確認）、江 1200、林 900（阻擋）、陳 1000
    s('丁-常態課A', I.ding, '2026-09-26', 'approved', { base: 1200, bonus: 300 }),  // 起點：算
    s('丁-常態課B', I.ding, '2026-10-25', 'approved', { base: 800 }),               // 終點：算
    s('王-線上課', I.wang, '2026-10-03', 'approved', { base: 1000, paid: 400 }),     // 部分已付 → 600
    s('王-待確認課', I.wang, '2026-10-08', 'approved', { base: 500, pricing: 'needs_review' }),
    s('江-營隊', I.jiang, '2026-10-11', 'approved', { base: 1200 }),
    s('江-營隊重複', I.jiang, '2026-10-11', 'approved', { base: 1200, anomaly: ['疑似重複：同講師同日同課程'] }),  // 異常標記 → 預設排除
    s('林-體驗課', I.lin, '2026-10-12', 'approved', { base: 900 }),
    s('陳-常態課', I.chen, '2026-10-02', 'approved', { base: 700 }),
    s('陳-加課', I.chen, '2026-10-20', 'approved', { base: 300 }),
    s('對不到的課', null, '2026-10-15', 'approved', { base: 350, name: '對不到測試' }),
    // ── 不會匯
    s('丁-前期未付', I.ding, '2026-09-25', 'approved', { base: 5000 }),             // 前一期（9 月期）
    s('陳-前期部分付', I.chen, '2026-09-10', 'approved', { base: 1000, paid: 300 }), // 前一期，應付 700
    s('丁-下期課', I.ding, '2026-10-26', 'approved', { base: 4000 }),               // 下一期（11 月期）
    s('丁-待核准', I.ding, '2026-10-10', 'pending', { base: 600 }),
    s('陳-待核准', I.chen, '2026-10-12', 'pending', { base: 450 }),
    s('王-已付', I.wang, '2026-10-01', 'paid', { base: 2000, paid: 2000 }),
    // ── 8 月期（7/26～8/25）1001 筆，每筆 10 元：驗證每頁 1000 筆的分頁有抓滿
    ...Array.from({ length: 1001 }, (_, n) => s(`丁-八月批次${n + 1}`, I.ding, `2026-08-${String(1 + (n % 25)).padStart(2, '0')}`, 'approved', { base: 10 })),
];

const world = { role: 'admin', partnerMissing: false, instructors: [], delayOnceFor: null, delayedServed: false, duplicateApproved: false, countDelta: 0,
    pendingUsers: [], activations: [], activationsMissing: false };
const resetWorld = ({ role = 'admin', partnerMissing = false } = {}) => {
    world.role = role;
    world.partnerMissing = partnerMissing;
    world.delayOnceFor = null;       // 'YYYY-MM-DD'：該期起日的已核准查詢第一次延遲 3 秒（競態測試）
    world.delayedServed = false;
    world.duplicateApproved = false; // 已核准查詢的回應重複塞一列（去重測試）
    world.countDelta = 0;            // 已核准筆數（count=exact）多報幾筆（讀取期間資料變動）
    world.instructors = INSTRUCTORS_SEED.map((row) => ({ ...row }));
    world.pendingUsers = [];         // users.role = 'pending' 的帳號（[{ id, role }]）
    world.activations = [];          // instructor_account_activations（[{ id, user_id, instructor_id, status }]）
    world.activationsMissing = false; // 啟用紀錄表還沒建（電子簽約 migration 未套）
};
const reqLog = [];
const patches = [];
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
const MISSING_SELECT = { code: '42703', message: 'column instructors.partner_no does not exist', details: null, hint: null };
const MISSING_PATCH = { code: 'PGRST204', message: "Could not find the 'partner_no' column of 'instructors' in the schema cache", details: null, hint: null };

const authUser = (uid) => ({
    id: uid, aud: 'authenticated', role: 'authenticated', email: `${world.role}@example.test`,
    user_metadata: { full_name: '測試管理員' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
});
const sessionFor = (uid) => ({
    access_token: `mock.${uid}`, refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(new Date('2030-01-01T00:00:00Z').getTime() / 1000), user: authUser(uid),
});
const currentUid = () => (world.role === 'admin' ? ADMIN_UID : MENTOR_UID);

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
        if (url.pathname === '/auth/v1/user') return json(route, authUser(currentUid()));
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, sessionFor(currentUid()));
        return json(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.replace('/rest/v1/rpc/', '');
        if (['claim_my_precreated_instructor', 'ensure_my_contract_reminder'].includes(name) && method === 'POST') return json(route, null);
        // 下載前會先存匯出紀錄；本腳本模擬「資料庫還沒套 20261022140000」→ 照舊下載（檔名沒有編號）。
        // 存匯出紀錄、標記、還原另由 verify-salary-sessions-paid-browser.mjs 驗
        if (name === 'record_salary_payout_export' && method === 'POST') {
            return json(route, { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null }, 404);
        }
        return reject(`rpc ${name}`);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return reject('not a rest/auth path');
    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];

    // 月結匯款頁讀「role 仍是 pending」的帳號清單（分頁、依 id 排序）；其餘 users 查詢是登入者本人的 profile
    if (table === 'users' && method === 'GET' && params.has('role')) {
        if (params.get('select') !== 'id') return reject(`users select ${params.get('select')}`);
        let rows;
        try { rows = sortById(world.pendingUsers.filter(compileFilters(params, new Set(['role'])))); } catch (error) { return reject(error.message); }
        const offset = Number(params.get('offset') || 0);
        const page = rows.slice(offset, offset + 1000).map((row) => project(row, 'id'));
        return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/*` });
    }
    if (table === 'users' && method === 'GET') {
        const row = { id: currentUid(), name: '測試管理員', email: `${world.role}@example.test`, role: world.role, created_at: now };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'instructor_account_activations' && method === 'GET') {
        if (world.activationsMissing) {
            return json(route, { code: 'PGRST205', message: "Could not find the table 'public.instructor_account_activations' in the schema cache", details: null, hint: null }, 404);
        }
        let rows;
        try { rows = sortById(world.activations.filter(compileFilters(params, new Set(['status'])))); } catch (error) { return reject(error.message); }
        const offset = Number(params.get('offset') || 0);
        const page = rows.slice(offset, offset + 1000).map((row) => project(row, params.get('select')));
        return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/*` });
    }
    if (table === 'salary_payout_schedule' && method === 'GET') {
        const row = { next_payday: '2026-11-10', regular_day: 10 };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'instructors') {
        const select = params.get('select') || '';
        if (method === 'GET') {
            if (params.get('user_id')) return json(route, acceptsObject ? null : []);  // 管理員本人沒有講師主檔
            if (world.partnerMissing && select.split(',').includes('partner_no')) return json(route, MISSING_SELECT, 400);
            let rows;
            try { rows = sortById(world.instructors.filter(compileFilters(params, new Set(['id'])))); } catch (error) { return reject(error.message); }
            const offset = Number(params.get('offset') || 0);
            const limit = Math.min(params.has('limit') ? Number(params.get('limit')) : Infinity, 1000);
            const page = rows.slice(offset, offset + limit).map((row) => project(row, select));
            return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/*` });
        }
        if (method === 'PATCH') {
            const body = request.postDataJSON();
            patches.push({ search: url.search, body });
            if (world.partnerMissing) return json(route, MISSING_PATCH, 400);
            if (Object.keys(body).join() !== 'partner_no') return reject(`instructors PATCH with fields ${Object.keys(body)}`);
            const id = (params.get('id') || '').replace(/^eq\./, '');
            const row = world.instructors.find((r) => r.id === id);
            if (!row || !params.get('id')?.startsWith('eq.')) return reject('instructors PATCH without id=eq');
            if (body.partner_no !== null && !/^[A-Z0-9]{1,20}$/.test(body.partner_no)) {
                return json(route, { code: '23514', message: 'new row for relation "instructors" violates check constraint "instructors_partner_no_format_check"' }, 400);
            }
            row.partner_no = body.partner_no;
            return json(route, [project(row, params.get('select'))]);
        }
        return reject(`instructors ${method}`);
    }
    if (table === 'class_sessions') {
        if (!['GET', 'HEAD'].includes(method)) return reject(`class_sessions ${method}`);
        let rows;
        try { rows = sortById(SESSIONS.filter(compileFilters(params, new Set(['status', 'session_date', 'instructor_id'])))); } catch (error) { return reject(error.message); }
        const approvedInPeriod = params.get('status') === 'eq.approved' && params.getAll('session_date').some((v) => v.startsWith('gte.'));
        if (method === 'HEAD') {
            const total = rows.length + (approvedInPeriod ? world.countDelta : 0);
            return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `*/${wantsCount ? total : '*'}` }, body: '' });
        }
        const offset = Number(params.get('offset') || 0);
        const limit = Math.min(params.has('limit') ? Number(params.get('limit')) : Infinity, 1000);
        let page = rows.slice(offset, offset + limit).map((row) => project(row, params.get('select')));
        if (approvedInPeriod && world.duplicateApproved && page.length) page = [...page, page[0]];
        if (approvedInPeriod && world.delayOnceFor && params.getAll('session_date').includes(`gte.${world.delayOnceFor}`)) {
            world.delayOnceFor = null;
            await new Promise((r) => setTimeout(r, 3000));
            await json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/*` });
            world.delayedServed = true;
            return undefined;
        }
        return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/${wantsCount ? rows.length : '*'}` });
    }
    // 首頁（輔導員被導回 / 時）會讀公告；salary_payout_exports＝頁面下方「匯款完成」區讀這一期的匯出紀錄（本腳本不測標記，回空）
    if (['site_links', 'notifications', 'salary_report_options', 'announcements', 'salary_payout_exports'].includes(table) && ['GET', 'HEAD'].includes(method)) {
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
async function newContext(browser, { viewport, role = 'admin' }) {
    const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', acceptDownloads: true });
    const uid = role === 'admin' ? ADMIN_UID : MENTOR_UID;
    await context.addInitScript(({ key, value }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: sessionFor(uid) });
    await context.clock.setFixedTime(new Date('2026-10-22T12:00:00+08:00'));
    await context.route('**/*', handleRoute);
    return context;
}
async function newPage(context) {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    return page;
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
async function openPayout(page, base) {
    await page.goto(`${base}/admin/salary/payout`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '月結匯款', exact: true }).waitFor({ timeout: 15000 });
    await lbl(page, '丁測一 納入匯款').waitFor({ timeout: 15000 });
}
async function noPageOverflow(page) {
    return page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
}
async function downloadVia(page, buttonName) {
    const promise = page.waitForEvent('download', { timeout: 10000 });
    await page.getByRole('button', { name: buttonName }).click();
    const download = await promise;
    const target = path.join(workDir, `${Date.now()}-${download.suggestedFilename()}`);
    await download.saveAs(target);
    return { name: download.suggestedFilename(), bytes: readFileSync(target), file: target };
}
const parseCsvLines = (buffer) => {
    const textValue = buffer.toString('utf8');
    return { textValue, lines: textValue.slice(1).split('\r\n') };
};
const beforeUnloadPrevented = (page) => page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
});
let downloadCount = 0;

async function readXlsx(bytes) {
    const zip = await JSZip.loadAsync(bytes);
    const read = (name) => zip.file(name)?.async('string');
    const sheetNames = [...(await read('xl/workbook.xml')).matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
    const sheets = [];
    for (let i = 1; i <= sheetNames.length; i += 1) sheets.push(await read(`xl/worksheets/sheet${i}.xml`));
    // 把每個分頁還原成二維陣列：{ t: 's'|'n', v, s }
    const grid = (xml) => {
        const rows = [];
        for (const rowMatch of xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)) {
            const r = Number(rowMatch[1]) - 1;
            rows[r] = [];
            for (const c of rowMatch[2].matchAll(/<c r="([A-Z]+)\d+"(?: t="(\w+)")? s="(\d+)">(.*?)<\/c>/g)) {
                const col = [...c[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
                const inner = c[4];
                rows[r][col] = c[2] === 'inlineStr'
                    ? { t: 's', s: Number(c[3]), v: /<t xml:space="preserve">(.*?)<\/t>/.exec(inner)[1].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"') }
                    : { t: 'n', s: Number(c[3]), v: Number(/<v>(.*?)<\/v>/.exec(inner)[1]) };
            }
        }
        return rows;
    };
    return { zip, sheetNames, sheets, grids: sheets.map(grid) };
}
function xmllintAll(zipBytesFile) {
    const dir = mkdtempSync(path.join(workDir, 'unzip-'));
    const unzip = spawnSync('unzip', ['-q', '-o', zipBytesFile, '-d', dir], { encoding: 'utf8' });
    if (unzip.status !== 0) return { ok: false, detail: unzip.stderr };
    const files = [];
    const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
    walk(dir);
    const bad = files.filter((f) => spawnSync('xmllint', ['--noout', f], { encoding: 'utf8' }).status !== 0);
    return { ok: bad.length === 0 && files.length === 9, detail: `${files.length} parts, bad=${bad.map((f) => path.relative(dir, f))}` };
}
async function quickLook(file) {
    if (spawnSync('which', ['qlmanage']).status !== 0) return null;
    const out = mkdtempSync(path.join(workDir, 'ql-'));
    const proc = spawn('qlmanage', ['-p', '-o', out, file], { stdio: 'ignore' });
    const previewDir = path.join(out, `${path.basename(file)}.qlpreview`);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !existsSync(path.join(previewDir, 'Preview.html'))) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 1000));
    if (proc.exitCode === null) proc.kill('SIGTERM');  // 只殺自己啟動的這個 qlmanage
    if (!existsSync(path.join(previewDir, 'Preview.html'))) return { ok: false };
    const strip = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
    const pages = readdirSync(previewDir).filter((f) => f.endsWith('.html')).map((f) => strip(readFileSync(path.join(previewDir, f), 'utf8')));
    return { ok: true, preview: strip(readFileSync(path.join(previewDir, 'Preview.html'), 'utf8')), pages };
}

// ───────────────────────── 主流程 ─────────────────────────
async function run() {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const viteBin = path.join(appDir, 'node_modules', '.bin', 'vite');
    const vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite dev pid=${vite.pid} port=${port}`);
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
        // 第一步：確認這個 port 上的伺服器是本 worktree 剛起的那一顆（不是並行 session 的）
        const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1)));
        // lsof -F 會把非 ASCII 的位元組寫成 \xe5 這種跳脫，要還原成 UTF-8 才能跟中文路徑比對
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

        // ════════ 1. 桌機 1280：預設值、阻擋與警告、下載與檢查 ════════
        section('1. 桌機 1280（今天 2026-10-22，匯款日設定 2026-11-10／每月 10 號 → 預設 10 月期 9/26～10/25）');
        resetWorld();
        const context = await newContext(browser, { viewport: { width: 1280, height: 900 } });
        let page = await newPage(context);
        page.on('download', () => { downloadCount += 1; });
        await openPayout(page, base);

        const banner = testId(page, 'payout-first-version-warning');
        check('警示橫幅出現且文字正確', (await banner.isVisible()) && (await text(banner)).includes('第一版：格式待財務確認。正式匯款前，請財務先用小額或試算核對。'));
        check('預設期別＝2026/10（下次匯款日 11/10 要匯的那期）', (await lbl(page, '期別').inputValue()) === '2026/10');
        check('預設付款日期＝2026-11-10', (await lbl(page, '付款日期').inputValue()) === '2026-11-10');
        check('預設匯款通知方式 3、手續費負擔方式 2',
            (await lbl(page, '匯款通知方式').inputValue()) === '3' && (await lbl(page, '手續費負擔方式').inputValue()) === '2');
        check('附言預覽＝26/10報酬夢想一號文化教育股份有限公司（21 字）',
            (await text(testId(page, 'payout-memo-preview'))) === '26/10報酬夢想一號文化教育股份有限公司' && (await text(testId(page, 'payout-memo-length'))) === '（21 字）');
        const sessionQueries = reqLog.filter((r) => r.path === '/rest/v1/class_sessions' && r.method === 'GET').map((r) => new URLSearchParams(r.search));
        check('本期查詢條件：status=approved、session_date 介於 2026-09-26～2026-10-25',
            sessionQueries.some((p) => p.get('status') === 'eq.approved' && p.getAll('session_date').join() === 'gte.2026-09-26,lte.2026-10-25'));
        check('另外三個數字：本期待核准 2 筆、已付 1 筆', (await text(testId(page, 'payout-stats-period'))) === '待核准 2 筆・已付 1 筆', await text(testId(page, 'payout-stats-period')));
        check('本期開始前仍未付的已核准：1003 筆・$15,710（8 月 1001 筆＋9/25 的 5000＋9/10 應付 700）',
            (await text(testId(page, 'payout-stats-earlier'))) === '1003 筆・$15,710', await text(testId(page, 'payout-stats-earlier')));
        check('納入 4 人、匯款總額 $5,600（丁 2300＋王 1100＋江 1200＋陳 1000；林被擋）',
            (await text(testId(page, 'payout-included-count'))) === '4' && (await text(testId(page, 'payout-total'))) === '$5,600',
            `${await text(testId(page, 'payout-included-count'))} / ${await text(testId(page, 'payout-total'))}`);
        check('有警告的人數只算沒被擋的人：4 人（丁、王、江、陳都有警告；林被擋另算）', (await page.getByText('有警告 4 人', { exact: true }).count()) === 1);
        const linBox = lbl(page, '林測三 納入匯款');
        check('阻擋的人（林測三：解款行 6 碼）不納入、勾選框停用',
            !(await linBox.isChecked()) && (await linBox.isDisabled()) && (await text(testId(page, `payout-row-${I.lin}`))).includes('解款行需為 7 碼數字（目前 6 碼）'));
        const chenRow = await text(testId(page, `payout-row-${I.chen}`));
        check('警告照樣納入：陳測四標出「戶名與姓名不同」「缺 Email」「需新增夥伴號碼」',
            (await lbl(page, '陳測四 納入匯款').isChecked()) && chenRow.includes('戶名與姓名不同') && chenRow.includes('缺 Email') && chenRow.includes('需新增夥伴號碼'));
        const wangRow = await text(testId(page, `payout-row-${I.wang}`));
        check('王測二標出「含待確認報價 1 筆」「有部分已付 1 筆」，系統金額 $1,100', wangRow.includes('含待確認報價 1 筆') && wangRow.includes('有部分已付 1 筆') && wangRow.includes('$1,100'));
        check('對不到講師的課列出 1 筆、不納入', (await text(testId(page, 'payout-unmatched'))).includes('對不到講師 1 筆'));
        check('本期有已付款的課：黃色警告「本期已有 1 筆標為已付款，請確認不會重複匯款」',
            (await text(testId(page, 'payout-paid-warning'))) === '本期已有 1 筆標為已付款，請確認不會重複匯款');
        check('「本期以前仍未付」附說明：切換到那些課所在的期別即可匯出，或到報酬登記中心處理',
            (await page.getByText('不在本期。切換到那些課所在的期別即可匯出，或到報酬登記中心處理', { exact: true }).count()) === 1);
        check('異常標記的課預設排除，上方顯示「已預設排除 1 筆異常標記的課，確認無誤可勾回」',
            (await text(testId(page, 'payout-anomaly-note'))).startsWith('已預設排除 1 筆異常標記的課，確認無誤可勾回'));
        const jiangRow = await text(testId(page, `payout-row-${I.jiang}`));
        check('江測五：異常課不計入（系統金額 $1,200、筆數 1、排除 1），並標「異常標記課 1 筆已預設排除」',
            jiangRow.includes('$1,200') && jiangRow.includes('排除 1') && jiangRow.includes('異常標記課 1 筆已預設排除'), jiangRow);
        check('江測五身分證是全形字：黃色警告「身分證／居留證格式不常見，請確認」（照樣納入）',
            jiangRow.includes('身分證／居留證格式不常見，請確認') && (await lbl(page, '江測五 納入匯款').isChecked()));
        check('陳測四身分證「 z200000004 」去空白轉大寫後是正常格式，不警告', !chenRow.includes('身分證／居留證格式不常見'));
        check('附言欄提示字改為「留空＝用範本附言」（不像已填的值）', (await lbl(page, '陳測四 附言').getAttribute('placeholder')) === '留空＝用範本附言');
        await lbl(page, '江測五 展開明細').click();
        check('展開後每堂顯示異常原因', (await page.getByText('異常標記（預設排除）：疑似重複：同講師同日同課程').count()) === 1);
        await lbl(page, '2026-10-11 江-營隊重複 排除').uncheck();
        check('勾回異常課：江測五實付 $2,400、總額 $6,800、提示改成「目前已勾回 1 筆」',
            (await text(testId(page, `payout-pay-${I.jiang}`))) === '$2,400' && (await text(testId(page, 'payout-total'))) === '$6,800'
            && (await text(testId(page, 'payout-anomaly-note'))).includes('目前已勾回 1 筆'));
        await lbl(page, '2026-10-11 江-營隊重複 排除').check();
        check('再排除回去：總額回到 $5,600', (await text(testId(page, 'payout-total'))) === '$5,600');
        await lbl(page, '江測五 展開明細').click();
        const firstOrder = await page.locator('[data-testid^="payout-row-"]').evaluateAll((rows) => rows.map((r) => r.querySelector('button')?.textContent.trim()));
        check('畫面依姓名筆畫排序：丁、王、江、林、陳', firstOrder.join() === '丁測一,王測二,江測五,林測三,陳測四', firstOrder.join());
        await page.screenshot({ path: shot('desktop-1280-initial.png'), fullPage: true });

        // 付款帳號／分行空白 → 兩個按鈕都可按，按下才擋
        await page.getByRole('button', { name: '轉帳檔 CSV' }).click();
        const csvErrors1 = await text(testId(page, 'payout-csv-errors'));
        check('付款帳號、分行空白：按 CSV 顯示錯誤、沒有下載', csvErrors1.includes('請填付款帳號（公司帳號）') && csvErrors1.includes('請填付款分行') && downloadCount === 0, csvErrors1);
        await page.getByRole('button', { name: '完整 Excel（四分頁）' }).click();
        check('付款帳號、分行空白：按 Excel 也顯示錯誤、沒有下載', (await text(testId(page, 'payout-xlsx-errors'))).includes('請填付款帳號') && downloadCount === 0);
        await lbl(page, '付款帳號').fill('1234-5678-9012');
        await lbl(page, '付款分行').fill('045');
        await page.getByRole('button', { name: '轉帳檔 CSV' }).click();
        check('付款分行不是 4 碼：擋下', (await text(testId(page, 'payout-csv-errors'))).includes('付款分行需為 4 碼數字') && downloadCount === 0);
        await lbl(page, '付款分行').fill('0456');

        // 調整沒原因 → 擋；填了原因 → 總額更新、可下載
        await lbl(page, '王測二 調整金額').fill('-100');
        check('輸入調整 -100 後，王測二實付 $1,000、總額 $5,500',
            (await text(testId(page, `payout-pay-${I.wang}`))) === '$1,000' && (await text(testId(page, 'payout-total'))) === '$5,500');
        await page.getByRole('button', { name: '轉帳檔 CSV' }).click();
        check('調整沒填原因：按下載出錯「王測二：有調整金額但沒填原因」、沒有下載',
            (await text(testId(page, 'payout-csv-errors'))).includes('王測二：有調整金額但沒填原因') && downloadCount === 0);
        await page.screenshot({ path: shot('desktop-1280-errors.png'), fullPage: false });
        await lbl(page, '王測二 調整原因').fill('教材費扣回');
        await lbl(page, '陳測四 附言').fill('26/10報酬補登');
        check('填了原因後總額 $5,500、錯誤可排除', (await text(testId(page, 'payout-total'))) === '$5,500');

        const csv1 = await downloadVia(page, '轉帳檔 CSV');
        const { textValue: csvText1, lines: csvLines1 } = parseCsvLines(csv1.bytes);
        check('CSV 檔名＝202610夢想講師轉帳檔_20261110.csv', csv1.name === '202610夢想講師轉帳檔_20261110.csv', csv1.name);
        check('CSV 開頭是 UTF-8 BOM（EF BB BF）', csv1.bytes[0] === 0xEF && csv1.bytes[1] === 0xBB && csv1.bytes[2] === 0xBF);
        check('CSV 只用 CRLF 換行、結尾有 CRLF', !/[^\r]\n/.test(csvText1) && csvText1.endsWith('\r\n'));
        check('CSV 表頭 14 欄', csvLines1[0] === '序號,付款日期,付款帳號,付款分行,解款行,收款人帳號,收款人戶名,付款金額,收款人ID,匯款通知方式,匯款通知資訊,付款相關附言,手續費負擔方式,夥伴號碼', csvLines1[0]);
        const csvRows1 = csvLines1.slice(1, -1).map((line) => line.split(','));
        check('CSV 4 列資料（林測三被擋、對不到的課不在裡面）、沒有總額列', csvRows1.length === 4 && csvLines1.at(-1) === '' && !csvText1.includes('林測三') && !csvText1.includes('5500'), `rows=${csvRows1.length}`);
        check('CSV 每列都是 14 欄', csvRows1.every((r) => r.length === 14));
        check('CSV 第 1 列（丁測一）：日期 20261110、付款帳號 123456789012、分行 0456、解款行 0081832、帳號 00291234567890（前導 0 保留）',
            csvRows1[0].slice(0, 7).join() === '1,20261110,123456789012,0456,0081832,00291234567890,丁測一', csvRows1[0].join());
        check('CSV 金額：丁 2300、王 1000（含 -100 調整）、江 1200、陳 1000；不加千分位',
            csvRows1.map((r) => `${r[6]}:${r[7]}`).join() === '丁測一:2300,王測二:1000,江測五:1200,陳測四媽媽:1000', csvRows1.map((r) => `${r[6]}:${r[7]}`).join());
        check('CSV 王測二帳號去掉連字號：0123456789012；身分證、通知方式 3、手續費 2',
            csvRows1[1][5] === '0123456789012' && csvRows1[1][8] === 'Z200000002' && csvRows1[1][9] === '3' && csvRows1[1][12] === '2');
        check('CSV 附言：預設 26/10報酬夢想一號文化教育股份有限公司、陳測四覆寫為 26/10報酬補登',
            csvRows1[0][11] === '26/10報酬夢想一號文化教育股份有限公司' && csvRows1[3][11] === '26/10報酬補登');
        check('CSV 夥伴號碼：丁 需新增1、王 A036872、江 需新增2、陳 需新增3', csvRows1.map((r) => r[13]).join() === '需新增1,A036872,需新增2,需新增3', csvRows1.map((r) => r[13]).join());
        check('CSV 陳測四匯款通知資訊空白（缺 Email）', csvRows1[3][10] === '');
        check('CSV 收款人ID 去前後空白轉大寫：陳測四 Z200000004', csvRows1[3][8] === 'Z200000004', csvRows1[3][8]);
        check('下載後頁面顯示「已下載轉帳檔 CSV：4 人，共 $5,500」', (await text(testId(page, 'payout-download-message'))) === '已下載轉帳檔 CSV：4 人，共 $5,500');
        check('剛匯出、沒有新改動：離開頁面不提醒', (await beforeUnloadPrevented(page)) === false);

        const xlsx1 = await downloadVia(page, '完整 Excel（四分頁）');
        check('Excel 檔名＝202610夢想講師轉帳檔_20261110.xlsx', xlsx1.name === '202610夢想講師轉帳檔_20261110.xlsx', xlsx1.name);
        const book1 = await readXlsx(xlsx1.bytes);
        check('Excel 分頁名稱：轉帳檔案、薪資明細、薪資總計、供應商', book1.sheetNames.join() === '轉帳檔案,薪資明細,薪資總計,供應商', book1.sheetNames.join());
        const [transfer1, detail1, summary1, vendor1] = book1.grids;
        const cell = (grid, r, c) => grid[r]?.[c];
        const isText = (x, v) => x && x.t === 's' && x.s === 1 && x.v === v;
        check('轉帳檔案：解款行 0081832、帳號 00291234567890、分行 0456、付款日期 20261110、身分證是文字儲存格（格式 @）',
            isText(cell(transfer1, 1, 4), '0081832') && isText(cell(transfer1, 1, 5), '00291234567890') && isText(cell(transfer1, 1, 3), '0456')
            && isText(cell(transfer1, 1, 1), '20261110') && isText(cell(transfer1, 1, 8), 'Z100000001'), JSON.stringify(transfer1[1]));
        check('轉帳檔案：夥伴號碼 A036872 是文字、金額 2300 是數字', isText(cell(transfer1, 2, 13), 'A036872') && cell(transfer1, 1, 7)?.t === 'n' && cell(transfer1, 1, 7)?.v === 2300);
        check('轉帳檔案：表頭＋4 列、沒有總額列', transfer1.filter(Boolean).length === 5);
        const detailRows1 = detail1.filter(Boolean);
        const adjRow = detailRows1.find((r) => r[2]?.v === '手動調整');
        check('薪資明細：人工調整多一列「手動調整」，課程名稱＝教材費扣回、薪資 -100', adjRow && adjRow[1].v === '王測二' && adjRow[4].v === '教材費扣回' && adjRow[6].v === -100);
        const detailTotal1 = detailRows1.at(-1);
        check('薪資明細：合計（行政＋薪資＋獎金）＝轉帳總額 5500', detailTotal1[0].v === '合計' && (detailTotal1[5].v + detailTotal1[6].v + detailTotal1[7].v) === 5500, JSON.stringify(detailTotal1));
        check('薪資明細：課程日期文字 2026/9/26', detailRows1.some((r) => r[3]?.v === '2026/9/26' && r[3].t === 's'));
        const summaryRows1 = summary1.filter(Boolean);
        const grand1 = summaryRows1.find((r) => r[0]?.v === '總合計');
        check('薪資總計：總合計實收 5500、二代健保 0、成本中心都沒選 → 未填', grand1 && grand1[8].v === 5500 && grand1[7].v === 0 && summaryRows1.filter((r) => r[2]?.v === '未填').length === 4);
        check('供應商分頁：空白列＋表頭＋4 人，夥伴號碼王測二 A036872、銀行代號 0081832 是文字',
            vendor1.filter(Boolean).length === 5 && vendor1[1]?.[1]?.v === '夥伴號碼' && vendor1.some((r) => r?.[1]?.v === 'A036872') && vendor1.some((r) => isText(r?.[11], '0081832')));
        const lint1 = xmllintAll(xlsx1.file);
        check('xlsx 的 9 個 XML 部件全部通過 xmllint（格式正確）', lint1.ok, lint1.detail);
        const ql = await quickLook(xlsx1.file);
        if (ql === null) console.log('SKIP  macOS Quick Look 不可用（沒有 qlmanage）');
        else {
            check('macOS Quick Look（Apple Office 解析器）讀得出 4 個分頁名稱',
                ql.ok && ['轉帳檔案', '薪資明細', '薪資總計', '供應商'].every((n) => ql.preview.includes(`|${n}|`)), ql.ok ? ql.preview.slice(0, 200) : 'no preview');
            check('macOS Quick Look 顯示的轉帳分頁保留 0081832、00291234567890、0456',
                ql.ok && ql.pages.some((p) => p.includes('|0081832|') && p.includes('|00291234567890|') && p.includes('|0456|')));
        }

        // 排除某人／某一課 → 總額與檔案跟著變
        await lbl(page, '江測五 納入匯款').uncheck();
        check('取消勾選江測五：納入 3 人、總額 $4,300', (await text(testId(page, 'payout-included-count'))) === '3' && (await text(testId(page, 'payout-total'))) === '$4,300');
        await lbl(page, '陳測四 展開明細').click();
        await lbl(page, '2026-10-20 陳-加課 排除').check();
        check('排除陳測四的「陳-加課」（300）：陳實付 $700、總額 $4,000',
            (await text(testId(page, `payout-pay-${I.chen}`))) === '$700' && (await text(testId(page, 'payout-total'))) === '$4,000');
        check('有排除尚未匯出：離開頁面會提醒（beforeunload 被攔）', (await beforeUnloadPrevented(page)) === true);

        // 成本中心
        await lbl(page, '丁測一 展開明細').click();
        await lbl(page, '2026-09-26 丁-常態課A 成本中心').selectOption('90181');
        await lbl(page, '王測二 展開明細').click();
        await lbl(page, '王測二 全部成本中心').selectOption('90183');
        check('「這位全部設為 90183」：王測二兩堂課都變 90183',
            (await lbl(page, '2026-10-03 王-線上課 成本中心').inputValue()) === '90183' && (await lbl(page, '2026-10-08 王-待確認課 成本中心').inputValue()) === '90183');
        check('成本中心預設空白（丁-常態課B 沒選）', (await lbl(page, '2026-10-25 丁-常態課B 成本中心').inputValue()) === '');
        await page.screenshot({ path: shot('desktop-1280-expanded.png'), fullPage: true });

        const csv2 = await downloadVia(page, '轉帳檔 CSV');
        const csvRows2 = parseCsvLines(csv2.bytes).lines.slice(1, -1).map((line) => line.split(','));
        check('排除後 CSV：3 列（丁 2300、王 1000、陳 700），沒有江測五',
            csvRows2.map((r) => `${r[6]}:${r[7]}`).join() === '丁測一:2300,王測二:1000,陳測四媽媽:700', csvRows2.map((r) => `${r[6]}:${r[7]}`).join());
        check('排除後「需新增N」重新編號：丁 需新增1、陳 需新增2', csvRows2[0][13] === '需新增1' && csvRows2[2][13] === '需新增2' && csvRows2[1][0] === '2' && csvRows2[2][0] === '3');
        const xlsx2 = await downloadVia(page, '完整 Excel（四分頁）');
        const book2 = await readXlsx(xlsx2.bytes);
        const detail2 = book2.grids[1].filter(Boolean);
        const findDetail = (course) => detail2.find((r) => r[4]?.v === course);
        check('成本中心出現在明細：丁-常態課A＝90181、丁-常態課B 空白、王兩堂＋調整列＝90183',
            findDetail('丁-常態課A')?.[0]?.v === '90181' && findDetail('丁-常態課B')?.[0] === undefined
            && findDetail('王-線上課')?.[0]?.v === '90183' && findDetail('王-待確認課')?.[0]?.v === '90183' && findDetail('教材費扣回')?.[0]?.v === '90183');
        check('明細不含被排除的課（陳-加課、江-營隊）與預設排除的異常課', !findDetail('陳-加課') && !findDetail('江-營隊') && !findDetail('江-營隊重複'));
        check('明細合計＝轉帳總額 4000', (() => { const t = detail2.at(-1); return t[0].v === '合計' && t[5].v + t[6].v + t[7].v === 4000; })());
        const summary2 = book2.grids[2].filter(Boolean);
        const dingRows = summary2.filter((r) => r[0]?.v === '丁測一');
        check('薪資總計：丁測一兩列（90181 應付 1500、未填 800），實收 2300 只填第一列',
            dingRows.length === 2 && dingRows[0][2].v === '90181' && dingRows[0][6].v === 1500 && dingRows[0][8].v === 2300
            && dingRows[1][2].v === '未填' && dingRows[1][6].v === 800 && dingRows[1][8] === undefined, JSON.stringify(dingRows));
        const centerStart = summary2.findIndex((r) => r[0]?.v === '成本中心合計');
        const centers = summary2.slice(centerStart + 2).map((r) => `${r[0].v}:${r[4].v}`).join();
        check('成本中心合計：90181 1500、90183 1000、未填 1500、合計 4000', centers === '90181:1500,90183:1000,未填:1500,合計:4000', centers);
        check('匯出後又變乾淨：不再提醒', (await beforeUnloadPrevented(page)) === false);

        // 夥伴號碼匯入
        section('1b. 夥伴號碼匯入（mock CSV）');
        const importCsv = [
            ',,,,',
            '＊群組Z004/Z007個人/Z008公司,夥伴號碼,＊名稱 1,國籍,TW2 身份證字號',
            'Z007,A100001,丁測一,TW,Z100000001',
            'Z007,A036872,王測二,TW,Z200000002',
            'Z007,A555555,不存在,TW,Z999999999',
            'Z007,需新增1,江測五,TW,Z100000005',
            'Z007,B000001,衝突甲,TW,Z188888881',
            'Z007,B000001,衝突乙,TW,Z188888882',
        ].join('\r\n');
        const importFile = path.join(workDir, '供應商測試.csv');
        writeFileSync(importFile, `${String.fromCharCode(0xFEFF)}${importCsv}\r\n`);
        await lbl(page, '上傳夥伴號碼 CSV').setInputFiles(importFile);
        const counts = await waitText(testId(page, 'payout-import-counts'), /符合/);
        check('預覽：符合 2（會變更 1、不變 1）・對不到 1・衝突 2・格式不符 0・略過 1', counts === '符合 2（會變更 1、不變 1）・對不到 1・衝突 2・格式不符 0・略過 1', counts);
        check('預覽表：會變更 1 列、不變 1 列、對不到 1 列、衝突 2 列',
            (await testId(page, 'payout-import-change').count()) === 1 && (await testId(page, 'payout-import-same').count()) === 1
            && (await testId(page, 'payout-import-unmatched').count()) === 1 && (await testId(page, 'payout-import-conflict').count()) === 2);
        check('預覽沒有寫入任何資料', patches.length === 0);
        await testId(page, 'payout-import-counts').scrollIntoViewIfNeeded();
        await page.screenshot({ path: shot('desktop-1280-import-preview.png'), fullPage: false });
        await page.getByRole('button', { name: '確認更新 1 位講師的夥伴號碼' }).click();
        const importResult = await waitText(testId(page, 'payout-import-result'), /已更新/);
        check('確認後只更新「會變更」的 1 列：PATCH instructors?id=eq.丁測一 {partner_no: A100001}',
            importResult.startsWith('已更新 1 位') && patches.length === 1 && patches[0].body.partner_no === 'A100001' && patches[0].search.includes(`id=eq.${I.ding}`), JSON.stringify(patches));
        await page.waitForTimeout(300);
        const dingLabel = await text(testId(page, `payout-row-${I.ding}`));
        check('重新讀取後丁測一的夥伴號碼顯示 A100001（不再是需新增）', dingLabel.includes('A100001') && !dingLabel.includes('需新增夥伴號碼'));

        // 單筆編輯
        await lbl(page, '陳測四 夥伴號碼').fill('b200002');
        await page.getByRole('button', { name: '陳測四 儲存夥伴號碼' }).click();
        await page.waitForTimeout(300);
        const chenPatch = patches.at(-1);
        check('單筆編輯：小寫 b200002 轉成 B200002 後寫入陳測四', patches.length === 2 && chenPatch.body.partner_no === 'B200002' && chenPatch.search.includes(`id=eq.${I.chen}`), JSON.stringify(chenPatch));
        check('陳測四列上顯示 B200002', (await text(testId(page, `payout-row-${I.chen}`))).includes('B200002'));

        // 改選別期
        section('1c. 改選期別（有未匯出的調整時會先確認）');
        await lbl(page, '王測二 調整原因').fill('教材費扣回（改）');
        let confirmMessage = '';
        page.once('dialog', async (dialog) => { confirmMessage = dialog.message(); await dialog.accept(); });
        await lbl(page, '期別').selectOption('2026/09');
        await waitText(testId(page, 'payout-total'), '$5,700');
        check('有未匯出的改動時切換期別會先跳確認', confirmMessage.includes('切換期別會清除'), confirmMessage);
        check('改選 2026/09：付款日期改為 2026-10-10（該期固定匯款日）', (await lbl(page, '付款日期').inputValue()) === '2026-10-10');
        check('2026/09 期（8/26～9/25）：丁 5000、陳 700，總額 $5,700，2 人', (await text(testId(page, 'payout-total'))) === '$5,700' && (await text(testId(page, 'payout-included-count'))) === '2');
        check('2026/09 期開始前仍未付：1001 筆・$10,010', (await text(testId(page, 'payout-stats-earlier'))) === '1001 筆・$10,010', await text(testId(page, 'payout-stats-earlier')));
        reqLog.length = 0;
        await lbl(page, '期別').selectOption('2026/08');
        await waitText(testId(page, 'payout-total'), '$10,010');
        const augQueries = reqLog.filter((r) => r.path === '/rest/v1/class_sessions' && r.method === 'GET').map((r) => new URLSearchParams(r.search));
        check('2026/08 期 1001 筆：分頁抓滿（有 offset=1000 的第二頁），總額 $10,010',
            (await text(testId(page, 'payout-total'))) === '$10,010' && augQueries.some((p) => p.get('status') === 'eq.approved' && p.get('offset') === '1000'),
            `${await text(testId(page, 'payout-total'))} offsets=${augQueries.map((p) => p.get('offset'))}`);
        check('2026/08 期丁測一筆數 1001', (await text(testId(page, `payout-row-${I.ding}`))).includes('1001'));
        const desktopOverflow = await noPageOverflow(page);
        check(`1280 寬沒有整頁橫捲（scrollWidth ${desktopOverflow[0]} ≤ ${desktopOverflow[1]}）`, desktopOverflow[0] <= desktopOverflow[1]);
        await lbl(page, '丁測一 調整金額').fill('1');
        await lbl(page, '丁測一 調整原因').fill('測試');
        let unloadDialog = '';
        page.once('dialog', async (dialog) => { unloadDialog = dialog.type(); await dialog.accept(); });
        await page.close({ runBeforeUnload: true });
        await new Promise((r) => setTimeout(r, 500));
        check('有調整尚未匯出時關閉分頁：瀏覽器跳出 beforeunload 確認', unloadDialog === 'beforeunload', unloadDialog || '(沒有對話框)');

        // ════════ 2. 手機 375 ════════
        section('2. 手機 375（同一個瀏覽器設定檔：付款帳號、分行由 localStorage 帶回）');
        resetWorld();
        page = await newPage(context);
        await page.setViewportSize({ width: 375, height: 812 });
        await openPayout(page, base);
        check('付款帳號、分行記在 localStorage，重開頁面自動帶回',
            (await lbl(page, '付款帳號').inputValue()) === '1234-5678-9012' && (await lbl(page, '付款分行').inputValue()) === '0456');
        let mobileOverflow = await noPageOverflow(page);
        check(`375 寬沒有整頁橫捲（scrollWidth ${mobileOverflow[0]} ≤ ${mobileOverflow[1]}）`, mobileOverflow[0] <= mobileOverflow[1]);
        const scrollBox = await testId(page, 'payout-people-scroll').evaluate((el) => [el.scrollWidth, el.clientWidth, getComputedStyle(el).overflowX]);
        check('講師表格在自己的容器內橫向捲動（overflow-x auto）', scrollBox[0] > scrollBox[1] && scrollBox[2] === 'auto', JSON.stringify(scrollBox));
        const linTag = testId(page, `payout-tag-${I.lin}`);
        const linTagBox = await linTag.boundingBox();
        check('375 寬：被擋的林測三在姓名格內直接看到紅色「不匯：解款行有誤」，不用往右滑',
            (await text(linTag)) === '不匯：解款行有誤' && (await linTag.isVisible()) && linTagBox && linTagBox.x >= 0 && linTagBox.x + linTagBox.width <= 375, JSON.stringify(linTagBox));
        const chenTag = testId(page, `payout-tag-${I.chen}`);
        const chenTagBox = await chenTag.boundingBox();
        check('375 寬：有警告的陳測四姓名格內看到黃色「注意 N 項」', /^注意 \d+ 項$/.test(await text(chenTag)) && chenTagBox && chenTagBox.x + chenTagBox.width <= 375, `${await text(chenTag)} ${JSON.stringify(chenTagBox)}`);
        await page.screenshot({ path: shot('mobile-375-initial.png'), fullPage: true });
        await lbl(page, '丁測一 展開明細').click();
        mobileOverflow = await noPageOverflow(page);
        check(`375 寬展開明細後仍沒有整頁橫捲（${mobileOverflow[0]} ≤ ${mobileOverflow[1]}）`, mobileOverflow[0] <= mobileOverflow[1]);
        const csvButton = await page.getByRole('button', { name: '轉帳檔 CSV' }).boundingBox();
        check('375 寬下載按鈕熱區高度 ≥ 44px', csvButton && csvButton.height >= 44, JSON.stringify(csvButton));
        await page.screenshot({ path: shot('mobile-375-expanded.png'), fullPage: true });
        await page.close();
        await context.close();

        // ════════ 3. 正式庫還沒套 migration（partner_no 欄位不存在） ════════
        section('3. 正式庫還沒套 migration：instructors 沒有 partner_no 欄位');
        resetWorld({ partnerMissing: true });
        reqLog.length = 0;
        patches.length = 0;
        const missingContext = await newContext(browser, { viewport: { width: 1280, height: 900 } });
        page = await newPage(missingContext);
        await openPayout(page, base);
        const instructorGets = reqLog.filter((r) => r.path === '/rest/v1/instructors' && r.method === 'GET' && !new URLSearchParams(r.search).get('user_id'));
        check('先帶 partner_no 查（回 42703）→ 自動改用不含 partner_no 的查詢',
            instructorGets.length >= 2 && instructorGets[0].search.includes('partner_no') && instructorGets.some((r) => !r.search.includes('partner_no')));
        check('頁面仍可用：納入 4 人、總額 $5,600', (await text(testId(page, 'payout-included-count'))) === '4' && (await text(testId(page, 'payout-total'))) === '$5,600');
        check('顯示「需先套資料庫更新」並停用匯入（沒有上傳欄）',
            (await testId(page, 'payout-partner-missing').isVisible()) && (await lbl(page, '上傳夥伴號碼 CSV').count()) === 0);
        check('沒有紅色讀取錯誤', (await page.getByText('資料讀取失敗').count()) === 0);
        await lbl(page, '付款帳號').fill('123456789012');
        await lbl(page, '付款分行').fill('0456');
        await lbl(page, '手續費負擔方式').selectOption('__other');
        check('手續費選「其他代碼…」才出現輸入框，並顯示黃色警告「與財務範本不同，請先向財務確認代碼意義」',
            (await lbl(page, '手續費負擔方式（其他代碼）').isVisible()) && (await page.getByText('與財務範本不同，請先向財務確認代碼意義', { exact: true }).count()) === 1);
        await page.getByRole('button', { name: '轉帳檔 CSV' }).click();
        check('其他代碼留空：擋下「手續費負擔方式需為數字」', (await text(testId(page, 'payout-csv-errors'))).includes('手續費負擔方式需為數字'));
        await lbl(page, '手續費負擔方式（其他代碼）').fill('1');
        const csvOther = await downloadVia(page, '轉帳檔 CSV');
        check('其他代碼 1 會寫進 CSV 的手續費欄', parseCsvLines(csvOther.bytes).lines[1].split(',')[12] === '1');
        await lbl(page, '手續費負擔方式').selectOption('2');
        check('改回範本值 2：輸入框與警告消失', (await lbl(page, '手續費負擔方式（其他代碼）').count()) === 0 && (await page.getByText('與財務範本不同，請先向財務確認代碼意義').count()) === 0);
        check('下拉選單選項是「3（財務範本值）」「其他代碼…」，沒有自編的代碼意義',
            (await lbl(page, '匯款通知方式').locator('option').allTextContents()).join('|') === '3（財務範本值）|其他代碼…');
        const csv3 = await downloadVia(page, '轉帳檔 CSV');
        const csvRows3 = parseCsvLines(csv3.bytes).lines.slice(1, -1).map((line) => line.split(','));
        check('欄位不存在時 CSV 照常下載，夥伴號碼全部「需新增1～4」', csvRows3.map((r) => r[13]).join() === '需新增1,需新增2,需新增3,需新增4', csvRows3.map((r) => r[13]).join());
        await lbl(page, '王測二 展開明細').click();
        check('展開明細的夥伴號碼欄顯示「需先套資料庫更新」', (await page.getByText('需先套資料庫更新', { exact: true }).count()) >= 1);
        check('沒有送出任何 PATCH', patches.length === 0);
        await page.screenshot({ path: shot('missing-column-1280.png'), fullPage: true });

        await page.goto(`${base}/admin/salary/export`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬供應商 CSV 匯出' }).waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: /匯出 6 位老師/ }).waitFor({ timeout: 10000 });
        check('供應商匯出頁：欄位不存在時也能用（匯出 6 位老師），並提示需先套資料庫更新',
            (await page.getByRole('button', { name: '匯出 6 位老師' }).count()) === 1 && (await page.getByText(/資料庫還沒有夥伴號碼欄位/).count()) === 1);
        check('供應商匯出頁沒有紅色讀取錯誤', (await page.getByText('資料讀取失敗').count()) === 0);
        await page.screenshot({ path: shot('vendor-export-missing-column.png'), fullPage: true });
        await missingContext.close();

        // ════════ 5. 競態：10 月期還在讀就改選 9 月期，10 月的回應晚到 ════════
        section('5. 競態：第一期的回應延遲 3 秒，期間改選別期');
        resetWorld();
        world.delayOnceFor = '2026-09-26';
        const raceContext = await newContext(browser, { viewport: { width: 1280, height: 900 } });
        page = await newPage(raceContext);
        let raceDownloads = 0;
        page.on('download', () => { raceDownloads += 1; });
        await page.goto(`${base}/admin/salary/payout`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: '月結匯款', exact: true }).waitFor({ timeout: 15000 });
        await page.getByText('正在讀取本期報酬…').waitFor({ timeout: 10000 });
        check('讀取中：期別下拉停用', await lbl(page, '期別').isDisabled());
        check('讀取中：重新整理按鈕停用', await page.getByRole('button', { name: '讀取中' }).isDisabled());
        await page.getByRole('button', { name: '轉帳檔 CSV' }).click();
        check('讀取中按下載：擋下並提示「資料還在讀取中，請稍候」、沒有下載',
            (await text(testId(page, 'payout-csv-errors'))) === '資料還在讀取中，請稍候' && raceDownloads === 0);
        // 模擬極端情況：繞過停用，在 10 月期還沒回來時改選 9 月期
        await lbl(page, '期別').evaluate((el) => el.removeAttribute('disabled'));
        await lbl(page, '期別').selectOption('2026/09');
        await waitText(testId(page, 'payout-total'), '$5,700');
        const deadlineRace = Date.now() + 8000;
        while (!world.delayedServed && Date.now() < deadlineRace) await new Promise((r) => setTimeout(r, 100));
        await page.waitForTimeout(500);
        check('10 月期的延遲回應確實晚到（在 9 月期之後）', world.delayedServed === true);
        check('晚到的 10 月期回應被丟掉：仍是 9 月期資料（總額 $5,700、2 人）',
            (await text(testId(page, 'payout-total'))) === '$5,700' && (await text(testId(page, 'payout-included-count'))) === '2'
            && (await lbl(page, '期別').inputValue()) === '2026/09', `${await text(testId(page, 'payout-total'))}`);
        check('附言預覽是 9 月（26/09…）、畫面沒有 10 月的課', (await text(testId(page, 'payout-memo-preview'))).startsWith('26/09') && (await page.getByText('江測五').count()) === 0);
        await lbl(page, '付款帳號').fill('123456789012');
        await lbl(page, '付款分行').fill('0456');
        const raceCsv = await downloadVia(page, '轉帳檔 CSV');
        const raceRows = parseCsvLines(raceCsv.bytes).lines.slice(1, -1).map((line) => line.split(','));
        check('檔名與內容一致是 9 月期：202609…_20261010.csv，丁 5000、陳 700，附言 26/09',
            raceCsv.name === '202609夢想講師轉帳檔_20261010.csv' && raceRows.map((r) => `${r[6]}:${r[7]}`).join() === '丁測一:5000,陳測四媽媽:700'
            && raceRows.every((r) => r[11].startsWith('26/09')), `${raceCsv.name} ${raceRows.map((r) => `${r[6]}:${r[7]}`)}`);
        await raceContext.close();

        // ════════ 6. 去重、筆數不一致、重新整理會重抓主檔 ════════
        section('6. 去重／讀取期間資料變動／重新整理連主檔一起重抓');
        resetWorld();
        world.duplicateApproved = true;
        const dupContext = await newContext(browser, { viewport: { width: 1280, height: 900 } });
        page = await newPage(dupContext);
        let dupDownloads = 0;
        page.on('download', () => { dupDownloads += 1; });
        await openPayout(page, base);
        check('回應裡同一堂課出現兩次：依 id 去重，總額仍是 $5,600（沒有重複計入）',
            (await text(testId(page, 'payout-total'))) === '$5,600' && (await testId(page, 'payout-data-changed').count()) === 0);
        world.countDelta = 1;
        await page.getByRole('button', { name: '重新整理' }).click();
        await testId(page, 'payout-data-changed').waitFor({ timeout: 10000 });
        check('已核准總筆數（count=exact）和讀到的不一致：顯示「讀取期間資料有變動，請重新整理」',
            (await text(testId(page, 'payout-data-changed'))).startsWith('讀取期間資料有變動，請重新整理'));
        await lbl(page, '付款帳號').fill('123456789012');
        await lbl(page, '付款分行').fill('0456');
        await page.getByRole('button', { name: '完整 Excel（四分頁）' }).click();
        check('筆數不一致時擋下載', (await text(testId(page, 'payout-xlsx-errors'))).includes('讀取期間資料有變動') && dupDownloads === 0);
        world.countDelta = 0;
        world.instructors.find((row) => row.id === I.lin).bank_code = '0081830';  // 講師主檔在別處被修好了
        const beforeRefresh = reqLog.length;
        await page.getByRole('button', { name: '重新整理' }).click();
        await waitText(testId(page, 'payout-included-count'), '5');
        const refreshInstructorGets = reqLog.slice(beforeRefresh).filter((r) => r.path === '/rest/v1/instructors' && r.method === 'GET' && !new URLSearchParams(r.search).get('user_id'));
        check('重新整理會重抓講師主檔（有新的 instructors 查詢）', refreshInstructorGets.length >= 1, `gets=${refreshInstructorGets.length}`);
        check('主檔修好後林測三不再被擋：納入 5 人、總額 $6,500、筆數警告消失',
            (await text(testId(page, 'payout-included-count'))) === '5' && (await text(testId(page, 'payout-total'))) === '$6,500' && (await testId(page, 'payout-data-changed').count()) === 0);
        const dupCsv = await downloadVia(page, '轉帳檔 CSV');
        check('恢復正常後可下載，林測三在檔案裡', parseCsvLines(dupCsv.bytes).textValue.includes('林測三'));
        await dupContext.close();

        // ════════ 7. 帳號尚未完成 Email 驗證啟用的講師不能匯款（2026-10-23 第二輪資安審查建議 2） ════════
        section('7. 綁定帳號 role 仍是 pending、或有 pending 啟用紀錄的講師：直接排除、寫明原因、不進轉帳檔');
        resetWorld();
        const PENDING_UID = '00000000-0000-4000-8000-0000000000e1';
        const DROPDOWN_UID = '00000000-0000-4000-8000-0000000000e2';
        world.instructors.find((row) => row.id === I.ding).user_id = PENDING_UID;   // 姓名空位認領後還沒驗證信箱
        world.instructors.find((row) => row.id === I.wang).user_id = DROPDOWN_UID;  // 角色已是 teacher，但啟用紀錄仍 pending
        world.pendingUsers = [{ id: PENDING_UID, role: 'pending' }];
        world.activations = [
            { id: 'act-1', user_id: PENDING_UID, instructor_id: I.ding, status: 'pending' },
            { id: 'act-2', user_id: DROPDOWN_UID, instructor_id: I.wang, status: 'pending' },
            { id: 'act-3', user_id: '00000000-0000-4000-8000-0000000000e3', instructor_id: I.jiang, status: 'active' },
        ];
        reqLog.length = 0;
        const gateContext = await newContext(browser, { viewport: { width: 1280, height: 900 } });
        page = await newPage(gateContext);
        await openPayout(page, base);
        const gateQueries = reqLog.filter((r) => ['/rest/v1/users', '/rest/v1/instructor_account_activations'].includes(r.path) && new URLSearchParams(r.search).has(r.path.endsWith('users') ? 'role' : 'status'));
        check('讀取時一併查「role=pending 的帳號」與「status=pending 的啟用紀錄」',
            gateQueries.some((r) => r.path === '/rest/v1/users' && new URLSearchParams(r.search).get('role') === 'eq.pending')
            && gateQueries.some((r) => r.path === '/rest/v1/instructor_account_activations' && new URLSearchParams(r.search).get('status') === 'eq.pending'),
            gateQueries.map((r) => `${r.path}${r.search}`).join(' '));
        const dingGate = await text(testId(page, `payout-row-${I.ding}`));
        const wangGate = await text(testId(page, `payout-row-${I.wang}`));
        check('丁測一（帳號 role 仍是 pending）：不納入、勾選框停用、原因「帳號尚未完成 Email 驗證啟用，不能匯款」',
            !(await lbl(page, '丁測一 納入匯款').isChecked()) && (await lbl(page, '丁測一 納入匯款').isDisabled())
            && dingGate.includes('帳號尚未完成 Email 驗證啟用，不能匯款'), dingGate);
        check('王測二（角色 teacher、但啟用紀錄仍 pending）：同樣排除並寫明原因',
            !(await lbl(page, '王測二 納入匯款').isChecked()) && wangGate.includes('帳號尚未完成 Email 驗證啟用，不能匯款'), wangGate);
        check('江測五（啟用紀錄 active）照常納入；納入 2 人（江 1200＋陳 1000）、總額 $2,200',
            (await lbl(page, '江測五 納入匯款').isChecked()) && (await text(testId(page, 'payout-included-count'))) === '2'
            && (await text(testId(page, 'payout-total'))) === '$2,200', `${await text(testId(page, 'payout-included-count'))} / ${await text(testId(page, 'payout-total'))}`);
        await lbl(page, '付款帳號').fill('123456789012');
        await lbl(page, '付款分行').fill('0456');
        const gateCsv = await downloadVia(page, '轉帳檔 CSV');
        const gateRows = parseCsvLines(gateCsv.bytes).lines.slice(1, -1).map((line) => line.split(','));
        check('轉帳檔只有江測五、陳測四媽媽，沒有丁測一與王測二（帳號未啟用）',
            gateRows.map((r) => r[6]).join() === '江測五,陳測四媽媽' && !parseCsvLines(gateCsv.bytes).textValue.includes('丁測一') && !parseCsvLines(gateCsv.bytes).textValue.includes('王測二'),
            gateRows.map((r) => r[6]).join());
        await page.screenshot({ path: shot('desktop-1280-unactivated-blocked.png'), fullPage: true });
        world.activationsMissing = true;
        world.activations = [];
        await page.getByRole('button', { name: '重新整理' }).click();
        await waitText(testId(page, 'payout-included-count'), '3');
        check('啟用紀錄表還沒建（電子簽約 migration 未套）：只看角色，丁測一仍被擋、王測二恢復納入、沒有讀取錯誤',
            (await text(testId(page, `payout-row-${I.ding}`))).includes('帳號尚未完成 Email 驗證啟用，不能匯款')
            && (await lbl(page, '王測二 納入匯款').isChecked()) && (await page.getByText('資料讀取失敗').count()) === 0);
        await gateContext.close();

        // ════════ 4. 非 admin ════════
        section('4. 輔導員（mentor）直接開網址');
        resetWorld({ role: 'mentor' });
        const mentorContext = await newContext(browser, { viewport: { width: 1280, height: 900 }, role: 'mentor' });
        page = await newPage(mentorContext);
        await page.goto(`${base}/admin/salary/payout`, { waitUntil: 'networkidle' });
        await page.waitForURL(`${base}/`, { timeout: 10000 }).catch(() => {});
        check('輔導員被導回首頁，看不到月結匯款', new URL(page.url()).pathname === '/' && (await page.getByRole('heading', { name: '月結匯款', exact: true }).count()) === 0, page.url());
        await mentorContext.close();

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
