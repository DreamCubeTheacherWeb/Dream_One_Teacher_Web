import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVATION_BUTTON_LABEL,
  ACTIVATION_STATES,
  describeConfirmEmailError,
  describeConfirmedEmailMethod,
  interpretActivationStatus,
  normalizeEmail,
  validateEmailConfirmation,
} from './accountActivation.js';

test('讀不到啟用狀態（RPC 失敗）時什麼都不顯示，維持舊行為', () => {
  for (const raw of [null, undefined, 'x', {}, { status: '怪' }]) {
    const result = interpretActivationStatus(raw);
    assert.equal(result.state, ACTIVATION_STATES.UNKNOWN);
    assert.equal(result.pending, false);
    assert.equal(result.showButton, false);
  }
});

test('none 與 active 不顯示啟用提示', () => {
  assert.equal(interpretActivationStatus({ status: 'none' }).state, 'none');
  assert.equal(interpretActivationStatus({ status: 'none' }).pending, false);
  const active = interpretActivationStatus({ status: 'active', claim_method: 'legacy_pre_activation' });
  assert.equal(active.state, 'active');
  assert.equal(active.pending, false);
  assert.equal(active.showButton, false);
});

test('待啟用＋公司尚未確認 Email：提示聯絡行政人員，不給按鈕（即使資料已完整）', () => {
  for (const profileComplete of [true, false]) {
    const result = interpretActivationStatus({ status: 'pending', has_confirmed_email: false, masked_email: null, profile_complete: profileComplete });
    assert.equal(result.state, ACTIVATION_STATES.NEEDS_EMAIL_CONFIRMATION);
    assert.equal(result.pending, true);
    assert.equal(result.showButton, false);
    assert.equal(result.message, '你的 Email 尚未經公司確認，請聯絡行政人員確認後才能啟用帳號。');
  }
});

test('待啟用＋已確認 Email＋資料未完整：請先補齊資料，指向啟用按鈕，不給按鈕', () => {
  const result = interpretActivationStatus({ status: 'pending', has_confirmed_email: true, masked_email: 'ab***@gmail.com', profile_complete: false });
  assert.equal(result.state, ACTIVATION_STATES.NEEDS_PROFILE);
  assert.equal(result.showButton, false);
  assert.ok(result.message.includes(`「${ACTIVATION_BUTTON_LABEL}」`));
  assert.ok(result.message.includes('儲存個人資料'));
});

test('待啟用＋已確認 Email＋資料完整：顯示主按鈕與遮罩信箱', () => {
  const result = interpretActivationStatus({ status: 'pending', has_confirmed_email: true, masked_email: 'ab***@gmail.com', profile_complete: true });
  assert.equal(result.state, ACTIVATION_STATES.READY);
  assert.equal(result.showButton, true);
  assert.equal(result.maskedEmail, 'ab***@gmail.com');
  assert.ok(result.message.includes('ab***@gmail.com'));
  assert.equal(ACTIVATION_BUTTON_LABEL, '確認資料無誤，驗證信箱啟用帳號');
});

test('確認方式標示', () => {
  assert.equal(describeConfirmedEmailMethod('company_existing_record'), '公司既有資料登錄');
  assert.equal(describeConfirmedEmailMethod('admin_trusted_channel'), '管理員經可信管道確認');
  assert.match(describeConfirmedEmailMethod('google_login_new_instructor'), /Google 登入信箱/);
  assert.equal(describeConfirmedEmailMethod('未知'), '未知');
  assert.equal(describeConfirmedEmailMethod(null), '');
});

test('確認 Email 表單：Email 轉小寫去空白、格式檢查、管道註記必填', () => {
  assert.equal(normalizeEmail('  Ab@Gmail.COM '), 'ab@gmail.com');

  const ok = validateEmailConfirmation({ email: ' Teacher@Example.com ', note: ' 10/20 透過 LINE 與老師確認 ' });
  assert.equal(ok.ok, true);
  assert.equal(ok.email, 'teacher@example.com');
  assert.equal(ok.note, '10/20 透過 LINE 與老師確認');

  const noEmail = validateEmailConfirmation({ email: '', note: '透過電話與本人確認' });
  assert.equal(noEmail.ok, false);
  assert.ok(noEmail.errors.email);

  const badEmail = validateEmailConfirmation({ email: 'abc', note: '透過電話與本人確認' });
  assert.equal(badEmail.ok, false);
  assert.match(badEmail.errors.email, /格式/);

  const noNote = validateEmailConfirmation({ email: 'a@b.co', note: '  ' });
  assert.equal(noNote.ok, false);
  assert.ok(noNote.errors.note);
  assert.equal(validateEmailConfirmation({ email: 'a@b.co', note: '短' }).ok, false);
});

test('確認 Email 失敗訊息', () => {
  assert.match(describeConfirmEmailError({ message: 'permission denied' }), /只有管理員/);
  assert.match(describeConfirmEmailError({ message: 'duplicate key 23505' }), /已經被其他講師使用/);
  assert.match(describeConfirmEmailError({ message: 'NOTE_REQUIRED' }), /管道註記/);
  assert.match(describeConfirmEmailError({ message: 'INVALID_EMAIL' }), /格式不正確/);
  assert.match(describeConfirmEmailError({ message: 'INSTRUCTOR_NOT_FOUND' }), /找不到這位講師/);
  assert.match(describeConfirmEmailError({ message: 'boom' }), /確認失敗：boom/);
});
