#!/usr/bin/env node
// 「關於我」總覽＋選單順序＋新手導覽（業主 2026-10-21 三項需求）：以 mock Supabase＋真 Chrome＋固定時鐘實際開頁驗證。
// 1) 選單順序：關於我、我的課程、我的報酬優先，方塊競速往後，排行榜不在選單（在排行榜頁時「關於我」維持選中）
// 2) /me 三塊摘要的數字與「我的報酬」頁黃卡一致；各塊讀不到資料時只有該塊顯示錯誤
// 3) 導覽只在 /me 第一次進來時自動跳出，看完／跳過後這台裝置不再跳，「重看導覽」可再打開
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { getInstructorProfileCompletion, REQUIRED_PROFILE_FIELDS, REQUIRED_PROFILE_PATHS } from '../src/lib/profileCompletion.js';
import { tourStorageKey } from '../src/lib/onboarding.js';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-22-about-me-dashboard');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000091';
const instructorId = '20000000-0000-4000-8000-000000000091';
// 台北 2026-10-22 中午：下次匯款日 11/10 匯「10月」＝9/26～10/25
const fixedNow = '2026-10-22T04:00:00.000Z';
const now = fixedNow;

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'about-me@test.local',
    user_metadata: { full_name: '總覽測試講師' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.about.me', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};

// 講師主檔填齊（不然 /me 會被導去個人資料頁）
const completeInstructor = {
    id: instructorId, user_id: userId, employment_status: 'active', instructor_role: 'B',
    teaching_regions: ['台北市'], created_at: now, updated_at: now,
    ...Object.fromEntries(REQUIRED_PROFILE_FIELDS.map(({ key }) => [key, key === 'email_primary' ? authUser.email : '測試'])),
    ...Object.fromEntries(REQUIRED_PROFILE_PATHS.map(key => [key, `${userId}/${key}.jpg`])),
    full_name: '總覽測試講師', nickname: '小明老師',
};
if (!getInstructorProfileCompletion(completeInstructor).complete) throw new Error('mock 講師主檔不完整，測試前提錯誤');

// 本期（9/26～10/25）：核准 1500＋待核准 1200＋待定價 1 筆＝$2,700、3 場、含待核准 $1,200、1 筆待確認金額；
// 退回的與上一期的不算
const sessions = [
    { id: 's1', instructor_id: instructorId, course_type: 'onsite_2hr', course_name: '到府課', session_date: '2026-10-20', status: 'pending', pricing_status: 'needs_review', total_salary: 0, month_label: '2026/10' },
    { id: 's2', instructor_id: instructorId, course_type: 'onsite_2hr', course_name: '到府課', session_date: '2026-10-10', status: 'pending', pricing_status: 'priced', total_salary: 1200, month_label: '2026/10' },
    { id: 's3', instructor_id: instructorId, course_type: 'onsite_2hr', course_name: '到府課', session_date: '2026-10-05', status: 'pending', pricing_status: 'rejected', total_salary: 999, month_label: '2026/10' },
    { id: 's4', instructor_id: instructorId, course_type: 'onsite_2hr', course_name: '到府課', session_date: '2026-10-01', status: 'approved', pricing_status: 'priced', total_salary: 1500, month_label: '2026/10' },
    { id: 's5', instructor_id: instructorId, course_type: 'onsite_2hr', course_name: '到府課', session_date: '2026-09-20', status: 'paid', pricing_status: 'priced', total_salary: 3000, month_label: '2026/09' },
];
const salarySummary = {
    user_id: userId, instructor_id: instructorId, full_name: '總覽測試講師',
    this_month_salary: 2700, this_month_sessions: 4, this_year_salary: 54321, total_salary: 60000,
    total_sessions: 37, total_hours: 80, pending_salary: 1200, paid_salary: 3000,
};
const categories = ['魔方入門', '教你怎麼教', '速解培訓', '營隊帶法', '幼兒啟蒙'].map((title, i) => ({
    id: `c${i + 1}`, title, description: '', visibility: 'all', is_published: true, order: i,
}));
const courses = [['k1', 'c1'], ['k2', 'c1'], ['k3', 'c2'], ['k4', 'c3'], ['k5', 'c5'], ['k6', 'c5'], ['k7', 'c5']]
    .map(([id, category_id], i) => ({ id, category_id, title: `課程${id}`, is_published: true, order: i }));
const leaderboardRows = [
    { user_id: 'other-1', display_name: '甲講師', total_hours: 50, session_count: 20, student_reach: 300 },
    { user_id: userId, display_name: '小明老師', total_hours: 32.5, session_count: 15, student_reach: 200 },
    { user_id: 'other-2', display_name: '乙講師', total_hours: 40, session_count: 18, student_reach: 250 },
    { user_id: 'other-3', display_name: '丙講師', total_hours: 10, session_count: 5, student_reach: 60 },
];
const badgeDefinitions = ['first_class', 'hundred_hours', 'wca_fan'].map((key, i) => ({
    key, name: `徽章${i + 1}`, description: '', category: 'teaching', rule_type: 'manual', active: true, sort_order: i,
}));
const badgeOverrides = [{ badge_key: 'first_class', state: 'granted' }, { badge_key: 'wca_fan', state: 'granted' }];

const json = (route, data, status = 200, extraHeaders = {}) => route.fulfill({
    status,
    headers: {
        'content-type': 'application/json',
        ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}),
        ...extraHeaders,
    },
    body: JSON.stringify(data),
});

