#!/usr/bin/env node
// 輔導員（mentor）只負責培訓、不碰錢與個資（migration 20261022010000 的前端部分）：
// 以假 Supabase（照新 RLS：mentor 讀 instructors 表只會拿到自己那列）在正式版建置上實跑，
//   mentor：/admin/download-center、/admin/salary 被導回首頁；後台首頁不再出現這兩張入口卡；
//           講師資料總覽只顯示名冊（無個資、無文件、無展開明細、無預覽表單），資料來自名冊函式；
//           作業審核中心、章節頁的講師姓名改由名冊函式取得；全程不直接讀 instructors 表、不讀證件檔。
//   admin：上述頁面與功能照舊（直接讀 instructors 表、可展開明細、可預覽表單、可進兩個報酬／表單頁）。
// 需先 npm run build；需在沙盒外執行（要開本機 port）。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = mkdtempSync(path.join(tmpdir(), 'dream-one-mentor-access-'));

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();

const IDS = {
    admin: '00000000-0000-4000-8000-0000000000a1',
    mentor: '00000000-0000-4000-8000-0000000000a2',
    t1: '00000000-0000-4000-8000-0000000000b1',
    t2: '00000000-0000-4000-8000-0000000000b2',
};
const COURSE_ID = 'd0000000-0000-4000-8000-000000000001';
const LESSON_ID = 'e0000000-0000-4000-8000-000000000001';
const SENSITIVE = ['A123456789', 'B223456789', '00011122233', '00099988877', '0912345678', '0922333444', 'teacher1@example.com', '臺北市信義區'];

const INSTRUCTORS = [
    {
        id: '10000000-0000-4000-8000-0000000000b1', user_id: IDS.t1, full_name: '王小明', nickname: '小明', gender: '男',
        instructor_role: 'A', employment_status: 'active', teaching_regions: ['臺北市'], speed_qualification: null,
        id_number: 'A123456789', bank_account_number: '00011122233', bank_name: '測試銀行', bank_code: '812', phone_mobile: '0912345678',
        email_primary: 'teacher1@example.com', address: '臺北市信義區', birth_date: '1999-01-01',
        id_front_path: `instructors/${IDS.t1}/id_front.jpg`, id_back_path: `instructors/${IDS.t1}/id_back.jpg`, bankbook_path: `instructors/${IDS.t1}/bankbook.jpg`,
        created_at: now, updated_at: now,
    },
    {
        id: '10000000-0000-4000-8000-0000000000b2', user_id: IDS.t2, full_name: '李小華', nickname: '小華', gender: '女',
        instructor_role: '實習', employment_status: 'active', teaching_regions: ['新北市'], speed_qualification: null,
        id_number: 'B223456789', bank_account_number: '00099988877', bank_name: '測試銀行', bank_code: '812', phone_mobile: '0922333444',
        email_primary: 'teacher2@example.com', address: '新北市板橋區', birth_date: '2000-02-02',
        created_at: now, updated_at: now,
    },
];
const DIRECTORY_KEYS = ['id', 'user_id', 'full_name', 'nickname', 'instructor_role', 'employment_status', 'teaching_regions', 'speed_qualification'];
const USERS = [
    { id: IDS.admin, name: '測試管理員', email: 'admin@example.com', role: 'admin', mentor_name: null, created_at: now },
    { id: IDS.mentor, name: '測試輔導員', email: 'mentor@example.com', role: 'mentor', mentor_name: null, created_at: now },
    { id: IDS.t1, name: 'google-t1', email: 'g1@example.com', role: 'teacher', mentor_name: null, created_at: now },
    { id: IDS.t2, name: 'google-t2', email: 'g2@example.com', role: 'teacher', mentor_name: null, created_at: now },
];
const COURSE = { id: COURSE_ID, title: '測試課程', is_published: true, order: 1, visibility: 'all', category_id: 'c1', course_categories: { title: '分類' }, created_at: now };
const LESSON = { id: LESSON_ID, course_id: COURSE_ID, title: '第一章', order: 1, is_published: true, created_at: now };
const ASSIGNMENT = {
    id: 'a0000000-0000-4000-8000-000000000001', user_id: IDS.t1, lesson_id: LESSON_ID, content: '作業內容', video_url: null,
    feedback: null, created_at: now, lessons: { title: '第一章', course_id: COURSE_ID, courses: { title: '測試課程' } },
};
const FEEDBACK = { id: 'f0000000-0000-4000-8000-000000000001', assignment_id: ASSIGNMENT.id, user_id: IDS.t2, content: '回饋', created_at: now };
const COMMENT = { id: 'c0000000-0000-4000-8000-000000000001', lesson_id: LESSON_ID, user_id: IDS.t1, body: '留言內容', created_at: now };

