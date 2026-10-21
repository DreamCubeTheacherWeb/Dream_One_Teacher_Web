#!/usr/bin/env node
/*
 * 後台講師編輯頁「講師自行修改權限」「修改紀錄」瀏覽器回歸測試。
 * 全程用 Playwright 攔截 *.supabase.co（auth／rest／rpc／storage），以記憶體假資料回應，不連正式 Supabase。
 *
 * 測項：
 *  a. 三項有資料且無開放 → 鎖定中；開放（confirm、RPC 參數、防連點）→ 已開放；收回 → 鎖定中；RPC 失敗用 alert
 *  b. 只有匯入雲端連結（path 為 null）也算已有資料 → 鎖定中；沒資料的項目不顯示按鈕
 *  c. 未認領講師 → 開放按鈕停用並顯示說明
 *  d. 修改紀錄：講師用開放權限、管理員改匯款（帳號遮罩）、系統匯入首次提交、舊雲端連結；舊檔／新檔簽 300 秒連結
 *  e. 管理員替換／移除身分證、存摺不刪舊檔；替換大頭照仍刪舊檔；存檔後重新載入修改紀錄
 *  f. 新資料表回 PGRST205 → 頁面照常載入，新區塊提示先套用資料庫更新且按鈕停用；其他錯誤顯示讀取失敗
 *  g. 390px 無水平捲動、新按鈕高度 >= 44px；桌機／手機截圖
 *
 * 用法（在 培訓web/ 下）：node scripts/verify-doc-edit-unlock-admin-browser.mjs [--skip-build]
 *   --skip-build：沿用上一次 build 好的 dist-admin-unlock（只改測試腳本時加快）
 * 自己 build 到 dist-admin-unlock、自己起 vite preview（埠 4300-4399 擇空閒者），結束時只殺自己的 PID。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const viteBin = path.join(appDir, 'node_modules/vite/bin/vite.js');
const outDirName = 'dist-admin-unlock';
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-doc-edit-unlock');
const skipBuild = process.argv.includes('--skip-build');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;

const NOW = new Date().toISOString();
const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_ADMIN_ID = '00000000-0000-4000-8000-000000000009';
const TEACHER_USER_ID = '00000000-0000-4000-8000-000000000002';
const INSTRUCTOR_ID = '10000000-0000-4000-8000-000000000001';
const GRANTED_AT = '2026-10-20T03:30:00.000Z'; // Asia/Taipei 2026/10/20 11:30
// 開放 72 小時後過期；測試用固定的遠未來，避免測試本身過了某天就失效。
const ACTIVE_EXPIRES_AT = '2099-12-31T15:59:00.000Z'; // Asia/Taipei 2099/12/31 23:59
const EXPIRED_AT = '2020-01-01T00:00:00.000Z';
const SCOPES = ['id_card', 'bankbook', 'bank_account'];
const SCOPE_LABELS = { id_card: '身分證正反面', bankbook: '存摺封面', bank_account: '匯款銀行資訊' };
const MIGRATION_NOTICE = '此功能需先套用資料庫更新（20261020120000）';
const UNCLAIMED_NOTICE = '講師尚未認領帳號，無法自行修改；請直接在上方替講師更新。';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const USER_DIRECTORY = {
    [ADMIN_ID]: '測試管理員',
    [OTHER_ADMIN_ID]: '王管理員',
};

// ───────────────────────── 小工具 ─────────────────────────
const results = [];
const check = async (name, fn) => {
    try {
        await fn();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (error) {
        results.push({ name, pass: false });
        console.log(`FAIL  ${name}  — ${String(error?.message || error).split('\n')[0]}`);
    }
};
const ok = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}：期望 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`);
    }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (fn, message, timeout = 8000) => {
    const start = Date.now();
    let last;
    for (;;) {
        try {
            const value = await fn();
            if (value) return value;
        } catch (error) { last = error; }
        if (Date.now() - start > timeout) throw new Error(`逾時：${message}${last ? `（${last.message}）` : ''}`);
        await sleep(60);
    }
};
const textOf = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
const waitForText = (locator, expected, label) => waitUntil(
    async () => (await textOf(locator)) === expected,
    `${label} 應為「${expected}」`,
);

// ───────────────────────── 假資料 ─────────────────────────
const docFields = (key, name) => ({
    [`${key}_path`]: `instructors/${TEACHER_USER_ID}/${key}/${name}.png`,
    [`${key}_mime`]: 'image/png',
    [`${key}_size`]: PIXEL.length,
    [`${key}_uploaded_at`]: '2026-09-01T00:00:00.000Z',
});

const makeInstructor = (overrides = {}) => ({
    id: INSTRUCTOR_ID,
    user_id: TEACHER_USER_ID,
    full_name: '林測試',
    nickname: '測試老師',
    email_primary: 'teacher@example.com',
    phone_mobile: '0912345678',
    employment_status: 'active',
    instructor_role: 'A',
    teaching_regions: ['臺北市'],
    bank_account_name: '林測試',
    bank_name: '華南銀行',
    bank_branch: '總行',
    bank_code: '0080000',
    bank_account_number: '1234567890',
    hide_from_leaderboard: false,
    created_at: NOW,
    updated_at: NOW,
    ...docFields('photo', 'old-photo'),
    ...docFields('id_front', 'old-front'),
    ...docFields('id_back', 'old-back'),
    ...docFields('bankbook', 'old-bankbook'),
    ...overrides,
});

const sampleChanges = () => [
    {
        id: 4, item: 'id_front', changed_at: '2026-10-20T05:00:00.000Z', changed_by: TEACHER_USER_ID,
        changed_by_role: 'instructor', unlock_id: '50000000-0000-4000-8000-000000000001',
        old_value: { path: 'instructors/u1/id_front/old-a.png', mime: 'image/png', size: 68, uploaded_at: '2026-09-01T00:00:00Z' },
        new_value: { path: 'instructors/u1/id_front/new-a.png', mime: 'image/png', size: 70, uploaded_at: '2026-10-20T05:00:00Z' },
    },
    {
        id: 3, item: 'bank_account', changed_at: '2026-10-19T08:00:00.000Z', changed_by: OTHER_ADMIN_ID,
        changed_by_role: 'admin', unlock_id: null,
        old_value: { bank_account_name: '林測試', bank_name: '華南銀行', bank_branch: '總行', bank_code: '0080000', bank_account_number: '1234567890' },
        new_value: { bank_account_name: '林測試', bank_name: '華南銀行', bank_branch: '總行', bank_code: '0080000', bank_account_number: '9876543210987' },
    },
    {
        id: 2, item: 'bankbook', changed_at: '2026-10-19T02:00:00.000Z', changed_by: TEACHER_USER_ID,
        changed_by_role: 'instructor', unlock_id: null,
        old_value: { external_url: 'https://drive.google.com/file/d/old-bankbook/view' },
        new_value: { path: 'instructors/u1/bankbook/new-b.png', mime: 'image/png', size: 70 },
    },
    {
        id: 1, item: 'id_back', changed_at: '2026-10-18T02:00:00.000Z', changed_by: null,
        changed_by_role: 'system', unlock_id: null,
        old_value: {},
        new_value: { path: 'instructors/u1/id_back/first-back.png', mime: 'image/png', size: 70 },
    },
];

const makeState = (overrides = {}) => ({
    instructor: makeInstructor(),
    unlocks: [],
    changes: [],
    unlocksFailure: null, // { status, body }：整個 instructor_edit_unlocks 查詢回錯誤
    changesFailure: null,
    rpcDelayMs: 0,
    rpcFailure: null,
    rpcCalls: [],
    storageDeletes: [],
    uploads: [],
    signCalls: [],
    patches: [],
    userLookups: [],
    getCount: { unlocks: 0, changes: 0 },
    nextChangeId: 100,
    ...overrides,
});

const missingTableFailure = (table) => ({
    status: 404,
    body: { code: 'PGRST205', details: null, hint: null, message: `Could not find the table 'public.${table}' in the schema cache` },
});

// ───────────────────────── 假 Supabase ─────────────────────────
const makeSession = () => {
    const user = {
        id: ADMIN_ID, aud: 'authenticated', role: 'authenticated', email: 'admin@example.com',
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { full_name: USER_DIRECTORY[ADMIN_ID] },
        created_at: NOW, updated_at: NOW,
    };
    return {
        user,
        session: {
            access_token: 'mock.admin.token', refresh_token: 'mock.admin.refresh', token_type: 'bearer',
            expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user,
        },
        profile: { id: ADMIN_ID, name: USER_DIRECTORY[ADMIN_ID], email: user.email, role: 'admin', created_at: NOW },
    };
};

const respond = (route, body, status = 200) => {
    const headers = { 'content-type': 'application/json' };
    if (Array.isArray(body)) headers['content-range'] = body.length ? `0-${body.length - 1}/${body.length}` : '*/0';
    return route.fulfill({ status, headers, body: JSON.stringify(body) });
};