// options：role、instructor（null＝沒有講師主檔）、failSalary（報酬 view 回 500）
const routeFor = ({ role, instructor = completeInstructor, failSalary = false }, calls) => async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, session);
        return json(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = url.pathname.replace('/rest/v1/rpc/', '');
        calls.push({ fn, body: request.postDataJSON?.() ?? null });
        if (fn === 'get_teaching_leaderboard_v2') return json(route, leaderboardRows);
        if (fn === 'get_teaching_years') return json(route, [{ yr: 2026 }]);
        return json(route, null);
    }
    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        const one = (row) => json(route, acceptsObject ? row : (row ? [row] : []));
        calls.push({ table, method: request.method(), search: url.search });
        if (request.method() === 'HEAD') {
            const count = table === 'course_training_status' ? 2 : 0;
            return route.fulfill({ status: 200, headers: { 'content-range': `*/${count}`, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-range' }, body: '' });
        }
        if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
        if (table === 'users') return one({ id: userId, name: '總覽測試講師', email: authUser.email, role, created_at: now });
        if (table === 'instructors') return one(instructor);
        if (table === 'instructor_salary_summary') {
            if (failSalary) return json(route, { message: 'boom', code: 'XX000' }, 500);
            return one(instructor ? salarySummary : null);
        }
        if (table === 'salary_payout_schedule') return one({ next_payday: '2026-11-10', regular_day: 10 });
        if (table === 'class_sessions') return json(route, url.searchParams.get('instructor_id') === `eq.${instructorId}` ? sessions : []);
        if (table === 'course_categories') return json(route, categories);
        if (table === 'courses') return json(route, courses);
        if (table === 'badge_definitions') return json(route, badgeDefinitions);
        if (table === 'badge_overrides') return json(route, url.searchParams.get('instructor_id') === `eq.${instructorId}` ? badgeOverrides : []);
        return json(route, acceptsObject ? null : []);
    }
    if (url.pathname.startsWith('/storage/v1/')) return json(route, []);
    return json(route, {}, 404);
};

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
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

let browser;
let base;
const openContext = async (options, { width = 1440, height = 900 } = {}) => {
    const calls = [];
    const context = await browser.newContext({ viewport: { width, height } });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
    await context.clock.setFixedTime(new Date(fixedNow));
    await context.route('**/*', routeFor(options, calls));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error' && process.env.DEBUG_CONSOLE) console.log('console.error:', message.text().slice(0, 300)); });
    return { context, page, calls, errors };
};
const tour = (page) => page.getByRole('dialog', { name: /歡迎|關於我|我的報酬|我的課程|教材/ });
const desktopNavItems = (page) => page.locator('header nav').evaluate(nav => [...nav.querySelectorAll(':scope > a, :scope > button')]
    .map(el => ({ text: el.innerText.trim(), active: el.className.includes('bg-bauhaus-black') })));
const waitForDashboard = async (page) => {
    await page.getByRole('heading', { name: '關於我', level: 1 }).waitFor();
    await page.getByTestId('about-salary-total').waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-testid^="about-"] .animate-pulse'));
};
const storedTourFlag = (page) => page.evaluate(key => localStorage.getItem(key), tourStorageKey(userId));
// 每一行的字數（逐字量座標分行），用來檢查手機上最後一行不是孤零零一個字（標點不算字）
const lineLengths = (locator) => locator.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const lines = [];
    let lastTop = null;
    while (walker.nextNode()) {
        const node = walker.currentNode;
        for (let i = 0; i < node.length; i += 1) {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            const rect = range.getClientRects()[0];
            if (!rect || !node.data[i].trim()) continue;
            if (lastTop === null || Math.abs(rect.top - lastTop) > 4) { lines.push(''); lastTop = rect.top; }
            lines[lines.length - 1] += node.data[i];
        }
    }
    return lines.map(line => line.replace(/[，。、！？：；（）「」・]/g, '').length);
});

