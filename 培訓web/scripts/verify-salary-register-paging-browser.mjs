#!/usr/bin/env node
// 後台報酬登記中心改伺服器端篩選＋分頁：mock Supabase（照 PostgREST 網址條件真的過濾、排序、分頁、計數）
// 放 5,535 筆（2024/02～2026/10，其中 2025/08 有 607 筆），以本機 vite dev 實際操作桌機與 390px 手機。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const { COURSE_LABELS } = await import(path.join(appDir, 'src/lib/constants.js'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-19-salary-register-paging');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000071';
const instructorId = '10000000-0000-4000-8000-000000000071';
const now = new Date().toISOString();
const SERVER_MAX_ROWS = 1000;  // Supabase 預設每次最多回傳 1,000 筆

// ── 假資料：33 個月共 5,535 筆
const MONTH_COUNTS = (() => {
    const months = [];
    for (let index = 2024 * 12 + 1; index <= 2026 * 12 + 9; index += 1) {
        months.push(`${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`);
    }
    const fixed = { '2025-08': 607, '2026-10': 45 };
    const others = months.filter(month => !fixed[month]);
    const remaining = 5535 - 607 - 45;
    const base = Math.floor(remaining / others.length);
    let extra = remaining - base * others.length;
    return months.map(month => [month, fixed[month] ?? base + (extra-- > 0 ? 1 : 0)]);
})();
const NAMES = ['王大明', '陳小美', '林小華', '張志豪', '李佳穎', '黃冠宇', '吳宜蓁', '劉建宏', '蔡雅婷', '楊子軒', '許淑芬', '鄭家豪'];
const COURSE_TYPES = Object.keys(COURSE_LABELS);
const daysIn = (month) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();

