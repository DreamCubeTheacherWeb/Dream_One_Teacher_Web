#!/usr/bin/env node
// 2026-10-20 上線後大檢查的雜項修正：以 mock Supabase 實際開頁驗證（不連任何真實後端）。
//  1. 後台「培訓進度總覽」：超過 1000 筆進度時要分頁抓完，完成數才不會被低估。
//  2. 後台「作業審核中心」：改成 effect 內載入（修 lint）後，頁面載入、分組、待審核數、輔導員選單行為不變。
//  3. 登入核心（AuthContext）：users 查詢遇到 5xx 要重試，不可把已存在的帳號當成新使用者／待審核。
//  4. 後台課程編輯（CMSManager）：章節標題／「需繳交作業」寫入失敗時，畫面要還原並提示（不能顯示成已存）。
//  5. 章節頁（LessonDetail）：快速切章時舊章節較晚回來的回應不可蓋掉新章節；留言按讚不可連點多加、失敗要還原。
import { existsSync, readFileSync } from 'node:fs';
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

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();

const makeSession = (userId, email, name) => {
    const authUser = {
        id: userId, aud: 'authenticated', role: 'authenticated', email,
        user_metadata: { full_name: name }, app_metadata: { provider: 'google', providers: ['google'] },
        identities: [], created_at: now, updated_at: now,
    };
    const session = {
        access_token: 'mock.misc.fixes', refresh_token: 'mock.refresh', token_type: 'bearer',
        expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
    };
    return { authUser, session };
};

const json = (route, data, status = 200) => route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}) },
    body: JSON.stringify(data),
});

// 模擬 PostgREST：預設最多回 1000 筆（max-rows），並支援 supabase-js .range() 送出的 offset／limit 與 order。
const PGRST_MAX_ROWS = 1000;
const paginate = (rows, url) => {
    const params = url.searchParams;
    const order = params.get('order');
    let list = rows;
    if (order) {
        const [col, dir] = order.split('.');
        list = [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const offset = Number(params.get('offset') || 0);
    const limit = Math.min(Number(params.get('limit') || PGRST_MAX_ROWS), PGRST_MAX_ROWS);
    return list.slice(offset, offset + limit);
};

/**
 * 通用 mock：scenario.tables[表名](url, request) 回傳陣列（或 { status, body }）；
 * scenario.rpc[函式名](request) 回傳 JSON。沒定義的表一律回空陣列。
 */
const makeHandler = (scenario) => async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, scenario.authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, scenario.session);
        return json(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = url.pathname.replace('/rest/v1/rpc/', '');
        const handler = scenario.rpc?.[fn];
        return json(route, handler ? await handler(request) : null);
    }
    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        scenario.log?.push({ method: request.method(), table, search: url.search });
        const handler = scenario.tables?.[table];
        if (handler) {
            const result = await handler(url, request);
            if (result && !Array.isArray(result) && result.status) {
                return route.fulfill({ status: result.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result.body ?? {}) });
            }
            if (acceptsObject) return json(route, result?.[0] ?? null);
            return json(route, result);
        }
        if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
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

const openPage = async (browser, scenario, viewport = { width: 1280, height: 1000 }) => {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: scenario.session });
    await context.route('**/*', makeHandler(scenario));
    const page = await context.newPage();
    return { context, page };
};

