#!/usr/bin/env node
// 2026-10-20「我的報酬 → 報酬確認區」：業主要把「回報查詢表」試算表的「登記查詢表」搬進站內。
// 用 mock Supabase 在真瀏覽器（本機 vite dev）驗證：分合作單位／直營課程（＋有紀錄才出現的其他課程）、
// 欄位對照試算表、各區提問窗口、月份篩選、超過 50 筆可展開、手機版卡片、舊試算表連結仍讀後台設定。
// 跑法：npm run verify:compensation-confirm:browser（需本機 Google Chrome；沙盒內起不了 vite 就在沙盒外跑）
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
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-compensation-confirm');

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;

const userId = '00000000-0000-4000-8000-000000000091';
const instructorId = '10000000-0000-4000-8000-000000000091';
const now = new Date().toISOString();
const POINTS_URL = 'https://example.com/points-sheet';

let seq = 0;
const session = (fields) => {
    seq += 1;
    const date = fields.session_date;
    return {
        id: `30000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        instructor_id: instructorId, instructor_name: '確認區測試老師', role_in_session: 'lead',
        month_label: date.slice(0, 7).replace('-', '/'), duration_hours: 2, student_count: null,
        course_name: null, unit_name: null, term_period: null, base_salary: 600, bonus: 0, total_salary: 600,
        paid_amount: 0, status: 'approved', pricing_status: 'quoted', pricing_message: null, source: 'self_report',
        created_at: now, ...fields,
    };
};

// 主情境：合作單位 3 筆（站內回報、總表匯入、被退回）、直營 5 筆、其他 2 筆，跨 2026/09 與 2026/10
const MAIN_SESSIONS = [
    session({ course_type: 'collab_lead', unit_name: '【週四】康軒幼兒園115上空間邏輯魔數班', term_period: 'semester', session_date: '2026-10-15', student_count: 12, base_salary: 700, bonus: 100, total_salary: 800 }),
    session({ course_type: 'collab_assistant', course_name: '【週二】青山康橋115上課間 低 / 中年級', session_date: '2026-09-22', student_count: 28, source: 'historical_import', status: 'paid', total_salary: 450 }),
    session({ course_type: 'collab_lead', unit_name: '【週三】新竹康橋115上課後 基礎班', term_period: 'semester', session_date: '2026-10-08', student_count: 8, status: 'pending', pricing_status: 'rejected', pricing_message: '管理員退回：同一天同單位重複回報', total_salary: 0 }),
    session({ course_type: 'onsite_2hr', course_name: '傅昱翔', session_date: '2026-10-04', student_count: 1, total_salary: 900 }),
    session({ course_type: 'speed_onsite', course_name: '林郡睿', session_date: '2026-10-12', student_count: 1, status: 'pending', pricing_status: 'needs_review', base_salary: null, total_salary: 0 }),
    session({ course_type: 'trial', course_name: '塔尖對決台北場裁判', session_date: '2026-09-05', student_count: 30, total_salary: 1000 }),
    session({ course_type: 'camp', unit_name: '寒假第一梯', session_date: '2026-09-27', duration_hours: 6, student_count: 20, total_salary: 1800 }),
    session({ course_type: 'online', course_name: '線上一對一 陳同學', session_date: '2026-10-02', student_count: 1, total_salary: 700 }),
    session({ course_type: 'regular_basic', course_name: '六晚左營', session_date: '2026-10-10', student_count: 6, total_salary: 500 }),
    session({ course_type: 'event_booth', course_name: '信義區市集擺攤', session_date: '2026-10-11', duration_hours: 4, student_count: null, total_salary: 800 }),
];
// 分頁情境：直營 60 筆，沒有合作單位、沒有其他課程
const MANY_SESSIONS = Array.from({ length: 60 }, (_, index) => session({
    course_type: 'onsite_1_5hr',
    course_name: `到府學生${String(index + 1).padStart(2, '0')}`,
    session_date: `2026-${index < 30 ? '10' : '09'}-${String((index % 28) + 1).padStart(2, '0')}`,
    student_count: 1,
}));

let currentSessions = MAIN_SESSIONS;
let siteLinkReads = 0;

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'compensation-confirm@test.local',
    user_metadata: { full_name: '確認區測試老師' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const authSession = {
    access_token: 'mock.compensation.confirm', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, data, status = 200) => route.fulfill({
    status,
    headers: {
        'content-type': 'application/json', ...CORS,
        ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}),
    },
    body: JSON.stringify(data),
});

const summaryRow = () => {
    const total = currentSessions.reduce((sum, row) => sum + Number(row.total_salary || 0), 0);
    return {
        instructor_id: instructorId, user_id: userId, full_name: '確認區測試老師',
        total_sessions: currentSessions.length, total_hours: currentSessions.length * 2, total_salary: total,
        total_paid: 450, total_unpaid: total - 450, this_month_sessions: 5, this_month_salary: 2200,
        this_year_salary: total, pending_salary: 0, approved_unpaid_salary: total - 450, paid_salary: 450,
    };
};

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, authSession);
        return json(route, {});
    }
    if (url.pathname === '/rest/v1/rpc/link_my_instructor_by_email') return json(route, instructorId);
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);
    if (!url.pathname.startsWith('/rest/v1/')) return json(route, {}, 404);

    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
    const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
    if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
    if (table === 'class_sessions') {
        if (url.searchParams.get('instructor_id') !== `eq.${instructorId}`) return json(route, { message: 'expected own instructor filter' }, 400);
        return json(route, [...currentSessions].sort((a, b) => b.session_date.localeCompare(a.session_date)));
    }
    if (table === 'site_links') {
        siteLinkReads += 1;
        return json(route, [{ key: 'salary_points', label: '報酬 / 點數確認區', description: '查看每月報酬與點數結算結果', url: POINTS_URL }]);
    }
    if (table === 'users') {
        const row = { id: userId, name: '確認區測試老師', email: authUser.email, role: 'teacher', created_at: now };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'instructors') {
        // 講師要通過「個人資料完整度」關卡才進得了 /my/salary（欄位照 verify-salary-fixes-20261020.mjs）
        const own = {
            id: instructorId, user_id: userId, full_name: '確認區測試老師', nickname: '確認區測試老師', gender: '女',
            birth_date: '1990-01-01', id_number: 'A223456789', phone_mobile: '0912345678', line_id: 'confirm-test',
            address: '測試通訊地址', household_address: '測試戶籍地址', email_primary: authUser.email,
            instructor_role: 'A', speed_qualification: null, employment_status: 'active',
            teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 3 次', teaching_regions: ['臺北市'],
            bio_notes: '測試講師', bank_account_name: '確認區測試老師', bank_name: '測試銀行', bank_branch: '測試分行',
            bank_account_number: '0000000000', bank_code: '0000000', photo_path: 'test/photo.png',
            id_front_path: 'test/id-front.png', id_back_path: 'test/id-back.png', bankbook_path: 'test/bankbook.png',
            created_at: now,
        };
        return json(route, acceptsObject ? own : [own]);
    }
    if (table === 'instructor_salary_summary') {
        const row = summaryRow();
        return json(route, acceptsObject ? row : [row]);
    }
    return json(route, acceptsObject ? null : []);
}

const results = [];
const check = (name, condition, detail = '') => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? `  ← ${detail}` : ''}`);
};

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

