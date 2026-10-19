// 第一階段情境：老師端全流程（新建／認領／同名／舊資料／Email 自動對應）＋資料庫層安全＋解除認領＋手機版。
// 每個情境用全新的假帳號；斷言結果交給 ctx.r（Results）。
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { createGoogleUser, adminCreateInstructor, samplePng } from './lib/fixtures.mjs';
import { openAs, shot, measureOverflow, fieldControl } from './lib/browser.mjs';
import { sleep } from './lib/util.mjs';

const REGIONS = ['臺北市', '新北市'];
let seq = 0;

// ── 共用小工具 ──────────────────────────────────────────────────────
const randomDigits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

async function newUser(ctx, prefix, fullName) {
  seq += 1;
  const email = `${prefix}-${ctx.base.runTag}-${seq}@e2e.test`.toLowerCase();
  const user = await createGoogleUser(ctx.stack, { email, fullName });
  if (!user.id) throw new Error(`Google 帳號建立被 hook 拒絕：${JSON.stringify(user.hookRejected)}`);
  return user;
}

function profileData(user, fullName, overrides = {}) {
  return {
    full_name: fullName,
    nickname: `${fullName.slice(-2)}老師`,
    gender: '女',
    birth_date: '1995-05-05',
    id_number: `A2${randomDigits(8)}`,
    phone_mobile: `09${randomDigits(8)}`,
    line_id: `line_${randomDigits(5)}`,
    address: '臺北市信義區測試路 1 號',
    household_address: '新北市板橋區戶籍路 2 號',
    email_primary: user.email,
    teaching_freq_semester: '每週 2 次',
    teaching_freq_vacation: '每週 4 次',
    bio_notes: '端到端測試填寫的教學經歷與理念。',
    bank_account_name: fullName,
    bank_name: '華南銀行',
    bank_branch: '仁愛分行',
    bank_code: '0081234',
    bank_account_number: `1234${randomDigits(8)}`,
    ...overrides,
  };
}

const FIELD_LABELS = [
  ['full_name', '姓名'], ['nickname', '講師暱稱'], ['gender', '性別'], ['birth_date', '出生年月日'],
  ['id_number', '身分證字號'], ['phone_mobile', '手機號碼'], ['line_id', 'Line ID'],
  ['email_primary', '主要 Email'], ['address', '通訊地址'], ['household_address', '戶籍地址'],
  ['teaching_freq_semester', '接課頻率（學期間）'], ['teaching_freq_vacation', '接課頻率（寒暑假）'],
  ['bank_account_name', '匯款戶名'], ['bank_name', '銀行別'], ['bank_branch', '分行別'],
  ['bank_code', '銀行代碼（6–7 碼）'], ['bank_account_number', '銀行帳號（含檢查碼）'],
  ['bio_notes', '教學經歷 / 教學理念 / 想說的話'],
];

async function waitProfileLoaded(page) {
  await fieldControl(page, '姓名').waitFor({ state: 'visible', timeout: 20000 });
}

// 依 src/lib/profileCompletion.js：18 欄＋接課地區＋身分證正反面與存摺封面三份檔案
async function fillProfile(page, data, { skip = [] } = {}) {
  await waitProfileLoaded(page);
  for (const [key, label] of FIELD_LABELS) {
    if (skip.includes(key) || data[key] === undefined) continue;
    const control = fieldControl(page, label);
    if (await control.isDisabled()) continue; // 已鎖定（例如銀行資料存過）
    const tag = await control.evaluate((el) => el.tagName);
    if (tag === 'SELECT') await control.selectOption(data[key]);
    else await control.fill(data[key]);
  }
  for (const county of REGIONS) {
    const chip = page.locator('label.bh-chip', { hasText: county }).first();
    if (!(await chip.locator('input[type=checkbox]').isChecked())) await chip.click();
  }
  for (const key of ['id_front', 'id_back', 'bankbook']) {
    const input = page.locator(`[data-testid="${key}-file-input"]`);
    if (await input.count() === 0) continue;
    await input.setInputFiles({ name: `${key}.png`, mimeType: 'image/png', buffer: samplePng(`${key}-${data.full_name}`) });
  }
}

async function clickSave(page) {
  await page.getByRole('button', { name: /送出資料|儲存個人資料/ }).click();
}

const instructorOf = (ctx, userId) => ctx.api.json(
  `SELECT row_to_json(i) FROM public.instructors i WHERE i.user_id = :'uid'`, { uid: userId },
);
const roleOf = (ctx, userId) => ctx.api.sql(`SELECT role FROM public.users WHERE id = :'uid'`, { uid: userId });

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

const goto = (ctx, session, path) => session.page.goto(`${ctx.stack.baseUrl}${path}`, { waitUntil: 'domcontentloaded' });

// /courses 先列大分類；點進種好的分類，確認看得到那門課（UI 與 RLS 都要放行）
async function seeSeededCourse(ctx, s, { navigate = true } = {}) {
  if (navigate) await goto(ctx, s, '/courses');
  const category = s.page.getByRole('link', { name: /E2E 培訓分類/ });
  if (!(await visible(category, 12000))) {
    return { ok: false, detail: `url=${s.page.url()} 畫面=${(await s.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200)}` };
  }
  await category.first().click();
  const ok = await visible(s.page.getByText(ctx.base.courseTitle), 10000);
  return { ok: ok && /\/courses/.test(s.page.url()), detail: ok ? '' : `url=${s.page.url()}` };
}

async function chooseCard(page, name) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

async function nameClaimUI(page, fullName) {
  await page.locator('#claim-full-name').fill(fullName);
  await page.getByRole('button', { name: '用姓名認領' }).click();
}

// ── 合約簽署（真的看 PDF、勾同意、Email OTP、滑鼠畫簽名、送出） ─────────
async function signContractUI(ctx, session, user, tag, { wrongOtpFirst = false } = {}) {
  const { page } = session;
  const r = ctx.r;
  await goto(ctx, session, '/contract');
  const finish = page.getByRole('button', { name: '我已完整看完且清楚這份文件的所有內容' });
  const pdfReady = await visible(finish, 25000);
  r.check(`${tag} 合約第 1 步：講師守則 PDF 載入並可按「已看完」`, pdfReady && await pollUntil(() => finish.isEnabled(), { timeoutMs: 15000 }));
  await finish.click();
  await page.getByText('填寫契約資料').waitFor({ timeout: 20000 });

  const roleMissing = await page.getByText('尚無法簽署：您的講師等級尚未設定').isVisible();
  if (roleMissing) return { roleMissing: true };

  const nameValue = await page.locator('input[placeholder="請輸入姓名"]').inputValue();
  const roleValue = await page.locator('input[placeholder="由系統自動帶入"]').inputValue();
  r.check(`${tag} 合約表單自動帶入姓名與講師等級`, nameValue.length > 0 && roleValue.length > 0, `姓名=${nameValue} 等級=${roleValue}`);

  await page.getByText('清楚看過所有合約文件內容，皆可遵守並配合。').click();
  await page.getByText('清楚且接受線上電子簽名與實體簽約具備一樣的法律效力。').click();

  await page.getByRole('button', { name: /寄送驗證碼到我的信箱/ }).click();
  const code = await pollUntil(async () => {
    const res = await fetch(`${ctx.stack.supabaseUrl}/__e2e/mailbox?email=${encodeURIComponent(user.email)}`);
    const body = await res.json();
    return body.messages.at(-1)?.code;
  });
  r.check(`${tag} Email OTP 已寄出（假信箱收到 6 碼）`, /^\d{6}$/.test(code || ''));
  const firstCell = page.getByLabel('驗證碼第 1 碼');
  if (wrongOtpFirst) {
    const wrong = code === '111111' ? '222222' : '111111';
    await firstCell.fill(wrong);
    r.check(`${tag} 錯誤驗證碼被拒絕`, await visible(page.getByText('驗證碼錯誤或已過期'), 8000));
  }
  await firstCell.fill(code);
  r.check(`${tag} 正確驗證碼通過「本人身分已驗證」`, await visible(page.getByText('本人身分已驗證'), 10000));

  await page.getByRole('button', { name: /點擊此處進行簽名/ }).click();
  const canvas = page.locator('canvas.cursor-crosshair');
  await canvas.waitFor({ state: 'visible' });
  await sleep(150); // SignaturePad 在 50ms 後才 resize canvas
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 24; i += 1) {
    await page.mouse.move(box.x + box.width * (0.2 + 0.025 * i), box.y + box.height * (0.6 - 0.25 * Math.sin(i / 3)), { steps: 2 });
  }
  await page.mouse.up();
  await page.getByRole('button', { name: '確認簽名' }).click();
  r.check(`${tag} 簽名板畫完後顯示「已簽名」`, await visible(page.getByText('已簽名', { exact: true }), 5000));

  await page.getByRole('button', { name: /確認送出簽約/ }).click();
  const done = await visible(page.getByText('簽約完成！'), 25000);
  r.check(`${tag} 畫面顯示「簽約完成！」`, done, done ? '' : session.dialogs.at(-1)?.message || '');
  return { roleMissing: false, done };
}