// ───────────────────────── 1. 培訓進度總覽：2500 筆進度要分頁抓完 ─────────────────────────
async function verifyProgressOverviewPaging(browser, base) {
    const adminId = '00000000-0000-4000-8000-000000000101';
    const { authUser, session } = makeSession(adminId, 'progress-admin@test.local', '進度測試管理員');
    const LESSONS = 20;
    const TEACHERS = 125; // 125 位 × 20 章 = 2500 筆進度
    const courseId = '10000000-0000-4000-8000-000000000001';
    const pad = (n, w) => String(n).padStart(w, '0');
    const lessons = Array.from({ length: LESSONS }, (_, i) => ({ id: `30000000-0000-4000-8000-0000000000${pad(i, 2)}` }));
    const teachers = Array.from({ length: TEACHERS }, (_, i) => ({
        id: `40000000-0000-4000-8000-000000000${pad(i, 3)}`, name: `講師${pad(i, 3)}`, email: `t${pad(i, 3)}@example.com`, mentor_name: null,
    }));
    // 講師 i 完成 (i % 21) 章，最多 20（0～20 章都會出現）
    const expected = new Map(teachers.map((t, i) => [t.email, Math.min(i % (LESSONS + 1), LESSONS)]));
    const progressRows = teachers.flatMap((t, i) => lessons.map((l, j) => ({
        id: `p-${pad(i, 3)}-${pad(j, 2)}`, user_id: t.id, lesson_id: l.id, completed: j < expected.get(t.email),
    })));
    const log = [];
    const scenario = {
        authUser, session, log,
        tables: {
            users: (url) => (url.searchParams.get('role') === 'eq.teacher'
                ? teachers
                : [{ id: adminId, name: '進度測試管理員', email: authUser.email, role: 'admin', created_at: now }]),
            courses: () => [{ id: courseId, title: '測試課程' }],
            lessons: () => lessons,
            progress: (url) => paginate(progressRows, url),
        },
    };
    const { context, page } = await openPage(browser, scenario);
    await page.goto(`${base}/admin/progress`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '培訓進度總覽' }).waitFor();
    await page.locator('table tbody tr').nth(TEACHERS - 1).waitFor();
    const shown = await page.evaluate(() => [...document.querySelectorAll('table tbody tr')].map(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.innerText.trim());
        return { email: cells[1], progress: cells[3] };
    }));
    const wrong = shown.filter(r => r.progress !== `${expected.get(r.email)}/${LESSONS}`);
    const progressRequests = log.filter(l => l.table === 'progress').length;
    check('進度總覽：125 位講師 × 20 章（共 2500 筆進度）每位的完成數都正確', shown.length === TEACHERS && wrong.length === 0,
        wrong.length ? `${wrong.length} 位錯誤，例如 ${wrong[0].email} 顯示 ${wrong[0].progress}、應為 ${expected.get(wrong[0].email)}/${LESSONS}` : `${shown.length} 位全對`);
    const last = shown.find(r => r.email === teachers[TEACHERS - 1].email);
    check('進度總覽：排在第 3 頁的最後一位講師完成數正確', last?.progress === `${expected.get(last?.email)}/${LESSONS}`, last?.progress);
    check('進度總覽：進度分 3 頁抓取（1000＋1000＋500）', progressRequests === 3, `${progressRequests} 次請求`);
    await context.close();
}

// ───────────────────────── 2. 作業審核中心：載入行為不變（lint 修正的回歸） ─────────────────────────
async function verifyAssignmentReviewLoads(browser, base) {
    const adminId = '00000000-0000-4000-8000-000000000102';
    const { authUser, session } = makeSession(adminId, 'review-admin@test.local', '審核測試管理員');
    const teacherA = '50000000-0000-4000-8000-00000000000a';
    const teacherB = '50000000-0000-4000-8000-00000000000b';
    const lesson = { title: '第一章', course_id: 'c1', courses: { title: '測試課程' } };
    const assignments = [
        { id: 'a1', user_id: teacherA, lesson_id: 'l1', type: 'text', content: '心得一', created_at: '2026-10-01T00:00:00Z', lessons: lesson },
        { id: 'a2', user_id: teacherA, lesson_id: 'l2', type: 'text', content: '心得二', created_at: '2026-10-02T00:00:00Z', lessons: lesson },
        { id: 'a3', user_id: teacherB, lesson_id: 'l1', type: 'text', content: '心得三', created_at: '2026-10-03T00:00:00Z', lessons: lesson },
    ];
    const scenario = {
        authUser, session,
        tables: {
            users: (url) => {
                const id = url.searchParams.get('id');
                if (id === `eq.${adminId}`) return [{ id: adminId, name: '審核測試管理員', email: authUser.email, role: 'admin', created_at: now }];
                return [
                    { id: teacherA, name: '甲講師', email: 'a@example.com', role: 'teacher', mentor_name: '輔導甲' },
                    { id: teacherB, name: '乙講師', email: 'b@example.com', role: 'teacher', mentor_name: null },
                    { id: adminId, name: '審核測試管理員', email: authUser.email, role: 'admin', mentor_name: null },
                ];
            },
            assignments: () => assignments,
            assignment_feedbacks: () => [{ id: 'f1', assignment_id: 'a1', user_id: adminId, content: '很好', created_at: '2026-10-04T00:00:00Z' }],
        },
    };
    const { context, page } = await openPage(browser, scenario);
    await page.goto(`${base}/admin/assignments`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '作業審核中心' }).waitFor();
    const buttons = await page.locator('button:has(span.font-bold)').allInnerTexts();
    const cardA = buttons.find(t => t.includes('甲講師')) || '';
    const cardB = buttons.find(t => t.includes('乙講師')) || '';
    check('作業審核：兩位講師各一張卡片', Boolean(cardA) && Boolean(cardB), buttons.join(' | ').replace(/\n/g, ' '));
    check('作業審核：甲講師 2 份作業、1 份已回饋 → 待審核數 1，並顯示輔導員標籤', /\b1\b/.test(cardA) && cardA.includes('輔導甲'), cardA.replace(/\n/g, ' '));
    check('作業審核：乙講師 1 份作業、尚未回饋 → 待審核數 1', /\b1\b/.test(cardB), cardB.replace(/\n/g, ' '));
    const mentorOptions = await page.locator('select').first().locator('option').allInnerTexts();
    check('作業審核：輔導員下拉選單載入「輔導甲」', mentorOptions.includes('輔導甲'), mentorOptions.join('/'));
    await context.close();
}

