// 規格 §3 上線前必測（docs/specs/2026-10-20-claim-activation-esign.md）：
// OTP 過期、重複使用、錯 5 次鎖、重寄冷卻（含接續輸入）、冒用別人的 challenge、簽署中斷、簽署途中契約改版、
// 重複送出（連點＋重放）、不同意電子簽約、未設定寄信金鑰、簽後文件遭修改（檔案被換／證據被改）。
// 「錯誤認領」在 scenarios.mjs 的 G。最後一步會竄改全域證據鏈，所以 SEC 一定排在最後。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latestOtp, skipOtpCooldown, setEmailConfigured, makeActiveTeacherViaRest, makeReadyPendingTeacher, signViaRest, makePdf, sha256,
} from './lib/fixtures.mjs';
import {
  roleOf, activationOf, pollUntil, visible, goto, dualShot, openAs, sleep, typeOtp, openOtpDialogAndWaitSent,
  readDocuments, agreeConsent, verifyContractOtp, drawSignature, submitContract, waitProfileLoaded,
} from './lib/flows.mjs';
import { openEvidencePanel } from './scenarios-admin.mjs';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MINOR_SHOTS_DIR = path.join(appDir, 'docs/verification/2026-10-22-esign-minor');

const challengeRow = (ctx, id) => ctx.api.json(`SELECT row_to_json(c) FROM private.email_otp_challenges c WHERE c.id = :'id'`, { id });
const contractsOf = (ctx, uid) => ctx.api.json(`SELECT coalesce(json_agg(row_to_json(c) ORDER BY c.created_at), '[]') FROM public.instructor_contracts c WHERE c.user_id = :'uid'`, { uid });
const evidenceCount = (ctx, uid) => Number(ctx.api.sql(`SELECT count(*) FROM public.contract_signing_evidence WHERE user_id = :'uid'`, { uid }));

async function openActivationDialog(ctx, user) {
  const s = await openAs(ctx.browser, ctx.stack, user);
  await goto(ctx, s, '/profile');
  await waitProfileLoaded(s.page);
  await s.page.getByTestId('activation-button').click();
  const notice = await openOtpDialogAndWaitSent(s.page);
  return { s, notice };
}

const otpNotice = (page) => page.getByTestId('otp-notice').innerText().catch(() => '');

// ═══ SEC-1 OTP 過期（超級使用者把 expires_at 改成過去）＋重新寄送後成功；同一組碼重複使用 ═══
export async function secOtpExpiredAndReuse(ctx) {
  const r = ctx.r;
  const user = await makeReadyPendingTeacher(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-expire' });
  const { s } = await openActivationDialog(ctx, user);
  try {
    const otp = latestOtp(ctx.api, user.id, 'account_activation');
    ctx.api.sql(`UPDATE private.email_otp_challenges SET expires_at = now() - interval '1 minute' WHERE id = :'id'`, { id: otp.challenge_id });
    await typeOtp(s.page, otp.code);
    r.check('SEC OTP 過期：輸入正確碼也顯示「驗證碼已過期」，帳號不啟用',
      await pollUntil(async () => (await otpNotice(s.page)).includes('驗證碼已過期'), { timeoutMs: 8000 }) && roleOf(ctx, user.id) === 'pending', await otpNotice(s.page));
    r.check('SEC OTP 過期後輸入框停用（這組已失效）', await s.page.locator('#email-otp-code').isDisabled());
    await dualShot(ctx, s, 'SEC-01-otp-expired', { fullPage: false });
    await s.page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    skipOtpCooldown(ctx.api, user.id, 'account_activation'); // 模擬等了 61 秒
    await s.page.getByTestId('activation-button').click();
    await openOtpDialogAndWaitSent(s.page);
    const fresh = latestOtp(ctx.api, user.id, 'account_activation');
    r.check('SEC 重新寄送後是新的一組碼，舊的作廢', fresh.challenge_id !== otp.challenge_id && Boolean(challengeRow(ctx, otp.challenge_id)?.superseded_at));
    await typeOtp(s.page, fresh.code);
    await s.page.waitForURL(/\/courses$/, { timeout: 15000 }).catch(() => {});
    r.check('SEC 新碼驗證成功 → 啟用', roleOf(ctx, user.id) === 'teacher' && activationOf(ctx, user.id)?.status === 'active');
    const reuse = await ctx.api.rpc(user.token, 'verify_email_otp', { p_challenge_id: fresh.challenge_id, p_code: fresh.code });
    r.check('SEC OTP 重複使用：同一組啟用碼再驗一次回 used', reuse.data?.status === 'used', JSON.stringify(reuse.data));
    const expiredAgain = await ctx.api.rpc(user.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
    r.check('SEC 被新碼取代的舊碼再驗回 superseded', expiredAgain.data?.status === 'superseded', JSON.stringify(expiredAgain.data));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-1: ${e}`));
    await s.context.close();
  }
}

// ═══ SEC-2 錯 5 次鎖 ═══
export async function secOtpLocked(ctx) {
  const r = ctx.r;
  const user = await makeReadyPendingTeacher(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-lock' });
  const { s } = await openActivationDialog(ctx, user);
  try {
    const otp = latestOtp(ctx.api, user.id, 'account_activation');
    const wrong = otp.code === '000000' ? '999999' : '000000';
    const remainingSeen = [];
    for (let i = 1; i <= 4; i += 1) {
      await typeOtp(s.page, wrong);
      const text = await pollUntil(async () => {
        const t = await otpNotice(s.page);
        return t.includes(`還可以再試 ${5 - i} 次`) ? t : null;
      }, { timeoutMs: 8000 });
      remainingSeen.push(text ? 5 - i : 'x');
    }
    r.check('SEC 錯 1～4 次各顯示「還可以再試 4／3／2／1 次」', remainingSeen.join(',') === '4,3,2,1', remainingSeen.join(','));
    await typeOtp(s.page, wrong);
    r.check('SEC 第 5 次錯 → 「錯誤次數過多，這組已鎖定」，輸入框停用',
      await pollUntil(async () => (await otpNotice(s.page)).includes('錯誤次數過多'), { timeoutMs: 8000 }) && await s.page.locator('#email-otp-code').isDisabled(), await otpNotice(s.page));
    await dualShot(ctx, s, 'SEC-02-otp-locked', { fullPage: false });
    const right = await ctx.api.rpc(user.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
    r.check('SEC 鎖定後就算輸入正確碼也回 locked，帳號不啟用', right.data?.status === 'locked' && roleOf(ctx, user.id) === 'pending'
      && challengeRow(ctx, otp.challenge_id)?.attempts === 5, JSON.stringify(right.data));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-2: ${e}`));
    await s.context.close();
  }
}

