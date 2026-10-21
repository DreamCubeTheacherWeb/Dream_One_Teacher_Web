#!/usr/bin/env node
/*
 * 瀏覽器回歸（mock Supabase）：後台「老師資料追蹤」與「只填姓名新增老師」。
 *   - /admin/instructors：進度標籤、進度篩選（含 ?progress=todo 預選）、Google 登入 Email、姓名認領標籤與解綁說明
 *   - 新增 modal：只填姓名（多行、同名提示與確認勾選、同批重複）與完整資料兩種模式
 *   - 刪除空位（只限乾淨的空位）
 *   - /admin/teachers：待審核帳號旁的同名空位警示
 *   - /admin：老師資料追蹤卡
 *   - 輔導員（20261022010000 起只拿到名冊）：沒有追蹤卡、進度篩選與進度欄，也不查簽約／啟用紀錄
 * 用法：node scripts/verify-teacher-progress-ui.mjs（會先 npm run build，再自己起 preview）
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(process.env.VERIFY_SHOT_DIR || tmpdir(), 'teacher-progress-shots');
mkdirSync(shotDir, { recursive: true });

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();

// ── 測試資料 ─────────────────────────────────────────────────
const uid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const ADMIN_ID = uid(1);
const U_CLAIMED_SLOT = uid(12);
const U_PENDING = uid(13);
const U_CONTRACT_MISSING = uid(14);
const U_SIGNED = uid(15);

const completeFields = {
  nickname: '老師', gender: '女', birth_date: '1990-01-01', id_number: 'A123456789',
  phone_mobile: '0912345678', line_id: 'line', address: '通訊地址', household_address: '戶籍地址',
  teaching_freq_semester: '每週一次', teaching_freq_vacation: '每週一次', teaching_regions: ['臺北市'],
  bio_notes: '經歷', bank_account_name: '老師', bank_name: '銀行', bank_branch: '分行',
  bank_account_number: '1234567890', bank_code: '1234567',
  id_front_path: 'front.jpg', id_back_path: 'back.jpg', bankbook_path: 'bank.jpg',
};
const row = (n, overrides) => ({
  id: `10000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  user_id: null, employment_status: 'active', name_slot: false, created_at: now, ...overrides,
});
const makeInstructors = () => [
  // s1：乾淨的空位（沒人認領）→ 未認領，可刪除
  row(1, { full_name: '王小明', name_slot: true }),
  // 同名的另一個空位，已被認領但資料還沒填完 → 資料未完整 + 姓名認領
  row(2, { full_name: '王小明', name_slot: true, user_id: U_CLAIMED_SLOT, phone_mobile: '0911111111' }),
  // 自己「新建帳號」註冊、等審核 → 待審核
  row(3, { full_name: '李新建', user_id: U_PENDING, email_primary: 'new@example.com', nickname: '新' }),
  // 後台另外有一個同名空位（可能是同一人選錯）→ 帳號審核頁要警示
  row(4, { full_name: '李新建', name_slot: true }),
  // 資料完整、合約只有作廢 → 待簽約
  row(5, { full_name: '陳完整', user_id: U_CONTRACT_MISSING, email_primary: 'chen@example.com', ...completeFields }),
  // 資料完整、有 signed 合約 → 已完成
  row(6, { full_name: '林已簽', user_id: U_SIGNED, email_primary: 'lin@example.com', ...completeFields }),
  // 離職且沒人認領 → 已停用
  row(7, { full_name: '張離職', employment_status: 'cancelled' }),
  // 匯入的完整舊資料，沒人認領 → 未認領（但不是乾淨空位，不能刪）
  row(8, { full_name: '趙匯入', email_primary: 'zhao@example.com', ...completeFields }),
];
let instructors = makeInstructors();
const makeUsers = () => [
  { id: ADMIN_ID, name: '測試管理員', email: 'admin@example.com', role: 'admin', created_at: now },
  { id: U_CLAIMED_SLOT, name: '王 小明', email: 'wang.google@gmail.com', role: 'teacher', created_at: now },
  { id: U_PENDING, name: '李新建', email: 'new@example.com', role: 'pending', created_at: now },
  { id: U_CONTRACT_MISSING, name: '陳完整', email: 'chen@example.com', role: 'teacher', created_at: now },
  { id: U_SIGNED, name: '林已簽', email: 'lin.login@gmail.com', role: 'teacher', created_at: now },
];
const contracts = [
  { id: 'c1', user_id: U_CONTRACT_MISSING, status: 'voided' },
  { id: 'c2', user_id: U_SIGNED, status: 'signed' },
];

let inserts = [];
let deletes = [];
let rpcCalls = [];
let contractReads = 0;

const makeSession = (role) => {
  const id = role === 'admin' ? ADMIN_ID : uid(2);
  const user = {
    id, aud: 'authenticated', role: 'authenticated', email: `${role}@example.com`,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: role === 'admin' ? '測試管理員' : '測試輔導員' },
    created_at: now, updated_at: now,
  };
  return {
    user,
    session: {
      access_token: `mock.${role}.token`, refresh_token: `mock.${role}.refresh`, token_type: 'bearer',
      expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user,
    },
    profile: { id, name: user.user_metadata.full_name, email: user.email, role, created_at: now },
  };
};

const respond = (route, body, status = 200) => {
  const headers = { 'content-type': 'application/json' };
  if (Array.isArray(body)) headers['content-range'] = body.length ? `0-${body.length - 1}/${body.length}` : '*/0';
  return route.fulfill({ status, headers, body: JSON.stringify(body) });
};

