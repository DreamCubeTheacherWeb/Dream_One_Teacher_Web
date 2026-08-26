#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 4237;
const base = `http://localhost:${port}`;
const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000041';
const instructorId = '10000000-0000-4000-8000-000000000041';
const now = new Date().toISOString();
const salarySession = {
    id: '30000000-0000-4000-8000-000000000099',
    instructor_id: instructorId,
    instructor_name: '速解測試老師',
    instructor_role_at_time: 'A',
    speed_qualification_at_time: null,
    course_type: 'speed_onsite',
    course_name: '校園速解課',
    session_date: '2026-08-14',
    month_label: '2026-08',
    role_in_session: 'lead',
    duration_hours: 1.5,
    student_count: 2,
    base_salary: null,
    bonus: 0,
    paid_amount: 0,
    total_salary: null,
    status: 'pending',
    pricing_status: 'needs_review',
    pricing_message: '尚未設定速解資格',
    source: 'self_report',
    registered_by_name: '速解測試老師',
    created_at: now,
};

const authUser = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'speed-teacher@test.local',
    user_metadata: { full_name: '速解測試老師' },
    app_metadata: { provider: 'google', providers: ['google'] },
    identities: [],
    created_at: now,
    updated_at: now,
};
const session = {
    access_token: 'mock.speed.salary',
    refresh_token: 'mock.refresh',
    token_type: 'bearer',
    expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    user: authUser,
};

let appRole = 'teacher';
let speedQualification = 'speed_master';
let submitCalls = 0;
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
        const body = request.postDataJSON();
        const isSpeed = body.p_course_type?.startsWith('speed_');
        const appliedRate = isSpeed ? 900 : 300;
        const missingQualification = isSpeed && !speedQualification;
        const missingDuration = body.p_duration_hours === null;
        const needsReview = missingQualification || missingDuration;
        return json(route, [{
            matched: !needsReview,
            needs_review: needsReview,
            is_speed_course: isSpeed,
            message: missingQualification
                ? '尚未設定速解資格，已保留回報並交由管理員核薪'
                : missingDuration
                    ? '此報酬規則需要填寫時數，已交由管理員核薪'
                    : '已依現行報酬表完成試算',
            instructor_role: 'A',
            speed_qualification: speedQualification,
            pricing_basis: isSpeed ? 'speed_qualification' : 'general_level',
            pricing_label: missingQualification ? null : (isSpeed ? '速解大師' : 'A'),
            rate_card_id: needsReview ? null : '20000000-0000-4000-8000-000000000041',
            pricing_mode: 'hourly',
            applied_rate: needsReview ? null : appliedRate,
            base_salary: needsReview ? null : appliedRate * Number(body.p_duration_hours),
        }]);
    }
    if (url.pathname === '/rest/v1/rpc/submit_my_class_session') {
        submitCalls += 1;
        return json(route, '30000000-0000-4000-8000-000000000041');
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);

    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        if (request.method() !== 'GET') {
            if (table === 'class_sessions') directSessionWrites += 1;
            return json(route, acceptsObject ? {} : [], 201);
        }
        if (table === 'users') {
            const row = { id: userId, name: '速解測試老師', email: authUser.email, role: appRole, created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructors') {
            const row = {
                id: instructorId,
                user_id: userId,
                full_name: '速解測試老師',
                nickname: '速解測試老師',
                gender: '男',
                birth_date: '1990-01-01',
                id_number: 'A123456789',
                phone_mobile: '0912345678',
                line_id: 'speed-test',
                address: '測試通訊地址',
                household_address: '測試戶籍地址',
                email_primary: authUser.email,
                instructor_role: 'A',
                speed_qualification: speedQualification,
                employment_status: 'active',
                teaching_freq_semester: '每週 2 次',
                teaching_freq_vacation: '每週 3 次',
                teaching_regions: ['臺北市'],
                bio_notes: '測試講師',
                bank_account_name: '速解測試老師',
                bank_name: '測試銀行',
                bank_branch: '測試分行',
                bank_account_number: '0000000000',
                bank_code: '0000000',
                photo_path: 'test/photo.png',
                id_front_path: 'test/id-front.png',
                id_back_path: 'test/id-back.png',
                bankbook_path: 'test/bankbook.png',
                created_at: now,
            };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructor_salary_summary') return json(route, acceptsObject ? null : []);
        if (table === 'class_sessions') return json(route, appRole === 'admin' ? [salarySession] : []);
        return json(route, acceptsObject ? null : []);
    }
    return json(route, {}, 404);
}

