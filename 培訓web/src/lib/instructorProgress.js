import {
  REQUIRED_PROFILE_DOCUMENTS,
  REQUIRED_PROFILE_FIELDS,
  getInstructorProfileCompletion,
} from './profileCompletion.js';
import { isInstructorPersonnel } from './constants.js';

/*
 * 老師「資料進度」：一路追到簽完約。
 * 判斷順序（先符合的先贏）：
 *   已停用 → 未認領 → 待審核（新建帳號） → 待確認 Email → 待信箱驗證 → 資料未完整 → 待簽約 → 已完成
 *
 * 認領後的帳號啟用（2026-10-20 起，規格 docs/specs/2026-10-20-claim-activation-esign.md）：
 *   認領只是「綁定」，帳號仍是 pending，要用公司已確認的 Email 收驗證碼才會啟用成 teacher。
 *   users.role 還是 pending 時分兩種人：
 *     - 有一筆 status='pending' 的啟用紀錄（instructor_account_activations）＝已認領待啟用：
 *         instructors.confirmed_email 空 → 「待確認 Email」（管理員要先在後台確認 Email）
 *         instructors.confirmed_email 有值 → 「待信箱驗證」（等老師填完資料並輸入驗證碼）
 *     - 沒有啟用紀錄＝新建帳號，等管理員核准 → 「待審核」
 *   啟用紀錄只有管理員讀得到（RLS）。讀不到時（activationsByUserId 傳 null，例如輔導員）：
 *     有 confirmed_email 的 pending 帳號仍可判成「待信箱驗證」（新建帳號在核准前不會有 confirmed_email），
 *     沒有 confirmed_email 的無法與新建帳號區分，維持「待審核」。
 *
 * 「已簽約」的定義：這位老師綁定的登入帳號（instructor_contracts.user_id）有至少一筆 status='signed'。
 *   - 簽約紀錄只存 user_id，沒有 instructor_id，所以未認領的主檔不可能是已簽約。
 *   - 送簽 RPC（submit_my_contract）會在同一交易把同一人舊的 signed 作廢再新增，
 *     所以每人最多只有一筆 signed；voided 不算簽約。
 *   - 不要求簽的是「目前最新版本」：文件改版時個人資料頁只會提示「有新版可重簽」，
 *     不該因為改版把全部老師一夜打回「待簽約」。
 *
 * 簽約紀錄只有管理員讀得到（RLS），讀不到時 signedUserIds 傳 null：
 *   資料完整的人會顯示「資料已完整」（簽約狀態未知），不會被誤判成待簽約或已完成。
 *
 * 人員類別（2026-10-22 起，instructors.personnel_types；employment_status 只代表合作狀態）：
 *   不含「講師」的純職員／工讀計時：資料完整度照 profileCompletion 的規則免填接課頻率、地區、經歷；
 *   不需簽講師合約，資料完整就算「已完成」，不會出現在「待簽約」。
 *   啟用（待確認 Email／待信箱驗證）照常適用，那是帳號安全，不分人員類別。
 */

export const DISABLED_EMPLOYMENT_STATUSES = ['frozen', 'cancelled'];

export const PROGRESS_TODO_FILTER = 'todo';

export const PROGRESS_STAGES = [
  { key: 'unclaimed', label: '未認領', todo: true, description: '還沒有人用 Google 登入認領這份主檔' },
  { key: 'pending_review', label: '待審核', todo: true, description: '已用「新建帳號」註冊，等管理員核准' },
  { key: 'awaiting_email_confirm', label: '待確認 Email', todo: true, description: '已認領綁定，但公司還沒確認這位老師的 Email，請管理員先確認' },
  { key: 'awaiting_email_verify', label: '待信箱驗證', todo: true, description: 'Email 已確認，等老師補齊資料並輸入信箱驗證碼啟用帳號' },
  { key: 'incomplete', label: '資料未完整', todo: true, description: '已開通，但必填資料或文件還沒補齊' },
  { key: 'awaiting_contract', label: '待簽約', todo: true, description: '資料完整，但還沒完成簽約' },
  { key: 'complete', label: '已完成', todo: false, description: '資料完整且已簽約（職員／工讀計時不需簽約）' },
  { key: 'disabled', label: '已停用', todo: false, description: '已凍結或已離職／停止合作' },
];