async function teacherDesktop() {
    const { context, page, calls, errors } = await openContext({ role: 'teacher' });
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await waitForDashboard(page);

    // ── 導覽：第一次進 /me 自動跳出 ──
    const dialog = tour(page);
    await dialog.waitFor({ timeout: 5000 }).catch(() => {});
    check('講師第一次進「關於我」自動跳出新手導覽', await dialog.isVisible());
    check('導覽第 1 格：標題「歡迎來到講師資源站」、顯示 1 / 5', (await dialog.innerText()).includes('歡迎來到講師資源站') && (await dialog.innerText()).includes('1 / 5'));
    check('導覽開著時焦點在「下一步」', await page.evaluate(() => document.activeElement?.textContent?.includes('下一步')));
    check('導覽開著時背景鎖住捲動', await page.evaluate(() => document.body.style.overflow === 'hidden'));
    await page.screenshot({ path: path.join(shotDir, 'teacher-1440-tour-step1.png') });
    const titles = [];
    for (let i = 0; i < 5; i += 1) {
        titles.push(await dialog.getByRole('heading', { level: 2 }).innerText());
        if (i < 4) await dialog.getByRole('button', { name: '下一步' }).click();
    }
    check('導覽共 5 格、依序為 歡迎／關於我／我的報酬／我的課程／教材與個人資料',
        titles.length === 5 && ['歡迎', '關於我', '我的報酬', '我的課程', '教材'].every((w, i) => titles[i].includes(w)), titles.join('｜'));
    check('最後一格主按鈕是「開始使用」、顯示 5 / 5', await dialog.getByRole('button', { name: '開始使用' }).isVisible() && (await dialog.innerText()).includes('5 / 5'));
    await dialog.getByRole('button', { name: '上一步' }).click();
    check('「上一步」回到第 4 格', (await dialog.innerText()).includes('4 / 5'));
    await dialog.getByRole('button', { name: '下一步' }).click();
    await dialog.getByRole('button', { name: '開始使用' }).click();
    check('按「開始使用」後導覽關閉、背景恢復捲動', !(await dialog.isVisible()) && await page.evaluate(() => document.body.style.overflow === ''));
    check('看完後這台裝置記下「看過了」', Boolean(await storedTourFlag(page)));
    await page.reload({ waitUntil: 'networkidle' });
    await waitForDashboard(page);
    await page.waitForTimeout(600);
    check('重新整理後不再自動跳出', !(await dialog.isVisible()));
    await page.getByRole('button', { name: '重看導覽' }).click();
    check('按「重看導覽」再打開、從第 1 格開始', await dialog.isVisible() && (await dialog.innerText()).includes('1 / 5'));
    await page.mouse.click(10, 450); // 點遮罩（不會關），焦點掉到頁面上
    await page.keyboard.press('Tab');
    check('點遮罩後按 Tab，焦點仍在導覽彈窗內', await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))));
    check('換格時標題與說明在 aria-live 區塊內（讀螢幕軟體會念）', await dialog.locator('[aria-live="polite"] h2').count() === 1);
    await page.keyboard.press('Escape');
    check('按 Esc 關閉導覽', !(await dialog.isVisible()));

    // ── 選單順序 ──
    const items = await desktopNavItems(page);
    const texts = items.map(i => i.text);
    check('講師選單順序：關於我／我的課程／我的報酬／教材資源／方塊競速／個人資料',
        JSON.stringify(texts) === JSON.stringify(['關於我', '我的課程', '我的報酬', '教材資源', '方塊競速', '個人資料']), texts.join('／'));
    check('選單不再有「排行榜」', !texts.includes('排行榜'));
    check('在 /me 時「關於我」為選中狀態', items.find(i => i.text === '關於我')?.active === true);

    // ── 報酬塊 ──
    const salary = page.getByTestId('about-salary');
    const salaryText = await salary.innerText();
    check('報酬塊標題「10月累計報酬」＋「11/10 匯款」', salaryText.includes('10月累計報酬') && salaryText.includes('11/10 匯款'), salaryText.split('\n').slice(0, 3).join('｜'));
    check('本期金額 $2,700（核准＋待核准，退回與上一期不算）', (await page.getByTestId('about-salary-total').innerText()).trim() === '$2,700');
    check('副標：9/26～10/25・3 場・含待核准 $1,200・1 筆待確認金額', salaryText.includes('9/26～10/25・3 場・含待核准 $1,200・1 筆待確認金額'));
    check('今年累計 $54,321・總場次 37', salaryText.includes('今年累計 $54,321・總場次 37'));
    check('提醒：1 筆等待核准、1 筆被退回', salaryText.includes('1 筆回報等待管理員核准') && salaryText.includes('1 筆回報被退回'));
    check('「登記課程回報」連到 /my/salary/new、「查看報酬明細」連到 /my/salary',
        await salary.getByRole('link', { name: '登記課程回報' }).getAttribute('href') === '/my/salary/new'
        && await salary.getByRole('link', { name: '查看報酬明細' }).getAttribute('href') === '/my/salary');
    const sessionQuery = calls.find(c => c.table === 'class_sessions');
    check('報酬清單只查本人（帶 instructor_id 條件）', sessionQuery?.search.includes(`instructor_id=eq.${instructorId}`), sessionQuery?.search);

    // ── 課程塊 ──
    const coursesText = await page.getByTestId('about-courses').innerText();
    check('課程塊：培訓分類 5、課程 7、已完訓 2', /培訓分類\s*5/.test(coursesText) && /課程\s*7/.test(coursesText) && /已完訓\s*2/.test(coursesText), coursesText.replace(/\n/g, '｜').slice(0, 80));
    const categoryLinks = await page.getByTestId('about-courses').locator('ul a').evaluateAll(as => as.map(a => [a.innerText.replace(/\s+/g, ''), a.getAttribute('href')]));
    check('列出前 4 個分類，各自連到該分類', categoryLinks.length === 4 && categoryLinks[0][1] === '/courses?category=c1' && categoryLinks[0][0].includes('2門'), JSON.stringify(categoryLinks));
    check('超過 4 個時提示「還有 1 個分類」', coursesText.includes('還有 1 個分類'));

    // ── 排名塊 ──
    const rankText = await page.getByTestId('about-rank').innerText();
    check('今年教學時數排名 #3、32.5 小時、共 4 位講師上榜', rankText.includes('#3') && rankText.includes('32.5 小時') && rankText.includes('共 4 位講師上榜'), rankText.replace(/\n/g, '｜'));
    const rankCall = calls.find(c => c.fn === 'get_teaching_leaderboard_v2');
    check('排名查今年＋全部範圍（p_year 2026、p_category all）', rankCall?.body?.p_year === 2026 && rankCall?.body?.p_category === 'all', JSON.stringify(rankCall?.body));
    const badgeText = await page.getByTestId('about-badges').innerText();
    check('排名塊同時列出今年 15 場、200 人次', rankText.includes('15 場') && rankText.includes('200 人次'));
    check('徽章 2 / 3，有「看全部徽章」連到個人資料', badgeText.includes('2 / 3') && await page.getByTestId('about-badges').getByRole('link', { name: '看全部徽章' }).getAttribute('href') === '/profile');
    check('已解鎖的徽章顯示名稱（徽章1、徽章3），未解鎖的不顯示', badgeText.includes('徽章1') && badgeText.includes('徽章3') && !badgeText.includes('徽章2'));
    const ranking = page.getByTestId('about-ranking');
    check('「完整排行榜」連到 /leaderboard?year=2026（和這裡的今年排名同一年）、「方塊競速」連到 /cube',
        await ranking.getByRole('link', { name: '完整排行榜' }).getAttribute('href') === '/leaderboard?year=2026'
        && await ranking.getByRole('link', { name: '方塊競速' }).getAttribute('href') === '/cube');
    await page.screenshot({ path: path.join(shotDir, 'teacher-1440-dashboard.png'), fullPage: true });

    // ── 和「我的報酬」黃卡一致、排行榜頁時「關於我」選中 ──
    await page.getByRole('link', { name: '查看報酬明細' }).click();
    await page.getByRole('heading', { name: '我的報酬', level: 1 }).waitFor({ timeout: 10000 }).catch(async () => {
        console.log('DEBUG url', page.url(), '\n', (await page.locator('main').innerText()).slice(0, 400), '\nerrors', errors.join(' / '));
    });
    const salaryPage = await page.locator('main').innerText();
    check('「我的報酬」頁黃卡同為 10月累計報酬 $2,700', salaryPage.includes('10月累計報酬') && salaryPage.includes('$2,700'));
    const before = calls.length;
    await page.goto(`${base}/leaderboard?year=2026`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const lbCall = calls.slice(before).find(c => c.fn === 'get_teaching_leaderboard_v2');
    check('從「關於我」點進排行榜（?year=2026）直接查 2026 年', lbCall?.body?.p_year === 2026, JSON.stringify(lbCall?.body));
    await page.goto(`${base}/leaderboard`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const lbDefault = calls.filter(c => c.fn === 'get_teaching_leaderboard_v2').pop();
    check('直接開排行榜仍預設歷屆總榜（p_year null）', lbDefault?.body?.p_year === null, JSON.stringify(lbDefault?.body));
    const lbItems = await desktopNavItems(page);
    check('在排行榜頁時「關於我」維持選中', lbItems.find(i => i.text === '關於我')?.active === true);
    check('排行榜頁不會自動跳導覽', !(await tour(page).isVisible()));
    check('整段流程沒有前端錯誤', errors.length === 0, errors.join(' / '));
    await context.close();
}

async function otherPagesNoTour() {
    const { context, page } = await openContext({ role: 'teacher' });
    for (const target of ['/', '/courses', '/profile', '/my/salary']) {
        await page.goto(`${base}${target}`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(700);
        check(`講師沒看過導覽時開 ${target} 不會跳導覽`, !(await tour(page).isVisible()));
    }
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await tour(page).waitFor({ timeout: 5000 }).catch(() => {});
    const opened = await tour(page).isVisible();
    await page.goBack({ waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    check('導覽沒看完就按「上一頁」：導覽跟著關掉、不蓋在別頁上', opened && !(await tour(page).isVisible()) && new URL(page.url()).pathname !== '/me', page.url());
    check('沒看完就離開不記「看過了」（下次進來會再跳）', !(await storedTourFlag(page)));
    const homeAboutLink = page.locator('main a[href="/me"]');
    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    check('首頁（已核准講師）有「關於我」按鈕連到 /me', await homeAboutLink.count() === 1 && await homeAboutLink.isVisible());
    check('沒自動跳過，所以裝置上還沒有「看過了」紀錄', !(await storedTourFlag(page)));
    await context.close();
}

async function adminDesktop() {
    const { context, page } = await openContext({ role: 'admin' }, { width: 1280, height: 860 });
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await waitForDashboard(page);
    await tour(page).waitFor({ timeout: 5000 }).catch(() => {});
    check('管理員第一次進「關於我」也會跳導覽', await tour(page).isVisible());
    await tour(page).getByRole('button', { name: '跳過導覽' }).click();
    check('按右上角「跳過導覽」關閉並記下', !(await tour(page).isVisible()) && Boolean(await storedTourFlag(page)));
    const texts = (await desktopNavItems(page)).map(i => i.text);
    check('管理員選單順序：關於我／我的課程／我的報酬／教材資源／方塊競速／個人資料／後台管理',
        JSON.stringify(texts) === JSON.stringify(['關於我', '我的課程', '我的報酬', '教材資源', '方塊競速', '個人資料', '後台管理']), texts.join('／'));
    await page.screenshot({ path: path.join(shotDir, 'admin-1280-dashboard.png') });
    await context.close();
}

async function teacherMobile() {
    const { context, page } = await openContext({ role: 'teacher' }, { width: 375, height: 812 });
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await waitForDashboard(page);
    const dialog = tour(page);
    await dialog.waitFor({ timeout: 5000 }).catch(() => {});
    const box = await dialog.boundingBox();
    check('手機 375px：導覽彈窗在畫面內（左右各留 ≥16px、不超出底部）',
        box && box.x >= 15 && box.x + box.width <= 360 && box.y >= 0 && box.y + box.height <= 812, box ? `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}` : '找不到');
    const buttonHeights = await dialog.locator('button').evaluateAll(bs => bs.map(b => Math.round(b.getBoundingClientRect().height)));
    check('手機導覽按鈕高度都 ≥44px', buttonHeights.length >= 2 && buttonHeights.every(h => h >= 44), buttonHeights.join(','));
    const tourLines = await lineLengths(dialog.locator('#onboarding-tour-body'));
    check('手機導覽第 1 格說明：最後一行至少 2 個字（不留孤字）', tourLines.length > 1 && tourLines[tourLines.length - 1] >= 2, tourLines.join('/'));
    await page.screenshot({ path: path.join(shotDir, 'teacher-375-tour.png') });
    await dialog.getByRole('button', { name: '先跳過' }).click();
    check('第 1 格「先跳過」關閉並記下', !(await dialog.isVisible()) && Boolean(await storedTourFlag(page)));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('手機 375px：總覽頁沒有橫向捲軸', overflow <= 0, `超出 ${overflow}px`);
    const alertLines = await lineLengths(page.getByTestId('about-salary').getByText('被退回'));
    check('手機「被退回」提醒：最後一行至少 2 個字', alertLines[alertLines.length - 1] >= 2, alertLines.join('/'));
    const order = await page.evaluate(() => ['about-salary', 'about-courses', 'about-ranking']
        .map(id => Math.round(document.querySelector(`[data-testid="${id}"]`).getBoundingClientRect().top)));
    check('手機上三塊由上到下：報酬、課程、排名', order[0] < order[1] && order[1] < order[2], order.join(' < '));
    await page.screenshot({ path: path.join(shotDir, 'teacher-375-dashboard.png'), fullPage: true });
    await page.getByRole('button', { name: '開啟選單' }).click();
    const menuLinks = await page.locator('header > div.xl\\:hidden a, header > div.xl\\:hidden button').evaluateAll(els => els.map(el => el.innerText.trim()).filter(Boolean));
    const navOnly = menuLinks.filter(t => ['關於我', '我的課程', '我的報酬', '教材資源', '方塊競速', '個人資料', '排行榜'].includes(t));
    check('手機選單順序同桌機、沒有排行榜', JSON.stringify(navOnly) === JSON.stringify(['關於我', '我的課程', '我的報酬', '教材資源', '方塊競速', '個人資料']), navOnly.join('／'));
    await page.screenshot({ path: path.join(shotDir, 'teacher-375-menu.png') });
    await context.close();
}

async function incompleteProfile() {
    const incomplete = { ...completeInstructor, bank_account_number: null };
    const { context, page } = await openContext({ role: 'teacher', instructor: incomplete });
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await page.waitForURL(/\/profile$/, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600);
    check('個人資料沒填齊：進 /me 被導去 /profile', new URL(page.url()).pathname === '/profile', page.url());
    check('個人資料沒填齊：不跳導覽、也不記「看過了」', !(await tour(page).isVisible()) && !(await storedTourFlag(page)));
    await context.close();
}

async function pendingUser() {
    const { context, page } = await openContext({ role: 'pending', instructor: null });
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await page.waitForURL(/\/pending$/, { timeout: 8000 }).catch(() => {});
    check('待審核帳號：進 /me 被導去 /pending', new URL(page.url()).pathname === '/pending', page.url());
    const texts = (await desktopNavItems(page)).map(i => i.text);
    check('待審核帳號：選單沒有「關於我」、不跳導覽', !texts.includes('關於我') && !(await tour(page).isVisible()), texts.join('／'));
    await context.close();
}

async function salaryFailure() {
    const { context, page, errors } = await openContext({ role: 'teacher', failSalary: true });
    await context.addInitScript(key => localStorage.setItem(key, 'seen'), tourStorageKey(userId));
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await waitForDashboard(page);
    const salaryText = await page.getByTestId('about-salary').innerText();
    check('報酬讀取失敗：報酬塊顯示錯誤與「到我的報酬查看」', salaryText.includes('報酬資料暫時無法載入') && salaryText.includes('到「我的報酬」查看'));
    check('報酬讀取失敗：金額顯示「—」不是 $0', (await page.getByTestId('about-salary-total').innerText()).trim() === '—');
    check('報酬讀取失敗：課程與排名照常顯示', (await page.getByTestId('about-rank').innerText()).includes('#3') && /培訓分類\s*5/.test(await page.getByTestId('about-courses').innerText()));
    check('已看過導覽（裝置有紀錄）時不跳', !(await tour(page).isVisible()));
    check('報酬讀取失敗時沒有前端錯誤', errors.length === 0, errors.join(' / '));
    await context.close();
}

async function noInstructorAdmin() {
    const { context, page } = await openContext({ role: 'admin', instructor: null });
    await context.addInitScript(key => localStorage.setItem(key, 'seen'), tourStorageKey(userId));
    await page.goto(`${base}/me`, { waitUntil: 'networkidle' });
    await waitForDashboard(page);
    const salaryText = await page.getByTestId('about-salary').innerText();
    check('沒有講師主檔的管理員：報酬塊顯示「還沒有報酬紀錄」、金額 $0', salaryText.includes('還沒有報酬紀錄') && (await page.getByTestId('about-salary-total').innerText()).trim() === '$0');
    check('沒有講師主檔：徽章提示「綁定講師資料後就會開始累積徽章」', (await page.getByTestId('about-badges').innerText()).includes('綁定講師資料後'));
    await context.close();
}

async function run() {
    const port = await reservePort();
    base = `http://127.0.0.1:${port}`;
    const viteBin = path.join(appDir, 'node_modules', '.bin', 'vite');
    const vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite dev pid=${vite.pid} port=${port}`);
    let viteLog = '';
    vite.stdout.on('data', chunk => { viteLog += chunk; });
    vite.stderr.on('data', chunk => { viteLog += chunk; });
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* dev server starting */ }
            if (Date.now() > deadline) throw new Error(`vite dev did not start\n${viteLog}`);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});
        await teacherDesktop();
        await otherPagesNoTour();
        await adminDesktop();
        await teacherMobile();
        await incompleteProfile();
        await pendingUser();
        await salaryFailure();
        await noInstructorAdmin();
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} ${passed === results.length ? 'PASS' : 'FAIL'}  screenshots: docs/verification/2026-10-22-about-me-dashboard`);
    process.exit(passed === results.length ? 0 : 1);
}

run().catch(error => { console.error(error); process.exit(1); });
