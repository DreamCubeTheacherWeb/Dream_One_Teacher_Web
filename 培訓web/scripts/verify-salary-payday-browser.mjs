#!/usr/bin/env node
// 講師「我的報酬」黃卡（X月累計報酬＋M/D 匯款）與後台「講師端匯款日」設定：mock Supabase 真瀏覽器驗證。
// 做法同 verify-salary-register-paging-browser.mjs：本機 vite dev＋本機 Chrome＋localStorage 塞假 session，
// 所有 Supabase 網域請求都由 page.route 攔截回假資料；沒列在白名單的請求一律回 404 並讓腳本 FAIL，絕不放行到正式站。
// 「今天」用 Playwright clock.setFixedTime 固定（台北時間），結果才是確定的。
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
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-salary-payday');
mkdirSync(shotDir, { recursive: true });
const shot = (name) => path.join(shotDir, name);

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const supabaseHost = new URL(env.VITE_SUPABASE_URL).hostname;
const projectRef = supabaseHost.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000091';
const OWN = '10000000-0000-4000-8000-000000000091';   // 測試講師本人
const OTHER = '10000000-0000-4000-8000-000000000092'; // 別的講師（誤把全體算進來金額就會超出）
const now = new Date().toISOString();
const COURSE_TYPE = Object.keys(COURSE_LABELS)[0];

