#!/usr/bin/env node
/*
 * 「人員類別（講師／職員／工讀計時）＋合作狀態」前端驗證。
 * 全程用 Playwright 攔截 *.supabase.co（auth／rest／rpc／storage），以記憶體假資料回應，不連正式 Supabase。
 * 假後端會記下每一次寫入 instructors 的請求（PATCH／POST），所以「沒有送出請求」是真的數出來的。
 *
 * 涵蓋：
 *  A 講師編輯頁：人員類別勾選、合作狀態只有 3 個選項、速解選項、取消勾講師→等級／速解收起顯示「不適用」且已存值不清除、
 *    存檔請求內容、全不勾擋下且沒有請求、NULL 合作狀態與舊資料（沒有 personnel_types）的顯示
 *  B 講師資料總覽：合作狀態篩選與統計、人員類別篩選、小標籤、職員列的等級／速解顯示「不適用」、舊資料當講師、
 *    1024／1280 表格版面與 900 卡片版面、新增人員表單
 *  C 個人資料頁：純職員看不到接課欄位且沒填也能存檔（請求不帶管理員專屬欄位）；講師（含舊資料）沒填仍被擋
 *  D 課程列表：純職員看到新提示；講師維持原提示；資料庫還沒有 personnel_types 欄位時退回舊查詢
 *  E 合約管理：非講師不計入未簽約，列表標「非講師，不需簽約」；上傳新版文件的通知不寄給非講師
 *  F 已移除的死選項（職員／工讀生等級、助教）不再出現在原始碼
 *
 * 用法（在 培訓web/ 下）：node scripts/verify-personnel-types-ui.mjs
 * 自己起 vite dev（隨機空閒埠，只殺自己的 PID）；截圖存 docs/verification/2026-10-22-personnel-types/。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-22-personnel-types');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const NOW = new Date().toISOString();

// ───────────────────────── 小工具 ─────────────────────────
const results = [];
const check = async (name, fn) => {
    try {
        await fn();
        results.push(true);
        console.log(`PASS  ${name}`);
    } catch (error) {
        results.push(false);
        console.log(`FAIL  ${name}  — ${String(error?.message || error).split('\n')[0]}`);
    }
};
const ok = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${label}：期望 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`);
    }
};
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const waitUntil = async (fn, message, timeout = 8000) => {
    const start = Date.now();
    for (;;) {
        try { const value = await fn(); if (value) return value; } catch { /* retry */ }
        if (Date.now() - start > timeout) throw new Error(`逾時：${message}`);
        await sleep(60);
    }
};
const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

