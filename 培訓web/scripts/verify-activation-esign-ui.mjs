#!/usr/bin/env node
/*
 * 瀏覽器回歸（mock Supabase）：認領後的帳號啟用（Email OTP）與後台確認 Email。
 * 規格：docs/specs/2026-10-20-claim-activation-esign.md §1.4／§2。簽約流程本身在 verify-contract-feature-enabled.mjs。
 *
 * 講師端（/profile）
 *   A1 已認領待啟用、Email 已確認、資料未完整 → 提示先補資料，沒有啟用按鈕
 *   A2 資料完整 → 頂端出現「確認資料無誤，驗證信箱啟用帳號」主按鈕與遮罩信箱
 *   A3 有未儲存修改 → 不寄驗證碼，提示先儲存
 *   A4 按鈕 → Email 驗證視窗（用途 account_activation）→ 錯誤碼提示 → 正確碼 → 啟用成功導去 /courses
 *   A5 待啟用的人儲存個人資料後留在 /profile（不被導去「帳號審核中」），並重新讀取啟用狀態
 *   A6 手機 390px：提示、按鈕、驗證視窗無水平溢出，觸控目標 ≥ 44px
 * 後台（/admin/instructors）
 *   B1 進度新增「待確認 Email」「待信箱驗證」，數字與列標籤正確；追蹤卡同步
 *   B2 admin 每列有「確認 Email」：必填檢查、送出 admin_confirm_instructor_email 的參數、錯誤訊息、成功提示
 *   B3 展開列顯示已確認 Email、確認時間與方式、管道註記
 *   B4 輔導員只拿到名冊（migration 20261022010000）：不查啟用紀錄、沒有確認按鈕、沒有進度篩選／進度欄，也不能展開看 Email
 *   B5 手機 390px：確認 Email 視窗在視窗內且無水平溢出
 * 用法：node scripts/verify-activation-esign-ui.mjs（會先 npm run build，再自己起 preview）
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
const shotDir = path.join(process.env.VERIFY_SHOT_DIR || tmpdir(), 'activation-esign-shots');
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
  .split('\n').map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();

const uid = (n) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const TEACHER_ID = uid(41);
const ADMIN_ID = uid(1);
const CHALLENGE_ID = '00000000-0000-4000-8000-0000000000d2';
const MASKED = 'pe***@example.com';

// 資料完整的講師主檔（和簽約情境相同的樣板）
const completeFields = {
  nickname: '老師', gender: '女', birth_date: '1990-01-01', id_number: 'A123456789',
  phone_mobile: '0912345678', line_id: 'line', address: '通訊地址', household_address: '戶籍地址',
  teaching_freq_semester: '每週一次', teaching_freq_vacation: '每週一次', teaching_regions: ['臺北市'],
  bio_notes: '經歷', bank_account_name: '待啟用老師', bank_name: '銀行', bank_branch: '分行',
  bank_account_number: '1234567890', bank_code: '822123', instructor_role: 'B',
  photo_path: 'mock/photo.jpg', id_front_path: 'front.jpg', id_back_path: 'back.jpg', bankbook_path: 'bank.jpg',
  hide_from_leaderboard: false,
};
const TEACHER_INSTRUCTOR = {
  id: '10000000-0000-4000-8000-000000000041', user_id: TEACHER_ID, full_name: '待啟用老師',
  email_primary: 'pending.teacher@example.com', employment_status: 'active', created_at: now, updated_at: now,
  ...completeFields,
};

const respond = (route, body, status = 200) => {
  const headers = { 'content-type': 'application/json' };
  if (Array.isArray(body)) headers['content-range'] = body.length ? `0-${body.length - 1}/${body.length}` : '*/0';
  return route.fulfill({ status, headers, body: JSON.stringify(body) });
};

// ── 情境狀態 ─────────────────────────────────────────────
let activation;
let activated;
let rpcCalls;
let instructorPatches;
let rpcOverrides;
const resetTeacher = ({ confirmed = true, complete = true } = {}) => {
  activation = { status: 'pending', claim_method: 'name_slot', has_confirmed_email: confirmed, masked_email: confirmed ? MASKED : null, profile_complete: complete };
  activated = false;
  rpcCalls = [];
  instructorPatches = [];
  rpcOverrides = {};
};
const callsOf = (name) => rpcCalls.filter((call) => call.name === name);