const normalizePath = (value) => (typeof value === 'string' && value.trim() ? value : null);

// 模擬 DB trigger：管理員改身分證／存摺檔案時，instructor_document_changes 多一筆紀錄。
const recordAdminDocumentChanges = (state, before, payload) => {
    for (const key of ['id_front', 'id_back', 'bankbook']) {
        const oldPath = normalizePath(before[`${key}_path`]);
        const newPath = normalizePath(payload[`${key}_path`]);
        if (oldPath === newPath) continue;
        state.changes.unshift({
            id: state.nextChangeId += 1,
            item: key,
            changed_at: new Date().toISOString(),
            changed_by: ADMIN_ID,
            changed_by_role: 'admin',
            unlock_id: null,
            old_value: oldPath ? { path: oldPath, mime: before[`${key}_mime`] } : {},
            new_value: newPath ? { path: newPath, mime: payload[`${key}_mime`] } : {},
        });
    }
};

const makeHandler = (state, baseUrl, authBundle) => async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseUrl) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, body: '' });

    const { pathname } = url;
    if (pathname.startsWith('/auth/v1/')) {
        if (pathname === '/auth/v1/user') return respond(route, authBundle.user);
        if (pathname.startsWith('/auth/v1/token')) return respond(route, authBundle.session);
        return respond(route, {});
    }

    if (pathname.startsWith('/storage/v1/')) {
        const signPrefix = '/storage/v1/object/sign/instructor_uploads/';
        if (pathname.startsWith(signPrefix)) {
            const filePath = decodeURIComponent(pathname.slice(signPrefix.length));
            const body = request.postDataJSON?.() || {};
            state.signCalls.push({ path: filePath, expiresIn: body.expiresIn });
            return respond(route, { signedURL: `/object/public/mock-pixel/${filePath}` });
        }
        if (pathname.startsWith('/storage/v1/object/public/mock-pixel/')) {
            return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
        }
        if (method === 'DELETE') {
            state.storageDeletes.push({ pathname, prefixes: request.postDataJSON()?.prefixes || [] });
            return respond(route, []);
        }
        if (method === 'POST') {
            state.uploads.push({ pathname: decodeURIComponent(pathname) });
            return respond(route, { Key: 'mock-upload' });
        }
        return respond(route, {}, 404);
    }

    if (pathname.startsWith('/rest/v1/rpc/')) {
        const fn = pathname.slice('/rest/v1/rpc/'.length);
        if (fn === 'claim_my_precreated_instructor') return respond(route, { status: 'staff' });
        if (fn === 'admin_grant_instructor_edit_unlock' || fn === 'admin_revoke_instructor_edit_unlock') {
            const body = request.postDataJSON() || {};
            state.rpcCalls.push({ fn, body });
            if (state.rpcDelayMs) await sleep(state.rpcDelayMs);
            if (state.rpcFailure) return respond(route, state.rpcFailure.body, state.rpcFailure.status);
            if (fn === 'admin_grant_instructor_edit_unlock') {
                let row = state.unlocks.find((item) => item.instructor_id === body.p_instructor_id
                    && item.scope === body.p_scope && !item.consumed_at && !item.revoked_at);
                if (!row) {
                    row = {
                        id: `50000000-0000-4000-8000-${String(state.unlocks.length + 10).padStart(12, '0')}`,
                        instructor_id: body.p_instructor_id, scope: body.p_scope, granted_by: ADMIN_ID,
                        granted_at: GRANTED_AT, expires_at: ACTIVE_EXPIRES_AT,
                        consumed_at: null, consumed_by: null, revoked_at: null, revoked_by: null,
                    };
                    state.unlocks.push(row);
                }
                return respond(route, row);
            }
            const row = state.unlocks.find((item) => item.id === body.p_unlock_id);
            if (row && !row.consumed_at && !row.revoked_at) {
                row.revoked_at = new Date().toISOString();
                row.revoked_by = ADMIN_ID;
            }
            return respond(route, row || null);
        }
        return respond(route, null);
    }

    if (!pathname.startsWith('/rest/v1/')) return respond(route, {}, 404);
    const table = pathname.replace('/rest/v1/', '').split('/')[0];
    const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');

    if (table === 'instructors' && method === 'PATCH') {
        const payload = request.postDataJSON();
        const before = state.instructor;
        state.patches.push(payload);
        recordAdminDocumentChanges(state, before, payload);
        state.instructor = { ...before, ...payload, updated_at: new Date().toISOString() };
        return respond(route, wantsObject ? state.instructor : [state.instructor]);
    }
    if (method !== 'GET') return route.fulfill({ status: 204, body: '' });

    if (table === 'instructor_edit_unlocks') {
        state.getCount.unlocks += 1;
        if (state.unlocksFailure) return respond(route, state.unlocksFailure.body, state.unlocksFailure.status);
        state.unlockQueries = [...(state.unlockQueries || []), Object.fromEntries(url.searchParams)];
        const expiresFilter = url.searchParams.get('expires_at') || '';
        const notAfter = expiresFilter.startsWith('gt.') ? expiresFilter.slice(3) : null;
        const rows = state.unlocks
            .filter((item) => !item.consumed_at && !item.revoked_at)
            .filter((item) => !notAfter || new Date(item.expires_at ?? ACTIVE_EXPIRES_AT) > new Date(notAfter))
            .map(({ id, scope, granted_at: grantedAt, expires_at: expiresAt }) => ({
                id, scope, granted_at: grantedAt, expires_at: expiresAt ?? ACTIVE_EXPIRES_AT,
            }));
        return respond(route, rows);
    }
    if (table === 'instructor_document_changes') {
        state.getCount.changes += 1;
        if (state.changesFailure) return respond(route, state.changesFailure.body, state.changesFailure.status);
        return respond(route, state.changes.slice(0, Number(url.searchParams.get('limit')) || 50));
    }
    if (table === 'users') {
        const idFilter = url.searchParams.get('id') || '';
        if (idFilter.startsWith('in.(')) {
            const ids = idFilter.slice(4, -1).split(',');
            state.userLookups.push(ids);
            return respond(route, ids.filter((id) => USER_DIRECTORY[id]).map((id) => ({ id, name: USER_DIRECTORY[id] })));
        }
        return respond(route, wantsObject ? authBundle.profile : [authBundle.profile]);
    }
    if (table === 'instructors') {
        const idFilter = url.searchParams.get('id');
        const userFilter = url.searchParams.get('user_id');
        let rows;
        if (idFilter) rows = idFilter === `eq.${state.instructor.id}` ? [state.instructor] : [];
        else if (userFilter) rows = userFilter === `eq.${state.instructor.user_id}` ? [state.instructor] : [];
        else rows = [state.instructor];
        return respond(route, wantsObject ? (rows[0] || null) : rows);
    }
    return respond(route, wantsObject ? null : []);
};