// ═══ SEC-3 重寄冷卻：60 秒內再要碼回 cooldown，並帶回進行中的 challenge，可接續輸入剛寄出的碼 ═══
export async function secOtpCooldown(ctx) {
  const r = ctx.r;
  const user = await makeReadyPendingTeacher(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-cooldown' });
  const { s } = await openActivationDialog(ctx, user);
  try {
    const first = latestOtp(ctx.api, user.id, 'account_activation');
    r.check('SEC 剛寄出時「重新寄送」按鈕在倒數、不能按', await s.page.getByTestId('otp-resend').isDisabled()
      && /重新寄送（\d+ 秒後）/.test(await s.page.getByTestId('otp-resend').innerText()));
    await s.page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    const rest = await ctx.api.rpc(user.token, 'request_email_otp', { p_purpose: 'account_activation' });
    r.check('SEC 60 秒內再要碼：REST 回 cooldown＋同一個 challenge_id，沒有多寄一封',
      rest.data?.status === 'cooldown' && rest.data.challenge_id === first.challenge_id && rest.data.retry_after_seconds > 0
      && latestOtp(ctx.api, user.id, 'account_activation').challenge_id === first.challenge_id, JSON.stringify(rest.data));
    await s.page.getByTestId('activation-button').click();
    const notice = await openOtpDialogAndWaitSent(s.page);
    r.check('SEC 關掉再打開視窗：顯示「剛剛已經寄出驗證碼…秒後才能重新寄送」，輸入框可接續輸入',
      notice.includes('剛剛已經寄出驗證碼') && await s.page.locator('#email-otp-code').isEnabled(), notice);
    await dualShot(ctx, s, 'SEC-03-otp-cooldown', { fullPage: false });
    await typeOtp(s.page, first.code);
    await s.page.waitForURL(/\/courses$/, { timeout: 15000 }).catch(() => {});
    r.check('SEC 冷卻中輸入第一封信的碼 → 啟用成功', roleOf(ctx, user.id) === 'teacher');
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-3: ${e}`));
    await s.context.close();
  }
}

// ═══ SEC-4 冒用別人的 challenge_id ═══
export async function secForeignChallenge(ctx) {
  const r = ctx.r;
  const victim = await makeReadyPendingTeacher(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-victim' });
  const attacker = await makeReadyPendingTeacher(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-attacker' });
  await ctx.api.rpc(victim.token, 'request_email_otp', { p_purpose: 'account_activation' });
  const otp = latestOtp(ctx.api, victim.id, 'account_activation');
  const stolen = await ctx.api.rpc(attacker.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
  r.check('SEC 拿別人的 challenge_id＋正確碼驗證 → 回 invalid（當作不存在），攻擊者不啟用',
    stolen.data?.status === 'invalid' && stolen.data.attempts_remaining === 0 && roleOf(ctx, attacker.id) === 'pending', JSON.stringify(stolen.data));
  r.check('SEC 冒用不會累計本人那組的錯誤次數、也不會用掉它', challengeRow(ctx, otp.challenge_id)?.attempts === 0 && !challengeRow(ctx, otp.challenge_id)?.verified_at);
  const own = await ctx.api.rpc(victim.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
  r.check('SEC 本人隨後仍可用自己的碼啟用', own.data?.activated === true && roleOf(ctx, victim.id) === 'teacher', JSON.stringify(own.data));
}

// ═══ SEC-5 不同意電子簽約 → 紙本畫面、通知管理員、沒有簽約紀錄 ═══
export async function secDecline(ctx) {
  const r = ctx.r;
  const user = await makeActiveTeacherViaRest(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-decline', fullName: '紙本簽約老師' });
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/contract');
    await readDocuments(s.page);
    await s.page.getByTestId('consent-decline').click();
    await s.page.getByTestId('decline-dialog').waitFor({ state: 'visible' });
    await dualShot(ctx, s, 'SEC-04-decline-dialog', { fullPage: false });
    await s.page.getByTestId('decline-confirm').click();
    r.check('SEC 不同意 → 顯示「已記錄：改以紙本簽約」畫面', await visible(s.page.getByTestId('paper-flow'), 10000) && await s.page.getByText('已記錄：改以紙本簽約').isVisible());
    await dualShot(ctx, s, 'SEC-05-paper-flow');
    const consent = ctx.api.json(`SELECT row_to_json(x) FROM public.contract_consent_records x WHERE x.user_id = :'uid' ORDER BY created_at DESC LIMIT 1`, { uid: user.id });
    r.check('SEC 資料庫記錄 decline_electronic（含不同意文案與個資告知全文、IP、UA）',
      consent?.decision === 'decline_electronic' && consent.consent_text_version === 'esign-decline-paper-v1' && String(consent.privacy_notice_text).length > 50 && consent.ip_address);
    // 2026-10-23 資安審查建議 3：通知內文不帶講師自填的姓名，改用 Google 登入信箱辨識
    const notified = ctx.api.json(`SELECT coalesce(json_agg(row_to_json(n)), '[]') FROM public.notifications n WHERE n.user_id = :'admin' AND n.title = '講師選擇改以紙本簽約' AND n.body LIKE :'who'`,
      { admin: ctx.base.admin.id, who: `%${user.email.toLowerCase()}%` });
    r.check('SEC 管理員收到「講師選擇改以紙本簽約」通知（以登入信箱辨識、不含講師自填的姓名）',
      notified.length === 1 && !notified[0].body.includes('紙本簽約老師'), notified[0]?.body?.slice(0, 80));
    r.check('SEC 沒有任何簽約紀錄', contractsOf(ctx, user.id).length === 0 && evidenceCount(ctx, user.id) === 0);
    await goto(ctx, s, '/profile');
    r.check('SEC 個人資料頁顯示「紙本簽約處理中」', await visible(s.page.getByTestId('paper-pending'), 10000));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-5: ${e}`));
    await s.context.close();
  }
}

