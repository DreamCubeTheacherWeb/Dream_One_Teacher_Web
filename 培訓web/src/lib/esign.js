/*
 * 電子簽約的純函式：雜湊、送出錯誤對應、時間顯示、文件版本整理。
 * 介面契約：docs/specs/2026-10-20-claim-activation-esign.md §1.4。
 */

const HEX64 = /^[0-9a-f]{64}$/;

export const isSha256Hex = (value) => typeof value === 'string' && HEX64.test(value);

const toBytes = (input) => {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('sha256Hex 只接受 ArrayBuffer 或 Uint8Array（要雜湊檔案請先 arrayBuffer()）');
};

/** 小寫 hex 的 SHA-256（WebCrypto；需要 HTTPS 或 localhost）。 */
export const sha256Hex = async (input) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('這個瀏覽器環境不支援 SHA-256 計算（需要 HTTPS），請改用較新的瀏覽器。');
  const digest = await subtle.digest('SHA-256', toBytes(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Blob/File → SHA-256。 */
export const sha256HexOfBlob = async (blob) => sha256Hex(await blob.arrayBuffer());

/**
 * submit_my_contract / record_contract_consent 的錯誤代碼 → 白話。
 * 回傳 { code, message, action }：
 *   action 告訴畫面要把使用者帶回哪一步：
 *     'otp'      → 重新做簽約前的 Email 驗證
 *     'consent'  → 重新做電子簽約同意
 *     'reload'   → 重新載入文件、從頭閱讀
 *     'activate' → 帳號尚未啟用
 *     'minor'    → 未滿 18 歲不能線上簽約，畫面改成「紙本簽約」說明
 *     null       → 停在原地，可重試
 */
const SUBMIT_ERRORS = [
  { code: 'OTP_REQUIRED', action: 'otp', message: '請先完成 Email 驗證後再簽署。' },
  { code: 'OTP_EXPIRED', action: 'otp', message: 'Email 驗證已逾時（驗證後需在 15 分鐘內送出），請重新驗證後再按「確認簽署」。' },
  { code: 'OTP_ALREADY_USED', action: 'otp', message: '這組 Email 驗證碼已經使用過，請重新驗證後再簽署。' },
  { code: 'EMAIL_VERIFICATION_REQUIRED', action: 'otp', message: '請先完成 Email 身分驗證後再送出。' },
  { code: 'CONSENT_REQUIRED', action: 'consent', message: '電子簽約同意已失效或逾時（同意後需在 2 小時內完成），請重新選擇簽約方式。' },
  { code: 'DOC_VERSION_MISMATCH', action: 'reload', message: '契約剛更新版本，請重新閱讀後再簽。' },
  { code: 'NO_ACTIVE_DOCUMENTS', action: 'reload', message: '合約文件已更新，請重新整理頁面後再簽署。' },
  { code: 'DOC_HASH_MISMATCH', action: 'reload', message: '系統檢查發現合約範本檔案與登錄的內容不一致，為了保護你，這次簽署已停止。請稍後重新整理再試，若持續出現請聯絡管理員。' },
  { code: 'INVALID_HASH', action: null, message: '文件檔案指紋格式不正確，這次簽署沒有送出。請重新整理頁面再試，若持續出現請聯絡管理員。' },
  { code: 'INVALID_INPUT', action: null, message: '送出的資料格式不正確，這次沒有送出。請重新整理頁面再試，若持續出現請聯絡管理員。' },
  { code: 'CONSENT_TEXT_UNKNOWN', action: null, message: '系統找不到這個版本的同意文案，這次沒有記錄。請重新整理頁面再試，若持續出現請聯絡管理員。' },
  { code: 'MINOR_REQUIRES_GUARDIAN', action: 'minor', message: '依民法規定，未滿 18 歲簽訂契約需要法定代理人（通常是父母）同意，所以不能線上簽約。請改以紙本簽約，由你和法定代理人一起簽名。' },
  { code: 'ACCOUNT_NOT_ACTIVE', action: 'activate', message: '你的帳號還沒有啟用，請先到「個人資料」完成信箱驗證啟用帳號。' },
  { code: 'FILE_NOT_UPLOADED', action: null, message: '簽署檔案上傳不完整，請重試。' },
  { code: 'SIGNED_PDF_MISSING', action: null, message: '簽署檔案上傳不完整，請重試。' },
];

export const describeContractRpcError = (error) => {
  const raw = String(error?.message || error || '');
  const hit = SUBMIT_ERRORS.find((entry) => raw.includes(entry.code));
  if (hit) return { code: hit.code, message: hit.message, action: hit.action };
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(raw)) {
    return { code: 'NETWORK', message: '網路連線異常，這次沒有送出，請檢查網路後再試一次。', action: null };
  }
  return { code: 'UNKNOWN', message: `簽約送出失敗：${raw || '未知錯誤'}`, action: null };
};

const YMD = /^(\d{4})-(\d{2})-(\d{2})/;

/** 'YYYY-MM-DD'（可帶時間尾巴）→ {y,m,d}；格式錯或不存在的日期（例如 2026-02-30）回 null。 */
const parseYmd = (value) => {
  const match = YMD.exec(String(value ?? '').trim());
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return { y, m, d };
};

const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/** 現在是台灣的哪一天，'YYYY-MM-DD'。 */
export const taipeiToday = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/**
 * 出生日期 birthDate 在 today（台灣日期，預設今天）是否未滿 18 歲。
 * 與資料庫 private.is_minor_birth_date 同一規則（資料庫才是防線，這裡只是讓畫面提早說清楚）：
 * 出生日當天滿 18 歲；2/29 出生者，滿 18 歲那年不是閏年，視為 3/1 成年（民法 §121 以月之末日為期間末日，較保守）；
 * 沒有出生日期或格式不對回 false。
 */
export const isMinorOn = (birthDate, today = taipeiToday()) => {
  const birth = parseYmd(birthDate);
  const day = parseYmd(today);
  if (!birth || !day) return false;
  let adult = { y: birth.y + 18, m: birth.m, d: birth.d };
  if (birth.m === 2 && birth.d === 29 && !isLeapYear(adult.y)) adult = { y: adult.y, m: 3, d: 1 };
  const key = (date) => date.y * 10000 + date.m * 100 + date.d;
  return key(day) < key(adult);
};

/**
 * doc_versions（{doc_type: version}）＋步驟清單 → {{doc_list}} 用的陣列。
 * @param {{docType: string, title: string}[]} steps
 */
export const buildDocEntries = (steps, docVersions) => (steps || [])
  .filter((step) => docVersions && docVersions[step.docType] !== undefined)
  .map((step) => ({ title: step.title, version: docVersions[step.docType] }));

/** 2026-10-20 14:03（台北時間）。無效時間回空字串。 */
export const formatTaipeiTime = (value, { seconds = false } = {}) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const time = seconds ? `${parts.hour}:${parts.minute}:${parts.second}` : `${parts.hour}:${parts.minute}`;
  return `${parts.year}-${parts.month}-${parts.day} ${time}（台北時間）`;
};

