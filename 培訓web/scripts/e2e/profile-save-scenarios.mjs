#!/usr/bin/env node
/*
 * 個人資料頁「存檔」端到端驗證：真 PostgreSQL（repo 全部 SQL：trigger＋RLS）＋真 PostgREST
 * ＋假 GoTrue／Storage 閘道（storage RLS 以呼叫者身分在 PostgreSQL 內執行）＋Vite build＋Playwright。
 *
 *   node scripts/e2e/profile-save-scenarios.mjs              # P1–P9（目前程式）＋P6、P10 反向對照
 *   node scripts/e2e/profile-save-scenarios.mjs --skip-p6    # 不跑 P6
 *   node scripts/e2e/profile-save-scenarios.mjs --skip-p10   # 不跑 P10
 *
 * P1 新講師第一次填表（沒有主檔、Email＝Google）
 * P2 姓名＋手機＋末四碼認領的舊講師，主要 Email ≠ Google；只改暱稱
 * P3 form-import 講師（四份證件在 form-import/），Email 自動對應認領；只改文字欄位
 * P4 form-import 講師以姓名＋手機＋末四碼認領（Email ≠ Google），換一張身分證正面
 * P5 已有主檔的講師連續存兩次（電話、地址）
 * P6 反向對照：ProfilePage.jsx 暫時換成 1f5c350（upsert 版）重新 build，P2、P3 應被 42501／403 擋下；
 *    build 完立刻寫回原檔，並以 git diff --quiet -- src 確認乾淨。
 * P7 mentor（有自己的主檔）只改暱稱：存檔成功、角色仍是 mentor
 * P8 任職狀態 frozen、但管理員已把角色手動改回 teacher 的講師只改暱稱：存檔成功、存後角色仍是 teacher
 *    （頁面在凍結前就開著；重新載入時登入檢查本來就會把凍結講師降為 pending 並登出，只記 NOTE 不計分）
 * P7 需要 mentor 帳號：repo SQL 的 users_role_check 沒有 mentor，測試庫只放寬這一條 constraint（印 NOTE）
 * P9 身分核對認領的舊講師把主要 Email 改成非 Google 信箱：被資料庫擋下、畫面顯示中文說明、資料庫不變
 * P10 反向對照：ProfilePage.jsx 暫時換成 3168949（UPDATE 每次都帶 user_id、email_primary）重新 build，
 *    用同一套 P7／P8／P9 斷言跑，P7、P8（及 P9 的中文說明）必須 FAIL，並確認舊版確實重現兩個問題；
 *    同 P6 的手法 build 完立刻寫回原檔、git diff --quiet -- src 確認乾淨。
 *
 * 2026-10-20 帳號啟用（docs/specs/2026-10-20-claim-activation-esign.md）合併後：任何認領都只「綁定＋待啟用」，
 * 要用寄到「已確認 Email」的驗證碼才會變 teacher。P2～P5、P7～P9 要測的是「已開通的老師存檔」，所以認領後
 * 先斷言「綁定本人＋待啟用（pending）」，再照正式路徑（管理員確認 Email → 本人要碼 → 驗證）啟用成 teacher，才開始存檔測試。
 * 待審核頁的按鈕也改成「認領帳號／新建帳號」（身分核對要先在姓名步驟回 not_found）。
 *
 * 執行前 src 必須已 commit（P6／P10 靠 git diff --quiet -- src 證明還原乾淨）。
 *
 * 每個斷言都對資料庫查回比對（instructors 整列前後 diff、storage.objects），不是只看畫面。
 * 絕不連正式 Supabase；不改 培訓web/.env。initdb 需要 shared memory，請在沙盒外執行。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startStack } from './lib/stack.mjs';
import { makeApi, createGoogleUser, adminCreateInstructor, samplePng, latestOtp, setEmailConfigured } from './lib/fixtures.mjs';
import { launchBrowser, openAs, shot, fieldControl } from './lib/browser.mjs';
import { Results, sleep } from './lib/util.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = new Set(process.argv.slice(2));
const shotsDir = path.join(appDir, 'docs/verification/2026-10-20-profile-save-e2e');
mkdirSync(shotsDir, { recursive: true });

const BUCKET = 'instructor_uploads';
const DOC_KEYS = ['photo', 'id_front', 'id_back', 'bankbook'];
const FILE_SUFFIXES = ['_path', '_mime', '_size', '_uploaded_at'];
const DOC_FIELDS = DOC_KEYS.flatMap((key) => FILE_SUFFIXES.map((suffix) => `${key}${suffix}`));
const IMPORTED_AT = '2026-08-20T03:00:00+00:00';
const UPSERT_COMMIT = '1f5c350';
const ALWAYS_SEND_IDENTITY_COMMIT = '3168949'; // UPDATE payload 每次都帶 user_id 與 email_primary 的版本
const GOOGLE_EMAIL_HINT = '主要 Email 必須是你登入用的 Google 信箱';

const r = new Results();
let activeStack = null;
let activeBrowser = null;
let profileFile = null;
let profileOriginal = null;

const restoreProfilePage = () => {
  if (profileFile && profileOriginal) writeFileSync(profileFile, profileOriginal);
};
const cleanup = async () => {
  restoreProfilePage();
  try { await activeBrowser?.close(); } catch { /* ignore */ }
  try { await activeStack?.stop(); } catch { /* ignore */ }
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n收到 ${signal}，還原檔案並收掉本測試起的行程…`);
    await cleanup();
    process.exit(130);
  });
}

// ── 小工具 ────────────────────────────────────────────────────────────
let seq = 0;
const digits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const isBlank = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
const short = (v) => (typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}…` : v);

