/*
 * Email 一次性驗證碼（OTP）的純函式：訊息對應、倒數計算、輸入清理。
 * 對應資料庫 RPC（見 docs/specs/2026-10-20-claim-activation-esign.md §1.4）：
 *   request_email_otp(p_purpose)            → status: sent | cooldown | rate_limited | daily_limit_reached
 *                                              | locked_contact_admin | no_confirmed_email
 *                                              | profile_incomplete | not_allowed | email_not_configured
 *   verify_email_otp(p_challenge_id, p_code) → status: verified | invalid | expired | used | locked | superseded
 *                                              （locked 可能帶 sending_suspended:true＝24 小時內第 3 組被鎖，已暫停寄碼）
 * 畫面與 Supabase 呼叫在 components/EmailOtpDialog.jsx，這裡不碰網路，方便單獨測試。
 */

export const OTP_PURPOSES = Object.freeze({
  ACTIVATION: 'account_activation',
  CONTRACT: 'contract_sign',
});

export const OTP_LENGTH = 6;
// 規格：5 分鐘有效、同目的 60 秒冷卻、每人每小時 5 封、每 24 小時 10 封、錯 5 次鎖定；
// 24 小時內被鎖 3 組 → 暫停寄碼 24 小時，要請行政解除（2026-10-23）
export const OTP_VALID_SECONDS = 300;
export const OTP_RESEND_SECONDS = 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_HOUR = 5;
export const OTP_MAX_PER_DAY = 10;

const PURPOSE_TEXT = {
  [OTP_PURPOSES.ACTIVATION]: {
    title: '驗證信箱，啟用帳號',
    intro: '為確認是你本人，系統會寄一組 6 碼驗證碼到公司已確認的信箱。輸入正確後就會啟用你的講師帳號。',
    verifiedMessage: '信箱驗證成功，帳號已啟用。',
  },
  [OTP_PURPOSES.CONTRACT]: {
    title: '簽約前的本人身分驗證',
    intro: '為確認是你本人簽署，系統會寄一組 6 碼驗證碼到公司已確認的信箱。驗證通過後才能手寫簽名。',
    verifiedMessage: '本人身分已驗證。',
  },
};

export const getOtpPurposeText = (purpose) => PURPOSE_TEXT[purpose] || PURPOSE_TEXT[OTP_PURPOSES.ACTIVATION];

/** 只留數字（全形數字先轉半形），最多 6 碼。 */
export const normalizeOtpInput = (raw) => String(raw ?? '')
  .normalize('NFKC')
  .replace(/\D/g, '')
  .slice(0, OTP_LENGTH);

export const isOtpComplete = (code) => normalizeOtpInput(code).length === OTP_LENGTH;