async function verifySignedContractInDb(ctx, userId, tag) {
  const r = ctx.r;
  const contract = ctx.api.json(`
    SELECT row_to_json(c) FROM (
      SELECT status, signature_path, signed_pdf_paths, doc_versions, verify_method, verified_at,
             filled_name, filled_instructor_role, filled_id_number, ip_address
        FROM public.instructor_contracts WHERE user_id = :'uid' ORDER BY created_at DESC LIMIT 1) c`, { uid: userId });
  r.check(`${tag} 資料庫有 status='signed' 的合約`, contract?.status === 'signed', JSON.stringify(contract || {}).slice(0, 160));
  if (!contract) return;
  r.check(`${tag} 合約記錄 Email OTP 驗證（verify_method=email_otp、verified_at 有值）`,
    contract.verify_method === 'email_otp' && Boolean(contract.verified_at));
  const pdfPath = contract.signed_pdf_paths?.contract;
  const objects = ctx.api.json(`
    SELECT coalesce(json_agg(name), '[]') FROM storage.objects
     WHERE bucket_id = 'contract-documents' AND name IN (:'sig', :'pdf')`, { sig: contract.signature_path, pdf: pdfPath || '' });
  r.check(`${tag} 簽名 PNG 與簽署 PDF 都真的在 storage.objects`, objects.length === 2, JSON.stringify(objects));
  try {
    const bytes = readFileSync(ctx.stack.gateway.filePath('contract-documents', pdfPath));
    const pdf = await PDFDocument.load(bytes);
    const xobjects = pdf.getPages()[0].node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    const images = xobjects ? xobjects.keys().length : 0;
    r.check(`${tag} 上傳的 PDF 可解析且第 1 頁嵌入簽名與欄位影像`, pdf.getPageCount() === 1 && images >= 6, `${bytes.length} bytes，${images} 個影像`);
  } catch (error) {
    r.check(`${tag} 上傳的 PDF 可解析且第 1 頁嵌入簽名與欄位影像`, false, error.message);
  }
}

async function adminApproveUI(ctx, fullName, tag) {
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    await goto(ctx, admin, '/admin/teachers');
    const card = admin.page.locator('.bh-card', { hasText: fullName }).filter({ has: admin.page.getByRole('button', { name: /核准新講師/ }) });
    await card.first().waitFor({ state: 'visible', timeout: 15000 });
    const button = card.first().getByRole('button', { name: /核准新講師/ });
    await pollUntil(() => button.isEnabled(), { timeoutMs: 8000 });
    await shot(admin.page, ctx.shotsDir, `${tag}-admin-approve`);
    await button.click();
    return { ok: true, dialogs: admin.dialogs };
  } catch (error) {
    return { ok: false, error: error.message.split('\n')[0] };
  } finally {
    await sleep(300);
    await admin.context.close();
  }
}

