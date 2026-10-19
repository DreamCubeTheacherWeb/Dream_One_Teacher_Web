// 講師「登記課程回報」表單欄位設定（salary_report_fields，migration 20261020120000）的純函式。
// 後台設定頁與講師回報頁共用。
//   system：算報酬會用到的欄位，鎖住（只能排序）
//   builtin：內建欄位，可隱藏、部分可改必填
//   custom：管理員新增的欄位，可改名、改型別、刪除；答案存 class_sessions.extra_fields

export const REPORT_LAYOUTS = [
    { key: 'b2c_direct', label: 'B2C 直營課程', hint: '到府、線上、體驗、速解研究所' },
    { key: 'b2b', label: 'B2B 合作單位', hint: '學校、補習班等合作單位課程' },
    { key: 'b2c_camp', label: '營隊', hint: '寒暑假營隊（含負責人）' },
    { key: 'other', label: '其他課程', hint: '常態課、幼兒啟蒙、站櫃等' },
];

export const layoutLabel = (layout) => REPORT_LAYOUTS.find((item) => item.key === layout)?.label || layout;

// 永遠固定在表單最上面、不在設定表裡的欄位（後台只顯示說明）
export const PINNED_FIELD_LABELS = ['回報類別', '上課日期', '課程種類', '報酬項目／講師身分別'];

export const FIELD_SOURCES = {
    system: { label: '算報酬用', hint: '系統用來算報酬，不能隱藏或刪除，只能調整順序' },
    builtin: { label: '內建', hint: '可以隱藏；隱藏後講師看不到、也不會送出' },
    custom: { label: '自訂', hint: '管理員新增的欄位，可改名或刪除' },
};

export const FIELD_TYPES = [
    { key: 'text', label: '單行文字' },
    { key: 'textarea', label: '多行文字' },
    { key: 'number', label: '數字' },
    { key: 'select', label: '下拉選單' },
    { key: 'boolean', label: '是／否勾選' },
];

export const fieldTypeLabel = (type) => FIELD_TYPES.find((item) => item.key === type)?.label || type;

export const CUSTOM_LABEL_MAX = 60;
export const CUSTOM_HELP_MAX = 200;
export const CUSTOM_OPTION_MAX = 50;
export const CUSTOM_OPTION_LABEL_MAX = 100;
export const CUSTOM_ANSWER_MAX = 2000;

// 內建欄位中可以改「必填」的（其他內建欄位只能顯示／隱藏）
export const REQUIRABLE_BUILTINS = new Set(['course_name', 'location', 'materials', 'self_review', 'incident']);

// 與 migration 種子相同；設定表讀不到時講師回報頁退回這份，不擋回報
const seed = (layout, rows) => rows.map(([field_key, source, label, is_required], index) => ({
    id: `default:${layout}:${field_key}`,
    layout,
    field_key,
    source,
    label,
    field_type: 'text',
    options: [],
    help_text: null,
    is_required,
    is_visible: true,
    sort_order: (index + 1) * 10,
}));

export const DEFAULT_REPORT_FIELDS = [
    ...seed('b2b', [
        ['term_period', 'system', '教學課程期間', false],
        ['unit', 'system', '本次上課單位', false],
        ['hours', 'system', '上課時數', false],
        ['students', 'system', '本次上課人數', false],
        ['materials', 'builtin', '本次發出教材數量', true],
        ['incident', 'builtin', '特殊狀況或其他問題回報', false],
    ]),
    ...seed('b2c_direct', [
        ['course_name', 'builtin', '課程名稱', true],
        ['hours', 'system', '上課時數', false],
        ['students', 'system', '實際上課人數', false],
        ['transport', 'builtin', '交通補助', false],
        ['incident', 'builtin', '特殊狀況回饋', false],
    ]),
    ...seed('b2c_camp', [
        ['camp_batch', 'system', '營隊梯次', false],
        ['students', 'system', '上課人數', false],
        ['transport', 'builtin', '交通補助', false],
        ['incident', 'builtin', '特殊狀況回饋', false],
    ]),
    ...seed('other', [
        ['role', 'system', '角色', false],
        ['course_name', 'builtin', '課程名稱', false],
        ['hours', 'system', '時數', false],
        ['students', 'system', '人數', false],
        ['location', 'builtin', '地點', false],
        ['transport', 'builtin', '交通補助', false],
        ['self_review', 'builtin', '課程自評', false],
        ['progress', 'system', '學習進度', false],
        ['incident', 'builtin', '特殊狀況回報', false],
    ]),
];

const sortValue = (row) => Number(row?.sort_order) || 0;
const byOrder = (a, b) => sortValue(a) - sortValue(b) || String(a?.field_key ?? '').localeCompare(String(b?.field_key ?? ''));

const normalizeRow = (row) => ({
    ...row,
    options: Array.isArray(row?.options) ? row.options.map(String) : [],
    help_text: row?.help_text || null,
    is_required: Boolean(row?.is_required),
    is_visible: row?.is_visible !== false,
});

// 後台用：某版面的全部欄位（含隱藏），依順序
export const allFieldsOfLayout = (rows, layout) => (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.layout === layout)
    .map(normalizeRow)
    .sort(byOrder);

// 講師回報頁用：某版面要顯示的欄位，依順序。
// 設定表沒有這個版面（讀取失敗）→ 用預設；算報酬用的欄位若不在清單裡（不應發生）補在最後，確保送得出去。
export const visibleFieldsOfLayout = (rows, layout) => {
    const configured = allFieldsOfLayout(rows, layout);
    const base = configured.length ? configured : allFieldsOfLayout(DEFAULT_REPORT_FIELDS, layout);
    const visible = base.filter((row) => row.is_visible || row.source === 'system');
    const missingSystem = allFieldsOfLayout(DEFAULT_REPORT_FIELDS, layout)
        .filter((row) => row.source === 'system' && !visible.some((field) => field.field_key === row.field_key));
    return [...visible, ...missingSystem];
};