const ALL_ROWS = [];
for (const [month, count] of MONTH_COUNTS) {
    for (let k = 0; k < count; k += 1) {
        const i = ALL_ROWS.length;
        const day = month === '2026-10' ? 1 + (k % 17) : 1 + (k % daysIn(month));
        let status = month >= '2026-09' ? 'approved' : 'paid';
        let pricing = 'legacy';
        if (month === '2026-10' && k < 6) { status = 'pending'; pricing = k < 2 ? 'needs_review' : 'quoted'; }
        if (month === '2025-08' && k < 3) { status = 'pending'; pricing = 'quoted'; }
        if (month === '2025-08' && k >= 3 && k < 8) status = 'approved';
        if (month === '2025-03' && k < 2) { status = 'pending'; pricing = 'quoted'; }
        const base = 400 + (i % 7) * 100;
        const bonus = i % 10 === 0 ? 200 : 0;
        const total = pricing === 'needs_review' ? 0 : base + bonus;
        ALL_ROWS.push({
            id: `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            instructor_id: instructorId,
            instructor_name: NAMES[i % NAMES.length],
            instructor_role_at_time: 'A',
            speed_qualification_at_time: null,
            role_in_session: 'lead',
            course_type: COURSE_TYPES[i % COURSE_TYPES.length],
            course_name: i === 4321 ? '速解營 A,B (進階)' : (i % 5 === 0 ? `第${(i % 9) + 1}期班` : null),
            session_date: `${month}-${String(day).padStart(2, '0')}`,
            month_label: month.replace('-', '/'),
            duration_hours: 1.5,
            student_count: 1 + (i % 6),
            base_salary: pricing === 'needs_review' ? null : base,
            bonus: pricing === 'needs_review' ? 0 : bonus,
            total_salary: total,
            paid_amount: status === 'paid' ? total : 0,
            status,
            pricing_status: pricing,
            is_anomaly: i % 97 === 0,
            anomaly_reasons: i % 97 === 0 ? ['測試異常'] : [],
            term_period: null, unit_name: null, materials_issued: null,
            transport_subsidy_requested: false, transport_distance_km: null,
            source: 'import', created_at: now,
        });
    }
}

// ── 簡化版 PostgREST：只認這頁會送的條件，其餘一律 400，避免畫面偷偷送出沒驗到的查詢
const STATUS_RANK = { pending: 0, approved: 1, paid: 2 };
const KNOWN_PARAMS = new Set(['select', 'order', 'offset', 'limit', 'session_date', 'status', 'is_anomaly', 'pricing_status', 'or', 'id']);
const likeToRegex = (pattern) => new RegExp(`^${pattern.split('').map(ch => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}$`, 'is');

function parseOr(value) {
    const inner = value.replace(/^\(/, '').replace(/\)$/, '');
    const conditions = [...inner.matchAll(/(\w+)\.ilike\."((?:[^"\\]|\\.)*)"/g)].map(([, column, pattern]) => [column, likeToRegex(pattern)]);
    const rebuilt = [...inner.matchAll(/(\w+)\.ilike\."((?:[^"\\]|\\.)*)"/g)].map(match => match[0]).join(',');
    if (!conditions.length || rebuilt !== inner) throw new Error(`bad or filter: ${value}`);
    return (row) => conditions.some(([column, regex]) => regex.test(String(row[column] ?? '')));
}

function compileFilters(params) {
    const tests = [];
    for (const key of params.keys()) if (!KNOWN_PARAMS.has(key)) throw new Error(`unexpected param ${key}`);
    for (const raw of params.getAll('session_date')) {
        const [op, value] = [raw.slice(0, raw.indexOf('.')), raw.slice(raw.indexOf('.') + 1)];
        if (op === 'gte') tests.push(row => row.session_date >= value);
        else if (op === 'lt') tests.push(row => row.session_date < value);
        else throw new Error(`unexpected session_date op ${raw}`);
    }
    for (const column of ['status', 'pricing_status', 'id']) {
        const raw = params.get(column);
        if (!raw) continue;
        if (!raw.startsWith('eq.')) throw new Error(`unexpected ${column} op ${raw}`);
        tests.push(row => String(row[column]) === raw.slice(3));
    }
    const anomaly = params.get('is_anomaly');
    if (anomaly) {
        if (anomaly !== 'eq.true') throw new Error(`unexpected is_anomaly ${anomaly}`);
        tests.push(row => row.is_anomaly === true);
    }
    if (params.get('or')) tests.push(parseOr(params.get('or')));
    return (row) => tests.every(test => test(row));
}

function compileOrder(value) {
    if (!value) return null;
    const keys = value.split(',').map(part => {
        const [column, direction] = part.split('.');
        return { column, asc: direction !== 'desc' };
    });
    return (a, b) => {
        for (const { column, asc } of keys) {
            const rank = (row) => (column === 'status' ? STATUS_RANK[row.status] ?? 99 : row[column]);
            const x = rank(a); const y = rank(b);
            if (x === y) continue;
            return (x < y ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
    };
}

const project = (row, select) => {
    if (!select || select === '*') return row;
    return Object.fromEntries(select.split(',').map(column => [column, row[column]]));
};

let failNextList = false;
let appRole = 'admin';
const sessionRequests = [];
const patches = [];
const inserts = [];

// 真正的 Supabase 會開放瀏覽器讀 Content-Range（總筆數就在裡面），mock 也要照做
const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, data, status = 200, headers = {}) => route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...headers },
    body: JSON.stringify(data),
});

async function handleClassSessions(route, request, url) {
    const method = request.method();
    const headers = await request.allHeaders();
    sessionRequests.push({ method, search: url.search, params: new URLSearchParams(url.search) });
    if (method === 'PATCH') {
        patches.push({ search: url.search, body: request.postDataJSON() });
        return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    if (method === 'POST') {
        const body = request.postDataJSON();
        const payload = Array.isArray(body) ? body[0] : body;
        inserts.push(payload);
        ALL_ROWS.push({
            ...payload,
            id: `50000000-0000-4000-8000-${String(inserts.length).padStart(12, '0')}`,
            total_salary: Number(payload.base_salary || 0) + Number(payload.bonus || 0),
            paid_amount: Number(payload.paid_amount || 0),
            is_anomaly: false,
            anomaly_reasons: [],
        });
        return route.fulfill({ status: 201, headers: CORS, body: '' });
    }
    if (!['GET', 'HEAD'].includes(method)) return json(route, { message: 'not allowed in this test' }, 405);
    const params = new URLSearchParams(url.search);
    if (failNextList && params.get('select') === '*') {
        failNextList = false;
        return json(route, { code: '57014', message: 'canceling statement due to statement timeout' }, 500);
    }
    let rows;
    try {
        rows = ALL_ROWS.filter(compileFilters(params));
    } catch (error) {
        return json(route, { code: 'PGRST100', message: error.message }, 400);
    }
    const order = compileOrder(params.get('order'));
    if (order) rows = [...rows].sort(order);
    const total = rows.length;
    const wantsCount = (headers.prefer || '').includes('count=exact');
    if (method === 'HEAD') {
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `*/${wantsCount ? total : '*'}` }, body: '' });
    }
    const offset = Number(params.get('offset') || 0);
    const limit = Math.min(params.has('limit') ? Number(params.get('limit')) : Infinity, SERVER_MAX_ROWS);
    const page = rows.slice(offset, offset + limit).map(row => project(row, params.get('select')));
    const range = page.length ? `${offset}-${offset + page.length - 1}` : '*';
    return json(route, page, 200, { 'content-range': `${range}/${wantsCount ? total : '*'}` });
}

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'paging-admin@test.local',
    user_metadata: { full_name: '分頁測試管理員' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.salary.paging', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, session);
        return json(route, {});
    }
    if (url.pathname === '/rest/v1/rpc/link_my_instructor_by_email') return json(route, instructorId);
    if (url.pathname === '/rest/v1/rpc/quote_salary') {
        return json(route, [{
            matched: true, needs_review: false, is_speed_course: false, message: '已依現行報酬表完成試算',
            instructor_role: 'A', speed_qualification: null, pricing_basis: 'general_level', pricing_label: 'A',
            rate_card_id: '20000000-0000-4000-8000-000000000071', pricing_mode: 'hourly', applied_rate: 400, base_salary: 600,
        }]);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);
    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        if (table === 'class_sessions') return handleClassSessions(route, request, url);
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
        if (table === 'users') {
            const row = { id: userId, name: '分頁測試管理員', email: authUser.email, role: appRole, created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructors') {
            const list = NAMES.map((name, i) => ({ id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, full_name: name, instructor_role: 'A', speed_qualification: null }));
            return json(route, acceptsObject ? null : list);
        }
        return json(route, acceptsObject ? null : []);
    }
    return json(route, {}, 404);
}

// ── 期望值：用同一套規則在腳本裡算
const expectedRows = ({ month = '', status = '', anomalyOnly = false, search = '' } = {}) => {
    const term = search.trim().replace(/[,()"\\%*]/g, '_');
    const regex = term ? likeToRegex(`%${term}%`) : null;
    return ALL_ROWS
        .filter(row => !month || row.session_date.startsWith(`${month}-`))
        .filter(row => !status || row.status === status)
        .filter(row => !anomalyOnly || row.is_anomaly)
        .filter(row => !regex || ['instructor_name', 'course_name', 'course_type'].some(column => regex.test(String(row[column] ?? ''))))
        .sort(compileOrder('status.asc,session_date.desc,id.desc'));
};
const rowLabel = (row) => `開啟 ${row.instructor_name} ${row.session_date} 報酬紀錄`;
const money = (value) => `$${Math.round(value).toLocaleString()}`;

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

const results = [];
const check = (name, condition, detail = '') => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? `  ← ${detail}` : ''}`);
};

async function contextFor(browser, viewport) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
    await context.route('**/*', handleRoute);
    return context;
}

const overflowOf = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const progress = (page) => page.getByTestId('salary-register-progress');
const statValue = (page, label) => page.locator('.bh-card').filter({ has: page.getByText(label, { exact: true }) }).locator('div').last().innerText();
const tableLabels = (page) => page.locator('table tbody tr[aria-label]').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
const waitProgress = (page, text) => progress(page).filter({ hasText: text }).waitFor({ timeout: 15000 });
const waitEmpty = (page) => page.locator('table').getByText('沒有符合的紀錄').waitFor({ timeout: 15000 });

async function openPage(page, base) {
    await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '報酬登記中心' }).waitFor();
}