async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 200 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function visible(locator, timeout = 10000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

// 每列前後比較（略過 updated_at）。changed：值不同的欄位；lost：原本有值卻被改掉、且不在預期清單內；
// normalized：原本 null／空，存檔後變成空字串之類（沒有資料遺失，僅列出）。
function diffRows(before, after, expected = []) {
  const changed = {};
  for (const key of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (key === 'updated_at') continue;
    if (JSON.stringify(before?.[key] ?? null) !== JSON.stringify(after?.[key] ?? null)) {
      changed[key] = { from: before?.[key] ?? null, to: after?.[key] ?? null };
    }
  }
  const unexpected = Object.keys(changed).filter((key) => !expected.includes(key));
  const normalized = unexpected.filter((key) => isBlank(changed[key].from) && isBlank(changed[key].to));
  const lost = unexpected.filter((key) => !normalized.includes(key));
  return { changed, lost, normalized };
}

const describeChanges = (changed, keys) => keys.map((key) => `${key}: ${JSON.stringify(short(changed[key].from))}→${JSON.stringify(short(changed[key].to))}`).join('; ');

function makeCtx(stack, api, admin, browser, phase, shotPrefix) {
  const ctx = { stack, api, admin, browser, phase, shotPrefix, consoleErrors: [] };
  ctx.rowOfUser = (uid) => api.json(`SELECT row_to_json(i) FROM public.instructors i WHERE i.user_id = :'uid'`, { uid });
  ctx.rowById = (id) => api.json(`SELECT row_to_json(i) FROM public.instructors i WHERE i.id = :'id'`, { id });
  ctx.roleOf = (uid) => api.sql(`SELECT role FROM public.users WHERE id = :'uid'`, { uid });
  ctx.objectOf = (name) => api.json(`
    SELECT json_build_object('owner_id', o.owner_id, 'size', (o.metadata->>'size')::int, 'mimetype', o.metadata->>'mimetype')
      FROM storage.objects o WHERE o.bucket_id = '${BUCKET}' AND o.name = :'name'`, { name });
  ctx.draftCount = (uid) => Number(api.sql(`SELECT count(*) FROM public.instructor_profile_drafts WHERE user_id = :'uid'`, { uid }));
  return ctx;
}

async function newUser(ctx, prefix, fullName, email) {
  seq += 1;
  const mail = (email || `${prefix}-${Date.now().toString(36)}-${seq}@e2e.test`).toLowerCase();
  const user = await createGoogleUser(ctx.stack, { email: mail, fullName });
  if (!user.id) throw new Error(`Google 帳號建立被 hook 拒絕：${JSON.stringify(user.hookRejected)}`);
  return user;
}

// 以某人身分上傳到 instructor_uploads（走閘道 → storage RLS）
async function uploadAs(ctx, token, name, { mime = 'image/png', label } = {}) {
  const bytes = samplePng(label || name);
  const res = await ctx.api.request(token, 'POST', `/storage/v1/object/${BUCKET}/${name}`, {
    raw: bytes, headers: { 'content-type': mime },
  });
  if (res.status !== 200) throw new Error(`upload ${name} failed ${res.status} ${JSON.stringify(res.data)}`);
  return { path: name, mime, size: bytes.length };
}

const docColumns = (files) => Object.fromEntries(Object.entries(files).flatMap(([key, f]) => [
  [`${key}_path`, f.path], [`${key}_mime`, f.mime], [`${key}_size`, f.size], [`${key}_uploaded_at`, IMPORTED_AT],
]));

async function adminPatchInstructor(ctx, id, body) {
  const res = await ctx.api.rest(ctx.admin.token, 'PATCH', `instructors?id=eq.${id}`, { body, prefer: 'return=minimal' });
  if (res.status !== 204) throw new Error(`admin PATCH instructor failed ${res.status} ${JSON.stringify(res.data)}`);
}

// 舊講師／匯入講師的「完整」主檔：講師頁必填 18 欄＋接課地區都有值，另帶幾個非表單欄位（管理員欄位、舊資料參考欄）
function legacyRow({ fullName, email, idNumber, phone, extra = {} }) {
  return {
    full_name: fullName, nickname: `${fullName.slice(-2)}老師`, gender: '男', birth_date: '1988-08-08',
    id_number: idNumber, phone_mobile: phone, phone_home: null, line_id: `legacy_${digits(5)}`,
    address: '臺中市西屯區舊資料路 8 號', household_address: '臺中市西屯區戶籍路 9 號',
    email_primary: email, email_secondary: null,
    teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 4 次', teaching_regions: ['臺中市', '彰化縣'],
    bio_notes: '舊資料匯入的教學經歷與理念。',
    bank_account_name: fullName, bank_name: '華南銀行', bank_branch: '仁愛分行', bank_code: '0081234',
    bank_account_number: `1234${digits(8)}`,
    employment_status: 'active', instructor_role: 'A', form_submitted_at: '2026-08-15T02:00:00+00:00',
    note_internal: '管理員內部備註（不可被講師存檔改掉）', teaching_regions_raw: '台中、彰化',
    bank_info_raw: '華南 仁愛 原文', line_name: '舊 Line 名稱', school_info: '某大學 資工系', shirt_size: 'L',
    ...extra,
  };
}

// 追蹤瀏覽器對 /rest/v1/instructors 的寫入請求（方法、網址、送出的欄位、回應狀態與內容）
function trackInstructorWrites(page) {
  const writes = [];
  const byRequest = new Map();
  page.on('request', (req) => {
    if (!/\/rest\/v1\/instructors(\?|$)/.test(req.url()) || !['PATCH', 'POST', 'PUT'].includes(req.method())) return;
    let body = null;
    try { body = JSON.parse(req.postData() || 'null'); } catch { body = req.postData(); }
    const entry = { method: req.method(), url: req.url(), body };
    writes.push(entry);
    byRequest.set(req, entry);
  });
  page.on('response', async (res) => {
    const entry = byRequest.get(res.request());
    if (!entry) return;
    let data = null;
    try { data = JSON.parse(await res.text()); } catch { /* ignore */ }
    entry.response = data;
    entry.status = res.status();
  });
  page.on('requestfailed', (req) => {
    const entry = byRequest.get(req);
    if (entry) entry.status = 0;
  });
  return writes;
}

async function openSession(ctx, user) {
  const s = await openAs(ctx.browser, ctx.stack, user);
  s.writes = trackInstructorWrites(s.page);
  return s;
}

const goto = (ctx, s, route) => s.page.goto(`${ctx.stack.baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
const waitProfileLoaded = (page) => fieldControl(page, '姓名').waitFor({ state: 'visible', timeout: 20000 });

async function saveAndWait(s, { firstTime = false } = {}) {
  const dialogsBefore = s.dialogs.length;
  const writesBefore = s.writes.length;
  await s.page.getByRole('button', { name: /送出資料|儲存個人資料/ }).click();
  const outcome = await pollUntil(async () => {
    const d = s.dialogs.slice(dialogsBefore).find((x) => /個人資料已儲存|儲存失敗|請先補齊/.test(x.message));
    if (d) return { ok: d.message.includes('個人資料已儲存'), message: d.message };
    if (firstTime && await s.page.getByText('恭喜你完成註冊！').isVisible().catch(() => false)) {
      return { ok: true, message: '恭喜你完成註冊！（成功彈窗）' };
    }
    return null;
  }, { timeoutMs: 20000 });
  await pollUntil(() => s.writes.slice(writesBefore).every((w) => w.status !== undefined), { timeoutMs: 5000 });
  await sleep(300); // 讓存檔後的 storage 清理請求跑完
  return {
    ...(outcome || { ok: false, message: '20 秒內沒有成功或失敗訊息' }),
    writes: s.writes.slice(writesBefore),
    dialogs: s.dialogs.slice(dialogsBefore).map((d) => d.message),
  };
}

const writeSummary = (writes) => writes.map((w) => {
  const u = new URL(w.url);
  return `${w.method} ${u.pathname.replace('/rest/v1/', '')}${u.search}→${w.status}${w.response?.code ? `(${w.response.code})` : ''}`;
}).join(', ') || '（沒有寫入請求）';

const sentDocFields = (writes) => [...new Set(writes.flatMap((w) => (w.body && typeof w.body === 'object' ? Object.keys(Array.isArray(w.body) ? w.body[0] || {} : w.body) : [])))]
  .filter((key) => DOC_FIELDS.includes(key));

// 身分核對認領（PendingApproval「認領帳號」：先用姓名找空位 → 沒有（舊講師有個資）→ 再核對手機＋身分證末四碼）
async function claimByIdentityUI(ctx, s, { fullName, phoneDigits, last4 }) {
  await goto(ctx, s, '/pending');
  await s.page.getByRole('button', { name: /^認領帳號/ }).click();
  await s.page.locator('#claim-full-name').fill(fullName);
  await s.page.getByRole('button', { name: '用姓名認領' }).click();
  await s.page.locator('#claim-phone').waitFor({ state: 'visible', timeout: 10000 });
  await s.page.locator('#claim-phone').fill(phoneDigits);
  await s.page.locator('#claim-id-last-four').fill(last4);
  await s.page.getByRole('button', { name: '核對並帶入資料' }).click();
  await s.page.waitForURL(/\/profile$/, { timeout: 15000 }).catch(() => {});
  return /\/profile$/.test(s.page.url());
}

const activationOf = (ctx, uid) => ctx.api.json(
  `SELECT row_to_json(a) FROM public.instructor_account_activations a WHERE a.user_id = :'uid' ORDER BY a.claimed_at DESC LIMIT 1`, { uid },
);

// 認領後「只綁不開通」：照正式路徑啟用（管理員確認 Email → 本人要碼 → 從測試信箱讀碼驗證），回傳啟用後角色
async function activateClaimedViaRest(ctx, user, instructorId, email) {
  setEmailConfigured(ctx.api, true);
  const confirm = await ctx.api.rpc(ctx.admin.token, 'admin_confirm_instructor_email', {
    p_instructor_id: instructorId, p_email: email, p_note: 'E2E：存檔測試前由管理員確認',
  });
  if (confirm.data?.status !== 'confirmed') throw new Error(`admin_confirm_instructor_email failed ${JSON.stringify(confirm.data)}`);
  const sent = await ctx.api.rpc(user.token, 'request_email_otp', { p_purpose: 'account_activation' });
  if (sent.data?.status !== 'sent') throw new Error(`request_email_otp ${JSON.stringify(sent.data)}`);
  const otp = latestOtp(ctx.api, user.id, 'account_activation');
  const verified = await ctx.api.rpc(user.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
  if (!verified.data?.activated) throw new Error(`verify_email_otp ${JSON.stringify(verified.data)}`);
  return ctx.roleOf(user.id);
}

// 存檔失敗時（P6 預期）共用的斷言：被 42501／403 擋、資料庫整列不變
function checkBlocked(label, outcome, before, after) {
  const write = outcome.writes.find((w) => w.method === 'POST' && /on_conflict=user_id/.test(w.url));
  r.check(`${label} 舊 upsert 版存檔被擋（畫面顯示儲存失敗）`, !outcome.ok && /儲存失敗/.test(outcome.message), outcome.message);
  r.check(`${label} 寫入請求是 POST …?on_conflict=user_id 且回 403／42501`,
    Boolean(write) && write.status === 403 && write.response?.code === '42501',
    `${writeSummary(outcome.writes)}；message=${write?.response?.message || ''}`);
  const d = diffRows(before, after);
  r.check(`${label} 被擋後資料庫主檔完全沒變`, Object.keys(d.changed).length === 0, describeChanges(d.changed, Object.keys(d.changed)));
}

// 單一寫入請求送出的欄位名
const sentKeys = (write) => (write?.body && typeof write.body === 'object' && !Array.isArray(write.body) ? Object.keys(write.body) : []);

// 管理員在「帳號管理」改角色（TeacherManager.changeRole：users.update({ role })），走 admin JWT＋RLS
async function adminSetRole(ctx, uid, role) {
  const res = await ctx.api.rest(ctx.admin.token, 'PATCH', `users?id=eq.${uid}`, { body: { role }, prefer: 'return=minimal' });
  if (res.status !== 204) throw new Error(`admin PATCH users role failed ${res.status} ${JSON.stringify(res.data)}`);
}

// repo 的 SQL 鏈裡 users.role 的 CHECK（supabase/setup.sql:8）只有 pending／teacher／admin，沒有 mentor，
// 但前端路由、RLS、claim RPC、guard trigger 都把 mentor 當有效角色。測試庫只放寬這一條 constraint 才建得出 mentor 帳號。
function ensureMentorRoleAllowed(ctx, label, results) {
  const def = ctx.api.sql(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.users'::regclass AND conname = 'users_role_check'`);
  if (def && !def.includes("'mentor'")) {
    ctx.api.sql(`ALTER TABLE public.users DROP CONSTRAINT users_role_check, ADD CONSTRAINT users_role_check CHECK (role IN ('pending', 'teacher', 'mentor', 'admin'))`);
    results.note(`${label} 測試庫補丁：repo SQL 的 users_role_check 不含 mentor（${def}），已放寬為含 mentor 才能建立 mentor 帳號`);
  }
}

