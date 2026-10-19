// 後台畫面（第二階段）：新增老師 modal、資料進度篩選一路走到已完成、後台首頁卡片數字、
// 帳號審核頁（同名空位警示、待啟用不給核准）、刪除空位、輔導員視角、合約管理證據面板與驗證。
import {
  adminCreateInstructor, createGoogleUser, createMentor, latestOtp, makeActiveTeacherViaRest, signViaRest,
} from './lib/fixtures.mjs';
import {
  newUser, roleOf, activationOf, pollUntil, visible, goto, dualShot, openAs, sleep,
} from './lib/flows.mjs';

const SEARCH = '搜尋姓名、Email 或手機號碼⋯⋯';

async function readProgressChips(page) {
  await page.locator('[data-progress-filter]').first().waitFor({ state: 'visible', timeout: 15000 });
  const chips = await page.locator('[data-progress-filter]').evaluateAll((els) => els.map((el) => ({
    key: el.getAttribute('data-progress-filter'), text: el.textContent.trim(),
  })));
  return Object.fromEntries(chips.map(({ key, text }) => [key, { text, count: Number((text.match(/(\d+)\s*$/) || [])[1]) }]));
}

async function rowBadge(page, name) {
  await page.getByPlaceholder(SEARCH).fill(name);
  const row = page.locator('tbody tr', { hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 10000 });
  return { key: await row.locator('[data-progress]').first().getAttribute('data-progress'), label: (await row.locator('[data-progress]').first().textContent()).trim() };  // textContent：CSS uppercase 會讓 innerText 變成 EMAIL
}

// ═══ ADM-1 新增老師 modal：只填姓名、一次多位、同名要勾選確認、預設等級實習；刪除空位 ═══
export async function scenarioAdminSlots(ctx) {
  const r = ctx.r;
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  const { page } = admin;
  try {
    await goto(ctx, admin, '/admin/instructors');
    await page.getByRole('button', { name: /新增講師/ }).click();
    const dialog = page.getByRole('dialog', { name: '新增講師' });
    await dialog.waitFor({ state: 'visible' });
    r.check('ADM 新增講師 modal 預設是「只填姓名」分頁', (await dialog.getByRole('tab', { name: /只填姓名/ }).getAttribute('aria-selected')) === 'true');
    await dialog.getByLabel('老師姓名，一行一個').fill('新增甲老師\n新增乙老師');
    r.check('ADM 一次輸入兩位 → 顯示「將新增 2 位空位」', (await dialog.getByTestId('name-slot-count').innerText()).includes('將新增 2 位空位'));
    r.check('ADM 講師等級預設「實習」', (await dialog.getByLabel('講師等級').inputValue()) === '實習');
    const hint = await dialog.getByText(/建好後，老師用 Google 登入/).innerText();
    if (hint.includes('直接綁定並開通')) {
      ctx.known('ADM 新增空位的說明仍寫「直接綁定並開通」', `ADM［文案過時］「只填姓名」表單提示寫「…就會直接綁定並開通」（src/pages/admin/InstructorList.jsx:1248），但 10/20 起姓名認領只綁定、要再用 Email 驗證碼啟用，且管理員要先「確認 Email」。`);
    }
    await dualShot(ctx, admin, 'ADM-01-add-slots-modal', { fullPage: false });
    await dialog.getByRole('button', { name: '新增 2 位' }).click();
    r.check('ADM 送出後顯示「已新增 2 位空位」', await visible(page.getByText(/已新增 2 位空位：新增甲老師、新增乙老師/), 10000));
    const rows = ctx.api.json(`SELECT coalesce(json_agg(row_to_json(i)), '[]') FROM public.instructors i WHERE full_name IN ('新增甲老師', '新增乙老師')`);
    r.check('ADM 資料庫建立兩個空位（name_slot、未綁定、active、實習）', rows.length === 2
      && rows.every((x) => x.name_slot && !x.user_id && x.employment_status === 'active' && x.instructor_role === '實習'));

    // 同名：要勾選「我確定要再新增同名空位」才能送出
    await page.getByRole('button', { name: /新增講師/ }).click();
    await dialog.getByLabel('老師姓名，一行一個').fill('新增甲老師');
    const conflict = dialog.getByTestId('name-slot-conflicts');
    const submit = dialog.getByRole('button', { name: /^新增$/ });
    r.check('ADM 輸入已存在的姓名 → 顯示同名警示、新增按鈕停用', await visible(conflict, 5000) && await submit.isDisabled());
    await dualShot(ctx, admin, 'ADM-02-add-slot-duplicate', { fullPage: false });
    await dialog.getByText('我確定要再新增同名空位（同名同姓不同人）').click();
    r.check('ADM 勾選確認後才能送出', await submit.isEnabled());
    await submit.click();
    await visible(page.getByText(/已新增 1 位空位：新增甲老師/), 10000);
    r.check('ADM 同名空位確認後建立成功（共 2 個「新增甲老師」）', ctx.api.sql(`SELECT count(*) FROM public.instructors WHERE full_name = '新增甲老師' AND name_slot`) === '2');

    // 刪除空位（未認領、沒有資料）
    await page.getByPlaceholder(SEARCH).fill('新增乙老師');
    const row = page.locator('tbody tr', { hasText: '新增乙老師' }).first();
    await row.getByRole('button', { name: /刪除空位/ }).click();
    r.check('ADM 刪除空位成功、畫面顯示通知', await visible(page.getByText('已刪除空位「新增乙老師」'), 10000)
      && ctx.api.sql(`SELECT count(*) FROM public.instructors WHERE full_name = '新增乙老師'`) === '0');
    // 已被認領的空位沒有「刪除空位」
    const claimedSlot = ctx.api.json(`SELECT row_to_json(i) FROM public.instructors i WHERE name_slot AND user_id IS NOT NULL ORDER BY created_at LIMIT 1`);
    if (claimedSlot) {
      await page.getByPlaceholder(SEARCH).fill(claimedSlot.full_name);
      const claimedRow = page.locator('tbody tr', { hasText: claimedSlot.full_name }).first();
      await claimedRow.waitFor({ state: 'visible' });
      r.check('ADM 已被認領的空位不提供「刪除空位」', await claimedRow.getByRole('button', { name: /刪除空位/ }).count() === 0);
    }
  } finally {
    ctx.consoleErrors.push(...admin.consoleErrors.map((e) => `ADM-1: ${e}`));
    await admin.context.close();
  }
}

