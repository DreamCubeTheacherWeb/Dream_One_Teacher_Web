// 站內課程回報對齊 Google 課後回報表單的條件欄位（合作課／營隊／直營交通補助）。
// 驗證訊息與 submit_my_class_session（migration 20261018120000）一致；後端仍是最終防線。
import { TERM_PERIOD_LABELS } from './constants.js';

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