const teacherSession = () => {
  const user = {
    id: TEACHER_ID, aud: 'authenticated', role: 'authenticated', email: 'pending.teacher@example.com',
    app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: '待啟用老師' },
    created_at: now, updated_at: now,
  };
  return {
    user,
    session: { access_token: 'mock.teacher.token', refresh_token: 'mock.teacher.refresh', token_type: 'bearer', expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user },
  };
};

const teacherRoutes = (baseUrl) => async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === baseUrl) return route.continue();
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
  if (!url.hostname.endsWith('.supabase.co')) return route.abort();
  const { user, session } = teacherSession();

  if (url.pathname.startsWith('/auth/v1/')) {
    if (url.pathname === '/auth/v1/user') return respond(route, user);
    if (url.pathname.startsWith('/auth/v1/token')) return respond(route, session);
    return respond(route, {});
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const name = url.pathname.split('/').pop();
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    rpcCalls.push({ name, body });
    if (rpcOverrides[name]) {
      const result = rpcOverrides[name](body);
      if (result?.__error) return respond(route, { code: 'P0001', message: result.__error }, 400);
      return respond(route, result);
    }
    if (name === 'claim_my_precreated_instructor') return respond(route, { status: 'claimed', instructor_id: TEACHER_INSTRUCTOR.id, claimed_now: false, activation_required: !activated });
    if (name === 'get_my_activation_status') {
      return respond(route, activated
        ? { status: 'active', claim_method: 'name_slot', has_confirmed_email: true, masked_email: MASKED, profile_complete: true }
        : activation);
    }
    if (name === 'request_email_otp') {
      return respond(route, { status: 'sent', challenge_id: CHALLENGE_ID, expires_at: new Date(Date.now() + 300000).toISOString(), masked_email: MASKED, resend_after_seconds: 60 });
    }
    if (name === 'verify_email_otp') {
      if (body.p_code === '123456') { activated = true; return respond(route, { status: 'verified', verified_at: now, activated: true }); }
      return respond(route, { status: 'invalid', attempts_remaining: 4 });
    }
    return respond(route, null);
  }
  if (!url.pathname.startsWith('/rest/v1/')) return respond(route, {}, 404);

  const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
  const method = request.method();
  const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
  if (method === 'PATCH' && table === 'instructors') {
    instructorPatches.push(request.postDataJSON());
    return respond(route, [{ updated_at: new Date().toISOString() }]);
  }
  if (method !== 'GET') return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });

  let rows = [];
  if (table === 'users') {
    rows = [{ id: TEACHER_ID, name: '待啟用老師', email: user.email, role: activated ? 'teacher' : 'pending', created_at: now }];
  } else if (table === 'instructors') {
    rows = [TEACHER_INSTRUCTOR];
  }
  return respond(route, wantsObject ? (rows[0] || null) : rows);
};