// ───────────────────────── 3. 登入核心：users 查詢 5xx 不可被當成「沒有這個帳號」 ─────────────────────────
const RETRY_MESSAGE = '帳號資料載入失敗';
const authScenario = (userId, { usersGet }) => {
    const { authUser, session } = makeSession(userId, 'auth-admin@test.local', '登入測試管理員');
    const log = [];
    const scenario = {
        authUser, session, log,
        tables: {
            users: (url, request) => {
                // 登入核心查自己的 users 列（id=eq.<自己>）；其他頁面查的 users 不計入
                if (request.method() === 'GET' && url.searchParams.get('id') === `eq.${userId}`) {
                    return usersGet(log.filter(l => l.method === 'GET' && l.table === 'users' && l.search.includes(`id=eq.${userId}`)).length);
                }
                return request.method() === 'GET' ? [] : [];
            },
            courses: () => [],
        },
    };
    return scenario;
};
const adminRow = (userId) => ({ id: userId, name: '登入測試管理員', email: 'auth-admin@test.local', role: 'admin', created_at: now });
const waitForOutcome = (page) => page.waitForFunction((msg) => {
    const text = document.body.innerText;
    return location.pathname === '/pending' || text.includes(msg) || text.includes('培訓進度總覽');
}, RETRY_MESSAGE, { timeout: 15000 }).catch(() => {});
const usersInserts = (log) => log.filter(l => l.method === 'POST' && l.table === 'users').length;
const usersGets = (log, userId) => log.filter(l => l.method === 'GET' && l.table === 'users' && l.search.includes(`id=eq.${userId}`)).length;