const sessionFor = (role) => {
    const user = {
        id: IDS[role], aud: 'authenticated', role: 'authenticated', email: `${role}@example.com`,
        app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: role }, created_at: now, updated_at: now,
    };
    return {
        user,
        session: {
            access_token: `mock.${role}.token`, refresh_token: `mock.${role}.refresh`, token_type: 'bearer',
            expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user,
        },
    };
};

// PostgREST 篩選（只實作本頁面會用到的 eq.／in.()／is.）
const applyFilters = (rows, params) => rows.filter((row) => {
    for (const [key, raw] of params) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
        const value = row[key];
        if (raw.startsWith('eq.')) { if (String(value) !== raw.slice(3)) return false; }
        else if (raw.startsWith('in.(')) { if (!raw.slice(4, -1).split(',').map((v) => v.replace(/"/g, '')).includes(String(value))) return false; }
        else if (raw === 'not.is.null') { if (value == null) return false; }
        else if (raw === 'is.null') { if (value != null) return false; }
    }
    return true;
});

const respond = (route, body, { status = 200, total } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (Array.isArray(body)) headers['content-range'] = body.length ? `0-${body.length - 1}/${total ?? body.length}` : `*/${total ?? 0}`;
    return route.fulfill({ status, headers, body: JSON.stringify(body) });
};

const makeHandler = (role, log) => async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    const { user, session } = sessionFor(role);
    const entry = { role, method: request.method(), path: url.pathname, query: url.search, body: request.postData() };
    log.push(entry);

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return respond(route, user);
        if (url.pathname.startsWith('/auth/v1/token')) return respond(route, session);
        return respond(route, {});
    }
    if (url.pathname.startsWith('/storage/v1/')) return respond(route, { signedURL: '/x' });
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = url.pathname.split('/').pop();
        if (fn === 'mentor_instructor_directory') {
            if (role !== 'admin' && role !== 'mentor') return respond(route, { code: '42501', message: 'denied' }, { status: 403 });
            const ids = (request.postDataJSON() || {}).p_user_ids;
            const rows = INSTRUCTORS.filter((i) => !ids || ids.includes(i.user_id))
                .map((i) => Object.fromEntries(DIRECTORY_KEYS.map((k) => [k, i[k] ?? null])));
            return respond(route, rows);
        }
        if (fn === 'claim_my_precreated_instructor') return respond(route, { status: 'staff' });
        return respond(route, null);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return respond(route, {}, { status: 404 });

    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
    const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
    if (!['GET', 'HEAD'].includes(request.method())) return route.fulfill({ status: 204, body: '' });

    let rows = [];
    if (table === 'users') rows = USERS;
    // 新 RLS：admin 讀全表；其他角色只讀得到自己那列（mentor 沒有主檔 → 空）
    else if (table === 'instructors') rows = role === 'admin' ? INSTRUCTORS : INSTRUCTORS.filter((i) => i.user_id === user.id);
    else if (table === 'courses') rows = [COURSE];
    else if (table === 'lessons') rows = [LESSON];
    else if (table === 'assignments') rows = [ASSIGNMENT];
    else if (table === 'assignment_feedbacks') rows = [FEEDBACK];
    else if (table === 'lesson_comments') rows = [COMMENT];
    rows = applyFilters(rows, url.searchParams);
    if (request.method() === 'HEAD') {
        // 跨網域時前端要讀得到 content-range 才拿得到 count
        return route.fulfill({
            status: 200,
            headers: {
                'content-range': rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0',
                'access-control-allow-origin': '*',
                'access-control-expose-headers': 'content-range',
            },
            body: '',
        });
    }
    return respond(route, wantsObject ? (rows[0] || null) : rows);
};

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const preview = spawn(path.join(appDir, 'node_modules/.bin/vite'), ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'],
});
const waitForServer = async () => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try { if ((await fetch(baseUrl)).ok) return; } catch { /* not ready */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('vite preview did not start');
};

