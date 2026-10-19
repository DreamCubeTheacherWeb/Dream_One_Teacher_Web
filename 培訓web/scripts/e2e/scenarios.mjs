// 老師端情境 A～G（2026-10-20 起：認領＝綁定待啟用 → 補資料 → Email OTP 啟用 → 簽約 v2）＋資料庫層安全。
// 介面契約：docs/specs/2026-10-20-claim-activation-esign.md。每個情境用全新的假帳號；斷言交給 ctx.r。
import {
  createGoogleUser, adminCreateInstructor, samplePng, latestOtp, markAsPreMigrationRecord,
  makeActiveTeacherViaRest,
} from './lib/fixtures.mjs';
import {
  newUser, nextSeq, profileData, fillProfile, waitProfileLoaded, saveProfileAndWait, instructorOf, instructorById,
  roleOf, activationOf, pollUntil, visible, goto, chooseCard, nameClaimUI, seeSeededCourse, dualShot,
  activateViaUI, checkActivationRecord, signContractV2, verifyContractEvidence, adminConfirmEmailUI, adminApproveUI,
  openAs, fieldControl, sleep, typeOtp, openOtpDialogAndWaitSent, REGIONS,
} from './lib/flows.mjs';

const NEEDS_EMAIL_TEXT = '你的 Email 尚未經公司確認，請聯絡行政人員確認後才能啟用帳號。';

// 後台「新增講師 → 只填姓名」建空位（畫面操作）；回傳新建的列
export async function adminAddSlotsUI(ctx, adminSession, names, { confirmDuplicate = false } = {}) {
  const { page } = adminSession;
  await goto(ctx, adminSession, '/admin/instructors');
  await page.getByRole('button', { name: /新增講師/ }).click();
  const dialog = page.getByRole('dialog', { name: '新增講師' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByLabel('老師姓名，一行一個').fill(names.join('\n'));
  if (confirmDuplicate) await dialog.getByText('我確定要再新增同名空位（同名同姓不同人）').click();
  const before = ctx.api.sql(`SELECT count(*) FROM public.instructors`);
  await dialog.getByRole('button', { name: names.length > 1 ? `新增 ${names.length} 位` : '新增' }).click();
  await pollUntil(() => Number(ctx.api.sql(`SELECT count(*) FROM public.instructors`)) === Number(before) + names.length, { timeoutMs: 10000 });
  return ctx.api.json(`SELECT coalesce(json_agg(row_to_json(i) ORDER BY i.created_at), '[]') FROM public.instructors i
                         WHERE i.full_name = ANY (string_to_array(:'names', '|')) AND i.name_slot`, { names: names.join('|') });
}

// ═══ A 新建帳號（管理員核准＝公司核驗，Google 信箱登錄為已確認 Email）═══════════════
export async function scenarioA(ctx) {
  const r = ctx.r;
  const fullName = '測試新老師林';
  const user = await newUser(ctx, 'a-new', fullName);
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    r.check('A Google 新帳號建立後是 pending、沒有啟用紀錄', roleOf(ctx, user.id) === 'pending' && !activationOf(ctx, user.id));
    await goto(ctx, s, '/pending');
    r.check('A /pending 顯示「認領帳號」「新建帳號」兩張卡（認領卡說明改成「綁定後用 Email 驗證碼啟用」）',
      await visible(s.page.getByRole('button', { name: /^認領帳號/ })) && await s.page.getByRole('button', { name: /^新建帳號/ }).isVisible()
      && await s.page.getByText('核對後綁定，再用 Email 驗證碼啟用').isVisible());
    await dualShot(ctx, s, 'A-01-pending-choice');

    await chooseCard(s.page, '新建帳號');
    await s.page.waitForURL(/\/profile$/);
    await waitProfileLoaded(s.page);
    r.check('A 新建帳號的 /profile 沒有啟用卡（新建帳號走管理員審核）', !(await s.page.getByTestId('activation-card').isVisible()));
    r.check('A /profile 預填 Google 姓名與登入 Email',
      await fieldControl(s.page, '姓名').inputValue() === fullName && await fieldControl(s.page, '主要 Email').inputValue() === user.email);
    const data = profileData(user, fullName);
    await fillProfile(s.page, data);
    await s.page.getByRole('button', { name: /送出資料/ }).click();
    r.check('A 送出後顯示「恭喜你完成註冊！」', await visible(s.page.getByText('恭喜你完成註冊！'), 20000));
    const inst = instructorOf(ctx, user.id);
    r.check('A 資料庫建立講師主檔、資料完整、等級強制「實習」',
      inst && inst.instructor_role === '實習' && REGIONS.every((c) => inst.teaching_regions?.includes(c)) && inst.id_front_path && inst.bankbook_path);
    await s.page.getByRole('button', { name: '我知道了' }).click();
    await s.page.waitForURL(/\/pending$/);
    r.check('A 回到 /pending 看到「帳號審核中」', await visible(s.page.getByText('帳號審核中')));
    await dualShot(ctx, s, 'A-02-pending-review');

    const approval = await adminApproveUI(ctx, fullName, 'A-03');
    r.check('A 管理員在 /admin/teachers 按「核准新講師」', approval.ok, approval.error || '');
    r.check('A 核准後角色變 teacher', await pollUntil(() => roleOf(ctx, user.id) === 'teacher'));
    checkActivationRecord(ctx, user, 'A', { method: 'new_instructor_approved' });
    const afterApprove = instructorOf(ctx, user.id);
    r.check('A 核准時把 Google 信箱登錄為已確認 Email（google_login_new_instructor）並登錄身分已核驗',
      afterApprove.confirmed_email === user.email && afterApprove.confirmed_email_method === 'google_login_new_instructor' && Boolean(afterApprove.identity_verified_at));

    await s.page.getByRole('button', { name: /重新檢查狀態/ }).click();
    await s.page.waitForURL(/\/courses$/, { timeout: 15000 }).catch(() => {});
    const seen = await seeSeededCourse(ctx, s, { navigate: false });
    r.check('A 按「重新檢查狀態」後到 /courses 並看到課程', seen.ok, seen.detail);
    await goto(ctx, s, '/pending');
    await s.page.waitForURL(/\/courses$/, { timeout: 10000 }).catch(() => {});
    r.check('A 已核准老師整頁重新整理 /pending → 直接到 /courses（cf62bf9 修正，嚴格斷言）', /\/courses$/.test(s.page.url()), s.page.url());

    const sign = await signContractV2(ctx, s, user, 'A', { wrongOtpFirst: true, shots: true });
    if (sign.done) {
      const c = await verifyContractEvidence(ctx, user, 'A');
      ctx.state.aTeacher = { ...user, contractId: c?.id, evidenceId: c?.evidence_id };
      await goto(ctx, s, `/contract/view/${c.id}`);
      r.check('A 契約查閱頁可開啟（登入後可查看自己的已簽契約）', await visible(s.page.getByText('合約檢視'), 15000));
    }
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `A: ${e}`));
    await s.context.close();
  }
}

