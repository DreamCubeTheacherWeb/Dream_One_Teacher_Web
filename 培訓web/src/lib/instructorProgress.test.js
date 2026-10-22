import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INSTRUCTOR_PROGRESS_COLUMNS,
  PROGRESS_STAGES,
  buildActivationMap,
  buildProgressRows,
  buildSignedUserIdSet,
  countProgress,
  getInstructorProgress,
  getVisibleProgressStages,
  hasConfirmedEmail,
  isProgressFilterKey,
  matchesProgressFilter,
} from './instructorProgress.js';
import {
  REQUIRED_PROFILE_DOCUMENTS,
  REQUIRED_PROFILE_FIELDS,
  getInstructorProfileCompletion,
} from './profileCompletion.js';

const UID = '00000000-0000-4000-8000-000000000001';
const UID2 = '00000000-0000-4000-8000-000000000002';

// 所有必填欄位、接課地區與三份文件都有的主檔。
const completeInstructor = (overrides = {}) => {
  const row = { id: 'inst-1', user_id: UID, employment_status: 'active', teaching_regions: ['臺北市'] };
  REQUIRED_PROFILE_FIELDS.forEach(({ key }) => { row[key] = `值-${key}`; });
  REQUIRED_PROFILE_DOCUMENTS.forEach(({ key }) => { row[`${key}_path`] = `${key}.jpg`; });
  return { ...row, ...overrides };
};

const signed = new Set([UID]);

test('測試用的完整主檔確實沒有缺項', () => {
  assert.equal(getInstructorProfileCompletion(completeInstructor()).complete, true);
});

test('已停用（冷凍／離職）優先於所有其他階段，即使沒有認領或待審核', () => {
  const frozenUnclaimed = getInstructorProgress({ user_id: null, employment_status: 'frozen' });
  assert.equal(frozenUnclaimed.key, 'disabled');
  assert.equal(frozenUnclaimed.label, '已停用');

  const cancelledPending = getInstructorProgress(
    completeInstructor({ employment_status: 'cancelled' }),
    { userRole: 'pending', signedUserIds: signed },
  );
  assert.equal(cancelledPending.key, 'disabled');
  assert.equal(cancelledPending.todo, false);
});

test('沒有綁定登入帳號就是未認領，缺項數照主檔計算', () => {
  const slot = { full_name: '王小明', user_id: null, employment_status: 'active', name_slot: true };
  const empty = getInstructorProgress(slot);
  assert.equal(empty.key, 'unclaimed');
  assert.equal(empty.label, '未認領');
  assert.equal(empty.todo, true);
  // 只填了姓名的空位：總項目 22 項裡只有姓名有值，其餘 21 項都缺
  assert.equal(empty.missingCount, getInstructorProfileCompletion({}).totalItems - 1);
  assert.equal(empty.missingCount, 21);

  // 匯入的完整舊資料但還沒人認領：仍是未認領（認領排在資料完整度前面）
  const imported = getInstructorProgress(completeInstructor({ user_id: null }));
  assert.equal(imported.key, 'unclaimed');
  assert.equal(imported.missingCount, 0);
});

test('已綁帳號但 users.role 還是 pending，是新建帳號待審核（不論資料完整與否）', () => {
  const incompletePending = getInstructorProgress(
    completeInstructor({ nickname: '' }),
    { userRole: 'pending', signedUserIds: signed },
  );
  assert.equal(incompletePending.key, 'pending_review');
  assert.equal(incompletePending.label, '待審核');
  assert.equal(incompletePending.missingCount, 1);

  const completePending = getInstructorProgress(completeInstructor(), { userRole: 'pending', signedUserIds: signed });
  assert.equal(completePending.key, 'pending_review');
  assert.equal(completePending.missingCount, 0);
});

test('已開通但資料缺漏是資料未完整，並回報缺項數與缺項名稱', () => {
  const progress = getInstructorProgress(
    completeInstructor({ nickname: '', bank_code: '  ', id_front_path: null, teaching_regions: [] }),
    { userRole: 'teacher', signedUserIds: signed },
  );
  assert.equal(progress.key, 'incomplete');
  assert.equal(progress.label, '資料未完整');
  assert.equal(progress.todo, true);
  assert.equal(progress.missingCount, 4);
  assert.deepEqual(
    [...progress.missingItems].sort(),
    ['主要接課地區', '身分證正面', '講師暱稱', '銀行代碼'].sort(),
  );
});