let passed = 0;
const pass = (message) => { passed += 1; console.log(`PASS  ${message}`); };
let browser;
try {
    await waitForServer();
    browser = await chromium.launch(existsSync(chromePath) ? { executablePath: chromePath } : {});

    const openAs = async (role) => {
        const log = [];
        const pageErrors = [];
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: sessionFor(role).session });
        await context.route('**/*', makeHandler(role, log));
        const page = await context.newPage();
        page.on('pageerror', (error) => pageErrors.push(error.message));
        return { context, page, log, pageErrors };
    };
    const tableReads = (log, table) => log.filter((r) => r.path === `/rest/v1/${table}` && ['GET', 'HEAD'].includes(r.method));
    // 讀自己那列（AuthContext 顯示名稱／頭貼）是 RLS 允許的；這裡只抓「讀別人」的查詢
    const othersInstructorReads = (log, selfId) => tableReads(log, 'instructors')
        .filter((r) => !decodeURIComponent(r.query).includes(`user_id=eq.${selfId}`));
    const rpcCalls = (log) => log.filter((r) => r.path === '/rest/v1/rpc/mentor_instructor_directory');
    const settle = (page) => page.waitForLoadState('networkidle');

    // ══════════ mentor ══════════
    const m = await openAs('mentor');
    for (const [target, heading] of [['/admin/download-center', '講師表單預覽與下載'], ['/admin/salary', '報酬登記中心']]) {
        await m.page.goto(`${baseUrl}${target}`, { waitUntil: 'networkidle' });
        await m.page.waitForURL(`${baseUrl}/`);
        assert.equal(await m.page.getByRole('heading', { name: heading }).count(), 0, `${target} heading still rendered for mentor`);
    }
    assert.equal(othersInstructorReads(m.log, IDS.mentor).length, 0, 'redirected pages read other instructors');
    pass('mentor 直接網址進 /admin/download-center、/admin/salary 都被導回首頁，頁面沒渲染、也沒讀別人的 instructors');

    m.log.length = 0;
    await m.page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
    await m.page.getByRole('heading', { name: '後台管理總覽' }).waitFor();
    assert.equal(await m.page.locator('a[href="/admin/salary"]').count(), 0, 'mentor dashboard still links to /admin/salary');
    assert.equal(await m.page.locator('a[href="/admin/download-center"]').count(), 0, 'mentor dashboard still links to /admin/download-center');
    assert.equal(await m.page.locator('a[href="/admin/instructors"]').filter({ hasText: '查看講師名冊（姓名、等級、狀態）' }).count(), 1);
    const statCard = m.page.locator('div').filter({ hasText: /^2講師主檔$/ });
    assert.ok(await statCard.count() >= 1, 'mentor dashboard instructor count is not 2');
    assert.equal(othersInstructorReads(m.log, IDS.mentor).length, 0, 'mentor dashboard reads the instructors table');
    assert.equal(rpcCalls(m.log).length, 1, 'mentor dashboard did not call mentor_instructor_directory once');
    pass('mentor 後台首頁：沒有報酬登記中心／表單下載入口；講師主檔人數 2 來自名冊函式，沒直接讀別人的 instructors 列');

    m.log.length = 0;
    await m.page.goto(`${baseUrl}/admin/instructors`, { waitUntil: 'networkidle' });
    await m.page.getByRole('heading', { name: '講師資料總覽' }).waitFor();
    // 1280px 顯示桌機表格（手機卡片在 DOM 但隱藏）
    await m.page.locator('tbody tr').filter({ hasText: '王小明' }).first().waitFor();
    assert.equal(await m.page.locator('tbody tr').filter({ hasText: '李小華' }).count(), 1);
    assert.equal(await m.page.getByText('講師資料自動填表').count(), 0, 'form panel visible to mentor');
    assert.equal(await m.page.getByRole('button', { name: /預覽/ }).count(), 0, 'preview button visible to mentor');
    assert.equal(await m.page.getByRole('link', { name: /編輯/ }).count(), 0, 'edit link visible to mentor');
    assert.equal(await m.page.locator('th', { hasText: '文件' }).count(), 0, 'documents column visible to mentor');
    assert.equal(await m.page.locator('th', { hasText: '操作' }).count(), 0, 'actions column visible to mentor');
    await m.page.locator('tr').filter({ hasText: '王小明' }).first().click();
    await settle(m.page);
    assert.equal(await m.page.getByText('身分證字號').count(), 0, 'expanded details opened for mentor');
    const mentorHtml = await m.page.content();
    for (const secret of SENSITIVE) assert.ok(!mentorHtml.includes(secret), `mentor instructor list leaks ${secret}`);
    assert.equal(othersInstructorReads(m.log, IDS.mentor).length, 0, 'mentor instructor list reads the instructors table');
    assert.equal(tableReads(m.log, 'contract_documents').length, 0, 'mentor instructor list loads form templates');
    assert.equal(m.log.filter((r) => r.path.startsWith('/storage/v1/')).length, 0, 'mentor instructor list touches storage');
    assert.equal(rpcCalls(m.log).length, 1);
    await m.page.screenshot({ path: path.join(shotDir, 'mentor-instructors-1280.png'), fullPage: true });
    pass('mentor 講師資料總覽：只顯示名冊（2 位），沒有自動填表、預覽、編輯、文件／操作欄，點列不展開；畫面無身分證／帳號／電話／Email／地址；只呼叫名冊函式、沒直接讀別人的主檔列／表單模板／證件檔');

    m.log.length = 0;
    await m.page.goto(`${baseUrl}/admin/assignments`, { waitUntil: 'networkidle' });
    await m.page.getByRole('heading', { name: '作業審核中心' }).waitFor();
    await m.page.getByText('小明（王小明）').first().waitFor();
    const assignmentRpc = rpcCalls(m.log).map((r) => JSON.parse(r.body || '{}').p_user_ids);
    assert.ok(assignmentRpc.some((ids) => ids?.length === 1 && ids[0] === IDS.t1), `no directory call for the assignment author: ${JSON.stringify(assignmentRpc)}`);
    assert.ok(assignmentRpc.some((ids) => ids?.length === 1 && ids[0] === IDS.t2), `no directory call for the feedback author: ${JSON.stringify(assignmentRpc)}`);
    assert.equal(othersInstructorReads(m.log, IDS.mentor).length, 0, 'mentor assignment review reads the instructors table');
    pass('mentor 作業審核中心：學員名稱「小明（王小明）」由名冊函式取得（作業作者、回饋作者各呼叫一次），沒直接讀別人的 instructors 列');

    m.log.length = 0;
    await m.page.goto(`${baseUrl}/courses/${COURSE_ID}/lessons/${LESSON_ID}`, { waitUntil: 'networkidle' });
    await m.page.getByText('留言內容').first().waitFor();
    await m.page.getByText('小明（王小明）').first().waitFor();
    const lessonRpc = rpcCalls(m.log).map((r) => JSON.parse(r.body || '{}').p_user_ids);
    assert.ok(lessonRpc.some((ids) => ids?.length === 1 && ids[0] === IDS.t1), `no directory call for the comment author: ${JSON.stringify(lessonRpc)}`);
    assert.equal(othersInstructorReads(m.log, IDS.mentor).length, 0, 'mentor lesson page reads other instructors from the table');
    pass('mentor 章節頁：留言者「小明（王小明）」由名冊函式取得，沒有用 instructors 表查別人');
    assert.deepEqual(m.pageErrors, [], `mentor page errors: ${m.pageErrors.join(' | ')}`);
    pass('mentor 走完 5 個頁面沒有未捕捉的前端例外');
    await m.context.close();

    // ══════════ admin（回歸） ══════════
    const a = await openAs('admin');
    await a.page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
    await a.page.getByRole('heading', { name: '後台管理總覽' }).waitFor();
    assert.equal(await a.page.locator('a[href="/admin/salary"]').count(), 1);
    assert.equal(await a.page.locator('a[href="/admin/download-center"]').count(), 1);
    assert.ok(await a.page.locator('div').filter({ hasText: /^2講師主檔$/ }).count() >= 1, 'admin dashboard instructor count is not 2');
    assert.equal(rpcCalls(a.log).length, 0, 'admin dashboard calls the directory function');
    pass('admin 後台首頁：報酬登記中心、表單下載入口都在；講師主檔人數 2 照舊直接計數');

    a.log.length = 0;
    await a.page.goto(`${baseUrl}/admin/instructors`, { waitUntil: 'networkidle' });
    await a.page.getByText('講師資料自動填表').waitFor();
    assert.ok(await a.page.getByRole('button', { name: '預覽表單' }).count() >= 2, 'admin lost preview buttons');
    assert.equal(await a.page.locator('th', { hasText: '文件' }).count(), 1);
    assert.equal(await a.page.locator('th', { hasText: '操作' }).count(), 1);
    await a.page.getByRole('button', { name: '展開講師資料' }).first().click();
    await a.page.locator('tbody').getByText('身分證字號').first().waitFor();
    assert.ok(tableReads(a.log, 'instructors').some((r) => r.query.includes('select=*')), 'admin list no longer reads the full instructors row');
    assert.equal(rpcCalls(a.log).length, 0);
    await a.page.screenshot({ path: path.join(shotDir, 'admin-instructors-1280.png'), fullPage: true });
    pass('admin 講師資料總覽：自動填表、預覽表單、文件／操作欄、展開明細照舊，資料直接讀 instructors 表');

    for (const [target, heading] of [['/admin/download-center', '講師表單預覽與下載'], ['/admin/salary', '報酬登記中心']]) {
        await a.page.goto(`${baseUrl}${target}`, { waitUntil: 'networkidle' });
        await a.page.getByRole('heading', { name: heading }).waitFor();
        assert.equal(new URL(a.page.url()).pathname, target);
    }
    pass('admin 進得了 /admin/download-center 與 /admin/salary');
    assert.deepEqual(a.pageErrors, [], `admin page errors: ${a.pageErrors.join(' | ')}`);
    await a.context.close();

    console.log(`\n${passed}/${passed} PASS  screenshots: ${shotDir}`);
} finally {
    await browser?.close();
    preview.kill('SIGTERM');
}