// 讀不到簽約紀錄（例如輔導員）時，資料完整的人改用這一階段，避免誤報待簽約／已完成。
export const PROFILE_READY_STAGE = {
  key: 'profile_ready',
  label: '資料已完整',
  todo: false,
  description: '資料完整（簽約狀態僅管理員可見）',
};

const STAGE_BY_KEY = Object.fromEntries(
  [...PROGRESS_STAGES, PROFILE_READY_STAGE].map((stage) => [stage.key, stage]),
);

export const PROGRESS_FILTER_KEYS = [
  PROGRESS_TODO_FILTER,
  ...PROGRESS_STAGES.map((stage) => stage.key),
  PROFILE_READY_STAGE.key,
];

export const isProgressFilterKey = (value) => PROGRESS_FILTER_KEYS.includes(value);

// 只撈算進度用得到的欄位（後台首頁不需要把整張主檔拉下來）。
export const INSTRUCTOR_PROGRESS_COLUMNS = [...new Set([
  'id',
  'user_id',
  'full_name',
  'email_primary',
  'confirmed_email',
  'employment_status',
  'personnel_types',
  'name_slot',
  'teaching_regions',
  ...REQUIRED_PROFILE_FIELDS.map(({ key }) => key),
  ...REQUIRED_PROFILE_DOCUMENTS.flatMap(({ key }) => [`${key}_path`, `${key}_external_url`]),
])];

export const isInstructorDisabled = (instructor) => (
  DISABLED_EMPLOYMENT_STATUSES.includes(instructor?.employment_status)
);

// 傳入 instructor_contracts 的列；非陣列（沒權限讀、查詢失敗）回傳 null 代表「簽約狀態未知」。
export const buildSignedUserIdSet = (contractRows) => {
  if (!Array.isArray(contractRows)) return null;
  return new Set(
    contractRows
      .filter((row) => row?.status === 'signed' && row?.user_id)
      .map((row) => row.user_id),
  );
};

// 傳入 instructor_account_activations 的列（只要 status='pending' 的）；非陣列（沒權限讀、查詢失敗）回傳 null。
export const buildActivationMap = (activationRows) => {
  if (!Array.isArray(activationRows)) return null;
  return new Map(
    activationRows
      .filter((row) => row?.user_id && row?.status === 'pending')
      .map((row) => [row.user_id, row]),
  );
};

export const hasConfirmedEmail = (instructor) => String(instructor?.confirmed_email ?? '').trim() !== '';

/**
 * 篩選列要顯示哪些階段：讀不到的資訊對應的階段不顯示，避免誤導。
 *   - 簽約紀錄讀不到：待簽約、已完成 合併成「資料已完整」
 *   - 啟用紀錄讀不到：「待確認 Email」無法與「待審核」區分，不顯示
 */
export const getVisibleProgressStages = ({ contractKnown = true, activationKnown = true } = {}) => {
  const stages = PROGRESS_STAGES.filter((stage) => {
    if (stage.key === 'awaiting_email_confirm') return activationKnown;
    if (!contractKnown && (stage.key === 'awaiting_contract' || stage.key === 'complete')) return false;
    return true;
  });
  if (contractKnown) return stages;
  const insertAt = stages.findIndex((stage) => stage.key === 'disabled');
  return [...stages.slice(0, insertAt), PROFILE_READY_STAGE, ...stages.slice(insertAt)];
};

const makeProgress = (stage, completion) => ({
  key: stage.key,
  label: stage.label,
  todo: stage.todo,
  description: stage.description,
  missingCount: completion.missingItems.length,
  missingItems: completion.missingItems,
});