// ───────────────────────── 起 build、preview、瀏覽器 ─────────────────────────
const findFreePort = async () => {
    for (let port = 4371; port <= 4399; port += 1) {
        const free = await new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => server.close(() => resolve(true)));
            server.listen(port, '127.0.0.1');
        });
        if (free) return port;
    }
    for (let port = 4300; port < 4371; port += 1) {
        const free = await new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => server.close(() => resolve(true)));
            server.listen(port, '127.0.0.1');
        });
        if (free) return port;
    }
    throw new Error('4300-4399 沒有空閒埠');
};

const waitForServer = async (baseUrl) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
            const response = await fetch(baseUrl);
            if (response.ok) return;
        } catch { /* preview 還沒起來 */ }
        await sleep(250);
    }
    throw new Error('vite preview 啟動逾時');
};

const openAdminPage = async (browser, baseUrl, state, { width = 1280, height = 900 } = {}) => {
    const authBundle = makeSession();
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Asia/Taipei', locale: 'zh-TW' });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: authBundle.session });
    await context.route('**/*', makeHandler(state, baseUrl, authBundle));
    const page = await context.newPage();
    const ctl = { dialogs: [], confirm: 'accept', pageErrors: [] };
    page.on('dialog', async (dialog) => {
        ctl.dialogs.push({ type: dialog.type(), message: dialog.message() });
        if (dialog.type() === 'confirm' && ctl.confirm === 'dismiss') await dialog.dismiss();
        else await dialog.accept();
    });
    page.on('pageerror', (error) => ctl.pageErrors.push(error.message));
    await page.goto(`${baseUrl}/admin/instructors/${state.instructor.id}/edit`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '編輯講師資料' }).waitFor({ timeout: 20000 });
    await waitUntil(
        () => page.evaluate(() => !/讀取(開放狀態|修改紀錄)中/.test(document.body.innerText)),
        '開放狀態與修改紀錄載入完成',
        15000,
    );
    return { context, page, ctl };
};