// 一直按「載入更多」，每按一次都等進度文字變成下一個數字才繼續
async function loadAll(page, total) {
    for (let guard = 0; guard < 80; guard += 1) {
        const text = await progress(page).innerText();
        if (text.includes('全部')) break;
        const loaded = Number(text.match(/已顯示 ([\d,]+)／/)[1].replace(/,/g, ''));
        await page.getByRole('button', { name: /載入更多/ }).click();
        const next = Math.min(loaded + 100, total);
        await waitProgress(page, next === total
            ? `已顯示全部 ${total.toLocaleString()} 筆`
            : `已顯示 ${next.toLocaleString()}／${total.toLocaleString()} 筆`);
    }
    await waitProgress(page, `已顯示全部 ${total.toLocaleString()} 筆`);
}

async function run() {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
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
        check('假資料共 5,535 筆、2025/08 有 607 筆', ALL_ROWS.length === 5535 && expectedRows({ month: '2025-08' }).length === 607);
        const globalPending = ALL_ROWS.filter(row => row.status === 'pending').length;

        // ── 桌機
        let context = await contextFor(browser, { width: 1280, height: 900 });
        let page = await context.newPage();
        const consoleErrors = [];
        page.on('pageerror', error => consoleErrors.push(String(error)));
        await openPage(page, base);
        await waitProgress(page, '已顯示全部 45 筆');
        const monthSelect = page.getByLabel('月份');
        check('預設月份為最近一個月 2026/10', await monthSelect.inputValue() === '2026-10');
        check('標題顯示全庫筆數「共 5,535 筆紀錄」', await page.getByText('共 5,535 筆紀錄').isVisible());
        const monthTexts = await monthSelect.locator('option').allInnerTexts();
        check('月份選單列出 2026/10～2024/02 共 33 個月＋全部月份',
            monthTexts.length === 34 && monthTexts[0] === '全部月份' && monthTexts[1] === '2026/10' && monthTexts.at(-1) === '2024/02' && monthTexts.includes('2025/08'),
            JSON.stringify(monthTexts.slice(0, 3)));
        check(`待處理按鈕是全庫數字（${globalPending}，含待核薪 2）`,
            await page.getByRole('button', { name: new RegExp(`待處理 ${globalPending}`) }).isVisible()
            && await page.getByText('（待核薪 2）').isVisible());
        check('2026/10 的 45 筆依「待處理優先、日期新到舊」排列',
            JSON.stringify(await tableLabels(page)) === JSON.stringify(expectedRows({ month: '2026-10' }).map(rowLabel)));
        check('第一次載入只抓一頁（每次 select=* 都有 limit≤100）',
            sessionRequests.filter(r => r.params.get('select') === '*').every(r => Number(r.params.get('limit')) > 0 && Number(r.params.get('limit')) <= 100));
        await page.screenshot({ path: path.join(shotDir, 'desktop-default-2026-10.png'), fullPage: true });

        // 選 2025/08：伺服器端帶日期區間，先顯示 100／607，再載入更多直到全部
        sessionRequests.length = 0;
        await monthSelect.selectOption('2025-08');
        await waitProgress(page, '已顯示 100／607 筆');
        const listReq = sessionRequests.find(r => r.params.get('select') === '*');
        check('選 2025/08 時查詢帶 session_date gte 2025-08-01、lt 2025-09-01，且只要 100 筆',
            listReq && JSON.stringify(listReq.params.getAll('session_date')) === JSON.stringify(['gte.2025-08-01', 'lt.2025-09-01'])
            && listReq.params.get('limit') === '100' && listReq.params.get('order') === 'status.asc,session_date.desc,id.desc',
            listReq?.search);
        const augRows = expectedRows({ month: '2025-08' });
        const augTotal = augRows.reduce((sum, row) => sum + row.total_salary, 0);
        const augPaid = augRows.reduce((sum, row) => sum + row.paid_amount, 0);
        check('統計卡是整個月 607 筆的數字（不是只算已載入的 100 筆）',
            await statValue(page, '篩選筆數') === '607' && await statValue(page, '總報酬') === money(augTotal)
            && await statValue(page, '未付款') === money(augTotal - augPaid),
            `${await statValue(page, '篩選筆數')} ${await statValue(page, '總報酬')} vs ${money(augTotal)}`);
        check('第一頁表格 100 列，且最前面是該月 3 筆待核准',
            (await tableLabels(page)).length === 100
            && JSON.stringify((await tableLabels(page)).slice(0, 3)) === JSON.stringify(augRows.slice(0, 3).map(rowLabel)));
        check('「載入更多（再 100 筆）」按鈕可見', await page.getByRole('button', { name: '載入更多（再 100 筆）' }).isVisible());
        await page.screenshot({ path: path.join(shotDir, 'desktop-2025-08-first-page.png'), fullPage: false });
        await page.getByRole('button', { name: /載入更多/ }).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(shotDir, 'desktop-2025-08-load-more-button.png'), fullPage: false });
        sessionRequests.length = 0;
        await loadAll(page, 607);
        const loadMoreRequests = sessionRequests.filter(r => r.params.get('select') === '*');
        check('正常載入更多：每次多抓 1 筆接縫（offset 99、199…599，各 101 筆），沒有觸發整批重抓',
            JSON.stringify(loadMoreRequests.map(r => `${r.params.get('offset')}+${r.params.get('limit')}`))
            === JSON.stringify(['99+101', '199+101', '299+101', '399+101', '499+101', '599+101']),
            JSON.stringify(loadMoreRequests.map(r => `${r.params.get('offset')}+${r.params.get('limit')}`)));
        const augLabels = await tableLabels(page);
        check('載入更多後 2025/08 全部 607 筆都看得到、順序正確、沒有重複',
            augLabels.length === 607 && JSON.stringify(augLabels) === JSON.stringify(augRows.map(rowLabel)),
            `got ${augLabels.length}`);
        check('全部載完後「載入更多」按鈕消失', await page.getByRole('button', { name: /載入更多/ }).count() === 0);
        const augDates = await page.locator('table tbody tr[aria-label] td:first-child').allInnerTexts();
        check('607 列日期全部落在 2025-08', augDates.length === 607 && augDates.every(text => text.trim().startsWith('2025-08-')));
        await progress(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(shotDir, 'desktop-2025-08-all-607.png'), fullPage: false });

        // 狀態、異常篩選（都在伺服器端）
        sessionRequests.length = 0;
        await page.getByLabel('狀態').selectOption('paid');
        const augPaidRows = expectedRows({ month: '2025-08', status: 'paid' });
        await waitProgress(page, `已顯示 100／${augPaidRows.length} 筆`);
        check(`2025/08＋已付款 = ${augPaidRows.length} 筆，查詢帶 status=eq.paid`,
            await statValue(page, '篩選筆數') === String(augPaidRows.length)
            && sessionRequests.some(r => r.params.get('select') === '*' && r.params.get('status') === 'eq.paid'));
        await page.getByLabel('僅看異常').check();
        const augPaidAnomaly = expectedRows({ month: '2025-08', status: 'paid', anomalyOnly: true });
        await waitProgress(page, `已顯示全部 ${augPaidAnomaly.length} 筆`);
        check(`再勾「僅看異常」= ${augPaidAnomaly.length} 筆，查詢帶 is_anomaly=eq.true`,
            JSON.stringify(await tableLabels(page)) === JSON.stringify(augPaidAnomaly.map(rowLabel))
            && sessionRequests.some(r => r.params.get('is_anomaly') === 'eq.true'));
        await page.getByLabel('僅看異常').uncheck();
        await page.getByLabel('狀態').selectOption('');
        await waitProgress(page, '已顯示 100／607 筆');

        // 搜尋講師（伺服器端 ilike）
        sessionRequests.length = 0;
        await page.getByLabel('搜尋講師姓名或課程').fill('林小華');
        const linRows = expectedRows({ month: '2025-08', search: '林小華' });
        await waitProgress(page, `已顯示全部 ${linRows.length} 筆`);
        const orReq = sessionRequests.find(r => r.params.get('or'));
        check(`搜尋「林小華」在 2025/08 找到 ${linRows.length} 筆，查詢以 or=ilike 送到伺服器`,
            JSON.stringify(await tableLabels(page)) === JSON.stringify(linRows.map(rowLabel))
            && orReq?.params.get('or') === '(instructor_name.ilike."%林小華%",course_name.ilike."%林小華%",course_type.ilike."%林小華%")',
            orReq?.params.get('or'));
        await page.screenshot({ path: path.join(shotDir, 'desktop-search-instructor.png'), fullPage: false });

        // 特殊字元搜尋不會把查詢弄壞
        await monthSelect.selectOption('');
        await page.getByLabel('搜尋講師姓名或課程').fill('A,B (');
        const specialRows = expectedRows({ search: 'A,B (' });
        await waitProgress(page, `已顯示全部 ${specialRows.length} 筆`);
        check('搜尋含逗號與括號的「A,B (」也能找到「速解營 A,B (進階)」且沒有錯誤',
            specialRows.length === 1 && await page.locator('table').getByText('速解營 A,B (進階)').isVisible()
            && await page.getByRole('alert').count() === 0);
        await page.getByLabel('搜尋講師姓名或課程').fill('');

        // 全部月份：分頁 100／5,535，統計分段抓滿 5,535 筆（伺服器每次最多 1,000 筆）
        sessionRequests.length = 0;
        await waitProgress(page, '已顯示 100／5,535 筆');
        const allTotal = ALL_ROWS.reduce((sum, row) => sum + row.total_salary, 0);
        const statsRequests = sessionRequests.filter(r => r.params.get('select') === 'id,total_salary,paid_amount');
        check('全部月份：表格 100 列、統計卡 5,535 筆且總報酬為全庫加總',
            (await tableLabels(page)).length === 100 && await statValue(page, '篩選筆數') === '5,535'
            && await statValue(page, '總報酬') === money(allTotal),
            `${await statValue(page, '總報酬')} vs ${money(allTotal)}`);
        check('統計以 1,000 筆一段分 6 次抓完，沒有一次抓全部明細',
            statsRequests.length === 6 && sessionRequests.filter(r => r.params.get('select') === '*').every(r => Number(r.params.get('limit')) <= 100),
            `stats=${statsRequests.length}`);

        // 待處理快捷鍵：切到全部月份，看得到早期月份的待處理
        await monthSelect.selectOption('2026-10');
        await waitProgress(page, '已顯示全部 45 筆');
        await page.getByRole('button', { name: new RegExp(`待處理 ${globalPending}`) }).click();
        await waitProgress(page, `已顯示全部 ${globalPending} 筆`);
        const pendingLabels = await tableLabels(page);
        check(`點「待處理」切到全部月份，${globalPending} 筆含 2025/08 與 2025/03 的待處理`,
            await monthSelect.inputValue() === '' && await page.getByLabel('狀態').inputValue() === 'pending'
            && JSON.stringify(pendingLabels) === JSON.stringify(expectedRows({ status: 'pending' }).map(rowLabel))
            && pendingLabels.some(label => label.includes(' 2025-03-')) && pendingLabels.some(label => label.includes(' 2025-08-')));
        await page.screenshot({ path: path.join(shotDir, 'desktop-pending-all-months.png'), fullPage: true });
        await page.getByRole('button', { name: new RegExp(`待處理 ${globalPending}`) }).click();

        // 修改後重載保留已載入筆數
        await monthSelect.selectOption('2025-08');
        await waitProgress(page, '已顯示 100／607 筆');
        await page.getByRole('button', { name: /載入更多/ }).click();
        await waitProgress(page, '已顯示 200／607 筆');
        const target = augRows[150];
        await page.getByRole('row', { name: rowLabel(target) }).first().click();
        await page.getByRole('button', { name: '儲存', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
        await waitProgress(page, '已顯示 200／607 筆');
        check('在第 2 頁修改並儲存後，送出 PATCH 且畫面仍保留 200 筆（不跳回第 1 頁）',
            patches.some(p => p.search.includes(`id=eq.${target.id}`)) && (await tableLabels(page)).length === 200);

        // 查詢失敗 → 錯誤訊息 → 重新載入
        failNextList = true;
        await monthSelect.selectOption('2025-07');
        await page.getByRole('alert').filter({ hasText: '重新載入' }).waitFor({ timeout: 15000 });
        check('查詢失敗時顯示錯誤與「重新載入」', await page.getByRole('button', { name: '重新載入' }).isVisible());
        await page.getByRole('button', { name: '重新載入' }).click();
        const julCount = expectedRows({ month: '2025-07' }).length;
        await waitProgress(page, `已顯示 100／${julCount} 筆`);
        check('按「重新載入」後恢復正常', await page.getByRole('alert').count() === 0);

        // 瀏覽中別人把 3 筆待核准改成已付款（排序位置跨過分頁邊界）：接縫對不上 → 自動整批重抓，不漏不重
        await monthSelect.selectOption('2025-08');
        await waitProgress(page, '已顯示 100／607 筆');
        const movedRows = ALL_ROWS.filter(row => row.session_date.startsWith('2025-08-') && row.status === 'pending');
        movedRows.forEach(row => { row.status = 'paid'; });
        sessionRequests.length = 0;
        await page.getByRole('button', { name: /載入更多/ }).click();
        await waitProgress(page, '已顯示 200／607 筆');
        const shifted = expectedRows({ month: '2025-08' });
        check('別人同時改了 3 筆狀態：按載入更多偵測到接縫變動，自動重抓成伺服器現況的前 200 筆',
            movedRows.length === 3
            && JSON.stringify(await tableLabels(page)) === JSON.stringify(shifted.slice(0, 200).map(rowLabel))
            && sessionRequests.some(r => r.params.get('offset') === '99') && sessionRequests.some(r => r.params.get('offset') === '0' && r.params.get('limit') === '200'));
        await loadAll(page, 607);
        const shiftedLabels = await tableLabels(page);
        check('之後載到底仍是 607 筆、與伺服器現況一致、按鈕消失（不會卡住）',
            JSON.stringify(shiftedLabels) === JSON.stringify(shifted.map(rowLabel))
            && await page.getByRole('button', { name: /載入更多/ }).count() === 0);
        movedRows.forEach(row => { row.status = 'pending'; });

        // 在 2026/10 畫面新增一筆 2025-08-15 的紀錄：存檔後自動切到 2025/08，看得到剛存的那筆
        await monthSelect.selectOption('2026-10');
        await waitProgress(page, '已顯示全部 45 筆');
        await page.getByRole('button', { name: '新增報酬紀錄' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('講師*').selectOption('10000000-0000-4000-8000-000000000000');  // 王大明
        await dialog.getByLabel('日期*').fill('2025-08-15');
        await dialog.getByLabel('時數').fill('1.5');
        await dialog.getByLabel('人數').fill('2');
        // 試算有 250ms 延遲，試算中按鈕會變「試算中…」；以名稱「儲存」找按鈕，Playwright 會等到試算完、可按才點
        await page.waitForTimeout(400);
        await dialog.getByRole('button', { name: '儲存', exact: true }).click();
        await dialog.waitFor({ state: 'detached', timeout: 15000 });
        await waitProgress(page, '已顯示 100／608 筆');
        const withNew = expectedRows({ month: '2025-08' });
        const newRow = ALL_ROWS.find(row => row.id.startsWith('50000000-'));
        check('新增別的月份後自動切到 2025/08，剛存的那筆出現在列表（608 筆）',
            inserts.length === 1 && inserts[0].session_date === '2025-08-15'
            && await monthSelect.inputValue() === '2025-08'
            && withNew.slice(0, 100).some(row => row.id === newRow?.id)
            && JSON.stringify(await tableLabels(page)) === JSON.stringify(withNew.slice(0, 100).map(rowLabel)),
            `inserts=${inserts.length} month=${await monthSelect.inputValue()}`);
        await page.screenshot({ path: path.join(shotDir, 'desktop-after-add-other-month.png'), fullPage: false });
        ALL_ROWS.splice(ALL_ROWS.indexOf(newRow), 1);
        check('桌機操作過程沒有前端例外', consoleErrors.length === 0, consoleErrors.join(' | '));
        check('桌機 1280px 無水平溢出', (await overflowOf(page)) === 0);
        await context.close();

        // ── mentor 權限照舊
        appRole = 'mentor';
        context = await contextFor(browser, { width: 1280, height: 900 });
        page = await context.newPage();
        await openPage(page, base);
        await waitProgress(page, '已顯示全部 45 筆');
        check('mentor 可進入且同樣預設 2026/10，看不到「回報選項管理」',
            await page.getByLabel('月份').inputValue() === '2026-10' && await page.getByRole('link', { name: '回報選項管理' }).count() === 0);
        await context.close();
        appRole = 'admin';

        // ── 390px 手機
        context = await contextFor(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await openPage(page, base);
        await waitProgress(page, '已顯示全部 45 筆');
        const cards = page.locator('div.bh-card.overflow-hidden > div.md\\:hidden > button');
        check('390px 預設 2026/10 顯示 45 張卡片', await cards.count() === 45);
        check('390px 預設畫面無水平溢出', (await overflowOf(page)) === 0);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-default.png'), fullPage: false });
        await page.getByLabel('月份').selectOption('2025-08');
        await waitProgress(page, '已顯示 100／607 筆');
        const mobileButton = page.getByRole('button', { name: '載入更多（再 100 筆）' });
        await mobileButton.scrollIntoViewIfNeeded();
        const box = await mobileButton.boundingBox();
        check('390px「載入更多」按鈕滿版、高度 ≥ 44px', box && box.width >= 300 && box.height >= 44, JSON.stringify(box));
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-load-more.png'), fullPage: false });
        await mobileButton.click();
        await waitProgress(page, '已顯示 200／607 筆');
        check('390px 載入更多後 200 張卡片', await cards.count() === 200);
        await page.getByLabel('狀態').selectOption('pending');
        await waitProgress(page, '已顯示全部 3 筆');
        check('390px 狀態篩選後 3 張卡片且無水平溢出', await cards.count() === 3 && (await overflowOf(page)) === 0);
        await page.getByLabel('狀態').selectOption('');
        await waitProgress(page, '已顯示 100／607 筆');
        await loadAll(page, 607);
        check('390px 也能把 2025/08 的 607 筆全部載完', await cards.count() === 607 && (await overflowOf(page)) === 0);
        await progress(page).scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-all-607.png'), fullPage: false });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByLabel('搜尋講師姓名或課程').fill('陳小美');
        await waitProgress(page, `已顯示全部 ${expectedRows({ month: '2025-08', search: '陳小美' }).length} 筆`);
        check('390px 搜尋講師後無水平溢出', (await overflowOf(page)) === 0);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-filters.png'), fullPage: false });
        await context.close();
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
