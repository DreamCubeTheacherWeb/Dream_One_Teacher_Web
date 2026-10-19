// 站內課程回報對齊 Google 課後回報表單的條件欄位（合作課／營隊／直營交通補助）。
// 驗證訊息與 submit_my_class_session（migration 20261018120000）一致；後端仍是最終防線。
import { TERM_PERIOD_LABELS, courseCategoryFor, reportChannelFor } from './constants.js';

export const OTHER_OPTION = '__other__';
export const REPORT_TEXT_MAX = 200;
export const TRANSPORT_DISTANCE_MAX = 500;

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
        grouped[row.kind].push({ value: row.value, label: row.label || row.value, sort_order: row.sort_order ?? 0 });
    }
    for (const list of Object.values(grouped)) list.sort((a, b) => a.sort_order - b.sort_order);
    return grouped;
};

export const termPeriodChoices = (options) => (options?.term_period?.length
    ? options.term_period.map(({ value, label }) => ({ value, label }))
    : Object.entries(TERM_PERIOD_LABELS).map(([value, label]) => ({ value, label })));

export const resolveUnitName = (extras) => (extras.unit_choice === OTHER_OPTION
    ? extras.unit_other
    : extras.unit_choice).trim();

const roundDistance = (value) => Math.round(Number(value) * 10) / 10;

export const validateReportExtras = (courseType, extras) => {
    const group = reportGroupFor(courseType);
    const unitName = resolveUnitName(extras);
    const materials = extras.materials_issued.trim();

    if (group === 'collab') {
        if (!extras.term_period) return '合作課程請選擇教學課程期間。';
        if (!TERM_PERIOD_LABELS[extras.term_period]) return '教學課程期間不正確。';
        if (!unitName) return '合作課程請選擇本次上課單位。';
    }
    if (group === 'camp' && !unitName) return '營隊課程請選擇營隊梯次。';
    if (group !== 'direct' && (unitName.length > REPORT_TEXT_MAX || (group === 'collab' && materials.length > REPORT_TEXT_MAX))) {
        return '上課單位／營隊梯次或教材數量不得超過 200 字。';
    }
    // 表單 B 的直營課與營隊都有交通補助；合作單位課沒有
    if (group !== 'collab' && extras.transport_requested) {
        if (String(extras.transport_distance_km).trim() === '') return '申請交通補助請填寫單趟公里數。';
        const distance = roundDistance(extras.transport_distance_km);
        if (!Number.isFinite(distance) || distance <= 0 || distance > TRANSPORT_DISTANCE_MAX) {
            return '單趟公里數必須大於 0 且不超過 500 公里。';
        }
    }
    return '';
};

// 只送出目前課型會顯示的欄位，切換課型時殘留的隱藏值不會被寫入
export const buildReportExtrasParams = (courseType, extras) => {
    const group = reportGroupFor(courseType);
    const unitName = resolveUnitName(extras);
    const transportRequested = group !== 'collab' && Boolean(extras.transport_requested);
    return {
        p_term_period: group === 'collab' ? (extras.term_period || null) : null,
        p_unit_name: group === 'direct' ? null : (unitName || null),
        p_materials_issued: group === 'collab' ? (extras.materials_issued.trim() || null) : null,
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

const LAYOUT_FIELDS = {
    b2b: ['hours', 'students'],
    b2c_direct: ['course_name', 'hours_preset', 'students', 'transport'],
    b2c_camp: ['students', 'transport'],
    other: ['role', 'course_name', 'hours', 'students', 'location', 'transport', 'self_review', 'progress'],
};

export const reportFieldsFor = (courseType) => new Set(LAYOUT_FIELDS[reportLayoutFor(courseType)]);

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

// 表單上的必填欄位（後端對這些欄位仍允許空值，前端照表單要求）
export const validateReportBasics = (courseType, form) => {
    const layout = reportLayoutFor(courseType);
    if (layout === 'b2c_direct' && !String(form.course_name || '').trim()) return '請填寫課程名稱（學生代表姓名或課程地點）。';
    if ((layout === 'b2b' || layout === 'b2c_direct') && String(form.duration_hours ?? '').trim() === '') return '請填寫上課時數。';
    if (layout !== 'other' && String(form.student_count ?? '').trim() === '') return '請填寫本次上課人數。';
    return '';
};

const textOrNull = (value) => String(value || '').trim() || null;

// 只送出目前版面看得到的基本欄位，切換類別時殘留的隱藏值不會被寫入
export const buildReportBasicParams = (courseType, form) => {
    const fields = reportFieldsFor(courseType);
    const hasHours = fields.has('hours') || fields.has('hours_preset');
    return {
        p_role_in_session: fields.has('role') ? form.role_in_session : roleForCourseType(courseType),
        p_course_name: fields.has('course_name') ? textOrNull(form.course_name) : null,
        p_location: fields.has('location') ? textOrNull(form.location) : null,
        p_duration_hours: hasHours && String(form.duration_hours ?? '') !== '' ? Number(form.duration_hours) : null,
        p_student_count: String(form.student_count ?? '') !== '' ? Number(form.student_count) : null,
        p_self_review: fields.has('self_review') ? textOrNull(form.self_review) : null,
        p_progress_note: fields.has('progress') ? textOrNull(form.progress_note) : null,
        p_incident_report: textOrNull(form.incident_report),
    };
};
