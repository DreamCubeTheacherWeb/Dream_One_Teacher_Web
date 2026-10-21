#!/usr/bin/env node
// 後台「回報選項管理」頁（2026-10-20 改版：期間 chip＋每期各自的清單＋拖曳排序＋表單欄位設定）：
// 以 mock Supabase 實際操作（桌機＋390px），驗證送出的 payload、拖曳排序 RPC 與權限導向。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { DEFAULT_REPORT_FIELDS } from '../src/lib/salaryReportFields.js';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-report-options-v4');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000061';
const instructorId = '10000000-0000-4000-8000-000000000061';
const now = new Date().toISOString();

const LONG_UNIT = '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動';
const SEM_A = '【學期】信義國小 週三班';
const SEM_B = '【學期】文山國小 週五班';
const UNIT_1 = '【新竹】康乃薾中小學';
const UNIT_2 = '【週二】再興魔方高手 入門班115上';
const UNIT_OLD = '【舊】已結束的合作單位';
const CAMP_1 = '【臺北A】中山 | 7/1~7/3 三日營';

const opt = (id, kind, label, sort_order, period_id, is_active = true) => ({ id, kind, value: label, label, sort_order, is_active, period_id });
const seedOptions = () => [
    { id: 't1', kind: 'term_period', value: 'winter_break', label: '2026年寒假', sort_order: 10, is_active: true, period_id: null },
    { id: 't2', kind: 'term_period', value: 'semester', label: '115學年度上學期', sort_order: 20, is_active: true, period_id: null },
    { id: 't3', kind: 'term_period', value: 'summer_break', label: '2026年暑假', sort_order: 30, is_active: true, period_id: null },
    opt('p1', 'partner_unit', UNIT_1, 10, 't1'),
    opt('p2', 'partner_unit', UNIT_2, 20, 't1'),
    opt('p3', 'partner_unit', LONG_UNIT, 30, 't1'),
    opt('p4', 'partner_unit', UNIT_OLD, 40, 't1', false),
    opt('p5', 'partner_unit', SEM_A, 10, 't2'),
    opt('p6', 'partner_unit', SEM_B, 20, 't2'),
    opt('s1', 'partner_unit', UNIT_1, 10, 't3'),
    opt('s2', 'partner_unit', '【暑假】東區國小', 20, 't3'),
    opt('s3', 'partner_unit', '【暑假】西區國小', 30, 't3'),
    opt('c1', 'camp_batch', CAMP_1, 10, 't1'),
    opt('c2', 'camp_batch', '【高雄H】苓雅 | 8/15~8/16 速解營', 10, 't3'),
    opt('c3', 'camp_batch', '【台中B】西屯 | 7/20~7/22 三日營', 20, 't3'),
];
// 24 筆種子欄位（與 migration 相同）＋ 1 筆自訂欄位
const seedFields = () => [
    ...DEFAULT_REPORT_FIELDS.map(({ id: _id, ...rest }) => ({ ...rest, id: `f-${rest.layout}-${rest.field_key}` })),
    {
        id: 'f-custom-1', layout: 'b2b', field_key: 'custom_abcde12345', source: 'custom', label: '使用的教具',
        field_type: 'select', options: ['方塊', '計時器'], help_text: '沒有就留白', is_required: false, is_visible: true, sort_order: 70,
    },
];

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'options-admin@test.local',
    user_metadata: { full_name: '選項測試管理員' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.salary.options', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};

let appRole = 'admin';
let tableRows = seedOptions();
let fieldRows = seedFields();
let writes = []; // { method: POST|PATCH|DELETE|RPC, table|name, body, id }
let forceDuplicate = false;
let forceZeroRows = false;
let forceRpcFail = false;
let forceCopyFail = false;
let forceFieldsLoadError = false;
let optionGets = 0;
let idCounter = 0;

const json = (route, data, status = 200) => route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}) },
    body: JSON.stringify(data),
});
const idFilter = (url) => (url.searchParams.get('id') || '').replace('eq.', '');
const byOrder = (a, b) => a.sort_order - b.sort_order;