// ═══ ADM-2 進度篩選：一位老師從未認領一路走到已完成，每一步都看篩選人數與標籤；同時看帳號審核頁 ═══
export async function scenarioAdminProgress(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const name = '進度追蹤老師';
  const slot = await adminCreateInstructor(api, ctx.base.admin, { full_name: name, name_slot: true, instructor_role: '實習', employment_status: 'active' });
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  const { page } = admin;
  let previous = null;
  const stepCheck = async (expectedKey, expectedLabel, action) => {
    await goto(ctx, admin, '/admin/instructors');
    const chips = await readProgressChips(page);
    const badge = await rowBadge(page, name);
    await page.locator(`[data-progress-filter="${expectedKey}"]`).click();
    await page.getByPlaceholder(SEARCH).fill(name);
    const inFilter = await visible(page.locator('tbody tr', { hasText: name }), 5000);
    const deltaOk = !previous || (previous.key === expectedKey
      ? chips[expectedKey].count === previous.chips[expectedKey].count
      : chips[expectedKey].count === previous.chips[expectedKey].count + 1 && chips[previous.key].count === previous.chips[previous.key].count - 1);
    r.check(`ADM 進度：${action} → 標籤「${expectedLabel}」，篩選「${expectedLabel}」看得到他，人數${previous && previous.key !== expectedKey ? ' +1（上一階段 −1）' : '正確'}`,
      badge.key === expectedKey && badge.label.startsWith(expectedLabel) && inFilter && deltaOk && chips[expectedKey].text.startsWith(expectedLabel),
      `標籤=${badge.label} 篩選=${chips[expectedKey].text}${previous ? `（之前 ${previous.chips[expectedKey]?.text}）` : ''}`);
    previous = { key: expectedKey, chips };
    return chips;
  };
  try {
    await stepCheck('unclaimed', '未認領', '後台剛建空位');
    const teacher = await newUser(ctx, 'adm-progress', '進度 Google');
    const claim = await api.rpc(teacher.token, 'claim_instructor_name_slot', { provided_full_name: name });
    await stepCheck('awaiting_email_confirm', '待確認 Email', `老師用姓名認領（${claim.data?.status}）`);
    await dualShot(ctx, admin, 'ADM-03-progress-awaiting-email-confirm');

    // 帳號審核頁：待啟用帳號不給「核准新講師」，只連到講師主檔
    await goto(ctx, admin, '/admin/teachers');
    const card = page.locator('.bh-card', { hasText: teacher.email }).first();
    await card.waitFor({ state: 'visible', timeout: 10000 });
    r.check('ADM 帳號審核頁：待啟用帳號顯示「待確認 Email」、沒有「核准新講師」、改給「到講師主檔確認 Email」',
      (await card.getByTestId('awaiting-activation-chip').textContent()).includes('待確認 Email')
      && await card.getByRole('button', { name: /核准新講師/ }).count() === 0
      && await card.getByRole('link', { name: /到講師主檔確認 Email/ }).isVisible());

    await api.rpc(ctx.base.admin.token, 'admin_confirm_instructor_email', { p_instructor_id: slot.id, p_email: teacher.email, p_note: '10/20 LINE 確認（E2E）' });
    await stepCheck('awaiting_email_verify', '待信箱驗證', '管理員確認 Email');
    await goto(ctx, admin, '/admin/teachers');
    r.check('ADM 帳號審核頁：確認 Email 後標籤變「待信箱驗證」', (await page.locator('.bh-card', { hasText: teacher.email }).first().getByTestId('awaiting-activation-chip').textContent()).includes('待信箱驗證'));

    const complete = {
      nickname: '進度老師', gender: '男', birth_date: '1991-01-01', id_number: 'F123456789', phone_mobile: '0955111222', line_id: 'line-progress',
      address: '臺北市', household_address: '臺北市', email_primary: teacher.email, teaching_freq_semester: '每週 1 次', teaching_freq_vacation: '每週 1 次',
      teaching_regions: ['臺北市'], bio_notes: '進度追蹤用', bank_account_name: name, bank_name: '華南銀行', bank_branch: '總行',
      bank_account_number: '123123123123', bank_code: '0080000',
      id_front_path: `instructors/${teacher.id}/id_front/a.png`, id_back_path: `instructors/${teacher.id}/id_back/a.png`, bankbook_path: `instructors/${teacher.id}/bankbook/a.png`,
    };
    const filled = await api.rest(teacher.token, 'PATCH', `instructors?user_id=eq.${teacher.id}`, { body: complete });
    const afterFill = await stepCheck('awaiting_email_verify', '待信箱驗證', `老師補齊資料（HTTP ${filled.status}）`);
    ctx.findings.add(`ADM（設計行為，記錄）進度順序和派工單預期不同：待啟用（pending）期間不論資料是否補齊都顯示「待確認 Email／待信箱驗證」；「資料未完整」只會出現在已啟用的老師（src/lib/instructorProgress.js 的 getInstructorProgress 判斷順序：未認領 → 待審核 → 待確認 Email → 待信箱驗證 → 資料未完整 → 待簽約 → 已完成）。測試以「已啟用老師清掉 Line ID」走到「資料未完整」。（補齊資料當下「資料未完整」共 ${afterFill.incomplete?.count} 位）`);

    await api.rpc(teacher.token, 'request_email_otp', { p_purpose: 'account_activation' });
    const otp = latestOtp(api, teacher.id, 'account_activation');
    const verified = await api.rpc(teacher.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
    await stepCheck('awaiting_contract', '待簽約', `老師用 OTP 啟用（activated=${verified.data?.activated}）`);

    await api.rest(teacher.token, 'PATCH', `instructors?user_id=eq.${teacher.id}`, { body: { line_id: '' } });
    await stepCheck('incomplete', '資料未完整', '已啟用老師把必填的 Line ID 清空');
    await api.rest(teacher.token, 'PATCH', `instructors?user_id=eq.${teacher.id}`, { body: { line_id: 'line-progress' } });
    await stepCheck('awaiting_contract', '待簽約', '補回 Line ID');

    await signViaRest(ctx.stack, api, teacher);
    await stepCheck('complete', '已完成', '老師完成簽約');
    await dualShot(ctx, admin, 'ADM-04-progress-complete');
  } finally {
    ctx.consoleErrors.push(...admin.consoleErrors.map((e) => `ADM-2: ${e}`));
    await admin.context.close();
  }
}

// ═══ ADM-3 後台首頁：「待審核作業」只算沒有回饋的作業；「老師資料追蹤」＝講師總覽的「還沒完成」═══
export async function scenarioAdminDashboard(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const teacher = await makeActiveTeacherViaRest(ctx.stack, api, ctx.base.admin, { emailPrefix: 'adm-homework' });
  const lessonId = api.sql(`INSERT INTO public.lessons (course_id, title, is_published) VALUES (:'course', 'E2E 作業章節', true) RETURNING id`, { course: ctx.base.courseId });
  const ids = [1, 2, 3].map((n) => api.sql(`INSERT INTO public.assignments (user_id, lesson_id, type, content) VALUES (:'uid', :'lesson', 'text', :'c') RETURNING id`,
    { uid: teacher.id, lesson: lessonId, c: `第 ${n} 份心得` }));
  api.sql(`INSERT INTO public.assignment_feedbacks (assignment_id, user_id, body) VALUES (:'aid', :'admin', '寫得很好')`, { aid: ids[0], admin: ctx.base.admin.id });
  const expected = Number(api.sql(`SELECT count(*) FROM public.assignments a WHERE NOT EXISTS (SELECT 1 FROM public.assignment_feedbacks f WHERE f.assignment_id = a.id)`));
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    await goto(ctx, admin, '/admin/instructors');
    const chips = await readProgressChips(admin.page);
    await goto(ctx, admin, '/admin');
    const homework = admin.page.locator('.bh-card', { hasText: '待審核作業' }).first();
    await homework.waitFor({ state: 'visible', timeout: 15000 });
    const shown = Number((await homework.locator('.text-4xl').innerText()).trim());
    r.check('ADM 後台首頁「待審核作業」＝ 3 份作業扣掉 1 份已有回饋 ＝ 2', shown === 2 && expected === 2, `畫面 ${shown}／資料庫 ${expected}`);
    const tracking = admin.page.getByRole('link', { name: /老師資料追蹤/ });
    const trackingCount = Number((await tracking.locator('.text-4xl').innerText()).trim());
    const breakdown = await tracking.innerText();
    r.check('ADM「老師資料追蹤」數字＝講師總覽「還沒完成」人數，並列出各階段（含待確認 Email、待信箱驗證）',
      trackingCount === chips.todo.count && breakdown.includes('待確認 Email') && breakdown.includes('待信箱驗證'), `首頁 ${trackingCount}／總覽 ${chips.todo.text}`);
    await dualShot(ctx, admin, 'ADM-05-dashboard');
    await tracking.click();
    await admin.page.waitForURL(/\/admin\/instructors\?progress=todo/, { timeout: 10000 }).catch(() => {});
    r.check('ADM 點「老師資料追蹤」直接到「還沒完成」名單', /progress=todo/.test(admin.page.url()));
  } finally {
    ctx.consoleErrors.push(...admin.consoleErrors.map((e) => `ADM-3: ${e}`));
    await admin.context.close();
  }
}

