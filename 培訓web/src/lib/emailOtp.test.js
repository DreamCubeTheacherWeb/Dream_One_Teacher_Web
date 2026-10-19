import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OTP_PURPOSES,
  describeOtpRpcError,
  formatCountdown,
  getOtpPurposeText,
  interpretRequestResult,
  interpretVerifyResult,
  isOtpComplete,
  normalizeOtpInput,
  secondsUntil,
  secondsUntilIso,
} from './emailOtp.js';

test('驗證碼輸入只留數字、最多 6 碼，全形數字與空白會被清理', () => {
  assert.equal(normalizeOtpInput('123456'), '123456');
  assert.equal(normalizeOtpInput(' 12 34-56 '), '123456');
  assert.equal(normalizeOtpInput('1234567890'), '123456');
  assert.equal(normalizeOtpInput('１２３４５６'), '123456');
  assert.equal(normalizeOtpInput('ab12cd'), '12');
  assert.equal(normalizeOtpInput(null), '');
  assert.equal(normalizeOtpInput(undefined), '');
  assert.equal(isOtpComplete('12345'), false);
  assert.equal(isOtpComplete('１２３４５６'), true);
  assert.equal(isOtpComplete('12 34 56'), true);
});

test('倒數：無條件進位、不會是負數、時間無效回 0', () => {
  assert.equal(secondsUntil(10_000, 0), 10);
  assert.equal(secondsUntil(10_001, 0), 11);
  assert.equal(secondsUntil(0, 10_000), 0);
  assert.equal(secondsUntil(Number.NaN, 0), 0);
  const now = Date.parse('2026-10-20T06:00:00Z');
  assert.equal(secondsUntilIso('2026-10-20T06:05:00Z', now), 300);
  assert.equal(secondsUntilIso('2026-10-20T05:59:00Z', now), 0);
  assert.equal(secondsUntilIso(null, now), 0);
  assert.equal(secondsUntilIso('不是時間', now), 0);
});

test('倒數顯示成 m:ss', () => {
  assert.equal(formatCountdown(300), '5:00');
  assert.equal(formatCountdown(299), '4:59');
  assert.equal(formatCountdown(61), '1:01');
  assert.equal(formatCountdown(9), '0:09');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(-5), '0:00');
  assert.equal(formatCountdown('abc'), '0:00');
});

test('寄送結果：sent 帶回驗證碼資訊，預設重寄冷卻 60 秒', () => {
  const sent = interpretRequestResult({
    status: 'sent', challenge_id: 'c-1', expires_at: '2026-10-20T06:05:00Z', masked_email: 'ab***@gmail.com', resend_after_seconds: 60,
  });
  assert.equal(sent.kind, 'sent');
  assert.equal(sent.challengeId, 'c-1');
  assert.equal(sent.maskedEmail, 'ab***@gmail.com');
  assert.equal(sent.retryAfterSeconds, 60);
  assert.equal(interpretRequestResult({ status: 'sent', challenge_id: 'c-2' }).retryAfterSeconds, 60);
});

test('寄送結果：冷卻中顯示剩餘秒數，沒帶 challenge_id 時前端不假裝有驗證碼可輸入', () => {
  const cooldown = interpretRequestResult({ status: 'cooldown', retry_after_seconds: 42 });
  assert.equal(cooldown.kind, 'cooldown');
  assert.equal(cooldown.retryAfterSeconds, 42);
  assert.equal(cooldown.challengeId, null);
  assert.match(cooldown.message, /42 秒/);

  const resumed = interpretRequestResult({ status: 'cooldown', retry_after_seconds: 10, challenge_id: 'c-9', expires_at: '2026-10-20T06:05:00Z', masked_email: 'x***@y.com' });
  assert.equal(resumed.challengeId, 'c-9');
});