// ── 後台資料 ─────────────────────────────────────────────
const U = { confirm: uid(51), verify: uid(52), review: uid(53), done: uid(54) };
const row = (n, overrides) => ({
  id: `20000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  user_id: null, employment_status: 'active', name_slot: false, created_at: now, ...overrides,
});
const makeAdminInstructors = () => [
  row(1, { full_name: '黃待確認', user_id: U.confirm, name_slot: true, email_primary: 'huang@example.com', phone_mobile: '0911111111' }),
  row(2, {
    full_name: '周待驗證', user_id: U.verify, name_slot: true, email_primary: 'zhou.main@example.com', phone_mobile: '0922222222',
    confirmed_email: 'zhou@example.com', confirmed_email_at: '2026-10-20T03:00:00Z',
    confirmed_email_method: 'admin_trusted_channel', confirmed_email_note: '10/20 透過 LINE 與老師確認',
  }),
  row(3, { full_name: '李新建', user_id: U.review, email_primary: 'new@example.com', nickname: '新' }),
  row(4, {
    full_name: '趙已啟用', user_id: U.done, email_primary: 'zhao@example.com', ...completeFields,
    confirmed_email: 'zhao@example.com', confirmed_email_at: '2026-10-19T03:00:00Z', confirmed_email_method: 'company_existing_record',
  }),
  row(5, { full_name: '王空位', name_slot: true }),
];
let adminInstructors = makeAdminInstructors();
const adminUsers = () => [
  { id: ADMIN_ID, name: '管理員', email: 'admin@example.com', role: 'admin', created_at: now },
  { id: U.confirm, name: '黃待確認', email: 'huang.google@gmail.com', role: 'pending', created_at: now },
  { id: U.verify, name: '周待驗證', email: 'zhou.google@gmail.com', role: 'pending', created_at: now },
  { id: U.review, name: '李新建', email: 'new@example.com', role: 'pending', created_at: now },
  { id: U.done, name: '趙已啟用', email: 'zhao@example.com', role: 'teacher', created_at: now },
];
const activationRows = [
  { id: 'a1', user_id: U.confirm, status: 'pending', claim_method: 'name_slot' },
  { id: 'a2', user_id: U.verify, status: 'pending', claim_method: 'name_slot' },
  { id: 'a3', user_id: U.done, status: 'active', claim_method: 'legacy_pre_activation' },
];
let adminRpcCalls = [];
let adminRpcOverrides = {};
let activationReads = 0;

const adminRoutes = (baseUrl, role) => async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === baseUrl) return route.continue();
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
  if (!url.hostname.endsWith('.supabase.co')) return route.abort();
  const id = role === 'admin' ? ADMIN_ID : uid(2);
  const user = {
    id, aud: 'authenticated', role: 'authenticated', email: `${role}@example.com`,
    app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: role === 'admin' ? '管理員' : '輔導員' },
    created_at: now, updated_at: now,
  };
  const session = { access_token: `mock.${role}`, refresh_token: `mock.${role}.r`, token_type: 'bearer', expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user };

  if (url.pathname.startsWith('/auth/v1/')) {
    if (url.pathname === '/auth/v1/user') return respond(route, user);
    if (url.pathname.startsWith('/auth/v1/token')) return respond(route, session);
    return respond(route, {});
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const name = url.pathname.split('/').pop();
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    adminRpcCalls.push({ name, body });
    if (adminRpcOverrides[name]) {
      const result = adminRpcOverrides[name](body);
      if (result?.__error) return respond(route, { code: 'P0001', message: result.__error }, 400);
      return respond(route, result);
    }
    if (name === 'claim_my_precreated_instructor') return respond(route, { status: 'staff' });
    if (name === 'admin_confirm_instructor_email') {
      const target = adminInstructors.find((item) => item.id === body.p_instructor_id);
      if (target) Object.assign(target, { confirmed_email: body.p_email, confirmed_email_at: now, confirmed_email_method: 'admin_trusted_channel', confirmed_email_note: body.p_note });
      return respond(route, { status: 'confirmed' });
    }
    if (name === 'mentor_instructor_directory') {
      const keys = ['id', 'user_id', 'full_name', 'nickname', 'instructor_role', 'employment_status', 'teaching_regions', 'speed_qualification'];
      return respond(route, adminInstructors.map((item) => Object.fromEntries(keys.map((key) => [key, item[key] ?? null]))));
    }
    return respond(route, null);
  }
  if (!url.pathname.startsWith('/rest/v1/')) return respond(route, {}, 404);

  const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
  const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
  if (request.method() !== 'GET') return route.fulfill({ status: 204, body: '' });

  let rows = [];
  if (table === 'users') {
    const everyone = adminUsers();
    const profile = { id, name: user.user_metadata.full_name, email: user.email, role, created_at: now };
    const all = everyone.some((item) => item.id === id) ? everyone : [...everyone, profile];
    const idFilter = url.searchParams.get('id');
    rows = idFilter ? all.filter((item) => idFilter === `eq.${item.id}`) : all;
  } else if (table === 'instructors') {
    const idFilter = url.searchParams.get('id');
    const userFilter = url.searchParams.get('user_id');
    // 20261022010000 起輔導員讀不到講師主檔表（只能走名冊函式）
    if (role === 'mentor') rows = [];
    else if (idFilter) rows = adminInstructors.filter((item) => idFilter === `eq.${item.id}`);
    else if (userFilter) rows = adminInstructors.filter((item) => userFilter === `eq.${item.user_id}`);
    else rows = adminInstructors;
  } else if (table === 'instructor_contracts') {
    rows = role === 'admin' ? [{ id: 'c1', user_id: U.done, status: 'signed' }] : [];
  } else if (table === 'instructor_account_activations') {
    activationReads += 1;
    rows = role === 'admin' ? activationRows.filter((item) => !url.searchParams.get('status') || url.searchParams.get('status') === `eq.${item.status}`) : [];
  }
  return respond(route, wantsObject ? (rows[0] || null) : rows);
};

// ── 小工具 ───────────────────────────────────────────────
const results = [];
const pass = (name, detail = '') => { results.push(true); console.log(`PASS  ${name}${detail ? ` - ${detail}` : ''}`); };
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

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { const response = await fetch(baseUrl); if (response.ok) return; } catch { /* preview 尚未啟動 */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('preview server timeout');
}

const overflowOf = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// 篩選鈕有 CSS uppercase：innerText 會把 Email 變 EMAIL，所以讀 textContent
const chipText = async (page, key) => (await page.locator(`[data-progress-filter="${key}"]`).textContent()).replace(/\s+/g, ' ').trim();
const rowOf = (page, name) => page.locator('tbody tr').filter({ hasText: name });

async function main() {
  execSync('npm run build', { cwd: appDir, stdio: 'ignore' });
  const port = await reservePort();
  const baseUrl = `http://localhost:${port}`;
  const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch(existsSync(chromePath) ? { executablePath: chromePath } : {});

    const teacherPage = async (viewport = { width: 1280, height: 1000 }) => {
      const { session } = teacherSession();
      const context = await browser.newContext({ viewport });
      await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
      await context.route('**/*', teacherRoutes(baseUrl));
      const page = await context.newPage();
      page.on('dialog', (dialog) => dialog.accept());
      return { context, page };
    };

    // ═════════ A：講師端帳號啟用 ═════════
    resetTeacher({ confirmed: true, complete: false });
    {
      const { context, page } = await teacherPage();
      await page.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
      await page.getByTestId('activation-card').waitFor({ timeout: 10000 });
      await step('A1 已確認 Email 但資料未完整：提示先補齊資料並指向啟用按鈕，沒有按鈕', async () => {
        const message = await page.getByTestId('activation-message').innerText();
        assert.ok(message.includes('請先補齊資料') && message.includes('確認資料無誤，驗證信箱啟用帳號'), message);
        assert.equal(await page.getByTestId('activation-button').count(), 0);
      });
      await context.close();
    }

    resetTeacher({ confirmed: true, complete: true });
    {
      const { context, page } = await teacherPage();
      await page.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
      await page.getByTestId('activation-button').waitFor({ timeout: 10000 });
      await step('A2 資料完整：頂端出現「確認資料無誤，驗證信箱啟用帳號」主按鈕與遮罩信箱', async () => {
        assert.equal((await page.getByTestId('activation-button').innerText()).trim(), '確認資料無誤，驗證信箱啟用帳號');
        assert.ok((await page.getByTestId('activation-message').innerText()).includes(MASKED));
        const isFirst = await page.getByTestId('activation-card').evaluate((node) => node === node.parentElement.firstElementChild);
        assert.ok(isFirst, '啟用卡應是頁面第一個區塊');
        assert.equal(await page.getByText('帳號審核中', { exact: true }).count(), 0);
      });
      await page.screenshot({ path: path.join(shotDir, 'profile-activation-desktop.png'), fullPage: false });

      await step('A3 有未儲存修改時，不寄驗證碼並提示先儲存', async () => {
        await page.locator('textarea').first().fill('改了一點內容但還沒儲存');
        await page.getByTestId('activation-button').click();
        await page.getByTestId('activation-hint').waitFor({ timeout: 5000 });
        assert.ok((await page.getByTestId('activation-hint').innerText()).includes('尚未儲存的修改'));
        assert.equal(callsOf('request_email_otp').length, 0);
        assert.equal(await page.getByTestId('email-otp-dialog').count(), 0);
      });
      await context.close();
    }

    resetTeacher({ confirmed: true, complete: true });
    {
      const { context, page } = await teacherPage();
      await page.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
      await page.getByTestId('activation-button').waitFor({ timeout: 10000 });
      await step('A4 啟用：驗證視窗（用途 account_activation）→ 錯誤碼提示 → 正確碼 → 導去 /courses', async () => {
        await page.getByTestId('activation-button').click();
        await page.locator('#email-otp-code').waitFor({ timeout: 10000 });
        assert.deepEqual(callsOf('request_email_otp').map((call) => call.body), [{ p_purpose: 'account_activation' }]);
        const dialogText = await page.getByTestId('email-otp-dialog').innerText();
        assert.ok(dialogText.includes('驗證信箱，啟用帳號') && dialogText.includes(MASKED), dialogText.slice(0, 120));
        assert.match(await page.getByTestId('otp-expiry').innerText(), /驗證碼有效時間 [45]:\d\d/);

        await page.locator('#email-otp-code').fill('000000');
        await page.getByTestId('email-otp-dialog').getByRole('button', { name: '驗證', exact: true }).click();
        await page.getByTestId('otp-notice').filter({ hasText: '還可以再試 4 次' }).waitFor({ timeout: 8000 });
        assert.equal(activated, false);
        assert.equal(await page.locator('#email-otp-code').inputValue(), '');

        await page.locator('#email-otp-code').fill('123456');
        await page.getByTestId('email-otp-dialog').getByRole('button', { name: '驗證', exact: true }).click();
        await page.waitForURL('**/courses', { timeout: 15000 });
        const verifies = callsOf('verify_email_otp').map((call) => call.body);
        assert.deepEqual(verifies, [
          { p_challenge_id: CHALLENGE_ID, p_code: '000000' },
          { p_challenge_id: CHALLENGE_ID, p_code: '123456' },
        ]);
        return `landed=${new URL(page.url()).pathname}`;
      });
      await context.close();
    }

    resetTeacher({ confirmed: true, complete: true });
    {
      const { context, page } = await teacherPage();
      await page.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
      await page.getByTestId('activation-card').waitFor({ timeout: 10000 });
      await step('A5 待啟用的人儲存個人資料：留在 /profile、重新讀取啟用狀態，不被導去「帳號審核中」', async () => {
        const before = callsOf('get_my_activation_status').length;
        await page.getByRole('button', { name: '儲存個人資料' }).click();
        const start = Date.now();
        while (callsOf('get_my_activation_status').length <= before && Date.now() - start < 8000) await page.waitForTimeout(150);
        assert.equal(instructorPatches.length, 1, '應該有送出一次主檔更新');
        assert.ok(callsOf('get_my_activation_status').length > before, '儲存後要重新讀啟用狀態');
        assert.equal(new URL(page.url()).pathname, '/profile');
        assert.equal(await page.getByTestId('activation-card').count(), 1);
      });
      await context.close();
    }

    resetTeacher({ confirmed: true, complete: true });
    {
      const { context, page } = await teacherPage({ width: 390, height: 844 });
      await page.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
      await page.getByTestId('activation-button').waitFor({ timeout: 10000 });
      await step('A6 390px：啟用提示與按鈕無水平溢出，按鈕觸控高度 ≥ 44px 且在視窗內', async () => {
        assert.ok(await overflowOf(page) <= 0, `overflow=${await overflowOf(page)}`);
        const box = await page.getByTestId('activation-button').boundingBox();
        assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
      });
      await page.getByTestId('activation-button').click();
      await page.locator('#email-otp-code').waitFor({ timeout: 10000 });
      await step('A6b 390px：Email 驗證視窗在畫面內、無水平溢出，輸入框／按鈕 ≥ 44px，numeric＋one-time-code', async () => {
        const metrics = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]').getBoundingClientRect();
          const input = document.querySelector('#email-otp-code');
          const buttons = [...document.querySelectorAll('[role="dialog"] button')].filter((button) => button.offsetParent !== null);
          return {
            left: Math.round(dialog.left), right: Math.round(dialog.right),
            inputHeight: Math.round(input.getBoundingClientRect().height),
            inputmode: input.getAttribute('inputmode'), autocomplete: input.getAttribute('autocomplete'),
            smallButtons: buttons.filter((button) => button.getBoundingClientRect().height < 44).map((button) => button.textContent.trim()),
          };
        });
        assert.ok(metrics.left >= 0 && metrics.right <= 390 && metrics.inputHeight >= 44, JSON.stringify(metrics));
        assert.equal(metrics.inputmode, 'numeric');
        assert.equal(metrics.autocomplete, 'one-time-code');
        assert.deepEqual(metrics.smallButtons, [], `小於 44px 的按鈕：${metrics.smallButtons}`);
        assert.ok(await overflowOf(page) <= 0);
      });
      await page.screenshot({ path: path.join(shotDir, 'profile-activation-otp-mobile.png'), fullPage: false });
      await context.close();
    }

    // ═════════ B：後台確認 Email 與新進度階段 ═════════
    const adminPage = async (role, viewport = { width: 1280, height: 1000 }) => {
      const id = role === 'admin' ? ADMIN_ID : uid(2);
      const user = {
        id, aud: 'authenticated', role: 'authenticated', email: `${role}@example.com`,
        app_metadata: { provider: 'google', providers: ['google'] }, user_metadata: { full_name: role },
        created_at: now, updated_at: now,
      };
      const session = { access_token: `mock.${role}`, refresh_token: `mock.${role}.r`, token_type: 'bearer', expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user };
      const context = await browser.newContext({ viewport });
      await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
      await context.route('**/*', adminRoutes(baseUrl, role));
      const page = await context.newPage();
      return { context, page };
    };

    adminInstructors = makeAdminInstructors();
    adminRpcCalls = [];
    adminRpcOverrides = {};
    {
      const { context, page } = await adminPage('admin');
      const dialogs = [];
      page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
      await page.goto(`${baseUrl}/admin/instructors`, { waitUntil: 'networkidle' });
      await page.locator('tbody tr').first().waitFor();

      await step('B1 進度篩選新增「待確認 Email」「待信箱驗證」，各階段人數正確', async () => {
        const expected = {
          all: '全部 5', unclaimed: '未認領 1', pending_review: '待審核 1',
          awaiting_email_confirm: '待確認 Email 1', awaiting_email_verify: '待信箱驗證 1',
          incomplete: '資料未完整 0', awaiting_contract: '待簽約 0', complete: '已完成 1',
        };
        for (const [key, text] of Object.entries(expected)) assert.equal(await chipText(page, key), text, key);
        assert.equal(await chipText(page, 'todo'), '還沒完成 4');
      });
      await step('B1b 每列標籤：黃待確認＝待確認 Email、周待驗證＝待信箱驗證、李新建＝待審核（不靠 Email 判斷新建帳號）', async () => {
        const stageOf = (name) => rowOf(page, name).first().locator('[data-progress]').getAttribute('data-progress');
        assert.equal(await stageOf('黃待確認'), 'awaiting_email_confirm');
        assert.equal(await stageOf('周待驗證'), 'awaiting_email_verify');
        assert.equal(await stageOf('李新建'), 'pending_review');
        assert.equal(await stageOf('趙已啟用'), 'complete');
        assert.equal(await stageOf('王空位'), 'unclaimed');
      });
      await step('B1c 篩選「待確認 Email」只剩一位', async () => {
        await page.locator('[data-progress-filter="awaiting_email_confirm"]').click();
        await page.locator('[data-progress-filter="awaiting_email_confirm"][aria-pressed="true"]').waitFor();
        assert.deepEqual(await page.locator('tbody tr td:first-child .font-bold').allInnerTexts(), ['黃待確認']);
        await page.locator('[data-progress-filter="all"]').click();
        await page.locator('[data-progress-filter="all"][aria-pressed="true"]').waitFor();
      });

      await step('B2a 非姓名空位的列：「確認 Email」視窗照舊預填主檔 Email、沒有認領者提示', async () => {
        await rowOf(page, '李新建').getByRole('button', { name: '確認 Email' }).click();
        const modal = page.getByTestId('confirm-email-modal');
        await modal.waitFor();
        assert.equal(await modal.locator('#confirm-email-input').inputValue(), 'new@example.com');
        assert.equal(await modal.getByTestId('claimant-email-hint').count(), 0);
        await modal.getByRole('button', { name: '取消' }).click();
        await modal.waitFor({ state: 'detached' });
      });
      await step('B2 姓名空位的列：視窗不預填（認領者可能改過主檔 Email），旁邊小字列出認領者填的 Email；空白送出顯示必填提示且不呼叫 RPC', async () => {
        await rowOf(page, '黃待確認').getByRole('button', { name: '確認 Email' }).click();
        const modal = page.getByTestId('confirm-email-modal');
        await modal.waitFor();
        assert.equal(await modal.locator('#confirm-email-input').inputValue(), '');
        assert.equal(await modal.getByTestId('claimant-email-hint').innerText(),
          '認領者填的 Email：huang@example.com（請勿直接採用，請與老師透過原有管道確認）');
        await modal.locator('#confirm-email-input').fill('');
        await modal.getByTestId('confirm-email-submit').click();
        const errors = await modal.getByRole('alert').allInnerTexts();
        assert.ok(errors.some((text) => text.includes('請輸入要確認的 Email')) && errors.some((text) => text.includes('請註記是怎麼和老師確認的')), errors.join('|'));
        assert.equal(adminRpcCalls.filter((call) => call.name === 'admin_confirm_instructor_email').length, 0);
      });
      await step('B2b 伺服器拒絕時顯示白話錯誤並保留視窗', async () => {
        adminRpcOverrides.admin_confirm_instructor_email = () => ({ __error: 'EMAIL_IN_USE duplicate 23505' });
        const modal = page.getByTestId('confirm-email-modal');
        await modal.locator('#confirm-email-input').fill('Huang@Example.com');
        await modal.locator('#confirm-email-note').fill('10/20 透過 LINE 與老師本人確認');
        await modal.getByTestId('confirm-email-submit').click();
        await modal.getByTestId('confirm-email-error').waitFor({ timeout: 5000 });
        assert.ok((await modal.getByTestId('confirm-email-error').innerText()).includes('已經被其他講師使用'));
        delete adminRpcOverrides.admin_confirm_instructor_email;
      });
      await step('B2c 送出 admin_confirm_instructor_email：Email 轉小寫、帶管道註記；成功後提示並重新整理列表', async () => {
        const modal = page.getByTestId('confirm-email-modal');
        adminRpcCalls = [];
        await modal.getByTestId('confirm-email-submit').click();
        await page.getByRole('status').filter({ hasText: '已登錄 黃待確認 的已確認 Email：huang@example.com' }).waitFor({ timeout: 8000 });
        const calls = adminRpcCalls.filter((call) => call.name === 'admin_confirm_instructor_email');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body, {
          p_instructor_id: adminInstructors[0].id, p_email: 'huang@example.com', p_note: '10/20 透過 LINE 與老師本人確認',
        });
        assert.equal(await page.getByTestId('confirm-email-modal').count(), 0);
        // 重新整理後該位改成「待信箱驗證」（已有已確認 Email）
        await page.waitForFunction(() => document.querySelector('[data-progress-filter="awaiting_email_verify"]')?.textContent.replace(/\s+/g, ' ').trim() === '待信箱驗證 2', null, { timeout: 8000 });
        assert.equal(await chipText(page, 'awaiting_email_confirm'), '待確認 Email 0');
      });
      await step('B3 展開列顯示已確認 Email、確認時間（台北時間）、確認方式與管道註記', async () => {
        await rowOf(page, '周待驗證').locator('td').first().click();
        const info = page.locator('tbody').getByTestId('email-confirmation').first();
        await info.waitFor({ timeout: 5000 });
        const text = await info.innerText();
        assert.ok(text.includes('zhou@example.com') && text.includes('2026-10-20 11:00（台北時間）')
          && text.includes('管理員經可信管道確認') && text.includes('10/20 透過 LINE 與老師確認'), text);
      });
      await page.screenshot({ path: path.join(shotDir, 'admin-instructors-email-confirm.png'), fullPage: true });
      await context.close();
    }

    adminInstructors = makeAdminInstructors();
    {
      const { context, page } = await adminPage('admin');
      await page.goto(`${baseUrl}/admin`, { waitUntil: 'networkidle' });
      await step('B1d 後台首頁追蹤卡列出「待確認 Email 1・待信箱驗證 1」', async () => {
        const card = page.getByRole('link', { name: /老師資料追蹤/ });
        await card.waitFor({ timeout: 8000 });
        assert.match(await card.innerText(), /待審核 1・待確認 Email 1・待信箱驗證 1・資料未完整 0/);
      });
      await context.close();
    }

    adminInstructors = makeAdminInstructors();
    activationReads = 0;
    adminRpcCalls = [];
    {
      const { context, page } = await adminPage('mentor');
      await page.goto(`${baseUrl}/admin/instructors`, { waitUntil: 'networkidle' });
      await page.locator('tbody tr').first().waitFor();
      await step('B4 輔導員只拿到名冊：走名冊函式、不查啟用紀錄；沒有確認按鈕、進度篩選、進度欄，也不能展開看 Email', async () => {
        assert.equal(activationReads, 0);
        assert.ok(adminRpcCalls.some((call) => call.name === 'mentor_instructor_directory'), '應呼叫名冊函式');
        await rowOf(page, '周待驗證').first().waitFor({ timeout: 5000 });
        assert.equal(await page.getByRole('button', { name: '確認 Email' }).count(), 0);
        assert.equal(await page.locator('[data-progress-filter]').count(), 0);
        assert.equal(await page.locator('[data-progress]').count(), 0);
        // 輔導員不能展開列：沒有任何已確認 Email 區塊
        await rowOf(page, '周待驗證').locator('td').first().click();
        assert.equal(await page.getByTestId('email-confirmation').count(), 0);
        assert.equal(await page.getByText('zhou@example.com').count(), 0);
      });
      await context.close();
    }

    adminInstructors = makeAdminInstructors();
    adminRpcCalls = [];
    {
      const { context, page } = await adminPage('admin', { width: 390, height: 844 });
      await page.goto(`${baseUrl}/admin/instructors`, { waitUntil: 'networkidle' });
      await page.getByText('黃待確認').first().waitFor({ timeout: 8000 });
      await step('B5 390px：卡片上有「確認 Email」按鈕，視窗在畫面內、無水平溢出、控制項 ≥ 44px', async () => {
        const button = page.locator('[data-testid="confirm-email-button"]:visible').first();
        assert.ok((await button.boundingBox()).height >= 44);
        await button.click();
        const modal = page.getByTestId('confirm-email-modal');
        await modal.waitFor();
        const metrics = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]').getBoundingClientRect();
          const controls = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] input')];
          return {
            left: Math.round(dialog.left), right: Math.round(dialog.right),
            small: controls.filter((node) => node.getBoundingClientRect().height < 44).map((node) => node.textContent.trim() || node.id),
          };
        });
        assert.ok(metrics.left >= 0 && metrics.right <= 390, JSON.stringify(metrics));
        assert.deepEqual(metrics.small, [], `小於 44px：${metrics.small}`);
        assert.ok(await overflowOf(page) <= 0);
      });
      await page.screenshot({ path: path.join(shotDir, 'admin-confirm-email-mobile.png'), fullPage: false });
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
