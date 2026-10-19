// 站內課程回報對齊 Google 課後回報表單的條件欄位（合作課／營隊／直營交通補助）。
// 驗證訊息與 submit_my_class_session（migration 20261020120000）一致；後端仍是最終防線。
// 2026-10-20 起：欄位顯示與順序依後台「回報表單欄位」設定（salary_report_fields）；
// 合作單位與營隊梯次掛在教學期間底下（salary_report_options.period_id）。
import { TERM_PERIOD_LABELS, courseCategoryFor, reportChannelFor } from './constants.js';
import { fieldKeySet, isFieldRequired, visibleFieldsOfLayout } from './salaryReportFields.js';

export const OTHER_OPTION = '__other__';
export const REPORT_TEXT_MAX = 200;
export const TRANSPORT_DISTANCE_MAX = 500;
// 業主 2026-10-19 指示加在回報頁交通補助旁的備註（只提示，不擋送出）
export const TRANSPORT_SUBSIDY_NOTE = '備註：超過15公里才得以申請，需要事先和課程經理確認，交通方式也需提前報備確認。';

export const EMPTY_REPORT_EXTRAS = {
    term_period: '',
    unit_choice: '',
    unit_other: '',
    materials_issued: '',
    transport_requested: false,
    transport_distance_km: '',
};

// collab_* → 合作單位課程；camp / camp_director_* / speed_camp → 營隊；其餘 → 直營
export const reportGroupFor = (courseType = '') => {
    if (courseType.startsWith('collab_')) return 'collab';
    if (courseType === 'camp' || courseType === 'speed_camp' || courseType.startsWith('camp_director_')) return 'camp';
    return 'direct';
};

export const groupReportOptions = (rows) => {
    const grouped = { term_period: [], partner_unit: [], camp_batch: [] };
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !grouped[row.kind] || row.is_active === false) continue;
        grouped[row.kind].push({
            id: row.id ?? null,
            value: row.value,
            label: row.label || row.value,
            sort_order: row.sort_order ?? 0,
            period_id: row.period_id ?? null,
        });
    }
    for (const list of Object.values(grouped)) list.sort((a, b) => a.sort_order - b.sort_order);
    // 期間停用時講師讀不到期間那一列：它底下的單位與梯次一起收掉
    const periodIds = new Set(grouped.term_period.map(period => period.id).filter(Boolean));
    for (const kind of ['partner_unit', 'camp_batch']) {
        grouped[kind] = grouped[kind].filter(item => !item.period_id || periodIds.has(item.period_id));
    }
    return grouped;
};

// 下拉選項：key 用列 id（不同期間可能同名），value 是存進回報的文字
const choiceOf = (item, period = null) => ({
    key: item.id || item.value,
    value: item.value,
    label: item.label || item.value,
    period_value: period?.value ?? null,
    period_label: period?.label ?? null,
});

export const periodByValue = (options, termPeriod) => (options?.term_period || [])
    .find(period => period.value === termPeriod) || null;

// 選到的教學期間底下的合作單位；還沒選期間或找不到期間 → 空清單（畫面提示先選期間／改自由輸入）
export const partnerUnitsFor = (options, termPeriod) => {
    const period = termPeriod ? periodByValue(options, termPeriod) : null;
    if (!period?.id) return [];
    return (options?.partner_unit || [])
        .filter(unit => unit.period_id === period.id)
        .map(unit => choiceOf(unit, period));
};

// 營隊梯次：所有啟用中期間的梯次，依期間順序排列（畫面依期間分組顯示）
export const campBatchesFor = (options) => {
    const periods = options?.term_period || [];
    const batches = options?.camp_batch || [];
    const ordered = periods.flatMap(period => batches
        .filter(batch => batch.period_id && batch.period_id === period.id)
        .map(batch => choiceOf(batch, period)));
    const loose = batches.filter(batch => !batch.period_id).map(batch => choiceOf(batch));
    return [...ordered, ...loose];
};

export const unitChoicesFor = (courseType, options, termPeriod) => {
    const group = reportGroupFor(courseType);
    if (group === 'collab') return partnerUnitsFor(options, termPeriod);
    if (group === 'camp') return campBatchesFor(options);
    return [];
};

// 到府課不問報酬項目：時數 ≤ 1.5 走「到府 1.5hr/節」，其餘走「到府 2hr/節」（業主 2026-10-19）
export const deriveCourseType = (courseType, durationHours) => {
    if (courseType !== 'onsite_2hr' && courseType !== 'onsite_1_5hr') return courseType;
    const hours = Number(durationHours);
    if (String(durationHours ?? '') === '' || !Number.isFinite(hours)) return 'onsite_2hr';
    return hours <= 1.5 ? 'onsite_1_5hr' : 'onsite_2hr';
};