/** 合約狀態（instructor_contracts.status）→ 顯示文字。 */
export const contractStatusLabel = (status) => ({
  signed: '有效',
  voided: '已作廢',
}[status] || status || '—');

/** 簽約檔下載檔名：不可含路徑分隔字元。 */
export const safeDownloadName = (...parts) => parts
  .map((part) => String(part ?? '').trim())
  .filter(Boolean)
  .join('_')
  .replace(/[\\/:*?"<>|]+/g, '-');

/**
 * 比對兩份 {doc_type: sha256} 雜湊表。
 * 回傳 { ok, mismatched:[doc_type], missing:[doc_type] }；missing＝證據裡有、實際沒算到。
 */
export const compareHashMaps = (expected, actual) => {
  const mismatched = [];
  const missing = [];
  Object.entries(expected || {}).forEach(([docType, hash]) => {
    const got = actual?.[docType];
    if (!got) missing.push(docType);
    else if (String(got).toLowerCase() !== String(hash).toLowerCase()) mismatched.push(docType);
  });
  return { ok: mismatched.length === 0 && missing.length === 0, mismatched, missing };
};

/**
 * 完整性檢查結果彙整。
 * @param {{label: string, ok: boolean}[]} results
 * @returns {{ok: boolean, total: number, failed: string[]}}
 */
export const summarizeIntegrity = (results) => {
  const list = results || [];
  const failed = list.filter((item) => !item.ok).map((item) => item.label);
  return { ok: list.length > 0 && failed.length === 0, total: list.length, failed };
};

/** 簽署證據裡各種狀態的白話。 */
export const consentDecisionLabel = (decision) => ({
  agree_electronic: '同意使用線上簽約',
  decline_electronic: '不同意，改以紙本簽約',
}[decision] || decision || '—');

export const deliveryStatusLabel = (status) => ({
  queued: '排隊中',
  sent: '已送出',
  failed: '失敗',
  not_configured: '未設定寄信金鑰',
}[status] || status || '—');

export const deliveryKindLabel = (kind) => ({
  otp_activation: '帳號啟用驗證碼',
  otp_contract: '簽約驗證碼',
  contract_signed_copy: '簽署完成通知',
}[kind] || kind || '—');

/** 雜湊太長時顯示前後段，滑過可看全文。 */
export const shortHash = (hash) => {
  const text = String(hash || '');
  return text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text;
};