test('資料完整但沒有 signed 合約是待簽約；voided 不算簽約', () => {
  const noContract = getInstructorProgress(completeInstructor(), { userRole: 'teacher', signedUserIds: new Set() });
  assert.equal(noContract.key, 'awaiting_contract');
  assert.equal(noContract.label, '待簽約');
  assert.equal(noContract.todo, true);

  const onlyVoided = buildSignedUserIdSet([{ user_id: UID, status: 'voided' }]);
  const voided = getInstructorProgress(completeInstructor(), { userRole: 'teacher', signedUserIds: onlyVoided });
  assert.equal(voided.key, 'awaiting_contract');

  // 別人簽了不算我
  const otherSigned = getInstructorProgress(completeInstructor(), { userRole: 'teacher', signedUserIds: new Set([UID2]) });
  assert.equal(otherSigned.key, 'awaiting_contract');
});

test('資料完整且有 signed 合約是已完成；舊合約作廢後又有新的 signed 仍是已完成', () => {
  const done = getInstructorProgress(completeInstructor(), { userRole: 'teacher', signedUserIds: signed });
  assert.equal(done.key, 'complete');
  assert.equal(done.label, '已完成');
  assert.equal(done.todo, false);
  assert.equal(done.missingCount, 0);

  const resigned = buildSignedUserIdSet([
    { user_id: UID, status: 'voided' },
    { user_id: UID, status: 'signed' },
  ]);
  assert.equal(
    getInstructorProgress(completeInstructor(), { userRole: 'teacher', signedUserIds: resigned }).key,
    'complete',
  );
});

test('讀不到簽約紀錄（signedUserIds 為 null）時，資料完整的人是「資料已完整」而不是待簽約或已完成', () => {
  assert.equal(buildSignedUserIdSet(null), null);
  assert.equal(buildSignedUserIdSet(undefined), null);

  const unknown = getInstructorProgress(completeInstructor(), { userRole: 'teacher', signedUserIds: null });
  assert.equal(unknown.key, 'profile_ready');
  assert.equal(unknown.todo, false);

  // 前面的階段不受影響
  assert.equal(getInstructorProgress({ user_id: null }, { signedUserIds: null }).key, 'unclaimed');
  assert.equal(
    getInstructorProgress(completeInstructor({ nickname: '' }), { userRole: 'teacher', signedUserIds: null }).key,
    'incomplete',
  );
});

test('讀不到 users.role 時不會被誤判成待審核', () => {
  const progress = getInstructorProgress(completeInstructor(), { userRole: null, signedUserIds: signed });
  assert.equal(progress.key, 'complete');
});

test('buildProgressRows 依綁定帳號的 role 帶入待審核判斷，並能統計各階段與「還沒完成」', () => {
  const instructors = [
    { id: 'a', user_id: null, employment_status: 'active', name_slot: true },
    { id: 'b', user_id: UID2, employment_status: 'active' },
    completeInstructor({ id: 'c', user_id: 'user-c', nickname: '' }),
    completeInstructor({ id: 'd', user_id: 'user-d' }),
    completeInstructor({ id: 'e', user_id: UID }),
    { id: 'f', user_id: null, employment_status: 'cancelled' },
  ];
  const usersById = new Map([
    [UID2, { role: 'pending', email: 'b@example.com' }],
    ['user-c', { role: 'teacher' }],
    ['user-d', { role: 'teacher' }],
    [UID, { role: 'teacher' }],
  ]);
  const rows = buildProgressRows(instructors, { usersById, signedUserIds: signed });
  assert.deepEqual(
    rows.map((row) => [row.instructor.id, row.progress.key]),
    [
      ['a', 'unclaimed'],
      ['b', 'pending_review'],
      ['c', 'incomplete'],
      ['d', 'awaiting_contract'],
      ['e', 'complete'],
      ['f', 'disabled'],
    ],
  );

  const counts = countProgress(rows);
  assert.equal(counts.total, 6);
  assert.equal(counts.todo, 4);
  assert.deepEqual(counts.byKey, {
    unclaimed: 1,
    pending_review: 1,
    awaiting_email_confirm: 0,
    awaiting_email_verify: 0,
    incomplete: 1,
    awaiting_contract: 1,
    complete: 1,
    disabled: 1,
    profile_ready: 0,
  });
});