const routeHandler = (baseUrl, { user, session, profile }) => async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === baseUrl) return route.continue();
  if (!url.hostname.endsWith('.supabase.co')) return route.abort();

  if (url.pathname.startsWith('/auth/v1/')) {
    if (url.pathname === '/auth/v1/user') return respond(route, user);
    if (url.pathname.startsWith('/auth/v1/token')) return respond(route, session);
    return respond(route, {});
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const name = url.pathname.split('/').pop();
    rpcCalls.push(name);
    if (name === 'claim_my_precreated_instructor') return respond(route, { status: 'staff' });
    if (name === 'mentor_instructor_directory') {
      const keys = ['id', 'user_id', 'full_name', 'nickname', 'instructor_role', 'employment_status', 'teaching_regions', 'speed_qualification'];
      return respond(route, instructors.map((item) => Object.fromEntries(keys.map((key) => [key, item[key] ?? null]))));
    }
    return respond(route, null);
  }
  if (!url.pathname.startsWith('/rest/v1/')) return respond(route, {}, 404);

  const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
  const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
  const method = request.method();

  if (table === 'instructors' && method === 'POST') {
    const payload = request.postDataJSON();
    inserts.push(payload);
    const created = (Array.isArray(payload) ? payload : [payload]).map((item, index) => {
      const row = { id: `20000000-0000-4000-8000-0000000000${String(inserts.length * 10 + index).padStart(2, '0')}`, created_at: now, user_id: null, ...item };
      instructors.push(row);
      return row;
    });
    // 完整資料模式用 .insert().select('id').single() 取回新列 id，再登錄已確認 Email。
    if (wantsObject) return respond(route, { id: created[0].id }, 201);
    return route.fulfill({ status: 201, body: '' });
  }
  if (table === 'instructors' && method === 'DELETE') {
    const idFilter = url.searchParams.get('id');
    deletes.push(Object.fromEntries(url.searchParams.entries()));
    const target = instructors.find((item) => idFilter === `eq.${item.id}`
      && url.searchParams.get('name_slot') === 'eq.true' && url.searchParams.get('user_id') === 'is.null'
      && item.name_slot && !item.user_id);
    if (target) instructors = instructors.filter((item) => item.id !== target.id);
    return respond(route, target ? [{ id: target.id }] : []);
  }
  if (method !== 'GET') return route.fulfill({ status: 204, body: '' });

  let rows = [];
  if (table === 'users') {
    const everyone = [...makeUsers(), ...(makeUsers().some((item) => item.id === profile.id) ? [] : [profile])];
    const idFilter = url.searchParams.get('id');
    rows = idFilter ? everyone.filter((item) => idFilter === `eq.${item.id}`) : everyone;
  } else if (table === 'instructors') {
    const idFilter = url.searchParams.get('id');
    const userFilter = url.searchParams.get('user_id');
    // 20261022010000 起輔導員讀不到講師主檔表（只能走名冊函式）
    if (profile.role === 'mentor') rows = [];
    else if (idFilter) rows = instructors.filter((item) => idFilter === `eq.${item.id}`);
    else if (userFilter) rows = instructors.filter((item) => userFilter === `eq.${item.user_id}`);
    else rows = instructors;
  } else if (table === 'instructor_contracts') {
    contractReads += 1;
    // 與資料庫相同：只有管理員讀得到（輔導員會拿到空陣列，所以前端不能靠回傳判斷權限）
    rows = profile.role === 'admin'
      ? contracts.filter((item) => !url.searchParams.get('status') || url.searchParams.get('status') === `eq.${item.status}`)
      : [];
  }
  return respond(route, wantsObject ? (rows[0] || null) : rows);
};

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch { /* preview 尚未啟動 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('preview server timeout');
}

const results = [];
const pass = (name, detail = '') => {
  results.push(true);
  console.log(`PASS  ${name}${detail ? ` - ${detail}` : ''}`);
};
const fail = (name, error) => {
  results.push(false);
  console.log(`FAIL  ${name}\n      ${String(error?.message || error).split('\n').slice(0, 6).join('\n      ')}`);
};
const step = async (name, callback) => {
  try {
    const detail = await callback();
    pass(name, typeof detail === 'string' ? detail : '');
  } catch (error) {
    fail(name, error);
  }
};

const rowOf = (page, name) => page.locator('tbody tr').filter({ hasText: name });
const progressOf = async (page, name) => rowOf(page, name).first().locator('[data-progress]').getAttribute('data-progress');
// React Router 的網址更新是 transition，要等篩選鈕真的切到 pressed 才算畫面已更新
const selectProgress = async (page, key) => {
  await page.locator(`[data-progress-filter="${key}"]`).click();
  await page.locator(`[data-progress-filter="${key}"][aria-pressed="true"]`).waitFor({ timeout: 5000 });
};
const nameCells = (page) => page.locator('tbody tr td:first-child .font-bold').allInnerTexts();
// 篩選鈕有 CSS uppercase：innerText 會把「待確認 Email」變成 EMAIL，所以讀 textContent
const chipText = async (page, key) => (await page.locator(`[data-progress-filter="${key}"]`).textContent()).replace(/\s+/g, ' ').trim();

async function main() {
  execSync('npm run build', { cwd: appDir, stdio: 'ignore' });
  const port = await reservePort();
  const baseUrl = `http://localhost:${port}`;
  const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch(existsSync(chromePath) ? { executablePath: chromePath } : {});

    const newPage = async (role, viewport = { width: 1280, height: 1000 }) => {
      const auth = makeSession(role);
      const context = await browser.newContext({ viewport });
      await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
        key: storageKey,
        value: auth.session,
      });
      await context.route('**/*', routeHandler(baseUrl, auth));
      const page = await context.newPage();
      return { context, page };
    };

    // ═════════ 管理員：講師資料總覽 ═════════
    {
      const { context, page } = await newPage('admin');
      const dialogs = [];
      page.on('dialog', async (dialog) => {
        dialogs.push(dialog.message());
        await dialog.dismiss();
      });
      await page.goto(`${baseUrl}/admin/instructors?progress=todo`, { waitUntil: 'networkidle' });
      await page.locator('tbody tr').first().waitFor();

      await step('?progress=todo 預選「還沒完成」，只列出未認領＋待審核＋待確認 Email＋待信箱驗證＋資料未完整＋待簽約', async () => {
        assert.equal(await page.locator('[data-progress-filter="todo"]').getAttribute('aria-pressed'), 'true');
        const names = (await nameCells(page)).sort();
        assert.deepEqual(names, ['王小明', '王小明', '李新建', '李新建', '趙匯入', '陳完整'].sort());
        return `rows=${names.length}`;
      });

      await step('每顆篩選顯示人數（全部 8、還沒完成 6、未認領 3、待審核 1、資料未完整 1、待簽約 1、已完成 1、已停用 1）', async () => {
        const expected = {
          all: '全部 8', todo: '還沒完成 6', unclaimed: '未認領 3', pending_review: '待審核 1',
          awaiting_email_confirm: '待確認 Email 0', awaiting_email_verify: '待信箱驗證 0',
          incomplete: '資料未完整 1', awaiting_contract: '待簽約 1', complete: '已完成 1', disabled: '已停用 1',
        };
        for (const [key, text] of Object.entries(expected)) {
          assert.equal(await chipText(page, key), text, key);
        }
      });

      await step('每列進度標籤正確（階段判斷：已停用→未認領→待審核→資料未完整→待簽約→已完成）', async () => {
        await selectProgress(page, 'all');
        assert.equal(await rowOf(page, '李新建').count(), 2);
        const emptySlot = rowOf(page, '李新建').filter({ hasNotText: 'new@example.com' });
        assert.equal(await emptySlot.locator('[data-progress]').getAttribute('data-progress'), 'unclaimed');
        const pending = page.locator('tbody tr').filter({ hasText: 'new@example.com' });
        assert.equal(await pending.locator('[data-progress]').getAttribute('data-progress'), 'pending_review');
        assert.match(await pending.locator('[data-progress]').innerText(), /待審核\s*缺 \d+ 項/);
        assert.equal(await progressOf(page, '陳完整'), 'awaiting_contract');
        assert.equal(await progressOf(page, '林已簽'), 'complete');
        assert.equal(await progressOf(page, '張離職'), 'disabled');
        assert.equal(await progressOf(page, '趙匯入'), 'unclaimed');
        const claimedSlot = page.locator('tbody tr').filter({ hasText: 'wang.google@gmail.com' });
        assert.equal(await claimedSlot.locator('[data-progress]').getAttribute('data-progress'), 'incomplete');
        assert.match(await claimedSlot.locator('[data-progress]').innerText(), /資料未完整\s*缺 \d+ 項/);
      });

      await step('點篩選會寫進網址 ?progress=，可單獨篩出待簽約', async () => {
        await selectProgress(page, 'awaiting_contract');
        await page.waitForURL(/progress=awaiting_contract/);
        assert.deepEqual(await nameCells(page), ['陳完整']);
        await selectProgress(page, 'complete');
        assert.deepEqual(await nameCells(page), ['林已簽']);
        await selectProgress(page, 'all');
        await page.waitForFunction(() => !location.search.includes('progress='));
        assert.equal((await nameCells(page)).length, 8);
      });

      await step('已綁定的列顯示 Google 登入 Email（與主檔相同就不重複）', async () => {
        const claimedSlot = rowOf(page, 'wang.google@gmail.com');
        assert.equal(await claimedSlot.locator('[data-testid="login-email"]').innerText(), 'Google 登入：wang.google@gmail.com');
        assert.equal(await rowOf(page, '林已簽').locator('[data-testid="login-email"]').innerText(), 'Google 登入：lin.login@gmail.com');
        assert.equal(await rowOf(page, '陳完整').locator('[data-testid="login-email"]').count(), 0);
        await page.getByPlaceholder('搜尋姓名、Email 或手機號碼⋯⋯').fill('lin.login');
        await page.locator('tbody tr').filter({ hasText: '王小明' }).first().waitFor({ state: 'detached', timeout: 5000 });
        assert.deepEqual(await nameCells(page), ['林已簽']);
        await page.getByPlaceholder('搜尋姓名、Email 或手機號碼⋯⋯').fill('');
        await page.locator('tbody tr').filter({ hasText: '王小明' }).first().waitFor({ timeout: 5000 });
      });

      await step('姓名認領的列有「姓名認領」小標籤與解除綁定說明；一般列沒有', async () => {
        const claimedSlot = rowOf(page, 'wang.google@gmail.com');
        assert.equal(await claimedSlot.getByText('姓名認領', { exact: true }).count(), 1);
        assert.equal(await claimedSlot.getByTestId('name-slot-unlink-hint').innerText(), '若認領錯人：按解除綁定，對方會回到待審核');
        assert.equal(await rowOf(page, '陳完整').getByText('姓名認領', { exact: true }).count(), 0);
        assert.equal(await rowOf(page, '陳完整').getByTestId('name-slot-unlink-hint').count(), 0);
      });

      await step('姓名認領的列按解除綁定，確認視窗說明對方會回到待審核（取消後不呼叫解綁）', async () => {
        dialogs.length = 0;
        rpcCalls = [];
        await rowOf(page, 'wang.google@gmail.com').getByRole('button', { name: '解除綁定' }).click();
        await page.waitForTimeout(200);
        assert.equal(dialogs.length, 1);
        assert.match(dialogs[0], /若認領錯人：按解除綁定，對方會回到待審核/);
        assert.equal(rpcCalls.includes('admin_unlink_instructor'), false);
        dialogs.length = 0;
        await rowOf(page, '陳完整').getByRole('button', { name: '解除綁定' }).click();
        await page.waitForTimeout(200);
        assert.match(dialogs[0], /同一 Email 的 Google 帳號下次登入會再次自動認領/);
      });

      await step('展開列顯示還缺哪幾項', async () => {
        await rowOf(page, 'new@example.com').locator('td').first().click();
        // 手機卡片與桌機表格共用展開狀態，這裡只看桌機表格裡那份
        const missing = page.locator('tbody').getByText(/還缺 \d+ 項：/);
        await missing.first().waitFor({ timeout: 5000 });
        const text = await missing.first().innerText();
        assert.match(text, /身分證字號/);
        return text.slice(0, 40);
      });

      // ── 新增 modal：只填姓名
      await step('新增講師預設「只填姓名」，多行輸入並顯示將新增人數', async () => {
        await page.getByRole('button', { name: '新增講師' }).click();
        const dialog = page.getByRole('dialog', { name: '新增講師' });
        assert.equal(await dialog.getByRole('tab', { name: /只填姓名/ }).getAttribute('aria-selected'), 'true');
        assert.equal(await dialog.locator('input[type="email"]').count(), 0);
        await dialog.getByLabel('老師姓名，一行一個').fill('新人甲\n\n  新人乙  \n');
        assert.equal((await dialog.getByTestId('name-slot-count').innerText()).trim(), '將新增 2 位空位');
        assert.equal(await dialog.getByTestId('name-slot-conflicts').count(), 0);
        assert.equal(await dialog.getByRole('button', { name: '新增 2 位' }).isEnabled(), true);
      });

      await step('同名時列出「名冊已有同名：王小明（已認領 1、未認領 1）」與同批重複，勾選確認才能送出', async () => {
        const dialog = page.getByRole('dialog', { name: '新增講師' });
        await dialog.getByLabel('老師姓名，一行一個').fill('王小明\n新人甲\n新人甲');
        const box = dialog.getByTestId('name-slot-conflicts');
        const text = await box.innerText();
        assert.match(text, /名冊已有同名：王小明（已認領 1、未認領 1）/);
        assert.match(text, /這一批裡重複輸入：新人甲（共 2 行）/);
        const submit = dialog.getByRole('button', { name: '新增 3 位' });
        assert.equal(await submit.isDisabled(), true);
        await dialog.getByLabel('我確定要再新增同名空位（同名同姓不同人）').check();
        assert.equal(await submit.isEnabled(), true);
        // 改動輸入後要重新確認
        await dialog.getByLabel('老師姓名，一行一個').fill('王小明\n新人甲\n新人甲\n新人丙');
        assert.equal(await dialog.getByRole('button', { name: '新增 4 位' }).isDisabled(), true);
        await dialog.getByLabel('老師姓名，一行一個').fill('王 小明');
        assert.match(await box.innerText(), /名冊已有同名：王小明/);
      });

      await step('勾選確認後一次新增多位空位：payload 只有姓名＋業務狀態＋預設等級實習＋name_slot', async () => {
        const dialog = page.getByRole('dialog', { name: '新增講師' });
        await dialog.getByLabel('老師姓名，一行一個').fill('王小明\n新人甲\n新人甲');
        await dialog.getByLabel('我確定要再新增同名空位（同名同姓不同人）').check();
        inserts = [];
        await dialog.getByRole('button', { name: '新增 3 位' }).click();
        await page.getByRole('status').filter({ hasText: '已新增 3 位空位' }).waitFor({ timeout: 5000 });
        assert.equal(inserts.length, 1);
        assert.deepEqual(inserts[0], [
          { full_name: '王小明', employment_status: 'active', instructor_role: '實習', name_slot: true },
          { full_name: '新人甲', employment_status: 'active', instructor_role: '實習', name_slot: true },
          { full_name: '新人甲', employment_status: 'active', instructor_role: '實習', name_slot: true },
        ]);
        assert.equal(await page.getByRole('dialog', { name: '新增講師' }).count(), 0);
        await page.locator('[data-progress-filter="all"]').filter({ hasText: '全部 11' }).waitFor({ timeout: 5000 });
        assert.equal(await chipText(page, 'unclaimed'), '未認領 6');
      });

      await step('填完整資料模式維持原本行為（需 Email、不帶 name_slot）', async () => {
        await page.getByRole('button', { name: '新增講師' }).click();
        const dialog = page.getByRole('dialog', { name: '新增講師' });
        await dialog.getByRole('tab', { name: /填完整資料/ }).click();
        inserts = [];
        await dialog.locator('input[type="text"]').first().fill('完整乙');
        await dialog.getByRole('button', { name: '新增', exact: true }).click();
        await dialog.getByText('Email 為必填(用於登入後自動綁定)').waitFor();
        assert.equal(inserts.length, 0);
        await dialog.locator('input[type="email"]').fill('Full.B@Example.com');
        await dialog.getByRole('button', { name: '新增', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '已新增 完整乙' }).waitFor({ timeout: 5000 });
        assert.equal(inserts.length, 1);
        assert.equal(inserts[0].full_name, '完整乙');
        assert.equal(inserts[0].email_primary, 'full.b@example.com');
        assert.equal(Object.hasOwn(inserts[0], 'name_slot'), false);
        assert.ok(rpcCalls.includes('admin_confirm_instructor_email'), '預設勾選「已和老師確認」時要登錄已確認 Email');
      });

      await step('只有乾淨的空位有「刪除空位」，已認領／有資料的沒有', async () => {
        const pristineRows = page.locator('tbody tr').filter({ has: page.getByRole('button', { name: '刪除空位' }) });
        const names = (await pristineRows.locator('td:first-child .font-bold').allInnerTexts()).sort();
        // 王小明(s1)、李新建空位、剛新增的 王小明、新人甲×2
        assert.deepEqual(names, ['李新建', '新人甲', '新人甲', '王小明', '王小明'].sort());
        assert.equal(await rowOf(page, '趙匯入').getByRole('button', { name: '刪除空位' }).count(), 0);
        assert.equal(await rowOf(page, 'wang.google@gmail.com').getByRole('button', { name: '刪除空位' }).count(), 0);
        assert.equal(await rowOf(page, '張離職').getByRole('button', { name: '刪除空位' }).count(), 0);
      });

      await step('刪除空位：確認後只送出鎖定「空位＋未認領」的刪除', async () => {
        page.removeAllListeners('dialog');
        const messages = [];
        page.on('dialog', async (dialog) => { messages.push(dialog.message()); await dialog.accept(); });
        deletes = [];
        const slotRow = page.locator('tbody tr').filter({ hasText: '新人甲' }).first();
        await slotRow.getByRole('button', { name: '刪除空位' }).click();
        await page.getByRole('status').filter({ hasText: '已刪除空位「新人甲」' }).waitFor({ timeout: 5000 });
        assert.match(messages[0], /確定要刪除空位「新人甲」/);
        assert.equal(deletes.length, 1);
        assert.equal(deletes[0].name_slot, 'eq.true');
        assert.equal(deletes[0].user_id, 'is.null');
        assert.match(deletes[0].id, /^eq\./);
        // 通知出現時列表可能還在重新讀取（多一個讀取請求後更明顯），輪詢等列表更新
        await page.waitForFunction(
          () => [...document.querySelectorAll('tbody tr')].filter((tr) => tr.textContent.includes('新人甲')).length === 1,
          null,
          { timeout: 5000 },
        );
      });

      await page.screenshot({ path: path.join(shotDir, 'admin-instructors-desktop.png'), fullPage: true });
      await context.close();
    }

    // ═════════ 管理員：帳號審核頁的同名空位警示 ═════════
    instructors = makeInstructors();
    inserts = [];
    deletes = [];
    rpcCalls = [];
    {
      const { context, page } = await newPage('admin');
      await page.goto(`${baseUrl}/admin/teachers`, { waitUntil: 'networkidle' });
      await step('待審核帳號旁提醒「後台有同名空位未認領」，其他帳號沒有', async () => {
        const warnings = page.getByTestId('same-name-slot-warning');
        await warnings.first().waitFor({ timeout: 5000 });
        assert.equal(await warnings.count(), 1);
        const text = await warnings.first().innerText();
        assert.match(text, /後台有同名空位未認領，可能是同一位老師選成「新建帳號」。可刪除空位後再核准，或請老師改用「認領帳號」。/);
        const card = page.locator('.bh-card').filter({ hasText: 'new@example.com' }).first();
        assert.equal(await card.getByTestId('same-name-slot-warning').count(), 1);
        await page.getByRole('button', { name: /^講師 / }).click();
        assert.equal(await page.getByTestId('same-name-slot-warning').count(), 0);
      });
      await step('警示只提醒、不自動合併（沒有新增、刪除或任何 RPC 寫入）', async () => {
        assert.equal(inserts.length, 0);
        assert.equal(deletes.length, 0);
        assert.deepEqual(rpcCalls.filter((name) => /instructor|approve|merge|link/.test(name) && name !== 'claim_my_precreated_instructor'), []);
      });
      await context.close();
    }

    // ═════════ 管理員：後台首頁追蹤卡 ═════════
    {
      const { context, page } = await newPage('admin');
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
      await step('後台首頁「老師資料追蹤」卡顯示還沒完成人數並導向 ?progress=todo', async () => {
        const card = page.getByRole('link', { name: /老師資料追蹤，還沒完成 6 位/ });
        await card.waitFor({ timeout: 5000 });
        const text = await card.innerText();
        assert.match(text, /6/);
        assert.match(text, /未認領 3・待審核 1・待確認 Email 0・待信箱驗證 0・資料未完整 1・待簽約 1/);
        await card.click();
        await page.waitForURL(`${baseUrl}/admin/instructors?progress=todo`);
        await page.locator('tbody tr').first().waitFor();
        assert.equal(await page.locator('[data-progress-filter="todo"]').getAttribute('aria-pressed'), 'true');
      });
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
      await page.screenshot({ path: path.join(shotDir, 'admin-dashboard-desktop.png'), fullPage: false });
      await context.close();
    }

    // ═════════ 輔導員：只拿到名冊 ═════════
    {
      contractReads = 0;
      rpcCalls = [];
      const { context, page } = await newPage('mentor');
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
      await step('輔導員的後台首頁沒有「老師資料追蹤」卡（要讀講師主檔與簽約／啟用紀錄）', async () => {
        await page.getByText('後台管理總覽').waitFor({ timeout: 5000 });
        assert.equal(await page.getByRole('link', { name: /老師資料追蹤/ }).count(), 0);
        assert.equal(contractReads, 0);
      });
      await page.goto(`${baseUrl}/admin/instructors?progress=todo`, { waitUntil: 'networkidle' });
      await page.locator('tbody tr').first().waitFor();
      await step('輔導員只看名冊：走名冊函式、不查簽約紀錄；沒有進度篩選／進度欄／新增講師／刪除空位', async () => {
        assert.equal(contractReads, 0);
        assert.ok(rpcCalls.includes('mentor_instructor_directory'), '應呼叫名冊函式');
        await page.locator('tbody tr').filter({ hasText: '陳完整' }).first().waitFor({ timeout: 5000 });
        assert.equal(await page.locator('[data-progress-filter]').count(), 0);
        assert.equal(await page.locator('[data-progress]').count(), 0);
        assert.equal(await page.getByRole('button', { name: '新增講師' }).count(), 0);
        assert.equal(await page.getByRole('button', { name: '刪除空位' }).count(), 0);
        // 網址帶了進度篩選也不會把名冊篩成空白
        assert.ok(await page.locator('tbody tr').count() >= 5);
      });
      await context.close();
    }

    // ═════════ 手機版 390px ═════════
    instructors = makeInstructors();
    {
      const { context, page } = await newPage('admin', { width: 390, height: 844 });
      await page.goto(`${baseUrl}/admin/instructors?progress=todo`, { waitUntil: 'networkidle' });
      await page.getByText('趙匯入').first().waitFor({ timeout: 5000 });
      await step('390px：進度篩選與卡片列表無水平溢出，篩選熱區 ≥ 44px', async () => {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `overflow=${overflow}`);
        const heights = await page.locator('[data-progress-filter]').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        assert.ok(heights.length >= 8 && heights.every((height) => height >= 44), JSON.stringify(heights));
        // 手機卡片也有進度標籤與解綁說明
        // 卡片版在 lg（1024px）以下顯示（版面整理後由 md 改成 lg）
        const cards = page.locator('.lg\\:hidden .bh-card');
        assert.ok(await cards.locator('[data-progress]').count() >= 6);
        assert.equal(await cards.getByTestId('name-slot-unlink-hint').count(), 1);
      });
      await page.getByRole('button', { name: '新增講師' }).click();
      await step('390px：新增 modal 在視窗內且無水平溢出', async () => {
        const dialog = page.getByRole('dialog', { name: '新增講師' });
        await dialog.getByLabel('老師姓名，一行一個').fill('王小明\n王小明');
        const box = await dialog.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `overflow=${overflow}`);
      });
      await page.screenshot({ path: path.join(shotDir, 'admin-instructors-mobile-modal.png'), fullPage: false });
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} PASS ===  截圖：${shotDir}`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
