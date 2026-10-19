/*
 * 帳號認領後的「啟用」流程：把 get_my_activation_status() 的回傳翻成畫面要顯示的狀態，
 * 以及後台「確認 Email」表單的檢查與標示。介面契約：docs/specs/2026-10-20-claim-activation-esign.md §1.4／§2。
 *
 * get_my_activation_status() → { status: 'none'|'pending'|'active', claim_method, has_confirmed_email,
 *                               masked_email, profile_complete }
 *   none    = 沒有啟用紀錄（新建帳號待管理員審核，或根本沒綁定）
 *   pending = 已認領綁定、等待用 Email 驗證碼啟用
 *   active  = 已啟用
 */

export const ACTIVATION_BUTTON_LABEL = '確認資料無誤，驗證信箱啟用帳號';

export const ACTIVATION_STATES = Object.freeze({
  UNKNOWN: 'unknown', // 讀不到（RPC 失敗或尚未上線）：維持舊行為，不顯示任何啟用提示
  NONE: 'none',
  ACTIVE: 'active',
  NEEDS_EMAIL_CONFIRMATION: 'needs_email_confirmation',
  NEEDS_PROFILE: 'needs_profile',
  READY: 'ready',
});

/**
 * @returns {{state: string, pending: boolean, maskedEmail: string|null, claimMethod: string|null,
 *            title: string, message: string, showButton: boolean}}
 */
export const interpretActivationStatus = (raw) => {
  const base = {
    state: ACTIVATION_STATES.UNKNOWN,
    pending: false,
    maskedEmail: raw?.masked_email || null,
    claimMethod: raw?.claim_method || null,
    title: '',
    message: '',
    showButton: false,
  };

  if (!raw || typeof raw !== 'object') return base;

  if (raw.status === 'active') return { ...base, state: ACTIVATION_STATES.ACTIVE };
  if (raw.status === 'none') return { ...base, state: ACTIVATION_STATES.NONE };
  if (raw.status !== 'pending') return base;

  const pending = { ...base, pending: true };

  if (!raw.has_confirmed_email) {
    return {
      ...pending,
      state: ACTIVATION_STATES.NEEDS_EMAIL_CONFIRMATION,
      title: '帳號尚未啟用',
      message: '你的 Email 尚未經公司確認，請聯絡行政人員確認後才能啟用帳號。',
    };
  }

  if (!raw.profile_complete) {
    return {
      ...pending,
      state: ACTIVATION_STATES.NEEDS_PROFILE,
      title: '帳號尚未啟用',
      message: `請先補齊資料，再按下方「${ACTIVATION_BUTTON_LABEL}」。補齊後記得先按頁面最下方的「儲存個人資料」。`,
    };
  }

  return {
    ...pending,
    state: ACTIVATION_STATES.READY,
    title: '最後一步：驗證信箱，啟用帳號',
    message: `資料都填好了。確認無誤後，系統會寄 6 碼驗證碼到${raw.masked_email ? ` ${raw.masked_email}` : '公司已確認的信箱'}，輸入正確就會啟用帳號。`,
    showButton: true,
  };
};

// ── 後台「確認 Email」（admin_confirm_instructor_email） ──

export const CONFIRMED_EMAIL_METHOD_LABELS = Object.freeze({
  company_existing_record: '公司既有資料登錄',
  admin_trusted_channel: '管理員經可信管道確認',
  google_login_new_instructor: '新進講師（管理員審核通過，採 Google 登入信箱）',
});

export const describeConfirmedEmailMethod = (method) => (
  CONFIRMED_EMAIL_METHOD_LABELS[method] || (method ? String(method) : '')
);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email 正規化：去空白、轉小寫（與資料庫 confirmed_email 的存法一致）。 */
export const normalizeEmail = (value) => String(value ?? '').trim().toLowerCase();

/**
 * 檢查後台「確認 Email」表單。管道註記必填：
 * 確認方式是 admin_trusted_channel（管理員透過可信管道與老師本人確認），要留得下當時怎麼確認的。
 * @returns {{ok: boolean, email: string, note: string, errors: {email?: string, note?: string}}}
 */
export const validateEmailConfirmation = ({ email, note }) => {
  const normalized = normalizeEmail(email);
  const trimmedNote = String(note ?? '').trim();
  const errors = {};
  if (!normalized) errors.email = '請輸入要確認的 Email。';
  else if (!EMAIL_PATTERN.test(normalized)) errors.email = 'Email 格式不正確。';
  if (trimmedNote.length < 4) errors.note = '請註記是怎麼和老師確認的（例如「10/20 透過 LINE 與老師本人確認」）。';
  return { ok: Object.keys(errors).length === 0, email: normalized, note: trimmedNote, errors };
};

/** admin_confirm_instructor_email 失敗時的白話訊息。 */
export const describeConfirmEmailError = (error) => {
  const raw = String(error?.message || error || '');
  if (/FORBIDDEN|not admin|permission|42501/i.test(raw)) return '只有管理員可以確認 Email。';
  if (/EMAIL_IN_USE|already|duplicate|23505/i.test(raw)) return '這個 Email 已經被其他講師使用，請確認是否輸入正確。';
  if (/INVALID_EMAIL/i.test(raw)) return 'Email 格式不正確。';
  if (/NOTE_REQUIRED/i.test(raw)) return '請填寫確認管道註記（500 字以內）。';
  if (/INSTRUCTOR_NOT_FOUND/i.test(raw)) return '找不到這位講師，請重新整理頁面。';
  return `確認失敗：${raw || '未知錯誤'}`;
};