// ═══ ADM-4 帳號審核頁：新建帳號與未認領空位同名 → 警示 ═══
export async function scenarioAdminTeacherManager(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const name = '同名警示老師';
  const newcomer = await newUser(ctx, 'adm-newcomer', name);
  const own = await api.rest(newcomer.token, 'POST', 'instructors', { body: { user_id: newcomer.id, full_name: name, email_primary: newcomer.email }, prefer: 'return=minimal' });
  await adminCreateInstructor(api, ctx.base.admin, { full_name: name, name_slot: true, instructor_role: '實習', employment_status: 'active' });
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    await goto(ctx, admin, '/admin/teachers');
    const card = admin.page.locator('.bh-card', { hasText: newcomer.email }).first();
    await card.waitFor({ state: 'visible', timeout: 15000 });
    r.check('ADM 帳號審核頁：新建帳號與未認領空位同名 → 顯示同名空位警示', own.status === 201 && await card.getByTestId('same-name-slot-warning').isVisible());
    r.check('ADM 新建帳號（沒有啟用紀錄）仍走「核准新講師」，資料未完整時按鈕停用', await card.getByRole('button', { name: /核准新講師/ }).isDisabled());
    await card.scrollIntoViewIfNeeded();
    await dualShot(ctx, admin, 'ADM-06-teacher-manager');
  } finally {
    ctx.consoleErrors.push(...admin.consoleErrors.map((e) => `ADM-4: ${e}`));
    await admin.context.close();
  }
}