// ═══ SEC-6 簽署中斷：簽約 OTP 驗證後關頁再回來，能重新完成、不留半套紀錄 ═══
export async function secInterrupted(ctx) {
  const r = ctx.r;
  const user = await makeActiveTeacherViaRest(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-interrupt' });
  let s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/contract');
    await readDocuments(s.page);
    await agreeConsent(s.page);
    const firstOtp = await verifyContractOtp(ctx, s, user, 'SEC 中斷前');
    await s.page.close(); // 關頁
    r.check('SEC 驗證後關頁：資料庫沒有任何簽約或證據（不留半套）', contractsOf(ctx, user.id).length === 0 && evidenceCount(ctx, user.id) === 0
      && Boolean(challengeRow(ctx, firstOtp.challenge_id)?.verified_at) && !challengeRow(ctx, firstOtp.challenge_id)?.consumed_at);
    const page = await s.context.newPage();
    s = { ...s, page };
    page.on('dialog', (d) => d.accept());
    await goto(ctx, s, '/contract');
    r.check('SEC 重新打開 /contract 從閱讀文件開始', await visible(page.getByTestId('read-phase'), 15000));
    await readDocuments(page);
    await agreeConsent(page);
    await page.getByTestId('read-ack-checkbox').check();
    await page.getByTestId('send-otp').click();
    const notice = await openOtpDialogAndWaitSent(page);
    const cooled = notice.includes('剛剛已經寄出驗證碼') && !(await page.locator('#email-otp-code').isVisible());
    r.check('SEC 60 秒內回來再要簽約碼：顯示冷卻提示（已驗證過的碼不會再給輸入）', cooled, notice);
    if (cooled) {
      ctx.known('SEC 簽署中斷後 60 秒內要等冷卻', 'SEC［UX 小缺口］簽約 OTP 驗證通過後關頁再回來（60 秒內），重新要碼會回 cooldown，但冷卻回覆只帶「未驗證」的碼（supabase/migrations/20261020100000_claim_activation_esign_evidence.sql:1419-1437），剛驗證過的那組前端也已遺失，老師只能等倒數結束再按「重新寄送」。資料面正確（不會留下半套紀錄）。');
    }
    await page.getByRole('dialog').getByRole('button', { name: '取消' }).click();
    skipOtpCooldown(ctx.api, user.id, 'contract_sign'); // 模擬等了 61 秒
    await page.getByTestId('send-otp').click();
    await openOtpDialogAndWaitSent(page);
    const second = latestOtp(ctx.api, user.id, 'contract_sign');
    await typeOtp(page, second.code);
    await page.getByTestId('contract-otp-card').getByText('本人身分已驗證').waitFor({ state: 'visible', timeout: 10000 });
    await drawSignature(page);
    await submitContract(page);
    const done = await visible(page.getByTestId('signing-complete'), 25000);
    const contracts = contractsOf(ctx, user.id);
    const consents = Number(ctx.api.sql(`SELECT count(*) FROM public.contract_consent_records WHERE user_id = :'uid'`, { uid: user.id }));
    r.check('SEC 回來後重新完成簽署：剛好 1 份契約＋1 筆證據，用的是第二組碼，第一組被作廢不是被消耗',
      done && contracts.length === 1 && contracts[0].status === 'signed' && evidenceCount(ctx, user.id) === 1
      && contracts[0].otp_challenge_id === second.challenge_id && Boolean(challengeRow(ctx, firstOtp.challenge_id)?.superseded_at)
      && !challengeRow(ctx, firstOtp.challenge_id)?.consumed_at && consents === 2, `contracts=${contracts.length} consents=${consents}`);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-6: ${e}`));
    await s.context.close();
  }
}

// ═══ SEC-7 簽署途中契約改版：老師在簽名步驟，管理員用畫面上傳新版 → 送出顯示改版訊息 → 重新閱讀後簽成功 ═══
export async function secVersionChanged(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const user = await makeActiveTeacherViaRest(ctx.stack, api, ctx.base.admin, { emailPrefix: 'sec-version' });
  const s = await openAs(ctx.browser, ctx.stack, user);
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    await goto(ctx, s, '/contract');
    await readDocuments(s.page);
    await agreeConsent(s.page);
    await verifyContractOtp(ctx, s, user, 'SEC 改版前');
    await drawSignature(s.page);
    const before = Number(api.sql(`SELECT max(version) FROM public.contract_documents WHERE doc_type = 'contract'`));

    // 管理員在合約管理頁上傳新版（畫面操作；確認視窗與成功提示自動按確定）
    await goto(ctx, admin, '/admin/contracts');
    const card = admin.page.locator('div.bh-card.p-5').filter({ has: admin.page.locator('h3', { hasText: '講師合約書' }) }).first();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    const newPdf = await makePdf('E2E Instructor Contract v2', ['Name:', 'Level:', 'ID number:', 'Address:', 'Phone:', '', 'Signature:', 'v2 clause']);
    await card.locator('input[type=file]').setInputFiles({ name: 'contract-v2.pdf', mimeType: 'application/pdf', buffer: newPdf });
    const uploaded = await pollUntil(() => Number(api.sql(`SELECT max(version) FROM public.contract_documents WHERE doc_type = 'contract'`)) === before + 1, { timeoutMs: 15000 });
    await pollUntil(() => admin.dialogs.some((d) => d.message.includes('上傳成功')), { timeoutMs: 10000 });
    const v2 = api.json(`SELECT row_to_json(d) FROM public.contract_documents d WHERE doc_type = 'contract' AND is_active ORDER BY version DESC LIMIT 1`);
    r.check('SEC 管理員用畫面上傳新版：新版啟用、舊版停用、範本雜湊在上傳時登錄', uploaded && v2?.version === before + 1 && v2.content_sha256 === sha256(newPdf)
      && api.sql(`SELECT count(*) FROM public.contract_documents WHERE doc_type = 'contract' AND is_active`) === '1', `v${v2?.version}`);
    // 新版的欄位座標（後台「定位欄位」是拖拉編輯器，這裡以管理員 REST 照抄舊版座標代替）
    const copy = api.json(`SELECT coalesce(json_agg(json_build_object('doc_type', doc_type, 'doc_version', :'v'::int, 'field_type', field_type, 'page_number', page_number,
                                   'x', x, 'y_from_top', y_from_top, 'width', width, 'height', height, 'font_size', font_size)), '[]')
                             FROM public.contract_field_positions WHERE doc_type = 'contract' AND doc_version = :'old'::int`, { v: String(v2.version), old: String(before) });
    await api.rest(ctx.base.admin.token, 'POST', 'contract_field_positions', { body: copy, prefer: 'return=minimal' });

    await submitContract(s.page);
    const notice = await pollUntil(async () => {
      const t = await s.page.getByTestId('flow-notice').innerText().catch(() => '');
      return t.includes('契約剛更新版本') ? t : null;
    }, { timeoutMs: 20000 });
    r.check('SEC 送出時顯示「契約剛更新版本，請重新閱讀後再簽」並回到閱讀文件', Boolean(notice) && await s.page.getByTestId('read-phase').isVisible(), notice || '');
    r.check('SEC 改版被擋的那次沒有寫入任何契約或證據', contractsOf(ctx, user.id).length === 0 && evidenceCount(ctx, user.id) === 0);
    await dualShot(ctx, s, 'SEC-06-version-changed');
    await readDocuments(s.page);
    await agreeConsent(s.page);
    await s.page.getByTestId('read-ack-checkbox').check();
    if (await s.page.getByTestId('send-otp').isVisible()) await verifyContractOtp(ctx, s, user, 'SEC 改版後');
    if (await s.page.getByTestId('open-signature').isVisible()) await drawSignature(s.page);
    await submitContract(s.page);
    const done = await visible(s.page.getByTestId('signing-complete'), 25000);
    const signed = contractsOf(ctx, user.id).find((c) => c.status === 'signed');
    r.check('SEC 重新閱讀後簽成功，契約記錄新版版本與新版範本雜湊', done && signed?.doc_versions?.contract === v2.version
      && signed.document_sha256?.contract === v2.content_sha256, JSON.stringify(signed?.doc_versions || {}));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-7: ${e}`), ...admin.consoleErrors.map((e) => `SEC-7 admin: ${e}`));
    await s.context.close();
    await admin.context.close();
  }
}

