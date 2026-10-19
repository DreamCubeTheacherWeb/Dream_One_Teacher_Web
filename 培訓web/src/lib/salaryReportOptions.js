// 後台「回報選項管理」的純函式：排序、驗證、下一個排序值、上移／下移。
// 不碰網路與畫面，方便 node --test 直接驗證。

export const OPTION_LABEL_MAX = 200;
export const SORT_STEP = 10;

// 三個分頁；term_period 的 value 是固定代碼，只允許改名與啟用，不可新增
export const OPTION_KINDS = [
    { kind: 'term_period', title: '教學課程期間', canAdd: false, hint: '寒假、學期間、暑假是系統固定代碼，只能改顯示文字或停用。' },
    { kind: 'partner_unit', title: '合作單位', canAdd: true, hint: '合作課講師回報時的「本次上課單位」下拉選項。' },
    { kind: 'camp_batch', title: '營隊梯次', canAdd: true, hint: '營隊課講師回報時的「營隊梯次」下拉選項。' },
];

export const kindConfig = (kind) => OPTION_KINDS.find((item) => item.kind === kind) || null;

const sortValue = (option) => Number(option?.sort_order) || 0;

// 依 sort_order 由小到大；相同時依 label，確保畫面順序穩定
export const sortOptions = (options) => [...(Array.isArray(options) ? options : [])].sort((a, b) => (
    sortValue(a) - sortValue(b) || String(a?.label ?? '').localeCompare(String(b?.label ?? ''), 'zh-Hant')
));

export const optionsOfKind = (options, kind) => sortOptions(
    (Array.isArray(options) ? options : []).filter((option) => option?.kind === kind),
);

// 新增時的排序預設：目前最大值＋10（沒有任何選項時為 10）
export const nextSortOrder = (options) => {
    const list = Array.isArray(options) ? options : [];
    if (list.length === 0) return SORT_STEP;
    return Math.max(...list.map(sortValue)) + SORT_STEP;
};

// 回傳 { ok:true, label } 或 { ok:false, message }
export const validateOptionLabel = (rawLabel, siblings = [], { ignoreId = null } = {}) => {
    const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
    if (!label) return { ok: false, message: '請輸入選項文字。' };
    if (label.length > OPTION_LABEL_MAX) return { ok: false, message: `選項文字不得超過 ${OPTION_LABEL_MAX} 字。` };
    const duplicate = (Array.isArray(siblings) ? siblings : []).some((option) => (
        option.id !== ignoreId && (option.value === label || option.label === label)
    ));
    if (duplicate) return { ok: false, message: '這個分頁已經有相同的選項。' };
    return { ok: true, label };
};

// 上移／下移：回傳需要更新的 [{ id, sort_order }]；到頂／到底回傳 []
// 相鄰兩筆排序值不同 → 只交換這兩筆；相同（資料有重複值）→ 整組重編成 10、20、30…，只回傳有變的
export const planMove = (kindOptions, id, direction) => {
    const list = sortOptions(kindOptions);
    const index = list.findIndex((option) => option.id === id);
    const target = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || target < 0 || target >= list.length) return [];

    const current = list[index];
    const neighbor = list[target];
    if (sortValue(current) !== sortValue(neighbor)) {
        return [
            { id: current.id, sort_order: sortValue(neighbor) },
            { id: neighbor.id, sort_order: sortValue(current) },
        ];
    }
    const reordered = [...list];
    reordered[index] = neighbor;
    reordered[target] = current;
    return reordered
        .map((option, position) => ({ id: option.id, sort_order: (position + 1) * SORT_STEP }))
        .filter((update) => sortValue(list.find((option) => option.id === update.id)) !== update.sort_order);
};

// 畫面用：到頂不能再上移、到底不能再下移
export const canMove = (kindOptions, id, direction) => {
    const list = sortOptions(kindOptions);
    const index = list.findIndex((option) => option.id === id);
    if (index < 0) return false;
    return direction === 'up' ? index > 0 : index < list.length - 1;
};

// Postgres 唯一鍵衝突（kind＋value 重複）
export const isDuplicateError = (error) => error?.code === '23505';

export const optionErrorMessage = (error, fallback = '操作失敗，請稍後再試。') => {
    if (!error) return fallback;
    if (isDuplicateError(error)) return '這個分頁已經有相同的選項。';
    if (error.code === '42501' || /row-level security|permission denied/i.test(error.message || '')) {
        return '沒有權限執行這個操作，請確認是否以管理員登入。';
    }
    return `${fallback}${error.message ? `（${error.message}）` : ''}`;
};
