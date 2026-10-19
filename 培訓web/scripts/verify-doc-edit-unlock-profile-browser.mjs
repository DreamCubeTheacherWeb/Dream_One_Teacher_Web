#!/usr/bin/env node
/*
 * 講師個人頁「身分證／存摺／匯款：已有資料就鎖定；管理員開放一次後可更換一次」瀏覽器回歸測試。
 * 全程用 Playwright 攔截 *.supabase.co（auth／rest／rpc／storage），以記憶體假資料回應，不連正式 Supabase。
 * 假後端另外模擬 DB trigger：講師在「沒有有效開放」時改到已鎖定的欄位會被擋（403／42501），
 * 存檔真的改到某範圍時把該範圍的開放標成已用掉——所以畫面送出的請求只要有一點不對就會被抓到。
 *
 * 測項：
 *  a. 三份文件＋匯款帳號都有、沒有開放 → 三張卡鎖定提示文字正確、無檔案輸入、匯款五欄 disabled
 *  b. 身分證正面只有匯入的雲端連結（path 為 null）→ 仍鎖定、沒有「上傳新版」；開放後才出現
 *  c. 開放 id_card：選檔→取消更換（預覽回原圖）→再選檔→存檔；上傳路徑、payload、舊檔不被刪、存檔後鎖回、重整仍鎖
 *  d. 開放 bank_account：五欄可編輯→改帳號存檔→payload 正確→五欄再次 disabled
 *  e. 全新講師（無主檔／有主檔但三份文件與匯款皆空）→ 三個檔案輸入都在、沒有任何鎖定提示
 *  f. instructor_edit_unlocks 回 404＋PGRST205 → 頁面照常載入、照樣鎖定、沒有未捕捉錯誤
 *  h. 讀 instructors 失敗 → 顯示重新載入、不當首次填表、不刪草稿
 *  g. 390px：開放狀態無水平捲動、更換檔案／取消更換按鈕高度 >= 44px
 *
 * 用法（在 培訓web/ 下）：node scripts/verify-doc-edit-unlock-profile-browser.mjs [--skip-build] [--keep-build]
 *   --skip-build：沿用上一次 build 好的 dist-profile-unlock（只改測試腳本時加快；不會刪除它）
 *   --keep-build：跑完不刪除這次 build 出來的 dist-profile-unlock
 * 自己 build 到 dist-profile-unlock、自己起 vite preview（埠 4400-4499 擇空閒者），結束時只殺自己的 PID。
 * 截圖存到 docs/verification/2026-10-20-doc-edit-unlock/teacher-*.png。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const viteBin = path.join(appDir, 'node_modules/vite/bin/vite.js');
const outDirName = 'dist-profile-unlock';
const outDirPath = path.join(appDir, outDirName);
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-doc-edit-unlock');
const skipBuild = process.argv.includes('--skip-build');
const keepBuild = process.argv.includes('--keep-build');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const supabaseHost = new URL(env.VITE_SUPABASE_URL).hostname;
const projectRef = supabaseHost.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;

// ───────────────────────── 常數與文案（與 ProfilePage／instructorDocumentLocks 的畫面文字逐字對照） ─────────────────────────
const NOW = new Date().toISOString();
const UID = '00000000-0000-4000-8000-000000000002';
const INSTRUCTOR_ID = '10000000-0000-4000-8000-000000000001';
const ADMIN_ID = '00000000-0000-4000-8000-0000000000a1';
const GRANTED_AT = '2026-10-20T01:00:00Z';
const LOCK_NOTICE = '如需修改，請於講師群組提出。';
const UNLOCKED_TEXT = '管理員已開放修改一次，存檔後會自動鎖回。';
const BANK_LOCKED_TEXT = `匯款銀行資訊已儲存並鎖定。${LOCK_NOTICE}`;
const SAVED_ALERT = '個人資料已儲存！';
const DOCS = [
    { key: 'id_front', label: '身分證正面', color: [40, 90, 200] },
    { key: 'id_back', label: '身分證反面', color: [40, 160, 100] },
    { key: 'bankbook', label: '存摺封面', color: [130, 70, 170] },
];
const lockedText = (label) => `${label}已提交並鎖定。${LOCK_NOTICE}`;
const BANK_PLACEHOLDERS = ['須與身分證姓名相同', '例：華南銀行', '例：仁愛分行', '000000 或 0000000', '請填寫完整帳號'];
const ADDRESS_PLACEHOLDER = '請輸入通訊地址';
const ORANGE = [240, 140, 30];

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
// 沒換的證件欄位：主線 01b9884 起存檔不重送（omitUnchangedDocumentFields），送了也必須是原值。
const unchangedOrOmitted = (payload, field, expected) => {
    if (!(field in payload)) return;
    equal(payload[field], expected, `payload.${field} 不變`);
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
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

// 產生純色 PNG（舊檔各一色、講師新選的檔案是橘色），截圖時看得出「換了沒」。
const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
const crc32 = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};
const pngChunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
};
const makePng = (width, height, [r, g, b]) => {
    const rowLength = width * 3 + 1;
    const raw = Buffer.alloc(rowLength * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = y * rowLength + 1 + x * 3;
            raw[offset] = r; raw[offset + 1] = g; raw[offset + 2] = b;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
};
const NEW_FILE = { name: 'new-front.png', mimeType: 'image/png', buffer: makePng(240, 150, ORANGE) };
const NEW_FILE_2 = { name: 'new-front-2.png', mimeType: 'image/png', buffer: makePng(240, 150, ORANGE) };

// ───────────────────────── 假資料 ─────────────────────────
const docFields = (key, name) => ({
    [`${key}_path`]: `instructors/${UID}/${key}/${name}.png`,
    [`${key}_mime`]: 'image/png',
    [`${key}_size`]: 1234,
    [`${key}_uploaded_at`]: '2026-09-01T00:00:00.000Z',
});
const emptyDocFields = (key) => ({
    [`${key}_path`]: null, [`${key}_mime`]: null, [`${key}_size`]: null, [`${key}_uploaded_at`]: null,
});

// 填齊所有必填欄位，儲存時才不會被「請先補齊以下資料」擋下。
const makeInstructor = (overrides = {}) => ({
    id: INSTRUCTOR_ID,
    user_id: UID,
    full_name: '林測試', nickname: '測試老師', gender: '男', birth_date: '1990-01-01',
    id_number: 'A123456789', phone_mobile: '0912345678', phone_home: '', line_id: 'lin-test',
    address: '台北市信義區通訊路 1 號', household_address: '新北市板橋區戶籍街 2 號',
    email_primary: 'teacher@example.com', email_secondary: '',
    instructor_role: 'A', speed_qualification: '', teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 5 次',
    teaching_regions: ['臺北市'], bio_notes: '完整的教學經歷介紹', wca_id: '',
    bank_account_name: '林測試', bank_name: '華南銀行', bank_branch: '仁愛分行',
    bank_code: '0080012', bank_account_number: '123456789012',
    photo_external_url: null, id_front_external_url: null, id_back_external_url: null, bankbook_external_url: null,
    ...emptyDocFields('photo'),
    ...docFields('id_front', 'old-front'),
    ...docFields('id_back', 'old-back'),
    ...docFields('bankbook', 'old-bankbook'),
    hide_from_leaderboard: false,
    created_at: NOW, updated_at: NOW,
    ...overrides,
});
const emptyDocsInstructor = () => makeInstructor({
    ...emptyDocFields('id_front'), ...emptyDocFields('id_back'), ...emptyDocFields('bankbook'),
    bank_account_name: '', bank_name: '', bank_branch: '', bank_code: '', bank_account_number: '',
});

const makeUnlock = (scope, id = `u-${scope}`) => ({
    id, instructor_id: INSTRUCTOR_ID, scope, granted_by: ADMIN_ID, granted_at: GRANTED_AT,
    consumed_at: null, revoked_at: null,
});

const makeState = ({ instructor, unlocks = [], unlocksFailure = null, instructorsFailure = null }) => ({
    instructor, // null = 完全沒有講師主檔（全新註冊）
    unlocks,
    unlocksFailure, // { status, body }
    instructorsFailure, // 讀 instructors 失敗：{ status, body }
    draftDeletes: 0,
    unlockGets: [], // 每次 GET instructor_edit_unlocks 的查詢字串
    saves: [], // 每次寫入 instructors（PATCH 更新或 POST 新增）：{ method, payload, search, params }
    rejections: [], // 假 DB trigger 擋下的存檔
    uploads: [], // storage 上傳（解碼後的物件路徑）
    storageDeletes: [], // 任何 storage DELETE：{ method, pathname, body }
    storageOther: [], // 其他會改動 storage 的請求（PUT／move 等）
    signCalls: [],
    draft: null,
    supabaseRequests: 0,
});

const missingTableFailure = {
    status: 404,
    body: { code: 'PGRST205', details: null, hint: null, message: "Could not find the table 'public.instructor_edit_unlocks' in the schema cache" },
};

// ───────────────────────── 假 DB trigger ─────────────────────────
const norm = (value) => (value === '' || value === undefined ? null : value);
const SCOPE_FIELDS = {
    id_card: ['id_front_path', 'id_back_path'],
    bankbook: ['bankbook_path'],
    bank_account: ['bank_account_name', 'bank_name', 'bank_branch', 'bank_code', 'bank_account_number'],
};
const SCOPE_HAS_DATA = (before, scope) => {
    if (!before) return false;
    if (scope === 'bank_account') return Boolean(norm(before.bank_account_number));
    const keys = scope === 'id_card' ? ['id_front', 'id_back'] : ['bankbook'];
    return keys.some((key) => Boolean(norm(before[`${key}_path`])) || Boolean(norm(before[`${key}_external_url`])));
};
const changedScopes = (before, payload) => Object.entries(SCOPE_FIELDS)
    .filter(([, fields]) => fields.some((field) => field in payload && norm(payload[field]) !== norm(before?.[field])))
    .map(([scope]) => scope);

// ───────────────────────── 假 Supabase ─────────────────────────
const makeAuth = () => {
    const user = {
        id: UID, aud: 'authenticated', role: 'authenticated', email: 'teacher@example.com',
        email_confirmed_at: NOW, confirmed_at: NOW, last_sign_in_at: NOW,
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { full_name: '林測試', avatar_url: '' }, identities: [], created_at: NOW, updated_at: NOW,
    };
    return {
        user,
        session: {
            access_token: 'mock.teacher.token', refresh_token: 'mock.teacher.refresh', token_type: 'bearer',
            expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user,
        },
        profile: { id: UID, name: '林測試', email: user.email, role: 'teacher', created_at: NOW, updated_at: NOW },
    };
};

const respond = (route, body, status = 200) => {
    const headers = { 'content-type': 'application/json' };
    if (Array.isArray(body)) headers['content-range'] = body.length ? `0-${body.length - 1}/${body.length}` : '*/0';
    return route.fulfill({ status, headers, body: JSON.stringify(body) });
};