// ═══ SEC-8 重複送出：連點「確認簽署」只成立一份；用同一個 challenge 重放 RPC 被拒；重新簽約後版本歷史 ═══
export async function secDoubleSubmit(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const user = await makeActiveTeacherViaRest(ctx.stack, api, ctx.base.admin, { emailPrefix: 'sec-double' });
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/contract');
    await readDocuments(s.page);
    await agreeConsent(s.page);
    const otp = await verifyContractOtp(ctx, s, user, 'SEC 連點');
    await drawSignature(s.page);
    const mark = ctx.stack.gateway.requests.length;
    await submitContract(s.page, { doubleClick: true });
    const done = await visible(s.page.getByTestId('signing-complete'), 25000);
    const calls = ctx.stack.gateway.requests.slice(mark).filter((x) => x.path === '/rest/v1/rpc/submit_my_contract').length;
    const contracts = contractsOf(ctx, user.id);
    r.check('SEC 連點兩下「確認簽署」：只送出 1 次、只成立 1 份契約與 1 筆證據', done && calls === 1 && contracts.length === 1 && evidenceCount(ctx, user.id) === 1, `RPC 呼叫 ${calls} 次`);
    const c = contracts[0];
    const replay = await api.rpc(user.token, 'submit_my_contract', {
      p_filled_name: c.filled_name, p_filled_instructor_role: c.filled_instructor_role, p_filled_id_number: c.filled_id_number,
      p_filled_address: c.filled_address, p_filled_phone: c.filled_phone, p_signature_path: c.signature_path,
      p_signed_pdf_paths: c.signed_pdf_paths, p_doc_versions: c.doc_versions, p_user_agent: 'replay',
      p_otp_challenge_id: otp.challenge_id, p_consent_id: c.consent_id, p_document_sha256: c.document_sha256, p_signed_pdf_sha256: c.signed_pdf_sha256,
    });
    r.check('SEC 用同一個 challenge 重放 submit_my_contract → OTP_ALREADY_USED，沒有多一份', String(replay.data?.message).includes('OTP_ALREADY_USED')
      && contractsOf(ctx, user.id).length === 1, `HTTP ${replay.status} ${replay.data?.message}`);
    const reverify = await api.rpc(user.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
    r.check('SEC 已用掉的簽約碼再驗一次回 used', reverify.data?.status === 'used', JSON.stringify(reverify.data));

    // 重新簽約：舊約作廢（voided＋superseded_by），契約查閱頁列出所有版本
    skipOtpCooldown(api, user.id, 'contract_sign');
    const second = await signViaRest(ctx.stack, api, user);
    const all = contractsOf(ctx, user.id);
    r.check('SEC 重新簽約：舊約改 voided 並指向新約，新約 signed', all.length === 2 && all[0].status === 'voided' && all[0].superseded_by === second.contract_id
      && all[0].voided_at && all[1].status === 'signed');
    await goto(ctx, s, `/contract/view/${second.contract_id}`);
    const versions = s.page.getByTestId('contract-versions');
    r.check('SEC 契約查閱頁列出所有簽署版本（含已作廢）', await visible(versions, 15000) && (await versions.locator('li').count()) >= 2);
    await goto(ctx, s, `/contract/view/${all[0].id}`);
    r.check('SEC 開舊版契約顯示「已作廢」橫幅', await visible(s.page.getByTestId('voided-banner'), 15000));
    await dualShot(ctx, s, 'SEC-07-contract-history');
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-8: ${e}`));
    await s.context.close();
  }
}

// ═══ SEC-9 未設定寄信金鑰：畫面顯示寄信未設定，不會當掉；補回後恢復 ═══
export async function secEmailNotConfigured(ctx) {
  const r = ctx.r;
  const user = await makeReadyPendingTeacher(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'sec-nomail' });
  setEmailConfigured(ctx.api, false);
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/profile');
    await waitProfileLoaded(s.page);
    await s.page.getByTestId('activation-button').click();
    const notice = await openOtpDialogAndWaitSent(s.page);
    r.check('SEC 拿掉 Vault resend_api_key → 視窗顯示「系統目前尚未設定寄信功能」，沒有輸入框',
      notice.includes('尚未設定寄信功能') && !(await s.page.locator('#email-otp-code').isVisible()), notice);
    const log = ctx.api.json(`SELECT row_to_json(l) FROM public.email_delivery_log l WHERE l.related_user_id = :'uid' ORDER BY requested_at DESC LIMIT 1`, { uid: user.id });
    r.check('SEC 寄送紀錄記成 not_configured、沒有產生驗證碼', log?.status === 'not_configured' && !latestOtp(ctx.api, user.id, 'account_activation'), JSON.stringify(log || {}).slice(0, 120));
    await dualShot(ctx, s, 'SEC-08-email-not-configured', { fullPage: false });
    await s.page.getByRole('dialog').getByRole('button', { name: '我知道了' }).click();
    r.check('SEC 關掉視窗後頁面正常（啟用卡還在、沒有前端錯誤）', await s.page.getByTestId('activation-card').isVisible()
      && !s.consoleErrors.some((e) => e.startsWith('pageerror')));
    setEmailConfigured(ctx.api, true);
    await s.page.getByTestId('activation-button').click();
    await openOtpDialogAndWaitSent(s.page);
    const otp = latestOtp(ctx.api, user.id, 'account_activation');
    await typeOtp(s.page, otp.code);
    await s.page.waitForURL(/\/courses$/, { timeout: 15000 }).catch(() => {});
    r.check('SEC 補回寄信設定後馬上可以寄碼並啟用（不受冷卻影響）', roleOf(ctx, user.id) === 'teacher');
  } finally {
    setEmailConfigured(ctx.api, true);
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `SEC-9: ${e}`));
    await s.context.close();
  }
}

// ═══ SEC-10（最後）簽後文件遭修改：storage 檔案被換 → 完整性驗證抓到；證據被改 → 證據鏈驗證抓到 ═══
export async function secTamper(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const signer = ctx.state.aTeacher?.contractId ? ctx.state.aTeacher : await (async () => {
    const t = await makeActiveTeacherViaRest(ctx.stack, api, ctx.base.admin, { emailPrefix: 'sec-tamper' });
    const signed = await signViaRest(ctx.stack, api, t);
    return { ...t, contractId: signed.contract_id, evidenceId: signed.evidence_id };
  })();
  const contract = api.json(`SELECT row_to_json(c) FROM public.instructor_contracts c WHERE id = :'id'`, { id: signer.contractId });
  const pdfPath = contract.signed_pdf_paths.contract;
  // 管理員也不能透過 Storage API 覆寫或刪除 signed/ 底下的檔案
  const overwrite = await api.request(ctx.base.admin.token, 'PUT', `/storage/v1/object/contract-documents/${pdfPath}`, { raw: Buffer.from('%PDF-1.4 overwrite'), headers: { 'content-type': 'application/pdf' } });
  const remove = await api.request(ctx.base.admin.token, 'DELETE', '/storage/v1/object/contract-documents', { body: { prefixes: [pdfPath] } });
  r.check('SEC 管理員用 Storage API 覆寫／刪除已簽 PDF 都被拒（signed/ 不可變）', overwrite.status === 403 && Array.isArray(remove.data) && remove.data.length === 0
    && api.sql(`SELECT count(*) FROM storage.objects WHERE bucket_id = 'contract-documents' AND name = :'n'`, { n: pdfPath }) === '1', `PUT ${overwrite.status} DELETE 刪了 ${remove.data?.length}`);

  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    let panel = await openEvidencePanel(ctx, admin, signer.id, signer.email);
    await panel.getByTestId('verify-chain').click();
    await panel.getByTestId('chain-result').waitFor({ state: 'visible', timeout: 15000 });
    r.check('SEC 竄改前證據鏈完整', (await panel.getByTestId('chain-result').innerText()).includes('證據鏈：完整'));

    // 竄改 1：有資料庫／主機權限的人直接換掉 storage 裡的檔案位元組（繞過 API）
    const file = ctx.stack.gateway.filePath('contract-documents', pdfPath);
    const original = readFileSync(file);
    writeFileSync(file, Buffer.concat([original, Buffer.from('\n% tampered by e2e\n')]));
    await panel.getByTestId('verify-files').click();
    const integrity = panel.getByTestId('integrity-result');
    await integrity.waitFor({ state: 'visible', timeout: 20000 });
    const integrityText = await integrity.innerText();
    r.check('SEC 換掉已簽 PDF 後「驗證檔案完整性」顯示不一致（指出已簽署成品）', integrityText.includes('檔案完整性：不一致') && integrityText.includes('不一致'), integrityText.slice(0, 120));

    // 竄改 2：超級使用者關掉 trigger 改一筆證據
    const evidenceId = contract.evidence_id;
    api.sql(`SET session_replication_role = replica;
             UPDATE public.contract_signing_evidence SET ip_address = '203.0.113.66' WHERE id = :'id';
             SET session_replication_role = origin;`, { id: evidenceId });
    panel = await openEvidencePanel(ctx, admin, signer.id, signer.email);
    await panel.getByTestId('verify-chain').click();
    const chain = panel.getByTestId('chain-result');
    await chain.waitFor({ state: 'visible', timeout: 15000 });
    const chainText = await chain.innerText();
    r.check('SEC 改一筆證據後「驗證證據鏈」顯示有斷裂，指出被改的那筆證據編號', chainText.includes('證據鏈：有斷裂') && chainText.includes(evidenceId), chainText.slice(0, 160));
    await dualShot(ctx, admin, 'SEC-09-tamper-detected');
    const rpc = await api.rpc(ctx.base.admin.token, 'admin_verify_contract_evidence_chain');
    r.check('SEC admin_verify_contract_evidence_chain 回 ok=false、first_broken_id＝被改的那筆', rpc.data?.ok === false && rpc.data.first_broken_id === evidenceId, JSON.stringify(rpc.data));
    const normalUpdate = ctx.stack.db.psqlSync(`UPDATE public.contract_signing_evidence SET ip_address = '1.1.1.1' WHERE id = :'id'`, { vars: { id: evidenceId }, expectFail: true });
    r.check('SEC 沒關 trigger 時，連超級使用者直接 UPDATE 證據也被擋（EVIDENCE_IMMUTABLE）', !normalUpdate.ok && normalUpdate.stderr.includes('EVIDENCE_IMMUTABLE'), normalUpdate.stderr.split('\n')[0]);
  } finally {
    ctx.consoleErrors.push(...admin.consoleErrors.map((e) => `SEC-10: ${e}`));
    await admin.context.close();
  }
}

// ═══ MINOR1 未滿 18 歲講師（法遵紅燈 R3，2026-10-22）：不能線上簽約，只能改紙本＋法定代理人 ═══
//   A. 真 PostgREST：成年時完成同意＋簽約 OTP，送出前出生日期被更正為未成年 → 被擋，OTP 沒被消耗、沒有半套紀錄
//   B. 畫面：未成年進簽約頁 → 同意頁換成未成年說明（沒有同意按鈕）→ 按「改以紙本簽約」→ 紙本簽約處理中
//   C. 畫面沒擋到（同意頁已打開才被更正出生日期）→ 按同意 → 伺服器擋下 → 畫面改顯示未成年說明
export async function minorPaperOnly(ctx) {
  const r = ctx.r;
  mkdirSync(MINOR_SHOTS_DIR, { recursive: true });
  const mctx = { ...ctx, shotsDir: MINOR_SHOTS_DIR };
  const minorBirth = ctx.api.sql(`SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date - interval '18 years' + interval '1 day')::date`);
  const setBirth = (uid, value) => ctx.api.sql(`UPDATE public.instructors SET birth_date = :'b' WHERE user_id = :'uid'`, { b: value, uid });

  // ── A ──
  const restUser = await makeActiveTeacherViaRest(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'minor-rest', fullName: '未成年REST講師' });
  const attempt = await signViaRest(ctx.stack, ctx.api, restUser, { allowFailure: true, beforeSubmit: () => setBirth(restUser.id, minorBirth) });
  r.check('MINOR REST：成年時完成同意＋簽約 OTP，送出前出生日期變未成年 → 400 MINOR_REQUIRES_GUARDIAN',
    attempt.failed && attempt.result.status === 400 && JSON.stringify(attempt.result.data).includes('MINOR_REQUIRES_GUARDIAN'), `${attempt.result.status} ${JSON.stringify(attempt.result.data)}`);
  const otpRow = challengeRow(ctx, attempt.otp.challenge_id);
  r.check('MINOR REST：被擋之後簽約 OTP 沒有被消耗（verified_at 在、consumed_at 空）', Boolean(otpRow?.verified_at) && !otpRow?.consumed_at, JSON.stringify(otpRow));
  r.check('MINOR REST：沒有半套紀錄（沒有契約、沒有證據）', contractsOf(ctx, restUser.id).length === 0 && evidenceCount(ctx, restUser.id) === 0);
  const restAgree = await ctx.api.rpc(restUser.token, 'record_contract_consent', { p_decision: 'agree_electronic', p_doc_versions: attempt.params.p_doc_versions, p_consent_text_version: 'esign-consent-v1' });
  r.check('MINOR REST：未成年再記錄 agree 同意也被擋（400 MINOR_REQUIRES_GUARDIAN）', restAgree.status === 400 && JSON.stringify(restAgree.data).includes('MINOR_REQUIRES_GUARDIAN'), JSON.stringify(restAgree.data));

  // ── B ──
  const ui = await makeActiveTeacherViaRest(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'minor-ui', fullName: '未成年畫面講師' });
  setBirth(ui.id, minorBirth);
  const s = await openAs(ctx.browser, ctx.stack, ui);
  try {
    await goto(ctx, s, '/contract');
    await readDocuments(s.page, { landing: 'minor-paper-page' });
    const page = s.page;
    const noConsentUi = (await page.getByTestId('consent-agree').count()) === 0 && (await page.getByTestId('consent-checkbox').count()) === 0
      && (await page.getByTestId('consent-decline').count()) === 0 && (await page.getByTestId('consent-page').count()) === 0;
    r.check('MINOR 畫面：未成年進簽約頁 → 同意頁換成未成年說明，沒有同意按鈕、勾選框與「不同意」按鈕', noConsentUi && await visible(page.getByTestId('minor-paper-button')));
    const minorText = await page.getByTestId('minor-paper-page').innerText();
    r.check('MINOR 畫面：說明含「未滿 18 歲」「法定代理人」「紙本簽約」「行政人員會和你聯繫」，且文件清單已代入、沒有殘留佔位符',
      ['請改以紙本簽約', '未滿 18 歲', '法定代理人', '一起簽名', '行政人員會和你聯繫', '第 '].every((t) => minorText.includes(t)) && !minorText.includes('{{'), minorText.slice(0, 200));
    r.check('MINOR 畫面：個資告知照常顯示', await visible(page.getByTestId('privacy-notice')));
    r.check('MINOR 畫面：進度列沒有「驗證與簽署」這一步（未成年沒有那條路）', (await page.getByText('驗證與簽署').count()) === 0);
    await dualShot(mctx, s, 'MINOR-01-minor-paper-page');
    await page.getByTestId('minor-paper-button').click();
    r.check('MINOR 畫面：按「改以紙本簽約」→ 進「已記錄：改以紙本簽約」（紙本簽約處理中）',
      await visible(page.getByTestId('paper-flow'), 10000) && await page.getByText('已記錄：改以紙本簽約').isVisible());
    const paperText = await page.getByTestId('paper-flow').innerText();
    r.check('MINOR 畫面：處理中畫面提醒和法定代理人一起簽，沒有「改變主意改用線上簽約」',
      paperText.includes('法定代理人') && !paperText.includes('改變主意') && (await page.getByRole('button', { name: /改變主意/ }).count()) === 0, paperText.slice(0, 200));
    await dualShot(mctx, s, 'MINOR-02-paper-flow');
    const consent = ctx.api.json(`SELECT row_to_json(x) FROM public.contract_consent_records x WHERE x.user_id = :'uid' ORDER BY created_at DESC LIMIT 1`, { uid: ui.id });
    r.check('MINOR 資料庫：記錄 decline_electronic、版本 esign-minor-paper-v1、存未成年說明全文＋個資告知＋IP',
      consent?.decision === 'decline_electronic' && consent.consent_text_version === 'esign-minor-paper-v1'
      && String(consent.consent_text).includes('法定代理人') && !String(consent.consent_text).includes('{{')
      && String(consent.privacy_notice_text).length > 50 && Boolean(consent.ip_address), JSON.stringify(consent).slice(0, 200));
    // 通知以 Google 登入信箱辨識（2026-10-23 起不帶講師自填的姓名）
    const notices = ctx.api.json(`SELECT coalesce(json_agg(n.title ORDER BY n.title), '[]') FROM public.notifications n WHERE n.user_id = :'admin' AND n.body LIKE :'who'`,
      { admin: ctx.base.admin.id, who: `%${ui.email.toLowerCase()}%` });
    r.check('MINOR 資料庫：管理員收到「講師選擇改以紙本簽約」與「未滿 18 歲的講師需由法定代理人一起簽紙本契約」兩則通知',
      notices.includes('講師選擇改以紙本簽約') && notices.includes('未滿 18 歲的講師需由法定代理人一起簽紙本契約'), JSON.stringify(notices));
    r.check('MINOR 資料庫：沒有任何簽約紀錄或證據', contractsOf(ctx, ui.id).length === 0 && evidenceCount(ctx, ui.id) === 0);
    await goto(ctx, s, '/profile');
    r.check('MINOR 個人資料頁顯示「紙本簽約處理中」', await visible(page.getByTestId('paper-pending'), 10000));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `MINOR-B: ${e}`));
    await s.context.close();
  }

  // ── C ──
  const stale = await makeActiveTeacherViaRest(ctx.stack, ctx.api, ctx.base.admin, { emailPrefix: 'minor-stale', fullName: '生日剛被更正的講師' });
  const sc = await openAs(ctx.browser, ctx.stack, stale);
  try {
    await goto(ctx, sc, '/contract');
    await readDocuments(sc.page); // 此時是成年：一般同意頁
    setBirth(stale.id, minorBirth); // 同意頁還開著，出生日期被行政更正為未成年
    await sc.page.getByTestId('consent-checkbox').check();
    await sc.page.getByTestId('consent-agree').click();
    r.check('MINOR 畫面沒擋到時：按「同意」被伺服器擋下 → 同意頁改成未成年說明（不是一串錯誤代碼）',
      await visible(sc.page.getByTestId('minor-paper-page'), 10000) && (await sc.page.getByTestId('consent-agree').count()) === 0
      && (await sc.page.getByTestId('consent-error').count()) === 0);
    await dualShot(mctx, sc, 'MINOR-03-server-blocked-flips-to-minor-page', { fullPage: false });
    const agreeRows = Number(ctx.api.sql(`SELECT count(*) FROM public.contract_consent_records WHERE user_id = :'uid' AND decision = 'agree_electronic'`, { uid: stale.id }));
    r.check('MINOR 資料庫：被擋的 agree 沒有留下任何同意紀錄', agreeRows === 0 && contractsOf(ctx, stale.id).length === 0);
  } finally {
    ctx.consoleErrors.push(...sc.consoleErrors.map((e) => `MINOR-C: ${e}`));
    await sc.context.close();
  }
}

export const ESIGN_SCENARIOS = {
  SEC1: secOtpExpiredAndReuse,
  SEC2: secOtpLocked,
  SEC3: secOtpCooldown,
  SEC4: secForeignChallenge,
  SEC5: secDecline,
  SEC6: secInterrupted,
  SEC7: secVersionChanged,
  SEC8: secDoubleSubmit,
  SEC9: secEmailNotConfigured,
  MINOR1: minorPaperOnly, // 放在 SEC10 前：SEC10 會竄改全域證據鏈
  SEC10: secTamper,
};