// ═══ B 姓名空位：後台「新增講師」建空位 → 認領綁定（待啟用）→ 管理員確認 Email → 補資料 → OTP 啟用 → 簽約 ═══
export async function scenarioB(ctx) {
  const r = ctx.r;
  const slotName = '測試王小明';
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  let slot;
  try {
    [slot] = await adminAddSlotsUI(ctx, admin, [slotName]);
  } finally {
    await admin.context.close();
  }
  r.check('B 管理員用「新增講師」建立空位：name_slot、未綁定、預設等級「實習」（cf62bf9，嚴格斷言）',
    slot?.name_slot === true && slot.user_id === null && slot.instructor_role === '實習' && slot.employment_status === 'active');
  const user = await newUser(ctx, 'b-slot', '小明 Wang');
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/pending');
    await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s.page, '認領帳號');
    r.check('B 認領第 1 步只有姓名欄', await visible(s.page.locator('#claim-full-name')) && await s.page.locator('#claim-phone').count() === 0);
    await s.page.locator('#claim-full-name').fill(slotName);
    await dualShot(ctx, s, 'B-01-claim-name', { fullPage: false });
    await s.page.getByRole('button', { name: '用姓名認領' }).click();
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 });
    const linked = instructorById(ctx, slot.id);
    const act = activationOf(ctx, user.id);
    r.check('B 只輸入姓名就綁定空位，但帳號仍是 pending（只綁不開通）',
      linked?.user_id === user.id && roleOf(ctx, user.id) === 'pending' && act?.status === 'pending' && act.claim_method === 'name_slot');
    await waitProfileLoaded(s.page);
    r.check('B /profile 顯示「已找到並認領您的講師主檔」（cf62bf9，嚴格斷言）', await visible(s.page.getByText('已找到並認領您的講師主檔'), 5000));
    r.check('B 啟用卡：沒有已確認 Email →「請聯絡行政人員確認」，而且沒有啟用按鈕',
      (await s.page.getByTestId('activation-message').innerText()) === NEEDS_EMAIL_TEXT && !(await s.page.getByTestId('activation-button').isVisible()));
    await dualShot(ctx, s, 'B-02-activation-needs-email');
    const noEmail = await ctx.api.rpc(user.token, 'request_email_otp', { p_purpose: 'account_activation' });
    r.check('B 沒確認 Email 時直接打 request_email_otp 也只回 no_confirmed_email', noEmail.data?.status === 'no_confirmed_email', JSON.stringify(noEmail.data));
    await goto(ctx, s, '/courses');
    await s.page.waitForURL(/\/profile$/, { timeout: 10000 }).catch(() => {});
    r.check('B 啟用前進不了 /courses（被帶回 /profile）', /\/profile$/.test(s.page.url()));

    const data = profileData(user, slotName);
    await fillProfile(s.page, data);
    const saved = await saveProfileAndWait(s);
    r.check('B 補齊資料後儲存成功（仍待確認 Email）', saved.includes('個人資料已儲存')
      && (await s.page.getByTestId('activation-message').innerText()) === NEEDS_EMAIL_TEXT, saved);

    const adminSession = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
    try {
      await adminConfirmEmailUI(ctx, adminSession, slotName, user.email, { tryEmptyNote: true, shots: true, tag: 'B-03' });
    } finally {
      await adminSession.context.close();
    }
    const confirmed = instructorById(ctx, slot.id);
    r.check('B 資料庫登錄已確認 Email（admin_trusted_channel，含確認者與註記）',
      confirmed.confirmed_email === user.email && confirmed.confirmed_email_method === 'admin_trusted_channel'
      && confirmed.confirmed_email_by === ctx.base.admin.id && String(confirmed.confirmed_email_note).includes('LINE'));

    await goto(ctx, s, '/profile');
    await waitProfileLoaded(s.page);
    await activateViaUI(ctx, s, user, 'B', { shots: true });
    checkActivationRecord(ctx, user, 'B', { method: 'name_slot', email: user.email });
    const seen = await seeSeededCourse(ctx, s);
    r.check('B 啟用後能進 /courses 看到課程', seen.ok, seen.detail);

    const sign = await signContractV2(ctx, s, user, 'B');
    if (sign.done) await verifyContractEvidence(ctx, user, 'B');
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `B: ${e}`));
    await s.context.close();
  }
}