test('篩選：todo 只包含未認領、待審核、待確認 Email、待信箱驗證、資料未完整、待簽約', () => {
  const stageKeys = PROGRESS_STAGES.filter((stage) => stage.todo).map((stage) => stage.key);
  assert.deepEqual(stageKeys, [
    'unclaimed',
    'pending_review',
    'awaiting_email_confirm',
    'awaiting_email_verify',
    'incomplete',
    'awaiting_contract',
  ]);

  const rows = [
    'unclaimed', 'pending_review', 'awaiting_email_confirm', 'awaiting_email_verify',
    'incomplete', 'awaiting_contract', 'complete', 'disabled', 'profile_ready',
  ]
    .map((key) => ({ key, todo: stageKeys.includes(key) }));
  assert.deepEqual(
    rows.filter((progress) => matchesProgressFilter(progress, 'todo')).map((progress) => progress.key),
    stageKeys,
  );
  assert.deepEqual(
    rows.filter((progress) => matchesProgressFilter(progress, 'complete')).map((progress) => progress.key),
    ['complete'],
  );
  assert.equal(rows.every((progress) => matchesProgressFilter(progress, '')), true);
  assert.equal(matchesProgressFilter(undefined, 'todo'), false);
});

test('網址參數只接受已知的篩選 key', () => {
  [
    'todo', 'unclaimed', 'pending_review', 'awaiting_email_confirm', 'awaiting_email_verify',
    'incomplete', 'awaiting_contract', 'complete', 'disabled', 'profile_ready',
  ].forEach((key) => assert.equal(isProgressFilterKey(key), true, key));
  ['', 'all', 'linked', null, undefined].forEach((key) => assert.equal(isProgressFilterKey(key), false, String(key)));
});

test('後台首頁只撈進度需要的欄位，且涵蓋必填欄位與三份文件的路徑與外部連結', () => {
  REQUIRED_PROFILE_FIELDS.forEach(({ key }) => assert.ok(INSTRUCTOR_PROGRESS_COLUMNS.includes(key), key));
  REQUIRED_PROFILE_DOCUMENTS.forEach(({ key }) => {
    assert.ok(INSTRUCTOR_PROGRESS_COLUMNS.includes(`${key}_path`), `${key}_path`);
    assert.ok(INSTRUCTOR_PROGRESS_COLUMNS.includes(`${key}_external_url`), `${key}_external_url`);
  });
  ['id', 'user_id', 'employment_status', 'name_slot', 'teaching_regions', 'confirmed_email'].forEach((key) => (
    assert.ok(INSTRUCTOR_PROGRESS_COLUMNS.includes(key), key)
  ));
  assert.equal(new Set(INSTRUCTOR_PROGRESS_COLUMNS).size, INSTRUCTOR_PROGRESS_COLUMNS.length);

  // 只靠這些欄位算出的完整度，要與整列算出的一致
  const full = completeInstructor({ line_name: '舊暱稱', bio_personal_experience: '經歷', note_internal: '內部' });
  const slim = Object.fromEntries(INSTRUCTOR_PROGRESS_COLUMNS.map((key) => [key, full[key]]));
  assert.equal(
    getInstructorProfileCompletion(slim).missingItems.length,
    getInstructorProfileCompletion(full).missingItems.length,
  );
});

// ── 認領後帳號啟用（規格 2026-10-20）：待確認 Email／待信箱驗證 ──

const pendingActivations = (...userIds) => buildActivationMap(
  userIds.map((user_id) => ({ user_id, status: 'pending', claim_method: 'name_slot' })),
);