const makeHandler = (state, baseUrl, auth) => async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseUrl) return route.continue();
    // 只有「本專案的 supabase 網域」會被假後端接手；其他一律 abort，絕不 continue 出去。
    if (url.hostname !== supabaseHost) return route.abort();
    state.supabaseRequests += 1;
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, body: '' });
    const { pathname } = url;

    if (pathname.startsWith('/auth/v1/')) {
        if (pathname === '/auth/v1/user') return respond(route, auth.user);
        if (pathname.startsWith('/auth/v1/token')) return respond(route, auth.session);
        return respond(route, {});
    }

    if (pathname.startsWith('/storage/v1/')) {
        const signPrefix = '/storage/v1/object/sign/instructor_uploads/';
        const mockPrefix = '/storage/v1/object/public/mock-pixel/';
        const objectPrefix = '/storage/v1/object/instructor_uploads/';
        if (pathname.startsWith(signPrefix)) {
            const filePath = decodeURIComponent(pathname.slice(signPrefix.length));
            state.signCalls.push(filePath);
            return respond(route, { signedURL: `/object/public/mock-pixel/${filePath}` });
        }
        if (pathname.startsWith(mockPrefix)) {
            const filePath = decodeURIComponent(pathname.slice(mockPrefix.length));
            const doc = DOCS.find((item) => filePath.includes(`/${item.key}/`));
            const color = doc && filePath.includes('/old-') ? doc.color : ORANGE;
            return route.fulfill({ status: 200, contentType: 'image/png', body: makePng(240, 150, color) });
        }
        if (method === 'DELETE') {
            state.storageDeletes.push({ method, pathname: decodeURIComponent(pathname), body: request.postData() || '' });
            return respond(route, []);
        }
        if (method === 'POST' && pathname.startsWith(objectPrefix)) {
            state.uploads.push({
                path: decodeURIComponent(pathname.slice(objectPrefix.length)),
                upsertHeader: (await request.allHeaders())['x-upsert'] || null,
            });
            return respond(route, { Key: 'mock-upload' });
        }
        state.storageOther.push({ method, pathname: decodeURIComponent(pathname) });
        return respond(route, {}, 404);
    }

    if (pathname.startsWith('/rest/v1/rpc/')) {
        if (pathname.endsWith('/claim_my_precreated_instructor')) return respond(route, { status: 'existing' });
        return respond(route, null);
    }

    if (!pathname.startsWith('/rest/v1/')) return respond(route, {}, 404);
    const table = pathname.replace('/rest/v1/', '').split('/')[0];
    const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');

    // 存檔：已有主檔走 PATCH（UPDATE … WHERE user_id），PATCH 沒更新到任何列才 POST 新增。
    if (table === 'instructors' && (method === 'PATCH' || method === 'POST')) {
        const raw = request.postDataJSON();
        const payload = Array.isArray(raw) ? raw[0] : raw;
        state.saves.push({ method, payload, search: url.search, params: Object.fromEntries(url.searchParams) });
        const before = state.instructor;
        if (method === 'PATCH' && (!before || url.searchParams.get('user_id') !== `eq.${UID}`)) {
            return respond(route, wantsObject ? null : [], 200);
        }
        if (method === 'POST' && before) {
            return respond(route, { code: '23505', details: null, hint: null, message: 'duplicate key value violates unique constraint' }, 409);
        }
        const changed = changedScopes(before, payload);
        const openByScope = Object.fromEntries(state.unlocks
            .filter((item) => !item.consumed_at && !item.revoked_at).map((item) => [item.scope, item]));
        const blocked = changed.filter((scope) => SCOPE_HAS_DATA(before, scope) && !openByScope[scope]);
        if (blocked.length) {
            state.rejections.push({ scopes: blocked });
            return respond(route, {
                code: '42501', details: null, hint: null,
                message: `${blocked.join('、')} 已鎖定，如需修改請聯絡管理員`,
            }, 403);
        }
        for (const scope of changed) {
            if (openByScope[scope]) openByScope[scope].consumed_at = new Date().toISOString();
        }
        const after = { id: INSTRUCTOR_ID, ...(before || {}), ...payload, updated_at: new Date().toISOString() };
        state.instructor = after;
        const selected = { id: after.id, updated_at: after.updated_at };
        return respond(route, wantsObject ? selected : [selected], method === 'POST' ? 201 : 200);
    }
    if (table === 'instructor_profile_drafts') {
        if (method === 'DELETE') { state.draft = null; state.draftDeletes += 1; return route.fulfill({ status: 204, body: '' }); }
        if (method !== 'GET') {
            const raw = request.postDataJSON();
            state.draft = Array.isArray(raw) ? raw[0] : raw;
            return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: '[]' });
        }
        return respond(route, wantsObject ? state.draft : (state.draft ? [state.draft] : []));
    }
    if (method !== 'GET') return route.fulfill({ status: 204, body: '' });

    if (table === 'instructor_edit_unlocks') {
        state.unlockGets.push(Object.fromEntries(url.searchParams));
        if (state.unlocksFailure) return respond(route, state.unlocksFailure.body, state.unlocksFailure.status);
        const instructorFilter = url.searchParams.get('instructor_id');
        const rows = state.unlocks
            .filter((item) => instructorFilter === `eq.${item.instructor_id}` && !item.consumed_at && !item.revoked_at)
            .map(({ id, scope, granted_at: grantedAt, granted_by: grantedBy }) => ({
                id, scope, granted_at: grantedAt, granted_by: grantedBy,
            }));
        return respond(route, rows);
    }
    if (table === 'users') return respond(route, wantsObject ? auth.profile : [auth.profile]);
    if (table === 'instructors') {
        if (state.instructorsFailure) return respond(route, state.instructorsFailure.body, state.instructorsFailure.status);
        const rows = state.instructor && url.searchParams.get('user_id') === `eq.${UID}` ? [state.instructor] : [];
        return respond(route, wantsObject ? (rows[0] ?? null) : rows);
    }
    return respond(route, wantsObject ? null : []);
};