// ═══ C 同名同姓：兩個空位各被一個帳號綁定（待啟用），第三個同名帳號回 not_found ═══
export async function scenarioC(ctx) {
  const r = ctx.r;
  const name = '同名老師';
  const first = await adminCreateInstructor(ctx.api, ctx.base.admin, { full_name: name, name_slot: true, instructor_role: '實習', employment_status: 'active' });
  await sleep(20);
  const second = await adminCreateInstructor(ctx.api, ctx.base.admin, { full_name: name, name_slot: true, instructor_role: '實習', employment_status: 'active' });
  const claimed = [];
  for (let i = 0; i < 2; i += 1) {
    const user = await newUser(ctx, `c-same${i + 1}`, `同名帳號${i + 1}`);
    const s = await openAs(ctx.browser, ctx.stack, user);
    try {
      await goto(ctx, s, '/pending');
      await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
      await chooseCard(s.page, '認領帳號');
      await nameClaimUI(s.page, i === 0 ? name : ' 同名 老師 ');
      await s.page.waitForURL(/\/profile$/, { timeout: 15000 }).catch(() => {});
      const row = ctx.api.sql(`SELECT id FROM public.instructors WHERE user_id = :'uid'`, { uid: user.id });
      claimed.push(row);
      r.check(`C 第 ${i + 1} 個同名帳號綁定成功（待啟用、仍 pending）`,
        Boolean(row) && roleOf(ctx, user.id) === 'pending' && activationOf(ctx, user.id)?.status === 'pending' && /\/profile$/.test(s.page.url()));
    } finally {
      ctx.consoleErrors.push(...s.consoleErrors.map((e) => `C${i + 1}: ${e}`));
      await s.context.close();
    }
  }
  r.check('C 兩個帳號綁到不同列，且依建立先後', claimed[0] === first.id && claimed[1] === second.id, JSON.stringify(claimed));

  const third = await newUser(ctx, 'c-same3', '同名帳號3');
  const s = await openAs(ctx.browser, ctx.stack, third);
  try {
    await goto(ctx, s, '/pending');
    await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s.page, '認領帳號');
    await nameClaimUI(s.page, name);
    r.check('C 第三個同名帳號回 not_found，畫面出現手機與身分證末四碼欄',
      await visible(s.page.locator('#claim-phone'), 10000) && await s.page.locator('#claim-id-last-four').isVisible());
    r.check('C 第三個帳號仍是 pending、沒有綁定、沒有啟用紀錄', roleOf(ctx, third.id) === 'pending' && !instructorOf(ctx, third.id) && !activationOf(ctx, third.id));
    await dualShot(ctx, s, 'C-01-claim-identity-step', { fullPage: false });
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `C3: ${e}`));
    await s.context.close();
  }
}

// ═══ D 舊資料核對：migration 前就有的舊主檔（公司既有 Email 已登錄）→ 姓名＋手機＋末四碼 → OTP 寄到舊信箱 ═══
export async function scenarioD(ctx) {
  const r = ctx.r;
  const legacyName = '舊資料陳老師';
  const legacyEmail = `legacy-chen-${ctx.base.runTag}@old-mail.example`;
  const legacy = await adminCreateInstructor(ctx.api, ctx.base.admin, {
    full_name: legacyName, nickname: '陳老師', gender: '男', birth_date: '1988-08-08',
    phone_mobile: '0912-345-678', id_number: 'B223456789', address: '臺中市西屯區舊資料路 8 號',
    email_primary: legacyEmail, employment_status: 'active', instructor_role: 'A',
  });
  markAsPreMigrationRecord(ctx.api, legacy.id);
  const user = await newUser(ctx, 'd-legacy', 'Chen Legacy');
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/pending');
    await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s.page, '認領帳號');
    await nameClaimUI(s.page, legacyName);
    r.check('D 舊講師（非空位、有個資）用姓名認領回 not_found、進第二步', await visible(s.page.locator('#claim-phone'), 10000) && !instructorOf(ctx, user.id));
    await s.page.locator('#claim-phone').fill('0912345678');
    await s.page.locator('#claim-id-last-four').fill('0000');
    await s.page.getByRole('button', { name: '核對並帶入資料' }).click();
    const failText = await pollUntil(async () => {
      const t = await s.page.getByRole('status').innerText().catch(() => '');
      return /剩餘 \d+ 次/.test(t) ? t : null;
    });
    r.check('D 末四碼錯誤顯示失敗與剩餘次數', Boolean(failText), failText || '');
    await dualShot(ctx, s, 'D-01-identity-wrong-last-four', { fullPage: false });
    await s.page.locator('#claim-id-last-four').fill('6789');
    await s.page.getByRole('button', { name: '核對並帶入資料' }).click();
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 }).catch(() => {});
    const act = activationOf(ctx, user.id);
    r.check('D 核對成功：綁定舊講師列、待啟用（identity_check），角色仍 pending',
      instructorOf(ctx, user.id)?.id === legacy.id && roleOf(ctx, user.id) === 'pending' && act?.claim_method === 'identity_check' && act.status === 'pending');
    await waitProfileLoaded(s.page);
    r.check('D /profile 帶入舊資料（暱稱、手機、身分證）',
      await fieldControl(s.page, '講師暱稱').inputValue() === '陳老師' && await fieldControl(s.page, '身分證字號').inputValue() === 'B223456789');
    const data = profileData(user, legacyName, {
      nickname: undefined, gender: undefined, birth_date: undefined, id_number: undefined,
      phone_mobile: undefined, address: undefined, email_primary: undefined,
    });
    await fillProfile(s.page, data);
    const saved = await saveProfileAndWait(s);
    r.check('D 主要 Email 保持舊信箱也能儲存個人資料（cf62bf9 修正 upsert 403，嚴格斷言）', saved.includes('個人資料已儲存'), saved);
    r.check('D 舊信箱仍是主要 Email，資料寫回同一列', instructorById(ctx, legacy.id)?.email_primary === legacyEmail && instructorById(ctx, legacy.id).bank_account_number === data.bank_account_number);
    const otp = await activateViaUI(ctx, s, user, 'D');
    r.check('D 啟用驗證碼寄到公司既有資料的 Email（不是 Google 登入信箱）', otp?.to === legacyEmail, otp?.to);
    checkActivationRecord(ctx, user, 'D', { method: 'identity_check', email: legacyEmail });
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `D: ${e}`));
    await s.context.close();
  }
}