// ── 假資料：講師本人 2026/09～2026/12，另有別人的紀錄（金額 9,999，被算進來就會爆）
let seq = 0;
const makeSession = ({ instructor = OWN, name = '薪資測試講師', date, status, pricing = 'quoted', total }) => {
    seq += 1;
    return {
        id: `40000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        instructor_id: instructor, instructor_name: name, instructor_role_at_time: 'A',
        speed_qualification_at_time: null, role_in_session: 'lead',
        course_type: COURSE_TYPE, course_name: null,
        session_date: date, month_label: date.slice(0, 7).replace('-', '/'),
        duration_hours: 1.5, student_count: 3,
        base_salary: pricing === 'needs_review' ? null : total, bonus: 0,
        total_salary: pricing === 'needs_review' ? null : total,
        paid_amount: status === 'paid' ? total : 0,
        status, pricing_status: pricing, pricing_message: pricing === 'rejected' ? '測試退回原因' : null,
        is_anomaly: false, anomaly_reasons: [],
        term_period: null, unit_name: null, materials_issued: null,
        transport_subsidy_requested: false, transport_distance_km: null,
        source: 'report', created_at: now,
    };
};
const SESSIONS = [
    // 2026/10：已付款 1000、已核准 800、待核准 600、尚無金額 1 筆、退回 1 筆（450，不算）
    makeSession({ date: '2026-10-03', status: 'paid', total: 1000 }),
    makeSession({ date: '2026-10-07', status: 'approved', total: 800 }),
    makeSession({ date: '2026-10-12', status: 'pending', total: 600 }),
    makeSession({ date: '2026-10-15', status: 'pending', pricing: 'needs_review', total: null }),
    makeSession({ date: '2026-10-16', status: 'pending', pricing: 'rejected', total: 450 }),
    // 2026/09
    makeSession({ date: '2026-09-05', status: 'paid', total: 500 }),
    makeSession({ date: '2026-09-12', status: 'paid', total: 700 }),
    makeSession({ date: '2026-09-19', status: 'approved', total: 900 }),
    // 2026/11、2026/12（讓「今天」被固定到之後時，換月的金額也能核對）
    makeSession({ date: '2026-11-02', status: 'approved', total: 1200 }),
    makeSession({ date: '2026-11-09', status: 'pending', total: 300 }),
    makeSession({ date: '2026-12-03', status: 'approved', total: 700 }),
    // 別的講師
    makeSession({ instructor: OTHER, name: '其他講師', date: '2026-10-05', status: 'approved', total: 9999 }),
    makeSession({ instructor: OTHER, name: '其他講師', date: '2026-11-05', status: 'approved', total: 9999 }),
    makeSession({ instructor: OTHER, name: '其他講師', date: '2026-12-05', status: 'approved', total: 9999 }),
];
const SUMMARY = {
    user_id: userId, instructor_id: OWN, full_name: '薪資測試講師',
    this_month_salary: 2400, this_month_sessions: 4, this_year_salary: 22000,
    total_salary: 31000, total_sessions: 20, total_hours: 40.5,
    pending_salary: 1200, paid_salary: 18650,
};
const TEACHER_INSTRUCTOR = {
    id: OWN, user_id: userId, full_name: '薪資測試講師', nickname: '薪資測試講師',
    gender: '男', birth_date: '1990-01-01', id_number: 'A123456789', phone_mobile: '0912345678',
    line_id: 'payday-test', address: '測試通訊地址', household_address: '測試戶籍地址',
    email_primary: 'payday-teacher@test.local', instructor_role: 'A', speed_qualification: null,
    employment_status: 'active', teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次',
    teaching_regions: ['臺北市'], bio_notes: '測試講師', bank_account_name: '薪資測試講師',
    bank_name: '測試銀行', bank_branch: '測試分行', bank_account_number: '0000000000', bank_code: '0000000',
    photo_path: null, photo_external_url: null, id_front_path: 'test/id-front.png', id_back_path: 'test/id-back.png',
    bankbook_path: 'test/bankbook.png', created_at: now,
};

// ── mock 的資料庫狀態（腳本會在各情境之間改它）
const world = {
    role: 'teacher',
    scheduleMode: 'ok',  // ok | missing（PGRST205）| error（HTTP 500）
    schedule: { id: true, next_payday: '2026-11-10', regular_day: 10, updated_at: now, updated_by: userId },
};
const setSchedule = (nextPayday, regularDay) => {
    world.schedule = { ...world.schedule, next_payday: nextPayday, regular_day: regularDay };
};
const reqLog = [];       // 所有 Supabase 請求
const patches = [];      // 對 salary_payout_schedule 的 PATCH
const unexpected = [];   // 白名單以外的 Supabase 請求（有就 FAIL）
const externalBlocked = new Set();
const supabaseHostsSeen = new Set();

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, data, status = 200, headers = {}) => route.fulfill({
    status, headers: { 'content-type': 'application/json', ...CORS, ...headers }, body: JSON.stringify(data),
});

// ── 簡化版 PostgREST（取自 paging 腳本）：不認得的條件一律 400
const STATUS_RANK = { pending: 0, approved: 1, paid: 2 };
const KNOWN_PARAMS = new Set(['select', 'order', 'offset', 'limit', 'session_date', 'status', 'is_anomaly', 'pricing_status', 'or', 'id', 'instructor_id']);
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
    for (const column of ['status', 'pricing_status', 'id', 'instructor_id']) {
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

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'payday-test@test.local',
    user_metadata: { full_name: '匯款日測試帳號' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.salary.payday', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(new Date('2030-01-01T00:00:00Z').getTime() / 1000), user: authUser,
};

const MISSING_TABLE_BODY = { code: 'PGRST205', message: "Could not find the table 'public.salary_payout_schedule' in the schema cache", details: null, hint: "Perhaps you meant the table 'public.site_links'" };

async function handleSupabase(route, request, url) {
    const method = request.method();
    const params = new URLSearchParams(url.search);
    const entry = { method, path: url.pathname, search: url.search };
    reqLog.push(entry);
    const reject = (why) => {
        unexpected.push(`${method} ${url.pathname}${url.search}  (${why})`);
        return json(route, { code: 'MOCK_UNEXPECTED', message: `verify script did not expect: ${why}` }, 404);
    };
    const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
    const wantsCount = (((await request.allHeaders()).prefer) || '').includes('count=exact');

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, session);
        return json(route, {});
    }
    // AuthContext 找不到講師頭貼時才會碰 storage；這裡 photo_path 為 null，正常不會有請求
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.replace('/rest/v1/rpc/', '');
        if (['claim_my_precreated_instructor', 'ensure_my_contract_reminder'].includes(name) && method === 'POST') return json(route, null);
        return reject(`rpc ${name}`);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return reject('not a rest/auth path');
    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];

    if (table === 'salary_payout_schedule') {
        if (world.scheduleMode === 'missing') return json(route, MISSING_TABLE_BODY, 404);
        if (world.scheduleMode === 'error') return json(route, { code: 'XX000', message: 'mock internal error', details: null, hint: null }, 500);
        if (method === 'GET') {
            if (params.get('select') !== 'next_payday,regular_day' || [...params.keys()].some(k => k !== 'select')) return reject('schedule GET with unexpected params');
            const row = { next_payday: world.schedule.next_payday, regular_day: world.schedule.regular_day };
            return json(route, acceptsObject ? row : [row]);
        }
        if (method === 'PATCH') {
            const body = request.postDataJSON();
            patches.push({ search: url.search, params, body, headers: request.headers() });
            if (params.get('id') !== 'eq.true') return reject('schedule PATCH without id=eq.true');
            setSchedule(body.next_payday ?? world.schedule.next_payday, body.regular_day ?? world.schedule.regular_day);
            const row = { next_payday: world.schedule.next_payday, regular_day: world.schedule.regular_day };
            return json(route, acceptsObject ? row : [row]);
        }
        return reject(`schedule ${method}`);
    }

    if (table === 'users' && method === 'GET') {
        const row = { id: userId, name: '匯款日測試帳號', email: authUser.email, role: world.role, created_at: now };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'instructors' && method === 'GET') {
        if (params.get('user_id')) {  // 本人的講師主檔（AuthContext、ProfileCompleteGate）
            if (params.get('user_id') !== `eq.${userId}`) return reject('instructors for another user');
            const rows = world.role === 'teacher' ? [TEACHER_INSTRUCTOR] : [];
            return json(route, acceptsObject ? (rows[0] ?? null) : rows);
        }
        const list = [
            { id: OWN, full_name: '薪資測試講師', instructor_role: 'A', speed_qualification: null },
            { id: OTHER, full_name: '其他講師', instructor_role: 'A', speed_qualification: null },
        ];
        return json(route, acceptsObject ? null : list);
    }
    if (table === 'instructor_salary_summary' && method === 'GET') {
        if (params.get('user_id') !== `eq.${userId}`) return reject('summary not filtered to the signed-in user');
        return json(route, acceptsObject ? SUMMARY : [SUMMARY]);
    }
    if (table === 'class_sessions') {
        if (!['GET', 'HEAD'].includes(method)) return reject(`class_sessions ${method}`);
        // 講師端一定要帶「本人」條件；沒帶就等於把全體講師的紀錄都抓下來
        if (world.role === 'teacher' && params.get('instructor_id') !== `eq.${OWN}`) return reject('teacher class_sessions not filtered to own instructor');
        let rows;
        try { rows = SESSIONS.filter(compileFilters(params)); } catch (error) { return json(route, { code: 'PGRST100', message: error.message }, 400); }
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
async function newContext(browser, { viewport, now: fixedNow }) {
    const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
    await context.clock.setFixedTime(new Date(fixedNow));
    await context.route('**/*', handleRoute);
    return context;
}
async function newPage(context) {
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(String(error)));
    return page;
}
// 固定「台北時間」的今天：中午 12 點（一般情境）／凌晨 00:30（跨 UTC 日期的邊界情境，UTC 還停在前一天）
const TAIPEI_NOON = (date) => `${date}T12:00:00+08:00`;
const TAIPEI_AFTER_MIDNIGHT = (date) => `${date}T00:30:00+08:00`;

const yellowCard = (page) => page.locator('div.bg-bauhaus-yellow.rounded-2xl').filter({ hasText: '累計報酬' });
async function readCard(page) {
    const card = yellowCard(page);
    await card.first().waitFor({ timeout: 15000 });
    const text = async (selector) => (await card.locator(selector).first().textContent())?.trim() ?? '';
    return {
        cards: await card.count(),
        title: await text('div.uppercase'),
        value: await text('div.text-3xl'),
        badge: await text('span.rounded-full'),
        sub: (await card.locator('div.text-xs').count()) ? await text('div.text-xs') : '',
    };
}
// 等黃卡變成預期內容（頁面先用預設值畫一次，匯款日設定回來後才更新），逾時就回最後一次讀到的樣子
async function waitCard(page, expected) {
    let last = null;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        last = await readCard(page);
        if (last.title === expected.title && last.badge === expected.badge) return last;
        await page.waitForTimeout(200);
    }
    return last;
}
async function openTeacher(page, base) {
    await page.goto(`${base}/my/salary`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '我的報酬', exact: true }).waitFor({ timeout: 15000 });
}
const miniStatValue = (page, label) => page.locator('.bh-card').filter({ has: page.getByText(label, { exact: true }) }).locator('div.text-lg').first().textContent();
const bodyText = (page) => page.locator('body').innerText();
const scheduleGets = () => reqLog.filter(r => r.path === '/rest/v1/salary_payout_schedule' && r.method === 'GET');

async function geometry(page) {
    return page.evaluate(() => {
        const card = [...document.querySelectorAll('div.bg-bauhaus-yellow.rounded-2xl')].find(el => el.textContent.includes('累計報酬'));
        const title = card.querySelector('div.uppercase');
        const badge = card.querySelector('span.rounded-full');
        const rc = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        return {
            card: rc(card), title: rc(title), badge: rc(badge),
            titleScroll: [title.scrollWidth, title.clientWidth], badgeScroll: [badge.scrollWidth, badge.clientWidth],
            cardScroll: [card.scrollWidth, card.clientWidth], docScroll: [document.scrollingElement.scrollWidth, window.innerWidth],
        };
    });
}
const intersects = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const f = (n) => Math.round(n * 10) / 10;
function checkLayout(label, g) {
    const box = (r) => `[${f(r.l)}–${f(r.r)}, ${f(r.t)}–${f(r.b)}]`;
    const detail = `card${box(g.card)} title${box(g.title)} badge${box(g.badge)} doc=${g.docScroll}`;
    check(`${label}：膠囊完整在黃卡內（右緣 ≤ 卡片右緣）`, g.badge.r <= g.card.r + 0.5 && g.badge.l >= g.card.l - 0.5 && g.badge.t >= g.card.t - 0.5 && g.badge.b <= g.card.b + 0.5, detail);
    check(`${label}：標題完整在黃卡內`, g.title.l >= g.card.l - 0.5 && g.title.r <= g.card.r + 0.5, detail);
    check(`${label}：標題與膠囊沒有重疊`, !intersects(g.title, g.badge), detail);
    check(`${label}：標題、膠囊、卡片內容都沒有被截斷或溢出`,
        g.titleScroll[0] <= g.titleScroll[1] + 1 && g.badgeScroll[0] <= g.badgeScroll[1] + 1 && g.cardScroll[0] <= g.cardScroll[1] + 1,
        JSON.stringify({ title: g.titleScroll, badge: g.badgeScroll, card: g.cardScroll }));
    check(`${label}：頁面沒有水平捲軸（scrollWidth ${g.docScroll[0]} ≤ 視窗 ${g.docScroll[1]}）`, g.docScroll[0] <= g.docScroll[1]);
}

// ── 講師端情境
async function teacherScenario(browser, base, { id, now: fixedNow, schedule, mode = 'ok', viewport = { width: 1280, height: 900 }, expected, screenshots = [] }) {
    world.role = 'teacher';
    world.scheduleMode = mode;
    if (schedule) setSchedule(schedule.next_payday, schedule.regular_day);
    reqLog.length = 0;
    const context = await newContext(browser, { viewport, now: fixedNow });
    const page = await newPage(context);
    await openTeacher(page, base);
    const card = await waitCard(page, expected);
    const label = `${id}`;
    check(`${label}：黃卡只有一張，標題「${expected.title}」`, card.cards === 1 && card.title === expected.title, JSON.stringify(card));
    check(`${label}：金額 ${expected.value}`, card.value === expected.value, JSON.stringify(card));
    check(`${label}：膠囊「${expected.badge}」`, card.badge === expected.badge, JSON.stringify(card));
    check(`${label}：副標「${expected.sub || '（無）'}」`, card.sub === expected.sub, JSON.stringify(card));
    return { context, page, card };
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

        // ════════ 1. 講師桌機：今天 2026-10-20，匯款日 11/10 ════════
        console.log('\n── 1. 講師端（今天 2026-10-20 台北、匯款日設定 2026-11-10／每月 10）');
        const OCT = { title: '10月累計報酬', value: '$2,400', badge: '11/10 匯款', sub: '4 場・含待核准 $600・1 筆待確認金額' };
        let { context, page } = await teacherScenario(browser, base, {
            id: '情境1 桌機 10/20', now: TAIPEI_NOON('2026-10-20'), schedule: { next_payday: '2026-11-10', regular_day: 10 }, expected: OCT,
        });
        check('情境1：副標含「4 場」「含待核准 $600」「1 筆待確認金額」',
            (await readCard(page)).sub.includes('4 場') && (await readCard(page)).sub.includes('含待核准 $600') && (await readCard(page)).sub.includes('1 筆待確認金額'));
        check('情境1：有讀「匯款日設定」（GET salary_payout_schedule select=next_payday,regular_day）', scheduleGets().length >= 1);
        const text1 = await bodyText(page);
        check('情境1：頁面不再出現「未領金額」', !text1.includes('未領金額'));
        check('情境1：頁面不再出現「已核准未付」', !text1.includes('已核准未付'));
        check('情境1：頁面不再出現「已領」', !text1.includes('已領'));
        check('情境1：四個小卡最後一格是「已匯款」，金額 = summary.paid_salary（$18,650）',
            (await page.getByText('已匯款', { exact: true }).count()) === 1 && (await miniStatValue(page, '已匯款'))?.trim() === '$18,650',
            `${await miniStatValue(page, '已匯款')}`);
        check('情境1：其他小卡沒被動到（累計總報酬 $31,000、待核准 $1,200）',
            (await miniStatValue(page, '累計總報酬'))?.trim() === '$31,000' && (await miniStatValue(page, '待核准'))?.trim() === '$1,200');
        check('情境1：講師端只抓本人紀錄（class_sessions 帶 instructor_id=eq.本人），別人的 $9,999 沒被算進來',
            reqLog.some(r => r.path === '/rest/v1/class_sessions' && new URLSearchParams(r.search).get('instructor_id') === `eq.${OWN}`) && card0Value(await readCard(page)) === 2400);
        check('情境1：沒有紅色錯誤畫面', (await page.getByRole('alert').count()) === 0 && !(await bodyText(page)).includes('暫時無法載入'));
        await page.screenshot({ path: shot('teacher-desktop-1280-2026-10-20.png'), fullPage: true });
        await yellowCard(page).screenshot({ path: shot('teacher-desktop-card-crop-2026-10-20.png') });
        await context.close();

        // ════════ 2. 今天 2026-11-11（台北凌晨 00:30，UTC 還是 11-10）════════
        console.log('\n── 2. 今天 2026-11-11（同一份設定；台北 00:30，UTC 仍是 11-10，故意測時區邊界）');
        const NOV = { title: '11月累計報酬', value: '$1,500', badge: '12/10 匯款', sub: '2 場・含待核准 $300' };
        ({ context, page } = await teacherScenario(browser, base, {
            id: '情境2 桌機 11/11', now: TAIPEI_AFTER_MIDNIGHT('2026-11-11'), schedule: { next_payday: '2026-11-10', regular_day: 10 }, expected: NOV,
        }));
        await page.screenshot({ path: shot('teacher-desktop-1280-2026-11-11.png'), fullPage: true });
        await context.close();

        // ════════ 3. 設定 12/09，今天 2026-12-10 ════════
        console.log('\n── 3. 設定改成 2026-12-09、今天 2026-12-10（台北 00:30，UTC 仍是 12-09）');
        const DEC = { title: '12月累計報酬', value: '$700', badge: '1/10 匯款', sub: '1 場' };
        ({ context, page } = await teacherScenario(browser, base, {
            id: '情境3 桌機 12/10', now: TAIPEI_AFTER_MIDNIGHT('2026-12-10'), schedule: { next_payday: '2026-12-09', regular_day: 10 }, expected: DEC,
        }));
        check('情境3：沒有待核准、沒有待確認金額時副標只有場次（不出現「含待核准」「待確認金額」）',
            !(await readCard(page)).sub.includes('含待核准') && !(await readCard(page)).sub.includes('待確認金額'));
        await page.screenshot({ path: shot('teacher-desktop-1280-2026-12-10.png'), fullPage: true });
        await context.close();

        // ════════ 4. 設定表不存在 / 後端錯誤：照常顯示 ════════
        console.log('\n── 4. 匯款日設定讀不到（表不存在 PGRST205 / 伺服器 500）：用每月 10 號，頁面照常');
        ({ context, page } = await teacherScenario(browser, base, {
            id: '情境4 表不存在 404', now: TAIPEI_NOON('2026-10-20'), schedule: { next_payday: '2026-11-10', regular_day: 10 }, mode: 'missing',
            expected: { title: '10月累計報酬', value: '$2,400', badge: '11/10 匯款', sub: OCT.sub },
        }));
        check('情境4：確實打了 salary_payout_schedule 且被回 404（不是沒讀）', scheduleGets().length >= 1);
        check('情境4：沒有紅色錯誤畫面、「我的報酬」其他區塊都在',
            (await page.getByRole('alert').count()) === 0 && !(await bodyText(page)).includes('暫時無法載入')
            && (await page.getByRole('heading', { name: '報酬確認區', exact: true }).isVisible()) && (await page.getByText('累計總報酬', { exact: true }).isVisible()));
        await page.screenshot({ path: shot('teacher-desktop-1280-schedule-table-missing.png'), fullPage: true });
        await context.close();

        ({ context, page } = await teacherScenario(browser, base, {
            // 2026-10-20 審查建議 5：讀取失敗（不是表還沒建）時註明「預估」，不默默當成確定日期
            id: '情境4b 後端 500', now: TAIPEI_NOON('2026-10-20'), mode: 'error',
            expected: { title: '10月累計報酬', value: '$2,400', badge: '11/10 匯款（預估）', sub: OCT.sub },
        }));
        check('情境4b：後端 500 時同樣沒有紅色錯誤畫面', (await page.getByRole('alert').count()) === 0 && !(await bodyText(page)).includes('暫時無法載入'));
        await context.close();

        // ════════ 5. 每月固定日不是 10（證明 regular_day 真的有讀到）════════
        console.log('\n── 5. 設定 2026-10-14／每月 15，今天 2026-10-20 → 跳到 11/15（證明有讀 regular_day，不是靠預設 10）');
        ({ context, page } = await teacherScenario(browser, base, {
            id: '情境5 每月15號', now: TAIPEI_NOON('2026-10-20'), schedule: { next_payday: '2026-10-14', regular_day: 15 }, mode: 'ok',
            expected: { title: '10月累計報酬', value: '$2,400', badge: '11/15 匯款', sub: OCT.sub },
        }));
        await context.close();
        setSchedule('2026-11-10', 10);

        // ════════ 6. 手機 390px ════════
        console.log('\n── 6. 講師端 390px 手機');
        ({ context, page } = await teacherScenario(browser, base, {
            id: '情境6 手機390 10/20', now: TAIPEI_NOON('2026-10-20'), schedule: { next_payday: '2026-11-10', regular_day: 10 },
            viewport: { width: 390, height: 844 }, expected: OCT,
        }));
        checkLayout('390px 10月卡', await geometry(page));
        await page.screenshot({ path: shot('teacher-mobile-390-2026-10-20.png'), fullPage: true });
        await yellowCard(page).screenshot({ path: shot('teacher-mobile-390-card-crop-2026-10-20.png') });
        await context.close();

        // 最寬的膠囊「12/10 匯款」＋「11月」＋較長副標，再驗一次 390px 與較窄的 320px（加碼）
        ({ context, page } = await teacherScenario(browser, base, {
            id: '情境6b 手機390 11/11', now: TAIPEI_AFTER_MIDNIGHT('2026-11-11'), schedule: { next_payday: '2026-11-10', regular_day: 10 },
            viewport: { width: 390, height: 844 }, expected: NOV,
        }));
        checkLayout('390px 11月卡（膠囊 12/10 匯款）', await geometry(page));
        await page.screenshot({ path: shot('teacher-mobile-390-2026-11-11.png'), fullPage: true });
        await context.close();

        ({ context, page } = await teacherScenario(browser, base, {
            id: '加碼 手機320 11/11', now: TAIPEI_AFTER_MIDNIGHT('2026-11-11'), schedule: { next_payday: '2026-11-10', regular_day: 10 },
            viewport: { width: 320, height: 640 }, expected: NOV,
        }));
        checkLayout('加碼 320px 11月卡', await geometry(page));
        await page.screenshot({ path: shot('teacher-mobile-320-2026-11-11.png'), fullPage: true });
        await context.close();

        // ════════ 後台 ════════
        console.log('\n── 後台（admin，今天 2026-10-20）：/admin/salary「講師端匯款日」');
        world.role = 'admin';
        world.scheduleMode = 'ok';
        setSchedule('2026-11-10', 10);
        reqLog.length = 0;
        patches.length = 0;
        context = await newContext(browser, { viewport: { width: 1280, height: 900 }, now: TAIPEI_NOON('2026-10-20') });
        page = await newPage(context);
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor({ timeout: 15000 });
        const section = page.locator('section[aria-labelledby="salary-payday-title"]');
        const dateInput = section.locator('input[type="date"]');
        const daySelect = section.locator('select');
        const saveButton = section.getByRole('button', { name: /儲存/ });
        const current = section.getByTestId('payday-current');
        await dateInput.waitFor({ timeout: 15000 });

        check('後台7：看得到「講師端匯款日」區塊', await section.getByRole('heading', { name: '講師端匯款日' }).isVisible());
        check('後台7：顯示「講師目前看到：10月累計報酬・11/10 匯款」', (await current.innerText()).trim() === '講師目前看到：10月累計報酬・11/10 匯款', await current.innerText());
        check('後台7：日期輸入框值 2026-11-10、每月固定 10', (await dateInput.inputValue()) === '2026-11-10' && (await daySelect.inputValue()) === '10',
            `${await dateInput.inputValue()} / ${await daySelect.inputValue()}`);
        check('後台9：沒改任何東西時「儲存」是 disabled', await saveButton.isDisabled());
        check('後台：後台讀設定帶的是 select=next_payday,regular_day', scheduleGets().length >= 1);
        await section.screenshot({ path: shot('admin-desktop-1280-payday-section.png') });
        await page.screenshot({ path: shot('admin-desktop-1280-page.png'), fullPage: false });

        // 9. 選今天以前
        patches.length = 0;
        await dateInput.fill('2026-10-19');
        check('後台9：日期選今天以前（2026-10-19）→ 瀏覽器判定低於下限 min', await dateInput.evaluate(el => el.validity.rangeUnderflow));
        check('後台9：選過去日期時不顯示「儲存後講師會看到」預覽', (await section.getByText(/儲存後講師會看到/).count()) === 0);
        if (await saveButton.isEnabled()) await saveButton.click();
        await page.waitForTimeout(600);
        check('後台9：按「儲存」不會送出請求（瀏覽器驗證擋下）', patches.length === 0, `patches=${patches.length}`);
        // 繞過瀏覽器驗證直接送出 submit 事件，測程式碼本身的防呆
        await section.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await page.waitForTimeout(600);
        check('後台9：即使繞過瀏覽器驗證直接送 submit，程式也擋下（顯示「請選今天或之後的日期。」、沒有請求）',
            patches.length === 0 && (await section.getByText('請選今天或之後的日期。').count()) === 1, `patches=${patches.length}`);
        await section.screenshot({ path: shot('admin-desktop-1280-past-date-blocked.png') });

        // 改回原值 → 又變回 disabled
        await dateInput.fill('2026-11-10');
        check('後台9：改回原本的日期後「儲存」又變回 disabled', await saveButton.isDisabled());

        // 8. 改成 2026-12-09
        await dateInput.fill('2026-12-09');
        const previewText = '儲存後講師會看到「11月累計報酬・12/9 匯款」';
        check(`後台8：改日期為 2026-12-09 → 出現預覽「${previewText}」`, (await section.getByText(previewText).count()) === 1,
            await section.innerText());
        check('後台8：改完「儲存」變成可按', await saveButton.isEnabled());
        await section.screenshot({ path: shot('admin-desktop-1280-preview.png') });
        patches.length = 0;
        await saveButton.click();
        await section.getByText(/已儲存/).waitFor({ timeout: 10000 });
        check('後台8：按儲存後只送出 1 次 PATCH', patches.length === 1, `patches=${patches.length}`);
        const patch = patches[0];
        console.log(`      ↳ 攔截到的請求：PATCH /rest/v1/salary_payout_schedule${patch?.search}  body=${JSON.stringify(patch?.body)}`);
        check('後台8：PATCH 網址條件含 id=eq.true', patch?.params.get('id') === 'eq.true', patch?.search);
        check('後台8：PATCH body 只含 next_payday 與 regular_day（不含 updated_by／id）',
            JSON.stringify(Object.keys(patch?.body ?? {}).sort()) === JSON.stringify(['next_payday', 'regular_day'])
            && patch.body.next_payday === '2026-12-09' && patch.body.regular_day === 10, JSON.stringify(patch?.body));
        check('後台8：成功後顯示「已儲存」訊息與新的「講師目前看到」',
            (await section.getByText('已儲存。講師現在看到「11月累計報酬・12/9 匯款」。').count()) === 1
            && (await current.innerText()).trim() === '講師目前看到：11月累計報酬・12/9 匯款', await section.innerText());
        check('後台8：儲存後「儲存」鈕回到 disabled、預覽消失', (await saveButton.isDisabled()) && (await section.getByText(/儲存後講師會看到/).count()) === 0);
        await section.screenshot({ path: shot('admin-desktop-1280-after-save.png') });

        // 重新整理仍是新日期（資料真的寫進 mock 資料庫）
        await page.reload({ waitUntil: 'networkidle' });
        await dateInput.waitFor({ timeout: 15000 });
        check('後台8：重新整理後日期仍是 2026-12-09', (await dateInput.inputValue()) === '2026-12-09' && (await current.innerText()).trim() === '講師目前看到：11月累計報酬・12/9 匯款');
        await context.close();

        // 8 延伸：剛存的日期，講師端真的看到
        console.log('\n── 後台→講師端：admin 剛存的 12/9，講師開「我的報酬」');
        ({ context, page } = await teacherScenario(browser, base, {
            id: '後台存檔→講師端', now: TAIPEI_NOON('2026-10-20'), mode: 'ok',
            expected: { title: '11月累計報酬', value: '$1,500', badge: '12/9 匯款', sub: '2 場・含待核准 $300' },
        }));
        await context.close();

        // 10. 表不存在
        console.log('\n── 後台：匯款日設定表不存在（PGRST205）');
        world.role = 'admin';
        world.scheduleMode = 'missing';
        setSchedule('2026-11-10', 10);
        context = await newContext(browser, { viewport: { width: 1280, height: 900 }, now: TAIPEI_NOON('2026-10-20') });
        page = await newPage(context);
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor({ timeout: 15000 });
        const missingSection = page.locator('section[aria-labelledby="salary-payday-title"]');
        await missingSection.getByText(/需先套用資料庫更新/).waitFor({ timeout: 10000 });
        check('後台10：表不存在時顯示「需先套用資料庫更新」', (await missingSection.getByText(/需先套用資料庫更新/).count()) === 1);
        check('後台10：不顯示表單（沒有日期框、沒有儲存鈕、沒有「講師目前看到」）',
            (await missingSection.locator('input[type="date"]').count()) === 0 && (await missingSection.getByRole('button').count()) === 0
            && (await missingSection.getByText(/講師目前看到/).count()) === 0);
        check('後台10：報酬登記中心其餘部分照常（頁面標題在、沒有整頁錯誤）', (await page.getByRole('heading', { name: '報酬登記中心' }).isVisible()) && (await page.getByText('這個頁面暫時無法顯示').count()) === 0);
        await missingSection.screenshot({ path: shot('admin-desktop-1280-table-missing.png') });
        await context.close();

        // 10b. 後端 500 → 錯誤提示可重試
        world.scheduleMode = 'error';
        context = await newContext(browser, { viewport: { width: 1280, height: 900 }, now: TAIPEI_NOON('2026-10-20') });
        page = await newPage(context);
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        const errSection = page.locator('section[aria-labelledby="salary-payday-title"]');
        await errSection.getByText('匯款日設定暫時讀不到。').waitFor({ timeout: 10000 });
        check('後台10b：後端 500 時顯示「匯款日設定暫時讀不到」與「重新載入」，不顯示表單',
            (await errSection.getByRole('button', { name: '重新載入' }).isVisible()) && (await errSection.locator('input[type="date"]').count()) === 0);
        world.scheduleMode = 'ok';
        await errSection.getByRole('button', { name: '重新載入' }).click();
        await errSection.locator('input[type="date"]').waitFor({ timeout: 10000 });
        check('後台10b：後端恢復後按「重新載入」→ 表單出現', (await errSection.locator('input[type="date"]').inputValue()) !== '');
        await context.close();

        // 11. mentor
        console.log('\n── 後台：mentor 帳號進 /admin/salary');
        world.role = 'mentor';
        world.scheduleMode = 'ok';
        reqLog.length = 0;
        context = await newContext(browser, { viewport: { width: 1280, height: 900 }, now: TAIPEI_NOON('2026-10-20') });
        page = await newPage(context);
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor({ timeout: 15000 });
        await page.waitForTimeout(500);
        check('後台11：mentor 進得了報酬登記中心（路由 staffOnly）', await page.getByRole('heading', { name: '報酬登記中心' }).isVisible());
        check('後台11：mentor 看不到「講師端匯款日」區塊', (await page.getByText('講師端匯款日').count()) === 0 && (await page.locator('input[type="date"]').count()) === 0
            && (await page.locator('section[aria-labelledby="salary-payday-title"]').count()) === 0);
        check('後台11：mentor 的頁面根本沒有去讀／寫 salary_payout_schedule', reqLog.filter(r => r.path === '/rest/v1/salary_payout_schedule').length === 0);
        await context.close();

        // 12. 後台 390px
        console.log('\n── 後台 390px 手機');
        world.role = 'admin';
        setSchedule('2026-11-10', 10);
        context = await newContext(browser, { viewport: { width: 390, height: 844 }, now: TAIPEI_NOON('2026-10-20') });
        page = await newPage(context);
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor({ timeout: 15000 });
        const mSection = page.locator('section[aria-labelledby="salary-payday-title"]');
        await mSection.locator('input[type="date"]').waitFor({ timeout: 15000 });
        await mSection.scrollIntoViewIfNeeded();
        const mBox = await mSection.boundingBox();
        const mOverflow = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
        check(`後台12：390px 區塊完整在視窗內、頁面沒有水平捲軸（scrollWidth ${mOverflow[0]} ≤ ${mOverflow[1]}）`,
            mBox && mBox.x >= 0 && mBox.x + mBox.width <= 390.5 && mOverflow[0] <= mOverflow[1], JSON.stringify({ mBox, mOverflow }));
        const mButton = mSection.getByRole('button', { name: /儲存/ });
        const mDate = mSection.locator('input[type="date"]');
        const mControls = await Promise.all([mDate.boundingBox(), mSection.locator('select').boundingBox(), mButton.boundingBox()]);
        check('後台12：日期框、每月固定日、儲存鈕在手機上高度 ≥ 44px 且都在視窗內',
            mControls.every(b => b && b.height >= 44 && b.x >= 0 && b.x + b.width <= 390.5), JSON.stringify(mControls));
        await page.screenshot({ path: shot('admin-mobile-390-payday-section.png'), fullPage: false });
        await mDate.fill('2026-12-09');
        check('後台12：手機上改日期後出現預覽、「儲存」可按',
            (await mSection.getByText('儲存後講師會看到「11月累計報酬・12/9 匯款」').count()) === 1 && await mButton.isEnabled());
        await mSection.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);  // 等按鈕的顏色轉場結束再截圖
        await page.screenshot({ path: shot('admin-mobile-390-preview.png'), fullPage: false });
        check('後台12：手機上出現預覽後仍沒有水平捲軸', await page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth));
        await context.close();

        // ════════ 全域檢查 ════════
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

// 黃卡金額字串 → 數字（"$2,400" → 2400）
function card0Value(card) {
    return Number(String(card.value).replace(/[^0-9.-]/g, ''));
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
