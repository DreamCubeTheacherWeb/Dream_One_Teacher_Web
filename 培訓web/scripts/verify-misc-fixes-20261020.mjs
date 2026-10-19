#!/usr/bin/env node
// 2026-10-20 上線後大檢查的雜項修正：以 mock Supabase 實際開頁驗證（不連任何真實後端）。
//  1. 後台「培訓進度總覽」：超過 1000 筆進度時要分頁抓完，完成數才不會被低估。
//  2. 後台「作業審核中心」：改成 effect 內載入（修 lint）後，頁面載入、分組、待審核數、輔導員選單行為不變。
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
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} PASS`);
    if (failed) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
