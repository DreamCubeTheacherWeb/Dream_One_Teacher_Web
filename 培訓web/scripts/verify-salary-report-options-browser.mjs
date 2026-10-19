#!/usr/bin/env node
// 後台「回報選項管理」頁：以 mock Supabase 實際操作（桌機＋390px），驗證送出的 payload 與權限導向。
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
const shotDir = path.join(appDir, 'docs/verification/2026-10-18-salary-report-options');
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
const seedRows = () => [
    { id: 't1', kind: 'term_period', value: 'winter_break', label: '寒假', sort_order: 10, is_active: true },
    { id: 't2', kind: 'term_period', value: 'semester', label: '學期間', sort_order: 20, is_active: true },
    { id: 't3', kind: 'term_period', value: 'summer_break', label: '暑假', sort_order: 30, is_active: true },
    { id: 'p1', kind: 'partner_unit', value: '【新竹】康乃薾中小學', label: '【新竹】康乃薾中小學', sort_order: 10, is_active: true },
    { id: 'p2', kind: 'partner_unit', value: '【週二】再興魔方高手 入門班115上', label: '【週二】再興魔方高手 入門班115上', sort_order: 20, is_active: true },
    { id: 'p3', kind: 'partner_unit', value: LONG_UNIT, label: LONG_UNIT, sort_order: 30, is_active: true },
    { id: 'p4', kind: 'partner_unit', value: '【舊】已結束的合作單位', label: '【舊】已結束的合作單位', sort_order: 40, is_active: false },
    { id: 'c1', kind: 'camp_batch', value: '【臺北A】中山 | 7/1~7/3 三日營', label: '【臺北A】中山 | 7/1~7/3 三日營', sort_order: 10, is_active: true },
    { id: 'c2', kind: 'camp_batch', value: '【高雄H】苓雅 | 8/15~8/16 速解營', label: '【高雄H】苓雅 | 8/15~8/16 速解營', sort_order: 20, is_active: true },
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
let tableRows = seedRows();
let writes = []; // { method, body, id }
let forceDuplicate = false;
let forceZeroRows = false;
let idCounter = 0;

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
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);

    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        const method = request.method();

        if (table === 'salary_report_options') {
            if (method === 'GET') return json(route, tableRows);
            if (method === 'POST') {
                const body = request.postDataJSON();
                writes.push({ method, body });
                if (forceDuplicate || tableRows.some(r => r.kind === body.kind && r.value === body.value)) {
                    return json(route, { code: '23505', message: 'duplicate key value violates unique constraint "salary_report_options_kind_value_key"' }, 409);
                }
                const row = { id: `new-${++idCounter}`, is_active: true, ...body };
                tableRows.push(row);
                return json(route, [row], 201);
            }
            if (method === 'PATCH') {
                const body = request.postDataJSON();
                const id = (url.searchParams.get('id') || '').replace('eq.', '');
                writes.push({ method, body, id });
                if (forceZeroRows) return json(route, []);
                const row = tableRows.find(r => r.id === id);
                if (!row) return json(route, []);
                Object.assign(row, body);
                return json(route, [row]);
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
const check = (name, condition) => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
};

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
const notice = async (page) => {
    const locator = page.locator('[role="alert"], [role="status"]');
    return (await locator.count()) ? (await locator.first().innerText()).trim() : '';
};
const rowLabels = (page) => page.locator('[data-option-row] p.font-black').allInnerTexts();
const rowFor = (page, label) => page.locator('[data-option-row]', { hasText: label });

async function openOptions(page, base) {
    await page.goto(`${base}/admin/salary/options`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '回報選項管理', level: 1 }).waitFor();
    await page.locator('[data-option-row]').first().waitFor();
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

        // ── 管理員從薪資登記中心的入口進來
        appRole = 'admin';
        let context = await contextFor(browser, { width: 1280, height: 900 });
        let page = await context.newPage();
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '薪資登記中心' }).waitFor();
        const entry = page.getByRole('link', { name: '回報選項管理' });
        check('薪資登記中心頁首有「回報選項管理」入口', await entry.isVisible());
        await entry.click();
        await page.getByRole('heading', { name: '回報選項管理', level: 1 }).waitFor();
        check('點入口進到 /admin/salary/options', new URL(page.url()).pathname === '/admin/salary/options');

        // ── 三籤
        await page.locator('[data-option-row]').first().waitFor();
        const tabs = await page.getByRole('tab').allInnerTexts();
        check('三個分頁籤：教學課程期間／合作單位／營隊梯次', JSON.stringify(tabs) === JSON.stringify(['教學課程期間', '合作單位', '營隊梯次']));
        check('預設為教學課程期間，列出 3 項固定期間', JSON.stringify(await rowLabels(page)) === JSON.stringify(['寒假', '學期間', '暑假']));
        check('教學課程期間籤沒有新增欄位與新增按鈕',
            await page.getByRole('button', { name: '新增', exact: true }).count() === 0
            && await page.getByLabel(/新增.*選項/).count() === 0);
        check('畫面說明「停用後講師看不到，舊紀錄不受影響」', await page.getByText('停用後講師看不到，舊紀錄不受影響').isVisible());
        check('任何分頁都沒有刪除按鈕', await page.getByRole('button', { name: /刪除/ }).count() === 0);
        await page.screenshot({ path: path.join(shotDir, 'desktop-term-period.png'), fullPage: true });

        // 期間改名只送 label（value 是固定代碼）
        writes = [];
        await rowFor(page, '學期間').getByRole('button', { name: /改名/ }).click();
        await page.getByLabel('編輯「學期間」的顯示文字').fill('學期中');
        await page.getByRole('button', { name: '儲存' }).click();
        await until(() => writes.length === 1);
        check('教學期間改名只送 label，value 保持固定代碼',
            writes.length === 1 && writes[0].method === 'PATCH' && writes[0].id === 't2'
            && JSON.stringify(writes[0].body) === JSON.stringify({ label: '學期中' }));
        check('改名後畫面顯示新文字', (await rowLabels(page)).includes('學期中'));

        // ── 合作單位
        await page.getByRole('tab', { name: '合作單位' }).click();
        await page.getByText('【新竹】康乃薾中小學').first().waitFor();
        const unitLabels = await rowLabels(page);
        check('合作單位列出全部 4 項（含停用）', unitLabels.length === 4);
        check('停用項灰色標示「已停用，講師看不到」', await rowFor(page, '【舊】已結束的合作單位').getByText('已停用，講師看不到').isVisible());
        await page.screenshot({ path: path.join(shotDir, 'desktop-partner-unit.png'), fullPage: true });

        // 新增：空白被擋
        writes = [];
        await page.getByRole('button', { name: '新增', exact: true }).click();
        check('新增空白被擋且不送出', (await notice(page)) === '請輸入選項文字。' && writes.length === 0);
        // 超長被擋
        await page.getByLabel('新增合作單位選項').fill('長'.repeat(201));
        await page.getByRole('button', { name: '新增', exact: true }).click();
        check('新增超過 200 字被擋且不送出', (await notice(page)).includes('不得超過 200 字') && writes.length === 0);
        // 重複被擋（前端）
        await page.getByLabel('新增合作單位選項').fill('【新竹】康乃薾中小學');
        await page.getByRole('button', { name: '新增', exact: true }).click();
        check('新增重複選項在前端被擋', (await notice(page)) === '這個分頁已經有相同的選項。' && writes.length === 0);
        // 成功新增
        await page.getByLabel('新增合作單位選項').fill('  【桃園】新增合作國小  ');
        await page.getByRole('button', { name: '新增', exact: true }).click();
        await until(() => writes.length === 1);
        check('新增送出 payload：kind／value＝label／label／sort_order＝最大值＋10',
            writes.length === 1 && writes[0].method === 'POST'
            && JSON.stringify(writes[0].body) === JSON.stringify({ kind: 'partner_unit', value: '【桃園】新增合作國小', label: '【桃園】新增合作國小', sort_order: 50 }));
        await until(async () => (await rowLabels(page)).includes('【桃園】新增合作國小'));
        check('新增後列在最後一列並顯示成功訊息', (await rowLabels(page)).at(-1) === '【桃園】新增合作國小' && (await notice(page)).includes('已新增'));
        // 伺服器端唯一鍵衝突 23505 → 友善訊息
        forceDuplicate = true;
        await page.getByLabel('新增合作單位選項').fill('【桃園】另一個新單位');
        await page.getByRole('button', { name: '新增', exact: true }).click();
        await until(async () => (await notice(page)).includes('已經有相同'));
        check('伺服器回 23505 時顯示友善訊息', (await notice(page)) === '這個分頁已經有相同的選項。');
        forceDuplicate = false;

        // 改名：合作單位 value 一起改
        writes = [];
        await rowFor(page, '【週二】再興魔方高手 入門班115上').getByRole('button', { name: /改名/ }).click();
        await page.getByLabel(/編輯「【週二】再興魔方高手 入門班115上」/).fill('【週二】再興魔方高手 進階班115上');
        await page.getByRole('button', { name: '儲存' }).click();
        await until(() => writes.length === 1);
        check('合作單位改名送 update（label 與 value 同步，id 正確）',
            writes.length === 1 && writes[0].method === 'PATCH' && writes[0].id === 'p2'
            && JSON.stringify(writes[0].body) === JSON.stringify({ label: '【週二】再興魔方高手 進階班115上', value: '【週二】再興魔方高手 進階班115上' }));
        // 改名成空白被擋
        writes = [];
        await rowFor(page, '【新竹】康乃薾中小學').getByRole('button', { name: /改名/ }).click();
        await page.getByLabel(/編輯「【新竹】康乃薾中小學」/).fill('   ');
        await page.getByRole('button', { name: '儲存' }).click();
        check('改名成空白被擋且不送出', (await notice(page)) === '請輸入選項文字。' && writes.length === 0);
        await page.getByRole('button', { name: '取消' }).click();

        // 停用／啟用
        writes = [];
        await page.getByRole('switch', { name: '啟用「【新竹】康乃薾中小學」' }).click();
        await until(() => writes.length === 1);
        check('停用送 update is_active=false',
            writes.length === 1 && writes[0].id === 'p1' && JSON.stringify(writes[0].body) === JSON.stringify({ is_active: false }));
        await until(async () => await rowFor(page, '【新竹】康乃薾中小學').getByText('已停用，講師看不到').count() > 0);
        check('停用後該列出現灰色「已停用」標示', await rowFor(page, '【新竹】康乃薾中小學').getByText('已停用，講師看不到').isVisible());
        writes = [];
        await page.getByRole('switch', { name: '啟用「【新竹】康乃薾中小學」' }).click();
        await until(() => writes.length === 1);
        check('重新啟用送 update is_active=true', writes.length === 1 && JSON.stringify(writes[0].body) === JSON.stringify({ is_active: true }));

        // 上移／下移
        const before = Object.fromEntries(tableRows.filter(r => r.kind === 'partner_unit').map(r => [r.id, r.sort_order]));
        writes = [];
        await page.getByRole('button', { name: '上移「【週二】再興魔方高手 進階班115上」' }).click();
        await until(() => writes.length === 2);
        const moved = Object.fromEntries(writes.map(w => [w.id, w.body.sort_order]));
        check('上移送 2 筆 update，交換兩者 sort_order',
            writes.length === 2 && writes.every(w => w.method === 'PATCH' && Object.keys(w.body).join() === 'sort_order')
            && moved.p2 === before.p1 && moved.p1 === before.p2);
        await until(async () => (await rowLabels(page))[0].includes('進階班'));
        check('上移後畫面順序互換', (await rowLabels(page))[0] === '【週二】再興魔方高手 進階班115上' && (await rowLabels(page))[1] === '【新竹】康乃薾中小學');
        check('第一列的上移鈕停用、最後一列的下移鈕停用',
            await page.getByRole('button', { name: '上移「【週二】再興魔方高手 進階班115上」' }).isDisabled()
            && await page.getByRole('button', { name: '下移「【桃園】新增合作國小」' }).isDisabled());
        writes = [];
        await page.getByRole('button', { name: '下移「【週二】再興魔方高手 進階班115上」' }).click();
        await until(() => writes.length === 2);
        check('下移也是交換兩筆 sort_order', writes.length === 2 && writes.every(w => Object.keys(w.body).join() === 'sort_order'));

        // 資料庫沒更新到任何列（RLS 擋下）要顯示錯誤，不可靜默
        forceZeroRows = true;
        await page.getByRole('switch', { name: '啟用「【舊】已結束的合作單位」' }).click();
        await until(async () => (await notice(page)).includes('沒有更新到任何資料'));
        check('更新 0 筆（RLS 擋下）顯示錯誤訊息', (await notice(page)).includes('沒有更新到任何資料'));
        forceZeroRows = false;

        // ── 營隊梯次
        await page.getByRole('tab', { name: '營隊梯次' }).click();
        await page.getByText('【臺北A】中山 | 7/1~7/3 三日營').first().waitFor();
        check('營隊梯次列出 2 項且有新增欄位', (await rowLabels(page)).length === 2 && await page.getByLabel('新增營隊梯次選項').isVisible());
        writes = [];
        await page.getByLabel('新增營隊梯次選項').fill('【台中B】西屯 | 7/20~7/22 三日營');
        await page.getByRole('button', { name: '新增', exact: true }).click();
        await until(() => writes.length === 1);
        check('營隊梯次新增 payload kind=camp_batch、sort_order=30',
            writes.length === 1 && JSON.stringify(writes[0].body) === JSON.stringify({ kind: 'camp_batch', value: '【台中B】西屯 | 7/20~7/22 三日營', label: '【台中B】西屯 | 7/20~7/22 三日營', sort_order: 30 }));
        await page.screenshot({ path: path.join(shotDir, 'desktop-camp-batch.png'), fullPage: true });
        await context.close();

        // ── 非 admin 被導走（teacher、mentor）
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
        // mentor 看得到薪資登記中心，但沒有選項管理入口
        appRole = 'mentor';
        context = await contextFor(browser, { width: 1280, height: 900 });
        page = await context.newPage();
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '薪資登記中心' }).waitFor();
        check('mentor 的薪資登記中心沒有「回報選項管理」入口', await page.getByRole('link', { name: '回報選項管理' }).count() === 0);
        await context.close();

        // ── 手機 390px
        appRole = 'admin';
        tableRows = seedRows();
        context = await contextFor(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await openOptions(page, base);
        check('390px 教學課程期間籤無水平溢出', (await overflowOf(page)) === 0);
        await page.getByRole('tab', { name: '合作單位' }).click();
        await page.getByText(LONG_UNIT).first().waitFor();
        check('390px 合作單位籤（含長名稱）無水平溢出', (await overflowOf(page)) === 0);
        const smallTargets = await page.evaluate(() => [...document.querySelectorAll('main button, main a, main input')]
            .filter(el => el.offsetParent !== null)
            .map(el => ({ text: (el.getAttribute('aria-label') || el.textContent || el.placeholder || '').trim().slice(0, 20), w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }))
            .filter(item => item.h < 43.5 || item.w < 43.5));
        check('390px 所有按鈕／連結／輸入熱區 ≥44px', smallTargets.length === 0);
        if (smallTargets.length) console.log('  too small:', JSON.stringify(smallTargets));
        await rowFor(page, '【新竹】康乃薾中小學').getByRole('button', { name: /改名/ }).click();
        check('390px 改名編輯狀態無水平溢出', (await overflowOf(page)) === 0);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-partner-unit.png'), fullPage: true });
        await page.getByRole('button', { name: '取消' }).click();
        await page.getByRole('tab', { name: '營隊梯次' }).click();
        check('390px 營隊梯次籤無水平溢出', (await overflowOf(page)) === 0);
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