// ═══ ADM-5 輔導員視角：看得到資料進度，看不到簽約（合約管理頁、簽約紀錄、證據都讀不到）═══
export async function scenarioAdminMentor(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const mentor = await createMentor(ctx.stack, api);
  r.check('ADM 名單上的 mentor Email 登入後角色是 mentor', roleOf(ctx, mentor.id) === 'mentor');
  const signer = ctx.state.aTeacher?.contractId ? ctx.state.aTeacher : await (async () => {
    const t = await makeActiveTeacherViaRest(ctx.stack, api, ctx.base.admin, { emailPrefix: 'adm-mentor-signer' });
    const signed = await signViaRest(ctx.stack, api, t);
    return { ...t, contractId: signed.contract_id };
  })();
  const s = await openAs(ctx.browser, ctx.stack, mentor);
  try {
    await goto(ctx, s, '/admin/instructors');
    const chips = await readProgressChips(s.page);
    r.check('ADM 輔導員看得到資料進度篩選，但沒有「待簽約／已完成」，改為「資料已完整」',
      Boolean(chips.profile_ready) && !chips.awaiting_contract && !chips.complete && Boolean(chips.unclaimed), Object.keys(chips).join(','));
    r.check('ADM 輔導員畫面說明「簽約狀態只有管理員看得到」', await s.page.getByText('簽約狀態只有管理員看得到').isVisible());
    await dualShot(ctx, s, 'ADM-07-mentor-progress');
    await goto(ctx, s, '/admin/contracts');
    await sleep(1500);
    r.check('ADM 輔導員開 /admin/contracts 被導走（合約管理只限管理員）', !/\/admin\/contracts/.test(s.page.url()), s.page.url());
    const contracts = await api.rest(mentor.token, 'GET', 'instructor_contracts?select=id');
    const evidence = await api.rest(mentor.token, 'GET', 'contract_signing_evidence?select=id');
    const consent = await api.rest(mentor.token, 'GET', 'contract_consent_records?select=id');
    r.check('ADM 輔導員用 REST 也讀不到簽約紀錄、簽署證據、同意紀錄', contracts.data?.length === 0 && evidence.data?.length === 0 && consent.data?.length === 0);
    const pdfPath = api.sql(`SELECT signed_pdf_paths->>'contract' FROM public.instructor_contracts WHERE id = :'id'`, { id: signer.contractId });
    const file = await api.request(mentor.token, 'GET', `/storage/v1/object/authenticated/contract-documents/${pdfPath}`);
    if (file.status === 200) {
      ctx.known('ADM 輔導員讀得到所有人的已簽契約檔', `ADM［待業主決定］storage 政策讓 mentor 讀整個 contract-documents（含所有人的 signed/）：supabase/migrations/20261019103000_restrict_contract_document_reads.sql 的「read contract documents scoped」，註解已寫「mentor 是否該讀待業主決定」。畫面上輔導員看不到簽約，但知道路徑就能下載已簽 PDF（身分證字號、地址都在上面）。`);
    }
    r.check('ADM 記錄：輔導員直接下載已簽契約檔的結果', [200, 400].includes(file.status), `HTTP ${file.status}`);
  } finally {
    ctx.consoleErrors.push(...s.consoleErrors.map((e) => `ADM-5: ${e}`));
    await s.context.close();
  }
}

