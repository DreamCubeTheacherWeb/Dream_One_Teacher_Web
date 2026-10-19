import {
  REQUIRED_PROFILE_DOCUMENTS,
  REQUIRED_PROFILE_FIELDS,
  getInstructorProfileCompletion,
} from './profileCompletion.js';

/*
 * 老師「資料進度」：一路追到簽完約。
 * 判斷順序（先符合的先贏）：
 *   已停用 → 未認領 → 待審核（新建帳號） → 資料未完整 → 待簽約 → 已完成
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
 */

export const DISABLED_EMPLOYMENT_STATUSES = ['frozen', 'cancelled'];

export const PROGRESS_TODO_FILTER = 'todo';

export const PROGRESS_STAGES = [
  { key: 'unclaimed', label: '未認領', todo: true, description: '還沒有人用 Google 登入認領這份主檔' },
  { key: 'pending_review', label: '待審核', todo: true, description: '已用「新建帳號」註冊，等管理員核准' },
  { key: 'incomplete', label: '資料未完整', todo: true, description: '已開通，但必填資料或文件還沒補齊' },
  { key: 'awaiting_contract', label: '待簽約', todo: true, description: '資料完整，但還沒完成簽約' },
  { key: 'complete', label: '已完成', todo: false, description: '資料完整且已簽約' },
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
  'employment_status',
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
 */
export const getInstructorProgress = (instructor, { userRole = null, signedUserIds = null } = {}) => {
  const completion = getInstructorProfileCompletion(instructor);

  if (isInstructorDisabled(instructor)) return makeProgress(STAGE_BY_KEY.disabled, completion);
  if (!instructor?.user_id) return makeProgress(STAGE_BY_KEY.unclaimed, completion);
  if (userRole === 'pending') return makeProgress(STAGE_BY_KEY.pending_review, completion);
  if (!completion.complete) return makeProgress(STAGE_BY_KEY.incomplete, completion);
  if (!(signedUserIds instanceof Set)) return makeProgress(PROFILE_READY_STAGE, completion);
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
 * @returns {{instructor: object, progress: object}[]}
 */
export const buildProgressRows = (instructors, { usersById = null, signedUserIds = null } = {}) => (
  (instructors || []).map((instructor) => ({
    instructor,
    progress: getInstructorProgress(instructor, {
      userRole: instructor?.user_id ? usersById?.get(instructor.user_id)?.role ?? null : null,
      signedUserIds,
    }),
  }))
);

export const matchesProgressFilter = (progress, filterKey) => {
  if (!filterKey) return true;
  if (!progress) return false;
  if (filterKey === PROGRESS_TODO_FILTER) return progress.todo;
  return progress.key === filterKey;
};

// 各階段人數與「還沒完成」總數（todo＝未認領＋待審核＋資料未完整＋待簽約）。
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