// ═══ A 新建帳號 ══════════════════════════════════════════════════════
export async function scenarioA(ctx) {
  const r = ctx.r;
  const fullName = '測試新老師林';
  const user = await newUser(ctx, 'a-new', fullName);
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    r.check('A Google 新帳號建立後是 pending', roleOf(ctx, user.id) === 'pending');
    await goto(ctx, s, '/pending');
    r.check('A /pending 顯示「認領帳號」「新建帳號」兩張卡',
      await visible(s.page.getByRole('button', { name: /^認領帳號/ })) && await s.page.getByRole('button', { name: /^新建帳號/ }).isVisible());
    await shot(s.page, ctx.shotsDir, 'A-01-pending-choice');

    await chooseCard(s.page, '新建帳號');
    await s.page.waitForURL(/\/profile$/);
    await waitProfileLoaded(s.page);
    r.check('A 選「新建帳號」進 /profile，看到首次註冊提示', await visible(s.page.getByText('填寫完下方資料後才算完成註冊')));
    r.check('A /profile 顯示擋門橫幅「還缺 N 項講師資料」', await visible(s.page.getByText(/還缺 \d+ 項講師資料/)));
    r.check('A /profile 預填 Google 姓名與登入 Email',
      await fieldControl(s.page, '姓名').inputValue() === fullName && await fieldControl(s.page, '主要 Email').inputValue() === user.email);

    // 先擋：空表單送出要列出缺項，不寫資料庫
    await clickSave(s.page);
    await sleep(400);
    r.check('A 空表單送出被前端擋下並列出缺項', s.dialogs.some((d) => d.message.includes('請先補齊以下資料')) && !instructorOf(ctx, user.id));

    const data = profileData(user, fullName);
    await fillProfile(s.page, data);
    await shot(s.page, ctx.shotsDir, 'A-02-profile-filled');
    await clickSave(s.page);
    r.check('A 送出後顯示「恭喜你完成註冊！」', await visible(s.page.getByText('恭喜你完成註冊！'), 20000));
    const inst = instructorOf(ctx, user.id);
    r.check('A 資料庫建立講師主檔、資料完整（18 欄＋地區＋3 份檔案）',
      inst && REGIONS.every((c) => inst.teaching_regions?.includes(c)) && inst.id_front_path && inst.id_back_path && inst.bankbook_path
      && inst.phone_mobile === data.phone_mobile && inst.bank_account_number === data.bank_account_number,
      inst ? '' : '找不到講師列');
    r.check('A 新講師等級由資料庫強制為「實習」', inst?.instructor_role === '實習', inst?.instructor_role);
    const files = ctx.api.json(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'instructor_uploads' AND name LIKE :'prefix'`, { prefix: `instructors/${user.id}/%` });
    r.check('A 三份證件檔真的上傳到 instructor_uploads（storage RLS 放行本人資料夾）', Number(files) === 3, `objects=${files}`);

    await s.page.getByRole('button', { name: '我知道了' }).click();
    await s.page.waitForURL(/\/pending$/);
    r.check('A 回到 /pending 看到「帳號審核中」', await visible(s.page.getByText('帳號審核中')));
    await shot(s.page, ctx.shotsDir, 'A-03-pending-review');
    r.check('A 審核前 pending 被擋在課程外（/courses 導回 /pending）', await (async () => {
      await goto(ctx, s, '/courses');
      await sleep(800);
      return /\/pending$/.test(s.page.url());
    })());

    // 管理員在 /admin/teachers 用畫面核准
    const approval = await adminApproveUI(ctx, fullName, 'A-04');
    r.check('A 管理員在 /admin/teachers 按「核准新講師」', approval.ok, approval.error || '');
    if (!approval.ok) {
      const fallback = await ctx.api.rpc(ctx.base.admin.token, 'approve_new_instructor_account', { target_user_id: user.id });
      r.note(`A 核准畫面失敗，改用 RPC 核准繼續後續步驟（HTTP ${fallback.status}）`);
    }
    r.check('A 核准後資料庫角色變 teacher', await pollUntil(() => roleOf(ctx, user.id) === 'teacher'));

    // 老師還停在 /pending（審核中畫面）→ 按「重新檢查狀態」
    await s.page.getByRole('button', { name: /重新檢查狀態/ }).click();
    await s.page.waitForURL(/\/courses$/, { timeout: 15000 }).catch(() => {});
    const landedOnCourses = /\/courses$/.test(s.page.url());
    const seenA = await seeSeededCourse(ctx, s, { navigate: false });
    r.check('A 老師按「重新檢查狀態」後被帶到 /courses 並看到課程', landedOnCourses && seenA.ok, seenA.detail);
    // 瀏覽器整頁重新整理 /pending：記錄落點（PendingApproval 在登入狀態還沒載入時就先導回首頁）
    await goto(ctx, s, '/pending');
    await sleep(2500);
    const landed = new URL(s.page.url()).pathname;
    if (landed !== '/courses') {
      ctx.known('A 已核准老師整頁重新整理 /pending 落在首頁', `A［UX 小 bug］已核准的老師在 /pending 按瀏覽器重新整理，會落在首頁「${landed}」而不是 /courses——src/pages/PendingApproval.jsx:37 在 AuthContext 還在載入（user 尚未就緒）時就 <Navigate to="/" />，第 38 行的「已核准→/courses」沒機會執行。老師仍可從選單進課程。重現：老師在「帳號審核中」頁被核准後按 F5。`);
    }
    const seenA2 = await seeSeededCourse(ctx, s);
    r.check('A 老師整頁重新整理後直接開 /courses 也看得到課程', seenA2.ok, seenA2.detail);
    await shot(s.page, ctx.shotsDir, 'A-05-courses');

    const sign = await signContractUI(ctx, s, user, 'A', { wrongOtpFirst: true });
    await shot(s.page, ctx.shotsDir, 'A-06-contract-done');
    if (sign.roleMissing) r.check('A 合約頁不應顯示「講師等級尚未設定」', false);
    await verifySignedContractInDb(ctx, user.id, 'A');
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `A: ${e}`));
    await s.context.close();
  }
}

// ═══ B 姓名認領 ══════════════════════════════════════════════════════
export async function scenarioB(ctx) {
  const r = ctx.r;
  const slotName = '測試王小明';
  const slot = await adminCreateInstructor(ctx.api, ctx.base.admin, { full_name: slotName, name_slot: true });
  r.check('B 管理員用 REST 建立 name_slot 空位', slot.name_slot === true && slot.user_id === null);
  const user = await newUser(ctx, 'b-slot', '小明 Wang');
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/pending');
    await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s.page, '認領帳號');
    r.check('B 認領第 1 步只有姓名欄、沒有手機與末四碼',
      await visible(s.page.locator('#claim-full-name')) && await s.page.locator('#claim-phone').count() === 0 && await s.page.locator('#claim-id-last-four').count() === 0);
    await s.page.locator('#claim-full-name').fill(slotName);
    await shot(s.page, ctx.shotsDir, 'B-01-name-claim');
    await s.page.getByRole('button', { name: '用姓名認領' }).click();
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 });
    const linked = ctx.api.json(`SELECT row_to_json(x) FROM (SELECT user_id, name_slot FROM public.instructors WHERE id = :'id') x`, { id: slot.id });
    r.check('B 只輸入姓名就直接綁定空位', linked?.user_id === user.id);
    r.check('B 帳號直接開通成 teacher，名稱改成空位姓名',
      roleOf(ctx, user.id) === 'teacher' && ctx.api.sql(`SELECT name FROM public.users WHERE id = :'id'`, { id: user.id }) === slotName);

    await waitProfileLoaded(s.page);
    if (!(await visible(s.page.getByText('已找到並認領您的講師主檔'), 3000))) {
      ctx.known('B 姓名認領後沒有「已認領」橫幅', 'B［UX 小缺口］姓名認領成功後的 /profile 沒有「已找到並認領您的講師主檔」橫幅——refreshProfile 再呼叫 claim_my_precreated_instructor 時回 claimed_now=false（src/pages/ProfilePage.jsx:536 只在 claimed_now 為真時顯示），老師只看到「還缺 N 項」。');
    }
    r.check('B ProfileCompleteGate 顯示缺項橫幅', await visible(s.page.getByText(/還缺 \d+ 項講師資料/)));
    await shot(s.page, ctx.shotsDir, 'B-02-profile-gate');
    await goto(ctx, s, '/courses');
    await s.page.waitForURL(/\/profile$/, { timeout: 10000 }).catch(() => {});
    r.check('B 資料未完成前進不了 /courses（被導回 /profile）', /\/profile$/.test(s.page.url()));
    const blockedCourses = await ctx.api.rest(user.token, 'GET', 'courses?select=id,title');
    r.check('B 資料未完成前 REST 也讀不到課程（RLS）', blockedCourses.status === 200 && blockedCourses.data.length === 0);

    const data = profileData(user, slotName);
    await fillProfile(s.page, data);
    await clickSave(s.page);
    r.check('B 儲存成功提示', await pollUntil(() => s.dialogs.some((d) => d.message.includes('個人資料已儲存')), { timeoutMs: 15000 }), s.dialogs.at(-1)?.message || '');
    const inst = instructorOf(ctx, user.id);
    r.check('B 資料庫個資補齊（空位那一列，不是新建第二列）', inst?.id === slot.id && inst.phone_mobile === data.phone_mobile && inst.bankbook_path);

    const seenB = await seeSeededCourse(ctx, s);
    r.check('B 填完資料後能進 /courses 看到課程', seenB.ok, seenB.detail);
    await shot(s.page, ctx.shotsDir, 'B-03-courses');

    let sign = await signContractUI(ctx, s, user, 'B');
    if (sign.roleMissing) {
      await shot(s.page, ctx.shotsDir, 'B-04-contract-role-missing');
      ctx.known('B 空位沒有講師等級→不能簽約', 'B［產品缺口］管理員只填姓名建立的空位沒有講師等級（instructor_role 為 NULL）；老師認領並填完資料後，合約頁顯示「尚無法簽署：您的講師等級尚未設定」，要管理員另外設定等級才能簽約（src/pages/ContractSigningFlow.jsx:169 roleMissing；trigger guard_instructor_role 只在老師自己 INSERT 時預設「實習」，管理員建立的空位不會）。');
      r.note('B 合約頁顯示「講師等級尚未設定」→ 管理員以 REST 設定等級「實習」後重試');
      const patch = await ctx.api.rest(ctx.base.admin.token, 'PATCH', `instructors?id=eq.${slot.id}`, { body: { instructor_role: '實習' } });
      r.check('B 管理員補設講師等級', patch.status === 204, `HTTP ${patch.status}`);
      sign = await signContractUI(ctx, s, user, 'B（補等級後）');
    }
    await shot(s.page, ctx.shotsDir, 'B-05-contract-done');
    await verifySignedContractInDb(ctx, user.id, 'B');
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `B: ${e}`));
    await s.context.close();
  }
}

// ═══ C 同名同姓 ══════════════════════════════════════════════════════
export async function scenarioC(ctx) {
  const r = ctx.r;
  const name = '同名老師';
  const first = await adminCreateInstructor(ctx.api, ctx.base.admin, { full_name: name, name_slot: true });
  await sleep(20);
  const second = await adminCreateInstructor(ctx.api, ctx.base.admin, { full_name: name, name_slot: true });
  const claimed = [];
  for (let i = 0; i < 2; i += 1) {
    const user = await newUser(ctx, `c-same${i + 1}`, `同名帳號${i + 1}`);
    const s = await openAs(ctx.browser, ctx.stack, user);
    try {
      await goto(ctx, s, '/pending');
      await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
      await chooseCard(s.page, '認領帳號');
      // 姓名中間多打空白也要能對上（後端會去掉所有空白比對）
      await nameClaimUI(s.page, i === 0 ? name : ' 同名 老師 ');
      await s.page.waitForURL(/\/profile$/, { timeout: 15000 }).catch(() => {});
      const row = ctx.api.sql(`SELECT id FROM public.instructors WHERE user_id = :'uid'`, { uid: user.id });
      claimed.push(row);
      r.check(`C 第 ${i + 1} 個同名帳號認領成功`, Boolean(row) && roleOf(ctx, user.id) === 'teacher' && /\/profile$/.test(s.page.url()));
    } finally {
      ctx.consoleErrors.push(...s.consoleErrors.map((e) => `C${i + 1}: ${e}`));
      await s.context.close();
    }
  }
  r.check('C 兩個帳號綁到不同列，且依建立先後（先建的給先認領的）', claimed[0] === first.id && claimed[1] === second.id, JSON.stringify(claimed));

  const third = await newUser(ctx, 'c-same3', '同名帳號3');
  const s = await openAs(ctx.browser, ctx.stack, third);
  try {
    await goto(ctx, s, '/pending');
    await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s.page, '認領帳號');
    await nameClaimUI(s.page, name);
    const identityShown = await visible(s.page.locator('#claim-phone'), 10000) && await s.page.locator('#claim-id-last-four').isVisible();
    r.check('C 第三個同名帳號回 not_found，畫面出現手機與身分證末四碼欄', identityShown);
    r.check('C 第三個帳號看到說明（沒有空位，可改核對舊資料或選新建）', await s.page.getByRole('status').innerText().then((t) => t.includes('後台沒有只登記這個姓名的空位')).catch(() => false));
    r.check('C 第三個帳號仍是 pending、沒有綁到任何列', roleOf(ctx, third.id) === 'pending' && !instructorOf(ctx, third.id));
    await shot(s.page, ctx.shotsDir, 'C-01-third-same-name-identity-step');
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `C3: ${e}`));
    await s.context.close();
  }
}

// ═══ D 舊資料核對（姓名＋手機＋身分證末四碼） ═════════════════════════
export async function scenarioD(ctx) {
  const r = ctx.r;
  const legacyName = '舊資料陳老師';
  const legacyEmail = `legacy-chen-${ctx.base.runTag}@old-mail.example`;
  const legacy = await adminCreateInstructor(ctx.api, ctx.base.admin, {
    full_name: legacyName, nickname: '陳老師', gender: '男', birth_date: '1988-08-08',
    phone_mobile: '0912-345-678', id_number: 'B223456789', address: '臺中市西屯區舊資料路 8 號',
    email_primary: legacyEmail, employment_status: 'active', instructor_role: 'A',
  });
  const user = await newUser(ctx, 'd-legacy', 'Chen Legacy');
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/pending');
    await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s.page, '認領帳號');
    await nameClaimUI(s.page, legacyName);
    r.check('D 舊講師（非空位）用姓名認領回 not_found、進第二步', await visible(s.page.locator('#claim-phone'), 10000));
    r.check('D 有個資的舊講師不會被只靠姓名綁走', !instructorOf(ctx, user.id));

    await s.page.locator('#claim-phone').fill('0912345678');
    await s.page.locator('#claim-id-last-four').fill('0000');
    await s.page.getByRole('button', { name: '核對並帶入資料' }).click();
    const failText = await pollUntil(async () => {
      const t = await s.page.getByRole('status').innerText().catch(() => '');
      return /剩餘 \d+ 次/.test(t) ? t : null;
    });
    r.check('D 末四碼錯誤顯示失敗與剩餘次數', Boolean(failText), failText || '');
    await shot(s.page, ctx.shotsDir, 'D-01-wrong-last-four');

    await s.page.locator('#claim-id-last-four').fill('6789');
    await s.page.getByRole('button', { name: '核對並帶入資料' }).click();
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 }).catch(() => {});
    const inst = instructorOf(ctx, user.id);
    r.check('D 正確資料後開通並綁定舊講師列', inst?.id === legacy.id && roleOf(ctx, user.id) === 'teacher' && /\/profile$/.test(s.page.url()));
    await waitProfileLoaded(s.page);
    r.check('D /profile 帶入舊資料（暱稱、手機、身分證）',
      await fieldControl(s.page, '講師暱稱').inputValue() === '陳老師'
      && await fieldControl(s.page, '手機號碼').inputValue() === '0912-345-678'
      && await fieldControl(s.page, '身分證字號').inputValue() === 'B223456789');
    await shot(s.page, ctx.shotsDir, 'D-02-legacy-data-loaded');

    // 補齊其他欄位；主要 Email 保持舊資料上的信箱（舊講師常見情況）
    const data = profileData(user, legacyName, {
      nickname: undefined, gender: undefined, birth_date: undefined, id_number: undefined,
      phone_mobile: undefined, address: undefined, email_primary: undefined,
    });
    await fillProfile(s.page, data);
    const before = s.dialogs.length;
    await clickSave(s.page);
    const outcome = await pollUntil(() => s.dialogs.slice(before).find((d) => /個人資料已儲存|儲存失敗/.test(d.message)), { timeoutMs: 15000 });
    const savedWithLegacyEmail = outcome?.message.includes('個人資料已儲存');
    if (!savedWithLegacyEmail) {
      ctx.known('D 舊講師保留舊 Email 存不了個人資料', `D［bug］用「姓名＋手機＋末四碼」認領舊講師後，主要 Email 保持舊資料上的信箱就無法儲存個人資料（${outcome?.message || '無回應'}）。要把主要 Email 改成目前登入的 Google 信箱才能存。`);
      ctx.dEmailBug = true;
      r.note(`D 保留舊 Email 儲存失敗：${outcome?.message}；改用登入信箱再存一次`);
      await fieldControl(s.page, '主要 Email').fill(user.email);
      const again = s.dialogs.length;
      await clickSave(s.page);
      await pollUntil(() => s.dialogs.slice(again).find((d) => /個人資料已儲存|儲存失敗/.test(d.message)), { timeoutMs: 15000 });
    }
    const after = instructorOf(ctx, user.id);
    r.check('D 舊講師補完資料後主檔完整（同一列）', after?.id === legacy.id && after.bankbook_path && after.bank_account_number === data.bank_account_number);
    const seenD = await seeSeededCourse(ctx, s);
    r.check('D 補完資料後能進課程', seenD.ok, seenD.detail);

    // 根因探針（REST）：另一位舊講師用同樣方式認領後，PATCH（純更新）可以；
    // 但 ProfilePage 用的 upsert（POST …?on_conflict=user_id）會先觸發 BEFORE INSERT trigger 而被擋。
    const legacy2Email = `legacy-probe-${ctx.base.runTag}@old-mail.example`;
    await adminCreateInstructor(ctx.api, ctx.base.admin, {
      full_name: '舊資料探針老師', phone_mobile: '0922-000-111', id_number: 'E212345678',
      email_primary: legacy2Email, employment_status: 'active',
    });
    const probeUser = await newUser(ctx, 'd-probe', 'Probe');
    const probeClaim = await ctx.api.rpc(probeUser.token, 'claim_existing_instructor_by_identity', {
      provided_full_name: '舊資料探針老師', provided_phone_mobile: '0922000111', provided_id_last_four: '5678',
    });
    const probePatch = await ctx.api.rest(probeUser.token, 'PATCH', `instructors?user_id=eq.${probeUser.id}`, { body: { line_id: 'probe-patch' } });
    const probeUpsert = await ctx.api.rest(probeUser.token, 'POST', 'instructors?on_conflict=user_id', {
      body: { user_id: probeUser.id, full_name: '舊資料探針老師', email_primary: legacy2Email, line_id: 'probe-upsert' },
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    r.check('D 探針：舊講師認領後 PATCH 自己的列（保留舊 Email）可以成功', probeClaim.data?.status === 'claimed' && probePatch.status === 204,
      `claim=${JSON.stringify(probeClaim.data)} PATCH=${probePatch.status}`);
    if (probeUpsert.status !== 201) {
      ctx.known('D 舊講師 upsert 被 BEFORE INSERT trigger 擋', `D［bug 根因］同一列用 PATCH 更新成功，但用 ProfilePage 的 upsert（src/pages/ProfilePage.jsx:461 .upsert(payload, { onConflict: 'user_id' })）就回 HTTP ${probeUpsert.status}「${probeUpsert.data?.message}」：PostgreSQL 的 INSERT … ON CONFLICT 會先跑 BEFORE INSERT trigger，guard_instructor_identity_email 的 INSERT 分支（supabase/migrations/20260826140000_recover_existing_instructor_identity_claim.sql:354-358）要求 email_primary＝登入信箱，所以舊講師主檔上的舊信箱整筆被拒。`);
    }
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `D: ${e}`));
    await s.context.close();
  }
}

// ═══ E Email 自動對應 ═══════════════════════════════════════════════
export async function scenarioE(ctx) {
  const r = ctx.r;
  seq += 1;
  const email = `e-auto-${ctx.base.runTag}-${seq}@e2e.test`;
  const pre = await adminCreateInstructor(ctx.api, ctx.base.admin, {
    full_name: '信箱自動老師', email_primary: email, employment_status: 'active', instructor_role: 'B',
  });
  const user = await createGoogleUser(ctx.stack, { email, fullName: 'Auto Mail' });
  r.check('E Before-User-Created hook 允許後台已建立的 Email', Boolean(user.id), JSON.stringify(user.hookRejected || {}));
  if (!user.id) return;
  const linkedAtSignup = ctx.api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: pre.id });
  r.check('E 帳號建立當下 trigger 就自動綁定主檔並給 teacher', linkedAtSignup === user.id && roleOf(ctx, user.id) === 'teacher');
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    let sawChoice = false;
    s.page.on('framenavigated', async () => {
      if (await s.page.getByText('請選擇你的講師身分').isVisible().catch(() => false)) sawChoice = true;
    });
    await goto(ctx, s, '/pending');
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 }).catch(() => {});
    await waitProfileLoaded(s.page).catch(() => {});
    const rpc = await ctx.api.rpc(user.token, 'claim_my_precreated_instructor');
    r.check('E claim_my_precreated_instructor 回 claimed', rpc.data?.status === 'claimed', JSON.stringify(rpc.data));
    r.check('E 不經 /pending 選擇卡，直接到 /profile 補資料', !sawChoice && /\/profile$/.test(s.page.url())
      && !(await s.page.getByText('請選擇你的講師身分').isVisible().catch(() => false)));
    r.check('E /profile 帶入後台建立的姓名', await fieldControl(s.page, '姓名').inputValue() === '信箱自動老師');
    await shot(s.page, ctx.shotsDir, 'E-01-auto-linked-profile');

    // 同 Email 第二個 Google 帳號：hook 必須拒絕（主檔已被認領）
    const dup = await createGoogleUser(ctx.stack, { email: email.toUpperCase(), fullName: 'Dup' });
    r.check('E 同 Email（大小寫不同）第二次註冊被 hook 拒絕', !dup.id && dup.hookRejected?.http_code === 409, JSON.stringify(dup.hookRejected || {}));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `E: ${e}`));
    await s.context.close();
  }
}

// ═══ F 安全（REST 直接打） ══════════════════════════════════════════
export async function scenarioF(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const admin = ctx.base.admin;
  const claim = (u, name) => api.rpc(u.token, 'claim_instructor_name_slot', { provided_full_name: name });

  // F1 有個資的空位不能用姓名認領
  const piiSlot = await adminCreateInstructor(api, admin, { full_name: '有個資空位', name_slot: true, phone_mobile: '0911000111' });
  const u1 = await newUser(ctx, 'f-pii', 'F1');
  const res1 = await claim(u1, '有個資空位');
  r.check('F 有個資（手機）的空位不能用姓名認領', res1.data?.status === 'not_found' && !api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: piiSlot.id }), JSON.stringify(res1.data));
  for (const [field, value] of [['id_number', 'D123456789'], ['bank_account_number', '000123'], ['birth_date', '1990-01-01'], ['id_front_path', 'instructors/x/id_front/a.png']]) {
    const slot = await adminCreateInstructor(api, admin, { full_name: `有個資${field}`, name_slot: true, [field]: value });
    const u = await newUser(ctx, `f-pii-${field}`, 'F1x');
    const res = await claim(u, `有個資${field}`);
    r.check(`F 有 ${field} 的空位不能用姓名認領`, res.data?.status === 'not_found' && !api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: slot.id }), JSON.stringify(res.data));
  }

  // F2 frozen／cancelled 空位不能認領
  for (const status of ['frozen', 'cancelled']) {
    const slot = await adminCreateInstructor(api, admin, { full_name: `停用空位${status}`, name_slot: true, employment_status: status });
    const u = await newUser(ctx, `f-${status}`, `F2${status}`);
    const res = await claim(u, `停用空位${status}`);
    r.check(`F ${status} 空位不能認領`, res.data?.status === 'not_found' && roleOf(ctx, u.id) === 'pending', JSON.stringify(res.data));
  }

  // F3 已是 teacher 的帳號呼叫被拒
  const spare = await adminCreateInstructor(api, admin, { full_name: '備用空位', name_slot: true });
  const teacherUser = await newUser(ctx, 'f-teacher', 'F3');
  const firstClaim = await claim(teacherUser, '備用空位');
  const spare2 = await adminCreateInstructor(api, admin, { full_name: '備用空位', name_slot: true });
  const res3 = await claim(teacherUser, '備用空位');
  r.check('F 已是 teacher 的帳號再呼叫 claim_instructor_name_slot 被拒（42501）',
    firstClaim.data?.status === 'claimed' && res3.status === 403 && res3.data?.code === '42501'
    && !api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: spare2.id }), `HTTP ${res3.status} ${JSON.stringify(res3.data)}`);
  r.check('F 該 teacher 仍只綁一列', api.sql(`SELECT count(*) FROM public.instructors WHERE user_id = :'uid'`, { uid: teacherUser.id }) === '1' && spare.id);

  // F4 未登入（anon）被拒
  const anonRes = await api.request(null, 'POST', '/rest/v1/rpc/claim_instructor_name_slot', { body: { provided_full_name: '備用空位' } });
  r.check('F 未登入（anon key）呼叫被拒', [401, 403].includes(anonRes.status) && !api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: spare2.id }), `HTTP ${anonRes.status} ${JSON.stringify(anonRes.data)}`);

  // F5 已綁定（pending 但已有自己的講師列）→ already_linked，不綁第二筆
  const selfMade = await newUser(ctx, 'f-selfmade', 'F5 自建');
  const own = await api.rest(selfMade.token, 'POST', 'instructors', {
    body: { user_id: selfMade.id, full_name: 'F5 自建', email_primary: selfMade.email }, prefer: 'return=minimal',
  });
  const res5 = await claim(selfMade, '備用空位');
  r.check('F 已有講師列的 pending 帳號呼叫回 already_linked、不綁第二筆',
    own.status === 201 && res5.data?.status === 'already_linked'
    && api.sql(`SELECT count(*) FROM public.instructors WHERE user_id = :'uid'`, { uid: selfMade.id }) === '1'
    && !api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: spare2.id }), `HTTP ${own.status} ${JSON.stringify(res5.data)}`);

  // F6 講師不能用 REST 把自己的 name_slot 改成 true（也不能把認領來的空位旗標改掉）
  seq += 1;
  const f6Email = `f-email-teacher-${ctx.base.runTag}-${seq}@e2e.test`;
  const f6Row = await adminCreateInstructor(api, admin, { full_name: 'F6 一般講師', email_primary: f6Email, employment_status: 'active' });
  const f6Teacher = await createGoogleUser(ctx.stack, { email: f6Email, fullName: 'F6' });
  const patch = await api.rest(f6Teacher.token, 'PATCH', `instructors?user_id=eq.${f6Teacher.id}`, { body: { name_slot: true } });
  const flag = api.sql(`SELECT name_slot FROM public.instructors WHERE id = :'id'`, { id: f6Row.id });
  r.check('F 講師（teacher）PATCH 自己的 name_slot=true 被拒（維持 false）',
    roleOf(ctx, f6Teacher.id) === 'teacher' && patch.status === 403 && flag === 'f', `HTTP ${patch.status} 值=${flag}`);
  const clear = await api.rest(teacherUser.token, 'PATCH', `instructors?user_id=eq.${teacherUser.id}`, { body: { name_slot: false } });
  const kept = api.sql(`SELECT name_slot FROM public.instructors WHERE user_id = :'uid'`, { uid: teacherUser.id });
  r.check('F 講師也不能把認領來的空位 name_slot 改成 false', clear.status === 403 && kept === 't', `HTTP ${clear.status} 值=${kept}`);
  const patchSelfMade = await api.rest(selfMade.token, 'PATCH', `instructors?user_id=eq.${selfMade.id}`, { body: { name_slot: true } });
  const selfFlag = api.sql(`SELECT name_slot FROM public.instructors WHERE user_id = :'uid'`, { uid: selfMade.id });
  r.check('F pending 自建講師 PATCH name_slot=true 被拒（維持 false）', patchSelfMade.status === 403 && selfFlag === 'f', `HTTP ${patchSelfMade.status} 值=${selfFlag}`);

  // F7 講師不能新增 name_slot=true 的列（自己的、或沒人綁的）
  const fresh = await newUser(ctx, 'f-insert', 'F7');
  const ins1 = await api.rest(fresh.token, 'POST', 'instructors', {
    body: { user_id: fresh.id, full_name: 'F7 偽空位', email_primary: fresh.email, name_slot: true }, prefer: 'return=minimal',
  });
  const ins2 = await api.rest(fresh.token, 'POST', 'instructors', {
    body: { user_id: null, full_name: 'F7 無主空位', name_slot: true }, prefer: 'return=minimal',
  });
  r.check('F 講師新增 name_slot=true 的列被拒', ins1.status === 403 && ins2.status === 403
    && api.sql(`SELECT count(*) FROM public.instructors WHERE full_name LIKE 'F7 %'`) === '0', `HTTP ${ins1.status}/${ins2.status}`);

  // F8 講師／pending／anon 讀不到未認領的空位
  const asTeacher = await api.rest(teacherUser.token, 'GET', 'instructors?select=id,full_name,name_slot,user_id');
  const asPending = await api.rest(fresh.token, 'GET', 'instructors?select=id&name_slot=eq.true');
  const asAnon = await api.request(null, 'GET', '/rest/v1/instructors?select=id&name_slot=eq.true');
  const unclaimed = Number(api.sql(`SELECT count(*) FROM public.instructors WHERE name_slot AND user_id IS NULL`));
  r.check('F 講師 SELECT instructors 只看得到自己那一列', asTeacher.status === 200 && asTeacher.data.length === 1 && asTeacher.data[0].user_id === teacherUser.id, `看到 ${asTeacher.data?.length} 列`);
  r.check('F pending 讀不到任何未認領空位', asPending.status === 200 && asPending.data.length === 0 && unclaimed > 0, `未認領空位共 ${unclaimed}`);
  r.check('F 未登入讀不到任何空位', (asAnon.status === 200 && asAnon.data.length === 0) || [401, 403].includes(asAnon.status), `HTTP ${asAnon.status}`);

  // F10 Storage RLS（假 Storage 以呼叫者身分寫 storage.objects，政策真的生效）
  const owner = await newUser(ctx, 'f-file-owner', 'F10 檔案主人');
  const other = await newUser(ctx, 'f-file-other', 'F10 旁人');
  const ownPath = `instructors/${owner.id}/id_front/${Date.now()}.png`;
  const upload = (u, bucket, objectPath, body, type = 'image/png') => api.request(u?.token || null, 'POST', `/storage/v1/object/${bucket}/${objectPath}`, {
    raw: body, headers: { 'content-type': type },
  });
  const ownUp = await upload(owner, 'instructor_uploads', ownPath, samplePng('owner'));
  r.check('F 本人可上傳到自己的 instructors/<uid>/ 資料夾', ownUp.status === 200, `HTTP ${ownUp.status} ${JSON.stringify(ownUp.data)}`);
  const intrude = await upload(other, 'instructor_uploads', `instructors/${owner.id}/id_front/evil.png`, samplePng('evil'));
  r.check('F 別人不能上傳到他人的證件資料夾（403）', intrude.status === 403, `HTTP ${intrude.status}`);
  const readOther = await api.request(other.token, 'GET', `/storage/v1/object/authenticated/instructor_uploads/${ownPath}`);
  const signOther = await api.request(other.token, 'POST', `/storage/v1/object/sign/instructor_uploads/${ownPath}`, { body: { expiresIn: 60 } });
  r.check('F 別人讀不到、也簽不出他人的證件檔', readOther.status === 400 && signOther.status === 400, `GET=${readOther.status} sign=${signOther.status}`);
  const adminRead = await api.request(ctx.base.admin.token, 'GET', `/storage/v1/object/authenticated/instructor_uploads/${ownPath}`);
  r.check('F 對照組：管理員讀得到同一個檔（證明上面是 RLS 擋下，不是路徑錯）', adminRead.status === 200, `HTTP ${adminRead.status}`);
  const delOther = await api.request(other.token, 'DELETE', '/storage/v1/object/instructor_uploads', { body: { prefixes: [ownPath] } });
  const stillThere = api.sql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'instructor_uploads' AND name = :'n'`, { n: ownPath });
  r.check('F 別人刪不掉他人的證件檔', delOther.status === 200 && Array.isArray(delOther.data) && delOther.data.length === 0 && stillThere === '1', `HTTP ${delOther.status} 刪除 ${delOther.data?.length} 筆`);
  const template = await upload(other, 'contract-documents', `templates/evil-${Date.now()}.pdf`, Buffer.from('%PDF-1.4 evil'), 'application/pdf');
  r.check('F 老師不能上傳合約範本（只有管理員）', template.status === 403, `HTTP ${template.status}`);
  const otherSigned = await upload(other, 'contract-documents', `signed/${owner.id}/fake.png`, samplePng('fake-sign'));
  r.check('F 老師不能把簽名檔放進別人的 signed/<uid>/ 資料夾', otherSigned.status === 403, `HTTP ${otherSigned.status}`);
  const anonUp = await api.request(null, 'POST', `/storage/v1/object/instructor_uploads/instructors/${owner.id}/id_back/anon.png`, {
    raw: samplePng('anon'), headers: { 'content-type': 'image/png' },
  });
  r.check('F 未登入不能上傳', anonUp.status === 403, `HTTP ${anonUp.status}`);
  const wrongType = await upload(owner, 'instructor_uploads', `instructors/${owner.id}/id_back/x.pdf`, Buffer.from('%PDF-1.4'), 'application/pdf');
  r.check('F 證件 bucket 拒收非圖片檔（bucket allowed_mime_types）', wrongType.status === 415, `HTTP ${wrongType.status}`);

  // 額外：太長的姓名、空白姓名
  const longName = await claim(fresh, '名'.repeat(51));
  const blank = await claim(fresh, '   ');
  r.check('F 空白或超過 50 字的姓名回 invalid_input', longName.data?.status === 'invalid_input' && blank.data?.status === 'invalid_input');

  // F9 兩個帳號同時認領同一個名字：只有一個成功（重複 5 輪；最後一輪 3 人搶）
  let raceOk = true;
  const raceDetail = [];
  for (let round = 0; round < 5; round += 1) {
    const name = `搶名老師${round}`;
    const slot = await adminCreateInstructor(api, admin, { full_name: name, name_slot: true });
    const racers = [];
    for (let i = 0; i < (round === 4 ? 3 : 2); i += 1) racers.push(await newUser(ctx, `f-race${round}-${i}`, `搶${i}`));
    const results = await Promise.all(racers.map((u) => claim(u, name)));
    const statuses = results.map((x) => x.data?.status);
    const winners = statuses.filter((x) => x === 'claimed').length;
    const owner = api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: slot.id });
    const teacherCount = racers.filter((u) => roleOf(ctx, u.id) === 'teacher').length;
    raceDetail.push(statuses.join('/'));
    if (!(winners === 1 && teacherCount === 1 && racers.some((u) => u.id === owner) && statuses.every((x) => ['claimed', 'not_found'].includes(x)))) raceOk = false;
  }
  r.check('F 同時認領同一空位：每輪剛好一人成功、其他 not_found、只有贏家變 teacher', raceOk, raceDetail.join(' | '));
}