export const termPeriodChoices = (options) => (options?.term_period?.length
    ? options.term_period.map(({ value, label }) => ({ value, label }))
    : Object.entries(TERM_PERIOD_LABELS).map(([value, label]) => ({ value, label })));

export const resolveUnitChoice = (extras, choices = []) => (extras.unit_choice && extras.unit_choice !== OTHER_OPTION
    ? (choices || []).find(choice => choice.key === extras.unit_choice) || null
    : null);

// 有清單時只認清單裡的選項（切換課型後殘留、對不到的選擇視為未選）；沒有清單時 unit_choice 就是文字本身
export const resolveUnitName = (extras, choices = []) => {
    if (extras.unit_choice === OTHER_OPTION) return String(extras.unit_other || '').trim();
    if (!choices?.length) return String(extras.unit_choice || '').trim();
    return String(resolveUnitChoice(extras, choices)?.value || '').trim();
};

// 依回報類別取得目前要顯示的欄位設定（沒給就用預設）
const fieldsFor = (courseType, fields) => fields || visibleFieldsOfLayout([], reportLayoutFor(courseType));

const roundDistance = (value) => Math.round(Number(value) * 10) / 10;

// context：{ fields：目前版面的欄位設定, options：groupReportOptions 的結果 }，都可省略（用預設）
export const validateReportExtras = (courseType, extras, { fields, options } = {}) => {
    const group = reportGroupFor(courseType);
    const layoutFields = fieldsFor(courseType, fields);
    const keys = fieldKeySet(layoutFields);
    const unitName = resolveUnitName(extras, unitChoicesFor(courseType, options, extras.term_period));
    const materials = extras.materials_issued.trim();
    const periodValues = options?.term_period?.length
        ? options.term_period.map(period => period.value)
        : Object.keys(TERM_PERIOD_LABELS);

    if (group === 'collab') {
        if (!extras.term_period) return '合作課程請選擇教學課程期間。';
        if (!periodValues.includes(extras.term_period)) return '教學課程期間不正確。';
        if (!unitName) return '合作課程請選擇本次上課單位。';
        if (keys.has('materials') && isFieldRequired(layoutFields, 'materials') && !materials) {
            return '請填寫本次發出教材數量（沒有發教材請填 0）。';
        }
    }
    if (group === 'camp' && !unitName) return '營隊課程請選擇營隊梯次。';
    if (group !== 'direct' && (unitName.length > REPORT_TEXT_MAX || (group === 'collab' && materials.length > REPORT_TEXT_MAX))) {
        return '上課單位／營隊梯次或教材數量不得超過 200 字。';
    }
    // 表單 B 的直營課與營隊都有交通補助；合作單位課沒有；後台可隱藏
    if (group !== 'collab' && keys.has('transport') && extras.transport_requested) {
        if (String(extras.transport_distance_km).trim() === '') return '申請交通補助請填寫單趟公里數。';
        const distance = roundDistance(extras.transport_distance_km);
        if (!Number.isFinite(distance) || distance <= 0 || distance > TRANSPORT_DISTANCE_MAX) {
            return '單趟公里數必須大於 0 且不超過 500 公里。';
        }
    }
    return '';
};

// 只送出目前課型會顯示的欄位，切換課型時殘留的隱藏值不會被寫入。
// 營隊梯次掛在期間底下：選清單裡的梯次時，連同它的期間一起送出（後台可看出是哪一期的營隊）
export const buildReportExtrasParams = (courseType, extras, { fields, options } = {}) => {
    const group = reportGroupFor(courseType);
    const keys = fieldKeySet(fieldsFor(courseType, fields));
    const choices = unitChoicesFor(courseType, options, extras.term_period);
    const unitName = resolveUnitName(extras, choices);
    const campPeriod = group === 'camp' ? resolveUnitChoice(extras, choices)?.period_value || null : null;
    const transportRequested = group !== 'collab' && keys.has('transport') && Boolean(extras.transport_requested);
    return {
        p_term_period: group === 'collab' ? (extras.term_period || null) : campPeriod,
        p_unit_name: group === 'direct' ? null : (unitName || null),
        p_materials_issued: group === 'collab' && keys.has('materials') ? (extras.materials_issued.trim() || null) : null,
        p_transport_subsidy_requested: transportRequested,
        p_transport_distance_km: transportRequested ? roundDistance(extras.transport_distance_km) : null,
    };
};