// 已有自己的主檔（Email＝Google 自動對應認領）、四份證件在本人資料夾（同 P5 的種法）
async function seedOwnedInstructor(ctx, { tag, fullName }) {
  seq += 1;
  const email = `${tag}-${seq}-${Date.now().toString(36)}@e2e.test`;
  const seeded = await adminCreateInstructor(ctx.api, ctx.admin, legacyRow({
    fullName: `${fullName}${seq}`, email, idNumber: `F12345${digits(4)}`, phone: `0966${digits(6)}`,
  }));
  const user = await newUser(ctx, tag, `${tag} Google`, email);
  const files = {};
  for (const key of DOC_KEYS) files[key] = await uploadAs(ctx, user.token, `instructors/${user.id}/${key}/${randomUUID()}.png`, { label: `${tag}-${key}-${seq}` });
  await adminPatchInstructor(ctx, seeded.id, docColumns(files));
  // Email 自動對應只綁定待啟用；這些情境要的是「已開通的老師」，照正式路徑啟用
  await activateClaimedViaRest(ctx, user, seeded.id, email);
  return { seeded, user, email };
}

// ═══ P1 第一次填表的新講師 ════════════════════════════════════════════
async function scenarioP1(ctx) {
  const fullName = 'P1 新講師';
  const user = await newUser(ctx, 'p1-new', fullName);
  const s = await openSession(ctx, user);
  try {
    r.check('P1 起始狀態：沒有主檔、帳號為 pending', !ctx.rowOfUser(user.id) && ctx.roleOf(user.id) === 'pending');
    await goto(ctx, s, '/pending');
    await s.page.getByRole('button', { name: /^新建帳號/ }).click();
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 });
    await waitProfileLoaded(s.page);
    r.check('P1 /profile 預填登入 Email', await fieldControl(s.page, '主要 Email').inputValue() === user.email);

    const data = {
      full_name: fullName, nickname: '新講師老師', gender: '女', birth_date: '1995-05-05',
      id_number: `A2${digits(8)}`, phone_mobile: `09${digits(8)}`, line_id: `line_${digits(5)}`,
      address: '臺北市信義區測試路 1 號', household_address: '新北市板橋區戶籍路 2 號',
      teaching_freq_semester: '每週 2 次', teaching_freq_vacation: '每週 4 次',
      bio_notes: '端到端測試填寫的教學經歷與理念。', bank_account_name: fullName, bank_name: '華南銀行',
      bank_branch: '仁愛分行', bank_code: '0081234', bank_account_number: `1234${digits(8)}`,
    };
    const labels = {
      full_name: '姓名', nickname: '講師暱稱', gender: '性別', birth_date: '出生年月日', id_number: '身分證字號',
      phone_mobile: '手機號碼', line_id: 'Line ID', address: '通訊地址', household_address: '戶籍地址',
      teaching_freq_semester: '接課頻率（學期間）', teaching_freq_vacation: '接課頻率（寒暑假）',
      bio_notes: '教學經歷 / 教學理念 / 想說的話', bank_account_name: '匯款戶名', bank_name: '銀行別',
      bank_branch: '分行別', bank_code: '銀行代碼（6–7 碼）', bank_account_number: '銀行帳號（含檢查碼）',
    };
    for (const [key, label] of Object.entries(labels)) {
      const control = fieldControl(s.page, label);
      if (await control.evaluate((el) => el.tagName) === 'SELECT') await control.selectOption(data[key]);
      else await control.fill(data[key]);
    }
    for (const county of ['臺北市', '新北市']) {
      await s.page.locator('label.bh-chip', { hasText: county }).first().click();
    }
    const uploads = {};
    for (const key of DOC_KEYS) {
      const buffer = samplePng(`p1-${key}-${user.id}`);
      uploads[key] = buffer.length;
      const input = key === 'photo'
        ? s.page.locator('input[type=file]:not([data-testid])').first()
        : s.page.locator(`[data-testid="${key}-file-input"]`);
      await input.setInputFiles({ name: `${key}.png`, mimeType: 'image/png', buffer });
    }

    const outcome = await saveAndWait(s, { firstTime: true });
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-P1-after-save`);
    r.check('P1 存檔成功（恭喜完成註冊）', outcome.ok, outcome.message);
    r.check('P1 寫入順序：先 PATCH（0 列）再 INSERT 建主檔',
      outcome.writes.length === 2 && outcome.writes[0].method === 'PATCH' && outcome.writes[0].status === 200
      && Array.isArray(outcome.writes[0].response) && outcome.writes[0].response.length === 0
      && outcome.writes[1].method === 'POST' && outcome.writes[1].status === 201,
      writeSummary(outcome.writes));

    const row = ctx.rowOfUser(user.id);
    r.check('P1 主檔已建立：user_id＝本人、主要 Email＝Google 信箱', row?.user_id === user.id && row?.email_primary === user.email,
      `email_primary=${row?.email_primary}`);
    const textMismatch = Object.keys(labels).filter((key) => row?.[key] !== data[key]);
    r.check('P1 文字欄位逐欄與畫面輸入一致', textMismatch.length === 0, textMismatch.map((k) => `${k}=${row?.[k]}`).join('; '));
    r.check('P1 接課地區已存', JSON.stringify(row?.teaching_regions) === JSON.stringify(['臺北市', '新北市']), JSON.stringify(row?.teaching_regions));
    const docProblems = [];
    for (const key of DOC_KEYS) {
      const p = row?.[`${key}_path`];
      const obj = p ? ctx.objectOf(p) : null;
      if (!p?.startsWith(`instructors/${user.id}/${key}/`)) docProblems.push(`${key}_path=${p}`);
      if (row?.[`${key}_mime`] !== 'image/png' || row?.[`${key}_size`] !== uploads[key]) docProblems.push(`${key} mime/size=${row?.[`${key}_mime`]}/${row?.[`${key}_size`]}`);
      if (!obj || obj.owner_id !== user.id || obj.size !== uploads[key]) docProblems.push(`${key} storage=${JSON.stringify(obj)}`);
    }
    r.check('P1 四份證件路徑都在 instructors/<uid>/<種類>/，mime／size 正確，storage 物件存在且 owner＝本人', docProblems.length === 0,
      docProblems.join('; ') || `例：${row?.id_front_path}`);
    r.check('P1 草稿已清除', ctx.draftCount(user.id) === 0);
    r.note(`P1 存檔後帳號角色＝${ctx.roleOf(user.id)}（新講師送出後等待管理員審核）`);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `P1: ${e}`));
    await s.context.close();
  }
}

// ═══ P2 身分核對認領的舊講師（主要 Email ≠ Google）只改暱稱 ═════════════
async function scenarioP2(ctx, { label = 'P2', expectBlocked = false } = {}) {
  seq += 1;
  const fullName = `舊講師陳${seq}`;
  const legacyEmail = `legacy-chen-${seq}-${Date.now().toString(36)}@old-mail.example`;
  const phoneDigits = `0912${digits(6)}`;
  const idNumber = `B22345${digits(4)}`;
  const legacy = await adminCreateInstructor(ctx.api, ctx.admin, legacyRow({
    fullName, email: legacyEmail, idNumber, phone: `${phoneDigits.slice(0, 4)}-${phoneDigits.slice(4, 7)}-${phoneDigits.slice(7)}`,
  }));
  const user = await newUser(ctx, 'p2-google', 'Chen Google');
  // 證件：本人資料夾（講師自己上傳過；用本人 token 走 storage RLS），由管理員把路徑寫進主檔
  const files = {};
  for (const key of DOC_KEYS) files[key] = await uploadAs(ctx, user.token, `instructors/${user.id}/${key}/${randomUUID()}.png`, { label: `p2-${key}-${seq}` });
  await adminPatchInstructor(ctx, legacy.id, docColumns(files));

  const s = await openSession(ctx, user);
  try {
    const claimed = await claimByIdentityUI(ctx, s, { fullName, phoneDigits, last4: idNumber.slice(-4) });
    const claimedRow = ctx.rowById(legacy.id);
    const act = activationOf(ctx, user.id);
    const roleAfterClaim = ctx.roleOf(user.id);
    const role = await activateClaimedViaRest(ctx, user, legacy.id, legacyEmail);
    await goto(ctx, s, '/profile');
    const before = ctx.rowById(legacy.id);
    r.check(`${label} 姓名＋手機＋末四碼認領成功（同一列綁定本人、只綁不開通：pending＋identity_check 待啟用），用 Email 驗證碼啟用後角色 teacher`,
      claimed && claimedRow?.user_id === user.id && roleAfterClaim === 'pending' && act?.status === 'pending' && act?.claim_method === 'identity_check'
      && role === 'teacher', `url=${s.page.url()} 認領後 role=${roleAfterClaim} 啟用後 role=${role}`);
    await waitProfileLoaded(s.page);
    r.check(`${label} /profile 帶入舊主要 Email（≠ Google 信箱）`,
      await fieldControl(s.page, '主要 Email').inputValue() === legacyEmail && legacyEmail !== user.email);
    const newNickname = `陳暱稱${seq}`;
    await fieldControl(s.page, '講師暱稱').fill(newNickname);
    const outcome = await saveAndWait(s);
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-${label}-after-save`);
    const after = ctx.rowById(legacy.id);
    if (expectBlocked) {
      checkBlocked(label, outcome, before, after);
      return;
    }
    r.check(`${label} 存檔成功`, outcome.ok, outcome.message);
    r.check(`${label} 寫入只有一次 PATCH（UPDATE 1 列），沒有 INSERT／upsert`,
      outcome.writes.length === 1 && outcome.writes[0].method === 'PATCH' && outcome.writes[0].status === 200
      && outcome.writes[0].response?.length === 1, writeSummary(outcome.writes));
    r.check(`${label} 暱稱已更新、主要 Email 仍是舊信箱`,
      after?.nickname === newNickname && after?.email_primary === legacyEmail,
      `nickname=${after?.nickname} email_primary=${after?.email_primary}`);
    const d = diffRows(before, after, ['nickname']);
    r.check(`${label} 其他欄位（含 4 份證件、管理員欄位、舊資料參考欄）都沒被改掉`, d.lost.length === 0,
      d.lost.length ? describeChanges(d.changed, d.lost) : `變動欄位：${Object.keys(d.changed).join(', ')}`);
    if (d.normalized.length) r.note(`${label} 原本空值被存成空字串（無資料遺失）：${describeChanges(d.changed, d.normalized)}`);
    r.check(`${label} 這次沒有送任何證件欄位`, sentDocFields(outcome.writes).length === 0, sentDocFields(outcome.writes).join(', '));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `${label}: ${e}`));
    await s.context.close();
  }
}