test('已認領待啟用（有 pending 啟用紀錄）且公司還沒確認 Email：待確認 Email，不論資料完整與否', () => {
  const activationsByUserId = pendingActivations(UID);
  for (const instructor of [completeInstructor(), completeInstructor({ nickname: '' }), completeInstructor({ confirmed_email: '   ' })]) {
    const progress = getInstructorProgress(instructor, { userRole: 'pending', signedUserIds: signed, activationsByUserId });
    assert.equal(progress.key, 'awaiting_email_confirm');
    assert.equal(progress.label, '待確認 Email');
    assert.equal(progress.todo, true);
  }
});

test('已認領待啟用且 Email 已確認：待信箱驗證（資料缺漏數照實回報）', () => {
  const activationsByUserId = pendingActivations(UID);
  const progress = getInstructorProgress(
    completeInstructor({ confirmed_email: 'teacher@example.com', nickname: '' }),
    { userRole: 'pending', signedUserIds: signed, activationsByUserId },
  );
  assert.equal(progress.key, 'awaiting_email_verify');
  assert.equal(progress.label, '待信箱驗證');
  assert.equal(progress.todo, true);
  assert.equal(progress.missingCount, 1);
});

test('pending 帳號沒有啟用紀錄＝新建帳號待審核；有 confirmed_email 也一樣（不靠它判斷）', () => {
  const activationsByUserId = pendingActivations(UID2);
  const progress = getInstructorProgress(
    completeInstructor({ confirmed_email: 'teacher@example.com' }),
    { userRole: 'pending', signedUserIds: signed, activationsByUserId },
  );
  assert.equal(progress.key, 'pending_review');
});

test('讀不到啟用紀錄（輔導員）：有 confirmed_email 的 pending 帳號判成待信箱驗證，沒有的無法區分、維持待審核', () => {
  const withEmail = getInstructorProgress(
    completeInstructor({ confirmed_email: 'teacher@example.com' }),
    { userRole: 'pending', signedUserIds: null, activationsByUserId: null },
  );
  assert.equal(withEmail.key, 'awaiting_email_verify');

  const withoutEmail = getInstructorProgress(completeInstructor(), { userRole: 'pending', activationsByUserId: null });
  assert.equal(withoutEmail.key, 'pending_review');
});

test('啟用成 teacher 之後不再算啟用階段，回到資料／簽約階段；停用與未認領優先', () => {
  const activationsByUserId = pendingActivations(UID);
  const activated = getInstructorProgress(
    completeInstructor({ confirmed_email: 'teacher@example.com' }),
    { userRole: 'teacher', signedUserIds: signed, activationsByUserId },
  );
  assert.equal(activated.key, 'complete');

  assert.equal(
    getInstructorProgress(completeInstructor({ employment_status: 'frozen' }), { userRole: 'pending', activationsByUserId }).key,
    'disabled',
  );
  assert.equal(
    getInstructorProgress(completeInstructor({ user_id: null }), { userRole: 'pending', activationsByUserId }).key,
    'unclaimed',
  );
});

test('啟用紀錄只收 status=pending 的列；非陣列回 null', () => {
  const map = buildActivationMap([
    { user_id: 'u1', status: 'pending' },
    { user_id: 'u2', status: 'active' },
    { user_id: 'u3', status: 'revoked' },
    { user_id: null, status: 'pending' },
  ]);
  assert.deepEqual([...map.keys()], ['u1']);
  assert.equal(buildActivationMap(null), null);
  assert.equal(buildActivationMap(undefined), null);
  assert.equal(buildActivationMap([]).size, 0);
});

test('hasConfirmedEmail 去除空白判斷', () => {
  assert.equal(hasConfirmedEmail({ confirmed_email: 'a@b.co' }), true);
  assert.equal(hasConfirmedEmail({ confirmed_email: '  ' }), false);
  assert.equal(hasConfirmedEmail({ confirmed_email: null }), false);
  assert.equal(hasConfirmedEmail({}), false);
  assert.equal(hasConfirmedEmail(undefined), false);
});