export const fieldKeySet = (fields) => new Set((fields || []).map((field) => field.field_key));

export const isFieldRequired = (fields, fieldKey) => Boolean(
    (fields || []).find((field) => field.field_key === fieldKey)?.is_required,
);

export const customFieldsOf = (fields) => (fields || []).filter((field) => field.source === 'custom');

// 新自訂欄位的代碼（custom_ ＋ 10 碼英數），與資料庫 CHECK 一致
export const newCustomFieldKey = (random = Math.random) => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 10; i += 1) suffix += alphabet[Math.floor(random() * alphabet.length)];
    return `custom_${suffix}`;
};

// 下拉選項：一行一個；去空白、去重複
export const parseOptionsText = (text) => {
    const seen = new Set();
    const list = [];
    for (const raw of String(text ?? '').split(/\r?\n/)) {
        const value = raw.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        list.push(value);
    }
    return list;
};

// 新增／編輯自訂欄位前檢查；回傳 { ok:true, value } 或 { ok:false, message }
export const validateCustomField = (draft, siblings = [], { ignoreId = null } = {}) => {
    const label = String(draft?.label ?? '').trim();
    const fieldType = draft?.field_type || 'text';
    const helpText = String(draft?.help_text ?? '').trim();
    const options = fieldType === 'select' ? parseOptionsText(draft?.optionsText ?? (draft?.options || []).join('\n')) : [];

    if (!label) return { ok: false, message: '請輸入欄位名稱。' };
    if (label.length > CUSTOM_LABEL_MAX) return { ok: false, message: `欄位名稱不得超過 ${CUSTOM_LABEL_MAX} 字。` };
    if (!FIELD_TYPES.some((type) => type.key === fieldType)) return { ok: false, message: '請選擇欄位類型。' };
    if (helpText.length > CUSTOM_HELP_MAX) return { ok: false, message: `說明文字不得超過 ${CUSTOM_HELP_MAX} 字。` };
    if (fieldType === 'select') {
        if (options.length === 0) return { ok: false, message: '下拉選單至少要有一個選項（一行一個）。' };
        if (options.length > CUSTOM_OPTION_MAX) return { ok: false, message: `下拉選項最多 ${CUSTOM_OPTION_MAX} 個。` };
        if (options.some((option) => option.length > CUSTOM_OPTION_LABEL_MAX)) {
            return { ok: false, message: `每個下拉選項不得超過 ${CUSTOM_OPTION_LABEL_MAX} 字。` };
        }
    }
    const duplicate = (Array.isArray(siblings) ? siblings : []).some((field) => field.id !== ignoreId && field.label === label);
    if (duplicate) return { ok: false, message: '這個版面已經有同名的欄位。' };
    return {
        ok: true,
        value: {
            label,
            field_type: fieldType,
            options,
            help_text: helpText || null,
            is_required: fieldType === 'boolean' ? false : Boolean(draft?.is_required),
        },
    };
};

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

// 講師送出前檢查自訂欄位（必填、數字格式、長度）；回傳錯誤訊息或空字串
export const validateCustomAnswers = (fields, answers = {}) => {
    for (const field of customFieldsOf(fields)) {
        const value = answers[field.field_key];
        if (field.field_type === 'boolean') continue;
        if (isBlank(value)) {
            if (field.is_required) return `請填寫「${field.label}」。`;
            continue;
        }
        if (field.field_type === 'number' && !Number.isFinite(Number(value))) return `「${field.label}」請填數字。`;
        if (field.field_type === 'select' && !field.options.includes(String(value))) return `請重新選擇「${field.label}」。`;
        if (String(value).length > CUSTOM_ANSWER_MAX) return `「${field.label}」不得超過 ${CUSTOM_ANSWER_MAX} 字。`;
    }
    return '';
};

// 送出用：只送目前版面顯示中的自訂欄位；全部沒填回傳 null
export const buildExtraFieldsParam = (fields, answers = {}) => {
    const result = {};
    for (const field of customFieldsOf(fields)) {
        const value = answers[field.field_key];
        if (field.field_type === 'boolean') {
            result[field.field_key] = Boolean(value);
            continue;
        }
        if (isBlank(value)) continue;
        result[field.field_key] = field.field_type === 'number' ? Number(value) : String(value).trim();
    }
    return Object.keys(result).length ? result : null;
};

// 後台顯示講師填的自訂欄位：[{ key, label, text }]（名稱用回報當時的快照）
export const extraFieldEntries = (extraFields) => {
    if (!extraFields || typeof extraFields !== 'object' || Array.isArray(extraFields)) return [];
    return Object.entries(extraFields).map(([key, entry]) => {
        const label = entry && typeof entry === 'object' ? (entry.label || key) : key;
        const raw = entry && typeof entry === 'object' ? entry.value : entry;
        const text = typeof raw === 'boolean' ? (raw ? '是' : '否') : String(raw ?? '');
        return { key, label, text };
    });
};

export const reportFieldErrorMessage = (error, fallback = '操作失敗，請稍後再試。') => {
    if (!error) return fallback;
    if (error.code === '23505') return '這個版面已經有相同的欄位。';
    if (error.code === '42501' || /row-level security|permission denied/i.test(error.message || '')) {
        return error.message && !/row-level security|permission denied/i.test(error.message)
            ? error.message
            : '沒有權限執行這個操作，請確認是否以管理員登入。';
    }
    return `${fallback}${error.message ? `（${error.message}）` : ''}`;
};