// ═══ E Email 自動對應：後台「新增講師 → 填完整資料」→ 同 Email 的 Google 帳號登入自動綁定（待啟用）═══
export async function scenarioE(ctx) {
  const r = ctx.r;
  const email = `e-auto-${ctx.base.runTag}-${nextSeq()}@e2e.test`;
  const name = '信箱自動老師';
  const adminSession = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    await goto(ctx, adminSession, '/admin/instructors');
    await adminSession.page.getByRole('button', { name: /新增講師/ }).click();
    const dialog = adminSession.page.getByRole('dialog', { name: '新增講師' });
    await dialog.getByRole('tab', { name: /填完整資料/ }).click();
    await fieldControl(adminSession.page, '姓名').fill(name);
    await fieldControl(adminSession.page, 'Email(登入用)').fill(email);
    await dialog.getByRole('button', { name: /^新增$/ }).click();
    await visible(adminSession.page.getByText(`已新增 ${name}`), 10000);
  } finally {
    await adminSession.context.close();
  }
  const pre = ctx.api.json(`SELECT row_to_json(i) FROM public.instructors i WHERE email_primary = :'e'`, { e: email });
  r.check('E 管理員用「填完整資料」建立帶 Email 的講師', Boolean(pre?.id) && pre.identity_verified_at && !pre.confirmed_email);
  const user = await createGoogleUser(ctx.stack, { email, fullName: 'Auto Mail' });
  r.check('E Before-User-Created hook 允許後台已建立的 Email', Boolean(user.id), JSON.stringify(user.hookRejected || {}));
  if (!user.id) return;
  const act = activationOf(ctx, user.id);
  r.check('E 帳號建立當下自動綁定主檔，但只綁不開通（pending、email_match 待啟用）',
    instructorById(ctx, pre.id)?.user_id === user.id && roleOf(ctx, user.id) === 'pending' && act?.claim_method === 'email_match' && act.status === 'pending');
  const s = await openAs(ctx.browser, ctx.stack, user);
  try {
    await goto(ctx, s, '/pending');
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 }).catch(() => {});
    await waitProfileLoaded(s.page).catch(() => {});
    r.check('E 不經 /pending 選擇卡，直接到 /profile、帶入後台姓名', /\/profile$/.test(s.page.url())
      && !(await s.page.getByText('請選擇你的講師身分').isVisible()) && await fieldControl(s.page, '姓名').inputValue() === name);
    const message = await s.page.getByTestId('activation-message').innerText().catch(() => '');
    if (message === NEEDS_EMAIL_TEXT) {
      ctx.known('E 後台「填完整資料」建的講師仍要另外確認 Email', 'E［流程缺口］管理員用「新增講師 → 填完整資料」輸入的 Email（src/pages/admin/InstructorList.jsx:1350-1372 FullInstructorForm）不會登錄成已確認 Email，老師登入自動綁定後看到「你的 Email 尚未經公司確認，請聯絡行政人員」；管理員要再到同一列按「確認 Email」並寫註記。成功訊息仍寫「登入時會自動綁定」，沒提醒還要確認 Email。');
    }
    r.check('E 啟用卡依規則顯示（沒有已確認 Email → 請聯絡行政人員）', message === NEEDS_EMAIL_TEXT, message);
    await dualShot(ctx, s, 'E-01-auto-linked-needs-email');
    const data = profileData(user, name, { email_primary: undefined });
    await fillProfile(s.page, data);
    r.check('E 補資料儲存成功', (await saveProfileAndWait(s)).includes('個人資料已儲存'));
    const confirm = await ctx.api.rpc(ctx.base.admin.token, 'admin_confirm_instructor_email', { p_instructor_id: pre.id, p_email: email, p_note: '10/20 電話與老師確認（E2E）' });
    r.check('E 管理員確認 Email（RPC）', confirm.data?.status === 'confirmed', JSON.stringify(confirm.data));
    await goto(ctx, s, '/profile');
    await waitProfileLoaded(s.page);
    await activateViaUI(ctx, s, user, 'E');
    checkActivationRecord(ctx, user, 'E', { method: 'email_match', email });
    const dup = await createGoogleUser(ctx.stack, { email: email.toUpperCase(), fullName: 'Dup' });
    r.check('E 同 Email（大小寫不同）第二次註冊被 hook 拒絕', !dup.id && dup.hookRejected?.http_code === 409, JSON.stringify(dup.hookRejected || {}));
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `E: ${e}`));
    await s.context.close();
  }
}