const duplicateOption = (body) => (body.kind === 'term_period'
    ? tableRows.some(r => r.kind === 'term_period' && r.value === body.value)
    : tableRows.some(r => r.kind === body.kind && r.period_id === body.period_id && r.value === body.value));

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

    // 拖曳排序 RPC：照 migration，把清單依 p_ids 順序改成 10、20、30…
    if (url.pathname === '/rest/v1/rpc/reorder_salary_report_options' || url.pathname === '/rest/v1/rpc/reorder_salary_report_fields') {
        const name = url.pathname.split('/').pop();
        const body = request.postDataJSON();
        writes.push({ method: 'RPC', name, body });
        if (forceRpcFail) return json(route, { code: 'P0001', message: '清單已被其他人修改，請重新整理後再排序' }, 400);
        const target = name === 'reorder_salary_report_options' ? tableRows : fieldRows;
        body.p_ids.forEach((id, index) => {
            const row = target.find(r => r.id === id);
            if (row) row.sort_order = (index + 1) * 10;
        });
        return json(route, body.p_ids.length);
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);

    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        const method = request.method();

        if (table === 'salary_report_options') {
            if (method === 'GET') { optionGets += 1; return json(route, tableRows); }
            if (method === 'POST') {
                const body = request.postDataJSON();
                writes.push({ method, table, body });
                const bodies = Array.isArray(body) ? body : [body];
                if (Array.isArray(body) && forceCopyFail) return json(route, { code: 'XX000', message: 'copy failed' }, 500);
                if (forceDuplicate || bodies.some(duplicateOption)) {
                    return json(route, { code: '23505', message: 'duplicate key value violates unique constraint "salary_report_options_item_value_key"' }, 409);
                }
                const created = bodies.map(item => ({ id: `new-${++idCounter}`, is_active: true, period_id: null, ...item }));
                tableRows.push(...created);
                return json(route, acceptsObject ? created[0] : created, 201);
            }
            if (method === 'PATCH') {
                const body = request.postDataJSON();
                const id = idFilter(url);
                writes.push({ method, table, body, id });
                if (forceZeroRows) return json(route, []);
                const row = tableRows.find(r => r.id === id);
                if (!row) return json(route, []);
                Object.assign(row, body);
                return json(route, [row]);
            }
            return json(route, [], 204);
        }
        if (table === 'salary_report_fields') {
            if (method === 'GET') {
                if (forceFieldsLoadError) return json(route, { code: '42P01', message: 'relation "public.salary_report_fields" does not exist' }, 404);
                return json(route, fieldRows);
            }
            if (method === 'POST') {
                const body = request.postDataJSON();
                writes.push({ method, table, body });
                const created = { id: `field-new-${++idCounter}`, ...body };
                fieldRows.push(created);
                return json(route, acceptsObject ? created : [created], 201);
            }
            if (method === 'PATCH') {
                const body = request.postDataJSON();
                const id = idFilter(url);
                writes.push({ method, table, body, id });
                const row = fieldRows.find(r => r.id === id);
                if (!row) return json(route, []);
                Object.assign(row, body);
                return json(route, [row]);
            }
            if (method === 'DELETE') {
                const id = idFilter(url);
                writes.push({ method, table, id });
                const row = fieldRows.find(r => r.id === id);
                fieldRows = fieldRows.filter(r => r.id !== id);
                return json(route, row ? [row] : []);
            }
            return json(route, [], 204);
        }
        if (method !== 'GET') return json(route, acceptsObject ? {} : [], 201);
        if (table === 'users') {
            const row = { id: userId, name: '選項測試管理員', email: authUser.email, role: appRole, created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructors') {
            const row = { id: instructorId, user_id: userId, full_name: '選項測試管理員', email_primary: authUser.email, instructor_role: 'A', employment_status: 'active', created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
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

const results = [];
const check = (name, condition, detail) => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
    if (!condition && detail !== undefined) console.log(`      detail: ${JSON.stringify(detail)}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
    return value;
};
const sameBody = (a, b) => same(sortKeys(a), sortKeys(b)); // 不看欄位順序

async function contextFor(browser, viewport) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
    await context.route('**/*', handleRoute);
    return context;
}

const overflowOf = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await fn()) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
};
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const panelOf = (page, panel) => page.locator(`[data-panel="${panel}"]`);
const noticeOf = async (page, panel = 'options') => {
    const locator = panelOf(page, panel).locator('[data-notice]');
    return (await locator.count()) ? (await locator.first().innerText()).trim() : '';
};
const savedLine = async (page, panel = 'options') => (await panelOf(page, panel).locator('[data-saved-line]').innerText()).trim();
const chipLabels = (page) => page.locator('[data-period-chip]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
const chip = (page, label) => page.locator('[data-period-chip]', { has: page.locator(`span:text-is("${label}")`) });
const section = (page, kind) => page.locator(`[data-option-section="${kind}"]`);
const labelsOf = (page, kind) => section(page, kind).locator('[data-option-label]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')));
const countOf = async (page, kind) => (await section(page, kind).locator('[data-section-count]').innerText()).trim();
const rowOf = (page, kind, label) => section(page, kind).locator('[data-option-row]', { has: page.locator(`[data-option-label][title="${label}"]`) });
const handleOf = (scope, label) => scope.getByRole('button', { name: `拖曳排序「${label}」`, exact: true });
const idsOf = (kind, periodId) => tableRows.filter(r => r.kind === kind && r.period_id === periodId).sort(byOrder).map(r => r.id);
const periodIds = () => tableRows.filter(r => r.kind === 'term_period').sort(byOrder).map(r => r.id);
const fieldIds = (layout) => fieldRows.filter(f => f.layout === layout).sort(byOrder).map(f => f.id);
const fieldRowOf = (page, label) => panelOf(page, 'fields').locator('[data-field-row]', { has: page.locator('[data-field-label]', { hasText: new RegExp(`^${label}$`) }) });
const fieldLabels = (page) => panelOf(page, 'fields').locator('[data-field-label]').allInnerTexts();
const editor = (page) => panelOf(page, 'fields').locator('[data-field-editor]');

async function keyboardDrag(page, handle, key = 'ArrowDown', times = 1) {
    await handle.focus();
    await page.keyboard.press('Space');
    await pause(150);
    for (let i = 0; i < times; i += 1) {
        await page.keyboard.press(key);
        await pause(250);
    }
    await page.keyboard.press('Space');
}

async function mouseDrag(page, fromHandle, toHandle, offset = -6) {
    const from = await fromHandle.boundingBox();
    const to = await toHandle.boundingBox();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + (offset < 0 ? -8 : 8), { steps: 4 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + offset, { steps: 15 });
    await pause(200);
    await page.mouse.up();
}

const smallTargets = (page) => page.evaluate(() => [...document.querySelectorAll('main button, main a, main input, main select, main textarea, main [role="switch"]')]
    .filter(el => el.offsetParent !== null)
    .map(el => ({ text: (el.getAttribute('aria-label') || el.textContent || el.placeholder || '').trim().slice(0, 24), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) }))
    .filter(item => item.h < 43.5 || item.w < 43.5));

async function openOptions(page, base) {
    await page.goto(`${base}/admin/salary/options`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '回報選項管理', level: 1 }).waitFor();
    await page.locator('[data-period-chip]').first().waitFor();
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

        // ══════════ 管理員：從報酬登記中心的入口進來 ══════════
        appRole = 'admin';
        let context = await contextFor(browser, { width: 1280, height: 900 });
        let page = await context.newPage();
        const consoleErrors = [];
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
        page.on('pageerror', error => consoleErrors.push(String(error)));
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor();
        const entry = page.getByRole('link', { name: '回報選項管理' });
        check('報酬登記中心頁首有「回報選項管理」入口', await entry.isVisible());
        await entry.click();
        await page.getByRole('heading', { name: '回報選項管理', level: 1 }).waitFor();
        check('點入口進到 /admin/salary/options', new URL(page.url()).pathname === '/admin/salary/options');
        await page.locator('[data-period-chip]').first().waitFor();

        // ── 主分頁
        const mainTabs = page.getByRole('tablist', { name: '設定項目' }).getByRole('tab');
        check('兩個主分頁：下拉選單內容／回報表單欄位，預設在下拉選單內容',
            same(await mainTabs.allInnerTexts(), ['下拉選單內容', '回報表單欄位'])
            && await mainTabs.nth(0).getAttribute('aria-selected') === 'true'
            && await panelOf(page, 'options').isVisible());

        // ── 期間 chip 與各期間的清單
        check('期間列：3 個期間 chip 依序排列，最後有「新增期間」',
            same(await chipLabels(page), ['2026年寒假', '115學年度上學期', '2026年暑假'])
            && await page.locator('[data-new-period-toggle]').isVisible());
        check('預設選中第一個期間（寒假）：黑底白字、aria-pressed',
            await page.locator('[data-period-chip="t1"]').getAttribute('aria-pressed') === 'true'
            && await page.locator('[data-period-chip="t1"]').evaluate(el => getComputedStyle(el.parentElement).backgroundColor) === 'rgb(18, 18, 18)');
        check('寒假：上課單位 4 項（含 1 項停用）、營隊梯次 1 項，筆數摘要正確',
            same(await labelsOf(page, 'partner_unit'), [UNIT_1, UNIT_2, LONG_UNIT, UNIT_OLD])
            && same(await labelsOf(page, 'camp_batch'), [CAMP_1])
            && await countOf(page, 'partner_unit') === '共 4 項，啟用 3 項'
            && await countOf(page, 'camp_batch') === '共 1 項，啟用 1 項');
        await chip(page, '115學年度上學期').click();
        await page.getByText(SEM_A).first().waitFor();
        check('切到學期期間：只顯示該期間的 2 個單位、0 個梯次（不混入寒假的清單）',
            same(await labelsOf(page, 'partner_unit'), [SEM_A, SEM_B])
            && same(await labelsOf(page, 'camp_batch'), [])
            && await countOf(page, 'partner_unit') === '共 2 項，啟用 2 項'
            && await countOf(page, 'camp_batch') === '共 0 項，啟用 0 項'
            && await section(page, 'camp_batch').getByText('這個期間還沒有梯次').isVisible());
        await chip(page, '2026年暑假').click();
        await page.getByText('【暑假】東區國小').first().waitFor();
        check('切到暑假期間：3 個單位（複製來的清單）、2 個梯次',
            same(await labelsOf(page, 'partner_unit'), [UNIT_1, '【暑假】東區國小', '【暑假】西區國小'])
            && same(await labelsOf(page, 'camp_batch'), ['【高雄H】苓雅 | 8/15~8/16 速解營', '【台中B】西屯 | 7/20~7/22 三日營'])
            && await countOf(page, 'partner_unit') === '共 3 項，啟用 3 項');
        await chip(page, '2026年寒假').click();
        await page.getByText(LONG_UNIT).first().waitFor();

        // ── 清單列要薄：單行、不超過約 60px，且沒有排序值徽章與上移／下移
        const heights = await page.locator('[data-option-row]').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
        check(`清單列很薄：桌機 ${heights.length} 列全部 ≤60px（最高 ${Math.max(...heights)}px）`, heights.length === 5 && Math.max(...heights) <= 60);
        check('每列只有：拖曳把手、名稱、改名鈕、啟用開關（無上移／下移、無排序值、無刪除）',
            await page.getByRole('button', { name: /上移|下移/ }).count() === 0
            && await section(page, 'partner_unit').locator('[data-drag-handle]').count() === 4
            && await section(page, 'partner_unit').getByRole('button', { name: /^改名「/ }).count() === 4
            && await section(page, 'partner_unit').getByRole('switch').count() === 4
            && await panelOf(page, 'options').getByRole('button', { name: /刪除/ }).count() === 0);
        const stoppedRow = rowOf(page, 'partner_unit', UNIT_OLD);
        check('停用列：灰底、名稱刪除線、小標「已停用」、開關為關',
            await stoppedRow.locator('xpath=ancestor::li[1]').evaluate(el => getComputedStyle(el).backgroundColor) !== 'rgb(255, 255, 255)'
            && (await stoppedRow.locator('[data-option-label]').evaluate(el => getComputedStyle(el).textDecorationLine)).includes('line-through')
            && await stoppedRow.getByText('已停用', { exact: true }).isVisible()
            && await stoppedRow.getByRole('switch').getAttribute('aria-checked') === 'false');
        check('頁面有一行小字說明「停用後講師看不到，舊紀錄不受影響，因此不提供刪除」',
            await panelOf(page, 'options').getByText('停用後講師看不到，舊紀錄不受影響，因此不提供刪除。').isVisible());
        await pause(500); // 等 chip／開關的顏色轉場跑完再截圖
        await page.screenshot({ path: path.join(shotDir, 'desktop-options.png'), fullPage: true });

        // ══════════ 上課單位／營隊梯次的新增、改名、啟用 ══════════
        // 改名：單位的 label 與 value 一起改
        writes = [];
        await rowOf(page, 'partner_unit', UNIT_2).getByRole('button', { name: /^改名「/ }).click();
        await page.getByLabel(`編輯「${UNIT_2}」的名稱`).fill('【週二】再興魔方高手 進階班115上');
        await page.getByLabel(`編輯「${UNIT_2}」的名稱`).press('Enter');
        await until(() => writes.length === 1);
        check('單位改名：Enter 儲存，送 PATCH 只含 label＋value（id 正確）',
            writes.length === 1 && writes[0].method === 'PATCH' && writes[0].id === 'p2'
            && sameBody(writes[0].body, { label: '【週二】再興魔方高手 進階班115上', value: '【週二】再興魔方高手 進階班115上' }));
        await until(async () => (await labelsOf(page, 'partner_unit')).includes('【週二】再興魔方高手 進階班115上'));
        check('改名後畫面顯示新名稱且回到一般列', (await labelsOf(page, 'partner_unit'))[1] === '【週二】再興魔方高手 進階班115上'
            && await page.getByLabel(/^編輯「/).count() === 0);
        // Esc 取消
        writes = [];
        await rowOf(page, 'partner_unit', UNIT_1).getByRole('button', { name: /^改名「/ }).click();
        await page.getByLabel(`編輯「${UNIT_1}」的名稱`).fill('不會存的名字');
        await page.getByLabel(`編輯「${UNIT_1}」的名稱`).press('Escape');
        await pause(300);
        check('改名按 Esc 取消，不送出、名稱不變', writes.length === 0 && (await labelsOf(page, 'partner_unit'))[0] === UNIT_1);
        // 改名成空白／同清單重名被擋
        await rowOf(page, 'partner_unit', UNIT_1).getByRole('button', { name: /^改名「/ }).click();
        await page.getByLabel(`編輯「${UNIT_1}」的名稱`).fill('   ');
        await page.getByRole('button', { name: '儲存名稱' }).click();
        check('改名成空白被擋且不送出', (await noticeOf(page)) === '請輸入單位名稱。' && writes.length === 0);
        await page.getByLabel(`編輯「${UNIT_1}」的名稱`).fill(LONG_UNIT);
        await page.getByRole('button', { name: '儲存名稱' }).click();
        check('改名成同一份清單已有的名稱被擋（重名）且不送出', (await noticeOf(page)) === '這份清單已經有相同的單位。' && writes.length === 0);
        await page.getByRole('button', { name: '取消改名' }).click();

        // 同名單位可以存在於不同期間：學期的單位改成寒假已有的名稱
        await chip(page, '115學年度上學期').click();
        await page.getByText(SEM_A).first().waitFor();
        writes = [];
        await rowOf(page, 'partner_unit', SEM_A).getByRole('button', { name: /^改名「/ }).click();
        await page.getByLabel(`編輯「${SEM_A}」的名稱`).fill(UNIT_1);
        await page.getByLabel(`編輯「${SEM_A}」的名稱`).press('Enter');
        await until(() => writes.length === 1);
        check('不同期間可以有同名單位：學期的單位改成寒假已有的名稱，照常送出',
            writes.length === 1 && writes[0].id === 'p5' && sameBody(writes[0].body, { label: UNIT_1, value: UNIT_1 }));
        await chip(page, '2026年寒假').click();
        await page.getByText(LONG_UNIT).first().waitFor();

        // 新增單位
        writes = [];
        await section(page, 'partner_unit').getByRole('button', { name: '新增', exact: true }).click();
        check('新增空白被擋且不送出', (await noticeOf(page)) === '請輸入單位名稱。' && writes.length === 0);
        await section(page, 'partner_unit').getByLabel('新增單位').fill('長'.repeat(201));
        await section(page, 'partner_unit').getByRole('button', { name: '新增', exact: true }).click();
        check('新增超過 200 字被擋且不送出', (await noticeOf(page)).includes('不得超過 200 字') && writes.length === 0);
        await section(page, 'partner_unit').getByLabel('新增單位').fill(`  ${UNIT_1}  `);
        await section(page, 'partner_unit').getByRole('button', { name: '新增', exact: true }).click();
        check('新增與本期間已有的單位同名，在前端被擋且不送出', (await noticeOf(page)) === '這份清單已經有相同的單位。' && writes.length === 0);
        await section(page, 'partner_unit').getByLabel('新增單位').fill('  【桃園】新增合作國小  ');
        await section(page, 'partner_unit').getByRole('button', { name: '新增', exact: true }).click();
        await until(() => writes.length === 1);
        check('新增單位 payload：kind／value＝label／label／sort_order＝該清單最大值＋10／is_active／period_id＝目前期間',
            writes.length === 1 && writes[0].method === 'POST'
            && sameBody(writes[0].body, { kind: 'partner_unit', value: '【桃園】新增合作國小', label: '【桃園】新增合作國小', sort_order: 50, is_active: true, period_id: 't1' }));
        await until(async () => (await labelsOf(page, 'partner_unit')).includes('【桃園】新增合作國小'));
        check('新增後列在該清單最後、筆數更新、輸入框清空',
            (await labelsOf(page, 'partner_unit')).at(-1) === '【桃園】新增合作國小'
            && await countOf(page, 'partner_unit') === '共 5 項，啟用 4 項'
            && (await section(page, 'partner_unit').getByLabel('新增單位').inputValue()) === '');
        forceDuplicate = true;
        await section(page, 'partner_unit').getByLabel('新增單位').fill('【桃園】另一個新單位');
        await section(page, 'partner_unit').getByRole('button', { name: '新增', exact: true }).click();
        await until(async () => (await noticeOf(page)).includes('已經有相同'));
        check('伺服器回 23505 時顯示友善訊息', (await noticeOf(page)) === '這份清單已經有相同的名稱。');
        forceDuplicate = false;
        // 新增梯次
        writes = [];
        await section(page, 'camp_batch').getByLabel('新增梯次').fill('【嘉義C】東區 | 7/8~7/10 三日營');
        await section(page, 'camp_batch').getByRole('button', { name: '新增', exact: true }).click();
        await until(() => writes.length === 1);
        check('新增梯次 payload：kind=camp_batch、sort_order＝10＋10、period_id＝目前期間',
            writes.length === 1 && sameBody(writes[0].body, { kind: 'camp_batch', value: '【嘉義C】東區 | 7/8~7/10 三日營', label: '【嘉義C】東區 | 7/8~7/10 三日營', sort_order: 20, is_active: true, period_id: 't1' }));

        // 啟用／停用
        writes = [];
        await page.getByRole('switch', { name: `啟用「${UNIT_1}」`, exact: true }).click();
        await until(() => writes.length === 1);
        check('停用送 PATCH is_active=false（id＝p1）', writes.length === 1 && writes[0].id === 'p1' && sameBody(writes[0].body, { is_active: false }));
        await until(async () => await page.getByRole('switch', { name: `啟用「${UNIT_1}」`, exact: true }).getAttribute('aria-checked') === 'false');
        check('停用後該列灰底、刪除線，摘要變成啟用 3 項',
            (await rowOf(page, 'partner_unit', UNIT_1).locator('[data-option-label]').evaluate(el => getComputedStyle(el).textDecorationLine)).includes('line-through')
            && await countOf(page, 'partner_unit') === '共 5 項，啟用 3 項');
        writes = [];
        await page.getByRole('switch', { name: `啟用「${UNIT_1}」`, exact: true }).click();
        await until(() => writes.length === 1);
        check('重新啟用送 PATCH is_active=true', writes.length === 1 && sameBody(writes[0].body, { is_active: true }));
        await until(async () => await page.getByRole('switch', { name: `啟用「${UNIT_1}」`, exact: true }).getAttribute('aria-checked') === 'true');
        // RLS 擋下（更新 0 筆）
        forceZeroRows = true;
        await page.getByRole('switch', { name: `啟用「${UNIT_OLD}」`, exact: true }).click();
        await until(async () => (await noticeOf(page)).includes('沒有更新到任何資料'));
        check('更新 0 筆（RLS 擋下）顯示錯誤訊息，不靜默', (await noticeOf(page)).includes('沒有更新到任何資料'));
        forceZeroRows = false;

        // ══════════ 拖曳排序：鍵盤、滑鼠、失敗還原 ══════════
        writes = [];
        let ids = idsOf('partner_unit', 't1');
        await keyboardDrag(page, handleOf(section(page, 'partner_unit'), UNIT_1), 'ArrowDown');
        await until(() => writes.some(w => w.method === 'RPC'));
        check('鍵盤拖曳（Space→ArrowDown→Space）：呼叫 reorder_salary_report_options，p_ids＝第一、二列互換',
            writes.length === 1 && writes[0].name === 'reorder_salary_report_options'
            && same(writes[0].body, { p_ids: [ids[1], ids[0], ...ids.slice(2)] }));
        await until(async () => (await savedLine(page)) === '已儲存順序');
        check('成功後顯示一行 aria-live「已儲存順序」', (await savedLine(page)) === '已儲存順序'
            && await panelOf(page, 'options').locator('[data-saved-line]').getAttribute('aria-live') === 'polite');
        check('畫面順序隨之改變（單位互換）', (await labelsOf(page, 'partner_unit'))[0] === '【週二】再興魔方高手 進階班115上' && (await labelsOf(page, 'partner_unit'))[1] === UNIT_1);
        await pause(400);

        writes = [];
        ids = idsOf('partner_unit', 't1');
        const labelsBefore = await labelsOf(page, 'partner_unit');
        await mouseDrag(page, handleOf(section(page, 'partner_unit'), labelsBefore[2]), handleOf(section(page, 'partner_unit'), labelsBefore[0]), -6);
        await until(() => writes.some(w => w.method === 'RPC'));
        check('滑鼠拖曳（第三列拖到第一列上方）：p_ids＝第三列移到最前',
            writes.length === 1 && same(writes[0].body, { p_ids: [ids[2], ids[0], ids[1], ...ids.slice(3)] }));
        await until(async () => (await labelsOf(page, 'partner_unit'))[0] === labelsBefore[2]);
        check('滑鼠拖曳後畫面第一列是被拖的那一列', (await labelsOf(page, 'partner_unit'))[0] === labelsBefore[2]);
        await pause(400);

        // 營隊梯次是另一份清單：只送該清單的 id
        writes = [];
        ids = idsOf('camp_batch', 't1');
        await keyboardDrag(page, handleOf(section(page, 'camp_batch'), CAMP_1), 'ArrowDown');
        await until(() => writes.some(w => w.method === 'RPC'));
        check('梯次清單拖曳只送梯次的 id（不混入單位）', writes.length === 1 && same(writes[0].body, { p_ids: [ids[1], ids[0]] }));
        await pause(400);

        // RPC 失敗：還原、顯示錯誤、重新載入
        writes = [];
        forceRpcFail = true;
        const getsBefore = optionGets;
        const orderBefore = await labelsOf(page, 'partner_unit');
        await keyboardDrag(page, handleOf(section(page, 'partner_unit'), orderBefore[0]), 'ArrowDown');
        await until(() => writes.some(w => w.method === 'RPC'));
        await until(async () => (await noticeOf(page)).includes('儲存順序失敗'));
        await until(() => optionGets > getsBefore);
        await pause(300);
        check('排序 RPC 失敗：顯示錯誤訊息、畫面順序還原、重新讀取一次資料庫',
            (await noticeOf(page)).includes('儲存順序失敗') && same(await labelsOf(page, 'partner_unit'), orderBefore) && optionGets > getsBefore);
        forceRpcFail = false;

        // ══════════ 新增期間（複製清單） ══════════
        writes = [];
        await page.locator('[data-new-period-toggle]').click();
        const newPanel = page.locator('[data-new-period-panel]');
        await newPanel.waitFor();
        check('新增期間面板：名稱輸入、「複製哪一期的清單」預設＝目前選中期間、另有「不複製，從空白開始」',
            await newPanel.getByLabel('期間名稱').isVisible()
            && await newPanel.getByLabel('複製哪一期的清單').inputValue() === 't1'
            && (await newPanel.locator('option').allInnerTexts()).at(-1) === '不複製，從空白開始'
            && (await newPanel.locator('option').count()) === 4);
        await newPanel.getByLabel('期間名稱').fill('115學年度下學期');
        await page.locator('[data-notice] button[aria-label="關閉訊息"]').click().catch(() => {});
        await pause(500);
        await page.screenshot({ path: path.join(shotDir, 'desktop-new-period.png'), fullPage: true });
        await newPanel.getByLabel('期間名稱').fill('');
        await newPanel.getByRole('button', { name: '建立期間' }).click();
        check('期間名稱空白被擋且不送出', (await noticeOf(page)) === '請輸入期間名稱。' && writes.length === 0);
        await newPanel.getByLabel('期間名稱').fill('2026年暑假');
        await newPanel.getByRole('button', { name: '建立期間' }).click();
        check('期間名稱與既有期間重複被擋且不送出', (await noticeOf(page)) === '這份清單已經有相同的期間。' && writes.length === 0);
        await newPanel.getByLabel('期間名稱').fill('115學年度下學期');
        // 只複製上課單位；營隊梯次每期日期不同，不複製（避免講師下拉出現兩組同名梯次）
        const copyBase = tableRows.filter(r => r.period_id === 't1' && r.kind === 'partner_unit').sort((a, b) => a.sort_order - b.sort_order);
        await newPanel.getByRole('button', { name: '建立期間' }).click();
        await until(() => writes.length === 2);
        check('新增期間第一次 insert：kind=term_period、value＝term_ 開頭代碼、label、sort_order＝最大＋10、is_active',
            writes[0]?.method === 'POST' && !Array.isArray(writes[0].body)
            && /^term_[a-z0-9]{10}$/.test(writes[0].body.value)
            && sameBody({ ...writes[0].body, value: 'X' }, { kind: 'term_period', value: 'X', label: '115學年度下學期', sort_order: 40, is_active: true }));
        const newPeriodId = tableRows.find(r => r.kind === 'term_period' && r.label === '115學年度下學期')?.id;
        check('複製清單第二次 insert：一次送整個陣列（只有上課單位），每列 period_id＝新期間 id、名稱／順序／啟用照抄',
            Boolean(newPeriodId) && Array.isArray(writes[1]?.body) && writes[1].body.length === copyBase.length
            && writes[1].body.every(row => row.period_id === newPeriodId)
            && sameBody(writes[1].body, copyBase.map(r => ({ kind: r.kind, value: r.value, label: r.label, sort_order: r.sort_order, is_active: r.is_active, period_id: newPeriodId }))),
            { newPeriodId, body: writes[1]?.body });
        await until(async () => (await chipLabels(page)).includes('115學年度下學期'));
        await until(async () => (await countOf(page, 'partner_unit')) !== '');
        check('新期間被選中，上課單位與寒假相同（複製成功）、營隊梯次是空的，面板收起',
            same(await labelsOf(page, 'partner_unit'), copyBase.map(r => r.label))
            && same(await labelsOf(page, 'camp_batch'), [])
            && await page.locator('h2', { hasText: '115學年度下學期' }).isVisible()
            && await newPanel.count() === 0);

        // 不複製 → 只送一次 insert，清單是空的
        writes = [];
        await page.locator('[data-new-period-toggle]').click();
        await page.locator('[data-new-period-panel]').getByLabel('期間名稱').fill('2027年寒假');
        await page.locator('[data-new-period-panel]').getByLabel('複製哪一期的清單').selectOption('');
        await page.locator('[data-new-period-panel]').getByRole('button', { name: '建立期間' }).click();
        await until(async () => (await chipLabels(page)).includes('2027年寒假'));
        await pause(300);
        check('選「不複製，從空白開始」只 insert 期間一次，新期間單位與梯次都是空的',
            writes.length === 1 && writes[0].body.sort_order === 50 && writes[0].body.label === '2027年寒假'
            && same(await labelsOf(page, 'partner_unit'), []) && same(await labelsOf(page, 'camp_batch'), []));

        // 複製失敗：期間已建立，清單沒複製，要明講
        writes = [];
        forceCopyFail = true;
        await page.locator('[data-new-period-toggle]').click();
        await page.locator('[data-new-period-panel]').getByLabel('期間名稱').fill('2027年暑假');
        await page.locator('[data-new-period-panel]').getByLabel('複製哪一期的清單').selectOption('t3');
        await page.locator('[data-new-period-panel]').getByRole('button', { name: '建立期間' }).click();
        await until(async () => (await noticeOf(page)).includes('清單複製失敗'));
        check('複製失敗時明講「期間已建立，但清單複製失敗」，期間仍留著並被選中',
            (await noticeOf(page)).startsWith('期間已建立，但清單複製失敗')
            && writes.length === 2 && (await chipLabels(page)).includes('2027年暑假')
            && await page.locator('h2', { hasText: '2027年暑假' }).isVisible());
        forceCopyFail = false;

        // ══════════ 期間改名、啟用／停用 ══════════
        await chip(page, '115學年度上學期').click();
        await page.locator('h2', { hasText: '115學年度上學期' }).waitFor();
        check('期間標頭旁有提示「換新學期請按新增期間，不要直接改名」',
            await panelOf(page, 'options').getByText('換新學期請按「新增期間」，不要直接改名——改名後，這個期間的舊回報也會顯示新名字。').isVisible());
        writes = [];
        await page.getByRole('button', { name: '改名期間「115學年度上學期」' }).click();
        await page.getByLabel('編輯期間「115學年度上學期」的名稱').fill('115學年度上學期（修訂）');
        await page.getByLabel('編輯期間「115學年度上學期」的名稱').press('Enter');
        await until(() => writes.length === 1);
        check('期間改名只送 label（value 是固定代碼）',
            writes.length === 1 && writes[0].method === 'PATCH' && writes[0].id === 't2' && sameBody(writes[0].body, { label: '115學年度上學期（修訂）' }));
        await until(async () => (await chipLabels(page)).includes('115學年度上學期（修訂）'));
        check('期間改名後 chip 顯示新名字', (await chipLabels(page)).includes('115學年度上學期（修訂）'));
        writes = [];
        await page.getByRole('button', { name: '改名期間「115學年度上學期（修訂）」' }).click();
        await page.getByLabel('編輯期間「115學年度上學期（修訂）」的名稱').fill('2026年寒假');
        await page.getByRole('button', { name: '儲存期間名稱' }).click();
        check('期間改名成既有期間的名字被擋', (await noticeOf(page)) === '這份清單已經有相同的期間。' && writes.length === 0);
        await page.getByRole('button', { name: '取消改名' }).click();

        writes = [];
        await page.getByRole('switch', { name: '啟用期間「115學年度上學期（修訂）」', exact: true }).click();
        await until(() => writes.length === 1);
        check('期間停用送 PATCH is_active=false', writes.length === 1 && writes[0].id === 't2' && sameBody(writes[0].body, { is_active: false }));
        await until(async () => await page.locator('[data-period-disabled-note]').count() > 0);
        check('停用的期間：chip 灰底＋刪除線，標頭下一行說明講師看不到期間與它底下的單位與梯次',
            await page.locator('[data-period-disabled-note]').innerText() === '講師看不到這個期間，也看不到它底下的單位與梯次。'
            && (await page.locator('[data-period-chip="t2"] span').first().evaluate(el => getComputedStyle(el).textDecorationLine)).includes('line-through'));
        await chip(page, '2026年暑假').click();
        await pause(400); // 等 chip 的顏色轉場跑完
        check('切到別的期間後，停用的 chip 仍是灰底（未選中時）',
            await page.locator('[data-period-chip="t2"]').evaluate(el => getComputedStyle(el.parentElement).backgroundColor) === 'rgb(224, 224, 224)',
            await page.locator('[data-period-chip="t2"]').evaluate(el => getComputedStyle(el.parentElement).backgroundColor));
        await chip(page, '115學年度上學期（修訂）').click();
        writes = [];
        await page.getByRole('switch', { name: '啟用期間「115學年度上學期（修訂）」', exact: true }).click();
        await until(() => writes.length === 1);
        check('期間重新啟用送 PATCH is_active=true', writes.length === 1 && sameBody(writes[0].body, { is_active: true }));

        // 期間 chip 鍵盤拖曳
        await pause(500);
        writes = [];
        ids = periodIds();
        await keyboardDrag(page, handleOf(page.locator('main'), '2026年寒假'), 'ArrowRight');
        await until(() => writes.some(w => w.method === 'RPC'));
        check('期間 chip 鍵盤拖曳（Space→ArrowRight→Space）：p_ids＝只含期間、第一個與第二個互換',
            writes.length === 1 && writes[0].name === 'reorder_salary_report_options'
            && same(writes[0].body, { p_ids: [ids[1], ids[0], ...ids.slice(2)] }), { ids, writes });
        await until(async () => (await chipLabels(page))[0] === '115學年度上學期（修訂）');
        check('期間 chip 拖曳後順序改變', (await chipLabels(page))[0] === '115學年度上學期（修訂）' && (await chipLabels(page))[1] === '2026年寒假');
        await pause(400);

        // ══════════ 分頁二：回報表單欄位 ══════════
        await mainTabs.nth(1).click();
        await panelOf(page, 'fields').locator('[data-field-row]').first().waitFor();
        check('切到「回報表單欄位」：選項面板收起、欄位面板顯示', await panelOf(page, 'fields').isVisible() && !(await panelOf(page, 'options').isVisible()));
        const layoutTabs = page.getByRole('tablist', { name: '回報版面' }).getByRole('tab');
        check('四個版面分頁：B2C 直營課程／B2B 合作單位／營隊／其他課程',
            same(await layoutTabs.allInnerTexts(), ['B2C 直營課程', 'B2B 合作單位', '營隊', '其他課程']));
        check('固定說明列：回報類別、上課日期、課程種類、報酬項目／講師身分別',
            (await panelOf(page, 'fields').locator('[data-pinned-line]').innerText()).includes('固定在最上面、不能調整：回報類別、上課日期、課程種類、報酬項目／講師身分別'));
        check('B2C 直營課程預設列出 5 個欄位（依順序）',
            same(await fieldLabels(page), ['課程名稱', '上課時數', '實際上課人數', '交通補助', '特殊狀況回饋']));

        // 切到 B2B：看自訂欄位、截圖
        await layoutTabs.nth(1).click();
        await fieldRowOf(page, '使用的教具').waitFor();
        check('B2B 版面 7 個欄位（含 1 個自訂欄位）', (await fieldLabels(page)).length === 7);
        const customRow = fieldRowOf(page, '使用的教具');
        check('自訂欄位列：標籤「自訂・下拉選單」、有顯示開關／編輯／刪除',
            await customRow.getByText('自訂・下拉選單').isVisible()
            && await customRow.getByRole('switch', { name: '顯示「使用的教具」' }).isVisible()
            && await customRow.getByRole('button', { name: '編輯「使用的教具」' }).isVisible()
            && await customRow.getByRole('button', { name: '刪除「使用的教具」' }).isVisible());
        const systemRow = fieldRowOf(page, '教學課程期間');
        check('system 欄位（教學課程期間）：標示「算報酬用」＋鎖頭，沒有任何開關／編輯／刪除，只有拖曳把手',
            await systemRow.getByText('算報酬用').isVisible()
            && await systemRow.locator('svg.lucide-lock').count() === 1
            && await systemRow.getByRole('switch').count() === 0
            && await systemRow.getByRole('button', { name: /刪除|編輯/ }).count() === 0
            && await systemRow.locator('[data-drag-handle]').count() === 1
            && await systemRow.getByRole('button').count() === 1);
        const materialsRow = fieldRowOf(page, '本次發出教材數量');
        const incidentRow = fieldRowOf(page, '特殊狀況或其他問題回報');
        check('builtin 欄位（教材數量、特殊狀況）都屬可改必填的內建欄位：各有「顯示」「必填」兩個開關',
            await materialsRow.getByRole('switch').count() === 2 && await incidentRow.getByRole('switch').count() === 2
            && await materialsRow.getByRole('switch', { name: '必填「本次發出教材數量」' }).getAttribute('aria-checked') === 'true'
            && await incidentRow.getByRole('switch', { name: '必填「特殊狀況或其他問題回報」' }).getAttribute('aria-checked') === 'false',
            { materials: await materialsRow.getByRole('switch').count(), incident: await incidentRow.getByRole('switch').count() });
        writes = [];
        await incidentRow.getByRole('switch', { name: '顯示「特殊狀況或其他問題回報」' }).click();
        await until(() => writes.length === 1);
        check('builtin 隱藏送 PATCH is_visible=false（id 正確）',
            writes.length === 1 && writes[0].method === 'PATCH' && writes[0].id === 'f-b2b-incident' && sameBody(writes[0].body, { is_visible: false }));
        await until(async () => await incidentRow.getByText('已隱藏', { exact: true }).count() > 0);
        check('隱藏的欄位仍在清單內，灰底、刪除線、小標「已隱藏」',
            await incidentRow.getByText('已隱藏', { exact: true }).isVisible()
            && (await incidentRow.locator('[data-field-label]').evaluate(el => getComputedStyle(el).textDecorationLine)).includes('line-through'));
        writes = [];
        await materialsRow.getByRole('switch', { name: '必填「本次發出教材數量」' }).click();
        await until(() => writes.length === 1);
        check('builtin 改必填送 PATCH is_required=false', writes.length === 1 && sameBody(writes[0].body, { is_required: false }));
        // PATCH 送出後提示訊息要等回應才出現；先等它出現再判斷，避免偶發的時間差誤判
        await panelOf(page, 'fields').locator('[data-notice]').first().waitFor({ timeout: 5000 }).catch(() => {});
        check('提示訊息有「關閉」鈕，按了就收起', await noticeOf(page, 'fields') !== '');
        await panelOf(page, 'fields').locator('[data-notice] button[aria-label="關閉訊息"]').click();
        check('按關閉後提示訊息消失', await panelOf(page, 'fields').locator('[data-notice]').count() === 0);
        await pause(500);
        await page.screenshot({ path: path.join(shotDir, 'desktop-fields.png'), fullPage: true });

        // 編輯自訂欄位（截圖）
        writes = [];
        await customRow.getByRole('button', { name: '編輯「使用的教具」' }).click();
        await editor(page).waitFor();
        check('編輯面板預填：名稱、類型＝下拉選單、選項一行一個、說明文字',
            await editor(page).getByLabel('欄位名稱').inputValue() === '使用的教具'
            && await editor(page).getByLabel('類型').inputValue() === 'select'
            && await editor(page).getByLabel('下拉選項（一行一個）').inputValue() === '方塊\n計時器'
            && await editor(page).getByLabel('說明文字（選填，講師會看到）').inputValue() === '沒有就留白');
        await pause(300);
        await page.screenshot({ path: path.join(shotDir, 'desktop-field-editor.png'), fullPage: true });
        await editor(page).getByLabel('欄位名稱').fill('使用的教具（改）');
        await editor(page).getByLabel('下拉選項（一行一個）').fill('方塊\n計時器\n方塊\n  教材包  ');
        await editor(page).getByRole('button', { name: '儲存' }).click();
        await until(() => writes.length === 1);
        check('編輯自訂欄位送 PATCH：label、field_type、options（去空白去重複）、help_text、is_required',
            writes.length === 1 && writes[0].method === 'PATCH' && writes[0].id === 'f-custom-1'
            && sameBody(writes[0].body, { label: '使用的教具（改）', field_type: 'select', options: ['方塊', '計時器', '教材包'], help_text: '沒有就留白', is_required: false }));
        await until(async () => await fieldRowOf(page, '使用的教具（改）').count() > 0);

        // 刪除自訂欄位：行內確認
        writes = [];
        const renamedRow = fieldRowOf(page, '使用的教具（改）');
        await renamedRow.getByRole('button', { name: '刪除「使用的教具（改）」' }).click();
        const confirmRow = panelOf(page, 'fields').locator('[data-confirm-delete]');
        await confirmRow.waitFor();
        check('刪除先出現行內確認「確定刪除？講師之前填的內容會保留在舊紀錄」，尚未送出',
            (await confirmRow.innerText()).includes('確定刪除') && (await confirmRow.innerText()).includes('講師之前填的內容會保留在舊紀錄') && writes.length === 0);
        await confirmRow.getByRole('button', { name: '取消' }).click();
        await pause(300);
        check('按取消：欄位還在、沒有送出任何刪除', await fieldRowOf(page, '使用的教具（改）').count() === 1 && writes.length === 0);
        await fieldRowOf(page, '使用的教具（改）').getByRole('button', { name: '刪除「使用的教具（改）」' }).click();
        await panelOf(page, 'fields').locator('[data-confirm-delete]').getByRole('button', { name: '刪除', exact: true }).click();
        await until(() => writes.length === 1);
        check('確認後送 DELETE（id＝該自訂欄位）', writes.length === 1 && writes[0].method === 'DELETE' && writes[0].id === 'f-custom-1');
        await until(async () => (await fieldLabels(page)).length === 6);
        check('刪除後欄位從清單消失（B2B 剩 6 個）', !(await fieldLabels(page)).some(label => label.includes('使用的教具')));

        // 新增下拉型自訂欄位（B2C 直營課程）
        await layoutTabs.nth(0).click();
        await fieldRowOf(page, '課程名稱').waitFor();
        check('不可改必填的內建欄位（交通補助）只有「顯示」一個開關；system 欄位（上課時數）沒有開關',
            await fieldRowOf(page, '交通補助').getByRole('switch').count() === 1
            && await fieldRowOf(page, '交通補助').getByRole('switch', { name: '顯示「交通補助」' }).count() === 1
            && await fieldRowOf(page, '上課時數').getByRole('switch').count() === 0);
        writes = [];
        await panelOf(page, 'fields').locator('[data-add-field]').click();
        await editor(page).waitFor();
        await editor(page).getByRole('button', { name: '儲存' }).click();
        check('新增欄位：名稱空白被擋', (await editor(page).locator('[data-editor-error]').innerText()) === '請輸入欄位名稱。' && writes.length === 0);
        await editor(page).getByLabel('欄位名稱').fill('教室設備');
        await editor(page).getByLabel('類型').selectOption('select');
        await editor(page).getByRole('button', { name: '儲存' }).click();
        check('下拉選單沒有任何選項被擋', (await editor(page).locator('[data-editor-error]').innerText()) === '下拉選單至少要有一個選項（一行一個）。' && writes.length === 0);
        await editor(page).getByLabel('欄位名稱').fill('課程名稱');
        await editor(page).getByLabel('下拉選項（一行一個）').fill('投影機');
        await editor(page).getByRole('button', { name: '儲存' }).click();
        check('欄位名稱與同版面欄位重複被擋', (await editor(page).locator('[data-editor-error]').innerText()) === '這個版面已經有同名的欄位。' && writes.length === 0);
        await editor(page).getByLabel('欄位名稱').fill('教室設備');
        await editor(page).getByLabel('下拉選項（一行一個）').fill('投影機\n白板\n投影機\n  延長線 ');
        await editor(page).getByLabel('說明文字（選填，講師會看到）').fill('勾選最主要用到的');
        await editor(page).getByRole('switch', { name: '必填', exact: true }).click();
        await editor(page).getByRole('button', { name: '儲存' }).click();
        await until(() => writes.length === 1);
        const created = writes[0]?.body;
        check('新增下拉型自訂欄位 payload：layout／field_key 以 custom_ 開頭／source=custom／options 陣列／help_text／is_required／is_visible／sort_order＝最大＋10',
            writes.length === 1 && writes[0].method === 'POST' && writes[0].table === 'salary_report_fields'
            && created.layout === 'b2c_direct' && /^custom_[a-z0-9]{10}$/.test(created.field_key)
            && sameBody({ ...created, field_key: 'X' }, {
                layout: 'b2c_direct', field_key: 'X', source: 'custom', label: '教室設備', field_type: 'select',
                options: ['投影機', '白板', '延長線'], help_text: '勾選最主要用到的', is_required: true, is_visible: true, sort_order: 60,
            }));
        await until(async () => await fieldRowOf(page, '教室設備').count() > 0);
        const newRow = fieldRowOf(page, '教室設備');
        check('新欄位出現在清單最後，標籤「自訂・下拉選單」與「必填」，編輯面板收起',
            (await fieldLabels(page)).at(-1) === '教室設備'
            && await newRow.getByText('自訂・下拉選單').isVisible() && await newRow.getByText('必填', { exact: true }).isVisible()
            && await editor(page).count() === 0);
        // 是／否類型不能設必填
        await panelOf(page, 'fields').locator('[data-add-field]').click();
        await editor(page).getByLabel('類型').selectOption('boolean');
        check('是／否勾選類型：必填開關停用', await editor(page).getByRole('switch', { name: '必填', exact: true }).isDisabled());
        await editor(page).getByRole('button', { name: '取消' }).click();

        // 欄位拖曳：鍵盤與滑鼠
        writes = [];
        ids = fieldIds('b2c_direct');
        await keyboardDrag(page, handleOf(panelOf(page, 'fields'), '課程名稱'), 'ArrowDown');
        await until(() => writes.some(w => w.method === 'RPC'));
        check('欄位鍵盤拖曳：呼叫 reorder_salary_report_fields，p_ids＝該版面全部欄位、第一二互換',
            writes.length === 1 && writes[0].name === 'reorder_salary_report_fields'
            && same(writes[0].body, { p_ids: [ids[1], ids[0], ...ids.slice(2)] }));
        await until(async () => (await savedLine(page, 'fields')) === '已儲存順序');
        check('欄位拖曳成功顯示「已儲存順序」，畫面順序改變', (await savedLine(page, 'fields')) === '已儲存順序' && (await fieldLabels(page))[0] === '上課時數');
        await pause(400);
        writes = [];
        ids = fieldIds('b2c_direct');
        const fieldOrder = await fieldLabels(page);
        await mouseDrag(page, handleOf(panelOf(page, 'fields'), fieldOrder[3]), handleOf(panelOf(page, 'fields'), fieldOrder[0]), -6);
        await until(() => writes.some(w => w.method === 'RPC'));
        check('欄位滑鼠拖曳（第四列拖到最前）：p_ids 順序正確', writes.length === 1 && same(writes[0].body, { p_ids: [ids[3], ids[0], ids[1], ids[2], ids[4], ids[5]] }));
        await until(async () => (await fieldLabels(page))[0] === fieldOrder[3]);
        await pause(400);
        // 欄位 RPC 失敗還原
        writes = [];
        forceRpcFail = true;
        const fieldBefore = await fieldLabels(page);
        await keyboardDrag(page, handleOf(panelOf(page, 'fields'), fieldBefore[0]), 'ArrowDown');
        await until(() => writes.some(w => w.method === 'RPC'));
        await until(async () => (await noticeOf(page, 'fields')).includes('儲存順序失敗'));
        await pause(300);
        check('欄位排序 RPC 失敗：顯示錯誤並還原順序', (await noticeOf(page, 'fields')).includes('儲存順序失敗') && same(await fieldLabels(page), fieldBefore));
        forceRpcFail = false;

        // 讀取失敗（資料庫還沒套 migration）
        forceFieldsLoadError = true;
        await page.getByRole('button', { name: '重新整理' }).click();
        await panelOf(page, 'fields').locator('[data-fields-load-error]').waitFor();
        check('讀取欄位失敗顯示「讀取表單欄位失敗，資料庫可能還沒套用 2026-10-20 的更新」',
            (await panelOf(page, 'fields').locator('[data-fields-load-error]').innerText()).startsWith('讀取表單欄位失敗，資料庫可能還沒套用 2026-10-20 的更新'));
        forceFieldsLoadError = false;
        await page.getByRole('button', { name: '重新整理' }).click();
        await until(async () => await panelOf(page, 'fields').locator('[data-fields-load-error]').count() === 0);
        await fieldRowOf(page, '上課時數').waitFor();
        check('資料庫恢復後按重新整理可重新讀到欄位', await panelOf(page, 'fields').locator('[data-field-row]').count() > 0);

        // 切回選項分頁：仍停在原本選的期間（面板只是藏起來）
        await mainTabs.nth(0).click();
        check('切回下拉選單內容：期間 chip 都在、仍選著剛才的期間', (await chipLabels(page)).length === 6
            && await page.locator('[data-period-chip="t2"]').getAttribute('aria-pressed') === 'true');
        check('整個過程沒有 console 錯誤或頁面例外（排除預期內的 mock 失敗回應）',
            consoleErrors.filter(text => !/Failed to load resource|status of (4|5)\d\d|net::ERR/.test(text)).length === 0);
        if (consoleErrors.length) console.log('  console:', JSON.stringify(consoleErrors.slice(0, 5)));
        await context.close();

        // ══════════ 非 admin 被導走 ══════════
        for (const role of ['teacher', 'mentor']) {
            appRole = role;
            context = await contextFor(browser, { width: 1280, height: 900 });
            page = await context.newPage();
            await page.goto(`${base}/admin/salary/options`, { waitUntil: 'networkidle' });
            await until(async () => !new URL(page.url()).pathname.startsWith('/admin'));
            check(`${role} 進 /admin/salary/options 被導離後台`,
                !new URL(page.url()).pathname.startsWith('/admin') && await page.getByRole('heading', { name: '回報選項管理', level: 1 }).count() === 0);
            await context.close();
        }
        appRole = 'mentor';
        context = await contextFor(browser, { width: 1280, height: 900 });
        page = await context.newPage();
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor();
        check('mentor 的報酬登記中心沒有「回報選項管理」入口', await page.getByRole('link', { name: '回報選項管理' }).count() === 0);
        await context.close();

        // ══════════ 手機 390px ══════════
        appRole = 'admin';
        tableRows = seedOptions();
        fieldRows = seedFields();
        context = await contextFor(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await openOptions(page, base);
        await page.getByText(LONG_UNIT).first().waitFor();
        check('390px 下拉選單內容分頁無水平溢出', (await overflowOf(page)) === 0);
        let tooSmall = await smallTargets(page);
        check('390px 下拉選單內容：所有按鈕／輸入／開關熱區 ≥44px', tooSmall.length === 0);
        if (tooSmall.length) console.log('  too small:', JSON.stringify(tooSmall));
        const mobileHeights = await page.locator('[data-option-row]').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
        check(`390px 清單列最高 ${Math.max(...mobileHeights)}px（長名稱最多折兩行，≤72px）`, Math.max(...mobileHeights) <= 72);
        await pause(500);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-options.png'), fullPage: true });
        await page.locator('[data-new-period-toggle]').click();
        await page.locator('[data-new-period-panel]').waitFor();
        check('390px 新增期間面板無水平溢出、熱區 ≥44px', (await overflowOf(page)) === 0 && (await smallTargets(page)).length === 0);
        await page.locator('[data-new-period-toggle]').click();
        await rowOf(page, 'partner_unit', LONG_UNIT).getByRole('button', { name: /^改名「/ }).click();
        check('390px 改名編輯狀態無水平溢出、熱區 ≥44px', (await overflowOf(page)) === 0 && (await smallTargets(page)).length === 0);
        await page.getByRole('button', { name: '取消改名' }).click();
        await page.getByRole('tab', { name: '回報表單欄位' }).click();
        await panelOf(page, 'fields').locator('[data-field-row]').first().waitFor();
        await page.getByRole('tab', { name: 'B2B 合作單位' }).click();
        await fieldRowOf(page, '使用的教具').waitFor();
        check('390px 回報表單欄位分頁無水平溢出', (await overflowOf(page)) === 0);
        tooSmall = await smallTargets(page);
        check('390px 回報表單欄位：所有按鈕／輸入／開關熱區 ≥44px', tooSmall.length === 0);
        if (tooSmall.length) console.log('  too small:', JSON.stringify(tooSmall));
        await pause(500);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-fields.png'), fullPage: true });
        await fieldRowOf(page, '使用的教具').getByRole('button', { name: '編輯「使用的教具」' }).click();
        await editor(page).waitFor();
        check('390px 欄位編輯面板無水平溢出、熱區 ≥44px', (await overflowOf(page)) === 0 && (await smallTargets(page)).length === 0);
        await pause(300);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-field-editor.png'), fullPage: true });
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