test('buildProgressRows 帶入啟用紀錄，並統計新階段', () => {
  const instructors = [
    completeInstructor({ id: 'a', user_id: 'ua' }),
    completeInstructor({ id: 'b', user_id: 'ub', confirmed_email: 'b@example.com' }),
    completeInstructor({ id: 'c', user_id: 'uc' }),
  ];
  const usersById = new Map([['ua', { role: 'pending' }], ['ub', { role: 'pending' }], ['uc', { role: 'pending' }]]);
  const rows = buildProgressRows(instructors, { usersById, activationsByUserId: pendingActivations('ua', 'ub') });
  assert.deepEqual(rows.map((row) => row.progress.key), ['awaiting_email_confirm', 'awaiting_email_verify', 'pending_review']);
  const counts = countProgress(rows);
  assert.equal(counts.todo, 3);
  assert.equal(counts.byKey.awaiting_email_confirm, 1);
  assert.equal(counts.byKey.awaiting_email_verify, 1);
});

test('篩選列的階段：讀不到的資訊對應的階段不顯示', () => {
  const keys = (options) => getVisibleProgressStages(options).map((stage) => stage.key);
  assert.deepEqual(keys({ contractKnown: true, activationKnown: true }), [
    'unclaimed', 'pending_review', 'awaiting_email_confirm', 'awaiting_email_verify',
    'incomplete', 'awaiting_contract', 'complete', 'disabled',
  ]);
  // 輔導員：看不到啟用紀錄與簽約紀錄
  assert.deepEqual(keys({ contractKnown: false, activationKnown: false }), [
    'unclaimed', 'pending_review', 'awaiting_email_verify', 'incomplete', 'profile_ready', 'disabled',
  ]);
  assert.deepEqual(keys({ contractKnown: true, activationKnown: false }), [
    'unclaimed', 'pending_review', 'awaiting_email_verify', 'incomplete', 'awaiting_contract', 'complete', 'disabled',
  ]);
});

test('人員類別：純職員／工讀計時免填接課欄位、不需簽約；兼任講師照講師規則', () => {
  const staffOnly = (overrides = {}) => completeInstructor({
    personnel_types: ['staff'],
    teaching_freq_semester: null,
    teaching_freq_vacation: '',
    bio_notes: null,
    teaching_regions: [],
    ...overrides,
  });
  const noContracts = new Set();
  // 缺的只有講師專屬欄位：不算資料未完整；沒簽約也不算待簽約
  assert.equal(getInstructorProgress(staffOnly(), { userRole: 'teacher', signedUserIds: noContracts }).key, 'complete');
  assert.equal(getInstructorProgress(completeInstructor({ personnel_types: ['part_time'] }), { userRole: 'teacher', signedUserIds: noContracts }).key, 'complete');
  // 簽約狀態讀不到時照舊是「資料已完整」
  assert.equal(getInstructorProgress(staffOnly(), { userRole: 'teacher', signedUserIds: null }).key, 'profile_ready');
  // 職員缺共同必填（例如身分證）仍是資料未完整
  const missingId = getInstructorProgress(staffOnly({ id_number: '' }), { userRole: 'teacher', signedUserIds: noContracts });
  assert.equal(missingId.key, 'incomplete');
  assert.deepEqual(missingId.missingItems, ['身分證字號']);
  // 職員也要先啟用帳號（啟用不分人員類別）
  const activations = new Map([[UID, { user_id: UID, status: 'pending' }]]);
  assert.equal(getInstructorProgress(staffOnly({ confirmed_email: 'a@b.tw' }), { userRole: 'pending', activationsByUserId: activations }).key, 'awaiting_email_verify');
  // 講師＋職員兼任、舊資料沒有人員類別：都照講師規則
  assert.equal(getInstructorProgress(completeInstructor({ personnel_types: ['instructor', 'staff'] }), { userRole: 'teacher', signedUserIds: noContracts }).key, 'awaiting_contract');
  assert.equal(getInstructorProgress(staffOnly({ personnel_types: ['instructor', 'staff'] }), { userRole: 'teacher', signedUserIds: noContracts }).key, 'incomplete');
  assert.equal(getInstructorProgress(completeInstructor(), { userRole: 'teacher', signedUserIds: noContracts }).key, 'awaiting_contract');
  // 後台首頁的輕量查詢要帶人員類別，完整度才會用對規則
  assert.ok(INSTRUCTOR_PROGRESS_COLUMNS.includes('personnel_types'));
});