// ═══ G 解除錯誤認領 ═════════════════════════════════════════════════
export async function scenarioG(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const admin = ctx.base.admin;
  const claim = (u, name) => api.rpc(u.token, 'claim_instructor_name_slot', { provided_full_name: name });

  // G1 冒認者還沒填個資 → 解除後真老師可以再用姓名認領
  const slot1 = await adminCreateInstructor(api, admin, { full_name: '被冒認老師甲', name_slot: true });
  const impostor = await newUser(ctx, 'g-impostor', '冒認者甲');
  const c1 = await claim(impostor, '被冒認老師甲');
  r.check('G 冒認者先用姓名認領成功', c1.data?.status === 'claimed' && roleOf(ctx, impostor.id) === 'teacher');
  const unlink = await api.rpc(admin.token, 'admin_unlink_instructor', { target_instructor_id: slot1.id });
  r.check('G 管理員 admin_unlink_instructor 成功', [200, 204].includes(unlink.status), `HTTP ${unlink.status} ${JSON.stringify(unlink.data)}`);
  r.check('G 冒認者回到 pending、空位 user_id 清空',
    roleOf(ctx, impostor.id) === 'pending' && !api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: slot1.id }));
  const impostorRead = await api.rest(impostor.token, 'GET', `instructors?select=id&id=eq.${slot1.id}`);
  r.check('G 解除後冒認者讀不到該空位', impostorRead.status === 200 && impostorRead.data.length === 0);
  const s = await openAs(ctx.browser, ctx.stack, impostor);
  try {
    await goto(ctx, s, '/courses');
    await s.page.waitForURL(/\/pending$/, { timeout: 12000 }).catch(() => {});
    r.check('G 冒認者的畫面回到 /pending 並重新出現兩張選擇卡', /\/pending$/.test(s.page.url()) && await visible(s.page.getByRole('button', { name: /^認領帳號/ })));
    await shot(s.page, ctx.shotsDir, 'G-01-impostor-back-to-pending');
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `G: ${e}`));
    await s.context.close();
  }
  const realTeacher = await newUser(ctx, 'g-real', '真老師甲');
  const c2 = await claim(realTeacher, '被冒認老師甲');
  r.check('G 空位沒被填個資 → 真正的老師可以再用姓名認領',
    c2.data?.status === 'claimed' && api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: slot1.id }) === realTeacher.id);

  // G2 冒認者已填手機與身分證 → 解除後不能再用姓名認領（設計如此）
  const slot2 = await adminCreateInstructor(api, admin, { full_name: '被冒認老師乙', name_slot: true });
  const impostor2 = await newUser(ctx, 'g-impostor2', '冒認者乙');
  await claim(impostor2, '被冒認老師乙');
  const fill = await api.rest(impostor2.token, 'PATCH', `instructors?user_id=eq.${impostor2.id}`, {
    body: { phone_mobile: '0988000111', id_number: 'C123456789', email_primary: impostor2.email },
  });
  r.check('G 冒認者把手機與身分證填進空位', fill.status === 204, `HTTP ${fill.status} ${JSON.stringify(fill.data)}`);
  await api.rpc(admin.token, 'admin_unlink_instructor', { target_instructor_id: slot2.id });
  const realTeacher2 = await newUser(ctx, 'g-real2', '真老師乙');
  const c3 = await claim(realTeacher2, '被冒認老師乙');
  r.check('G 空位已被冒認者填了手機／身分證 → 解除後不能再用姓名認領（設計如此）', c3.data?.status === 'not_found', JSON.stringify(c3.data));
  r.check('G 冒認者填的個資仍留在空位上（需管理員手動清除）',
    api.sql(`SELECT phone_mobile || '/' || id_number FROM public.instructors WHERE id = :'id'`, { id: slot2.id }) === '0988000111/C123456789');
  ctx.findings.add('G（設計行為，記錄）：冒認者若已在空位填了手機或身分證，管理員解除綁定後該空位不能再用姓名認領，冒認者填的個資也還留在列上；真正的老師只能走「姓名＋手機＋末四碼」（但那是冒認者的資料），實務上要管理員先清掉那些欄位或另建空位。');
  const cleared = await api.rest(admin.token, 'PATCH', `instructors?id=eq.${slot2.id}`, { body: { phone_mobile: null, id_number: null, email_primary: null } });
  const c4 = await claim(realTeacher2, '被冒認老師乙');
  r.check('G 管理員清掉冒認者的個資後，真老師可以用姓名認領', cleared.status === 204 && c4.data?.status === 'claimed', `HTTP ${cleared.status} ${JSON.stringify(c4.data)}`);
}