// ═══ ADM-6 合約管理：證據面板、驗證檔案完整性、驗證證據鏈（竄改後的情境在 SEC 最後一步）═══
export async function openEvidencePanel(ctx, admin, userId, email) {
  await goto(ctx, admin, '/admin/contracts');
  // 簽約狀態總覽預設只列前 20 位；先用搜尋框縮到這位講師
  if (email) await admin.page.getByPlaceholder('搜尋講師...').fill(email);
  const toggle = admin.page.getByTestId(`toggle-evidence-${userId}`);
  await toggle.waitFor({ state: 'visible', timeout: 15000 });
  await toggle.click();
  const panel = admin.page.getByTestId('evidence-panel').first();
  await panel.waitFor({ state: 'visible', timeout: 15000 });
  return panel;
}

export async function scenarioAdminEvidence(ctx) {
  const r = ctx.r;
  const { api } = ctx;
  const signer = ctx.state.aTeacher?.contractId ? ctx.state.aTeacher : await (async () => {
    const t = await makeActiveTeacherViaRest(ctx.stack, api, ctx.base.admin, { emailPrefix: 'adm-evidence' });
    const signed = await signViaRest(ctx.stack, api, t);
    return { ...t, contractId: signed.contract_id };
  })();
  const admin = await openAs(ctx.browser, ctx.stack, ctx.base.admin, { label: 'admin' });
  try {
    const panel = await openEvidencePanel(ctx, admin, signer.id, signer.email);
    const text = await panel.innerText();
    const contract = api.json(`SELECT row_to_json(c) FROM public.instructor_contracts c WHERE id = :'id'`, { id: signer.contractId });
    const evidence = api.json(`SELECT row_to_json(e) FROM public.contract_signing_evidence e WHERE id = :'id'`, { id: contract.evidence_id });
    r.check('ADM 證據面板顯示簽署紀錄、同意與 Email 驗證、檔案指紋與證據鏈、通知信寄送紀錄',
      text.includes('簽署紀錄') && text.includes('電子簽約同意與 Email 驗證') && text.includes('檔案指紋（SHA-256）與證據鏈')
      && text.includes(evidence.otp_challenge_id) && await panel.getByTestId('delivery-log').isVisible(), text.slice(0, 120).replace(/\s+/g, ' '));
    await panel.getByTestId('verify-files').click();
    const integrity = panel.getByTestId('integrity-result');
    await integrity.waitFor({ state: 'visible', timeout: 20000 });
    r.check('ADM「驗證檔案完整性」：重新下載算 SHA-256 → 一致', (await integrity.innerText()).includes('檔案完整性：一致'), (await integrity.innerText()).slice(0, 80));
    await panel.getByTestId('verify-chain').click();
    const chain = panel.getByTestId('chain-result');
    await chain.waitFor({ state: 'visible', timeout: 15000 });
    r.check('ADM「驗證證據鏈」：完整、沒有被改動', (await chain.innerText()).includes('證據鏈：完整'), (await chain.innerText()).slice(0, 80));
    await dualShot(ctx, admin, 'ADM-08-evidence-panel');
  } finally {
    ctx.consoleErrors.push(...admin.consoleErrors.map((e) => `ADM-6: ${e}`));
    await admin.context.close();
  }
}

export const ADMIN_SCENARIOS = {
  ADM1: scenarioAdminSlots,
  ADM2: scenarioAdminProgress,
  ADM3: scenarioAdminDashboard,
  ADM4: scenarioAdminTeacherManager,
  ADM5: scenarioAdminMentor,
  ADM6: scenarioAdminEvidence,
};

export { createGoogleUser, activationOf, pollUntil };