// ───────────────────────── 起 build、preview、瀏覽器 ─────────────────────────
const portIsFree = (port) => new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
});
const findFreePort = async () => {
    const start = 4400 + Math.floor(Math.random() * 100);
    for (let offset = 0; offset < 100; offset += 1) {
        const port = 4400 + ((start - 4400 + offset) % 100);
        if (await portIsFree(port)) return port;
    }
    throw new Error('4400-4499 沒有空閒埠');
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

// 核對「這個埠上回應的真的是我剛 build、剛起的那一份」（避免打到別的 session 的伺服器）。
const verifyServerIdentity = async (baseUrl, preview) => {
    ok(preview.exitCode === null, 'vite preview 已經結束');
    const expected = readFileSync(path.join(outDirPath, 'index.html'), 'utf8');
    const actual = await (await fetch(`${baseUrl}/`)).text();
    ok(actual === expected, '伺服器首頁與 dist-profile-unlock/index.html 不一致，可能打到別人的伺服器');
    const script = expected.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1];
    ok(script && (await fetch(`${baseUrl}${script}`)).ok, '找不到主程式 bundle');
};

const openProfile = async (browser, baseUrl, state, { width = 1280, height = 900, readySelector } = {}) => {
    const auth = makeAuth();
    const context = await browser.newContext({ viewport: { width, height }, timezoneId: 'Asia/Taipei', locale: 'zh-TW' });
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: auth.session });
    await context.route('**/*', makeHandler(state, baseUrl, auth));
    const page = await context.newPage();
    const ctl = { dialogs: [], pageErrors: [], consoleMessages: [] };
    page.on('dialog', async (dialog) => {
        ctl.dialogs.push({ type: dialog.type(), message: dialog.message() });
        await dialog.accept();
    });
    page.on('pageerror', (error) => ctl.pageErrors.push(error.message));
    page.on('console', (message) => ctl.consoleMessages.push({ type: message.type(), text: message.text() }));
    await page.goto(`${baseUrl}/profile`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(readySelector || `input[placeholder="${ADDRESS_PLACEHOLDER}"]`, { timeout: 20000 });
    return { context, page, ctl };
};