// ═══ F 安全（REST 直接打）═════════════════════════════════════════════
export async function scenarioF(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const admin = ctx.base.admin;
  const claim = (u, name) => api.rpc(u.token, 'claim_instructor_name_slot', { provided_full_name: name });
  const ownerOf = (id) => api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id });

  for (const [field, value] of [['phone_mobile', '0911000111'], ['id_number', 'D123456789'], ['bank_account_number', '000123'], ['birth_date', '1990-01-01'], ['id_front_path', 'instructors/x/id_front/a.png']]) {
    const slot = await adminCreateInstructor(api, admin, { full_name: `有個資${field}`, name_slot: true, [field]: value });
    const u = await newUser(ctx, `f-pii-${field}`, 'F1');
    const res = await claim(u, `有個資${field}`);
    r.check(`F 有 ${field} 的空位不能用姓名認領`, res.data?.status === 'not_found' && !ownerOf(slot.id), JSON.stringify(res.data));
  }
  for (const status of ['frozen', 'cancelled']) {
    const slot = await adminCreateInstructor(api, admin, { full_name: `停用空位${status}`, name_slot: true, employment_status: status });
    const u = await newUser(ctx, `f-${status}`, `F2${status}`);
    const res = await claim(u, `停用空位${status}`);
    r.check(`F ${status} 空位不能認領`, res.data?.status === 'not_found' && !ownerOf(slot.id) && !activationOf(ctx, u.id), JSON.stringify(res.data));
  }

  // 已啟用的 teacher 再呼叫被拒；已綁定（待啟用）的帳號再呼叫回 already_linked、不綁第二筆
  const active = await makeActiveTeacherViaRest(ctx.stack, api, admin, { emailPrefix: 'f-active' });
  const spare = await adminCreateInstructor(api, admin, { full_name: '備用空位', name_slot: true });
  const resTeacher = await claim(active, '備用空位');
  r.check('F 已啟用的 teacher 呼叫 claim_instructor_name_slot 被拒（42501），空位不被綁',
    resTeacher.status === 403 && resTeacher.data?.code === '42501' && !ownerOf(spare.id), `HTTP ${resTeacher.status} ${JSON.stringify(resTeacher.data)}`);
  const pendingClaimer = await newUser(ctx, 'f-claimer', 'F3 綁定者');
  const firstClaim = await claim(pendingClaimer, '備用空位');
  const spare2 = await adminCreateInstructor(api, admin, { full_name: '備用空位', name_slot: true });
  const again = await claim(pendingClaimer, '備用空位');
  r.check('F 已綁定待啟用的帳號再呼叫回 already_linked（activation_required），不綁第二筆',
    firstClaim.data?.status === 'claimed' && firstClaim.data?.activation_required === true && again.data?.status === 'already_linked'
    && !ownerOf(spare2.id) && api.sql(`SELECT count(*) FROM public.instructors WHERE user_id = :'uid'`, { uid: pendingClaimer.id }) === '1',
  `${JSON.stringify(firstClaim.data)} → ${JSON.stringify(again.data)}`);
  const anonRes = await api.request(null, 'POST', '/rest/v1/rpc/claim_instructor_name_slot', { body: { provided_full_name: '備用空位' } });
  r.check('F 未登入（anon key）呼叫被拒', [401, 403].includes(anonRes.status) && !ownerOf(spare2.id), `HTTP ${anonRes.status}`);

  // 講師不能自己動 name_slot、confirmed_email 等管理員欄位
  const patchSlot = await api.rest(active.token, 'PATCH', `instructors?user_id=eq.${active.id}`, { body: { name_slot: true } });
  const patchClear = await api.rest(pendingClaimer.token, 'PATCH', `instructors?user_id=eq.${pendingClaimer.id}`, { body: { name_slot: false } });
  r.check('F 講師 PATCH 自己的 name_slot（設 true／清 false）都被拒', patchSlot.status === 403 && patchClear.status === 403
    && api.sql(`SELECT name_slot FROM public.instructors WHERE user_id = :'uid'`, { uid: active.id }) === 'f'
    && api.sql(`SELECT name_slot FROM public.instructors WHERE user_id = :'uid'`, { uid: pendingClaimer.id }) === 't', `HTTP ${patchSlot.status}/${patchClear.status}`);
  const selfConfirm = await api.rest(pendingClaimer.token, 'PATCH', `instructors?user_id=eq.${pendingClaimer.id}`, { body: { confirmed_email: pendingClaimer.email } });
  const selfConfirmRpc = await api.rpc(pendingClaimer.token, 'admin_confirm_instructor_email', { p_instructor_id: spare.id, p_email: pendingClaimer.email, p_note: '我自己確認的' });
  r.check('F 待啟用的人不能自己把 Email 改成「已確認」（PATCH 與 admin RPC 都被拒）', selfConfirm.status === 403 && [401, 403].includes(selfConfirmRpc.status)
    && !api.sql(`SELECT confirmed_email FROM public.instructors WHERE user_id = :'uid'`, { uid: pendingClaimer.id }), `HTTP ${selfConfirm.status}/${selfConfirmRpc.status}`);
  const fresh = await newUser(ctx, 'f-insert', 'F7');
  const ins1 = await api.rest(fresh.token, 'POST', 'instructors', { body: { user_id: fresh.id, full_name: 'F7 偽空位', email_primary: fresh.email, name_slot: true }, prefer: 'return=minimal' });
  const ins2 = await api.rest(fresh.token, 'POST', 'instructors', { body: { user_id: null, full_name: 'F7 無主空位', name_slot: true }, prefer: 'return=minimal' });
  r.check('F 講師新增 name_slot=true 的列被拒', ins1.status === 403 && ins2.status === 403 && api.sql(`SELECT count(*) FROM public.instructors WHERE full_name LIKE 'F7 %'`) === '0', `HTTP ${ins1.status}/${ins2.status}`);

  // 啟用紀錄、同意、證據、寄送紀錄：沒有任何直接寫入政策；只讀得到自己的
  const insAct = await api.rest(fresh.token, 'POST', 'instructor_account_activations', { body: { user_id: fresh.id, instructor_id: spare.id, claim_method: 'name_slot', status: 'active' }, prefer: 'return=minimal' });
  const patchAct = await api.rest(pendingClaimer.token, 'PATCH', `instructor_account_activations?user_id=eq.${pendingClaimer.id}`, { body: { status: 'active' } });
  r.check('F 講師不能直接新增或把自己的啟用紀錄改成 active', [401, 403].includes(insAct.status) && activationOf(ctx, pendingClaimer.id)?.status === 'pending'
    && !activationOf(ctx, fresh.id), `INSERT ${insAct.status} PATCH ${patchAct.status}`);
  const insConsent = await api.rest(active.token, 'POST', 'contract_consent_records', { body: { user_id: active.id, decision: 'agree_electronic', consent_text_version: 'x', consent_text: 'x', doc_versions: {} }, prefer: 'return=minimal' });
  const insEvidence = await api.rest(active.token, 'POST', 'contract_signing_evidence', { body: { user_id: active.id }, prefer: 'return=minimal' });
  const insLog = await api.rest(active.token, 'POST', 'email_delivery_log', { body: { kind: 'otp_activation', to_email: 'x@x.x', subject: 'x' }, prefer: 'return=minimal' });
  r.check('F 講師不能直接寫同意紀錄、簽署證據、寄送紀錄', [insConsent, insEvidence, insLog].every((x) => [400, 401, 403].includes(x.status)), `${insConsent.status}/${insEvidence.status}/${insLog.status}`);
  const otherLogs = await api.rest(active.token, 'GET', `email_delivery_log?select=id&related_user_id=neq.${active.id}`);
  const otherActs = await api.rest(active.token, 'GET', `instructor_account_activations?select=id&user_id=neq.${active.id}`);
  const otp = await api.request(active.token, 'GET', '/rest/v1/email_otp_challenges?select=id');
  r.check('F 講師讀不到別人的寄送紀錄與啟用紀錄；OTP 表（private）完全不對外', otherLogs.data?.length === 0 && otherActs.data?.length === 0 && otp.status >= 400, `OTP 表 HTTP ${otp.status}`);
  const pendingConsent = await api.rpc(pendingClaimer.token, 'record_contract_consent', { p_decision: 'agree_electronic', p_doc_versions: { contract: 1 }, p_consent_text_version: 'esign-consent-v1' });
  const pendingOtp = await api.rpc(pendingClaimer.token, 'request_email_otp', { p_purpose: 'contract_sign' });
  r.check('F 未啟用帳號不能簽約：記錄同意回 ACCOUNT_NOT_ACTIVE、要簽約碼回 not_allowed',
    String(pendingConsent.data?.message).includes('ACCOUNT_NOT_ACTIVE') && pendingOtp.data?.status === 'not_allowed' && pendingOtp.data?.reason === 'account_not_active',
  `${JSON.stringify(pendingConsent.data)} ${JSON.stringify(pendingOtp.data)}`);

  const asTeacher = await api.rest(active.token, 'GET', 'instructors?select=id,user_id');
  const asPending = await api.rest(fresh.token, 'GET', 'instructors?select=id&name_slot=eq.true');
  r.check('F 講師只看得到自己那一列、pending 讀不到任何空位', asTeacher.data?.length === 1 && asTeacher.data[0].user_id === active.id && asPending.data?.length === 0);

  // 並行認領同一空位：每輪剛好一人綁定（待啟用），沒有人因此變 teacher
  let raceOk = true;
  const raceDetail = [];
  for (let round = 0; round < 5; round += 1) {
    const name = `搶名老師${round}`;
    const slot = await adminCreateInstructor(api, admin, { full_name: name, name_slot: true });
    const racers = [];
    for (let i = 0; i < (round === 4 ? 3 : 2); i += 1) racers.push(await newUser(ctx, `f-race${round}-${i}`, `搶${i}`));
    const results = await Promise.all(racers.map((u) => claim(u, name)));
    const statuses = results.map((x) => x.data?.status);
    const owner = ownerOf(slot.id);
    const pendingActs = racers.filter((u) => activationOf(ctx, u.id)?.status === 'pending').length;
    raceDetail.push(statuses.join('/'));
    if (!(statuses.filter((x) => x === 'claimed').length === 1 && pendingActs === 1 && racers.some((u) => u.id === owner)
      && racers.every((u) => roleOf(ctx, u.id) === 'pending'))) raceOk = false;
  }
  r.check('F 同時認領同一空位：每輪剛好一人綁定待啟用、其他 not_found、沒有人變 teacher', raceOk, raceDetail.join(' | '));

  // Storage RLS（假 Storage 以呼叫者身分寫 storage.objects）
  const owner = await newUser(ctx, 'f-file-owner', 'F10 檔案主人');
  const other = await newUser(ctx, 'f-file-other', 'F10 旁人');
  const ownPath = `instructors/${owner.id}/id_front/${Date.now()}.png`;
  const upload = (u, bucket, objectPath, body, type = 'image/png') => api.request(u?.token || null, 'POST', `/storage/v1/object/${bucket}/${objectPath}`, { raw: body, headers: { 'content-type': type } });
  r.check('F 本人可上傳到自己的證件資料夾', (await upload(owner, 'instructor_uploads', ownPath, samplePng('owner'))).status === 200);
  r.check('F 別人不能上傳到他人的證件資料夾', (await upload(other, 'instructor_uploads', `instructors/${owner.id}/id_front/evil.png`, samplePng('evil'))).status === 403);
  const readOther = await api.request(other.token, 'GET', `/storage/v1/object/authenticated/instructor_uploads/${ownPath}`);
  const adminRead = await api.request(admin.token, 'GET', `/storage/v1/object/authenticated/instructor_uploads/${ownPath}`);
  r.check('F 別人讀不到他人的證件檔（對照組：管理員讀得到）', readOther.status === 400 && adminRead.status === 200, `${readOther.status}/${adminRead.status}`);
  r.check('F 老師不能上傳合約範本、也不能把檔案放進別人的 signed/<uid>/',
    (await upload(active, 'contract-documents', `templates/evil-${Date.now()}.pdf`, Buffer.from('%PDF-1.4 evil'), 'application/pdf')).status === 403
    && (await upload(active, 'contract-documents', `signed/${owner.id}/fake.png`, samplePng('fake'))).status === 403);
}