async function verifyAuthRetry(browser, base) {
    // 情境 A：503 兩次後成功 → 最後是管理員，不被導去 /pending，也不建立新 users 列
    {
        const userId = '00000000-0000-4000-8000-000000000201';
        const scenario = authScenario(userId, {
            usersGet: (n) => (n <= 2 ? { status: 503, body: { message: 'upstream unavailable' } } : [adminRow(userId)]),
        });
        const { context, page } = await openPage(browser, scenario);
        await page.goto(`${base}/admin/progress`, { waitUntil: 'domcontentloaded' });
        await waitForOutcome(page);
        const pathName = new URL(page.url()).pathname;
        check('登入重試 A：503 兩次後成功 → 停在管理員頁面、沒被導去 /pending', pathName === '/admin/progress' && await page.getByRole('heading', { name: '培訓進度總覽' }).isVisible(), `path=${pathName}`);
        check('登入重試 A：共查 3 次（失敗 2 次＋成功 1 次）且沒有建立新 users 列', usersGets(scenario.log, userId) === 3 && usersInserts(scenario.log) === 0,
            `查詢 ${usersGets(scenario.log, userId)} 次、建立 ${usersInserts(scenario.log)} 次`);
        await context.close();
    }
    // 情境 B：一直 503 → 顯示可重試的錯誤，不是 pending、不建立新 users 列；按重試後（後端恢復）進得去
    {
        const userId = '00000000-0000-4000-8000-000000000202';
        let backendUp = false;
        const scenario = authScenario(userId, {
            usersGet: () => (backendUp ? [adminRow(userId)] : { status: 503, body: { message: 'upstream unavailable' } }),
        });
        const { context, page } = await openPage(browser, scenario);
        await page.goto(`${base}/admin/progress`, { waitUntil: 'domcontentloaded' });
        await waitForOutcome(page);
        const pathName = new URL(page.url()).pathname;
        const bodyText = await page.evaluate(() => document.body.innerText);
        const retryButton = page.getByRole('button', { name: /重試/ });
        check('登入重試 B：一直 503 → 顯示「帳號資料載入失敗」與重試按鈕', bodyText.includes(RETRY_MESSAGE) && await retryButton.isVisible(), `path=${pathName}`);
        check('登入重試 B：不是 pending（沒導去 /pending、沒有待審核畫面）', pathName !== '/pending' && !bodyText.includes('待審核'), `path=${pathName}`);
        check('登入重試 B：共查 3 次（首次＋重試 2 次）且沒有建立新 users 列', usersGets(scenario.log, userId) === 3 && usersInserts(scenario.log) === 0,
            `查詢 ${usersGets(scenario.log, userId)} 次、建立 ${usersInserts(scenario.log)} 次`);
        backendUp = true;
        let recovered = false;
        if (await retryButton.isVisible()) {
            await retryButton.click();
            recovered = await page.getByRole('heading', { name: '培訓進度總覽' }).waitFor({ timeout: 15000 }).then(() => true, () => false);
        }
        check('登入重試 B：後端恢復後按「重試」→ 進入管理員頁面', recovered && new URL(page.url()).pathname === '/admin/progress' && usersInserts(scenario.log) === 0, `path=${new URL(page.url()).pathname}`);
        await context.close();
    }
    // 情境 C：查無此列（2xx 空陣列）→ 照舊走新使用者流程：建立 users 列、進待審核頁
    {
        const userId = '00000000-0000-4000-8000-000000000203';
        const scenario = authScenario(userId, { usersGet: () => [] });
        const { context, page } = await openPage(browser, scenario);
        await page.goto(`${base}/courses`, { waitUntil: 'domcontentloaded' });
        await waitForOutcome(page);
        const pathName = new URL(page.url()).pathname;
        check('登入重試 C：查無此列 → 照舊建立新 users 列並進入 /pending', pathName === '/pending' && usersInserts(scenario.log) === 1, `path=${pathName}、建立 ${usersInserts(scenario.log)} 次`);
        check('登入重試 C：查無此列不重試（只查 1 次）', usersGets(scenario.log, userId) === 1, `${usersGets(scenario.log, userId)} 次`);
        await context.close();
    }
}