const tid = (page, id) => page.getByTestId(id);
const bankInputs = (page) => BANK_PLACEHOLDERS.map((placeholder) => page.locator(`input[placeholder="${placeholder}"]`));
const countBankDisabled = async (page) => {
    let disabled = 0;
    for (const input of bankInputs(page)) {
        equal(await input.count(), 1, '匯款欄位數量');
        if (await input.isDisabled()) disabled += 1;
    }
    return disabled;
};
const previewSrc = (page, label) => page.locator(`img[alt="${label}"]`).getAttribute('src');
const saveAndWait = async (page, ctl) => {
    const before = ctl.dialogs.length;
    await page.getByRole('button', { name: '儲存個人資料' }).click();
    await waitUntil(() => ctl.dialogs.slice(before).some((d) => d.message === SAVED_ALERT), '應跳出「個人資料已儲存！」', 10000);
};
const assertAllDocsLocked = async (page, label = '') => {
    for (const { key, label: docLabel } of DOCS) {
        equal(await textOf(tid(page, `${key}-locked-notice`)), lockedText(docLabel), `${label}${docLabel} 鎖定提示`);
        equal(await tid(page, `${key}-file-input`).count(), 0, `${label}${docLabel} 檔案輸入數`);
        equal(await tid(page, `${key}-replace-button`).count(), 0, `${label}${docLabel} 更換按鈕數`);
        equal(await tid(page, `${key}-unlocked-notice`).count(), 0, `${label}${docLabel} 開放提示數`);
    }
};
const shootSections = async (page, testIds, file) => {
    const box = await page.evaluate((ids) => {
        const rects = ids.map((id) => document.querySelector(`[data-testid="${id}"]`)?.closest('.bh-card')?.getBoundingClientRect())
            .filter(Boolean);
        return {
            top: Math.min(...rects.map((r) => r.top)) + window.scrollY,
            bottom: Math.max(...rects.map((r) => r.bottom)) + window.scrollY,
            width: document.documentElement.clientWidth,
        };
    }, testIds);
    await page.screenshot({
        path: path.join(shotDir, file),
        fullPage: true,
        clip: { x: 0, y: Math.max(0, box.top - 8), width: box.width, height: box.bottom - box.top + 16 },
    });
};

// 一個情境開頭就失敗（例如頁面根本沒載入）時，要明確標成 FAIL，而不是整支腳本崩掉。
const scenario = async (name, fn) => {
    try {
        await fn();
    } catch (error) {
        results.push({ name: `${name}（情境執行失敗）`, pass: false });
        console.log(`FAIL  ${name}（情境執行失敗）  — ${String(error?.message || error).split('\n')[0]}`);
    }
};

