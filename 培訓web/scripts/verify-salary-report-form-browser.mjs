#!/usr/bin/env node
// 課程回報對齊 Google 表單：以 mock Supabase 實際操作站內回報頁與後台明細（桌機＋390px 手機）。
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
const { categoriesInChannel, courseCategoryConfig, courseCategoryFor, reportChannelFor, teacherCourseItems } = await import(path.join(appDir, 'src/lib/constants.js'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-19-salary-report-form-channel');
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
    { kind: 'term_period', value: 'winter_break', label: '2026年寒假', sort_order: 10, is_active: true },
    { kind: 'term_period', value: 'semester', label: '115學年度上學期', sort_order: 20, is_active: true },
    { kind: 'term_period', value: 'summer_break', label: '2026年暑假', sort_order: 30, is_active: true },
    { kind: 'partner_unit', term_scope: 'vacation', value: '【新竹】康乃薾中小學 G3-6 / G1-2 / 幼兒園A、B、C', label: '【新竹】康乃薾中小學 G3-6 / G1-2 / 幼兒園A、B、C', sort_order: 10, is_active: true },
    { kind: 'partner_unit', term_scope: 'vacation', value: '【基隆】三之三立敏分校', label: '【基隆】三之三立敏分校', sort_order: 20, is_active: true },
    { kind: 'partner_unit', term_scope: 'semester', value: '【週二】再興魔方高手 入門班115上', label: '【週二】再興魔方高手 入門班115上', sort_order: 490, is_active: true },
    { kind: 'partner_unit', term_scope: 'semester', value: '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動', label: '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動', sort_order: 500, is_active: true },
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
    { ...baseSession, id: '30000000-0000-4000-8000-000000000053', course_type: 'camp', course_name: null, session_date: '2026-10-12', month_label: '2026/10', duration_hours: null, student_count: 8, base_salary: 3000, total_salary: 3000, unit_name: '【臺北A】中山 | 7/1~7/3 三日營' },
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
const alertText = async (page) => (await page.getByRole('alert').count()) ? (await page.getByRole('alert').innerText()).trim() : '';

async function openReport(page, base) {
    await page.goto(`${base}/my/salary/new`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '登記課程回報' }).waitFor();
}

// 2026-10-19 起回報頁照兩份 Google 表單分層：回報類別（B2C／B2B／其他）→ 課程種類（類別只有一種時不顯示）
// → 第三層（同一種課有多個報酬規則時才顯示；合作課叫「課程講師身分別」、營隊叫「是否為營隊負責人」、其餘叫「報酬項目」）
async function pickCourse(page, courseType) {
    const categoryKey = courseCategoryFor(courseType);
    const channel = reportChannelFor(courseType);
    await page.getByLabel('回報類別').selectOption(channel);
    if (categoriesInChannel(channel).length > 1) await page.getByLabel('課程種類').selectOption(categoryKey);
    if (categoryKey !== 'onsite' && teacherCourseItems(categoryKey).length > 1) {
        await page.getByLabel(courseCategoryConfig(categoryKey)?.itemLabel || '報酬項目', { exact: true }).selectOption(courseType);
    }
}
// 表單第一個格線區的欄位標籤順序（確認上課日期固定在回報類別之後）
const fieldOrder = (page) => page.locator('form > div.grid').first().locator(':scope > label > span.bh-label').allInnerTexts();
const fillBasics = async (page, { name, hours, students }) => {
    if (name !== undefined) await page.getByLabel('課程名稱', { exact: true }).fill(name);
    if (hours !== undefined) {
        const hoursField = page.getByLabel('上課時數', { exact: true });
        if ((await hoursField.evaluate(el => el.tagName)) === 'SELECT') await hoursField.selectOption(hours);
        else await hoursField.fill(hours);
    }
    if (students !== undefined) await page.getByLabel('上課人數', { exact: true }).fill(students);
};

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

        // ── 桌機：三種課型的條件欄位切換與送出內容
        appRole = 'teacher';
        let context = await contextFor(browser, { width: 1280, height: 900 });
        let page = await context.newPage();
        await openReport(page, base);

        // 分層選單：回報類別 → 課程種類 → 第三層
        const optionLabels = async (label) => page.getByLabel(label, { exact: true }).locator('option').allInnerTexts();
        check('回報類別預設 B2C 直營，選項為 B2C／B2B／其他', await page.getByLabel('回報類別').inputValue() === 'b2c'
            && JSON.stringify(await optionLabels('回報類別')) === JSON.stringify(['B2C 直營課程部', 'B2B 合作單位課程', '其他課程']));
        check('回報類別下方有三行備註說明哪種課選哪個',
            await page.getByText('同「課後回報表單｜二處 B2C 版本」').isVisible()
            && await page.getByText('同「B2B 合作單位課程 課後回報單」').isVisible()
            && await page.getByText('不在上面兩份表單裡的課').isVisible());
        check('B2C 的課程種類與二處表單選項一字不差', JSON.stringify(await optionLabels('課程種類')) === JSON.stringify([
            '到府家教課 or 到府揪團課', '線上課程', '體驗課', '速解研究所｜實體課程', '速解研究所｜線上課程', '寒暑假營隊 二日營、五日營']));
        check('B2C 到府課欄位照表單：課程名稱、時數下拉（1／1.5／2／2.5／3／其他）、人數、交通補助；沒有角色／地點／自評／進度',
            await page.getByLabel('課程名稱', { exact: true }).isVisible()
            && JSON.stringify(await optionLabels('上課時數')) === JSON.stringify(['請選擇', '1', '1.5', '2', '2.5', '3', '其他（自行填寫）'])
            && await page.getByLabel('上課人數', { exact: true }).isVisible()
            && await page.getByLabel('申請交通補助').isVisible()
            && await page.getByLabel('角色').count() === 0 && await page.getByLabel('地點').count() === 0
            && await page.getByLabel('課程自評').count() === 0 && await page.getByLabel('學習進度').count() === 0);
        check('到府課不顯示報酬項目（由時數自動判斷 1.5hr／2hr）', await page.getByLabel('報酬項目').count() === 0);
        check('B2C 到府：上課日期固定在回報類別之後第二格', (await fieldOrder(page))[1]?.trim().startsWith('上課日期'));
        await page.getByLabel('課程種類').selectOption('trial');
        check('體驗課只有一個報酬項目時第三層自動帶入並隱藏', await page.getByLabel('報酬項目').count() === 0);
        await page.getByLabel('上課時數', { exact: true }).selectOption('__other__');
        check('時數選「其他」出現自填欄位', await page.getByLabel('上課時數（自行填寫）').isVisible());
        await page.getByLabel('課程種類').selectOption('camp');
        check('營隊照表單問「是否為營隊負責人」、有梯次與人數、沒有時數與課程名稱',
            JSON.stringify(await optionLabels('是否為營隊負責人')) === JSON.stringify(['否（一般講師）', '否（一般講師，速解營）', '是（5 日營負責人）', '是（4 日營負責人）', '是（2 日營負責人）'])
            && await page.getByLabel('營隊梯次').isVisible() && await page.getByLabel('上課人數', { exact: true }).isVisible()
            && await page.getByLabel('上課時數', { exact: true }).count() === 0 && await page.getByLabel('課程名稱', { exact: true }).count() === 0);
        check('B2C 營隊：上課日期仍在第二格', (await fieldOrder(page))[1]?.trim().startsWith('上課日期'));
        await page.screenshot({ path: path.join(shotDir, 'desktop-channel-b2c-camp.png'), fullPage: true });
        await page.getByLabel('回報類別').selectOption('b2b');
        check('B2B 照表單：沒有課程種類與課程名稱，有身分別（主講／助教）、期間、單位、時數、人數、教材，沒有交通補助',
            await page.getByLabel('課程種類').count() === 0 && await page.getByLabel('課程名稱', { exact: true }).count() === 0
            && JSON.stringify(await optionLabels('課程講師身分別')) === JSON.stringify(['合作課程 主講', '合作課程 助教'])
            && await page.getByLabel('教學課程期間').isVisible() && await page.getByLabel('本次上課單位', { exact: true }).isVisible()
            && await page.getByLabel('上課時數', { exact: true }).isVisible() && await page.getByLabel('上課人數', { exact: true }).isVisible()
            && await page.getByLabel('本次發出教材數量').isVisible() && await page.getByLabel('申請交通補助').count() === 0
            && await page.getByLabel('地點').count() === 0 && await page.getByLabel('課程自評').count() === 0);
        check('B2B：上課日期仍在第二格；未選期間前單位下拉提示先選期間',
            (await fieldOrder(page))[1]?.trim().startsWith('上課日期')
            && (await page.getByLabel('本次上課單位', { exact: true }).locator('option').allInnerTexts()).join('') === '請先選擇教學課程期間，再選單位');
        check('教學課程期間選項文字照 B2B 表單', JSON.stringify(await optionLabels('教學課程期間')) === JSON.stringify(['請選擇寒假、學期間或暑假', '2026年寒假', '115學年度上學期', '2026年暑假']));
        await page.getByLabel('教學課程期間').selectOption('winter_break');
        check('選寒假 → 只列寒暑假清單', JSON.stringify(await page.getByLabel('本次上課單位', { exact: true }).locator('option').allInnerTexts())
            === JSON.stringify(['請選擇合作單位', '【新竹】康乃薾中小學 G3-6 / G1-2 / 幼兒園A、B、C', '【基隆】三之三立敏分校', '其它（清單沒有，自行填寫）']));
        await page.getByLabel('本次上課單位', { exact: true }).selectOption('【基隆】三之三立敏分校');
        await page.getByLabel('教學課程期間').selectOption('semester');
        check('改選學期間 → 只列學期間清單，且先前選的寒暑假單位被清掉', JSON.stringify(await page.getByLabel('本次上課單位', { exact: true }).locator('option').allInnerTexts())
            === JSON.stringify(['請選擇合作單位', '【週二】再興魔方高手 入門班115上', '【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動', '其它（清單沒有，自行填寫）'])
            && await page.getByLabel('本次上課單位', { exact: true }).inputValue() === '');
        await page.screenshot({ path: path.join(shotDir, 'desktop-channel-b2b.png'), fullPage: true });
        await page.getByLabel('回報類別').selectOption('other');
        check('其他課程維持完整欄位（常態課、角色、地點、自評、進度）',
            JSON.stringify(await optionLabels('課程種類')) === JSON.stringify(['常態課', '幼兒啟蒙', '速解培訓', '站櫃／擺攤', '其他'])
            && await page.getByLabel('角色').isVisible() && await page.getByLabel('地點').isVisible()
            && await page.getByLabel('課程自評').isVisible() && await page.getByLabel('學習進度').isVisible());
        await page.getByLabel('回報類別').selectOption('b2c');
        check('切回 B2C 回到到府家教課（無報酬項目）', await page.getByLabel('課程種類').inputValue() === 'onsite'
            && await page.getByLabel('報酬項目').count() === 0);

        // B2C 直營（預設到府）→ 表單必填與交通補助
        await page.getByRole('button', { name: '送出回報' }).click();
        check('直營課沒填課程名稱被擋', (await alertText(page)) === '請填寫課程名稱（學生代表姓名或課程地點）。' && submitBodies.length === 0);
        await fillBasics(page, { name: '王小明', hours: '1.5', students: '2' });
        check('直營課顯示交通補助開關', await page.getByLabel('申請交通補助').isVisible());
        check('交通補助旁顯示業主備註（15 公里、事先和課程經理確認、交通方式提前報備）',
            await page.getByText('備註：超過15公里才得以申請，需要事先和課程經理確認，交通方式也需提前報備確認。').isVisible());
        check('直營課不顯示上課單位／營隊梯次／教學期間',
            await page.getByLabel('本次上課單位').count() === 0
            && await page.getByLabel('營隊梯次').count() === 0
            && await page.getByLabel('教學課程期間').count() === 0);
        check('未勾交通補助時不顯示公里數', await page.getByLabel('單趟公里數').count() === 0);
        await page.getByLabel('申請交通補助').check();
        check('勾選交通補助後出現單趟公里數', await page.getByLabel('單趟公里數').isVisible());
        await page.getByRole('button', { name: '送出回報' }).click();
        check('勾了交通補助沒填公里數被擋', (await alertText(page)) === '申請交通補助請填寫單趟公里數。' && submitBodies.length === 0);
        await page.getByLabel('單趟公里數').fill('501');
        await page.getByRole('button', { name: '送出回報' }).click();
        check('公里數超過 500 被擋', (await alertText(page)) === '單趟公里數必須大於 0 且不超過 500 公里。' && submitBodies.length === 0);
        await page.getByLabel('單趟公里數').fill('12.35');
        await page.screenshot({ path: path.join(shotDir, 'desktop-direct-transport.png'), fullPage: true });

        // 合作課 → 期間＋單位＋教材，交通補助隱藏
        await pickCourse(page, 'collab_lead');
        await page.getByLabel('教學課程期間').selectOption(''); // 前面的分層檢查已選過期間，這裡回到未選
        check('合作課顯示教學課程期間／上課單位／教材數量',
            await page.getByLabel('教學課程期間').isVisible()
            && await page.getByLabel('本次上課單位').isVisible()
            && await page.getByLabel('本次發出教材數量').isVisible());
        check('合作課不顯示交通補助', await page.getByLabel('申請交通補助').count() === 0);
        check('教材欄位提示照表單原文精神', (await page.getByLabel('本次發出教材數量').getAttribute('placeholder')).includes('楓葉10，無則打 0'));
        await fillBasics(page, { hours: '', students: '' });
        await page.getByRole('button', { name: '送出回報' }).click();
        check('合作課沒填時數被擋（表單必填）', (await alertText(page)) === '請填寫上課時數。');
        await fillBasics(page, { hours: '2', students: '18' });
        await page.getByRole('button', { name: '送出回報' }).click();
        check('合作課缺教學期間被擋', (await alertText(page)) === '合作課程請選擇教學課程期間。' && submitBodies.length === 0);
        await page.getByLabel('教學課程期間').selectOption('semester');
        await page.getByRole('button', { name: '送出回報' }).click();
        check('合作課缺上課單位被擋', (await alertText(page)) === '合作課程請選擇本次上課單位。' && submitBodies.length === 0);
        const unitOptions = await page.getByLabel('本次上課單位').locator('option').allInnerTexts();
        check('上課單位下拉含該期間清單與「其它」', unitOptions.length === 4 && unitOptions.at(-1).startsWith('其它'));
        await page.getByLabel('本次上課單位').selectOption('__other__');
        check('選「其它」出現自填欄位', await page.getByLabel('本次上課單位（自行填寫）').isVisible());
        await page.getByLabel('本次上課單位（自行填寫）').fill('【臺北】新開合作單位 週五班');
        await page.getByLabel('本次發出教材數量').fill('楓葉10');
        await page.screenshot({ path: path.join(shotDir, 'desktop-collab.png'), fullPage: true });
        await page.getByRole('button', { name: '送出回報' }).click();
        await page.getByText('課程回報已送出，管理員核薪後會更新狀態。').waitFor();
        let body = submitBodies.at(-1);
        check('合作課送出帶期間／自填單位／教材，交通補助為否',
            submitBodies.length === 1 && body.p_course_type === 'collab_lead'
            && body.p_term_period === 'semester' && body.p_unit_name === '【臺北】新開合作單位 週五班'
            && body.p_materials_issued === '楓葉10' && body.p_transport_subsidy_requested === false
            && body.p_transport_distance_km === null
            && body.p_course_name === null && body.p_location === null && body.p_role_in_session === 'lead'
            && body.p_duration_hours === 2 && body.p_student_count === 18);

        // 營隊 → 只顯示營隊梯次
        await openReport(page, base);
        await pickCourse(page, 'camp');
        check('營隊顯示營隊梯次與交通補助、不顯示期間／教材',
            await page.getByLabel('營隊梯次').isVisible()
            && await page.getByLabel('教學課程期間').count() === 0
            && await page.getByLabel('本次發出教材數量').count() === 0
            && await page.getByLabel('申請交通補助').count() === 1);
        await fillBasics(page, { students: '8' });
        await page.getByRole('button', { name: '送出回報' }).click();
        check('營隊缺梯次被擋', (await alertText(page)) === '營隊課程請選擇營隊梯次。' && submitBodies.length === 1);
        await page.getByLabel('營隊梯次').selectOption('【臺北A】中山 | 7/1~7/3 三日營');
        await page.locator('input[inputmode="numeric"]').fill('8');
        await page.screenshot({ path: path.join(shotDir, 'desktop-camp.png'), fullPage: true });
        await page.getByRole('button', { name: '送出回報' }).click();
        await page.getByText('課程回報已送出，管理員核薪後會更新狀態。').waitFor();
        body = submitBodies.at(-1);
        check('營隊送出帶梯次，其餘新欄位為空',
            submitBodies.length === 2 && body.p_course_type === 'camp'
            && body.p_unit_name === '【臺北A】中山 | 7/1~7/3 三日營' && body.p_term_period === null
            && body.p_materials_issued === null && body.p_transport_subsidy_requested === false);

        // 直營到府＋交通補助
        await openReport(page, base);
        await pickCourse(page, 'onsite_1_5hr');
        await fillBasics(page, { name: '王小明', hours: '2', students: '2' });
        await page.getByLabel('申請交通補助').check();
        await page.getByLabel('單趟公里數').fill('12.35');
        await page.getByRole('button', { name: '送出回報' }).click();
        await page.getByText('課程回報已送出，管理員核薪後會更新狀態。').waitFor();
        body = submitBodies.at(-1);
        check('直營送出交通補助＝是、單趟 12.4 km，合作／營隊欄位為空',
            submitBodies.length === 3 && body.p_transport_subsidy_requested === true
            && body.p_transport_distance_km === 12.4 && body.p_unit_name === null && body.p_term_period === null
            && body.p_course_type === 'onsite_2hr' && body.p_course_name === '王小明' && body.p_duration_hours === 2
            && body.p_student_count === 2 && body.p_location === null && body.p_self_review === null);

        // 到府 1.5 小時 → 自動落到 onsite_1_5hr
        await openReport(page, base);
        await pickCourse(page, 'onsite_1_5hr');
        await fillBasics(page, { name: '李小華', hours: '1.5', students: '1' });
        await page.getByRole('button', { name: '送出回報' }).click();
        await page.getByText('課程回報已送出，管理員核薪後會更新狀態。').waitFor();
        body = submitBodies.at(-1);
        check('到府 1.5 小時自動送出 onsite_1_5hr', submitBodies.length === 4 && body.p_course_type === 'onsite_1_5hr' && body.p_duration_hours === 1.5);
        check('四次回報都只走受控 RPC', directSessionWrites === 0);
        await context.close();

        // 選項讀取失敗 → 自由輸入，不擋回報
        optionsFail = true;
        context = await contextFor(browser, { width: 1280, height: 900 });
        page = await context.newPage();
        await openReport(page, base);
        await pickCourse(page, 'collab_lead');
        check('選項讀取失敗時教學期間仍有內建三個選項', (await page.getByLabel('教學課程期間').locator('option').count()) === 4);
        await page.getByLabel('教學課程期間').selectOption('summer_break');
        check('選項讀取失敗時上課單位改為文字輸入', await page.locator('input[aria-label="本次上課單位"]').isVisible());
        await page.locator('input[aria-label="本次上課單位"]').fill('【新竹】愛丁堡');
        await fillBasics(page, { hours: '1.5', students: '12' });
        await page.getByRole('button', { name: '送出回報' }).click();
        await page.getByText('課程回報已送出，管理員核薪後會更新狀態。').waitFor();
        body = submitBodies.at(-1);
        check('自由輸入的單位照樣送出', body.p_unit_name === '【新竹】愛丁堡' && body.p_term_period === 'summer_break');
        optionsFail = false;
        await context.close();

        // ── 390px 手機：三種課型無水平溢出
        context = await contextFor(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await openReport(page, base);
        await page.getByLabel('申請交通補助').check();
        check('390px 直營＋交通補助無水平溢出', (await overflowOf(page)) === 0);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-direct.png'), fullPage: true });
        await pickCourse(page, 'collab_lead');
        await page.getByLabel('教學課程期間').selectOption('semester');
        await page.getByLabel('本次上課單位', { exact: true }).selectOption('【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動');
        check('390px 合作課（選最長單位名）無水平溢出', (await overflowOf(page)) === 0);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-collab.png'), fullPage: true });
        await pickCourse(page, 'camp');
        await page.getByLabel('營隊梯次').selectOption('__other__');
        check('390px 營隊（其它自填）無水平溢出', (await overflowOf(page)) === 0);
        await page.screenshot({ path: path.join(shotDir, 'mobile-390-camp.png'), fullPage: true });
        await context.close();

        // ── 後台明細：桌機表格與手機卡片
        appRole = 'admin';
        context = await contextFor(browser, { width: 1280, height: 900 });
        page = await context.newPage();
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor();
        const table = page.locator('table');
        check('後台表格顯示交通補助「申請 ・ 單趟 12.4 km」', await table.getByText('申請 ・ 單趟 12.4 km').isVisible());
        check('後台表格顯示合作課期間／單位／教材',
            await table.getByText('學期間').isVisible()
            && await table.getByText('【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動').isVisible()
            && await table.getByText('楓葉10').isVisible());
        check('後台表格營隊顯示為「梯次」', await table.getByText('梯次：').isVisible() && await table.getByText('【臺北A】中山 | 7/1~7/3 三日營').isVisible());
        await page.screenshot({ path: path.join(shotDir, 'admin-desktop.png'), fullPage: true });
        await context.close();

        context = await contextFor(browser, { width: 390, height: 844 });
        page = await context.newPage();
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor();
        const cards = page.locator('.md\\:hidden');
        check('後台手機卡片顯示交通補助與合作單位',
            await cards.getByText('申請 ・ 單趟 12.4 km').isVisible()
            && await cards.getByText('【屏東 週日】115上0906永齡希望小學屏東分校講師培訓活動').isVisible());
        check('390px 後台報酬登記無水平溢出', (await overflowOf(page)) === 0);
        await page.screenshot({ path: path.join(shotDir, 'admin-mobile-390.png'), fullPage: true });
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
