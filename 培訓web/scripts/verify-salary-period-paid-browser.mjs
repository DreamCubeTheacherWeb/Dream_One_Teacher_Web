#!/usr/bin/env node
// 後台「本期匯款完成」：mock Supabase 真瀏覽器驗證（2026-10-21）。
// 做法同 verify-salary-payday-browser.mjs：本機 vite dev＋本機 Chrome＋localStorage 塞假 session，
// 所有 Supabase 網域請求都由 page.route 攔截回假資料；沒列在白名單的請求一律回 404 並讓腳本 FAIL，絕不放行到正式站。
// 「今天」用 Playwright clock.setFixedTime 固定（台北時間）。mock 的 mark_salary_period_paid 照資料庫函式的條件改假資料，
// 所以按完之後統計卡、預覽筆數會跟著變。
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
const shotDir = path.join(appDir, 'docs/verification/2026-10-21-salary-period-paid');
mkdirSync(shotDir, { recursive: true });
const shot = (name) => path.join(shotDir, name);

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const supabaseHost = new URL(env.VITE_SUPABASE_URL).hostname;
const projectRef = supabaseHost.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000093';
const I1 = '10000000-0000-4000-8000-000000000093';
const I2 = '10000000-0000-4000-8000-000000000094';
const now = new Date().toISOString();
const COURSE_TYPE = Object.keys(COURSE_LABELS)[0];
const RPC = 'mark_salary_period_paid';