let base = '';
const pageErrors = [];
const failedRequests = [];

async function openMySalary(browser, { sessions, viewport }) {
    currentSessions = sessions;
    siteLinkReads = 0;
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: authSession });
    await context.route('**/*', handleRoute);
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(error.message));
    // 「Failed to load resource」另由 requestfailed／response 記下網址判斷，console 只收其他錯誤
    page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(message.text()); });
    page.on('requestfailed', request => failedRequests.push(`FAILED ${request.url()}`));
    page.on('response', response => { if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`); });
    await page.goto(`${base}/my/salary`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '報酬確認區' }).waitFor();
    return { context, page };
}

const region = (page, title) => page.getByRole('region', { name: new RegExp(`^${title}`) });
// 桌面表格的資料列（排除空狀態列）
const tableRows = (scope) => scope.locator('table tbody tr').filter({ has: scope.page().locator('td:nth-child(7)') });
const rowTexts = async (scope) => (await tableRows(scope).allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim());
const noHorizontalScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

async function run() {
    mkdirSync(shotDir, { recursive: true });
    const port = await reservePort();
    base = `http://127.0.0.1:${port}`;
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

        // ════════ C1 桌機 1280：主情境 ════════
        let { context, page } = await openMySalary(browser, { sessions: MAIN_SESSIONS, viewport: { width: 1280, height: 900 } });
        const body = await page.locator('body').innerText();
        check('C1 標題「報酬確認區」取代原本的「月份明細」', body.includes('報酬確認區') && !body.includes('月份明細'));
        check('C1 右上角「報酬確認區」是站內按鈕，不再是外連試算表',
            await page.getByRole('button', { name: '報酬確認區' }).count() === 1
            && await page.getByRole('link', { name: /報酬／點數確認區/ }).count() === 0);

        const b2b = region(page, '合作單位課程');
        const b2c = region(page, '直營課程');
        const other = region(page, '其他課程');
        check('C1 三區都在：合作單位 3 筆、直營 5 筆、其他 2 筆',
            await b2b.count() === 1 && await b2c.count() === 1 && await other.count() === 1
            && (await b2b.innerText()).includes('3 筆') && (await b2c.innerText()).includes('5 筆') && (await other.innerText()).includes('2 筆'));
        check('C1 區塊順序：合作單位 → 直營 → 其他（同試算表左右順序）', await page.evaluate(() => {
            const titles = [...document.querySelectorAll('#compensation-confirm h3')].map(node => node.textContent);
            return titles.length === 3 && titles[0].startsWith('合作單位課程') && titles[1].startsWith('直營課程') && titles[2].startsWith('其他課程');
        }));
        check('C1 各區提問窗口：合作單位找 SEP、直營找芳儒、其他洽課程派發窗口',
            (await b2b.innerText()).includes('有問題找 SEP') && (await b2c.innerText()).includes('有問題找 芳儒')
            && (await other.innerText()).includes('有問題請洽課程派發窗口'));

        const b2bHeaders = (await b2b.locator('thead th').allInnerTexts()).map(text => text.trim());
        const b2cHeaders = (await b2c.locator('thead th').allInnerTexts()).map(text => text.trim());
        check('C1 合作單位表頭：上課日期／單位／課程類型／上課人數／時數／報酬／狀態',
            b2bHeaders.join('|') === '上課日期|單位|課程類型|上課人數|時數|報酬|狀態', b2bHeaders.join('|'));
        check('C1 直營表頭第二欄是「課程名稱」', b2cHeaders[1] === '課程名稱', b2cHeaders.join('|'));

        const b2bRows = await rowTexts(b2b);
        check('C1 合作單位依日期新到舊：10/15、10/08、09/22',
            b2bRows.length === 3 && b2bRows[0].startsWith('2026-10-15') && b2bRows[1].startsWith('2026-10-08') && b2bRows[2].startsWith('2026-09-22'), b2bRows.join(' / '));
        check('C1 站內回報的合作課：單位名稱、主講、學期間、12 人、$800 含獎金 $100、已核准',
            ['【週四】康軒幼兒園115上空間邏輯魔數班', '合作課程 主講', '學期間', '12', '$800', '含獎金 $100', '已核准'].every(part => b2bRows[0]?.includes(part)), b2bRows[0]);
        check('C1 總表匯入的合作課（沒有 unit_name）：單位改顯示課程名稱欄、已付款',
            ['【週二】青山康橋115上課間 低 / 中年級', '合作課程 助教', '28', '$450', '已付款'].every(part => b2bRows[2]?.includes(part)), b2bRows[2]);
        check('C1 被退回的回報：報酬與狀態都顯示「已退回」並附退回原因',
            (b2bRows[1]?.match(/已退回/g) || []).length === 2 && b2bRows[1].includes('同一天同單位重複回報'), b2bRows[1]);

        const b2cRows = await rowTexts(b2c);
        const b2cRow = (name) => b2cRows.find(text => text.includes(name)) || '';
        check('C1 到府課：課程類型用表單用語「到府家教課 or 到府揪團課」，副標「到府 2hr/節」',
            b2cRow('傅昱翔').includes('到府家教課 or 到府揪團課') && b2cRow('傅昱翔').includes('到府 2hr/節'), b2cRow('傅昱翔'));
        check('C1 待核准的速解課：報酬欄顯示「待核准」不顯示 $0',
            b2cRow('林郡睿').includes('速解研究所｜實體課程') && (b2cRow('林郡睿').match(/待核准/g) || []).length === 2 && !b2cRow('林郡睿').includes('$0'), b2cRow('林郡睿'));
        check('C1 體驗課只有一個報酬項目：不顯示重複副標', b2cRow('塔尖對決台北場裁判').includes('體驗課') && !b2cRow('塔尖對決台北場裁判').includes('體驗課 體驗課'), b2cRow('塔尖對決台北場裁判'));
        check('C1 營隊沒填課程名稱：名稱改顯示營隊梯次', b2cRow('寒假第一梯').includes('寒暑假營隊') && b2cRow('寒假第一梯').includes('$1,800'), b2cRow('寒假第一梯'));
        check('C1 營隊副標寫「一般講師」，不顯示離開題目就看不懂的「否（一般講師）」',
            b2cRow('寒假第一梯').includes('一般講師') && !b2cRow('寒假第一梯').includes('否（'), b2cRow('寒假第一梯'));
        check('C1 線上課程：副標與主標相同時不重複顯示', b2cRow('線上一對一').includes('線上課程') && (b2cRow('線上一對一').match(/線上課程/g) || []).length === 1, b2cRow('線上一對一'));
        const otherRows = await rowTexts(other);
        const otherRow = (name) => otherRows.find(text => text.includes(name)) || '';
        check('C1 常態課歸到「其他課程」：常態課／實體常態-初階', otherRows.length === 2 && otherRow('六晚左營').includes('常態課') && otherRow('六晚左營').includes('實體常態-初階'), otherRows.join(' / '));
        check('C1 其他課程說明寫出薪資總表登記為「其他」的課歸這區（總表沒有學校社團，不再提）',
            (await other.innerText()).includes('薪資總表裡登記為「其他」的課') && !(await other.innerText()).includes('學校社團'));
        const statusLefts = await page.evaluate(() => [...document.querySelectorAll('#compensation-confirm table')]
            .map(table => Math.round(table.querySelector('thead th:nth-child(7)').getBoundingClientRect().left)));
        check('C1 桌機三張表「狀態」欄上下對齊（左緣差 ≤ 1px）', statusLefts.length === 3 && Math.max(...statusLefts) - Math.min(...statusLefts) <= 1, statusLefts.join(','));

        const pointsLink = page.getByRole('link', { name: /報酬／點數試算表/ });
        check('C1 舊試算表連結仍在（說明用舊表單回報的課與點數去哪查），網址讀後台設定、另開分頁',
            await pointsLink.count() === 1 && await pointsLink.getAttribute('href') === POINTS_URL
            && await pointsLink.getAttribute('target') === '_blank' && siteLinkReads >= 1, `reads=${siteLinkReads}`);
        check('C1 桌機 1280 沒有橫向捲軸', await noHorizontalScroll(page));
        check('C1 桌機：表格顯示、手機卡片隱藏', await b2b.locator('table').isVisible() && !(await b2b.locator('ul').isVisible()));

        await page.screenshot({ path: path.join(shotDir, '01-desktop-1280-full.png'), fullPage: true });

        // 右上角按鈕：捲到確認區
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.getByRole('button', { name: '報酬確認區' }).click();
        await page.waitForTimeout(1200);
        const headingTop = (await page.getByRole('heading', { name: '報酬確認區' }).boundingBox())?.y ?? -1;
        check('C1 點右上角「報酬確認區」會捲到確認區標題（標題在畫面上緣附近）', headingTop >= 0 && headingTop < 260, `top=${headingTop}`);
        await page.screenshot({ path: path.join(shotDir, '02-desktop-1280-after-jump.png') });

        // 月份篩選：2026/09 → 合作 1、直營 2（體驗課＋營隊）、其他 0 → 其他區隱藏
        await page.getByLabel('篩選月份').selectOption('2026/09');
        await page.waitForTimeout(200);
        check('C1 篩 2026/09：合作單位 1 筆、直營 2 筆、其他課程區隱藏',
            (await rowTexts(b2b)).length === 1 && (await rowTexts(b2c)).length === 2 && await other.count() === 0
            && (await b2b.innerText()).includes('1 筆') && (await b2c.innerText()).includes('2 筆'));
        await page.getByLabel('篩選月份').selectOption('');
        await page.waitForTimeout(200);
        check('C1 切回全部月份：其他課程區回來、合作單位回到 3 筆', await other.count() === 1 && (await rowTexts(b2b)).length === 3);
        await context.close();

        // ════════ C2 手機 375：主情境 ════════
        ({ context, page } = await openMySalary(browser, { sessions: MAIN_SESSIONS, viewport: { width: 375, height: 812 } }));
        const mB2b = region(page, '合作單位課程');
        const mB2c = region(page, '直營課程');
        check('C2 手機 375：卡片顯示、表格隱藏', await mB2b.locator('ul').isVisible() && !(await mB2b.locator('table').isVisible()));
        const cardTexts = (await mB2b.locator('ul > li').allInnerTexts()).map(text => text.replace(/\s+/g, ' '));
        check('C2 手機卡片：合作單位 3 張，第一張含日期、單位、主講・學期間、12 人、$800、已核准',
            cardTexts.length === 3 && ['2026-10-15', '康軒幼兒園', '合作課程 主講・學期間', '12 人', '$800', '已核准'].every(part => cardTexts[0].includes(part)), cardTexts[0]);
        const speedCard = (await mB2c.locator('ul > li').allInnerTexts()).map(text => text.replace(/\s+/g, ' ')).find(text => text.includes('林郡睿')) || '';
        check('C2 手機卡片：待核准的課金額顯示「待核准」', speedCard.includes('待核准') && !speedCard.includes('$0'), speedCard);
        const boothCard = (await region(page, '其他課程').locator('ul > li').allInnerTexts()).map(text => text.replace(/\s+/g, ' ')).find(text => text.includes('信義區市集擺攤')) || '';
        check('C2 手機卡片：沒填人數的擺攤只顯示「4 小時」，不寫「人數未填」', boothCard.includes('4 小時') && !boothCard.includes('人數未填') && !boothCard.includes('null'), boothCard);
        check('C2 手機 375 沒有橫向捲軸', await noHorizontalScroll(page));
        const chipOverflow = await page.evaluate(() => [...document.querySelectorAll('#compensation-confirm .bh-chip')]
            .filter(chip => chip.getBoundingClientRect().right > window.innerWidth + 0.5).length);
        check('C2 手機：狀態與窗口標籤都沒有超出畫面', chipOverflow === 0, `overflow=${chipOverflow}`);
        await page.screenshot({ path: path.join(shotDir, '03-mobile-375-full.png'), fullPage: true });
        await context.close();

        // ════════ C5 小筆電 1024／平板 820：表格不撐破頁面，名稱欄留得住字 ════════
        for (const width of [1024, 820]) {
            ({ context, page } = await openMySalary(browser, { sessions: MAIN_SESSIONS, viewport: { width, height: 900 } }));
            const nameWidths = await page.evaluate(() => [...document.querySelectorAll('#compensation-confirm table')]
                .map(table => Math.round(table.querySelector('thead th:nth-child(2)').getBoundingClientRect().width)));
            const cardsContainTables = await page.evaluate(() => [...document.querySelectorAll('#compensation-confirm table')]
                .every(table => table.closest('.overflow-x-auto').getBoundingClientRect().right <= window.innerWidth + 0.5));
            check(`C5 ${width}px：整頁沒有橫向捲軸、表格外框在畫面內、名稱欄寬 ≥ 140px`,
                await noHorizontalScroll(page) && cardsContainTables && nameWidths.length === 3 && Math.min(...nameWidths) >= 140, `name=${nameWidths.join(',')}`);
            await page.locator('#compensation-confirm').screenshot({ path: path.join(shotDir, `04-confirm-${width}.png`) });
            await context.close();
        }

        // ════════ C3 60 筆直營：每區先顯示 50 筆，可展開／收合；沒有合作課時顯示空狀態 ════════
        ({ context, page } = await openMySalary(browser, { sessions: MANY_SESSIONS, viewport: { width: 1280, height: 900 } }));
        const manyB2c = region(page, '直營課程');
        const manyB2b = region(page, '合作單位課程');
        check('C3 沒有合作課：合作單位區仍在並顯示空狀態、其他課程區隱藏',
            (await manyB2b.innerText()).includes('這段期間沒有合作單位課程紀錄') && (await manyB2b.innerText()).includes('0 筆') && await region(page, '其他課程').count() === 0);
        check('C3 直營 60 筆：先顯示 50 列', (await rowTexts(manyB2c)).length === 50, String((await rowTexts(manyB2c)).length));
        await manyB2c.getByRole('button', { name: '顯示全部 60 筆' }).click();
        check('C3 按「顯示全部 60 筆」後顯示 60 列，按鈕改成收合', (await rowTexts(manyB2c)).length === 60
            && await manyB2c.getByRole('button', { name: /收合/ }).count() === 1);
        await page.getByLabel('篩選月份').selectOption('2026/10');
        await page.waitForTimeout(200);
        check('C3 篩 2026/10：30 筆全部顯示、沒有展開按鈕',
            (await rowTexts(manyB2c)).length === 30 && await manyB2c.getByRole('button', { name: /顯示全部|收合/ }).count() === 0);
        await page.getByLabel('篩選月份').selectOption('');
        await page.waitForTimeout(200);
        check('C3 換過月份再切回全部：展開狀態已重置，回到 50 列並重新出現「顯示全部 60 筆」',
            (await rowTexts(manyB2c)).length === 50 && await manyB2c.getByRole('button', { name: '顯示全部 60 筆' }).count() === 1);
        await context.close();

        const relevantErrors = pageErrors.filter(text => !/Download the React DevTools/i.test(text));
        check('C4 全程沒有頁面錯誤或 console error', relevantErrors.length === 0, relevantErrors.slice(0, 3).join(' | '));
        // mock 會擋掉所有非 Supabase 的外部網址（字型等），頭像的 Storage 簽名網址也沒 mock（假主檔的 test/photo.png），
        // 那些失敗是測試環境造成的；本機頁面與 Supabase 資料請求（REST／RPC／Auth）不可失敗
        const appFailures = [...new Set(failedRequests)]
            .filter(line => /127\.0\.0\.1|supabase\.co/.test(line) && !line.includes('/storage/v1/'));
        console.log(`(外部資源被 mock 擋下 ${failedRequests.length - appFailures.length} 次，例：${[...new Set(failedRequests)].filter(line => !appFailures.includes(line)).slice(0, 2).join(' , ')})`);
        check('C4 本機頁面與 Supabase 請求沒有任何失敗', appFailures.length === 0, appFailures.slice(0, 3).join(' | '));
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }

    const passed = results.filter(Boolean).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    console.log(`截圖：${shotDir}`);
    process.exitCode = passed === results.length ? 0 : 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