// ═══ H 手機版 390px ═════════════════════════════════════════════════
export async function scenarioH(ctx) {
  const r = ctx.r;
  const viewport = { width: 390, height: 844 };
  const check = async (s, tag, file) => {
    await sleep(300);
    const m = await measureOverflow(s.page);
    await shot(s.page, ctx.shotsDir, file);
    r.check(`H ${tag}（390px）無水平溢出`, !m.overflow && m.offenders.length === 0, `docWidth=${m.docWidth} ${m.offenders.join('; ')}`);
  };

  // A 路線：/pending 選擇卡 → 新建帳號 → /profile 擋門
  const ua = await newUser(ctx, 'h-new', '手機新老師');
  const sa = await openAs(ctx.browser, ctx.stack, ua, { viewport });
  try {
    await goto(ctx, sa, '/pending');
    await visible(sa.page.getByRole('button', { name: /^新建帳號/ }));
    await check(sa, 'A /pending 選擇卡', 'H-A-01-pending-390');
    await chooseCard(sa.page, '新建帳號');
    await waitProfileLoaded(sa.page);
    await check(sa, 'A /profile 新建表單', 'H-A-02-profile-390');
  } finally {
    ctx.consoleErrors.push(...sa.consoleErrors.map((e) => `H-A: ${e}`));
    await sa.context.close();
  }

  // B 路線：/pending → 認領第 1 步（姓名）→ 第 2 步（手機＋末四碼）→ 姓名認領成功 → /profile 擋門
  await adminCreateInstructor(ctx.api, ctx.base.admin, { full_name: '手機空位老師', name_slot: true });
  const ub = await newUser(ctx, 'h-slot', '手機認領');
  const sb = await openAs(ctx.browser, ctx.stack, ub, { viewport });
  try {
    await goto(ctx, sb, '/pending');
    await visible(sb.page.getByRole('button', { name: /^認領帳號/ }));
    await check(sb, 'B /pending 選擇卡', 'H-B-01-pending-390');
    await chooseCard(sb.page, '認領帳號');
    await sb.page.locator('#claim-full-name').fill('手機空位老師');
    await check(sb, 'B 認領第 1 步（只填姓名）', 'H-B-02-claim-name-390');
    await nameClaimUI(sb.page, '沒有這個人');
    await visible(sb.page.locator('#claim-phone'));
    await check(sb, 'B 認領第 2 步（手機＋末四碼）', 'H-B-03-claim-identity-390');
    await sb.page.getByRole('button', { name: '返回' }).click();
    await chooseCard(sb.page, '認領帳號');
    await sb.page.locator('#claim-full-name').fill('手機空位老師');
    // 回到第 1 步要重新走姓名認領（返回後 claimStep 會重設為 name）
    await sb.page.getByRole('button', { name: '用姓名認領' }).click();
    await sb.page.waitForURL(/\/profile$/, { timeout: 15000 });
    await waitProfileLoaded(sb.page);
    await visible(sb.page.getByText(/還缺 \d+ 項講師資料/));
    await check(sb, 'B /profile 擋門橫幅', 'H-B-04-profile-gate-390');
  } finally {
    ctx.consoleErrors.push(...sb.consoleErrors.map((e) => `H-B: ${e}`));
    await sb.context.close();
  }
}