// ───────────────────────── 4. 課程編輯：章節寫入失敗要還原畫面並提示 ─────────────────────────
async function verifyCmsWriteFailures(browser, base) {
    const adminId = '00000000-0000-4000-8000-000000000204';
    const { authUser, session } = makeSession(adminId, 'cms-admin@test.local', '課程測試管理員');
    const courseId = '10000000-0000-4000-8000-000000000204';
    const lessonId = '30000000-0000-4000-8000-000000000204';
    let failWrites = true;
    const lessonPatches = [];
    const scenario = {
        authUser, session,
        tables: {
            users: () => [{ id: adminId, name: '課程測試管理員', email: authUser.email, role: 'admin', created_at: now }],
            course_categories: () => [{ id: 'cat1', title: '測試分類', visibility: 'all', is_published: true, order: 0 }],
            courses: () => [{ id: courseId, title: '測試課程', description: '', is_published: true, category_id: 'cat1', visibility: 'all' }],
            lessons: async (url, request) => {
                if (request.method() === 'PATCH') {
                    lessonPatches.push(JSON.parse(request.postData() || '{}'));
                    return failWrites ? { status: 500, body: { message: 'simulated write failure' } } : [];
                }
                return [{ id: lessonId, course_id: courseId, title: '第一章', order: 0, requires_assignment: false, assignment_for: null, tags: [] }];
            },
        },
    };
    const { context, page } = await openPage(browser, scenario);
    const dialogs = [];
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
    await page.goto(`${base}/admin/cms/${courseId}`, { waitUntil: 'networkidle' });
    const titleInput = page.getByPlaceholder('輸入章節標題...');
    await titleInput.waitFor();
    const requiresBox = page.getByRole('checkbox').nth(1); // 第 0 個是「發佈此課程」

    // 寫入失敗：標題
    await titleInput.fill('改壞的標題');
    await titleInput.blur();
    await page.waitForFunction(() => document.querySelector('input[placeholder="輸入章節標題..."]').value === '第一章', null, { timeout: 5000 }).catch(() => {});
    check('課程編輯（寫入失敗）：標題還原成「第一章」並跳出提示', await titleInput.inputValue() === '第一章' && dialogs.some(d => d.includes('章節標題儲存失敗')), `value=${await titleInput.inputValue()}、提示=${dialogs.join('|')}`);

    // 寫入失敗：需繳交作業
    dialogs.length = 0;
    await requiresBox.check({ force: true, noWaitAfter: true }).catch(() => {});
    await page.waitForTimeout(800);
    check('課程編輯（寫入失敗）：「需繳交作業」勾選被還原成未勾並跳出提示', !(await requiresBox.isChecked()) && dialogs.some(d => d.includes('需繳交作業')), `checked=${await requiresBox.isChecked()}、提示=${dialogs.join('|')}`);

    // 寫入成功：照舊保留改動、不跳提示
    failWrites = false;
    dialogs.length = 0;
    lessonPatches.length = 0;
    await titleInput.fill('第一章（新版）');
    await titleInput.blur();
    await page.waitForTimeout(800);
    await requiresBox.check({ force: true });
    await page.waitForTimeout(800);
    check('課程編輯（寫入成功）：標題與勾選保留、沒有錯誤提示、兩筆更新都送出',
        await titleInput.inputValue() === '第一章（新版）' && await requiresBox.isChecked() && dialogs.length === 0
            && lessonPatches.some(b => b.title === '第一章（新版）') && lessonPatches.some(b => b.requires_assignment === true),
        `title=${await titleInput.inputValue()}、checked=${await requiresBox.isChecked()}、提示=${dialogs.length}、PATCH=${JSON.stringify(lessonPatches)}`);
    await context.close();
}