const unlockRow = (page, scope) => page.getByTestId(`unlock-row-${scope}`);
const unlockStatus = (page, scope) => page.getByTestId(`unlock-status-${scope}`);
const waitForButtonCount = (locator, expected, label) => waitUntil(
    async () => (await locator.count()) === expected,
    `${label} 應有 ${expected} 顆`,
);
const grantButton = (page, scope) => unlockRow(page, scope).getByRole('button', { name: '開放修改一次', exact: true });
const revokeButton = (page, scope) => unlockRow(page, scope).getByRole('button', { name: '收回開放', exact: true });
const saveAndWait = async (page) => {
    await page.getByTestId('save-instructor').click();
    await page.getByText('講師資料已更新。', { exact: true }).waitFor({ timeout: 10000 });
};

// ───────────────────────── 主流程 ─────────────────────────
let preview;
let browser;
try {
    if (skipBuild) {
        ok(existsSync(path.join(appDir, outDirName, 'index.html')), `--skip-build 但 ${outDirName} 不存在`);
        console.log(`略過 build，沿用 ${outDirName}`);
    } else {
        console.log(`build 到 ${outDirName} ⋯`);
        const build = spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDirName, '--emptyOutDir'], {
            cwd: appDir, encoding: 'utf8',
        });
        if (build.status !== 0) {
            console.log((build.stdout || '').split('\n').slice(-20).join('\n'));
            console.log((build.stderr || '').split('\n').slice(-20).join('\n'));
            throw new Error('vite build 失敗');
        }
    }

    const port = await findFreePort();
    const baseUrl = `http://localhost:${port}`;
    preview = spawn(process.execPath, [viteBin, 'preview', '--outDir', outDirName, '--port', String(port), '--strictPort'], {
        cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`preview pid=${preview.pid} port=${port}`);
    await waitForServer(baseUrl);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });

    // ── a. 開放／收回主流程 ──
    {
        const state = makeState({ rpcDelayMs: 400 });
        const { context, page, ctl } = await openAdminPage(browser, baseUrl, state);
        await check('a1 三項都有資料、無開放 → 三列皆「鎖定中」且有「開放修改一次」', async () => {
            for (const scope of SCOPES) {
                equal(await textOf(unlockStatus(page, scope)), '鎖定中', `${scope} 狀態`);
                equal(await grantButton(page, scope).count(), 1, `${scope} 開放按鈕數`);
                ok(await grantButton(page, scope).isEnabled(), `${scope} 開放按鈕應可按`);
                equal(await revokeButton(page, scope).count(), 0, `${scope} 收回按鈕數`);
            }
        });
        await check('a2 沒有任何紀錄時顯示「尚無修改紀錄」', async () => {
            ok((await textOf(page.locator('main, body').first())).includes('尚無修改紀錄'), '找不到「尚無修改紀錄」');
        });
        await check('a3 confirm 按取消 → 不送 RPC', async () => {
            ctl.confirm = 'dismiss';
            ctl.dialogs.length = 0;
            await grantButton(page, 'bankbook').click();
            await waitUntil(() => ctl.dialogs.length === 1, '應跳出一個 confirm');
            equal(ctl.dialogs[0].message, '開放「存摺封面」讓講師自行修改一次？講師存檔後會自動鎖回。', 'confirm 文字');
            await sleep(500);
            equal(state.rpcCalls.length, 0, 'RPC 次數');
            equal(await textOf(unlockStatus(page, 'bankbook')), '鎖定中', '存摺列狀態');
            ctl.confirm = 'accept';
        });
        const countsBeforeGrant = { ...state.getCount };
        await check('a4 身分證「開放修改一次」連點兩下 → confirm 文字正確、只送一次 grant RPC、參數正確', async () => {
            ctl.dialogs.length = 0;
            await grantButton(page, 'id_card').dblclick();
            await waitUntil(() => state.rpcCalls.length >= 1, '應送出 grant RPC');
            await sleep(900);
            equal(state.rpcCalls.length, 1, 'RPC 次數（防連點）');
            equal(state.rpcCalls[0], { fn: 'admin_grant_instructor_edit_unlock', body: { p_instructor_id: INSTRUCTOR_ID, p_scope: 'id_card' } }, 'RPC 內容');
            const confirms = ctl.dialogs.filter((dialog) => dialog.type === 'confirm');
            equal(confirms.length, 1, 'confirm 次數');
            equal(confirms[0].message, '開放「身分證正反面」讓講師自行修改一次？講師存檔後會自動鎖回。', 'confirm 文字');
        });
        await check('a5 該列變「已開放修改一次」＋開放時間＋「收回開放」；其餘仍鎖定；已重新載入開放狀態與紀錄', async () => {
            await waitForText(unlockStatus(page, 'id_card'), '已開放修改一次', '身分證列狀態');
            equal(await textOf(page.getByTestId('unlock-desc-id_card')), '開放時間 2026/10/20 11:30，2099/12/31 23:59 前有效，講師存檔後自動鎖回', '說明文字');
            await waitForButtonCount(revokeButton(page, 'id_card'), 1, '身分證列「收回開放」');
            equal(await grantButton(page, 'id_card').count(), 0, '開放按鈕數');
            equal(await textOf(unlockStatus(page, 'bankbook')), '鎖定中', '存摺列');
            equal(await textOf(unlockStatus(page, 'bank_account')), '鎖定中', '匯款列');
            ok(state.getCount.unlocks > countsBeforeGrant.unlocks, '應重新讀取開放狀態');
            ok(state.getCount.changes > countsBeforeGrant.changes, '應重新讀取修改紀錄');
        });
        await check('a6 按「收回開放」→ revoke RPC 參數正確 → 回到鎖定中', async () => {
            const unlockId = state.unlocks[0].id;
            await waitUntil(() => revokeButton(page, 'id_card').isEnabled(), '收回按鈕應可按');
            await revokeButton(page, 'id_card').click();
            await waitUntil(() => state.rpcCalls.length >= 2, '應送出 revoke RPC');
            equal(state.rpcCalls[1], { fn: 'admin_revoke_instructor_edit_unlock', body: { p_unlock_id: unlockId } }, 'RPC 內容');
            await waitForText(unlockStatus(page, 'id_card'), '鎖定中', '身分證列狀態');
            await waitForButtonCount(grantButton(page, 'id_card'), 1, '身分證列「開放修改一次」');
        });
        await check('a7 RPC 失敗 → 以 alert 顯示錯誤訊息，列維持鎖定中且按鈕恢復可按', async () => {
            state.rpcFailure = { status: 403, body: { code: '42501', message: 'permission denied: admin only', details: null, hint: null } };
            ctl.dialogs.length = 0;
            await grantButton(page, 'bank_account').click();
            await waitUntil(() => ctl.dialogs.some((dialog) => dialog.type === 'alert'), '應跳出 alert');
            const alertMessage = ctl.dialogs.find((dialog) => dialog.type === 'alert').message;
            ok(alertMessage.includes('permission denied: admin only'), `alert 內容不含錯誤訊息：${alertMessage}`);
            equal(await textOf(unlockStatus(page, 'bank_account')), '鎖定中', '匯款列狀態');
            await waitUntil(
                async () => (await grantButton(page, 'bank_account').count()) === 1 && await grantButton(page, 'bank_account').isEnabled(),
                '按鈕應恢復可按',
            );
            state.rpcFailure = null;
        });
        await check('a8 整個流程沒有未捕捉的頁面錯誤', async () => {
            equal(ctl.pageErrors, [], 'pageerror');
        });
        await context.close();
    }

    // ── b. 只有匯入雲端連結也算已有資料 ──
    {
        const state = makeState({
            instructor: makeInstructor({
                id_front_path: null, id_front_mime: null, id_front_size: null, id_front_uploaded_at: null,
                id_front_external_url: 'https://drive.google.com/file/d/imported-front/view',
                id_back_path: null, id_back_mime: null, id_back_size: null, id_back_uploaded_at: null,
                bankbook_path: null, bankbook_mime: null, bankbook_size: null, bankbook_uploaded_at: null,
                bankbook_external_url: 'https://drive.google.com/file/d/imported-bankbook/view',
                bank_account_name: null, bank_name: null, bank_branch: null, bank_code: null, bank_account_number: null,
            }),
        });
        const { context, page } = await openAdminPage(browser, baseUrl, state);
        await check('b1 身分證只有匯入的雲端連結（path 為 null）→ 鎖定中且有開放按鈕', async () => {
            equal(await textOf(unlockStatus(page, 'id_card')), '鎖定中', '身分證列');
            equal(await grantButton(page, 'id_card').count(), 1, '開放按鈕數');
        });
        await check('b2 存摺只有匯入的雲端連結 → 鎖定中且有開放按鈕', async () => {
            equal(await textOf(unlockStatus(page, 'bankbook')), '鎖定中', '存摺列');
            equal(await grantButton(page, 'bankbook').count(), 1, '開放按鈕數');
        });
        await check('b3 匯款沒有帳號 → 顯示「講師尚未提交，可自行填寫」且沒有任何按鈕', async () => {
            equal(await textOf(unlockStatus(page, 'bank_account')), '尚未提交', '匯款列');
            equal(await textOf(page.getByTestId('unlock-desc-bank_account')), '講師尚未提交，可自行填寫', '說明文字');
            equal(await unlockRow(page, 'bank_account').getByRole('button').count(), 0, '按鈕數');
        });
        await context.close();
    }

    // ── c. 未認領講師 ──
    {
        const state = makeState({ instructor: makeInstructor({ user_id: null }) });
        const { context, page, ctl } = await openAdminPage(browser, baseUrl, state);
        await check('c1 未認領講師（user_id 為 null）→ 三顆開放按鈕全部停用', async () => {
            for (const scope of SCOPES) {
                equal(await grantButton(page, scope).count(), 1, `${scope} 開放按鈕數`);
                ok(await grantButton(page, scope).isDisabled(), `${scope} 開放按鈕應停用`);
            }
        });
        await check('c2 每列顯示「講師尚未認領帳號，無法自行修改；請直接在上方替講師更新。」', async () => {
            for (const scope of SCOPES) {
                equal(await textOf(page.getByTestId(`unlock-desc-${scope}`)), UNCLAIMED_NOTICE, `${scope} 說明`);
            }
        });
        await check('c3 硬點停用的按鈕 → 沒有 confirm、沒有 RPC', async () => {
            await grantButton(page, 'id_card').click({ force: true });
            await sleep(500);
            equal(ctl.dialogs.length, 0, 'dialog 次數');
            equal(state.rpcCalls.length, 0, 'RPC 次數');
        });
        await context.close();
    }

    // ── d. 修改紀錄顯示 ──
    {
        const state = makeState({
            changes: sampleChanges(),
            unlocks: [{
                id: '50000000-0000-4000-8000-000000000098', instructor_id: INSTRUCTOR_ID, scope: 'bankbook', granted_by: ADMIN_ID,
                granted_at: GRANTED_AT, expires_at: ACTIVE_EXPIRES_AT,
                consumed_at: null, consumed_by: null, revoked_at: null, revoked_by: null,
            }],
        });
        const { context, page } = await openAdminPage(browser, baseUrl, state);
        const rows = page.getByTestId('change-row');
        await check('d1 修改紀錄 4 筆，依時間新到舊排列', async () => {
            equal(await rows.count(), 4, '紀錄筆數');
            const labels = [];
            for (let index = 0; index < 4; index += 1) labels.push((await textOf(rows.nth(index))).split(' ')[0]);
            equal(labels, ['身分證正面', '匯款銀行資訊', '存摺封面', '身分證反面'], '項目順序');
        });
        await check('d2 講師用開放權限換身分證正面：時間、講師本人、「使用開放權限」、舊檔／新檔按鈕', async () => {
            const text = await textOf(rows.nth(0));
            ok(text.includes('2026/10/20 13:00'), `時間不對：${text}`);
            ok(text.includes('講師本人'), `缺少「講師本人」：${text}`);
            ok(text.includes('使用開放權限'), `缺少「使用開放權限」：${text}`);
            equal(await rows.nth(0).getByRole('button', { name: '舊檔', exact: true }).count(), 1, '舊檔按鈕數');
            equal(await rows.nth(0).getByRole('button', { name: '新檔', exact: true }).count(), 1, '新檔按鈕數');
        });
        await check('d3 管理員改匯款：管理員姓名、帳號遮罩、只列有變的欄位、無「使用開放權限」', async () => {
            const text = await textOf(rows.nth(1));
            ok(text.includes('管理員 王管理員'), `缺少「管理員 王管理員」：${text}`);
            ok(text.includes('帳號：123••••890 → 987•••••••987'), `帳號遮罩不對：${text}`);
            ok(!text.includes('1234567890') && !text.includes('9876543210987'), `帳號不應顯示完整：${text}`);
            ok(!text.includes('戶名：') && !text.includes('銀行：'), `不應列出沒變的欄位：${text}`);
            ok(!text.includes('使用開放權限'), `不應出現「使用開放權限」：${text}`);
            ok(text.includes('2026/10/19 16:00'), `時間不對：${text}`);
        });
        await check('d4 系統匯入首次提交：顯示「系統匯入」「首次提交」、只有新檔、無舊檔', async () => {
            const text = await textOf(rows.nth(3));
            ok(text.includes('系統匯入'), `缺少「系統匯入」：${text}`);
            ok(text.includes('首次提交'), `缺少「首次提交」：${text}`);
            equal(await rows.nth(3).getByRole('button', { name: '舊檔', exact: true }).count(), 0, '舊檔按鈕數');
            equal(await rows.nth(3).getByRole('button', { name: '新檔', exact: true }).count(), 1, '新檔按鈕數');
        });
        await check('d5 舊值只有雲端連結 → 直接連結「舊雲端連結」，不是按鈕', async () => {
            const link = rows.nth(2).getByRole('link', { name: '舊雲端連結' });
            equal(await link.count(), 1, '連結數');
            equal(await link.getAttribute('href'), 'https://drive.google.com/file/d/old-bankbook/view', 'href');
            equal(await link.getAttribute('target'), '_blank', 'target');
            equal(await rows.nth(2).getByRole('button', { name: '舊檔', exact: true }).count(), 0, '舊檔按鈕數');
        });
        await check('d6 修改者名字來自 users 查詢，且只查管理員的 id', async () => {
            equal(state.userLookups, [[OTHER_ADMIN_ID]], 'users 查詢參數');
        });
        await check('d7 點「舊檔」「新檔」才簽 300 秒連結並開新分頁到該路徑', async () => {
            const before = state.signCalls.filter((call) => call.expiresIn === 300).length;
            equal(before, 0, '點之前不該簽 300 秒連結');
            const [oldPopup] = await Promise.all([
                page.waitForEvent('popup'),
                rows.nth(0).getByRole('button', { name: '舊檔', exact: true }).click(),
            ]);
            await oldPopup.waitForURL((popupUrl) => popupUrl.pathname.includes('mock-pixel'), { timeout: 8000 });
            ok(oldPopup.url().endsWith('instructors/u1/id_front/old-a.png'), `舊檔連結不對：${oldPopup.url()}`);
            await oldPopup.close();
            const [newPopup] = await Promise.all([
                page.waitForEvent('popup'),
                rows.nth(0).getByRole('button', { name: '新檔', exact: true }).click(),
            ]);
            await newPopup.waitForURL((popupUrl) => popupUrl.pathname.includes('mock-pixel'), { timeout: 8000 });
            ok(newPopup.url().endsWith('instructors/u1/id_front/new-a.png'), `新檔連結不對：${newPopup.url()}`);
            await newPopup.close();
            const signed = state.signCalls.filter((call) => call.expiresIn === 300);
            equal(signed.map((call) => call.path), ['instructors/u1/id_front/old-a.png', 'instructors/u1/id_front/new-a.png'], '簽署路徑');
        });
        await page.screenshot({ path: path.join(shotDir, 'admin-desktop.png'), fullPage: true }).catch(() => {});
        await context.close();
    }

    // ── e. 存檔不刪身分證／存摺舊檔 ──
    {
        const state = makeState();
        const { context, page } = await openAdminPage(browser, baseUrl, state);
        const oldFront = state.instructor.id_front_path;
        const oldPhoto = state.instructor.photo_path;
        const oldBack = state.instructor.id_back_path;
        const chooseFile = (key, name) => page.getByTestId(`document-editor-${key}`).locator('input[type=file]')
            .setInputFiles({ name, mimeType: 'image/png', buffer: PIXEL });
        await check('e1 管理員替換 id_front 並存檔 → 上傳新檔、更新路徑，且不對舊 id_front 發出 storage 刪除', async () => {
            await chooseFile('id_front', 'new-front.png');
            await saveAndWait(page);
            equal(state.uploads.length, 1, '上傳次數');
            equal(state.patches.length, 1, 'PATCH 次數');
            ok(state.patches[0].id_front_path && state.patches[0].id_front_path !== oldFront, 'id_front_path 應換成新路徑');
            equal(state.storageDeletes.length, 0, 'storage 刪除請求數');
        });
        await check('e2 存檔後重新載入修改紀錄：新增的管理員紀錄出現，且可點「舊檔」', async () => {
            const rows = page.getByTestId('change-row');
            await waitUntil(async () => (await rows.count()) === 1, '應出現 1 筆新紀錄');
            const text = await textOf(rows.nth(0));
            ok(text.includes('身分證正面') && text.includes('管理員 測試管理員'), `紀錄內容不對：${text}`);
            equal(await rows.nth(0).getByRole('button', { name: '舊檔', exact: true }).count(), 1, '舊檔按鈕數');
            ok(state.getCount.changes >= 2, '存檔後應重新讀取修改紀錄');
        });
        await check('e3 管理員替換 photo 並存檔 → 仍刪舊 photo（只刪 photo，不碰 id_front 舊檔）', async () => {
            await chooseFile('photo', 'new-photo.png');
            await saveAndWait(page);
            equal(state.storageDeletes.length, 1, 'storage 刪除請求數');
            equal(state.storageDeletes[0].prefixes, [oldPhoto], '刪除路徑');
            ok(!state.storageDeletes[0].prefixes.includes(oldFront), '不應刪除舊 id_front');
        });
        await check('e4 管理員移除 id_back 並存檔 → 路徑清空，但舊 id_back 不刪除', async () => {
            const deletesBefore = state.storageDeletes.length;
            await page.getByTestId('document-editor-id_back').getByRole('button', { name: '移除' }).click();
            await saveAndWait(page);
            const lastPatch = state.patches[state.patches.length - 1];
            equal(lastPatch.id_back_path, null, 'id_back_path');
            equal(state.storageDeletes.length, deletesBefore, 'storage 刪除請求數');
            ok(!state.storageDeletes.some((call) => call.prefixes.includes(oldBack)), '不應刪除舊 id_back');
        });
        await context.close();
    }

    // ── f. 新資料表尚未套用 / 其他錯誤 ──
    {
        const state = makeState({
            unlocksFailure: missingTableFailure('instructor_edit_unlocks'),
            changesFailure: missingTableFailure('instructor_document_changes'),
        });
        const { context, page, ctl } = await openAdminPage(browser, baseUrl, state);
        await check('f1 新資料表回 PGRST205 → 頁面照常載入、基本欄位可見', async () => {
            equal(await page.getByLabel('姓名 *').inputValue(), '林測試', '姓名欄位');
            equal(await page.getByTestId('save-instructor').count(), 1, '儲存按鈕數');
            equal(ctl.pageErrors, [], 'pageerror');
        });
        await check('f2 兩個新區塊都顯示「此功能需先套用資料庫更新（20261020120000）」', async () => {
            equal(await textOf(page.getByTestId('unlock-migration-notice')), MIGRATION_NOTICE, '權限區塊說明');
            equal(await textOf(page.getByTestId('change-migration-notice')), MIGRATION_NOTICE, '紀錄區塊說明');
        });
        await check('f3 開放按鈕全部停用', async () => {
            for (const scope of SCOPES) {
                equal(await grantButton(page, scope).count(), 1, `${scope} 開放按鈕數`);
                ok(await grantButton(page, scope).isDisabled(), `${scope} 開放按鈕應停用`);
            }
        });
        await context.close();
    }
    {
        const state = makeState({
            unlocksFailure: { status: 500, body: { code: 'XX000', message: 'boom', details: null, hint: null } },
        });
        const { context, page } = await openAdminPage(browser, baseUrl, state);
        await check('f4 讀取開放狀態失敗（非缺表）→ 顯示讀取失敗與重新載入，按鈕停用，其餘頁面照常', async () => {
            const text = await textOf(page.getByRole('alert').filter({ hasText: '讀取開放狀態失敗' }));
            ok(text.includes('boom'), `錯誤訊息不對：${text}`);
            for (const scope of SCOPES) ok(await grantButton(page, scope).isDisabled(), `${scope} 開放按鈕應停用`);
            equal(await page.getByLabel('姓名 *').inputValue(), '林測試', '姓名欄位');
            ok((await textOf(page.locator('body'))).includes('尚無修改紀錄'), '修改紀錄區塊仍應正常');
        });
        await context.close();
    }

    // ── h. 開放 72 小時後過期：過期的那筆不算開放，畫面回到鎖定中、可重新開放 ──
    {
        const state = makeState({
            unlocks: [{
                id: '50000000-0000-4000-8000-000000000097', instructor_id: INSTRUCTOR_ID, scope: 'id_card', granted_by: ADMIN_ID,
                granted_at: GRANTED_AT, expires_at: EXPIRED_AT,
                consumed_at: null, consumed_by: null, revoked_at: null, revoked_by: null,
            }],
        });
        const { context, page } = await openAdminPage(browser, baseUrl, state);
        await check('h1 讀開放狀態時只取未過期的（expires_at=gt.現在）', async () => {
            const query = (state.unlockQueries || []).at(-1) || {};
            ok(String(query.expires_at || '').startsWith('gt.'), `缺少過期條件：${JSON.stringify(query)}`);
            ok(String(query.select || '').includes('expires_at'), `select 應含 expires_at：${query.select}`);
        });
        await check('h2 已過期的開放 → 身分證列顯示「鎖定中」且可再按「開放修改一次」', async () => {
            equal(await textOf(page.getByTestId('unlock-status-id_card')), '鎖定中', '身分證狀態');
            equal(await page.getByTestId('unlock-row-id_card').getByRole('button', { name: '開放修改一次' }).count(), 1, '開放按鈕數');
        });
        await context.close();
    }

    // ── g. 手機版與截圖 ──
    {
        const state = makeState({
            changes: sampleChanges(),
            unlocks: [{
                id: '50000000-0000-4000-8000-000000000099', instructor_id: INSTRUCTOR_ID, scope: 'bankbook', granted_by: ADMIN_ID,
                granted_at: GRANTED_AT, expires_at: ACTIVE_EXPIRES_AT,
                consumed_at: null, consumed_by: null, revoked_at: null, revoked_by: null,
            }],
        });
        const { context, page } = await openAdminPage(browser, baseUrl, state, { width: 390, height: 844 });
        await check('g1 390px 寬沒有水平捲動', async () => {
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            ok(overflow <= 0, `scrollWidth 比 clientWidth 多 ${overflow}px`);
        });
        await check('g2 新區塊的按鈕與連結高度皆 >= 44px', async () => {
            const heights = await page.$$eval(
                '[data-testid^="unlock-row-"] button, [data-testid="change-row"] button, [data-testid="change-row"] a',
                (elements) => elements.map((element) => Math.round(element.getBoundingClientRect().height * 10) / 10),
            );
            ok(heights.length >= 8, `量到的按鈕太少：${heights.length}`);
            ok(heights.every((height) => height >= 44), `有按鈕低於 44px：${heights.join(', ')}`);
        });
        await check('g3 存摺列顯示「已開放修改一次」與「收回開放」（手機版）', async () => {
            equal(await textOf(unlockStatus(page, 'bankbook')), '已開放修改一次', '存摺列');
            equal(await revokeButton(page, 'bankbook').count(), 1, '收回按鈕數');
        });
        await page.screenshot({ path: path.join(shotDir, 'admin-mobile.png'), fullPage: true }).catch(() => {});
        await context.close();
    }

    await check('g4 截圖 admin-desktop.png、admin-mobile.png 已存檔且大於 10KB', async () => {
        for (const name of ['admin-desktop.png', 'admin-mobile.png']) {
            const file = path.join(shotDir, name);
            ok(existsSync(file), `${name} 不存在`);
            const size = statSync(file).size;
            ok(size > 10 * 1024, `${name} 只有 ${size} bytes`);
        }
    });
} catch (error) {
    console.log(`FAIL  腳本中斷  — ${error?.stack || error}`);
    results.push({ name: '腳本中斷', pass: false });
} finally {
    await browser?.close().catch(() => {});
    if (preview && !preview.killed) {
        preview.kill('SIGTERM');
        await sleep(500);
        if (preview.exitCode === null) preview.kill('SIGKILL');
    }
}

const failed = results.filter((result) => !result.pass);
console.log(`\nRESULT  ${results.length - failed.length} PASS / ${failed.length} FAIL（共 ${results.length} 項）`);
if (failed.length) {
    console.log(`未通過：${failed.map((result) => result.name).join('；')}`);
    process.exit(1);
}