// ═══ G 錯誤認領（規格 §3）：冒認者綁了空位，但驗證碼寄到公司已確認的真老師信箱 → 不能啟用；
//      管理員用畫面解除綁定 → 真老師可以認領並啟用 ═══════════════════════════════
export async function scenarioG(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const realEmail = `g-real-${ctx.base.runTag}@e2e.test`;
  const slotName = '被冒認老師甲';
  const slot = await adminCreateInstructor(api, ctx.base.admin, { full_name: slotName, name_slot: true, instructor_role: '實習', employment_status: 'active' });
  const confirm = await api.rpc(ctx.base.admin.token, 'admin_confirm_instructor_email', { p_instructor_id: slot.id, p_email: realEmail, p_note: '10/20 LINE 與真老師確認（E2E）' });
  r.check('G 管理員事先登錄真老師的已確認 Email', confirm.data?.status === 'confirmed');
  const impostor = await newUser(ctx, 'g-impostor', '冒認者');
  const s = await openAs(ctx.browser, ctx.stack, impostor);
  try {
    await goto(ctx, s, '/pending');
    await visible(s.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s.page, '認領帳號');
    await nameClaimUI(s.page, slotName);
    await s.page.waitForURL(/\/profile$/, { timeout: 15000 });
    r.check('G 冒認者用姓名綁到空位（待啟用）', instructorById(ctx, slot.id)?.user_id === impostor.id && activationOf(ctx, impostor.id)?.status === 'pending');
    await fillProfile(s.page, profileData(impostor, slotName));
    await saveProfileAndWait(s);
    await s.page.getByTestId('activation-button').click();
    const notice = await openOtpDialogAndWaitSent(s.page);
    const sent = latestOtp(api, impostor.id, 'account_activation');
    r.check('G 驗證碼寄到公司確認的真老師信箱，冒認者畫面只看到遮罩', sent?.to === realEmail && !notice.includes(realEmail) && notice.includes('***@'), `${notice}｜${sent?.to}`);
    await typeOtp(s.page, sent.code === '123456' ? '654321' : '123456');
    r.check('G 冒認者猜錯驗證碼 → 不能啟用、仍 pending', await visible(s.page.getByText(/驗證碼不正確/), 8000) && roleOf(ctx, impostor.id) === 'pending');
    await dualShot(ctx, s, 'G-01-impostor-cannot-activate', { fullPage: false });
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `G: ${e}`));
    await s.context.close();
  }

  // 管理員在講師資料總覽按「解除綁定」
  const adminSession = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    await goto(ctx, adminSession, '/admin/instructors');
    await adminSession.page.getByPlaceholder('搜尋姓名、Email 或手機號碼⋯⋯').fill(slotName);
    const row = adminSession.page.locator('tbody tr', { hasText: slotName }).first();
    await row.waitFor({ state: 'visible' });
    r.check('G 講師總覽在已認領空位旁顯示「若認領錯人：按解除綁定」說明', await row.getByTestId('name-slot-unlink-hint').isVisible());
    await row.getByRole('button', { name: '解除綁定' }).click();
    await pollUntil(() => !api.sql(`SELECT user_id FROM public.instructors WHERE id = :'id'`, { id: slot.id }), { timeoutMs: 10000 });
  } finally {
    await adminSession.context.close();
  }
  const revoked = api.json(`SELECT row_to_json(a) FROM public.instructor_account_activations a WHERE a.user_id = :'uid' ORDER BY claimed_at DESC LIMIT 1`, { uid: impostor.id });
  r.check('G 解除綁定：空位釋出、冒認者的啟用紀錄改 revoked、冒認者仍 pending',
    !instructorById(ctx, slot.id).user_id && revoked?.status === 'revoked' && revoked.revoked_at && roleOf(ctx, impostor.id) === 'pending', JSON.stringify(revoked || {}).slice(0, 160));

  const realTeacher = await newUser(ctx, 'g-real', '真老師甲', { email: realEmail });
  const blocked = await api.rpc(realTeacher.token, 'claim_instructor_name_slot', { provided_full_name: slotName });
  r.check('G 冒認者已在空位填了手機／身分證 → 解除後不能再只靠姓名認領（設計如此）', blocked.data?.status === 'not_found', JSON.stringify(blocked.data));
  ctx.known('G 解除冒認後要手動清掉冒認者填的資料', 'G［流程缺口，設計使然］冒認者若已填個資，管理員按「解除綁定」後空位仍留著冒認者的手機、身分證、銀行、證件檔路徑，真老師無法再用姓名認領；後台沒有「清除冒認資料」的按鈕（src/pages/admin/InstructorList.jsx:262 handleUnlink 只呼叫 admin_unlink_instructor），測試以管理員 REST 清空後才繼續。');
  const piiFields = ['nickname', 'gender', 'birth_date', 'id_number', 'phone_mobile', 'line_id', 'address', 'household_address', 'email_primary',
    'teaching_freq_semester', 'teaching_freq_vacation', 'bio_notes', 'bank_account_name', 'bank_name', 'bank_branch', 'bank_account_number', 'bank_code',
    'id_front_path', 'id_back_path', 'bankbook_path', 'id_front_mime', 'id_back_mime', 'bankbook_mime', 'id_front_size', 'id_back_size', 'bankbook_size',
    'id_front_uploaded_at', 'id_back_uploaded_at', 'bankbook_uploaded_at'];
  const cleared = await api.rest(ctx.base.admin.token, 'PATCH', `instructors?id=eq.${slot.id}`, { body: Object.fromEntries(piiFields.map((f) => [f, null])) });
  r.check('G 管理員清空冒認者資料', cleared.status === 204, `HTTP ${cleared.status} ${JSON.stringify(cleared.data)}`);
  const s2 = await openAs(ctx.browser, ctx.stack, realTeacher);
  try {
    await goto(ctx, s2, '/pending');
    await visible(s2.page.getByRole('button', { name: /^認領帳號/ }));
    await chooseCard(s2.page, '認領帳號');
    await nameClaimUI(s2.page, slotName);
    await s2.page.waitForURL(/\/profile$/, { timeout: 15000 });
    r.check('G 真老師用姓名認領成功', instructorById(ctx, slot.id)?.user_id === realTeacher.id);
    await fillProfile(s2.page, profileData(realTeacher, slotName));
    r.check('G 真老師補完資料', (await saveProfileAndWait(s2)).includes('個人資料已儲存'));
    const otp = await activateViaUI(ctx, s2, realTeacher, 'G');
    r.check('G 真老師收到寄到自己信箱的碼並啟用', otp?.to === realEmail && roleOf(ctx, realTeacher.id) === 'teacher');
  } finally {
    ctx.consoleErrors.push(...s2.consoleErrors.map((e) => `G2: ${e}`));
    await s2.context.close();
  }
}