// ───────────────────────── 假資料 ─────────────────────────
const ids = {
    admin: '00000000-0000-4000-8000-0000000000a1',
    instr: '00000000-0000-4000-8000-0000000000b1',
    staff: '00000000-0000-4000-8000-0000000000b2',
    legacy: '00000000-0000-4000-8000-0000000000b3',
    signed: '00000000-0000-4000-8000-0000000000b4',
    incompleteInstr: '00000000-0000-4000-8000-0000000000c1',
    incompleteLegacy: '00000000-0000-4000-8000-0000000000c2',
    noRoleInstr: '00000000-0000-4000-8000-0000000000c3',
};
const rowId = (n) => `20000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const WORST_CASE_NAME = '歐陽長名字職員';
const LONG_EMAIL = 'a.really.long.instructor.address.for.layout@example-school.edu.tw';

// 填齊所有必填欄位（講師版）；純職員的資料再清掉接課欄位
const completeInstructor = (n, overrides) => ({
    id: rowId(n), user_id: null,
    full_name: `測試人員${n}`, nickname: '暱稱', gender: '男', birth_date: '1990-01-01',
    id_number: 'A123456789', phone_mobile: '0912345678', phone_home: '', line_id: 'lin-test',
    address: '台北市信義區通訊路 1 號', household_address: '新北市板橋區戶籍街 2 號',
    email_primary: `person${n}@example.com`, email_secondary: '',
    employment_status: 'active', instructor_role: 'A', speed_qualification: null,
    teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 5 次',
    teaching_regions: ['臺北市'], bio_notes: '完整的教學經歷介紹', wca_id: '',
    bank_account_name: '測試', bank_name: '華南銀行', bank_branch: '仁愛分行',
    bank_code: '0080012', bank_account_number: '123456789012',
    id_front_path: `instructors/${n}/id_front/a.png`, id_front_mime: 'image/png', id_front_size: 10, id_front_uploaded_at: NOW,
    id_back_path: `instructors/${n}/id_back/a.png`, id_back_mime: 'image/png', id_back_size: 10, id_back_uploaded_at: NOW,
    bankbook_path: `instructors/${n}/bankbook/a.png`, bankbook_mime: 'image/png', bankbook_size: 10, bankbook_uploaded_at: NOW,
    photo_path: null, hide_from_leaderboard: false,
    created_at: new Date(Date.now() - n * 60000).toISOString(), updated_at: NOW,
    ...overrides,
});
const withoutTeaching = { teaching_freq_semester: '', teaching_freq_vacation: '', teaching_regions: [], bio_notes: '', instructor_role: null };

const adminRows = () => [
    completeInstructor(1, { full_name: '林講師', personnel_types: ['instructor'], instructor_role: 'A', speed_qualification: 'speed_master', user_id: ids.instr }),
    completeInstructor(2, { full_name: '王職員', personnel_types: ['staff'], ...withoutTeaching, instructor_role: 'A', user_id: ids.staff }), // 已存的等級不清除，用來驗證等級篩選不會撈出職員
    completeInstructor(3, { full_name: '陳工讀', personnel_types: ['part_time'], ...withoutTeaching, instructor_role: 'B', speed_qualification: 'speed_master', employment_status: 'frozen' }), // 已存的等級／速解不清除
    completeInstructor(4, { full_name: '舊資料老師', instructor_role: 'B', employment_status: null, user_id: ids.legacy }), // 沒有 personnel_types 欄位
    completeInstructor(5, { full_name: '雙身分', personnel_types: ['instructor', 'staff'], instructor_role: 'S' }),
    completeInstructor(6, { full_name: WORST_CASE_NAME, personnel_types: ['staff', 'part_time'], ...withoutTeaching, employment_status: 'cancelled', email_primary: LONG_EMAIL }),
    completeInstructor(7, { full_name: '簽約講師', personnel_types: ['instructor'], user_id: ids.signed }),
];

// ───────────────────────── 假後端 ─────────────────────────
const makeBackend = ({ persona, rows, extraUsers = [], contracts = [], contractDocs = [], legacyDb = false }) => {
    const user = {
        id: persona.id, aud: 'authenticated', role: 'authenticated', email: persona.email,
        app_metadata: { provider: 'google', providers: ['google'] },
        user_metadata: { full_name: persona.name }, created_at: NOW, updated_at: NOW,
    };
    const session = {
        access_token: `mock.${persona.key}.token`, refresh_token: `mock.${persona.key}.refresh`, token_type: 'bearer',
        expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user,
    };
    const profile = { id: persona.id, name: persona.name, email: persona.email, role: persona.role, created_at: NOW };
    const state = { rows, writes: [], other: [], legacyDb, selects: [] };

    const json = (route, data, status = 200) => route.fulfill({
        status,
        headers: { 'content-type': 'application/json', ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}) },
        body: JSON.stringify(data),
    });

    const handler = async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
        if (!url.hostname.endsWith('.supabase.co')) return route.abort();
        if (url.pathname.startsWith('/auth/v1/')) {
            if (url.pathname === '/auth/v1/user') return json(route, user);
            if (url.pathname.startsWith('/auth/v1/token')) return json(route, session);
            return json(route, {});
        }
        if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);
        if (url.pathname.startsWith('/storage/v1/')) {
            // 只放行合約文件的上傳；其餘（含簽名網址）維持 404，和其他測項一致
            if (request.method() === 'POST' && url.pathname.startsWith('/storage/v1/object/contract-documents/')) return json(route, { Key: 'contract-documents/mock.pdf', Id: 'mock' });
            return json(route, {}, 404);
        }
        if (!url.pathname.startsWith('/rest/v1/')) return json(route, {}, 404);

        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        const reply = (list) => json(route, wantsObject ? (list[0] ?? null) : list);
        const method = request.method();

        if (table === 'instructors' && method !== 'GET') {
            const payload = request.postDataJSON();
            state.writes.push({ method, table, payload, search: url.search, role: persona.role });
            if (method === 'POST') return json(route, wantsObject ? {} : [], 201);
            const idEq = url.searchParams.get('id');
            const userEq = url.searchParams.get('user_id');
            const target = state.rows.find((r) => (idEq && idEq === `eq.${r.id}`) || (userEq && userEq === `eq.${r.user_id}`));
            if (!target) return reply([]);
            Object.assign(target, payload, { updated_at: new Date().toISOString() });
            return reply([target]);
        }
        if (method !== 'GET') {
            state.other.push({ method, table, payload: request.postDataJSON(), search: url.search });
            return route.fulfill({ status: 204, body: '' });
        }

        if (table === 'users') {
            const idEq = url.searchParams.get('id');
            if (idEq) return reply([profile]);
            return reply([profile, ...extraUsers]);
        }
        if (table === 'instructors') {
            const select = url.searchParams.get('select') || '';
            state.selects.push(select);
            // 模擬「資料庫還沒套用新欄位」：點名 personnel_types 的查詢會失敗，其餘照常
            if (state.legacyDb && select.includes('personnel_types')) {
                return json(route, { code: '42703', message: 'column instructors.personnel_types does not exist' }, 400);
            }
            const idEq = url.searchParams.get('id');
            const userEq = url.searchParams.get('user_id');
            let list = state.rows;
            if (idEq) list = list.filter((r) => idEq === `eq.${r.id}`);
            if (userEq) list = list.filter((r) => userEq === `eq.${r.user_id}`);
            if (state.legacyDb) list = list.map(({ personnel_types: _ignored, ...rest }) => rest);
            return reply(list);
        }
        if (table === 'instructor_contracts') return reply(contracts);
        if (table === 'contract_documents') return reply(contractDocs);
        return reply([]);
    };
    return { handler, session, state, persona };
};

const personas = {
    admin: { key: 'admin', role: 'admin', id: ids.admin, name: '測試管理員', email: 'admin@example.com' },
    staff: { key: 'staff', role: 'teacher', id: ids.staff, name: '王職員', email: 'staff@example.com' },
    incompleteInstr: { key: 'incompleteInstr', role: 'teacher', id: ids.incompleteInstr, name: '缺資料講師', email: 'incomplete@example.com' },
    incompleteLegacy: { key: 'incompleteLegacy', role: 'teacher', id: ids.incompleteLegacy, name: '缺資料舊講師', email: 'legacy@example.com' },
    noRoleInstr: { key: 'noRoleInstr', role: 'teacher', id: ids.noRoleInstr, name: '無等級講師', email: 'norole@example.com' },
};

// ───────────────────────── 執行 ─────────────────────────
async function run() {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const viteBin = path.join(appDir, 'node_modules', '.bin', 'vite');
    const vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite dev pid=${vite.pid} port=${port}`);
    let viteLog = '';
    vite.stdout.on('data', (chunk) => { viteLog += chunk; });
    vite.stderr.on('data', (chunk) => { viteLog += chunk; });
    let browser;
    const openPage = async (backend, { width = 1280, height = 1000, dialogs } = {}) => {
        const context = await browser.newContext({ viewport: { width, height } });
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: backend.session });
        await context.route('**/*', backend.handler);
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('dialog', async (dialog) => { dialogs?.push(dialog.message()); await dialog.accept(); });
        return { context, page, pageErrors };
    };
    const shot = (page, name) => page.screenshot({ path: path.join(shotDir, name), fullPage: true });
    // 勾選用的 <input> 是 sr-only，實際點的是外層 label
    const clickChip = (page, testId) => page.getByTestId(testId).locator('xpath=..').click();
    const optionTexts = (locator) => locator.locator('option').allTextContents();

    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* dev server starting */ }
            if (Date.now() > deadline) throw new Error(`vite dev did not start\n${viteLog}`);
            await sleep(250);
        }
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});

        // ═════════ A 講師編輯頁 ═════════
        const adminEdit = makeBackend({ persona: personas.admin, rows: adminRows() });
        const edit = await openPage(adminEdit);
        const editUrl = (n) => `${base}/admin/instructors/${rowId(n)}/edit`;
        await edit.page.goto(editUrl(1), { waitUntil: 'networkidle' });
        await edit.page.getByRole('heading', { name: '編輯講師資料' }).waitFor();

        await check('A1 編輯頁有「人員類別」三個勾選（講師已勾、其餘未勾），沒有舊的「業務狀態」', async () => {
            const group = edit.page.getByTestId('personnel-types-group');
            equal((await group.innerText()).includes('人員類別'), true, '標題');
            equal(await group.locator('input[type=checkbox]').count(), 3, '勾選數');
            equal(await edit.page.getByTestId('personnel-type-instructor').isChecked(), true, '講師');
            equal(await edit.page.getByTestId('personnel-type-staff').isChecked(), false, '職員');
            equal(await edit.page.getByTestId('personnel-type-part_time').isChecked(), false, '工讀計時');
            equal((await group.innerText()).replace(/\s+/g, ' ').includes('講師 職員 工讀計時'), true, '三個類別文字');
            equal(await edit.page.getByText('業務狀態').count(), 0, '舊標籤');
        });
        await check('A2 「合作狀態」下拉只有 合作中／冷凍／已離職，沒有 講師／職員／助教／工讀生', async () => {
            equal(await optionTexts(edit.page.getByLabel('合作狀態')), ['合作中', '冷凍', '已離職／停止合作'], '選項');
            equal(await edit.page.getByLabel('合作狀態').inputValue(), 'active', '預設值');
        });
        await check('A3 速解資格選項是「速解老師／速解大師」', async () => {
            equal(await optionTexts(edit.page.getByLabel('速解資格')), ['未設定', '速解老師', '速解大師'], '選項');
            equal(await edit.page.getByLabel('速解資格').inputValue(), 'speed_master', '現值');
        });
        await shot(edit.page, 'admin-edit-instructor.png');

        await check('A4 取消勾講師、改勾職員：講師等級／速解資格收起並顯示「不適用」', async () => {
            await clickChip(edit.page, 'personnel-type-instructor');
            await clickChip(edit.page, 'personnel-type-staff');
            equal(await edit.page.getByLabel('講師等級').count(), 0, '等級下拉');
            equal(await edit.page.getByLabel('速解資格').count(), 0, '速解下拉');
            equal((await edit.page.getByTestId('instructor-role-not-applicable').innerText()).includes('不適用'), true, '等級不適用');
            equal((await edit.page.getByTestId('speed-qualification-not-applicable').innerText()).includes('不適用'), true, '速解不適用');
        });
        await shot(edit.page, 'admin-edit-staff.png');
        await check('A5 存檔請求帶 personnel_types 陣列與 employment_status，且已存的等級／速解沒有被清掉', async () => {
            await edit.page.getByTestId('save-instructor').click();
            await edit.page.getByText('講師資料已更新。', { exact: true }).waitFor();
            const writes = adminEdit.state.writes;
            equal(writes.length, 1, '請求數');
            const { payload } = writes[0];
            equal(payload.personnel_types, ['staff'], 'personnel_types');
            equal(payload.employment_status, 'active', 'employment_status');
            equal(payload.instructor_role, 'A', '等級保留');
            equal(payload.speed_qualification, 'speed_master', '速解保留');
        });
        await check('A6 重新勾回講師：等級與速解下拉回來、原值還在；講師＋職員可同時勾', async () => {
            await clickChip(edit.page, 'personnel-type-instructor');
            equal(await edit.page.getByLabel('講師等級').inputValue(), 'A', '等級');
            equal(await edit.page.getByLabel('速解資格').inputValue(), 'speed_master', '速解');
            equal(await edit.page.getByTestId('personnel-type-staff').isChecked(), true, '職員仍勾');
        });
        await check('A7 合作狀態改冷凍後存檔，請求 employment_status=frozen、personnel_types 依勾選順序', async () => {
            await edit.page.getByLabel('合作狀態').selectOption('frozen');
            await edit.page.getByTestId('save-instructor').click();
            await waitUntil(() => adminEdit.state.writes.length === 2, '第二次存檔');
            const { payload } = adminEdit.state.writes[1];
            equal(payload.employment_status, 'frozen', 'employment_status');
            equal(payload.personnel_types, ['instructor', 'staff'], 'personnel_types');
        });
        await check('A8 人員類別全部取消：存檔被擋下、顯示訊息、沒有送出任何請求', async () => {
            await clickChip(edit.page, 'personnel-type-instructor');
            await clickChip(edit.page, 'personnel-type-staff');
            const before = adminEdit.state.writes.length;
            await edit.page.getByTestId('save-instructor').click();
            await edit.page.getByRole('alert').filter({ hasText: '人員類別至少要選一個' }).waitFor();
            await sleep(600);
            equal(adminEdit.state.writes.length, before, '請求數不變');
        });
        await check('A9 舊資料（沒有 personnel_types、合作狀態 NULL）：講師已勾、合作狀態顯示合作中、等級下拉在', async () => {
            await edit.page.goto(editUrl(4), { waitUntil: 'networkidle' });
            await edit.page.getByRole('heading', { name: '編輯講師資料' }).waitFor();
            equal(await edit.page.getByTestId('personnel-type-instructor').isChecked(), true, '講師');
            equal(await edit.page.getByTestId('personnel-type-staff').isChecked(), false, '職員');
            equal(await edit.page.getByLabel('合作狀態').inputValue(), 'active', '合作狀態');
            equal(await edit.page.getByLabel('講師等級').inputValue(), 'B', '等級');
        });
        await check('A10 編輯頁 390px 沒有水平溢出（人員類別勾選不撐破版面）', async () => {
            await edit.page.setViewportSize({ width: 390, height: 844 });
            await edit.page.goto(editUrl(2), { waitUntil: 'networkidle' });
            await edit.page.getByRole('heading', { name: '編輯講師資料' }).waitFor();
            const overflow = await edit.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            ok(overflow <= 1, `overflow=${overflow}`);
            equal(await edit.page.getByTestId('instructor-role-not-applicable').count(), 1, '職員頁等級不適用');
            await shot(edit.page, 'admin-edit-staff-390.png');
        });
        ok(edit.pageErrors.length === 0, `編輯頁有未捕捉錯誤：${edit.pageErrors.join('；')}`);
        await edit.context.close();

        // ═════════ B 講師資料總覽 ═════════
        const adminList = makeBackend({ persona: personas.admin, rows: adminRows() });
        const list = await openPage(adminList, { width: 1280 });
        await list.page.goto(`${base}/admin/instructors`, { waitUntil: 'networkidle' });
        await list.page.getByRole('heading', { name: '講師資料總覽' }).waitFor();
        await list.page.locator('table tbody tr').first().waitFor();
        const tableRow = (name) => list.page.locator('table tbody > tr').filter({ hasText: name });
        const visibleNames = () => list.page.locator('table tbody > tr td:first-child span.font-bold').allInnerTexts();

        await check('B1 合作狀態篩選只有 全部／合作中／冷凍／已離職，統計數正確（NULL 算合作中）', async () => {
            const bar = list.page.locator('button.bh-chip');
            const labels = (await bar.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
            ok(labels.includes('全部合作狀態'), `缺少「全部合作狀態」：${labels.join('|')}`);
            ok(labels.includes('合作中 5'), `合作中應為 5：${labels.join('|')}`);
            ok(labels.includes('冷凍 1'), `冷凍應為 1：${labels.join('|')}`);
            ok(labels.includes('已離職／停止合作 1'), `已離職應為 1：${labels.join('|')}`);
            ok(!labels.some((t) => /^(職員|助教|工讀生)/.test(t)), `不該再有身分類的狀態：${labels.join('|')}`);
        });
        await check('B2 人員類別篩選：選項與統計（講師 4、職員 3、工讀計時 2，舊資料算講師）', async () => {
            equal(await optionTexts(list.page.getByLabel('人員類別篩選')), ['全部人員類別', '講師 4', '職員 3', '工讀計時 2'], '選項');
        });
        await check('B3 用「職員」篩選只剩有職員類別的人（林講師、舊資料老師不在）', async () => {
            await list.page.getByLabel('人員類別篩選').selectOption('staff');
            const names = (await visibleNames()).sort();
            equal(names, [WORST_CASE_NAME, '王職員', '雙身分'].sort(), '剩下的人');
        });
        await check('B4 職員列的等級、速解欄顯示「不適用」且沒有等級下拉；講師列有下拉', async () => {
            const staffRow = tableRow('王職員');
            equal(await staffRow.getByTestId('not-applicable').count(), 2, '不適用數');
            equal(await staffRow.locator('select').count(), 0, '下拉數');
            await shot(list.page, 'list-staff-filter-1280.png');
            await list.page.getByLabel('人員類別篩選').selectOption('');
            const instrRow = tableRow('林講師');
            equal(await instrRow.getByTestId('not-applicable').count(), 0, '講師列不適用數');
            equal(await instrRow.locator('select').count(), 1, '講師列下拉數');
            equal((await instrRow.innerText()).includes('速解大師'), true, '速解大師');
        });
        await check('B5 非講師顯示小標籤（職員／工讀計時／講師・職員），純講師與舊資料不顯示', async () => {
            const tagText = async (name) => {
                const tags = tableRow(name).getByTestId('personnel-tag');
                return (await tags.count()) ? (await tags.first().innerText()).trim() : null;
            };
            equal(await tagText('王職員'), '職員', '王職員標籤');
            equal(await tagText('陳工讀'), '工讀計時', '陳工讀標籤');
            equal(await tagText('雙身分'), '講師・職員', '雙身分標籤');
            equal(await tagText('林講師'), null, '林講師無標籤');
            equal(await tagText('舊資料老師'), null, '舊資料無標籤');
        });
        await check('B6 「講師」篩選包含舊資料與雙身分，不含純職員／純工讀', async () => {
            await list.page.getByLabel('人員類別篩選').selectOption('instructor');
            equal((await visibleNames()).sort(), ['林講師', '簽約講師', '舊資料老師', '雙身分'].sort(), '講師們');
            await list.page.getByLabel('人員類別篩選').selectOption('');
        });
        await check('B7 舊資料列（沒有 personnel_types、合作狀態 NULL）當講師：有等級下拉、合作狀態顯示合作中', async () => {
            const legacyRow = tableRow('舊資料老師');
            equal(await legacyRow.locator('select').count(), 1, '下拉');
            equal(await legacyRow.getByTestId('not-applicable').count(), 0, '不適用');
            equal((await legacyRow.innerText()).includes('合作中'), true, '合作中');
        });
        await check('B8 合作狀態篩選「冷凍」只剩陳工讀', async () => {
            await list.page.getByRole('button', { name: '冷凍 1' }).click();
            equal(await visibleNames(), ['陳工讀'], '冷凍的人');
            await list.page.getByRole('button', { name: '冷凍 1' }).click();
        });
        const roleSelect = list.page.locator('select:has(option:text-is("全部等級"))');
        const speedSelect = list.page.locator('select:has(option:text-is("全部速解資格"))');
        // 篩選條件要在斷言失敗時也清掉，否則一項失敗會連累後面的測項
        const withFilters = async (fn) => {
            try { await fn(); } finally {
                await roleSelect.selectOption('');
                await speedSelect.selectOption('');
            }
        };
        await check('B14 等級篩選「A 級」：講師照常出現，已存了 A 級的職員不在結果中；「S 級」只剩雙身分（也是講師）', () => withFilters(async () => {
            await roleSelect.selectOption('A');
            const names = (await visibleNames()).sort();
            equal(names, ['林講師', '簽約講師'].sort(), 'A 級的人');
            ok(!names.includes('王職員'), '王職員（職員，已存 A 級）不該出現');
            await roleSelect.selectOption('S');
            equal(await visibleNames(), ['雙身分'], 'S 級的人');
        }));
        await check('B15 速解篩選「未取得」：只有沒速解資格的講師，職員／工讀（含已存速解的陳工讀）都不在結果中', () => withFilters(async () => {
            await speedSelect.selectOption('none');
            const names = (await visibleNames()).sort();
            equal(names, ['舊資料老師', '簽約講師', '雙身分'].sort(), '未取得的人');
            ok(!names.includes('王職員') && !names.includes('歐陽長名字職員') && !names.includes('陳工讀'), '非講師不該出現');
        }));
        await check('B16 速解篩選「速解大師」：只剩林講師（已存速解大師的工讀不出現）；等級＋速解同時篩選照樣排除非講師', () => withFilters(async () => {
            await speedSelect.selectOption('speed_master');
            equal(await visibleNames(), ['林講師'], '速解大師的人');
            await roleSelect.selectOption('B');
            equal(await visibleNames(), [], '等級 B＋速解大師（陳工讀是 B 級＋速解大師但非講師）');
            await roleSelect.selectOption('');
            await speedSelect.selectOption('');
            equal((await visibleNames()).length, 7, '清掉篩選後 7 列都回來');
        }));

        const measureLayout = (page) => page.evaluate(() => {
            const lineCount = (el) => {
                const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                const rects = [];
                while (walker.nextNode()) {
                    if (!walker.currentNode.textContent.trim()) continue;
                    const range = document.createRange();
                    range.selectNodeContents(walker.currentNode);
                    rects.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
                }
                if (!rects.length) return 0;
                const lineHeight = Math.min(...rects.map((r) => r.height));
                return Math.round((Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top))) / lineHeight);
            };
            const table = document.querySelector('table');
            if (!table || table.offsetParent === null) return { tableVisible: false };
            const wrapper = table.parentElement;
            const wrapRect = wrapper.getBoundingClientRect();
            return {
                tableVisible: true,
                headers: [...table.querySelectorAll('thead th')].map((th) => ({ text: th.innerText.trim(), lines: lineCount(th) })),
                chips: [...table.querySelectorAll('tbody span.bh-chip')].map((el) => ({ text: el.innerText.trim(), lines: lineCount(el) })),
                notApplicable: [...table.querySelectorAll('tbody [data-testid=not-applicable]')].map((el) => lineCount(el)),
                names: [...table.querySelectorAll('tbody tr td:first-child span.font-bold')].map((el) => lineCount(el)),
                rows: [...table.querySelectorAll('tbody > tr')].map((tr) => ({
                    name: tr.querySelector('td:first-child span.font-bold')?.innerText.trim() || '',
                    height: Math.round(tr.getBoundingClientRect().height),
                })),
                buttons: [...table.querySelectorAll('tbody .bh-btn')].map((el) => ({ lines: lineCount(el), clipped: el.getBoundingClientRect().right > wrapRect.right - 2 })),
                wrapperOverflow: wrapper.scrollWidth - wrapper.clientWidth,
                docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
        });
        for (const width of [1024, 1280]) {
            await check(`B9 ${width}px 表格含職員／工讀列：表頭與所有標籤只佔一行、「不適用」不換行、不超出外框、按鈕沒被切掉`, async () => {
                await list.page.setViewportSize({ width, height: 1000 });
                await list.page.waitForTimeout(150);
                const m = await measureLayout(list.page);
                ok(m.tableVisible, '表格沒顯示');
                ok(m.headers.length === 7 && m.headers.every((h) => h.lines === 1), `表頭：${m.headers.map((h) => `${h.text}=${h.lines}`).join('、')}`);
                ok(m.chips.length > 0 && m.chips.every((c) => c.lines === 1), `標籤換行：${m.chips.filter((c) => c.lines !== 1).map((c) => c.text).join('、')}`);
                ok(m.notApplicable.length === 6 && m.notApplicable.every((n) => n === 1), `不適用：${m.notApplicable.join('/')}`);
                ok(m.names.every((n) => n === 1), '姓名換行');
                ok(m.buttons.every((b) => b.lines === 1 && !b.clipped), `按鈕換行或被切掉（表格超出外框 ${m.wrapperOverflow}px）`);
                ok(m.wrapperOverflow <= 0, `表格超出外框 ${m.wrapperOverflow}px`);
                ok(m.docOverflow <= 0, `整頁橫向溢出 ${m.docOverflow}px`);
                // 最極端的一列（長姓名＋已離職＋兩個人員類別）在 1024px 允許標籤換到第二行，其餘列高仍須一致
                const heights = m.rows.filter((r) => r.name !== WORST_CASE_NAME).map((r) => r.height);
                ok(Math.max(...heights) <= 80 && Math.max(...heights) - Math.min(...heights) <= 4, `列高：${m.rows.map((r) => `${r.name}=${r.height}`).join('/')}`);
                const worst = m.rows.find((r) => r.name === WORST_CASE_NAME).height;
                ok(width === 1024 ? worst <= 110 : worst <= 80, `最極端列高 ${worst}px`);
                await shot(list.page, `list-${width}.png`);
            });
        }
        await check('B10 900px 卡片版：職員卡片有標籤與「不適用」，整頁無橫向捲軸', async () => {
            await list.page.setViewportSize({ width: 900, height: 1000 });
            await list.page.waitForTimeout(150);
            const m = await measureLayout(list.page);
            ok(!m.tableVisible, '應改顯示卡片');
            const cardOverflow = await list.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            const staffCard = list.page.locator('.lg\\:hidden > .bh-card').filter({ hasText: '王職員' });
            equal(await staffCard.getByTestId('personnel-tag').count(), 1, '職員標籤');
            equal(await staffCard.getByTestId('not-applicable').count(), 2, '不適用數');
            equal(await staffCard.locator('select').count(), 0, '下拉數');
            ok(cardOverflow <= 0, `整頁橫向溢出 ${cardOverflow}px`);
            await shot(list.page, 'list-cards-900.png');
            await list.page.setViewportSize({ width: 1280, height: 1000 });
        });

        await check('B11 新增人員表單：人員類別預設講師、合作狀態預設合作中；取消講師後等級／速解收起', async () => {
            await list.page.getByRole('button', { name: /新增講師/ }).click();
            const modal = list.page.locator('form');
            equal(await list.page.getByTestId('add-personnel-type-instructor').isChecked(), true, '講師預設勾');
            equal(await list.page.getByTestId('add-personnel-type-staff').isChecked(), false, '職員預設不勾');
            equal(await modal.locator('select').first().inputValue(), 'active', '合作狀態預設');
            equal(await optionTexts(modal.locator('select').first()), ['合作中', '冷凍', '已離職／停止合作'], '合作狀態選項');
            equal(await modal.locator('select').count(), 3, '講師時有 3 個下拉');
            await shot(list.page, 'add-modal-instructor.png');
            await clickChip(list.page, 'add-personnel-type-instructor');
            await clickChip(list.page, 'add-personnel-type-staff');
            equal(await modal.locator('select').count(), 1, '非講師只剩合作狀態下拉');
            await shot(list.page, 'add-modal-staff.png');
        });
        await check('B12 新增職員：請求帶 personnel_types=[staff]、合作狀態 active、等級與速解為空', async () => {
            const modal = list.page.locator('form');
            await modal.locator('input[type=text]').first().fill('新進職員');
            await modal.locator('input[type=email]').fill('new-staff@example.com');
            await modal.getByRole('button', { name: '新增', exact: true }).click();
            await waitUntil(() => adminList.state.writes.some((w) => w.method === 'POST'), '新增請求');
            const { payload } = adminList.state.writes.find((w) => w.method === 'POST');
            equal(payload.personnel_types, ['staff'], 'personnel_types');
            equal(payload.employment_status, 'active', 'employment_status');
            equal([payload.instructor_role, payload.speed_qualification], [null, null], '等級與速解');
            equal(payload.full_name, '新進職員', '姓名');
        });
        await check('B13 新增表單人員類別全不勾：顯示訊息、沒有送出請求', async () => {
            await list.page.getByRole('button', { name: /新增講師/ }).click();
            const modal = list.page.locator('form');
            await clickChip(list.page, 'add-personnel-type-instructor');
            await modal.locator('input[type=text]').first().fill('沒有類別的人');
            await modal.locator('input[type=email]').fill('none@example.com');
            const before = adminList.state.writes.filter((w) => w.method === 'POST').length;
            await modal.getByRole('button', { name: '新增', exact: true }).click();
            await list.page.getByText('人員類別至少要選一個').waitFor();
            await sleep(400);
            equal(adminList.state.writes.filter((w) => w.method === 'POST').length, before, 'POST 數不變');
        });
        ok(list.pageErrors.length === 0, `總覽頁有未捕捉錯誤：${list.pageErrors.join('；')}`);
        await list.context.close();

        // ═════════ C 個人資料頁 ═════════
        const staffRow = completeInstructor(20, { full_name: '王職員', personnel_types: ['staff'], ...withoutTeaching, user_id: ids.staff });
        const staffBackend = makeBackend({ persona: personas.staff, rows: [staffRow] });
        const staffDialogs = [];
        const staffProfile = await openPage(staffBackend, { dialogs: staffDialogs });
        await staffProfile.page.goto(`${base}/profile`, { waitUntil: 'networkidle' });
        await staffProfile.page.getByRole('heading', { name: '個人資料', exact: true }).waitFor();
        await check('C1 純職員的個人資料頁：看不到講師等級、速解、接課頻率、可接課地區、經歷與自我介紹；顯示人員類別', async () => {
            const body = await staffProfile.page.locator('body').innerText();
            // 「講師等級」「速解專業資格」只檢查欄位標題本身（頁面上的說明文字會提到它們）
            for (const label of ['講師等級', '速解專業資格']) {
                equal(await staffProfile.page.getByText(label, { exact: true }).count(), 0, `欄位「${label}」`);
            }
            for (const text of ['接課頻率', '可接課地區', '經歷與自我介紹', '教學經歷 / 教學理念']) {
                ok(!body.includes(text), `不該出現「${text}」`);
            }
            const types = staffProfile.page.getByTestId('personnel-types-readonly');
            equal((await types.innerText()).includes('職員'), true, '人員類別顯示職員');
            await shot(staffProfile.page, 'profile-staff.png');
        });
        await check('C6 純職員的個人資料頁沒有「合約簽署」區塊（尚未簽約／前往簽約）', async () => {
            const body = await staffProfile.page.locator('body').innerText();
            for (const text of ['合約簽署', '尚未簽約', '前往簽約']) ok(!body.includes(text), `不該出現「${text}」`);
        });
        await check('C2 純職員沒填接課資料也能存檔：沒有「請先補齊」、有送出請求，且請求不帶管理員專屬欄位', async () => {
            await staffProfile.page.getByRole('button', { name: '儲存個人資料' }).click();
            await waitUntil(() => staffDialogs.some((m) => m.includes('個人資料已儲存')), '儲存成功訊息');
            ok(!staffDialogs.some((m) => m.includes('請先補齊')), `不該被擋：${staffDialogs.join('｜')}`);
            const write = staffBackend.state.writes.find((w) => w.method === 'PATCH');
            ok(write, '沒有送出 PATCH');
            for (const field of ['personnel_types', 'employment_status', 'instructor_role', 'speed_qualification']) {
                ok(!Object.hasOwn(write.payload, field), `請求不該帶 ${field}`);
            }
        });
        await check('C3 完整的純職員不會被「資料未填完」強制導回個人資料頁（可進課程列表）', async () => {
            await staffProfile.page.goto(`${base}/courses`, { waitUntil: 'networkidle' });
            await sleep(500);
            equal(new URL(staffProfile.page.url()).pathname, '/courses', '網址');
        });
        ok(staffProfile.pageErrors.length === 0, `個人頁有未捕捉錯誤：${staffProfile.pageErrors.join('；')}`);

        // ═════════ D 課程列表（沿用純職員的 session）═════════
        const NON_INSTRUCTOR_NOTICE = '你的人員類別不是講師，僅能瀏覽開放給全部人員的課程分類。';
        await check('D1 純職員的課程列表顯示「人員類別不是講師」提示，且不是舊的「講師等級尚未設定」', async () => {
            const body = await staffProfile.page.locator('body').innerText();
            ok(body.includes(NON_INSTRUCTOR_NOTICE), '缺少新提示');
            ok(!body.includes('講師等級尚未設定'), '不該出現舊提示');
            await shot(staffProfile.page, 'courses-staff.png');
        });
        await staffProfile.context.close();

        const noRoleRow = completeInstructor(21, { full_name: '無等級講師', personnel_types: ['instructor'], instructor_role: null, user_id: ids.noRoleInstr });
        const noRole = await openPage(makeBackend({ persona: personas.noRoleInstr, rows: [noRoleRow] }));
        await noRole.page.goto(`${base}/courses`, { waitUntil: 'networkidle' });
        await check('D2 等級未設定的講師仍看到原本的「講師等級尚未設定」提示', async () => {
            const body = await noRole.page.locator('body').innerText();
            ok(body.includes('講師等級尚未設定'), '缺少原提示');
            ok(!body.includes(NON_INSTRUCTOR_NOTICE), '不該出現非講師提示');
        });
        await noRole.context.close();

        const legacyDbRow = completeInstructor(22, { full_name: '舊庫講師', instructor_role: null, user_id: ids.noRoleInstr });
        const legacyDb = makeBackend({ persona: personas.noRoleInstr, rows: [legacyDbRow], legacyDb: true });
        const legacyDbPage = await openPage(legacyDb);
        await legacyDbPage.page.goto(`${base}/courses`, { waitUntil: 'networkidle' });
        await check('D3 資料庫還沒有 personnel_types 欄位：課程列表照常載入並當作講師（退回舊查詢，沒有壞掉）', async () => {
            const body = await legacyDbPage.page.locator('body').innerText();
            ok(body.includes('講師等級尚未設定'), '應退回講師的原提示');
            ok(legacyDb.state.selects.some((s) => s.includes('personnel_types')), '應先試新欄位');
            ok(legacyDb.state.selects.some((s) => s === 'instructor_role'), '應退回只查 instructor_role');
            ok(legacyDbPage.pageErrors.length === 0, `未捕捉錯誤：${legacyDbPage.pageErrors.join('；')}`);
        });
        await legacyDbPage.context.close();

        // ═════════ C（續）講師沒填仍被擋 ═════════
        const incompleteDefs = [
            ['C4 講師（人員類別=講師）沒填接課頻率／經歷／接課地區：儲存被擋並列出缺項，沒有送出請求', personas.incompleteInstr, { personnel_types: ['instructor'] }],
            ['C5 舊資料講師（沒有 personnel_types）同樣被擋，且畫面仍有講師等級與接課欄位', personas.incompleteLegacy, {}],
        ];
        for (const [name, persona, extra] of incompleteDefs) {
            await check(name, async () => {
                const row = completeInstructor(30, { full_name: '缺資料講師', ...withoutTeaching, instructor_role: 'A', user_id: persona.id, ...extra });
                const backend = makeBackend({ persona, rows: [row] });
                const dialogs = [];
                const opened = await openPage(backend, { dialogs });
                await opened.page.goto(`${base}/profile`, { waitUntil: 'networkidle' });
                await opened.page.getByRole('heading', { name: '個人資料', exact: true }).waitFor();
                const body = await opened.page.locator('body').innerText();
                for (const text of ['講師等級', '速解專業資格', '接課頻率（學期間）', '可接課地區', '教學經歷 / 教學理念']) {
                    ok(body.includes(text), `講師應看到「${text}」`);
                }
                await check(`C7 ${persona.key === 'incompleteInstr' ? '講師' : '舊資料講師'}的個人資料頁仍有「合約簽署」區塊（尚未簽約、前往簽約）`, async () => {
                    await opened.page.getByText('合約簽署', { exact: true }).waitFor({ timeout: 8000 });
                    const text = await opened.page.locator('body').innerText();
                    ok(text.includes('尚未簽約') && text.includes('前往簽約'), '缺少簽約入口');
                });
                await opened.page.getByRole('button', { name: '儲存個人資料' }).click();
                await waitUntil(() => dialogs.some((m) => m.includes('請先補齊以下資料')), '補齊提示');
                const message = dialogs.find((m) => m.includes('請先補齊以下資料'));
                for (const item of ['接課頻率（學期間）', '接課頻率（寒暑假）', '經歷 / 理念', '主要接課地區']) {
                    ok(message.includes(item), `缺項應包含「${item}」`);
                }
                await sleep(300);
                equal(backend.state.writes.length, 0, '請求數');
                await opened.context.close();
            });
        }

        // ═════════ E 合約管理 ═════════
        const signedContract = { id: 'c-1', user_id: ids.signed, status: 'signed', signed_at: NOW, doc_versions: {}, contract_doc_version: 1 };
        const contractUsers = [
            { id: ids.instr, name: '林講師', email: 'instr@example.com', role: 'teacher' },
            { id: ids.staff, name: '王職員', email: 'staff@example.com', role: 'teacher' },
            { id: ids.legacy, name: '舊資料老師', email: 'legacy@example.com', role: 'teacher' },
            { id: ids.signed, name: '簽約講師', email: 'signed@example.com', role: 'teacher' },
        ];
        const contractBackend = makeBackend({ persona: personas.admin, rows: adminRows(), extraUsers: contractUsers, contracts: [signedContract] });
        const contractPage = await openPage(contractBackend);
        await contractPage.page.goto(`${base}/admin/contracts`, { waitUntil: 'networkidle' });
        await contractPage.page.getByRole('heading', { name: '合約文件管理' }).waitFor();
        const stats = () => contractPage.page.evaluate(() => Object.fromEntries(
            [...document.querySelectorAll('.text-4xl')].map((el) => [el.nextElementSibling?.innerText.trim(), Number(el.innerText)]),
        ));
        await check('E1 合約管理：總人數 5、已簽約 1、未簽約 3（純職員不算未簽約）', async () => {
            equal(await stats(), { 總人數: 5, 已簽約: 1, 未簽約: 3 }, '統計卡');
        });
        await check('E2 合約管理列表：職員列標「非講師，不需簽約」，講師與舊資料列仍是「未簽約」', async () => {
            const rowsOf = (name) => contractPage.page.locator('table tbody tr').filter({ hasText: name });
            const staffText = (await rowsOf('王職員').first().innerText()).replace(/\s+/g, ' ');
            ok(staffText.includes('非講師，不需簽約') && !staffText.includes('未簽約'), `職員列：${staffText}`);
            for (const name of ['林講師', '舊資料老師']) {
                const text = (await rowsOf(name).first().innerText()).replace(/\s+/g, ' ');
                ok(text.includes('未簽約') && !text.includes('非講師'), `${name}列：${text}`);
            }
            equal((await rowsOf('簽約講師').first().innerText()).includes('已簽約'), true, '簽約講師');
            await shot(contractPage.page, 'contracts.png');
        });
        ok(contractPage.pageErrors.length === 0, `合約頁有未捕捉錯誤：${contractPage.pageErrors.join('；')}`);
        await contractPage.context.close();

        const contractLegacy = makeBackend({ persona: personas.admin, rows: adminRows(), extraUsers: contractUsers, contracts: [signedContract], legacyDb: true });
        const contractLegacyPage = await openPage(contractLegacy);
        await contractLegacyPage.page.goto(`${base}/admin/contracts`, { waitUntil: 'networkidle' });
        await contractLegacyPage.page.getByRole('heading', { name: '合約文件管理' }).waitFor();
        await check('E3 資料庫還沒有 personnel_types 欄位：合約管理照常載入、姓名正常、全部當講師（未簽約 4）', async () => {
            const statsNow = await contractLegacyPage.page.evaluate(() => Object.fromEntries(
                [...document.querySelectorAll('.text-4xl')].map((el) => [el.nextElementSibling?.innerText.trim(), Number(el.innerText)]),
            ));
            equal(statsNow, { 總人數: 5, 已簽約: 1, 未簽約: 4 }, '統計卡');
            ok((await contractLegacyPage.page.locator('table tbody tr').filter({ hasText: '王職員' }).first().innerText()).includes('未簽約'), '舊庫時職員當講師');
        });
        await contractLegacyPage.context.close();

        const uploadDoc = {
            id: 'doc-1', doc_type: 'rules', version: 1, display_name: '工作規則', doc_mode: 'view_only', sort_order: 1,
            is_active: true, doc_category: 'contract', file_path: 'templates/rules/v1.pdf', file_name: 'rules.pdf',
        };
        const uploadBackend = makeBackend({ persona: personas.admin, rows: adminRows(), extraUsers: contractUsers, contracts: [signedContract], contractDocs: [uploadDoc] });
        const uploadDialogs = [];
        const uploadPage = await openPage(uploadBackend, { dialogs: uploadDialogs });
        await uploadPage.page.goto(`${base}/admin/contracts`, { waitUntil: 'networkidle' });
        await uploadPage.page.getByRole('heading', { name: '合約文件管理' }).waitFor();
        await check('E4 上傳新版合約文件：「合約文件已更新」通知只寄給需簽約的人，職員不在收件人裡', async () => {
            await uploadPage.page.locator('input[type=file][accept="application/pdf"]').first().setInputFiles({
                name: 'rules-v2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%mock\n'),
            });
            await waitUntil(() => uploadDialogs.some((m) => m.includes('上傳成功')), '上傳成功訊息');
            ok(uploadBackend.state.other.some((w) => w.table === 'contract_documents' && w.method === 'POST'), '新版文件沒有寫入');
            const notifications = uploadBackend.state.other
                .filter((w) => w.table === 'notifications' && w.method === 'POST')
                .flatMap((w) => w.payload);
            ok(notifications.length > 0, '沒有送出任何通知');
            const recipients = notifications.map((n) => n.user_id).sort();
            ok(!recipients.includes(ids.staff), '職員不該收到合約更新通知');
            equal(recipients, [ids.admin, ids.instr, ids.legacy, ids.signed].sort(), '通知收件人（管理員、林講師、舊資料老師、簽約講師）');
            ok(notifications.every((n) => n.title === '合約文件已更新' && n.type === 'contract'), '通知內容');
        });
        ok(uploadPage.pageErrors.length === 0, `上傳頁有未捕捉錯誤：${uploadPage.pageErrors.join('；')}`);
        await uploadPage.context.close();

        // ═════════ F 死選項 ═════════
        await check('F1 個人資料頁、待審作業頁、編輯頁的原始碼不再有「職員／工讀生」等級與「助教」業務狀態', async () => {
            const read = (file) => readFileSync(path.join(appDir, file), 'utf8');
            ok(!/value: '職員'|value: '工讀生'/.test(read('src/pages/ProfilePage.jsx')), 'ProfilePage 還有死選項');
            ok(!/'職員': '職員'|'工讀生': '工讀生'/.test(read('src/pages/admin/AssignmentReview.jsx')), 'AssignmentReview 還有死標籤');
            const editSource = read('src/pages/admin/AdminInstructorEdit.jsx');
            ok(!/label: '助教'|label: '工讀生'|業務狀態/.test(editSource), 'AdminInstructorEdit 還有舊業務狀態選項');
            ok(!/速解講師|速解師傅/.test(editSource), 'AdminInstructorEdit 還有舊速解名稱');
        });
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }
    const failed = results.filter((r) => !r).length;
    console.log(`\n${results.length - failed}/${results.length} PASS  screenshots: ${path.relative(appDir, shotDir)}`);
    if (failed) process.exit(1);
}

run().catch((error) => { console.error(error); process.exit(1); });