async function waitForServer() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        try { if ((await fetch(base)).ok) return; } catch { /* preview starting */ }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('Vite preview did not start');
}

const results = [];
const check = (name, condition) => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
};

async function contextFor(browser) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
    await context.route('**/*', handleRoute);
    return context;
}

async function run() {
    const viteBin = path.join(appDir, 'node_modules', '.bin', 'vite');
    const preview = spawn(viteBin, ['preview', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser;
    try {
        await waitForServer();
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});

        appRole = 'teacher';
        speedQualification = 'speed_master';
        submitCalls = 0;
        directSessionWrites = 0;
        let context = await contextFor(browser);
        let page = await context.newPage();
        await page.goto(`${base}/my/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '我的報酬' }).waitFor();
        check('講師端顯示站內課程回報入口', await page.getByRole('link', { name: /登記課程回報/ }).isVisible());
        check('講師端保留舊表單轉換入口', await page.getByText('仍在使用舊表單？').isVisible());
        await page.goto(`${base}/my/salary/new`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '登記課程回報' }).waitFor();
        await page.locator('select:has(option[value="speed_onsite"])').selectOption('speed_onsite');
        await page.locator('input[inputmode="decimal"]').fill('1.5');
        await page.locator('input[inputmode="numeric"]').fill('2');
        await page.waitForFunction(() => document.body.innerText.includes('依據：速解大師'));
        const quoteText = await page.locator('body').innerText();
        const hasSpeedBasis = quoteText.includes('依據：速解大師');
        check('講師端顯示速解大師試算依據', hasSpeedBasis);
        check('講師端顯示自動試算金額', await page.getByText('$1,350').first().isVisible());
        await page.screenshot({ path: '/tmp/dream-one-salary-report-desktop.png', fullPage: true });
        await page.getByRole('button', { name: '送出回報' }).click();
        await page.getByText('課程回報已送出，管理員核薪後會更新狀態。').waitFor();
        check('講師回報透過受控 RPC 送出', submitCalls === 1 && directSessionWrites === 0);
        check('回報成功後顯示確認訊息', await page.getByText('課程回報已送出，管理員核薪後會更新狀態。').isVisible());
        await context.close();

        speedQualification = null;
        context = await contextFor(browser);
        page = await context.newPage();
        await page.goto(`${base}/my/salary/new`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '登記課程回報' }).waitFor();
        await page.locator('select:has(option[value="speed_onsite"])').selectOption('speed_onsite');
        await page.getByText('待管理員核薪').waitFor();
        check('未取得速解資格顯示待核薪', await page.getByText('待核薪').first().isVisible());
        await context.close();

        appRole = 'admin';
        speedQualification = 'speed_master';
        context = await contextFor(browser);
        page = await context.newPage();
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        check('管理端薪資登記頁已啟用', await page.getByRole('heading', { name: '薪資登記中心' }).isVisible());
        check('管理端沒有未啟用遮罩', await page.getByText('尚未啟用，敬請期待').count() === 0);
        check('管理端優先顯示待核薪紀錄', await page.getByText('待核薪').first().isVisible());
        await page.locator('tr[aria-label="開啟 速解測試老師 2026-08-14 薪資紀錄"]').click();
        await page.getByRole('heading', { name: '審核 / 編輯薪資紀錄' }).waitFor();
        check('管理端可開啟審核與重新試算', await page.getByRole('heading', { name: '審核 / 編輯薪資紀錄' }).isVisible());
        await page.getByRole('button', { name: '關閉薪資紀錄' }).click();
        await page.screenshot({ path: '/tmp/dream-one-salary-admin-desktop.png', fullPage: true });
        await context.close();

        context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
        await context.route('**/*', handleRoute);
        page = await context.newPage();
        appRole = 'teacher';
        await page.goto(`${base}/my/salary/new`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '登記課程回報' }).waitFor();
        await page.getByText('待管理員核薪').waitFor();
        const teacherOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check('390px 講師回報頁無水平溢出', teacherOverflow === 0);
        await page.screenshot({ path: '/tmp/dream-one-salary-report-mobile.png', fullPage: true });
        appRole = 'admin';
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '薪資登記中心' }).waitFor();
        const adminOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check('390px 薪資登記中心無水平溢出', adminOverflow === 0);
        await page.screenshot({ path: '/tmp/dream-one-salary-admin-mobile.png', fullPage: true });
        await context.close();
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }

    const passed = results.filter(Boolean).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    process.exitCode = passed === results.length ? 0 : 1;
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