// ───────────────────────── 主流程 ─────────────────────────
let preview;
let browser;
let builtHere = false;
try {
    if (skipBuild) {
        ok(existsSync(path.join(outDirPath, 'index.html')), `--skip-build 但 ${outDirName} 不存在`);
        console.log(`略過 build，沿用 ${outDirName}`);
    } else {
        console.log(`build 到 ${outDirName} ⋯`);
        builtHere = true;
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
    const baseUrl = `http://127.0.0.1:${port}`;
    preview = spawn(process.execPath, [viteBin, 'preview', '--outDir', outDirName, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`preview pid=${preview.pid} port=${port}`);
    await waitForServer(baseUrl);
    await verifyServerIdentity(baseUrl, preview);
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });

    // ── a. 三份文件＋匯款都有資料、沒有開放 → 全部鎖定 ──
    await scenario('a', async () => {
        const state = makeState({ instructor: makeInstructor() });
        const { context, page, ctl } = await openProfile(browser, baseUrl, state);
        await check('a1 三張文件卡都有鎖定提示且文字正確；無檔案輸入、無更換按鈕、無開放提示', async () => {
            await assertAllDocsLocked(page);
        });
        await check('a2 已鎖定的預覽圖正常載入，且沒有「移除／取消更換」按鈕', async () => {
            for (const { label } of DOCS) {
                const loaded = await page.locator(`img[alt="${label}"]`).evaluate((img) => img.complete && img.naturalWidth > 0);
                ok(loaded, `${label} 預覽沒載入`);
                equal(await page.getByRole('button', { name: `移除${label}` }).count(), 0, `${label} 移除按鈕數`);
                equal(await page.getByRole('button', { name: `取消更換${label}` }).count(), 0, `${label} 取消更換按鈕數`);
            }
        });
        await check('a3 匯款五欄全部 disabled，bank-locked-notice 文字正確，沒有開放提示', async () => {
            equal(await countBankDisabled(page), 5, '匯款 disabled 欄位數');
            equal(await textOf(tid(page, 'bank-locked-notice')), BANK_LOCKED_TEXT, '匯款鎖定提示');
            equal(await tid(page, 'bank-unlocked-notice').count(), 0, '匯款開放提示數');
        });
        await check('a4 其他欄位不受影響（通訊地址仍可編輯）', async () => {
            ok(await page.locator(`input[placeholder="${ADDRESS_PLACEHOLDER}"]`).isEnabled(), '通訊地址不應被鎖');
        });
        await check('a5 載入時有查開放狀態：instructor_id、consumed_at／revoked_at 條件正確', async () => {
            ok(state.unlockGets.length >= 1, '沒有查詢 instructor_edit_unlocks');
            const params = state.unlockGets[0];
            equal(params.instructor_id, `eq.${INSTRUCTOR_ID}`, 'instructor_id 條件');
            equal(params.consumed_at, 'is.null', 'consumed_at 條件');
            equal(params.revoked_at, 'is.null', 'revoked_at 條件');
            equal(params.select, 'id,scope,granted_at,granted_by,expires_at', 'select 欄位');
            ok(String(params.expires_at || '').startsWith('gt.'), `缺少過期條件：${params.expires_at}`);
        });
        await check('a6 整個載入過程沒有未捕捉錯誤、沒有存檔請求、沒有 storage 寫入／刪除', async () => {
            equal(ctl.pageErrors, [], 'pageerror');
            equal(state.saves.length, 0, '存檔請求數');
            equal(state.uploads.length + state.storageDeletes.length + state.storageOther.length, 0, 'storage 寫入／刪除數');
        });
        await check('a7 截圖 teacher-locked-desktop.png（>10KB）', async () => {
            await shootSections(page, ['bank-locked-notice', 'document-upload-id_front'], 'teacher-locked-desktop.png');
            const size = statSync(path.join(shotDir, 'teacher-locked-desktop.png')).size;
            ok(size > 10 * 1024, `截圖只有 ${size} bytes`);
        });
        await context.close();
    });

    // ── b. 只有匯入的雲端連結（path 為 null）也算已有資料 ──
    const DRIVE_URL = 'https://drive.google.com/file/d/EXTFRONT123/view';
    await scenario('b', async () => {
        const state = makeState({
            instructor: makeInstructor({ ...emptyDocFields('id_front'), id_front_external_url: DRIVE_URL }),
        });
        const { context, page } = await openProfile(browser, baseUrl, state);
        await check('b1 身分證正面只有雲端連結 → 仍鎖定（提示文字正確、無檔案輸入、無更換按鈕）', async () => {
            equal(await textOf(tid(page, 'id_front-locked-notice')), lockedText('身分證正面'), '鎖定提示');
            equal(await tid(page, 'id_front-file-input').count(), 0, '檔案輸入數');
            equal(await tid(page, 'id_front-replace-button').count(), 0, '更換按鈕數');
        });
        await check('b2 沒有「上傳新版」按鈕，只剩「查看既有文件」連結（指向匯入網址）', async () => {
            equal(await page.getByRole('button', { name: '上傳新版' }).count(), 0, '上傳新版按鈕數');
            const link = page.getByRole('link', { name: '查看既有文件' });
            equal(await link.count(), 1, '查看既有文件連結數');
            equal(await link.getAttribute('href'), DRIVE_URL, '連結網址');
        });
        await check('b3 其餘兩份文件照常鎖定', async () => {
            for (const { key, label } of DOCS.filter((doc) => doc.key !== 'id_front')) {
                equal(await textOf(tid(page, `${key}-locked-notice`)), lockedText(label), `${label} 鎖定提示`);
            }
        });
        await context.close();

        // 補充：管理員開放 id_card 後，這種「只有雲端連結」的卡才出現「上傳新版」與開放提示。
        const openState = makeState({
            instructor: makeInstructor({ ...emptyDocFields('id_front'), id_front_external_url: DRIVE_URL }),
            unlocks: [makeUnlock('id_card')],
        });
        const opened = await openProfile(browser, baseUrl, openState);
        await check('b4 開放 id_card 後，只有雲端連結的正面出現「上傳新版」、檔案輸入與開放提示', async () => {
            equal(await opened.page.getByRole('button', { name: '上傳新版' }).count(), 1, '上傳新版按鈕數');
            equal(await tid(opened.page, 'id_front-file-input').count(), 1, '檔案輸入數');
            equal(await textOf(tid(opened.page, 'id_front-unlocked-notice')), UNLOCKED_TEXT, '開放提示');
            equal(await tid(opened.page, 'id_front-locked-notice').count(), 0, '鎖定提示數');
        });
        await opened.context.close();
    });

    // ── c. 開放 id_card：換一次身分證正面，存檔後自動鎖回 ──
    await scenario('c', async () => {
        const state = makeState({ instructor: makeInstructor(), unlocks: [makeUnlock('id_card')] });
        const oldFrontPath = state.instructor.id_front_path;
        const oldBackPath = state.instructor.id_back_path;
        const oldBankbookPath = state.instructor.bankbook_path;
        const { context, page, ctl } = await openProfile(browser, baseUrl, state);
        let originalSrc;

        await check('c1 正反兩面出現開放提示與更換按鈕（無鎖定提示）；存摺與匯款仍鎖定', async () => {
            for (const { key } of DOCS.filter((doc) => doc.key !== 'bankbook')) {
                equal(await textOf(tid(page, `${key}-unlocked-notice`)), UNLOCKED_TEXT, `${key} 開放提示`);
                equal(await tid(page, `${key}-replace-button`).count(), 1, `${key} 更換按鈕數`);
                equal(await tid(page, `${key}-locked-notice`).count(), 0, `${key} 鎖定提示數`);
                equal(await tid(page, `${key}-file-input`).count(), 1, `${key} 檔案輸入數`);
            }
            equal(await textOf(tid(page, 'bankbook-locked-notice')), lockedText('存摺封面'), '存摺鎖定提示');
            equal(await tid(page, 'bankbook-replace-button').count(), 0, '存摺更換按鈕數');
            equal(await tid(page, 'bankbook-file-input').count(), 0, '存摺檔案輸入數');
            equal(await textOf(tid(page, 'bank-locked-notice')), BANK_LOCKED_TEXT, '匯款鎖定提示');
            equal(await countBankDisabled(page), 5, '匯款 disabled 欄位數');
        });
        await check('c2 開放期間正本上沒有 X（沒有「移除」也沒有「取消更換」按鈕）', async () => {
            for (const { label } of DOCS) {
                equal(await page.getByRole('button', { name: `移除${label}` }).count(), 0, `${label} 移除按鈕數`);
                equal(await page.getByRole('button', { name: `取消更換${label}` }).count(), 0, `${label} 取消更換按鈕數`);
            }
            originalSrc = await previewSrc(page, '身分證正面');
            ok(originalSrc && originalSrc.includes(oldFrontPath), `原本預覽應指向舊檔：${originalSrc}`);
        });
        await check('c3 開放狀態桌機截圖（供人工對照，>10KB）', async () => {
            await shootSections(page, ['document-upload-id_front'], 'teacher-unlocked-desktop.png');
            const size = statSync(path.join(shotDir, 'teacher-unlocked-desktop.png')).size;
            ok(size > 10 * 1024, `截圖只有 ${size} bytes`);
        });
        await check('c4 按「更換檔案」選新檔 → 預覽換成新檔、出現「取消更換身分證正面」、按鈕變「改選其他檔案」', async () => {
            const [chooser] = await Promise.all([
                page.waitForEvent('filechooser'),
                tid(page, 'id_front-replace-button').click(),
            ]);
            await chooser.setFiles(NEW_FILE);
            await waitUntil(async () => (await page.getByRole('button', { name: '取消更換身分證正面' }).count()) === 1, '應出現取消更換按鈕');
            ok((await previewSrc(page, '身分證正面')).startsWith('blob:'), '預覽應換成新檔的 blob');
            equal(await textOf(tid(page, 'id_front-replace-button')), '改選其他檔案', '更換按鈕文字');
            equal(await tid(page, 'id_front-unlocked-notice').count(), 1, '開放提示仍在');
        });
        await check('c5 按「取消更換」→ 按鈕消失、預覽回到原本那張（img src 與原先逐字相同）、更換按鈕恢復', async () => {
            await page.getByRole('button', { name: '取消更換身分證正面' }).click();
            await waitUntil(async () => (await page.getByRole('button', { name: '取消更換身分證正面' }).count()) === 0, '取消更換按鈕應消失');
            equal(await previewSrc(page, '身分證正面'), originalSrc, '預覽 src');
            equal(await textOf(tid(page, 'id_front-replace-button')), '更換檔案', '更換按鈕文字');
            equal(state.uploads.length, 0, '取消更換前不應上傳任何檔案');
        });
        await check('c6 再選一次新檔（改用檔案輸入）→ 存檔：上傳路徑、payload、舊檔保留、開放用掉', async () => {
            await tid(page, 'id_front-file-input').setInputFiles(NEW_FILE_2);
            await waitUntil(async () => (await page.getByRole('button', { name: '取消更換身分證正面' }).count()) === 1, '應再次出現取消更換按鈕');
            const savesBefore = state.saves.length;
            await saveAndWait(page, ctl);

            equal(state.uploads.length, 1, '上傳請求數');
            const uploadedPath = state.uploads[0].path;
            ok(
                new RegExp(`^instructors/${UID}/id_front/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.png$`).test(uploadedPath),
                `上傳路徑格式不符：${uploadedPath}`,
            );
            ok(uploadedPath !== oldFrontPath, '上傳路徑不可與舊檔相同（不可覆蓋）');
            ok(state.uploads[0].upsertHeader !== 'true', `上傳不可帶 x-upsert: true（會覆蓋同名舊檔），實際 ${state.uploads[0].upsertHeader}`);

            equal(state.saves.length, savesBefore + 1, '存檔請求數');
            const { payload, params, method: saveMethod } = state.saves.at(-1);
            // 既有講師一律 UPDATE（不用 upsert，避免 INSERT trigger 擋下認領過的講師）
            equal(saveMethod, 'PATCH', '存檔方式');
            equal(params.user_id, `eq.${UID}`, 'user_id 條件');
            equal(payload.user_id, UID, 'payload.user_id');
            equal(payload.id_front_path, uploadedPath, 'payload.id_front_path 應是新路徑');
            equal(payload.id_front_mime, 'image/png', 'payload.id_front_mime');
            unchangedOrOmitted(payload, 'id_back_path', oldBackPath);
            unchangedOrOmitted(payload, 'bankbook_path', oldBankbookPath);
            equal(state.rejections.length, 0, '假 DB 擋下次數');
            equal(state.unlocks[0].consumed_at !== null, true, 'id_card 開放應被用掉');
        });
        await check('c7 整個過程沒有任何 storage 刪除請求含舊的 id_front 路徑（舊檔保留）', async () => {
            const hit = state.storageDeletes.filter((item) => item.pathname.includes(oldFrontPath) || item.body.includes(oldFrontPath));
            equal(hit, [], '含舊路徑的刪除請求');
            equal(state.uploads.some((item) => item.path === oldFrontPath), false, '不得覆蓋舊檔');
            equal(state.storageOther, [], '其他 storage 異動請求');
        });
        await check('c8 這次存檔不應有任何 storage 刪除請求（只換身分證，沒有其他檔案要清）', async () => {
            equal(state.storageDeletes, [], 'storage 刪除請求');
        });
        await check('c9 存檔後再查一次開放狀態；身分證正反兩面都回到鎖定（開放提示、更換按鈕、檔案輸入全消失）', async () => {
            ok(state.unlockGets.length >= 2, `開放狀態查詢次數應 >= 2（載入＋存檔後），實際 ${state.unlockGets.length}`);
            await waitUntil(async () => (await tid(page, 'id_front-locked-notice').count()) === 1, 'id_front 應回到鎖定');
            await assertAllDocsLocked(page);
            equal(await page.getByRole('button', { name: /取消更換/ }).count(), 0, '取消更換按鈕數');
        });
        await check('c10 重新載入後仍鎖定，預覽改簽新路徑', async () => {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForSelector(`input[placeholder="${ADDRESS_PLACEHOLDER}"]`, { timeout: 20000 });
            await assertAllDocsLocked(page, '重載後 ');
            const newPath = state.saves.at(-1).payload.id_front_path;
            ok(state.signCalls.includes(newPath), '重載後應對新路徑簽署預覽網址');
            ok((await previewSrc(page, '身分證正面')).includes(newPath), '預覽應指向新檔');
            equal(ctl.pageErrors, [], 'pageerror');
        });
        await context.close();
    });

    // ── c'. 選了又取消，直接存檔 → 不上傳、開放不被用掉 ──
    await scenario("c'", async () => {
        const state = makeState({ instructor: makeInstructor(), unlocks: [makeUnlock('id_card')] });
        const oldFrontPath = state.instructor.id_front_path;
        const { context, page, ctl } = await openProfile(browser, baseUrl, state);
        await check("c' 選新檔→取消更換→直接存檔：不上傳、payload 仍是舊路徑、開放沒被用掉、畫面仍是開放狀態", async () => {
            await tid(page, 'id_front-file-input').setInputFiles(NEW_FILE);
            await page.getByRole('button', { name: '取消更換身分證正面' }).click();
            await waitUntil(async () => (await page.getByRole('button', { name: '取消更換身分證正面' }).count()) === 0, '取消更換按鈕應消失');
            await saveAndWait(page, ctl);
            equal(state.uploads.length, 0, '上傳數');
            equal(state.saves.length, 1, '存檔請求數');
            unchangedOrOmitted(state.saves[0].payload, 'id_front_path', oldFrontPath);
            equal(state.rejections.length, 0, '假 DB 擋下次數');
            equal(state.unlocks[0].consumed_at, null, '開放不應被用掉');
            equal(await tid(page, 'id_front-replace-button').count(), 1, '更換按鈕仍在（仍是開放狀態）');
            equal(state.storageDeletes.length, 0, 'storage 刪除數');
        });
        await context.close();
    });

    // ── d. 開放 bank_account：改一次匯款資訊，存檔後鎖回 ──
    await scenario('d', async () => {
        const state = makeState({ instructor: makeInstructor(), unlocks: [makeUnlock('bank_account')] });
        const before = state.instructor;
        const { context, page, ctl } = await openProfile(browser, baseUrl, state);
        await check('d1 匯款五欄可編輯、顯示開放提示、沒有鎖定提示；三份文件仍鎖定', async () => {
            equal(await countBankDisabled(page), 0, '匯款 disabled 欄位數');
            equal(await textOf(tid(page, 'bank-unlocked-notice')), UNLOCKED_TEXT, '匯款開放提示');
            equal(await tid(page, 'bank-locked-notice').count(), 0, '匯款鎖定提示數');
            await assertAllDocsLocked(page);
        });
        await check('d2 改帳號存檔 → payload 帳號為新值、其餘匯款欄位不變、沒有檔案請求、假 DB 未擋', async () => {
            const input = page.locator('input[placeholder="請填寫完整帳號"]');
            await input.fill('9876543210');
            equal(await input.inputValue(), '9876543210', '輸入框的值');
            await saveAndWait(page, ctl);
            equal(state.saves.length, 1, '存檔請求數');
            const { payload } = state.saves[0];
            equal(payload.bank_account_number, '9876543210', 'payload.bank_account_number');
            for (const field of ['bank_account_name', 'bank_name', 'bank_branch', 'bank_code']) {
                equal(payload[field], before[field], `payload.${field}`);
            }
            for (const key of ['id_front_path', 'id_back_path', 'bankbook_path']) unchangedOrOmitted(payload, key, before[key]);
            equal(state.rejections.length, 0, '假 DB 擋下次數');
            equal(state.uploads.length + state.storageDeletes.length, 0, 'storage 請求數');
            equal(state.unlocks[0].consumed_at !== null, true, 'bank_account 開放應被用掉');
        });
        await check('d3 存檔後匯款五欄再次 disabled、出現鎖定提示、開放提示消失；欄位顯示新帳號', async () => {
            await waitUntil(async () => (await tid(page, 'bank-locked-notice').count()) === 1, '匯款應回到鎖定');
            equal(await countBankDisabled(page), 5, '匯款 disabled 欄位數');
            equal(await textOf(tid(page, 'bank-locked-notice')), BANK_LOCKED_TEXT, '匯款鎖定提示');
            equal(await tid(page, 'bank-unlocked-notice').count(), 0, '匯款開放提示數');
            equal(await page.locator('input[placeholder="請填寫完整帳號"]').inputValue(), '9876543210', '帳號欄位的值');
            ok(state.unlockGets.length >= 2, `存檔後應再查一次開放狀態，實際查詢 ${state.unlockGets.length} 次`);
            equal(ctl.pageErrors, [], 'pageerror');
        });
        await context.close();
    });

    // ── e. 全新講師：沒有任何文件／匯款 → 全部可填，沒有鎖定提示 ──
    await scenario('e', async () => {
        const variants = [
            ['e1 完全沒有講師主檔（首次註冊）', makeState({ instructor: null })],
            ['e2 有講師主檔但三份文件與匯款皆空', makeState({ instructor: emptyDocsInstructor() })],
        ];
        for (const [name, state] of variants) {
            const { context, page, ctl } = await openProfile(browser, baseUrl, state);
            await check(`${name} → 三個檔案輸入都在、沒有任何鎖定／開放提示、匯款五欄可編輯`, async () => {
                for (const { key, label } of DOCS) {
                    equal(await tid(page, `${key}-file-input`).count(), 1, `${label} 檔案輸入數`);
                    equal(await tid(page, `${key}-locked-notice`).count(), 0, `${label} 鎖定提示數`);
                    equal(await tid(page, `${key}-unlocked-notice`).count(), 0, `${label} 開放提示數`);
                }
                equal(await tid(page, 'bank-locked-notice').count(), 0, '匯款鎖定提示數');
                equal(await tid(page, 'bank-unlocked-notice').count(), 0, '匯款開放提示數');
                equal(await countBankDisabled(page), 0, '匯款 disabled 欄位數');
                equal(ctl.pageErrors, [], 'pageerror');
            });
            await context.close();
        }
    });

    // ── f. 資料表尚未套用（PGRST205）→ 視為沒有開放，頁面照常 ──
    await scenario('f', async () => {
        const state = makeState({ instructor: makeInstructor(), unlocksFailure: missingTableFailure });
        const { context, page, ctl } = await openProfile(browser, baseUrl, state);
        await check('f1 instructor_edit_unlocks 回 404＋PGRST205 → 頁面照常載入、三份文件與匯款照樣鎖定', async () => {
            ok(state.unlockGets.length >= 1, '應該真的打過 instructor_edit_unlocks');
            await assertAllDocsLocked(page);
            equal(await countBankDisabled(page), 5, '匯款 disabled 欄位數');
            equal(await textOf(tid(page, 'bank-locked-notice')), BANK_LOCKED_TEXT, '匯款鎖定提示');
        });
        await check('f2 沒有未捕捉的 page error，也沒有「Failed to load edit unlocks」警告', async () => {
            equal(ctl.pageErrors, [], 'pageerror');
            const warned = ctl.consoleMessages.filter((m) => m.text.includes('Failed to load edit unlocks'));
            equal(warned, [], 'console 警告');
        });
        await context.close();
    });

    // ── h. 讀不到講師主檔（網路／權限錯誤）→ 不可當成首次填表、不可刪草稿；可重新載入 ──
    await scenario('h', async () => {
        const state = makeState({
            instructor: makeInstructor(),
            instructorsFailure: { status: 500, body: { code: '57014', details: null, hint: null, message: 'canceling statement due to statement timeout' } },
        });
        state.draft = { user_id: UID, base_updated_at: state.instructor.updated_at ?? null, data: { address: '草稿地址' } };
        const { context, page, ctl } = await openProfile(browser, baseUrl, state, { readySelector: '[data-testid="profile-load-error"]' });
        await check('h1 讀取失敗 → 顯示錯誤與「重新載入」，不顯示空白表單', async () => {
            equal(await page.locator(`input[placeholder="${ADDRESS_PLACEHOLDER}"]`).count(), 0, '表單欄位數');
            equal(await page.getByRole('button', { name: '重新載入' }).count(), 1, '重新載入按鈕數');
            const box = await page.getByRole('button', { name: '重新載入' }).boundingBox();
            ok(box && box.height >= 44, `重新載入按鈕高度 ${box?.height}`);
        });
        await check('h2 讀取失敗時不刪伺服器草稿、不送任何存檔', async () => {
            await sleep(500);
            equal(state.draftDeletes, 0, '草稿刪除次數');
            ok(state.draft !== null, '草稿應仍在');
            equal(state.saves.length, 0, '存檔請求數');
            equal(ctl.pageErrors, [], 'pageerror');
        });
        await check('h3 恢復後按「重新載入」→ 載入 DB 正本，文件照樣鎖定', async () => {
            state.instructorsFailure = null;
            await page.getByRole('button', { name: '重新載入' }).click();
            await page.waitForSelector(`input[placeholder="${ADDRESS_PLACEHOLDER}"]`, { timeout: 10000 });
            await assertAllDocsLocked(page);
            equal(await tid(page, 'profile-load-error').count(), 0, '錯誤區塊數');
        });
        await context.close();
    });

    // ── g. 390px 手機版：開放狀態不橫向捲動、按鈕夠大 ──
    await scenario('g', async () => {
        const state = makeState({ instructor: makeInstructor(), unlocks: [makeUnlock('id_card')] });
        const { context, page } = await openProfile(browser, baseUrl, state, { width: 390, height: 844 });
        const horizontalOverflow = () => page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
        }));
        await check('g1 390px 開放狀態：scrollWidth <= clientWidth（無水平捲動）', async () => {
            const { scrollWidth, clientWidth } = await horizontalOverflow();
            ok(scrollWidth <= clientWidth, `scrollWidth=${scrollWidth} > clientWidth=${clientWidth}`);
            equal(clientWidth <= 390, true, `視窗寬度應為 390 以內，實際 ${clientWidth}`);
        });
        await check('g2 390px 更換按鈕（正面、反面）高度 >= 44px', async () => {
            for (const key of ['id_front', 'id_back']) {
                const button = tid(page, `${key}-replace-button`);
                await button.scrollIntoViewIfNeeded();
                const box = await button.boundingBox();
                ok(box && box.height >= 44, `${key} 更換按鈕高度 ${box?.height}`);
            }
        });
        await check('g3 截圖 teacher-unlocked-mobile.png（>10KB）', async () => {
            await shootSections(page, ['document-upload-id_front'], 'teacher-unlocked-mobile.png');
            const size = statSync(path.join(shotDir, 'teacher-unlocked-mobile.png')).size;
            ok(size > 10 * 1024, `截圖只有 ${size} bytes`);
        });
        await check('g4 390px 選了新檔後：取消更換按鈕與「改選其他檔案」按鈕都 >= 44px，仍無水平捲動', async () => {
            await tid(page, 'id_front-file-input').setInputFiles(NEW_FILE);
            const cancel = page.getByRole('button', { name: '取消更換身分證正面' });
            await cancel.waitFor({ timeout: 5000 });
            const cancelBox = await cancel.boundingBox();
            ok(cancelBox && cancelBox.width >= 44 && cancelBox.height >= 44, `取消更換按鈕 ${cancelBox?.width}x${cancelBox?.height}`);
            const replaceBox = await tid(page, 'id_front-replace-button').boundingBox();
            ok(replaceBox && replaceBox.height >= 44, `改選按鈕高度 ${replaceBox?.height}`);
            const { scrollWidth, clientWidth } = await horizontalOverflow();
            ok(scrollWidth <= clientWidth, `scrollWidth=${scrollWidth} > clientWidth=${clientWidth}`);
        });
        await context.close();
    });
} catch (error) {
    results.push({ name: '腳本執行', pass: false });
    console.log(`FAIL  腳本執行  — ${String(error?.stack || error).split('\n').slice(0, 4).join(' | ')}`);
} finally {
    if (browser) await browser.close().catch(() => {});
    if (preview && preview.exitCode === null) {
        preview.kill('SIGTERM'); // 只殺自己啟動並記下的 PID
        await sleep(600);
        if (preview.exitCode === null) preview.kill('SIGKILL');
    }
    if (builtHere && !keepBuild) rmSync(outDirPath, { recursive: true, force: true });
}

const passed = results.filter((item) => item.pass).length;
console.log(`\n=== ${passed}/${results.length} PASS ===`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