export async function selfTest(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const u = await newUser(ctx, 'z-self', '自檢帳號');
  const me = await api.request(u.token, 'GET', '/auth/v1/user');
  r.check('底座 /auth/v1/user 回傳登入者', me.status === 200 && me.data?.id === u.id && me.data?.app_metadata?.provider === 'google');
  const refreshed = await api.request(null, 'POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: u.session.refresh_token } });
  const reused = await api.request(null, 'POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: u.session.refresh_token } });
  r.check('底座 refresh_token 換新 session、舊 refresh token 不能重用', refreshed.status === 200 && reused.status === 400);
  const badJwt = await api.request(`${u.token.slice(0, -4)}AAAA`, 'GET', '/auth/v1/user');
  const badKey = await api.request(u.token, 'GET', '/rest/v1/users?select=id', { headers: { apikey: 'not-a-project-key' } });
  r.check('底座 竄改過的 JWT 與非本專案 apikey 一律 401', badJwt.status === 401 && badKey.status === 401);
  const asSelf = await api.rest(u.token, 'GET', 'users?select=id,role');
  r.check('底座 PostgREST 以 authenticated 身分跑 RLS', asSelf.status === 200 && asSelf.data.length === 1);
  const mentorOk = ctx.stack.db.psqlSync(`BEGIN; UPDATE public.users SET role = 'mentor' WHERE id = :'id'; ROLLBACK;`, { vars: { id: u.id }, expectFail: true }).ok;
  r.check('底座 bootstrap-after-chain.sql 已補上 users.role 的 mentor（repo SQL 落差，supabase/setup.sql:8）', mentorOk);
  const vault = api.sql(`SELECT count(*) FROM vault.decrypted_secrets WHERE name IN ('resend_api_key', 'resend_from')`);
  r.check('底座 寄信設定（Vault 替身 resend_api_key／resend_from）已就緒', vault === '2');
}

export const SCENARIOS = { A: scenarioA, B: scenarioB, C: scenarioC, D: scenarioD, E: scenarioE, F: scenarioF, G: scenarioG };
