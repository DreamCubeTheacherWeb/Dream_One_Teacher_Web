import { supabase } from './supabaseClient';

export const taipeiToday = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

export const emptySalaryQuote = {
    loading: false,
    matched: false,
    needs_review: false,
    message: '',
    pricing_basis: null,
    pricing_label: null,
    pricing_mode: null,
    applied_rate: null,
    base_salary: null,
};

const optionalNumber = (value) => value === '' || value === null || value === undefined
    ? null
    : Number(value);

export const getSalaryQuote = async ({
    instructorId,
    courseType,
    sessionDate,
    roleInSession = 'lead',
    durationHours,
    studentCount,
}) => {
    if (!instructorId || !courseType || !sessionDate) return null;

    const { data, error } = await supabase.rpc('quote_salary', {
        p_instructor_id: instructorId,
        p_course_type: courseType,
        p_session_date: sessionDate,
        p_role_in_session: roleInSession,
        p_duration_hours: optionalNumber(durationHours),
        p_student_count: optionalNumber(studentCount),
    });

    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
};

export const money = (value) => value === null || value === undefined
    ? '待核薪'
    : `$${Math.round(Number(value)).toLocaleString()}`;

export const pricingModeLabel = (mode) => ({
    hourly: '時薪',
    per_session: '單堂固定',
    fixed: '固定金額',
    negotiable: '議價',
}[mode] || mode || '—');

export const salaryErrorMessage = (error, fallback = '處理失敗，請稍後再試') => {
    const message = error?.message || '';
    if (/submit_my_class_session|quote_salary|schema cache|could not find the function/i.test(message)) {
        return '薪資回報功能尚未完成資料庫更新，請聯絡管理員。';
    }
    if (/row-level security|permission denied|42501/i.test(message)) {
        return '您目前無法使用這個薪資功能，請聯絡管理員確認資格。';
    }
    return message || fallback;
};
