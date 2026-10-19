#!/usr/bin/env node
// 一次性：聚光燈示意圖截圖（mock Supabase，資料為假）。
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
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/reports/2026-10-18-salary-report-form-spotlight');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000051';
const instructorId = '10000000-0000-4000-8000-000000000051';
const now = new Date().toISOString();

const reportOptions = [
    { kind: 'term_period', value: 'winter_break', label: '寒假', sort_order: 10, is_active: true },
    { kind: 'term_period', value: 'semester', label: '學期間', sort_order: 20, is_active: true },
    { kind: 'term_period', value: 'summer_break', label: '暑假', sort_order: 30, is_active: true },
    { kind: 'partner_unit', value: '【新竹】康乃薾中小學 G3-6 / G1-2 / 幼兒園A、B、C', label: '【新竹】康乃薾中小學 G3-6 / G1-2 / 幼兒園A、B、C', sort_order: 10, is_active: true },
    { kind: 'partner_unit', value: '【週二】再興魔方高手 入門班115上', label: '【週二】再興魔方高手 入門班115上', sort_order: 20, is_active: true },
    { kind: 'partner_unit', value: '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動', label: '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動', sort_order: 30, is_active: true },
    { kind: 'camp_batch', value: '【臺北A】中山 | 7/1~7/3 三日營', label: '【臺北A】中山 | 7/1~7/3 三日營', sort_order: 10, is_active: true },
    { kind: 'camp_batch', value: '【高雄H】苓雅 | 8/15~8/16 速解營', label: '【高雄H】苓雅 | 8/15~8/16 速解營', sort_order: 20, is_active: true },
];

const baseSession = {
    instructor_id: instructorId,
    instructor_name: '回報測試老師',
    instructor_role_at_time: 'A',
    speed_qualification_at_time: null,
    role_in_session: 'lead',
    bonus: 0,
    paid_amount: 0,
    status: 'pending',
    pricing_status: 'quoted',
    pricing_message: '已依現行報酬表完成試算',
    source: 'self_report',
    registered_by_name: '回報測試老師',
    created_at: now,
    term_period: null,
    unit_name: null,
    materials_issued: null,
    transport_subsidy_requested: false,
    transport_distance_km: null,
};
const adminSessions = [
    { ...baseSession, id: '30000000-0000-4000-8000-000000000051', course_type: 'onsite_1_5hr', course_name: '王小明', session_date: '2026-10-14', month_label: '2026/10', duration_hours: 1.5, student_count: 2, base_salary: 600, total_salary: 600, transport_subsidy_requested: true, transport_distance_km: 12.4 },
    { ...baseSession, id: '30000000-0000-4000-8000-000000000052', course_type: 'collab_lead', course_name: null, session_date: '2026-10-13', month_label: '2026/10', duration_hours: 2, student_count: 18, base_salary: 1000, total_salary: 1000, term_period: 'semester', unit_name: '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動', materials_issued: '楓葉10' },
];

const authUser = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'report-teacher@test.local',
    user_metadata: { full_name: '回報測試老師' },
    app_metadata: { provider: 'google', providers: ['google'] },
    identities: [],
    created_at: now,
    updated_at: now,
};
const session = {
    access_token: 'mock.salary.report',
    refresh_token: 'mock.refresh',
    token_type: 'bearer',
    expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    user: authUser,
};

let appRole = 'teacher';
let optionsFail = false;
let submitBodies = [];
let directSessionWrites = 0;

const json = (route, data, status = 200) => route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}) },
    body: JSON.stringify(data),
});

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
            rate_card_id: '20000000-0000-4000-8000-000000000051', pricing_mode: 'hourly', applied_rate: 400, base_salary: 600,
        }]);
    }
    if (url.pathname === '/rest/v1/rpc/submit_my_class_session') {
        submitBodies.push(request.postDataJSON());
        return json(route, '30000000-0000-4000-8000-000000000099');
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);

    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        if (request.method() !== 'GET') {
            if (table === 'class_sessions') directSessionWrites += 1;
            return json(route, acceptsObject ? {} : [], 201);
        }
        if (table === 'salary_report_options') {
            if (optionsFail) return json(route, { code: '42P01', message: 'relation does not exist' }, 404);
            return json(route, reportOptions);
        }
        if (table === 'users') {
            const row = { id: userId, name: '回報測試老師', email: authUser.email, role: appRole, created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructors') {
            const row = {
                id: instructorId, user_id: userId, full_name: '回報測試老師', nickname: '回報測試老師',
                gender: '男', birth_date: '1990-01-01', id_number: 'A123456789', phone_mobile: '0912345678',
                line_id: 'report-test', address: '測試通訊地址', household_address: '測試戶籍地址',
                email_primary: authUser.email, instructor_role: 'A', speed_qualification: null,
                employment_status: 'active', teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次',
                teaching_regions: ['臺北市'], bio_notes: '測試講師', bank_account_name: '回報測試老師',
                bank_name: '測試銀行', bank_branch: '測試分行', bank_account_number: '0000000000', bank_code: '0000000',
                photo_path: 'test/photo.png', id_front_path: 'test/id-front.png', id_back_path: 'test/id-back.png',
                bankbook_path: 'test/bankbook.png', created_at: now,
            };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructor_salary_summary') return json(route, acceptsObject ? null : []);
        if (table === 'class_sessions') return json(route, appRole === 'admin' ? adminSessions : []);
        return json(route, acceptsObject ? null : []);
    }
    return json(route, {}, 404);
}

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});