// form-import 匯入講師：管理員上傳四份證件到 form-import/，主檔帶匯入時的外部網址與管理員欄位
async function seedFormImport(ctx, { fullName, email, idNumber, phone, tag }) {
  const row = await adminCreateInstructor(ctx.api, ctx.admin, legacyRow({
    fullName, email, idNumber, phone,
    extra: Object.fromEntries(DOC_KEYS.map((key) => [`${key}_external_url`, `https://drive.google.com/open?id=FORM-${tag}-${key}`])),
  }));
  const files = {};
  for (const key of DOC_KEYS) {
    files[key] = await uploadAs(ctx, ctx.admin.token, `form-import/inst-${row.id}--${key}.jpg`, { mime: 'image/jpeg', label: `${tag}-${key}` });
  }
  await adminPatchInstructor(ctx, row.id, docColumns(files));
  return { row, files };
}

// ═══ P3 form-import 講師（Email 自動對應認領）只改文字欄位 ═════════════════
async function scenarioP3(ctx, { label = 'P3', expectBlocked = false } = {}) {
  seq += 1;
  const email = `p3-form-${seq}-${Date.now().toString(36)}@e2e.test`;
  const fullName = `匯入講師林${seq}`;
  const { row: seeded } = await seedFormImport(ctx, { fullName, email, idNumber: `C12345${digits(4)}`, phone: `0933${digits(6)}`, tag: `p3-${seq}` });
  const user = await newUser(ctx, 'p3', 'Lin Google', email);
  const s = await openSession(ctx, user);
  try {
    const act = activationOf(ctx, user.id);
    const roleAfterClaim = ctx.roleOf(user.id);
    const role = await activateClaimedViaRest(ctx, user, seeded.id, email);
    await goto(ctx, s, '/profile');
    await waitProfileLoaded(s.page);
    const before = ctx.rowById(seeded.id);
    r.check(`${label} Email 自動對應認領（同一列綁定本人、只綁不開通：pending＋email_match 待啟用）、啟用後角色 teacher、四份證件在 form-import/`,
      before?.user_id === user.id && roleAfterClaim === 'pending' && act?.status === 'pending' && act?.claim_method === 'email_match' && role === 'teacher'
      && DOC_KEYS.every((key) => before?.[`${key}_path`]?.startsWith('form-import/')),
      `認領後 role=${roleAfterClaim} 啟用後 role=${role} photo_path=${before?.photo_path}`);
    const edits = { nickname: `林暱稱${seq}`, line_id: `new_line_${seq}`, bio_notes: `更新後的教學理念 ${seq}` };
    await fieldControl(s.page, '講師暱稱').fill(edits.nickname);
    await fieldControl(s.page, 'Line ID').fill(edits.line_id);
    await fieldControl(s.page, '教學經歷 / 教學理念 / 想說的話').fill(edits.bio_notes);
    const outcome = await saveAndWait(s);
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-${label}-after-save`);
    const after = ctx.rowById(seeded.id);
    if (expectBlocked) {
      checkBlocked(label, outcome, before, after);
      return;
    }
    r.check(`${label} 存檔成功`, outcome.ok, outcome.message);
    r.check(`${label} 寫入只有一次 PATCH（UPDATE 1 列）`,
      outcome.writes.length === 1 && outcome.writes[0].method === 'PATCH' && outcome.writes[0].status === 200
      && outcome.writes[0].response?.length === 1, writeSummary(outcome.writes));
    r.check(`${label} PATCH 沒有夾帶任何證件欄位（omitUnchangedDocumentFields 生效）`, sentDocFields(outcome.writes).length === 0,
      sentDocFields(outcome.writes).join(', '));
    const textOk = Object.entries(edits).every(([key, value]) => after?.[key] === value);
    r.check(`${label} 三個文字欄位都已更新`, textOk, Object.keys(edits).map((k) => `${k}=${after?.[k]}`).join('; '));
    const docDiff = DOC_FIELDS.filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
    r.check(`${label} 四份證件的 path／mime／size／uploaded_at 原樣保留`, docDiff.length === 0,
      docDiff.length ? docDiff.map((k) => `${k}: ${before?.[k]}→${after?.[k]}`).join('; ') : `例：id_front=${after?.id_front_path} ${after?.id_front_mime} ${after?.id_front_size}`);
    const d = diffRows(before, after, Object.keys(edits));
    r.check(`${label} 其他欄位（管理員欄位、外部網址、舊資料參考欄）都沒被改掉`, d.lost.length === 0,
      d.lost.length ? describeChanges(d.changed, d.lost) : `變動欄位：${Object.keys(d.changed).join(', ')}`);
    if (d.normalized.length) r.note(`${label} 原本空值被存成空字串（無資料遺失）：${describeChanges(d.changed, d.normalized)}`);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `${label}: ${e}`));
    await s.context.close();
  }
}

// ═══ P4 form-import 講師（身分核對認領，Email ≠ Google）換一張身分證正面 ══════
async function scenarioP4(ctx) {
  seq += 1;
  const fullName = `匯入講師王${seq}`;
  const legacyEmail = `p4-old-${seq}-${Date.now().toString(36)}@old-mail.example`;
  const phoneDigits = `0955${digits(6)}`;
  const idNumber = `D12345${digits(4)}`;
  const { row: seeded, files } = await seedFormImport(ctx, { fullName, email: legacyEmail, idNumber, phone: phoneDigits, tag: `p4-${seq}` });
  const user = await newUser(ctx, 'p4-google', 'Wang Google');
  const s = await openSession(ctx, user);
  try {
    const claimed = await claimByIdentityUI(ctx, s, { fullName, phoneDigits, last4: idNumber.slice(-4) });
    const act = activationOf(ctx, user.id);
    const roleAfterClaim = ctx.roleOf(user.id);
    const role = await activateClaimedViaRest(ctx, user, seeded.id, legacyEmail);
    await goto(ctx, s, '/profile');
    const before = ctx.rowById(seeded.id);
    r.check('P4 身分核對認領成功（只綁不開通：pending＋identity_check）、啟用後 teacher、四份證件在 form-import/、主要 Email ≠ Google',
      claimed && before?.user_id === user.id && roleAfterClaim === 'pending' && act?.status === 'pending' && role === 'teacher'
      && DOC_KEYS.every((key) => before?.[`${key}_path`]?.startsWith('form-import/')) && before?.email_primary !== user.email,
      `認領後 role=${roleAfterClaim} 啟用後 role=${role}`);
    await waitProfileLoaded(s.page);
    const newFront = samplePng(`p4-new-front-${user.id}`, [200, 60, 40]);
    await s.page.locator('[data-testid="id_front-file-input"]').setInputFiles({ name: 'new-front.png', mimeType: 'image/png', buffer: newFront });
    const outcome = await saveAndWait(s);
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-P4-after-save`);
    const after = ctx.rowById(seeded.id);
    r.check('P4 存檔成功', outcome.ok, outcome.message);
    r.check('P4 寫入只有一次 PATCH（UPDATE 1 列）',
      outcome.writes.length === 1 && outcome.writes[0].method === 'PATCH' && outcome.writes[0].status === 200
      && outcome.writes[0].response?.length === 1, writeSummary(outcome.writes));
    const sent = sentDocFields(outcome.writes).sort();
    r.check('P4 PATCH 只送身分證正面的 4 個欄位', JSON.stringify(sent) === JSON.stringify(['id_front_mime', 'id_front_path', 'id_front_size', 'id_front_uploaded_at']), sent.join(', '));
    const newObj = after?.id_front_path ? ctx.objectOf(after.id_front_path) : null;
    r.check('P4 身分證正面換成 instructors/<uid>/id_front/ 新路徑，mime／size 正確，storage 物件 owner＝本人',
      after?.id_front_path?.startsWith(`instructors/${user.id}/id_front/`) && after?.id_front_mime === 'image/png'
      && after?.id_front_size === newFront.length && newObj?.owner_id === user.id && newObj?.size === newFront.length,
      `id_front_path=${after?.id_front_path} mime=${after?.id_front_mime} size=${after?.id_front_size} obj=${JSON.stringify(newObj)}`);
    const keptDiff = ['photo', 'id_back', 'bankbook'].flatMap((key) => FILE_SUFFIXES.map((sfx) => `${key}${sfx}`))
      .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
    r.check('P4 其他三份（大頭照、身分證反面、存摺）path／mime／size／uploaded_at 原樣保留', keptDiff.length === 0,
      keptDiff.join('; ') || `例：bankbook=${after?.bankbook_path}`);
    const d = diffRows(before, after, ['id_front_path', 'id_front_mime', 'id_front_size', 'id_front_uploaded_at']);
    r.check('P4 主要 Email 仍是舊信箱、其他欄位都沒被改掉', after?.email_primary === legacyEmail && d.lost.length === 0,
      d.lost.length ? describeChanges(d.changed, d.lost) : `變動欄位：${Object.keys(d.changed).join(', ')}`);
    if (d.normalized.length) r.note(`P4 原本空值被存成空字串（無資料遺失）：${describeChanges(d.changed, d.normalized)}`);
    r.check('P4 被換掉的 form-import 舊檔仍在 storage（講師刪不到管理員匯入檔）', Boolean(ctx.objectOf(files.id_front.path)), files.id_front.path);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `P4: ${e}`));
    await s.context.close();
  }
}

