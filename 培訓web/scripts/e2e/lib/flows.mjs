// 情境共用的畫面操作：假帳號、填個人資料、帳號啟用 OTP、簽約（同意頁 → 簽約 OTP → 手寫簽名 → 確認簽署）、
// 後台確認 Email／核准，以及「桌機＋390px」雙截圖。所有斷言交給 ctx.r。
import { readFileSync } from 'node:fs';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { createGoogleUser, latestOtp, samplePng, sha256 } from './fixtures.mjs';
import { openAs, shot, measureOverflow, fieldControl } from './browser.mjs';
import { sleep } from './util.mjs';

export const REGIONS = ['臺北市', '新北市'];
let seq = 0;
const randomDigits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');

export async function newUser(ctx, prefix, fullName, { email } = {}) {
  seq += 1;
  const address = (email || `${prefix}-${ctx.base.runTag}-${seq}@e2e.test`).toLowerCase();
  const user = await createGoogleUser(ctx.stack, { email: address, fullName });
  if (!user.id) throw new Error(`Google 帳號建立被 hook 拒絕：${JSON.stringify(user.hookRejected)}`);
  return user;
}

export const nextSeq = () => { seq += 1; return seq; };

export function profileData(user, fullName, overrides = {}) {
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

export async function waitProfileLoaded(page) {
  await fieldControl(page, '姓名').waitFor({ state: 'visible', timeout: 20000 });
}

// 依 src/lib/profileCompletion.js：18 欄＋接課地區＋身分證正反面與存摺封面三份檔案
export async function fillProfile(page, data, { skip = [] } = {}) {
  await waitProfileLoaded(page);
  for (const [key, label] of FIELD_LABELS) {
    if (skip.includes(key) || data[key] === undefined) continue;
    const control = fieldControl(page, label);
    if (await control.isDisabled()) continue;
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

export async function clickSave(page) {
  await page.getByRole('button', { name: /送出資料|儲存個人資料/ }).click();
}

// 儲存並等「個人資料已儲存！」或「儲存失敗」提示，回傳提示文字
export async function saveProfileAndWait(session) {
  const before = session.dialogs.length;
  await clickSave(session.page);
  const hit = await pollUntil(() => session.dialogs.slice(before).find((d) => /個人資料已儲存|儲存失敗|請先補齊/.test(d.message)), { timeoutMs: 15000 });
  return hit?.message || '';
}

export const instructorOf = (ctx, userId) => ctx.api.json(
  `SELECT row_to_json(i) FROM public.instructors i WHERE i.user_id = :'uid'`, { uid: userId },
);
export const instructorById = (ctx, id) => ctx.api.json(`SELECT row_to_json(i) FROM public.instructors i WHERE i.id = :'id'`, { id });
export const roleOf = (ctx, userId) => ctx.api.sql(`SELECT role FROM public.users WHERE id = :'uid'`, { uid: userId });
export const activationOf = (ctx, userId) => ctx.api.json(
  `SELECT row_to_json(a) FROM public.instructor_account_activations a WHERE a.user_id = :'uid' ORDER BY a.claimed_at DESC LIMIT 1`, { uid: userId },
);

export async function pollUntil(fn, { timeoutMs = 10000, intervalMs = 200 } = {}) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

export async function visible(locator, timeout = 10000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

export const goto = (ctx, session, path) => session.page.goto(`${ctx.stack.baseUrl}${path}`, { waitUntil: 'domcontentloaded' });

export async function chooseCard(page, name) {
  await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

export async function nameClaimUI(page, fullName) {
  await page.locator('#claim-full-name').fill(fullName);
  await page.getByRole('button', { name: '用姓名認領' }).click();
}

// /courses 先列大分類；點進種好的分類，確認看得到那門課（UI 與 RLS 都要放行）
export async function seeSeededCourse(ctx, s, { navigate = true } = {}) {
  if (navigate) await goto(ctx, s, '/courses');
  const category = s.page.getByRole('link', { name: /E2E 培訓分類/ });
  if (!(await visible(category, 12000))) {
    return { ok: false, detail: `url=${s.page.url()} 畫面=${(await s.page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 200)}` };
  }
  await category.first().click();
  const ok = await visible(s.page.getByText(ctx.base.courseTitle), 10000);
  return { ok: ok && /\/courses/.test(s.page.url()), detail: ok ? '' : `url=${s.page.url()}` };
}

// 桌機截一張＋同一頁切到 390px 再截一張，並量 390px 無水平溢出（React 狀態不變，畫面只是重新排版）
export async function dualShot(ctx, session, name, { mobile = true, fullPage = true } = {}) {
  const { page } = session;
  await sleep(250);
  await shot(page, ctx.shotsDir, name, { fullPage });
  if (!mobile) return;
  const original = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(450);
  const m = await measureOverflow(page);
  await shot(page, ctx.shotsDir, `${name}-390`, { fullPage });
  ctx.r.check(`${name}（390px）無水平溢出`, !m.overflow && m.offenders.length === 0, `docWidth=${m.docWidth} ${m.offenders.join('; ')}`);
  await page.setViewportSize(original);
  await sleep(300);
}

// ── 帳號啟用：/profile 啟用卡 →「確認資料無誤，驗證信箱啟用帳號」→ EmailOtpDialog（從測試信箱讀碼，畫面輸入）
export async function openOtpDialogAndWaitSent(page) {
  const dialog = page.getByTestId('email-otp-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  await pollUntil(async () => (await page.getByTestId('otp-notice').innerText().catch(() => '')).length > 0, { timeoutMs: 10000 });
  return (await page.getByTestId('otp-notice').innerText().catch(() => '')).trim();
}

export async function typeOtp(page, code) {
  await page.locator('#email-otp-code').fill(code);
  await page.getByRole('dialog').getByRole('button', { name: /^驗證$/ }).click();
}

export async function activateViaUI(ctx, session, user, tag, { shots = false } = {}) {
  const { page } = session;
  const r = ctx.r;
  const button = page.getByTestId('activation-button');
  r.check(`${tag} 啟用卡顯示「確認資料無誤，驗證信箱啟用帳號」按鈕`, await visible(button, 10000));
  if (shots) await dualShot(ctx, session, `${tag}-activation-card`);
  await button.click();
  const notice = await openOtpDialogAndWaitSent(page);
  const otp = latestOtp(ctx.api, user.id, 'account_activation');
  r.check(`${tag} 啟用驗證碼已寄到公司已確認的信箱（畫面只顯示遮罩信箱）`, Boolean(otp?.code) && notice.includes('驗證碼已寄到') && !notice.includes(otp?.to || '@@'), `${notice}｜寄到 ${otp?.to}`);
  if (shots) await dualShot(ctx, session, `${tag}-activation-otp`, { fullPage: false });
  await typeOtp(page, otp.code);
  await page.waitForURL(/\/courses$/, { timeout: 15000 }).catch(() => {});
  r.check(`${tag} 輸入正確驗證碼後帳號啟用、自動導到 /courses`, /\/courses$/.test(page.url()) && roleOf(ctx, user.id) === 'teacher', `url=${page.url()} role=${roleOf(ctx, user.id)}`);
  return otp;
}

export function checkActivationRecord(ctx, user, tag, { method, email }) {
  const a = activationOf(ctx, user.id);
  const complete = a && a.status === 'active' && a.claim_method === method && a.claimed_at && a.activated_at
    && (method === 'new_instructor_approved' || (a.otp_challenge_id && a.otp_verified_at))
    && (!email || a.activation_email === email);
  ctx.r.check(`${tag} instructor_account_activations 欄位齊全（${method}、active、時間與驗證碼識別都有）`, complete, JSON.stringify(a || {}).slice(0, 260));
  return a;
}

// ── 簽約 v2：閱讀 → 同意頁 → 驗證與簽署（勾已讀、簽約 OTP、手寫簽名、確認簽署）
export async function readDocuments(page) {
  const finish = page.getByRole('button', { name: '我已完整看完且清楚這份文件的所有內容' });
  if (await visible(finish, 25000)) {
    await pollUntil(() => finish.isEnabled(), { timeoutMs: 15000 });
    await finish.click();
  }
  const next = page.getByTestId('read-next');
  await next.waitFor({ state: 'visible', timeout: 25000 });
  await next.click();
  await page.getByTestId('consent-page').waitFor({ state: 'visible', timeout: 15000 });
}

export async function agreeConsent(page) {
  await page.getByTestId('consent-checkbox').check();
  await page.getByTestId('consent-agree').click();
  await page.getByTestId('sign-phase').waitFor({ state: 'visible', timeout: 15000 });
}

export async function verifyContractOtp(ctx, session, user, tag, { wrongFirst = false, shots = false } = {}) {
  const { page } = session;
  const r = ctx.r;
  await page.getByTestId('read-ack-checkbox').check();
  await page.getByTestId('send-otp').click();
  const notice = await openOtpDialogAndWaitSent(page);
  const otp = latestOtp(ctx.api, user.id, 'contract_sign');
  r.check(`${tag} 簽約驗證碼寄到已確認信箱`, Boolean(otp?.code) && notice.includes('驗證碼已寄到'), notice);
  if (shots) await dualShot(ctx, session, `${tag}-contract-otp`, { fullPage: false });
  if (wrongFirst) {
    await typeOtp(page, otp.code === '111111' ? '222222' : '111111');
    r.check(`${tag} 簽約錯誤驗證碼被拒並顯示剩餘次數`, await visible(page.getByText(/驗證碼不正確，還可以再試 4 次/), 8000));
  }
  await typeOtp(page, otp.code);
  r.check(`${tag} 簽約驗證碼通過「本人身分已驗證」`, await visible(page.getByTestId('contract-otp-card').getByText('本人身分已驗證'), 10000));
  return otp;
}

export async function drawSignature(page) {
  await page.getByTestId('open-signature').click();
  const canvas = page.locator('canvas.cursor-crosshair');
  await canvas.waitFor({ state: 'visible' });
  await sleep(150);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 24; i += 1) {
    await page.mouse.move(box.x + box.width * (0.2 + 0.025 * i), box.y + box.height * (0.6 - 0.25 * Math.sin(i / 3)), { steps: 2 });
  }
  await page.mouse.up();
  await page.getByRole('button', { name: '確認簽名' }).click();
  await page.getByText('已簽名', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
}

export async function submitContract(page, { doubleClick = false } = {}) {
  const submit = page.getByTestId('submit-contract');
  await pollUntil(() => submit.isEnabled(), { timeoutMs: 8000 });
  if (doubleClick) await submit.dblclick();
  else await submit.click();
}

export async function signContractV2(ctx, session, user, tag, { wrongOtpFirst = false, shots = false } = {}) {
  const { page } = session;
  const r = ctx.r;
  await goto(ctx, session, '/contract');
  await readDocuments(page);
  r.check(`${tag} 閱讀完文件後進到「選擇簽約方式」同意頁（含個資告知）`,
    await page.getByTestId('privacy-notice').isVisible() && await page.getByText('選擇簽約方式').first().isVisible());
  if (shots) await dualShot(ctx, session, `${tag}-consent`);
  await agreeConsent(page);
  const roleMissing = await page.getByText('尚無法簽署：您的講師等級尚未設定').isVisible();
  r.check(`${tag} 簽署頁沒有「講師等級尚未設定」`, !roleMissing);
  await verifyContractOtp(ctx, session, user, tag, { wrongFirst: wrongOtpFirst, shots });
  await drawSignature(page);
  r.check(`${tag} 確認簽署前顯示最後確認文字`, await page.getByTestId('final-confirm').isVisible());
  await submitContract(page);
  const done = await visible(page.getByTestId('signing-complete'), 25000);
  const copyNote = done ? await page.getByTestId('copy-email-note').innerText() : '';
  r.check(`${tag} 畫面顯示「簽約完成！」、伺服器簽署時間與副本通知信箱`, done
    && /\d{4}/.test(await page.getByTestId('signed-at').innerText().catch(() => '')) && copyNote.includes('***@'),
  done ? copyNote.slice(0, 80) : (await page.getByTestId('submit-error').innerText().catch(() => '')));
  if (shots && done) await dualShot(ctx, session, `${tag}-signed`);
  return { done };
}

// 簽完約後資料庫逐表核對：instructor_contracts、contract_signing_evidence、contract_consent_records、email_delivery_log、檔案雜湊
export async function verifyContractEvidence(ctx, user, tag) {
  const r = ctx.r;
  const { api } = ctx;
  const c = api.json(`SELECT row_to_json(c) FROM public.instructor_contracts c WHERE c.user_id = :'uid' AND c.status = 'signed' ORDER BY c.created_at DESC LIMIT 1`, { uid: user.id });
  r.check(`${tag} instructor_contracts：status='signed'，bound_email／consent_id／otp／雜湊／evidence_id／instructor_id 齊全`,
    c && c.bound_email && c.consent_id && c.otp_challenge_id && c.otp_verified_at && c.evidence_id && c.instructor_id
    && c.document_sha256 && c.signed_pdf_sha256 && c.verify_method,
  JSON.stringify(c ? { bound_email: c.bound_email, evidence_id: c.evidence_id, verify_method: c.verify_method } : {}));
  if (!c) return null;
  const e = api.json(`SELECT row_to_json(e) FROM public.contract_signing_evidence e WHERE e.id = :'id'`, { id: c.evidence_id });
  r.check(`${tag} contract_signing_evidence：本筆雜湊、前一筆雜湊、IP、UA、OTP 驗證時間、同意時間都在`,
    e && /^[0-9a-f]{64}$/.test(e.evidence_sha256) && e.ip_address && e.user_agent && e.otp_verified_at && e.consent_at
    && e.bound_email === c.bound_email && e.contract_id === c.id,
  JSON.stringify(e ? { ip: e.ip_address, ua: String(e.user_agent).slice(0, 30), prev: String(e.previous_evidence_sha256).slice(0, 8) } : {}));
  const consent = api.json(`SELECT row_to_json(x) FROM public.contract_consent_records x WHERE x.id = :'id'`, { id: c.consent_id });
  r.check(`${tag} contract_consent_records：agree_electronic，同意全文與個資告知全文（privacy_notice_text）都有存`,
    consent && consent.decision === 'agree_electronic' && String(consent.consent_text).length > 50
    && String(consent.privacy_notice_text || '').length > 50 && consent.ip_address && consent.user_agent,
  consent ? `consent=${String(consent.consent_text).length}字 privacy=${String(consent.privacy_notice_text || '').length}字` : '');
  // 檔案雜湊：伺服器記的成品雜湊＝storage 裡真的那份檔案
  const pdfPath = c.signed_pdf_paths?.contract;
  try {
    const bytes = readFileSync(ctx.stack.gateway.filePath('contract-documents', pdfPath));
    const pdf = await PDFDocument.load(bytes);
    const xobjects = pdf.getPages()[0].node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    r.check(`${tag} 簽署 PDF 的 SHA-256＝證據記錄，且第 1 頁嵌入簽名與欄位影像`,
      sha256(bytes) === c.signed_pdf_sha256?.contract && e?.signed_pdf_sha256?.contract === c.signed_pdf_sha256?.contract && (xobjects ? xobjects.keys().length : 0) >= 6,
      `${bytes.length} bytes`);
  } catch (error) {
    r.check(`${tag} 簽署 PDF 的 SHA-256＝證據記錄，且第 1 頁嵌入簽名與欄位影像`, false, error.message);
  }
  // 寄送紀錄：簽約 OTP 信不含碼、簽署完成通知已排入
  const logs = api.json(`SELECT coalesce(json_agg(row_to_json(l) ORDER BY l.requested_at), '[]') FROM public.email_delivery_log l WHERE l.related_user_id = :'uid'`, { uid: user.id });
  const codes = api.json(`SELECT coalesce(json_agg((regexp_match(r.body->>'text', '驗證碼：([0-9]{6})'))[1]), '[]')
                            FROM public.email_delivery_log l JOIN net._e2e_http_requests r ON r.id = l.net_request_id
                           WHERE l.related_user_id = :'uid' AND l.kind LIKE 'otp_%'`, { uid: user.id }).filter(Boolean);
  const otpLogs = logs.filter((l) => l.kind.startsWith('otp_'));
  const leak = otpLogs.some((l) => codes.some((code) => JSON.stringify(l).includes(code)));
  const copy = logs.find((l) => l.kind === 'contract_signed_copy' && l.related_contract_id === c.id);
  r.check(`${tag} email_delivery_log：OTP 信有紀錄但不含驗證碼；簽署完成通知已排入（queued，寄到 bound_email）`,
    otpLogs.length > 0 && !leak && copy && copy.status === 'queued' && copy.to_email === c.bound_email,
  `otp 紀錄 ${otpLogs.length} 筆、洩漏=${leak}、副本=${copy?.status}`);
  const copyReq = api.json(`SELECT r.body FROM net._e2e_http_requests r JOIN public.email_delivery_log l ON l.net_request_id = r.id WHERE l.id = :'id'`, { id: copy?.id || '00000000-0000-0000-0000-000000000000' });
  r.check(`${tag} 簽署完成通知信內含 /contract/view/<契約編號> 連結`, JSON.stringify(copyReq || {}).includes(`/contract/view/${c.id}`));
  return c;
}

// ── 後台：確認 Email（講師資料總覽 → 該列「確認 Email」→ 填 Email＋註記）
export async function adminConfirmEmailUI(ctx, adminSession, instName, email, { tryEmptyNote = false, shots = false, tag = 'ADM' } = {}) {
  const { page } = adminSession;
  const r = ctx.r;
  await goto(ctx, adminSession, '/admin/instructors');
  await page.getByPlaceholder('搜尋姓名、Email 或手機號碼⋯⋯').fill(instName);
  const row = page.locator('tbody tr', { hasText: instName }).first();
  await row.waitFor({ state: 'visible', timeout: 15000 });
  await row.getByTestId('confirm-email-button').click();
  const modal = page.getByTestId('confirm-email-modal');
  await modal.waitFor({ state: 'visible' });
  await page.locator('#confirm-email-input').fill(email);
  if (tryEmptyNote) {
    await page.locator('#confirm-email-note').fill('');
    await page.getByTestId('confirm-email-submit').click();
    r.check(`${tag} 確認 Email 時註記必填（空白送出被擋）`, await visible(modal.getByText('請註記是怎麼和老師確認的'), 5000));
  }
  await page.locator('#confirm-email-note').fill('10/20 透過 LINE 與老師本人確認（E2E）');
  if (shots) await dualShot(ctx, adminSession, `${tag}-confirm-email-modal`, { fullPage: false });
  await page.getByTestId('confirm-email-submit').click();
  const ok = await visible(page.getByText(`已登錄 ${instName} 的已確認 Email`), 10000);
  r.check(`${tag} 管理員用畫面確認 Email 成功`, ok);
  return ok;
}

export async function adminApproveUI(ctx, fullName, tag) {
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    await goto(ctx, admin, '/admin/teachers');
    const card = admin.page.locator('.bh-card', { hasText: fullName }).filter({ has: admin.page.getByRole('button', { name: /核准新講師/ }) });
    await card.first().waitFor({ state: 'visible', timeout: 15000 });
    const button = card.first().getByRole('button', { name: /核准新講師/ });
    await pollUntil(() => button.isEnabled(), { timeoutMs: 8000 });
    await dualShot(ctx, admin, `${tag}-admin-approve`);
    await button.click();
    await sleep(500);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message.split('\n')[0] };
  } finally {
    await admin.context.close();
  }
}

export { openAs, shot, measureOverflow, fieldControl, sleep };
