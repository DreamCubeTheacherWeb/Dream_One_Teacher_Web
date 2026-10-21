// 後台「回報選項管理」的純函式：期間與各期間清單、排序、驗證、拖曳後的新順序、複製清單。
// 不碰網路與畫面，方便 node --test 直接驗證。
//
// 資料結構（migration 20261020130000）：
//   期間 kind='term_period'（period_id 為 NULL，value 是講師回報存下的代碼）
//   上課單位 kind='partner_unit'、營隊梯次 kind='camp_batch'，各自以 period_id 掛在某個期間底下

export const OPTION_LABEL_MAX = 200;
export const SORT_STEP = 10;

// 每個期間底下的兩份清單
export const PERIOD_SECTIONS = [
    {
        kind: 'partner_unit',
        title: '上課單位',
        noun: '單位',
        placeholder: '例如：【新竹】愛丁堡 週二班',
        hint: 'B2B 合作課講師選了這個期間後，「本次上課單位」下拉會列出這裡的單位。',
    },
    {
        kind: 'camp_batch',
        title: '營隊梯次',
        noun: '梯次',
        placeholder: '例如：【臺北A】中山 | 7/1~7/3 三日營',
        hint: '營隊講師回報時，「營隊梯次」下拉會列出所有啟用中期間的梯次。',
    },
];

export const sectionConfig = (kind) => PERIOD_SECTIONS.find((item) => item.kind === kind) || null;

const sortValue = (option) => Number(option?.sort_order) || 0;

// 依 sort_order 由小到大；相同時依 label，確保畫面順序穩定
export const sortOptions = (options) => [...(Array.isArray(options) ? options : [])].sort((a, b) => (
    sortValue(a) - sortValue(b) || String(a?.label ?? '').localeCompare(String(b?.label ?? ''), 'zh-Hant')
));

export const periodsOf = (options) => sortOptions(
    (Array.isArray(options) ? options : []).filter((option) => option?.kind === 'term_period'),
);

// 某個期間底下某一種清單（上課單位／營隊梯次）
export const itemsOfPeriod = (options, periodId, kind) => sortOptions(
    (Array.isArray(options) ? options : []).filter((option) => (
        option?.kind === kind && periodId && option?.period_id === periodId
    )),
);

// 期間卡片上的筆數摘要：{ partner_unit: { total, active }, camp_batch: { total, active } }
export const periodCounts = (options, periodId) => Object.fromEntries(PERIOD_SECTIONS.map(({ kind }) => {
    const items = itemsOfPeriod(options, periodId, kind);
    return [kind, { total: items.length, active: items.filter((item) => item.is_active !== false).length }];
}));

// 新增時的排序預設：目前最大值＋10（沒有任何選項時為 10）
export const nextSortOrder = (options) => {
    const list = Array.isArray(options) ? options : [];
    if (list.length === 0) return SORT_STEP;
    return Math.max(...list.map(sortValue)) + SORT_STEP;
};

// 回傳 { ok:true, label } 或 { ok:false, message }；siblings＝同一份清單（同期間同種類，或全部期間）
export const validateOptionLabel = (rawLabel, siblings = [], { ignoreId = null, noun = '選項' } = {}) => {
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
    if (!label) return { ok: false, message: `請輸入${noun}名稱。` };
    if (label.length > OPTION_LABEL_MAX) return { ok: false, message: `${noun}名稱不得超過 ${OPTION_LABEL_MAX} 字。` };
    const duplicate = (Array.isArray(siblings) ? siblings : []).some((option) => (
        option.id !== ignoreId && (option.value === label || option.label === label)
    ));
    if (duplicate) return { ok: false, message: `這份清單已經有相同的${noun}。` };
    return { ok: true, label };
};

// 新期間的代碼：講師回報存的是代碼，名稱之後改了舊紀錄仍對得到同一個期間
export const newPeriodValue = (random = Math.random) => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 10; i += 1) suffix += alphabet[Math.floor(random() * alphabet.length)];
    return `term_${suffix}`;
};

// 新增期間時「從某期複製清單」：回傳要 insert 的列（名稱、順序、啟用狀態照抄，掛到新期間）。
// 預設只複製上課單位：營隊梯次帶日期（7/1~7/3…），每期不同；複製過去又沒停用舊期間時，
// 講師的梯次下拉會出現兩組同名梯次，容易選到錯的期間。
export const COPY_KINDS = ['partner_unit'];
export const planCopyItems = (options, sourcePeriodId, newPeriodId, kinds = COPY_KINDS) => {
    if (!sourcePeriodId || !newPeriodId) return [];
    return PERIOD_SECTIONS.filter(({ kind }) => kinds.includes(kind)).flatMap(({ kind }) => itemsOfPeriod(options, sourcePeriodId, kind).map((item) => ({
        kind,
        value: item.value,
        label: item.label,
        sort_order: sortValue(item),
        is_active: item.is_active !== false,
        period_id: newPeriodId,
    })));
};

// 拖曳放開後的新順序（id 陣列）；沒有移動或找不到時回傳 null
export const reorderIds = (list, activeId, overId) => {
    const ids = (Array.isArray(list) ? list : []).map((item) => item.id);
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0 || from === to) return null;
    const next = [...ids];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
};

// 依新順序把清單的 sort_order 改成 10、20、30…（樂觀更新畫面用，與 reorder RPC 寫入的值相同）
export const applyOrder = (options, orderedIds) => {
    const position = new Map((orderedIds || []).map((id, index) => [id, (index + 1) * SORT_STEP]));
    return (Array.isArray(options) ? options : []).map((option) => (
        position.has(option.id) ? { ...option, sort_order: position.get(option.id) } : option
    ));
};

// 目前該選哪個期間：原本選的還在就沿用，否則選第一個；沒有任何期間回傳 null
export const pickPeriodId = (periods, currentId) => {
    const list = Array.isArray(periods) ? periods : [];
    if (currentId && list.some((period) => period.id === currentId)) return currentId;
    return list[0]?.id ?? null;
};

// Postgres 唯一鍵衝突（同一份清單同名）
export const isDuplicateError = (error) => error?.code === '23505';

export const optionErrorMessage = (error, fallback = '操作失敗，請稍後再試。') => {
    if (!error) return fallback;
    if (isDuplicateError(error)) return '這份清單已經有相同的名稱。';
    if (error.code === '42501' || /row-level security|permission denied/i.test(error.message || '')) {
        return '沒有權限執行這個操作，請確認是否以管理員登入。';
    }
    return `${fallback}${error.message ? `（${error.message}）` : ''}`;
};

// 讀取選項失敗：欄位不存在（42703）通常代表資料庫還沒套用 2026-10-20 的更新
export const optionsLoadErrorMessage = (error) => {
    if (error?.code === '42703' || /period_id/i.test(error?.message || '')) {
        return '讀取選項失敗，資料庫可能還沒套用 2026-10-20 的更新。';
    }
    return optionErrorMessage(error, '讀取選項失敗');
};