// ═══ P5 已有主檔的講師連續存兩次 ═════════════════════════════════════════
async function scenarioP5(ctx) {
  seq += 1;
  const email = `p5-existing-${seq}-${Date.now().toString(36)}@e2e.test`;
  const fullName = `現有講師張${seq}`;
  const seeded = await adminCreateInstructor(ctx.api, ctx.admin, legacyRow({ fullName, email, idNumber: `E12345${digits(4)}`, phone: `0977${digits(6)}` }));
  const user = await newUser(ctx, 'p5', 'Chang Google', email);
  const files = {};
  for (const key of DOC_KEYS) files[key] = await uploadAs(ctx, user.token, `instructors/${user.id}/${key}/${randomUUID()}.png`, { label: `p5-${key}-${seq}` });
  await adminPatchInstructor(ctx, seeded.id, docColumns(files));
  await activateClaimedViaRest(ctx, user, seeded.id, email); // Email 自動對應只綁定待啟用，先照正式路徑啟用成 teacher
  const s = await openSession(ctx, user);
  try {
    await goto(ctx, s, '/profile');
    await waitProfileLoaded(s.page);
    const before = ctx.rowById(seeded.id);
    r.check('P5 起始：已有主檔（本人、teacher、證件在本人資料夾）',
      before?.user_id === user.id && ctx.roleOf(user.id) === 'teacher' && before?.id_front_path?.startsWith(`instructors/${user.id}/`));
    const newPhone = `0988${digits(6)}`;
    await fieldControl(s.page, '手機號碼').fill(newPhone);
    const first = await saveAndWait(s);
    const mid = ctx.rowById(seeded.id);
    const newAddress = `臺北市大安區第二次存檔路 ${seq} 號`;
    await fieldControl(s.page, '通訊地址').fill(newAddress);
    const second = await saveAndWait(s);
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-P5-after-second-save`);
    const after = ctx.rowById(seeded.id);
    r.check('P5 第一次存檔（改電話）成功、資料庫已是新電話', first.ok && mid?.phone_mobile === newPhone,
      `${first.message}；phone_mobile=${mid?.phone_mobile}；${writeSummary(first.writes)}`);
    r.check('P5 第二次存檔（改地址）成功', second.ok, `${second.message}；${writeSummary(second.writes)}`);
    r.check('P5 兩次改動都在：電話＝第一次的新值、地址＝第二次的新值', after?.phone_mobile === newPhone && after?.address === newAddress,
      `phone_mobile=${after?.phone_mobile} address=${after?.address}`);
    const allDialogs = [...first.dialogs, ...second.dialogs];
    r.check('P5 沒有任何失敗／衝突訊息（只有兩次「個人資料已儲存」）',
      allDialogs.length === 2 && allDialogs.every((m) => m.includes('個人資料已儲存')), JSON.stringify(allDialogs));
    r.check('P5 兩次都是 PATCH 200（各更新 1 列）', [...first.writes, ...second.writes].length === 2
      && [...first.writes, ...second.writes].every((w) => w.method === 'PATCH' && w.status === 200 && w.response?.length === 1),
      `${writeSummary(first.writes)} | ${writeSummary(second.writes)}`);
    const d = diffRows(before, after, ['phone_mobile', 'address']);
    r.check('P5 其他欄位（含 4 份證件）都沒被改掉', d.lost.length === 0,
      d.lost.length ? describeChanges(d.changed, d.lost) : `變動欄位：${Object.keys(d.changed).join(', ')}`);
    if (d.normalized.length) r.note(`P5 原本空值被存成空字串（無資料遺失）：${describeChanges(d.changed, d.normalized)}`);
    r.check('P5 存檔後沒有殘留草稿', ctx.draftCount(user.id) === 0);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `P5: ${e}`));
    await s.context.close();
  }
}

// ═══ P7 mentor（有自己的主檔）只改暱稱 ═══════════════════════════════════
// results：正式執行用 r；P10 反向對照時傳入另一個收集器，舊版的 FAIL 不算進總結，只拿來證明「舊版會 FAIL」。
async function scenarioP7(ctx, { label = 'P7', results = r } = {}) {
  const { seeded, user, email } = await seedOwnedInstructor(ctx, { tag: 'p7-mentor', fullName: '輔導員周' });
  ensureMentorRoleAllowed(ctx, label, results);
  await adminSetRole(ctx, user.id, 'mentor');
  const s = await openSession(ctx, user);
  const summary = { user };
  try {
    await goto(ctx, s, '/profile');
    await waitProfileLoaded(s.page);
    const before = ctx.rowById(seeded.id);
    results.check(`${label} 起始：mentor 帳號、已有自己的主檔（主要 Email＝Google）`,
      before?.user_id === user.id && ctx.roleOf(user.id) === 'mentor' && before?.email_primary === email,
      `role=${ctx.roleOf(user.id)} email_primary=${before?.email_primary}`);
    const newNickname = `周暱稱${seq}`;
    await fieldControl(s.page, '講師暱稱').fill(newNickname);
    const outcome = await saveAndWait(s);
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-${label}-after-save`);
    const after = ctx.rowById(seeded.id);
    const roleAfter = ctx.roleOf(user.id);
    Object.assign(summary, { outcome, before, after, roleAfter });
    results.check(`${label} mentor 存檔成功`, outcome.ok, outcome.message);
    results.check(`${label} 寫入只有一次 PATCH（UPDATE 1 列）`,
      outcome.writes.length === 1 && outcome.writes[0].method === 'PATCH' && outcome.writes[0].status === 200
      && outcome.writes[0].response?.length === 1, writeSummary(outcome.writes));
    const keys = sentKeys(outcome.writes[0]);
    results.check(`${label} PATCH 沒送 user_id，也沒送沒改的主要 Email`, keys.length > 0 && !keys.includes('user_id') && !keys.includes('email_primary'),
      `user_id=${keys.includes('user_id')} email_primary=${keys.includes('email_primary')}`);
    results.check(`${label} 資料庫：暱稱已更新、主要 Email 不變、角色仍是 mentor`,
      after?.nickname === newNickname && after?.email_primary === email && roleAfter === 'mentor',
      `nickname=${after?.nickname} email_primary=${after?.email_primary} role=${roleAfter}`);
    const d = diffRows(before, after, ['nickname']);
    results.check(`${label} 其他欄位（含 4 份證件、管理員欄位）都沒被改掉`, d.lost.length === 0,
      d.lost.length ? describeChanges(d.changed, d.lost) : `變動欄位：${Object.keys(d.changed).join(', ')}`);
    if (d.normalized.length) results.note(`${label} 原本空值被存成空字串（無資料遺失）：${describeChanges(d.changed, d.normalized)}`);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `${label}: ${e}`));
    await s.context.close();
  }
  return summary;
}