async function openReport(page, base) {
    await page.goto(`${base}/my/salary/new`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '登記課程回報' }).waitFor();
}
const courseSelect = (page) => page.locator('select:has(option[value="collab_lead"])');

async function spot(page, selectors, file, { pad = 12, center, clip } = {}) {
    if (center) await page.evaluate(sel => document.querySelector(sel)?.scrollIntoView({ block: 'center' }), center);
    await page.waitForTimeout(300);
    const rect = await page.evaluate(({ selectors, pad }) => {
        const rects = selectors.flatMap(s => [...document.querySelectorAll(s)]).map(e => e.getBoundingClientRect());
        if (!rects.length) return null;
        const x0 = Math.min(...rects.map(r => r.left)) - pad, y0 = Math.min(...rects.map(r => r.top)) - pad;
        const x1 = Math.max(...rects.map(r => r.right)) + pad, y1 = Math.max(...rects.map(r => r.bottom)) + pad;
        const W = window.innerWidth, H = window.innerHeight;
        const box = { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(W, x1), y1: Math.min(H, y1) };
        const mk = (l, t, w, h, css) => { const d = document.createElement('div'); d.setAttribute('data-spot', '1'); d.style.cssText = `position:fixed;left:${l}px;top:${t}px;width:${w}px;height:${h}px;z-index:99999;pointer-events:none;${css}`; document.body.appendChild(d); };
        const dim = 'background:rgba(15,23,42,.62);';
        mk(0, 0, W, box.y0, dim);
        mk(0, box.y1, W, H - box.y1, dim);
        mk(0, box.y0, box.x0, box.y1 - box.y0, dim);
        mk(box.x1, box.y0, W - box.x1, box.y1 - box.y0, dim);
        mk(box.x0 - 4, box.y0 - 4, box.x1 - box.x0 + 8, box.y1 - box.y0 + 8, 'border:4px solid #facc15;border-radius:10px;box-sizing:border-box;');
        return box;
    }, { selectors, pad });
    if (!rect) throw new Error(`no match for ${selectors.join(',')}`);
    await page.screenshot({ path: path.join(shotDir, file), ...(clip ? { clip } : {}) });
    await page.evaluate(() => document.querySelectorAll('[data-spot]').forEach(e => e.remove()));
    console.log(`shot ${file}`, JSON.stringify(rect));
}

async function run() {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const viteBin = path.join(appDir, 'node_modules', '.bin', 'vite');
    const vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite dev pid=${vite.pid} port=${port}`);
    let browser;
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
            if (Date.now() > deadline) throw new Error('vite dev did not start');
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});
        const vp = { width: 1400, height: 560 };
        const clip = { x: 300, y: 0, width: 800, height: 560 };
        appRole = 'teacher';
        let context = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
        await context.route('**/*', handleRoute);
        let page = await context.newPage();
        await openReport(page, base);

        await courseSelect(page).selectOption('collab_lead');
        await spot(page, ['section[aria-label="合作單位課程資訊"]'], 'step1-collab.png', { clip,  center: 'section[aria-label="合作單位課程資訊"]' });

        await page.getByLabel('本次上課單位').selectOption('__other__');
        await page.getByLabel('本次上課單位（自行填寫）').fill('【臺北】新開合作單位 週五班');
        await spot(page, ['section[aria-label="合作單位課程資訊"] label:has([aria-label^="本次上課單位"])'], 'step2-other-unit.png', { clip,  center: 'section[aria-label="合作單位課程資訊"]' });

        await openReport(page, base);
        await courseSelect(page).selectOption('camp');
        await page.getByLabel('營隊梯次').selectOption('【臺北A】中山 | 7/1~7/3 三日營');
        await spot(page, ['section[aria-label="營隊資訊"]', 'section[aria-label="交通補助"]'], 'step3-camp.png', { clip,  center: 'section[aria-label="營隊資訊"]' });

        await courseSelect(page).selectOption('onsite_1_5hr');
        await page.getByLabel('申請交通補助').check();
        await page.getByLabel('單趟公里數').fill('12.5');
        await spot(page, ['section[aria-label="交通補助"]'], 'step4-transport.png', { clip,  center: 'section[aria-label="交通補助"]' });
        await context.close();

        appRole = 'admin';
        context = await browser.newContext({ viewport: { width: 1400, height: 520 }, deviceScaleFactor: 2 });
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
        await context.route('**/*', handleRoute);
        page = await context.newPage();
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor();
        await spot(page, ['table thead th:nth-child(3)', 'table tbody tr:nth-child(-n+2) td:nth-child(3)'], 'step5-admin.png', { pad: 6, clip: { x: 40, y: 100, width: 1320, height: 300 }, center: 'table tbody tr:nth-child(2)' });
        await context.close();
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