/**
 * @param {object} instructor instructors 的一列
 * @param {object} [context]
 * @param {string|null} [context.userRole] 綁定帳號在 users.role 的值（讀不到就不傳）
 * @param {Set<string>|null} [context.signedUserIds] 有簽約的 user_id 集合；null＝簽約狀態未知
 * @param {Map<string, object>|null} [context.activationsByUserId] 待啟用紀錄（user_id → 列）；null＝讀不到
 */
export const getInstructorProgress = (
  instructor,
  { userRole = null, signedUserIds = null, activationsByUserId = null } = {},
) => {
  const completion = getInstructorProfileCompletion(instructor);

  if (isInstructorDisabled(instructor)) return makeProgress(STAGE_BY_KEY.disabled, completion);
  if (!instructor?.user_id) return makeProgress(STAGE_BY_KEY.unclaimed, completion);
  if (userRole === 'pending') {
    const confirmed = hasConfirmedEmail(instructor);
    if (activationsByUserId instanceof Map) {
      if (activationsByUserId.has(instructor.user_id)) {
        return makeProgress(confirmed ? STAGE_BY_KEY.awaiting_email_verify : STAGE_BY_KEY.awaiting_email_confirm, completion);
      }
      return makeProgress(STAGE_BY_KEY.pending_review, completion);
    }
    // 讀不到啟用紀錄：有已確認 Email 的 pending 帳號只可能是已認領待啟用
    return makeProgress(confirmed ? STAGE_BY_KEY.awaiting_email_verify : STAGE_BY_KEY.pending_review, completion);
  }
  if (!completion.complete) return makeProgress(STAGE_BY_KEY.incomplete, completion);
  if (!(signedUserIds instanceof Set)) return makeProgress(PROFILE_READY_STAGE, completion);
  // 純職員／工讀計時不需簽講師合約（與合約管理頁「非講師，不需簽約」一致）
  if (!isInstructorPersonnel(instructor?.personnel_types)) return makeProgress(STAGE_BY_KEY.complete, completion);
  return makeProgress(
    signedUserIds.has(instructor.user_id) ? STAGE_BY_KEY.complete : STAGE_BY_KEY.awaiting_contract,
    completion,
  );
};

/**
 * @param {object[]} instructors
 * @param {object} [context]
 * @param {Map<string, {role?: string, email?: string}>|null} [context.usersById]
 * @param {Set<string>|null} [context.signedUserIds]
 * @param {Map<string, object>|null} [context.activationsByUserId]
 * @returns {{instructor: object, progress: object}[]}
 */
export const buildProgressRows = (
  instructors,
  { usersById = null, signedUserIds = null, activationsByUserId = null } = {},
) => (
  (instructors || []).map((instructor) => ({
    instructor,
    progress: getInstructorProgress(instructor, {
      userRole: instructor?.user_id ? usersById?.get(instructor.user_id)?.role ?? null : null,
      signedUserIds,
      activationsByUserId,
    }),
  }))
);

export const matchesProgressFilter = (progress, filterKey) => {
  if (!filterKey) return true;
  if (!progress) return false;
  if (filterKey === PROGRESS_TODO_FILTER) return progress.todo;
  return progress.key === filterKey;
};

// 各階段人數與「還沒完成」總數（todo＝未認領＋待審核＋待確認 Email＋待信箱驗證＋資料未完整＋待簽約）。
export const countProgress = (progressRows) => {
  const byKey = Object.fromEntries(
    [...PROGRESS_STAGES, PROFILE_READY_STAGE].map((stage) => [stage.key, 0]),
  );
  let todo = 0;
  (progressRows || []).forEach(({ progress }) => {
    byKey[progress.key] += 1;
    if (progress.todo) todo += 1;
  });
  return { total: (progressRows || []).length, byKey, todo };
};