test('寄送結果：所有不能寄的狀態都有白話訊息，且指出是否要找行政人員', () => {
  const rate = interpretRequestResult({ status: 'rate_limited' });
  assert.equal(rate.kind, 'blocked');
  assert.match(rate.message, /每小時最多 5 封/);

  const noEmail = interpretRequestResult({ status: 'no_confirmed_email' });
  assert.equal(noEmail.kind, 'blocked');
  assert.equal(noEmail.needsAdmin, true);
  assert.match(noEmail.message, /尚未確認你的 Email/);

  const incomplete = interpretRequestResult({ status: 'profile_incomplete' });
  assert.equal(incomplete.kind, 'blocked');
  assert.match(incomplete.message, /資料還沒填完整/);

  const notAllowed = interpretRequestResult({ status: 'not_allowed', reason: 'something_new' });
  assert.equal(notAllowed.kind, 'blocked');
  assert.match(notAllowed.message, /something_new/);

  const notConfigured = interpretRequestResult({ status: 'email_not_configured' });
  assert.equal(notConfigured.kind, 'blocked');
  assert.equal(notConfigured.needsAdmin, true);
  assert.match(notConfigured.message, /尚未設定寄信/);

  assert.equal(interpretRequestResult({ status: '亂來' }).kind, 'error');
  assert.equal(interpretRequestResult(null).kind, 'error');
});

test('驗證結果：verified 帶 activated 與驗證時間', () => {
  const ok = interpretVerifyResult({ status: 'verified', verified_at: '2026-10-20T06:01:00Z', activated: true });
  assert.equal(ok.kind, 'verified');
  assert.equal(ok.activated, true);
  assert.equal(ok.verifiedAt, '2026-10-20T06:01:00Z');
  assert.equal(interpretVerifyResult({ status: 'verified' }).activated, false);
});

test('驗證結果：invalid 顯示剩餘次數，剩 0 次視為已失效必須重寄', () => {
  const invalid = interpretVerifyResult({ status: 'invalid', attempts_remaining: 3 });
  assert.equal(invalid.kind, 'invalid');
  assert.equal(invalid.attemptsRemaining, 3);
  assert.equal(invalid.needsNewCode, false);
  assert.match(invalid.message, /還可以再試 3 次/);

  const lastTry = interpretVerifyResult({ status: 'invalid', attempts_remaining: 0 });
  assert.equal(lastTry.kind, 'dead');
  assert.equal(lastTry.needsNewCode, true);

  assert.equal(interpretVerifyResult({ status: 'invalid' }).kind, 'invalid');
});

test('驗證結果：過期、用過、鎖定、被新驗證碼取代都要求重新寄送', () => {
  const cases = {
    expired: /過期/,
    used: /用過/,
    locked: /鎖定/,
    superseded: /更新的驗證碼/,
  };
  for (const [status, pattern] of Object.entries(cases)) {
    const result = interpretVerifyResult({ status });
    assert.equal(result.kind, 'dead', status);
    assert.equal(result.needsNewCode, true, status);
    assert.match(result.message, pattern, status);
  }
  assert.equal(interpretVerifyResult({ status: '???' }).kind, 'error');
  assert.equal(interpretVerifyResult(undefined).kind, 'error');
});

test('RPC 失敗訊息：網路、登入過期、其他', () => {
  assert.match(describeOtpRpcError(new Error('Failed to fetch')), /網路/);
  assert.match(describeOtpRpcError({ message: 'JWT expired' }), /登入狀態/);
  assert.match(describeOtpRpcError({ message: 'boom' }), /暫時無法/);
  assert.match(describeOtpRpcError(null), /暫時無法/);
});

test('兩種用途都有標題與說明', () => {
  for (const purpose of Object.values(OTP_PURPOSES)) {
    const text = getOtpPurposeText(purpose);
    assert.ok(text.title && text.intro && text.verifiedMessage, purpose);
  }
  assert.equal(getOtpPurposeText('未知').title, getOtpPurposeText(OTP_PURPOSES.ACTIVATION).title);
});

test('not_allowed 的各種 reason 都有白話，不把英文代碼丟給使用者', () => {
  const expectations = {
    already_active: /已經啟用過/,
    no_pending_activation: /沒有等待啟用/,
    instructor_disabled: /已停用/,
    role_not_allowed: /帳號身分/,
    account_not_active: /還沒有啟用/,
    invalid_purpose: /用途不正確/,
  };
  for (const [reason, pattern] of Object.entries(expectations)) {
    const result = interpretRequestResult({ status: 'not_allowed', reason });
    assert.equal(result.kind, 'blocked', reason);
    assert.match(result.message, pattern, reason);
    assert.ok(!result.message.includes(reason), `${reason} 不應直接顯示`);
  }
  assert.equal(interpretRequestResult({ status: 'not_allowed', reason: 'already_active' }).needsAdmin, false);
  assert.equal(interpretRequestResult({ status: 'not_allowed', reason: 'instructor_disabled' }).needsAdmin, true);
});