// ── 假資料。10月期 9/26～10/25：已核准 9/26（1000）、10/7（800）、10/25（300，別的講師）→ 應標 3 筆 $2,100；
//   邊界外：9/25 已核准 5000（屬 9月期）、10/26 已核准 4000（屬 11月期）；待核准 600、待定價 1 筆 → 「另有 2 筆待核准」；
//   退回 1 筆（不算待核准）；已付款 999（不動）。11月期另有 11/5 已核准 1200。
let seq = 0;
const makeSession = ({ instructor = I1, date, status, pricing = 'quoted', total }) => {
    seq += 1;
    const priced = !['needs_review', 'rejected'].includes(pricing);
    return {
        id: `40000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        instructor_id: instructor, instructor_name: instructor === I1 ? '匯款測試講師' : '另一位講師', instructor_role_at_time: 'A',
        speed_qualification_at_time: null, role_in_session: 'lead',
        course_type: COURSE_TYPE, course_name: null,
        session_date: date, month_label: date.slice(0, 7).replace('-', '/'),
        duration_hours: 1.5, student_count: 3,
        base_salary: priced ? total : null, bonus: 0, total_salary: priced ? total : 0,
        paid_amount: status === 'paid' ? total : 0, paid_at: status === 'paid' ? now : null,
        status, pricing_status: pricing, pricing_message: pricing === 'rejected' ? '測試退回原因' : null,
        is_anomaly: false, anomaly_reasons: [],
        term_period: null, unit_name: null, materials_issued: null,
        transport_subsidy_requested: false, transport_distance_km: null,
        source: 'report', created_at: now, updated_at: now,
    };
};
const seedSessions = () => {
    seq = 0;
    return [
        makeSession({ date: '2026-09-25', status: 'approved', total: 5000 }),  // 9月期終點
        makeSession({ date: '2026-09-26', status: 'approved', total: 1000 }),  // 10月期起點
        makeSession({ date: '2026-10-07', status: 'approved', total: 800 }),
        makeSession({ date: '2026-10-12', status: 'pending', total: 600 }),
        makeSession({ date: '2026-10-15', status: 'pending', pricing: 'needs_review', total: null }),
        makeSession({ date: '2026-10-16', status: 'pending', pricing: 'rejected', total: 450 }),
        makeSession({ date: '2026-10-20', status: 'paid', total: 999 }),
        makeSession({ instructor: I2, date: '2026-10-25', status: 'approved', total: 300 }),  // 10月期終點
        makeSession({ date: '2026-10-26', status: 'approved', total: 4000 }),  // 11月期起點
        makeSession({ instructor: I2, date: '2026-11-05', status: 'approved', total: 1200 }),
    ];
};

// ── mock 的資料庫狀態（腳本會在各情境之間改它）
const world = {
    role: 'admin',
    scheduleMode: 'ok',  // ok | error（HTTP 500）
    schedule: { next_payday: '2026-11-10', regular_day: 10 },
    rpcMode: 'ok',       // ok | 42501 | missing | 22023
    rpcDelayMs: 800,
    sessions: seedSessions(),
};
const reqLog = [];       // 所有 Supabase 請求（含時間）
const rpcCalls = [];     // mark_salary_period_paid 的呼叫
const unexpected = [];   // 白名單以外的 Supabase 請求（有就 FAIL）
const externalBlocked = new Set();
const supabaseHostsSeen = new Set();

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, data, status = 200, headers = {}) => route.fulfill({
    status, headers: { 'content-type': 'application/json', ...CORS, ...headers }, body: JSON.stringify(data),
});

// ── 簡化版 PostgREST：不認得的條件一律 400
const STATUS_RANK = { pending: 0, approved: 1, paid: 2 };
const KNOWN_PARAMS = new Set(['select', 'order', 'offset', 'limit', 'session_date', 'status', 'is_anomaly', 'pricing_status', 'or', 'id', 'instructor_id']);
function compileFilters(params) {
    const tests = [];
    for (const key of params.keys()) if (!KNOWN_PARAMS.has(key)) throw new Error(`unexpected param ${key}`);
    for (const raw of params.getAll('session_date')) {
        const [op, value] = [raw.slice(0, raw.indexOf('.')), raw.slice(raw.indexOf('.') + 1)];
        if (op === 'gte') tests.push(row => row.session_date >= value);
        else if (op === 'lt') tests.push(row => row.session_date < value);
        else if (op === 'lte') tests.push(row => row.session_date <= value);
        else throw new Error(`unexpected session_date op ${raw}`);
    }
    for (const column of ['status', 'id', 'instructor_id']) {
        const raw = params.get(column);
        if (!raw) continue;
        if (!raw.startsWith('eq.')) throw new Error(`unexpected ${column} op ${raw}`);
        tests.push(row => String(row[column]) === raw.slice(3));
    }
    const pricing = params.get('pricing_status');
    if (pricing) {
        const inList = /^not\.in\.\(([^)]*)\)$/.exec(pricing);
        if (pricing.startsWith('eq.')) tests.push(row => row.pricing_status === pricing.slice(3));
        else if (pricing.startsWith('neq.')) tests.push(row => row.pricing_status !== pricing.slice(4));
        else if (inList) { const values = inList[1].split(','); tests.push(row => !values.includes(row.pricing_status)); }
        else throw new Error(`unexpected pricing_status op ${pricing}`);
    }
    const anomaly = params.get('is_anomaly');
    if (anomaly) {
        if (anomaly !== 'eq.true') throw new Error(`unexpected is_anomaly ${anomaly}`);
        tests.push(row => row.is_anomaly === true);
    }
    if (params.get('or')) throw new Error('or filter not expected in this script');
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

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'period-paid@test.local',
    user_metadata: { full_name: '匯款完成測試帳號' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.salary.period.paid', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(new Date('2030-01-01T00:00:00Z').getTime() / 1000), user: authUser,
};

// mock 版 mark_salary_period_paid：與 migration 相同的條件、核對與回傳
const fmt = (n) => Math.round(Number(n)).toLocaleString('en-US');
function markPeriodPaid({ p_period_start: start, p_period_end: end, p_expected_count: expectedCount, p_expected_amount: expectedAmount }) {
    const rows = world.sessions.filter(row => row.status === 'approved' && !['needs_review', 'rejected'].includes(row.pricing_status)
        && row.session_date >= start && row.session_date <= end);
    const count = rows.length;
    const amount = rows.reduce((sum, row) => sum + Number(row.total_salary), 0);
    if ((expectedCount != null && count !== expectedCount) || (expectedAmount != null && Math.round(amount * 100) !== Math.round(expectedAmount * 100))) {
        return { error: { code: '22023', message: `這一期的紀錄剛剛有變動（確認時 ${expectedCount} 筆、$${fmt(expectedAmount)}，現在 ${count} 筆、$${fmt(amount)}），這次沒有標記任何紀錄，請重新確認。`, details: null, hint: null } };
    }
    const paidAt = new Date().toISOString();
    for (const row of rows) {
        row.status = 'paid';
        row.paid_amount = row.total_salary;
        row.paid_at = paidAt;
    }
    return { data: { marked_count: count, marked_amount: amount, paid_at: paidAt } };
}

async function handleSupabase(route, request, url) {
    const method = request.method();
    const params = new URLSearchParams(url.search);
    reqLog.push({ method, path: url.pathname, search: url.search, at: Date.now() });
    const reject = (why) => {
        unexpected.push(`${method} ${url.pathname}${url.search}  (${why})`);
        return json(route, { code: 'MOCK_UNEXPECTED', message: `verify script did not expect: ${why}` }, 404);
    };
    const headers = await request.allHeaders();
    const acceptsObject = (headers.accept || '').includes('vnd.pgrst.object+json');
    const wantsCount = (headers.prefer || '').includes('count=exact');

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, session);
        return json(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.replace('/rest/v1/rpc/', '');
        if (['claim_my_precreated_instructor', 'ensure_my_contract_reminder'].includes(name) && method === 'POST') return json(route, null);
        if (name === RPC && method === 'POST') {
            const body = request.postDataJSON();
            rpcCalls.push({ body, at: Date.now() });
            await new Promise(resolve => setTimeout(resolve, world.rpcDelayMs));
            if (world.rpcMode === '42501') return json(route, { code: '42501', message: '只有管理員可以標記匯款完成。', details: null, hint: null }, 403);
            if (world.rpcMode === 'missing') {
                return json(route, { code: 'PGRST202', message: `Could not find the function public.${RPC}(p_period_end, p_period_start) in the schema cache`, details: null, hint: null }, 404);
            }
            if (world.rpcMode === '22023') return json(route, { code: '22023', message: '這一期到 10/25 才結束，結束後才能標記已付款。', details: null, hint: null }, 400);
            if (Object.keys(body).sort().join(',') !== 'p_expected_amount,p_expected_count,p_period_end,p_period_start') return reject(`rpc body ${JSON.stringify(body)}`);
            const result = markPeriodPaid(body);
            return result.error ? json(route, result.error, 400) : json(route, result.data);
        }
        return reject(`rpc ${name}`);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return reject('not a rest/auth path');
    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];

    if (table === 'salary_payout_schedule') {
        if (world.scheduleMode === 'error') return json(route, { code: 'XX000', message: 'mock internal error', details: null, hint: null }, 500);
        if (method !== 'GET') return reject(`schedule ${method}`);
        if (params.get('select') !== 'next_payday,regular_day' || [...params.keys()].some(k => k !== 'select')) return reject('schedule GET with unexpected params');
        const row = { ...world.schedule };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'users' && method === 'GET') {
        const row = { id: userId, name: '匯款完成測試帳號', email: authUser.email, role: world.role, created_at: now };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'instructors' && method === 'GET') {
        if (params.get('user_id')) return json(route, acceptsObject ? null : []);
        const list = [
            { id: I1, full_name: '匯款測試講師', instructor_role: 'A', speed_qualification: null },
            { id: I2, full_name: '另一位講師', instructor_role: 'A', speed_qualification: null },
        ];
        return json(route, acceptsObject ? null : list);
    }
    if (table === 'class_sessions') {
        if (!['GET', 'HEAD'].includes(method)) return reject(`class_sessions ${method}`);
        let rows;
        try { rows = world.sessions.filter(compileFilters(params)); } catch (error) { return json(route, { code: 'PGRST100', message: error.message }, 400); }
        const order = compileOrder(params.get('order'));
        if (order) rows = [...rows].sort(order);
        const total = rows.length;
        if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `*/${wantsCount ? total : '*'}` }, body: '' });
        const offset = Number(params.get('offset') || 0);
        const limit = Math.min(params.has('limit') ? Number(params.get('limit')) : Infinity, 1000);
        const page = rows.slice(offset, offset + limit).map(row => project(row, params.get('select')));
        const range = page.length ? `${offset}-${offset + page.length - 1}` : '*';
        return json(route, page, 200, { 'content-range': `${range}/${wantsCount ? total : '*'}` });
    }
    if (['site_links', 'notifications', 'salary_report_options'].includes(table) && method === 'GET') {
        return json(route, acceptsObject ? null : []);
    }
    return reject(`table ${table} ${method}`);
}

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (url.hostname.includes('supabase')) {
        supabaseHostsSeen.add(url.hostname);
        return handleSupabase(route, request, url);
    }
    externalBlocked.add(url.hostname);
    return route.abort();
}

// ── 工具
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
const pageErrors = [];
const TAIPEI_NOON = (date) => `${date}T12:00:00+08:00`;
const sessionById = (index) => world.sessions[index];
const rowsStatus = () => world.sessions.map(row => `${row.session_date}:${row.status}`).join(' ');

async function openAdmin(browser, base, { today, viewport = { width: 1280, height: 900 }, role = 'admin' }) {
    world.role = role;
    reqLog.length = 0;
    rpcCalls.length = 0;
    const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
    await context.clock.setFixedTime(new Date(TAIPEI_NOON(today)));
    await context.route('**/*', handleRoute);
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '報酬登記中心' }).waitFor({ timeout: 15000 });
    return { context, page };
}
const paidSection = (page) => page.locator('section[aria-labelledby="salary-period-paid-title"]');
const preview = (page) => paidSection(page).getByTestId('period-paid-preview');
async function waitPreview(page, pattern) {
    const deadline = Date.now() + 10000;
    let text = '';
    while (Date.now() < deadline) {
        text = (await preview(page).innerText()).trim();
        if (pattern.test(text)) return text;
        await page.waitForTimeout(150);
    }
    return text;
}
const statValue = async (page, label) => (await page.locator('.bh-card').filter({ has: page.getByText(label, { exact: true }) }).first().innerText())
    .replace(label, '').trim();
async function waitStat(page, label, expected) {
    const deadline = Date.now() + 10000;
    let value = '';
    while (Date.now() < deadline) {
        value = await statValue(page, label);
        if (value === expected) return value;
        await page.waitForTimeout(150);
    }
    return value;
}
const previewQueries = () => reqLog.filter(r => r.path === '/rest/v1/class_sessions' && new URLSearchParams(r.search).get('select') === 'id,total_salary,paid_amount,is_anomaly');
const optionTexts = (page) => paidSection(page).locator('select option').evaluateAll(options => options.map(o => ({ value: o.value, text: o.textContent, disabled: o.disabled })));

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

        // ════════ 1. 10/27：10月期（9/26～10/25）已結束、匯款日 11/10 還沒到 ════════
        console.log('\n── 1. admin，今天 2026-10-27（10月期已結束，匯款日 11/10）');
        world.sessions = seedSessions();
        world.rpcMode = 'ok';
        let { context, page } = await openAdmin(browser, base, { today: '2026-10-27' });
        let sectionEl = paidSection(page);
        await sectionEl.waitFor({ timeout: 15000 });
        const startButton = sectionEl.getByRole('button', { name: '本期匯款完成' });
        let text = await waitPreview(page, /將標記/);
        check('1a 看得到「本期匯款完成」區塊，「講師端匯款日」區塊也還在', await sectionEl.getByRole('heading', { name: '本期匯款完成' }).isVisible()
            && await page.locator('section[aria-labelledby="salary-payday-title"]').isVisible());
        check('1b 預設期別＝10月（目前這一期，已結束）', (await sectionEl.locator('select').inputValue()) === '2026/10', await sectionEl.locator('select').inputValue());
        const options1 = await optionTexts(page);
        check('1c 期別選單：10月、9月、8月、7月，都已結束可選', options1.map(o => `${o.text}${o.disabled ? '(停用)' : ''}`).join(' / ')
            === '10月（9/26～10/25） / 9月（8/26～9/25） / 8月（7/26～8/25） / 7月（6/26～7/25）', JSON.stringify(options1));
        check('1d 按鈕旁顯示「將標記 3 筆、共 $2,100（期間 9/26～10/25）」（9/25 與 10/26 不算；待核准、待定價、退回、已付款不算）',
            text === '將標記 3 筆、共 $2,100（期間 9/26～10/25）', text);
        check('1e 另列「另有 2 筆待核准，這次不會標記；核准後等實際匯款了再按一次。」（退回那筆不算待核准）',
            (await sectionEl.getByText('另有 2 筆待核准，這次不會標記；核准後等實際匯款了再按一次。').count()) === 1, await sectionEl.innerText());
        check('1e2 更早期別還沒標的已核准（9/25 那筆）另外提醒「更早的期別還有 1 筆已核准、還沒標已付款…請到下方紀錄逐筆處理。」',
            (await sectionEl.getByText('更早的期別還有 1 筆已核准、還沒標已付款（多半是晚核准的），這裡不會標到，請到下方紀錄逐筆處理。').count()) === 1);
        check('1e3 沒有異常、沒有先付過的列 → 不顯示這兩行提醒', (await sectionEl.getByText(/標「異常」|之前已記錄付過/).count()) === 0);
        check('1f 匯款日還沒到 → 提醒「這一期的匯款日是 11/10，請確認已實際匯款再標記。」',
            (await sectionEl.getByText('這一期的匯款日是 11/10，請確認已實際匯款再標記。').count()) === 1);
        const pq = new URLSearchParams(previewQueries().at(-1)?.search || '');
        check('1g 預覽查詢條件與資料庫函式相同：status=eq.approved、pricing_status=not.in.(needs_review,rejected)、session_date gte 9/26 且 lte 10/25',
            pq.get('status') === 'eq.approved' && pq.get('pricing_status') === 'not.in.(needs_review,rejected)'
            && pq.getAll('session_date').join(' ') === 'gte.2026-09-26 lte.2026-10-25', pq.toString());
        check('1h 還沒按之前沒有送出標記請求', rpcCalls.length === 0);
        const paidBefore = await statValue(page, '已付款');
        check('1i 統計卡「已付款」原本是 $999（10 月篩選）', paidBefore === '$999', paidBefore);
        await sectionEl.screenshot({ path: shot('admin-1280-section-preview.png') });

        // 第一步：按「本期匯款完成」→ 重新數一次 → 出現確認
        await startButton.click();
        const confirmBox = sectionEl.getByRole('group');
        await confirmBox.waitFor({ timeout: 10000 });
        const confirmText = (await confirmBox.innerText()).trim();
        check('1j 按「本期匯款完成」先出現確認：「確定要把 10月這 3 筆、共 $2,100（期間 9/26～10/25）標記為已付款嗎？」',
            confirmText.startsWith('確定要把 10月這 3 筆、共 $2,100（期間 9/26～10/25）標記為已付款嗎？'), confirmText);
        check('1k 出現確認時還沒送出標記請求；按下時有重新數一次（預覽查詢 ≥ 2 次）', rpcCalls.length === 0 && previewQueries().length >= 2, `rpc=${rpcCalls.length} preview=${previewQueries().length}`);
        check('1l 確認中「本期匯款完成」變成 disabled（不能再開第二個確認）', await startButton.isDisabled());
        await sectionEl.screenshot({ path: shot('admin-1280-confirm.png') });
        await confirmBox.getByRole('button', { name: '取消' }).click();
        check('1m 按「取消」→ 確認消失、沒有送出請求、資料沒變', (await sectionEl.getByRole('group').count()) === 0 && rpcCalls.length === 0
            && sessionById(1).status === 'approved');

        // 第二步：再開確認，連點兩下「確認標記」→ 只送出 1 次
        await startButton.click();
        await sectionEl.getByRole('group').waitFor({ timeout: 10000 });
        const confirmButton = sectionEl.getByRole('button', { name: '確認標記 3 筆' });
        await confirmButton.evaluate(button => { button.click(); button.click(); });
        await page.waitForTimeout(200);
        const submittingLabel = (await sectionEl.getByRole('group').count()) ? (await sectionEl.getByRole('group').innerText()) : '';
        check('1n 送出中按鈕顯示「標記中…」且 disabled（防連點）', submittingLabel.includes('標記中…')
            && await sectionEl.getByRole('button', { name: '標記中…' }).isDisabled(), submittingLabel);
        await sectionEl.getByText(/已把 \d+ 筆/).waitFor({ timeout: 10000 });
        check('1o 連點兩下只送出 1 次 mark_salary_period_paid', rpcCalls.length === 1, `rpc=${rpcCalls.length}`);
        check('1p 送出的參數是期間 2026-09-26～2026-10-25，並帶確認框的 3 筆、2100 給資料庫核對',
            rpcCalls[0]?.body?.p_period_start === '2026-09-26' && rpcCalls[0]?.body?.p_period_end === '2026-10-25'
            && rpcCalls[0]?.body?.p_expected_count === 3 && rpcCalls[0]?.body?.p_expected_amount === 2100, JSON.stringify(rpcCalls[0]?.body));
        check('1q 完成訊息「已把 3 筆、共 $2,100 標記為已付款（10月，9/26～10/25）。」',
            (await sectionEl.getByText('已把 3 筆、共 $2,100 標記為已付款（10月，9/26～10/25）。', { exact: true }).count()) === 1, await sectionEl.innerText());
        text = await waitPreview(page, /沒有待標記/);
        check('1r 完成後預覽重讀 →「這一期沒有待標記的已核准紀錄（期間 9/26～10/25）」、按鈕 disabled',
            text === '這一期沒有待標記的已核准紀錄（期間 9/26～10/25）' && await startButton.isDisabled(), text);
        const paidAfter = await waitStat(page, '已付款', '$2,099');
        const rpcAt = rpcCalls[0]?.at ?? Infinity;
        check('1s 完成後統計卡重讀：「已付款」$999 → $2,099（10 月的 800＋300）', paidAfter === '$2,099'
            && reqLog.some(r => r.at > rpcAt && r.path === '/rest/v1/class_sessions' && new URLSearchParams(r.search).get('select') === 'id,total_salary,paid_amount'), paidAfter);
        check('1t 假資料庫裡只有 9/26、10/7、10/25 三筆變成已付款（9/25、10/26、待核准、退回都沒動）',
            rowsStatus() === '2026-09-25:approved 2026-09-26:paid 2026-10-07:paid 2026-10-12:pending 2026-10-15:pending 2026-10-16:pending 2026-10-20:paid 2026-10-25:paid 2026-10-26:approved 2026-11-05:approved',
            rowsStatus());
        await sectionEl.screenshot({ path: shot('admin-1280-after-mark.png') });
        await page.screenshot({ path: shot('admin-1280-page-after-mark.png'), fullPage: false });
        await context.close();

        // ════════ 1b. 確認後、送出前又多了一筆 → 資料庫整批取消 ════════
        console.log('\n── 1b. 確認之後到送出之前資料有異動');
        world.sessions = seedSessions();
        ({ context, page } = await openAdmin(browser, base, { today: '2026-10-27' }));
        sectionEl = paidSection(page);
        await waitPreview(page, /將標記 3 筆/);
        await sectionEl.getByRole('button', { name: '本期匯款完成' }).click();
        await sectionEl.getByRole('group').waitFor({ timeout: 10000 });
        world.sessions.push(makeSession({ date: '2026-10-24', status: 'approved', total: 500 }));
        await sectionEl.getByRole('button', { name: '確認標記 3 筆' }).click();
        await sectionEl.getByRole('alert').waitFor({ timeout: 10000 });
        const driftText = (await sectionEl.getByRole('alert').innerText()).trim();
        check('1b 確認後多了一筆 → 紅字「這一期的紀錄剛剛有變動（確認時 3 筆、$2,100，現在 4 筆、$2,600），這次沒有標記任何紀錄，請重新確認。」',
            driftText === '這一期的紀錄剛剛有變動（確認時 3 筆、$2,100，現在 4 筆、$2,600），這次沒有標記任何紀錄，請重新確認。', driftText);
        check('1b2 資料完全沒被改（4 筆都還是已核准）', world.sessions.filter(r => r.status === 'approved' && r.session_date >= '2026-09-26' && r.session_date <= '2026-10-25').length === 4);
        text = await waitPreview(page, /將標記 4 筆/);
        check('1b3 預覽自動重讀成「將標記 4 筆、共 $2,600（期間 9/26～10/25）」，可以重新確認', text === '將標記 4 筆、共 $2,600（期間 9/26～10/25）'
            && await sectionEl.getByRole('button', { name: '本期匯款完成' }).isEnabled(), text);
        await context.close();

        // ════════ 1c. 有異常、之前付過一部分、溢付的列 → 預覽與確認框都點出來 ════════
        console.log('\n── 1c. 有異常、之前付過一部分、溢付的列');
        world.sessions = seedSessions();
        world.sessions[1].paid_amount = 1200;   // 9/26：總額 1000、已付 1200（溢付）
        world.sessions[2].paid_amount = 100;    // 10/7：總額 800、已付 100 → 這次匯 700
        world.sessions[7].is_anomaly = true;    // 10/25：標異常
        ({ context, page } = await openAdmin(browser, base, { today: '2026-10-27' }));
        sectionEl = paidSection(page);
        text = await waitPreview(page, /將標記 3 筆/);
        check('1c 預覽總額仍是 3 筆 $2,100（與資料庫函式回傳的總額一致）', text === '將標記 3 筆、共 $2,100（期間 9/26～10/25）', text);
        check('1c2 紅字「其中 1 筆標「異常」（可能重複登記），建議先到下方「異常」確認再標記。」',
            (await sectionEl.getByText('其中 1 筆標「異常」（可能重複登記），建議先到下方「異常」確認再標記。').count()) === 1, await sectionEl.innerText());
        check('1c3「其中 2 筆之前已記錄付過 $1,300，這次實際要匯 $1,000；標記後已領一律改成總額。有 1 筆已付超過總額，請先逐筆確認。」',
            (await sectionEl.getByText(/^其中 2 筆之前已記錄付過 \$1,300，這次實際要匯 \$1,000；標記後已領一律改成總額。\s*有 1 筆已付超過總額，請先逐筆確認。$/).count()) === 1,
            await sectionEl.innerText());
        await sectionEl.getByRole('button', { name: '本期匯款完成' }).click();
        await sectionEl.getByRole('group').waitFor({ timeout: 10000 });
        const confirm1c = (await sectionEl.getByRole('group').innerText()).trim();
        check('1c4 確認框也寫出「其中 1 筆標「異常」。這次實際要匯 $1,000。」', confirm1c.includes('其中 1 筆標「異常」。') && confirm1c.includes('這次實際要匯 $1,000。'), confirm1c);
        await sectionEl.screenshot({ path: shot('admin-1280-warnings-confirm.png') });
        await context.close();

        // ════════ 2. 10/21：10月期還沒結束 → 預設 9月期，10月不能選 ════════
        console.log('\n── 2. admin，今天 2026-10-21（10月期到 10/25 才結束）');
        world.sessions = seedSessions();
        ({ context, page } = await openAdmin(browser, base, { today: '2026-10-21' }));
        sectionEl = paidSection(page);
        text = await waitPreview(page, /將標記|沒有要標記/);
        check('2a 預設期別＝9月（目前這一期 10月還沒結束）', (await sectionEl.locator('select').inputValue()) === '2026/09', await sectionEl.locator('select').inputValue());
        const options2 = await optionTexts(page);
        check('2b 10月選項停用並註明「10/25 結束後才能標」', options2[0]?.value === '2026/10' && options2[0]?.disabled && options2[0]?.text === '10月（9/26～10/25）・10/25 結束後才能標'
            && options2.slice(1).every(o => !o.disabled), JSON.stringify(options2));
        check('2c 9月期預覽「將標記 1 筆、共 $5,000（期間 8/26～9/25）」（9/25 是 9月期終點）', text === '將標記 1 筆、共 $5,000（期間 8/26～9/25）', text);
        check('2d 過去期別不顯示匯款日提醒', (await sectionEl.getByText(/請確認已實際匯款再標記/).count()) === 0);
        check('2e 沒有送出標記請求', rpcCalls.length === 0);
        await sectionEl.screenshot({ path: shot('admin-1280-1021-default-september.png') });
        await context.close();

        // ════════ 3. 11/12：匯款日 11/10 過了 → 目前這一期換成 11月（未結束），預設仍是 10月 ════════
        console.log('\n── 3. admin，今天 2026-11-12（匯款日過了兩天才來按）');
        world.sessions = seedSessions();
        ({ context, page } = await openAdmin(browser, base, { today: '2026-11-12' }));
        sectionEl = paidSection(page);
        text = await waitPreview(page, /將標記|沒有要標記/);
        const options3 = await optionTexts(page);
        check('3a 預設期別仍是 10月（不會跳去還沒結束的 11月）', (await sectionEl.locator('select').inputValue()) === '2026/10', await sectionEl.locator('select').inputValue());
        check('3b 11月選項停用「11/25 結束後才能標」', options3[0]?.value === '2026/11' && options3[0]?.disabled && options3[0]?.text.endsWith('11/25 結束後才能標'), JSON.stringify(options3));
        check('3c 10月預覽仍是 3 筆 $2,100、沒有匯款日提醒', text === '將標記 3 筆、共 $2,100（期間 9/26～10/25）'
            && (await sectionEl.getByText(/請確認已實際匯款再標記/).count()) === 0, text);
        // 換期別 → 預覽跟著換
        await sectionEl.locator('select').selectOption('2026/09');
        text = await waitPreview(page, /8\/26～9\/25/);
        check('3d 改選 9月 → 預覽換成「將標記 1 筆、共 $5,000（期間 8/26～9/25）」', text === '將標記 1 筆、共 $5,000（期間 8/26～9/25）', text);
        await context.close();

        // ════════ 4. 錯誤 ════════
        console.log('\n── 4. 送出失敗的訊息');
        for (const [mode, expected] of [
            ['42501', '只有管理員可以標記匯款完成。'],
            ['missing', '需先套用資料庫更新（20261021233000_mark_salary_period_paid.sql）才能使用。'],
            ['22023', '這一期到 10/25 才結束，結束後才能標記已付款。'],
        ]) {
            world.sessions = seedSessions();
            world.rpcMode = mode;
            world.rpcDelayMs = 100;
            ({ context, page } = await openAdmin(browser, base, { today: '2026-10-27' }));
            sectionEl = paidSection(page);
            await waitPreview(page, /將標記 3 筆/);
            await sectionEl.getByRole('button', { name: '本期匯款完成' }).click();
            await sectionEl.getByRole('button', { name: '確認標記 3 筆' }).click();
            await sectionEl.getByRole('alert').waitFor({ timeout: 10000 });
            const alertText = (await sectionEl.getByRole('alert').innerText()).trim();
            const afterError = await waitPreview(page, /將標記 3 筆/);
            check(`4 ${mode} → 紅字「${expected}」、確認框收起、預覽重讀仍是 3 筆`, alertText === expected && (await sectionEl.getByRole('group').count()) === 0
                && afterError === '將標記 3 筆、共 $2,100（期間 9/26～10/25）', `${alertText} / ${afterError}`);
            if (mode === 'missing') await sectionEl.screenshot({ path: shot('admin-1280-error-migration-missing.png') });
            await context.close();
        }
        world.rpcMode = 'ok';
        world.rpcDelayMs = 800;

        // ════════ 5. 匯款日設定讀不到 ════════
        console.log('\n── 5. 匯款日設定讀不到（HTTP 500）');
        world.sessions = seedSessions();
        world.scheduleMode = 'error';
        ({ context, page } = await openAdmin(browser, base, { today: '2026-10-27' }));
        sectionEl = paidSection(page);
        text = await waitPreview(page, /將標記|沒有要標記/);
        check('5 仍以每月 10 號推算出 10月期並註明「匯款日設定暫時讀不到，期別先以每月 10 號推算。」',
            (await sectionEl.locator('select').inputValue()) === '2026/10' && text === '將標記 3 筆、共 $2,100（期間 9/26～10/25）'
            && (await sectionEl.getByText('（匯款日設定暫時讀不到，期別先以每月 10 號推算。）').count()) === 1, await sectionEl.innerText());
        world.scheduleMode = 'ok';
        await context.close();

        // ════════ 6. mentor ════════
        console.log('\n── 6. mentor 帳號進 /admin/salary');
        world.sessions = seedSessions();
        ({ context, page } = await openAdmin(browser, base, { today: '2026-10-27', role: 'mentor' }));
        await page.waitForTimeout(500);
        check('6 mentor 看不到「本期匯款完成」區塊，也沒有送出標記請求', (await page.getByText('本期匯款完成').count()) === 0
            && (await paidSection(page).count()) === 0 && rpcCalls.length === 0);
        await context.close();

        // ════════ 7. 手機 390px ════════
        console.log('\n── 7. 後台 390px 手機');
        world.sessions = seedSessions();
        ({ context, page } = await openAdmin(browser, base, { today: '2026-10-27', viewport: { width: 390, height: 844 } }));
        sectionEl = paidSection(page);
        await waitPreview(page, /將標記 3 筆/);
        await sectionEl.scrollIntoViewIfNeeded();
        const box = await sectionEl.boundingBox();
        const overflow = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
        check(`7a 390px 區塊完整在視窗內、頁面沒有水平捲軸（scrollWidth ${overflow[0]} ≤ ${overflow[1]}）`,
            box && box.x >= 0 && box.x + box.width <= 390.5 && overflow[0] <= overflow[1], JSON.stringify({ box, overflow }));
        const controls = await Promise.all([sectionEl.locator('select').boundingBox(), sectionEl.getByRole('button', { name: '本期匯款完成' }).boundingBox()]);
        check('7b 期別選單、按鈕高度 ≥ 44px 且在視窗內', controls.every(b => b && b.height >= 44 && b.x >= 0 && b.x + b.width <= 390.5), JSON.stringify(controls));
        await page.screenshot({ path: shot('admin-mobile-390-preview.png'), fullPage: false });
        await sectionEl.getByRole('button', { name: '本期匯款完成' }).click();
        const mConfirm = sectionEl.getByRole('group');
        await mConfirm.waitFor({ timeout: 10000 });
        await mConfirm.scrollIntoViewIfNeeded();
        const confirmButtons = await Promise.all([
            sectionEl.getByRole('button', { name: '確認標記 3 筆' }).boundingBox(),
            sectionEl.getByRole('button', { name: '取消' }).boundingBox(),
        ]);
        const overflow2 = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
        check('7c 手機上確認框的兩個按鈕 ≥ 44px、在視窗內，仍沒有水平捲軸',
            confirmButtons.every(b => b && b.height >= 44 && b.x >= 0 && b.x + b.width <= 390.5) && overflow2[0] <= overflow2[1], JSON.stringify({ confirmButtons, overflow2 }));
        await page.waitForTimeout(300);
        await page.screenshot({ path: shot('admin-mobile-390-confirm.png'), fullPage: false });
        await sectionEl.getByRole('button', { name: '確認標記 3 筆' }).click();
        await sectionEl.getByText(/已把 \d+ 筆/).waitFor({ timeout: 10000 });
        await waitPreview(page, /沒有待標記/);
        await sectionEl.scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        check('7d 手機上完成後訊息完整顯示、沒有水平捲軸', await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth));
        await page.screenshot({ path: shot('admin-mobile-390-after-mark.png'), fullPage: false });
        await context.close();

        // ════════ 全域 ════════
        console.log('\n── 全域');
        check(`所有 Supabase 請求都被 mock 攔截（只見到 ${[...supabaseHostsSeen].join(', ')}），沒有白名單以外的請求`, unexpected.length === 0, unexpected.slice(0, 5).join(' | '));
        check('Supabase 請求主機只有 .env 設定的那一台（一律被 page.route 攔截，沒有 route.continue）', [...supabaseHostsSeen].every(h => h === supabaseHost));
        check('沒有前端未捕捉例外（pageerror）', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
        console.log(`(被擋下的非 Supabase 外部請求主機：${[...externalBlocked].join(', ') || '無'})`);
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