// ── 依回報類別決定要顯示哪些基本欄位（對齊兩份 Google 表單，2026-10-19）──
// b2b：講師身分別、日期、期間、單位、時數、人數、教材、特殊狀況（沒有課程名稱、地點、自評、進度）
// b2c_direct：課程種類、日期、課程名稱、時數（1／1.5／2／2.5／3／其他）、人數、交通補助、特殊狀況
// b2c_camp：是否為營隊負責人、日期、營隊梯次、人數、交通補助、特殊狀況（表單沒有時數）
// other：兩份表單都沒有的課，維持原本完整欄位
export const HOURS_PRESETS = ['1', '1.5', '2', '2.5', '3'];

export const reportLayoutFor = (courseType = '') => {
    const channel = reportChannelFor(courseType);
    if (channel === 'b2b') return 'b2b';
    if (channel === 'b2c') return courseCategoryFor(courseType) === 'camp' ? 'b2c_camp' : 'b2c_direct';
    return 'other';
};

// 目前版面要顯示的欄位代碼（依後台設定；沒給設定就用預設）。b2c_direct 的 hours 以 1／1.5／2… 下拉呈現
export const reportFieldsFor = (courseType, fields) => fieldKeySet(fieldsFor(courseType, fields));

export const INCIDENT_LABELS = {
    b2b: '特殊狀況或其他問題回報（選填）',
    b2c_direct: '特殊狀況回饋（選填）',
    b2c_camp: '特殊狀況回饋（選填）',
    other: '特殊狀況回報（選填）',
};

// 表單沒有「角色」欄位時，由報酬項目推得角色（助教類→助教、營隊負責人→負責人）
export const roleForCourseType = (courseType = '') => {
    if (courseType.endsWith('_assistant')) return 'assistant';
    if (courseType.startsWith('camp_director_') || courseType === 'collab_project') return 'project_lead';
    if (courseType === 'counter') return 'counter';
    if (courseType === 'cert_sub_judge') return 'sub_judge';
    return 'lead';
};

// 後台可改必填的內建文字欄位 → 回報表單上的欄位名
const REQUIRABLE_TEXT_FIELDS = [
    ['course_name', 'course_name'],
    ['location', 'location'],
    ['self_review', 'self_review'],
    ['incident', 'incident_report'],
];

// 表單上的必填欄位（後端對這些欄位仍允許空值，前端照表單要求與後台設定）
export const validateReportBasics = (courseType, form, fields) => {
    const layout = reportLayoutFor(courseType);
    const layoutFields = fieldsFor(courseType, fields);
    const keys = fieldKeySet(layoutFields);
    for (const [fieldKey, formKey] of REQUIRABLE_TEXT_FIELDS) {
        if (!keys.has(fieldKey) || !isFieldRequired(layoutFields, fieldKey) || String(form[formKey] || '').trim()) continue;
        if (fieldKey === 'course_name' && layout === 'b2c_direct') return '請填寫課程名稱（學生代表姓名或課程地點）。';
        const label = layoutFields.find(field => field.field_key === fieldKey)?.label || fieldKey;
        return `請填寫${label}。`;
    }
    if ((layout === 'b2b' || layout === 'b2c_direct') && String(form.duration_hours ?? '').trim() === '') return '請填寫上課時數。';
    if (layout !== 'other' && String(form.student_count ?? '').trim() === '') return '請填寫本次上課人數。';
    return '';
};

const textOrNull = (value) => String(value || '').trim() || null;

// 只送出目前版面看得到的基本欄位，切換類別或後台隱藏的欄位不會被寫入
export const buildReportBasicParams = (courseType, form, fields) => {
    const keys = reportFieldsFor(courseType, fields);
    return {
        p_role_in_session: keys.has('role') ? form.role_in_session : roleForCourseType(courseType),
        p_course_name: keys.has('course_name') ? textOrNull(form.course_name) : null,
        p_location: keys.has('location') ? textOrNull(form.location) : null,
        p_duration_hours: keys.has('hours') && String(form.duration_hours ?? '') !== '' ? Number(form.duration_hours) : null,
        p_student_count: keys.has('students') && String(form.student_count ?? '') !== '' ? Number(form.student_count) : null,
        p_self_review: keys.has('self_review') ? textOrNull(form.self_review) : null,
        p_progress_note: keys.has('progress') ? textOrNull(form.progress_note) : null,
        p_incident_report: keys.has('incident') ? textOrNull(form.incident_report) : null,
    };
};