// ═══ P8 任職狀態 frozen、角色已被管理員手動改回 teacher 的講師只改暱稱 ═══════════
// 頁面要在凍結前就開著：凍結講師重新載入頁面時，登入檢查 claim_my_precreated_instructor 會依規則把 teacher
// 降回 pending 並登出（20260826140000…sql:134-147），到不了存檔；存檔造成的降級只在「頁面已開著」時才會發生。
async function scenarioP8(ctx, { label = 'P8', results = r } = {}) {
  const { seeded, user, email } = await seedOwnedInstructor(ctx, { tag: 'p8-frozen', fullName: '凍結講師吳' });
  const s = await openSession(ctx, user);
  const summary = { user };
  try {
    await goto(ctx, s, '/profile');
    await waitProfileLoaded(s.page);
    // 頁面開著時：管理員把任職狀態改成凍結 → trg_sync_instructor_portal_access 依正式規則把 teacher 降成 pending；
    // 管理員再到帳號管理手動把角色改回 teacher。
    await adminPatchInstructor(ctx, seeded.id, { employment_status: 'frozen' });
    const roleAfterFreeze = ctx.roleOf(user.id);
    await adminSetRole(ctx, user.id, 'teacher');
    const before = ctx.rowById(seeded.id);
    results.check(`${label} 起始：凍結時 trigger 已把角色降為 pending，管理員手動改回 teacher；主檔 employment_status=frozen`,
      roleAfterFreeze === 'pending' && ctx.roleOf(user.id) === 'teacher' && before?.user_id === user.id
      && before?.employment_status === 'frozen' && before?.email_primary === email,
      `凍結後 role=${roleAfterFreeze}；現在 role=${ctx.roleOf(user.id)} employment_status=${before?.employment_status}`);
    const newNickname = `吳暱稱${seq}`;
    await fieldControl(s.page, '講師暱稱').fill(newNickname);
    const outcome = await saveAndWait(s);
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-${label}-after-save`);
    const after = ctx.rowById(seeded.id);
    const roleAfter = ctx.roleOf(user.id);
    Object.assign(summary, { outcome, before, after, roleAfter });
    results.check(`${label} 存檔成功`, outcome.ok, outcome.message);
    results.check(`${label} 寫入只有一次 PATCH（UPDATE 1 列）`,
      outcome.writes.length === 1 && outcome.writes[0].method === 'PATCH' && outcome.writes[0].status === 200
      && outcome.writes[0].response?.length === 1, writeSummary(outcome.writes));
    const keys = sentKeys(outcome.writes[0]);
    results.check(`${label} PATCH 沒送 user_id、主要 Email、employment_status`,
      keys.length > 0 && !['user_id', 'email_primary', 'employment_status'].some((key) => keys.includes(key)),
      `user_id=${keys.includes('user_id')} email_primary=${keys.includes('email_primary')} employment_status=${keys.includes('employment_status')}`);
    results.check(`${label} 存檔後角色仍是 teacher（沒被自動降回 pending）`, roleAfter === 'teacher', `role=${roleAfter}`);
    results.check(`${label} 資料庫：暱稱已更新、任職狀態仍是 frozen、主要 Email 不變`,
      after?.nickname === newNickname && after?.employment_status === 'frozen' && after?.email_primary === email,
      `nickname=${after?.nickname} employment_status=${after?.employment_status} email_primary=${after?.email_primary}`);
    const d = diffRows(before, after, ['nickname']);
    results.check(`${label} 其他欄位（含 4 份證件、管理員欄位）都沒被改掉`, d.lost.length === 0,
      d.lost.length ? describeChanges(d.changed, d.lost) : `變動欄位：${Object.keys(d.changed).join(', ')}`);
    if (d.normalized.length) results.note(`${label} 原本空值被存成空字串（無資料遺失）：${describeChanges(d.changed, d.normalized)}`);
    // 參考（不計分）：重新載入頁面時登入檢查的既有行為
    await goto(ctx, s, '/profile');
    const roleAfterReload = await pollUntil(() => (ctx.roleOf(user.id) === 'pending' ? 'pending' : null), { timeoutMs: 8000 }) || ctx.roleOf(user.id);
    results.note(`${label} 參考：存檔後重新載入頁面，登入檢查（claim_my_precreated_instructor）把凍結講師的角色改成 ${roleAfterReload}，網址=${s.page.url()}`);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `${label}: ${e}`));
    await s.context.close();
  }
  return summary;
}

// ═══ P9 已認領舊講師把主要 Email 改成非 Google 信箱 → 被擋、中文說明、資料庫不變 ═════
async function scenarioP9(ctx, { label = 'P9', results = r } = {}) {
  seq += 1;
  const fullName = `舊講師鄭${seq}`;
  const legacyEmail = `legacy-cheng-${seq}-${Date.now().toString(36)}@old-mail.example`;
  const phoneDigits = `0922${digits(6)}`;
  const idNumber = `G22345${digits(4)}`;
  const legacy = await adminCreateInstructor(ctx.api, ctx.admin, legacyRow({
    fullName, email: legacyEmail, idNumber, phone: phoneDigits,
  }));
  const user = await newUser(ctx, 'p9-google', 'Cheng Google');
  const files = {};
  for (const key of DOC_KEYS) files[key] = await uploadAs(ctx, user.token, `instructors/${user.id}/${key}/${randomUUID()}.png`, { label: `p9-${key}-${seq}` });
  await adminPatchInstructor(ctx, legacy.id, docColumns(files));
  const s = await openSession(ctx, user);
  const summary = { user };
  try {
    const claimed = await claimByIdentityUI(ctx, s, { fullName, phoneDigits, last4: idNumber.slice(-4) });
    const roleAfterClaim = ctx.roleOf(user.id);
    const role = await activateClaimedViaRest(ctx, user, legacy.id, legacyEmail);
    await goto(ctx, s, '/profile');
    const before = ctx.rowById(legacy.id);
    results.check(`${label} 起始：姓名＋手機＋末四碼認領成功（認領後 pending 待啟用，驗證碼啟用後 teacher）、主要 Email＝舊信箱（≠ Google）`,
      claimed && before?.user_id === user.id && roleAfterClaim === 'pending' && role === 'teacher' && before?.email_primary === legacyEmail,
      `url=${s.page.url()} 認領後 role=${roleAfterClaim} 啟用後 role=${role} email_primary=${before?.email_primary}`);
    await waitProfileLoaded(s.page);
    const otherEmail = `p9-other-${seq}-${Date.now().toString(36)}@other-mail.example`;
    await fieldControl(s.page, '主要 Email').fill(otherEmail);
    const outcome = await saveAndWait(s);
    await shot(s.page, shotsDir, `${ctx.shotPrefix}-${label}-after-save`);
    const after = ctx.rowById(legacy.id);
    const roleAfter = ctx.roleOf(user.id);
    Object.assign(summary, { outcome, before, after, roleAfter });
    results.check(`${label} 存檔被擋，畫面顯示中文說明（含登入的 Google 信箱），不再是英文錯誤`,
      !outcome.ok && /儲存失敗/.test(outcome.message) && outcome.message.includes(GOOGLE_EMAIL_HINT)
      && outcome.message.includes(user.email) && outcome.message.includes('請聯繫管理員') && !/must match|instructor email/i.test(outcome.message),
      outcome.message);
    const write = outcome.writes[0];
    results.check(`${label} 寫入是一次 PATCH（送出新的主要 Email、沒送 user_id），被資料庫 Email 守門以 403／42501 擋下`,
      outcome.writes.length === 1 && write?.method === 'PATCH' && write?.status === 403 && write?.response?.code === '42501'
      && write?.body?.email_primary === otherEmail && !sentKeys(write).includes('user_id'),
      `${writeSummary(outcome.writes)}；message=${write?.response?.message || ''}`);
    const d = diffRows(before, after);
    results.check(`${label} 被擋後資料庫主檔完全沒變（主要 Email 仍是舊信箱）、角色仍是 teacher`,
      Object.keys(d.changed).length === 0 && after?.email_primary === legacyEmail && roleAfter === 'teacher',
      `${describeChanges(d.changed, Object.keys(d.changed))}；email_primary=${after?.email_primary} role=${roleAfter}`);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `${label}: ${e}`));
    await s.context.close();
  }
  return summary;
}

// P10 用：收集舊版跑同一套斷言的結果（不算進總結），印成縮排行避免和正式 PASS／FAIL 混淆
function shadowResults(tag) {
  const items = [];
  return {
    items,
    check(name, condition, detail = '') {
      const ok = Boolean(condition);
      items.push({ name, ok, detail });
      console.log(`   ↳ [${tag}] ${ok ? '通過' : '未過'}：${name}${detail ? ` — ${detail}` : ''}`);
      return ok;
    },
    note(text) { console.log(`   ↳ [${tag}] NOTE ${text}`); },
    failed() { return items.filter((item) => !item.ok).map((item) => item.name); },
  };
}

// ── 底座：一位管理員（teacher_invites → Google 註冊 → handle_new_user 給 admin） ──
async function seedAdmin(stack, api) {
  const email = `admin-${Date.now().toString(36)}@e2e.test`;
  api.sql(`INSERT INTO public.teacher_invites (name, email, role) VALUES ('E2E 管理員', :'email', 'admin')`, { email });
  const admin = await createGoogleUser(stack, { email, fullName: 'E2E 管理員' });
  if (api.sql(`SELECT role FROM public.users WHERE id = :'id'`, { id: admin.id }) !== 'admin') throw new Error('admin bootstrap failed');
  return admin;
}

async function runPhase(phase, scenarios, { afterStart, shotPrefix = 'A' } = {}) {
  console.log(`\n════════ ${phase}（全新資料庫） ════════`);
  try {
    activeStack = await startStack({ appDir, viteMode: 'preview' });
  } finally {
    afterStart?.(); // vite build 已在 startStack 內完成（preview 伺服的是 build 快照）
  }
  try {
    const { chainReport } = activeStack;
    const api = makeApi(activeStack);
    const triggers = api.sql(`SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = 'public.instructors'::regclass AND NOT tgisinternal`);
    r.check(`${phase} 套用 repo 全部 SQL（${chainReport.applied.length - 1} 個檔），instructors 上的 guard trigger 都在`,
      ['trg_guard_instructor_admin_fields', 'trg_guard_instructor_bank_account', 'trg_guard_instructor_bankbook',
        'trg_guard_instructor_file_paths', 'trg_guard_instructor_identity_email'].every((t) => triggers.split(',').includes(t)),
      triggers);
    const admin = await seedAdmin(activeStack, api);
    activeBrowser = await launchBrowser(appDir);
    const ctx = makeCtx(activeStack, api, admin, activeBrowser, phase, shotPrefix);
    for (const [name, fn] of scenarios) {
      console.log(`\n── ${name} ──`);
      const started = Date.now();
      try {
        await fn(ctx);
      } catch (error) {
        r.check(`${name} 情境中途例外`, false, error.stack?.split('\n').slice(0, 3).join(' | ') || error.message);
      }
      console.log(`   （${name} 用時 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
    }
    const errors5xx = activeStack.gateway.requests.filter((req) => req.status >= 500);
    r.check(`${phase} 閘道沒有任何 5xx 回應`, errors5xx.length === 0, errors5xx.slice(0, 5).map((x) => `${x.method} ${x.path} ${x.status}`).join('; '));
    const noisy = [...new Set(ctx.consoleErrors.filter((line) => !/Failed to load resource|favicon/i.test(line)))];
    if (noisy.length) {
      console.log(`\n瀏覽器 console 錯誤（${noisy.length} 則，前 8 則）：`);
      for (const line of noisy.slice(0, 8)) console.log(`  - ${line.slice(0, 220)}`);
    }
  } finally {
    try { await activeBrowser?.close(); } catch { /* ignore */ }
    activeBrowser = null;
    await activeStack.stop();
    activeStack = null;
  }
}