// ═══ 底座自檢（每次都跑）：假 GoTrue／閘道金鑰／repo SQL 與正式庫的已知落差 ═══════════
export async function selfTest(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const u = await newUser(ctx, 'z-self', '自檢帳號');
  const me = await api.request(u.token, 'GET', '/auth/v1/user');
  r.check('底座 /auth/v1/user 回傳登入者（含 Google provider 與 full_name）',
    me.status === 200 && me.data?.id === u.id && me.data?.app_metadata?.provider === 'google' && me.data?.user_metadata?.full_name === '自檢帳號');
  const refreshed = await api.request(null, 'POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: u.session.refresh_token } });
  const reused = await api.request(null, 'POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: u.session.refresh_token } });
  const viaNew = refreshed.data?.access_token ? await api.request(refreshed.data.access_token, 'GET', '/auth/v1/user') : { status: 0 };
  r.check('底座 refresh_token 換新 session（新 token 可用）、舊 refresh token 不能重用',
    refreshed.status === 200 && refreshed.data?.refresh_token !== u.session.refresh_token && viaNew.status === 200 && viaNew.data?.id === u.id && reused.status === 400,
    `refresh=${refreshed.status} reuse=${reused.status}`);
  const logout = await api.request(u.token, 'POST', '/auth/v1/logout');
  r.check('底座 /auth/v1/logout 回 204', logout.status === 204);
  const badJwt = await api.request(`${u.token.slice(0, -4)}AAAA`, 'GET', '/auth/v1/user');
  const badKey = await api.request(u.token, 'GET', '/rest/v1/users?select=id', { headers: { apikey: 'not-a-project-key' } });
  r.check('底座 竄改過的 JWT 與非本專案 apikey 一律 401', badJwt.status === 401 && badKey.status === 401);
  const otpUnknown = await api.request(null, 'POST', '/auth/v1/otp', { body: { email: 'nobody@e2e.test', create_user: false } });
  r.check('底座 未註冊信箱要求 OTP 被拒（create_user=false）', otpUnknown.status === 422);
  const asSelf = await api.rest(u.token, 'GET', 'users?select=id,role');
  r.check('底座 PostgREST 以 authenticated 身分跑 RLS（只看得到自己的 users 列）', asSelf.status === 200 && asSelf.data.length === 1 && asSelf.data[0].id === u.id);

  // repo SQL 從頭建庫與正式庫的落差：public.users.role 的 CHECK 沒有 mentor
  const mentor = ctx.stack.db.psqlSync(`BEGIN; UPDATE public.users SET role = 'mentor' WHERE id = :'id'; ROLLBACK;`, { vars: { id: u.id }, expectFail: true });
  if (!mentor.ok) {
    ctx.known('repo SQL 建出的 users.role 不允許 mentor', '［schema 落差］只用 repo SQL 從頭建庫時，public.users 的 CHECK 只允許 pending/teacher/admin（supabase/setup.sql:8），沒有任何 migration 把 mentor 加進去；但程式與 RLS 到處用 mentor，正式庫應是在版控外改過。第二階段若要測輔導員，需先補 migration 或在測試底座補這條約束。');
  }
}

export const SCENARIOS = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF, G: scenarioG, H: scenarioH };