// ───────────────────────── 5. 章節頁：快速切章不被舊回應蓋掉；按讚防連點、失敗還原 ─────────────────────────
async function verifyLessonDetail(browser, base) {
    const adminId = '00000000-0000-4000-8000-000000000205';
    const { authUser, session } = makeSession(adminId, 'lesson-admin@test.local', '章節測試管理員');
    const courseId = '10000000-0000-4000-8000-000000000205';
    const L1 = '30000000-0000-4000-8000-000000000251';
    const L2 = '30000000-0000-4000-8000-000000000252';
    const lessonRows = {
        [L1]: { id: L1, course_id: courseId, title: '第一章：快速載入', order: 0, requires_assignment: false },
        [L2]: { id: L2, course_id: courseId, title: '第二章：很慢才回來', order: 1, requires_assignment: false },
    };
    const SLOW_MS = 2500;
    // 點「下一章節」進入 L2 時（armSlow）的第一個課程請求故意很慢，模擬舊章節的回應比新章節晚回來
    const state = { armSlow: false, slowStarted: false, slowDelivered: false, likeMode: 'slow-ok', likePosts: 0 };
    const scenario = {
        authUser, session,
        tables: {
            users: () => [{ id: adminId, name: '章節測試管理員', email: authUser.email, role: 'admin', created_at: now }],
            courses: async () => {
                if (state.armSlow) {
                    state.armSlow = false;
                    state.slowStarted = true;
                    await new Promise(resolve => setTimeout(resolve, SLOW_MS));
                    state.slowDelivered = true;
                }
                return [{ id: courseId, title: '測試課程' }];
            },
            lessons: async (url) => {
                const id = url.searchParams.get('id');
                if (id) return [lessonRows[id.replace('eq.', '')]]; // 單一章節（.single()）
                return [lessonRows[L1], lessonRows[L2]].map(({ id: rowId, title, order }) => ({ id: rowId, title, order }));
            },
            lesson_comments: () => [{ id: 'cm1', lesson_id: L1, user_id: '50000000-0000-4000-8000-0000000000aa', body: '一則留言', created_at: '2026-10-05T00:00:00Z' }],
            lesson_comment_likes: async (url, request) => {
                if (request.method() === 'POST') {
                    state.likePosts += 1;
                    if (state.likeMode === 'fail') return { status: 500, body: { message: 'simulated like failure' } };
                    await new Promise(resolve => setTimeout(resolve, 600));
                    return [];
                }
                return [];
            },
        },
    };

    // 快速切章：L1 載入完 → 點「下一章節」到慢的 L2 → 還沒回來就按上一頁回 L1
    {
        const { context, page } = await openPage(browser, scenario);
        await page.goto(`${base}/courses/${courseId}/lessons/${L1}`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '第一章：快速載入' }).waitFor();
        state.armSlow = true;
        await page.getByRole('link', { name: '下一章節' }).click();
        await page.waitForURL(`**/lessons/${L2}`);
        const waitStarted = Date.now();
        while (!state.slowStarted && Date.now() - waitStarted < 5000) await page.waitForTimeout(20);
        await page.goBack(); // 慢的 L2 請求還在路上時就回到 L1
        await page.waitForURL(`**/lessons/${L1}`);
        await page.getByRole('heading', { name: '第一章：快速載入' }).waitFor();
        const start = Date.now();
        while (!state.slowDelivered && Date.now() - start < SLOW_MS + 3000) await page.waitForTimeout(100);
        await page.waitForTimeout(1500); // 讓慢的回應有機會（錯誤地）接著把 L2 的內容蓋到畫面上
        const heading = await page.locator('h1').allInnerTexts();
        const pathName = new URL(page.url()).pathname;
        check('章節頁：舊章節（慢）的回應已送達，但畫面仍是最後點的章節（第一章）', state.slowStarted && state.slowDelivered && pathName.endsWith(L1) && heading.includes('第一章：快速載入') && !heading.includes('第二章：很慢才回來'),
            `slowStarted=${state.slowStarted}、slowDelivered=${state.slowDelivered}、path=...${pathName.slice(-8)}、標題=${heading.join('|')}`);
        await context.close();
    }

    // 按讚：連點只送一次、數字只 +1
    const likeButton = (page) => page.locator('button:has(svg.lucide-thumbs-up)');
    {
        state.likeMode = 'slow-ok';
        state.likePosts = 0;
        const { context, page } = await openPage(browser, scenario);
        await page.goto(`${base}/courses/${courseId}/lessons/${L1}`, { waitUntil: 'networkidle' });
        await likeButton(page).waitFor();
        await likeButton(page).dblclick();
        await page.waitForTimeout(1500);
        const text = (await likeButton(page).innerText()).trim();
        check('按讚：快速連點兩下只送出 1 次寫入、數字是 1', state.likePosts === 1 && text === '1', `寫入 ${state.likePosts} 次、顯示「${text}」`);
        await context.close();
    }

    // 按讚失敗：數字與按鈕狀態還原並提示
    {
        state.likeMode = 'fail';
        state.likePosts = 0;
        const { context, page } = await openPage(browser, scenario);
        const dialogs = [];
        page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.accept(); });
        await page.goto(`${base}/courses/${courseId}/lessons/${L1}`, { waitUntil: 'networkidle' });
        await likeButton(page).waitFor();
        await likeButton(page).click();
        await page.waitForTimeout(1000);
        const text = (await likeButton(page).innerText()).trim();
        const className = await likeButton(page).getAttribute('class');
        check('按讚：寫入失敗 → 數字還原（不顯示 1）、不是已按讚樣式，並跳出提示', text === '' && !className.includes('bg-bauhaus-blue') && dialogs.some(d => d.includes('按讚失敗')),
            `顯示「${text}」、提示=${dialogs.join('|')}`);
        check('按讚：失敗後按鈕恢復可再按', await likeButton(page).isEnabled());
        await context.close();
    }
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
        await verifyProgressOverviewPaging(browser, base);
        await verifyAssignmentReviewLoads(browser, base);
        await verifyAuthRetry(browser, base);
        await verifyCmsWriteFailures(browser, base);
        await verifyLessonDetail(browser, base);
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} PASS`);
    if (failed) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