let fatal = false;
const git = (gitArgs, opts = {}) => spawnSync('git', gitArgs, { cwd: appDir, ...opts });
const headShort = git(['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
try {
  await runPhase(`A 目前程式（${headShort}）`, [
    ['P1', scenarioP1], ['P2', scenarioP2], ['P3', scenarioP3], ['P4', scenarioP4], ['P5', scenarioP5],
    ['P7', scenarioP7], ['P8', scenarioP8], ['P9', scenarioP9],
  ]);
} catch (error) {
  fatal = true;
  console.error(`A 階段無法完成：${error.stack || error.message}`);
}

// 反向對照：ProfilePage.jsx 暫換成 commit 版 → vite build（startStack 內完成）→ 立刻寫回原檔 → 確認 src 乾淨
async function runWithOldProfilePage({ tag, commit, versionLabel, marker, phase, scenarios, shotPrefix }) {
  profileFile = path.join(appDir, 'src/pages/ProfilePage.jsx');
  const cleanBefore = git(['diff', '--quiet', '--', 'src']).status === 0;
  const oldSource = git(['show', `${commit}:培訓web/src/pages/ProfilePage.jsx`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout;
  if (!cleanBefore || !oldSource || !marker(oldSource)) {
    r.check(`${tag} 前置：src 乾淨且取得 ${commit} ${versionLabel} ProfilePage.jsx`, false, `cleanBefore=${cleanBefore} gotSource=${Boolean(oldSource)}`);
    return;
  }
  profileOriginal = readFileSync(profileFile);
  try {
    writeFileSync(profileFile, oldSource);
    console.log(`\n[${tag}] 已暫時把 src/pages/ProfilePage.jsx 換成 ${commit} 版（${versionLabel}），build 完立刻還原`);
    await runPhase(phase, scenarios, {
      shotPrefix,
      afterStart: () => {
        restoreProfilePage();
        console.log(`[${tag}] build 完成，src/pages/ProfilePage.jsx 已寫回原檔`);
      },
    });
  } catch (error) {
    fatal = true;
    console.error(`${tag} 階段無法完成：${error.stack || error.message}`);
  } finally {
    restoreProfilePage();
  }
  const cleanAfter = git(['diff', '--quiet', '--', 'src']).status === 0;
  r.check(`${tag} 還原後 git diff --quiet -- 培訓web/src 乾淨（ProfilePage.jsx 回到 ${headShort}）`, cleanAfter);
}

if (!args.has('--skip-p6')) {
  await runWithOldProfilePage({
    tag: 'P6', commit: UPSERT_COMMIT, versionLabel: 'upsert 版', shotPrefix: 'P6',
    marker: (src) => src.includes(".upsert(payload, { onConflict: 'user_id' })"),
    phase: `P6 反向對照（${UPSERT_COMMIT} upsert 版）`,
    scenarios: [
      ['P6-P2', (ctx) => scenarioP2(ctx, { label: 'P6-P2', expectBlocked: true })],
      ['P6-P3', (ctx) => scenarioP3(ctx, { label: 'P6-P3', expectBlocked: true })],
    ],
  });
}

if (!args.has('--skip-p10')) {
  const c = ALWAYS_SEND_IDENTITY_COMMIT;
  const failedList = (shadow) => shadow.failed().join('；') || '（全部通過）';
  await runWithOldProfilePage({
    tag: 'P10', commit: c, versionLabel: 'UPDATE 每次帶 user_id／email_primary', shotPrefix: 'P10',
    marker: (src) => src.includes('.update(payload)') && /payload = omitUnchangedDocumentFields\(\{\s*user_id: user\.id,/.test(src),
    phase: `P10 反向對照（${c} 版）`,
    scenarios: [
      ['P10-P7', async (ctx) => {
        const shadow = shadowResults(`${c} 跑 P7 斷言`);
        const { outcome } = await scenarioP7(ctx, { label: 'P10-P7', results: shadow });
        const write = outcome?.writes?.[0];
        r.check(`P10-P7 舊版（${c}）跑同一套 P7 斷言會 FAIL`, shadow.failed().length > 0, `未過：${failedList(shadow)}`);
        r.check('P10-P7 舊版重現問題：PATCH 夾帶 user_id、email_primary，mentor 被 Email 守門以 403／42501 擋下',
          !outcome?.ok && write?.status === 403 && write?.response?.code === '42501'
          && /not owned by the signed-in account/.test(write?.response?.message || '')
          && sentKeys(write).includes('user_id') && sentKeys(write).includes('email_primary'),
          `${outcome?.message}；${writeSummary(outcome?.writes || [])}`);
      }],
      ['P10-P8', async (ctx) => {
        const shadow = shadowResults(`${c} 跑 P8 斷言`);
        const { outcome, roleAfter } = await scenarioP8(ctx, { label: 'P10-P8', results: shadow });
        r.check(`P10-P8 舊版（${c}）跑同一套 P8 斷言會 FAIL`, shadow.failed().length > 0, `未過：${failedList(shadow)}`);
        r.check('P10-P8 舊版重現問題：PATCH 夾帶 user_id，存檔後角色被自動降回 pending',
          sentKeys(outcome?.writes?.[0]).includes('user_id') && roleAfter === 'pending',
          `${outcome?.message}；role=${roleAfter}；${writeSummary(outcome?.writes || [])}`);
      }],
      ['P10-P9', async (ctx) => {
        const shadow = shadowResults(`${c} 跑 P9 斷言`);
        const { outcome } = await scenarioP9(ctx, { label: 'P10-P9', results: shadow });
        r.check(`P10-P9 舊版（${c}）跑同一套 P9 斷言會 FAIL（畫面是英文錯誤）`, shadow.failed().length > 0
          && /changed instructor email must match/.test(outcome?.message || ''), `未過：${failedList(shadow)}；畫面：${outcome?.message}`);
      }],
    ],
  });
}

const counts = r.counts();
console.log('\n════════ 總結 ════════');
console.log(`${counts.PASS}/${r.items.length} PASS（FAIL ${counts.FAIL}／BLOCKED ${counts.BLOCKED}）`);
console.log(`截圖：${shotsDir}`);
process.exit(fatal || counts.FAIL > 0 || counts.BLOCKED > 0 ? 1 : 0);
