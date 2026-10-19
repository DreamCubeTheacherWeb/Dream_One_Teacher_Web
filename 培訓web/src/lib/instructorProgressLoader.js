import { supabase } from './supabaseClient';
import {
  INSTRUCTOR_PROGRESS_COLUMNS,
  buildActivationMap,
  buildProgressRows,
  buildSignedUserIdSet,
  countProgress,
} from './instructorProgress';

/*
 * 老師資料進度需要的 Supabase 讀取（純判斷邏輯在 instructorProgress.js，可單獨測試）。
 *
 * 權限（RLS）：
 *   - public.users：admin、mentor 都讀得到全部列（policy "Staff can view all profiles"）。
 *   - public.instructor_contracts：只有管理員讀得到全部（"Admins can do everything on contracts"）；
 *     輔導員查詢會得到「空陣列」而不是錯誤，所以不能靠回傳判斷有沒有權限，
 *     呼叫端用 includeContracts（＝目前是不是 admin）決定要不要查，沒查就回 signedUserIds: null。
 *   - public.instructor_account_activations（帳號啟用紀錄）：只有管理員讀得到全部（本人只讀得到自己的），
 *     所以和簽約紀錄一樣，由 includeContracts（＝admin）決定要不要查；讀不到就回 activationsByUserId: null，
 *     進度判斷會退而用 instructors.confirmed_email 區分「待信箱驗證」。
 *   - 任何一個查詢失敗都不丟錯：該項回 null，畫面顯示「—」或「資料已完整（簽約狀態未知）」。
 */

const PAGE_SIZE = 1000;
const MAX_PAGES = 50;

// PostgREST 單次最多回 1000 列；分頁撈完，避免名單超過 1000 人時進度悄悄少算。
export const fetchAllPages = async (makeQuery) => {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE_SIZE;
    const { data, error } = await makeQuery().range(from, from + PAGE_SIZE - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { data: rows, error: null };
};

export const loadProgressSupport = async ({ includeContracts }) => {
  const [usersResult, contractsResult, activationsResult] = await Promise.all([
    fetchAllPages(() => supabase.from('users').select('id, email, role').order('id')),
    includeContracts
      ? fetchAllPages(() => supabase
        .from('instructor_contracts')
        .select('user_id, status')
        .eq('status', 'signed')
        .order('id'))
      : Promise.resolve({ data: null, error: null }),
    includeContracts
      ? fetchAllPages(() => supabase
        .from('instructor_account_activations')
        .select('user_id, status, claim_method')
        .eq('status', 'pending')
        .order('id'))
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (usersResult.error) console.error('讀取登入帳號狀態失敗：', usersResult.error.message);
  if (contractsResult.error) console.error('讀取簽約紀錄失敗：', contractsResult.error.message);
  if (activationsResult.error) console.error('讀取帳號啟用紀錄失敗：', activationsResult.error.message);

  return {
    usersById: usersResult.data ? new Map(usersResult.data.map((row) => [row.id, row])) : null,
    signedUserIds: buildSignedUserIdSet(contractsResult.data),
    activationsByUserId: buildActivationMap(activationsResult.data),
    supportError: Boolean(usersResult.error || contractsResult.error || activationsResult.error),
  };
};

// 後台首頁用：輕量欄位＋算好各階段人數。
export const loadInstructorProgressSummary = async ({ includeContracts }) => {
  const selectInstructors = (columns) => fetchAllPages(() => supabase
    .from('instructors')
    .select(columns.join(','))
    .order('created_at', { ascending: false })
    .order('id'));

  const supportPromise = loadProgressSupport({ includeContracts });
  let instructorsResult = await selectInstructors(INSTRUCTOR_PROGRESS_COLUMNS);

  // 前端比資料庫 migration 先上線時 confirmed_email 欄位還不存在：退回不含該欄位再查一次，
  // 後台首頁的追蹤卡片不能因此整個讀取失敗（少了該欄只會讓「待信箱驗證」暫時算進「待審核」）。
  if (instructorsResult.error && /confirmed_email/.test(instructorsResult.error.message || '')) {
    instructorsResult = await selectInstructors(INSTRUCTOR_PROGRESS_COLUMNS.filter((column) => column !== 'confirmed_email'));
  }
  const support = await supportPromise;

  if (instructorsResult.error) {
    console.error('讀取老師資料進度失敗：', instructorsResult.error.message);
    return { counts: null, contractKnown: false, supportError: true };
  }

  const rows = buildProgressRows(instructorsResult.data, support);
  return {
    counts: countProgress(rows),
    contractKnown: support.signedUserIds !== null,
    activationKnown: support.activationsByUserId !== null,
    supportError: support.supportError,
  };
};