/** 距離目標時間還有幾秒（無條件進位，最少 0）；時間無效回 0。 */
export const secondsUntil = (targetMs, nowMs = Date.now()) => {
  if (!Number.isFinite(targetMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
};

export const secondsUntilIso = (iso, nowMs = Date.now()) => (
  iso ? secondsUntil(new Date(iso).getTime(), nowMs) : 0
);

/** 秒數 → 「4:59」。 */
export const formatCountdown = (totalSeconds) => {
  const safe = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

// request_email_otp 回 not_allowed 時的 reason（資料庫端定義）
const NOT_ALLOWED_REASONS = {
  already_active: { needsAdmin: false, message: '你的帳號已經啟用過了，不需要再驗證。請重新整理頁面。' },
  no_pending_activation: { needsAdmin: true, message: '目前沒有等待啟用的帳號紀錄。請重新整理頁面；若仍有問題請聯絡行政人員。' },
  instructor_disabled: { needsAdmin: true, message: '你的講師資料目前已停用，無法驗證。請聯絡行政人員。' },
  role_not_allowed: { needsAdmin: true, message: '這個帳號身分不需要（也不能）用這個方式驗證。請聯絡行政人員。' },
  account_not_active: { needsAdmin: false, message: '你的帳號還沒有啟用，請先到「個人資料」完成信箱驗證啟用帳號，再回來簽約。' },
  invalid_purpose: { needsAdmin: false, message: '驗證用途不正確，請重新整理頁面後再試。' },
};

const toCount = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Math.max(0, Math.floor(Number(value))) : null);

/**
 * 解讀 request_email_otp 的回傳。
 * kind：sent（已寄出，有 challengeId）｜cooldown（冷卻中）｜blocked（不能寄，needsAdmin 表示要找行政人員）｜error
 */
export const interpretRequestResult = (result) => {
  const status = result?.status;
  const base = { status: status || 'unknown', challengeId: null, expiresAt: null, maskedEmail: null, retryAfterSeconds: 0, message: '', needsAdmin: false };

  switch (status) {
    case 'sent':
      return {
        ...base,
        kind: 'sent',
        challengeId: result.challenge_id || null,
        expiresAt: result.expires_at || null,
        maskedEmail: result.masked_email || null,
        retryAfterSeconds: toCount(result.resend_after_seconds) ?? OTP_RESEND_SECONDS,
      };
    case 'cooldown': {
      const wait = toCount(result.retry_after_seconds) ?? OTP_RESEND_SECONDS;
      return {
        ...base,
        kind: 'cooldown',
        // 若資料庫在冷卻回覆中一併帶回進行中的驗證碼資訊，就可以接著輸入
        challengeId: result.challenge_id || null,
        expiresAt: result.expires_at || null,
        maskedEmail: result.masked_email || null,
        retryAfterSeconds: wait,
        message: `剛剛已經寄出驗證碼，請先查看信箱（含垃圾郵件匣）。${wait} 秒後才能重新寄送。`,
      };
    }
    case 'rate_limited':
      return {
        ...base,
        kind: 'blocked',
        message: `驗證碼寄送次數已達上限（每小時最多 ${OTP_MAX_PER_HOUR} 封），請稍後再試。若急需處理請聯絡行政人員。`,
      };
    case 'daily_limit_reached':
      return {
        ...base,
        kind: 'blocked',
        needsAdmin: true,
        message: `今天寄送次數已達上限（24 小時內最多 ${OTP_MAX_PER_DAY} 封），請明天再試或聯絡行政人員。`,
      };
    case 'locked_contact_admin':
      return {
        ...base,
        kind: 'blocked',
        needsAdmin: true,
        message: '驗證錯誤次數過多，已暫停寄送驗證碼。請聯絡行政人員協助。',
      };
    case 'no_confirmed_email':
      return {
        ...base,
        kind: 'blocked',
        needsAdmin: true,
        message: '公司尚未確認你的 Email，無法寄送驗證碼。請聯絡行政人員確認 Email 後再試。',
      };
    case 'profile_incomplete':
      return {
        ...base,
        kind: 'blocked',
        message: '你的講師資料還沒填完整。請先補齊資料並按「儲存個人資料」，再回來驗證信箱。',
      };
    case 'not_allowed': {
      const reason = NOT_ALLOWED_REASONS[result?.reason];
      return {
        ...base,
        kind: 'blocked',
        needsAdmin: reason ? reason.needsAdmin : true,
        message: reason
          ? reason.message
          : `目前無法寄送驗證碼${result?.reason ? `（${result.reason}）` : ''}。如有疑問請聯絡行政人員。`,
      };
    }
    case 'email_not_configured':
      return {
        ...base,
        kind: 'blocked',
        needsAdmin: true,
        message: '系統目前尚未設定寄信功能，沒辦法寄出驗證碼。這不是你的操作問題，請聯絡行政人員處理。',
      };
    default:
      return { ...base, kind: 'error', message: '無法寄送驗證碼，請稍後再試。' };
  }
};

/**
 * 解讀 verify_email_otp 的回傳。
 * kind：verified｜invalid（可再輸入）｜dead（這組驗證碼已不能再用，必須重新寄送）｜error
 */
export const interpretVerifyResult = (result) => {
  const status = result?.status;
  switch (status) {
    case 'verified':
      return {
        status,
        kind: 'verified',
        activated: Boolean(result.activated),
        verifiedAt: result.verified_at || null,
        message: '',
        attemptsRemaining: null,
        needsNewCode: false,
      };
    case 'invalid': {
      const remaining = toCount(result.attempts_remaining);
      if (remaining === 0) {
        return {
          status,
          kind: 'dead',
          activated: false,
          verifiedAt: null,
          attemptsRemaining: 0,
          needsNewCode: true,
          message: '驗證碼輸入錯誤次數過多，這組驗證碼已失效。請重新寄送新的驗證碼。',
        };
      }
      return {
        status,
        kind: 'invalid',
        activated: false,
        verifiedAt: null,
        attemptsRemaining: remaining,
        needsNewCode: false,
        message: remaining === null
          ? '驗證碼不正確，請重新確認信件內的 6 碼。'
          : `驗證碼不正確，還可以再試 ${remaining} 次。`,
      };
    }
    case 'expired':
      return {
        status, kind: 'dead', activated: false, verifiedAt: null, attemptsRemaining: null, needsNewCode: true,
        message: '驗證碼已過期（有效時間 5 分鐘）。請重新寄送新的驗證碼。',
      };
    case 'used':
      return {
        status, kind: 'dead', activated: false, verifiedAt: null, attemptsRemaining: null, needsNewCode: true,
        message: '這組驗證碼已經用過了。請重新寄送新的驗證碼。',
      };
    case 'locked':
      if (result?.sending_suspended) {
        // 24 小時內第 3 組被鎖：資料庫已暫停寄碼，重寄也寄不出去，請他找行政
        return {
          status, kind: 'dead', activated: false, verifiedAt: null, attemptsRemaining: 0, needsNewCode: false,
          sendingSuspended: true,
          message: '驗證錯誤次數過多，已暫停寄送驗證碼。請聯絡行政人員協助。',
        };
      }
      return {
        status, kind: 'dead', activated: false, verifiedAt: null, attemptsRemaining: 0, needsNewCode: true,
        message: '驗證碼輸入錯誤次數過多（最多 5 次），這組已鎖定。請重新寄送新的驗證碼。',
      };
    case 'superseded':
      return {
        status, kind: 'dead', activated: false, verifiedAt: null, attemptsRemaining: null, needsNewCode: true,
        message: '已經寄出更新的驗證碼，這一組已作廢。請使用最新一封信裡的驗證碼，或重新寄送。',
      };
    default:
      return {
        status: status || 'unknown', kind: 'error', activated: false, verifiedAt: null, attemptsRemaining: null, needsNewCode: false,
        message: '驗證失敗，請稍後再試。',
      };
  }
};

/** 呼叫 RPC 失敗（網路、登入逾時、權限）時給使用者的白話。 */
export const describeOtpRpcError = (error) => {
  const message = String(error?.message || '');
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return '網路連線異常，請檢查網路後再試。';
  }
  if (/jwt|not authenticated|not_authenticated|unauthorized|auth/i.test(message)) {
    return '登入狀態已過期，請重新整理頁面或重新登入後再試。';
  }
  return '系統暫時無法處理，請稍後再試。';
};
