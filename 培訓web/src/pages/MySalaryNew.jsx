import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Calendar, BookOpen, Users, Clock, MessageSquare, AlertCircle, Send, ArrowLeft, Building2, Package, Car, Tent } from 'lucide-react';
import { COURSE_LABELS, ROLE_LABELS, speedQualificationLabel } from '../lib/constants';
import { getSalaryQuote, salaryErrorMessage, taipeiToday } from '../lib/salary';
import SalaryQuotePanel from '../components/SalaryQuotePanel';
import {
    EMPTY_REPORT_EXTRAS,
    OTHER_OPTION,
    REPORT_TEXT_MAX,
    TRANSPORT_DISTANCE_MAX,
    buildReportExtrasParams,
    groupReportOptions,
    reportGroupFor,
    termPeriodChoices,
    validateReportExtras,
} from '../lib/salaryReportForm';

const TAIPEI_TODAY = taipeiToday();
const PROGRESS_REQUIRED_COURSES = new Set(['regular_basic', 'regular_advanced']);
// 講師端可見範圍門檻（與 migration 20261018150000 的 instructor_salary_visible_from() 一致）
const SALARY_VISIBLE_FROM = '2026-01-01';

const MySalaryNew = () => {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [instructor, setInstructor] = useState(null);
    const [form, setForm] = useState({
        course_type: 'regular_basic',
        course_name: '',
        session_date: TAIPEI_TODAY,
        role_in_session: 'lead',
        duration_hours: '',
        student_count: '',
        location: '',
        self_review: '',
        progress_note: '',
        incident_report: '',
    });
    const [extras, setExtras] = useState(EMPTY_REPORT_EXTRAS);
    const [reportOptions, setReportOptions] = useState(() => groupReportOptions([]));
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [instructorLoading, setInstructorLoading] = useState(true);
    const [quote, setQuote] = useState(null);
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quoteError, setQuoteError] = useState('');

    useEffect(() => {
        if (!user) return undefined;
        let active = true;
        (async () => {
            const { data, error: loadError } = await supabase
                .from('instructors')
                .select('id, full_name, instructor_role, speed_qualification')
                .eq('user_id', user.id)
                .maybeSingle();
            if (!active) return;
            setInstructor(data);
            if (loadError) setError('講師資料載入失敗，請重新整理頁面或聯絡管理員。');
            setInstructorLoading(false);
        })();
        return () => { active = false; };
    }, [user]);

    // 下拉選項（教學期間／合作單位／營隊梯次）；讀取失敗就退回自由輸入，不擋回報
    useEffect(() => {
        if (!user) return undefined;
        let active = true;
        (async () => {
            try {
                const { data, error: optionsError } = await supabase
                    .from('salary_report_options')
                    .select('kind, value, label, sort_order, is_active')
                    .eq('is_active', true)
                    .order('sort_order', { ascending: true });
                if (active) setReportOptions(groupReportOptions(optionsError ? [] : data));
            } catch {
                if (active) setReportOptions(groupReportOptions([]));
            }
        })();
        return () => { active = false; };
    }, [user]);

    useEffect(() => {
        if (!instructor?.id || !form.course_type || !form.session_date) return undefined;
        let active = true;
        const timer = window.setTimeout(async () => {
            setQuoteLoading(true);
            setQuoteError('');
            try {
                const nextQuote = await getSalaryQuote({
                    instructorId: instructor.id,
                    courseType: form.course_type,
                    sessionDate: form.session_date,
                    roleInSession: form.role_in_session,
                    durationHours: form.duration_hours,
                    studentCount: form.student_count,
                });
                if (active) setQuote(nextQuote);
            } catch (err) {
                if (active) {
                    setQuote(null);
                    setQuoteError(salaryErrorMessage(err, '試算失敗，仍可送出交由管理員核薪。'));
                }
            } finally {
                if (active) setQuoteLoading(false);
            }
        }, 250);
        return () => { active = false; window.clearTimeout(timer); };
    }, [
        instructor?.id,
        form.course_type,
        form.session_date,
        form.role_in_session,
        form.duration_hours,
        form.student_count,
    ]);

    const submit = async (event) => {
        event?.preventDefault();
        setError('');
        if (!form.course_type) { setError('請選擇課程類型'); return; }
        if (!form.session_date) { setError('請填寫日期'); return; }
        if (form.session_date > TAIPEI_TODAY) { setError('請在課程結束後再回報，日期不能晚於今天。'); return; }
        if (form.duration_hours !== '' && (Number(form.duration_hours) <= 0 || Number(form.duration_hours) > 24)) {
            setError('時數必須大於 0 且不得超過 24 小時。'); return;
        }
        if (form.student_count !== '' && (Number(form.student_count) < 1 || Number(form.student_count) > 999)) {
            setError('人數必須介於 1 至 999 人。'); return;
        }
        if (PROGRESS_REQUIRED_COURSES.has(form.course_type) && !form.progress_note.trim()) {
            setError('常態課請填寫學習進度。'); return;
        }
        const extrasError = validateReportExtras(form.course_type, extras);
        if (extrasError) { setError(extrasError); return; }
        if (!instructor) { setError('找不到您的講師資料，請聯絡管理員。'); return; }

        setSubmitting(true);
        try {
            const { error: submitError } = await supabase.rpc('submit_my_class_session', {
                p_course_type: form.course_type,
                p_session_date: form.session_date,
                p_role_in_session: form.role_in_session,
                p_course_name: form.course_name.trim() || null,
                p_location: form.location.trim() || null,
                p_duration_hours: form.duration_hours ? Number(form.duration_hours) : null,
                p_student_count: form.student_count ? Number(form.student_count) : null,
                p_self_review: form.self_review.trim() || null,
                p_progress_note: form.progress_note.trim() || null,
                p_incident_report: form.incident_report.trim() || null,
                ...buildReportExtrasParams(form.course_type, extras),
            });
            if (submitError) throw submitError;
            navigate('/my/salary', { replace: true, state: { salaryReportSubmitted: true } });
        } catch (submitError) {
            setError(salaryErrorMessage(submitError, '回報送出失敗，請稍後再試。'));
        } finally {
            setSubmitting(false);
        }
    };

    const progressRequired = PROGRESS_REQUIRED_COURSES.has(form.course_type);
    const reportGroup = reportGroupFor(form.course_type);
    const updateExtras = (patch) => setExtras(current => ({ ...current, ...patch }));

    return (
        <div className="p-4 sm:p-8 max-w-3xl mx-auto">
            <Link to="/my/salary" className="relative inline-flex items-center gap-1 text-sm text-bauhaus-black/60 hover:text-bauhaus-blue mb-4 min-h-[44px]">
                <ArrowLeft className="w-4 h-4" /> 回我的報酬
            </Link>

            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">登記課程回報</h1>
                <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">
                    上完課後填寫這份回報，送出後管理員會審核並登記薪資。
                </p>
                {instructor && (
                    <div className="flex flex-wrap gap-2 mt-3 text-xs font-bold">
                        <span className="bh-chip bg-bauhaus-blue text-white">一般等級：{instructor.instructor_role || '未設定'}</span>
                        <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black">速解資格：{speedQualificationLabel(instructor.speed_qualification)}</span>
                    </div>
                )}
            </div>

            <div className="bg-bauhaus-yellow border-2 border-bauhaus-black rounded-2xl p-4 mb-6 flex gap-3">
                <AlertCircle className="w-5 h-5 text-bauhaus-black shrink-0 mt-0.5" />
                <div className="text-sm text-bauhaus-black">
                    <div className="font-bold">薪資金額不需要您填寫</div>
                    <div className="text-bauhaus-black/70 mt-0.5 text-xs">
                        系統會依課程類型選用一般等級或速解資格試算。若資格或報酬規則尚未齊全，
                        仍可送出，金額會顯示「待核薪」交由管理員處理，不會記成 0 元。同一堂課請只在站內或舊表單擇一回報。
                    </div>
                </div>
            </div>

            <form className="bh-card p-4 sm:p-6 space-y-5" onSubmit={submit} noValidate>
                {/* 課程基本資訊 */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="課程類型 *" icon={BookOpen}>
                        <select value={form.course_type} onChange={e => setForm({ ...form, course_type: e.target.value })}
                            className="bh-input">
                            {Object.entries(COURSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>

                    <Field label="日期 *" icon={Calendar}>
                        <input type="date" min={SALARY_VISIBLE_FROM} max={TAIPEI_TODAY} required value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="角色">
                        <select value={form.role_in_session} onChange={e => setForm({ ...form, role_in_session: e.target.value })}
                            className="bh-input">
                            {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>

                    <Field label="課程名稱">
                        <input type="text" maxLength={160} placeholder="例：OO 國小週二班" value={form.course_name}
                            onChange={e => setForm({ ...form, course_name: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="時數" icon={Clock}>
                        <input type="number" min="0.5" max="24" step="0.5" inputMode="decimal" placeholder="例：1.5" value={form.duration_hours}
                            onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="人數" icon={Users}>
                        <input type="number" min="1" max="999" step="1" inputMode="numeric" placeholder="例：6" value={form.student_count}
                            onChange={e => setForm({ ...form, student_count: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="地點" full>
                        <input type="text" maxLength={160} placeholder="選填" value={form.location}
                            onChange={e => setForm({ ...form, location: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <SalaryQuotePanel quote={quote} loading={quoteLoading} error={quoteError} />
                </div>

                {/* 對齊 Google 課後回報表單的條件欄位 */}
                {reportGroup === 'collab' && (
                    <section aria-label="合作單位課程資訊" className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <p className="sm:col-span-2 text-xs font-bold text-bauhaus-black/60">合作單位課程（B2B）回報資訊</p>
                        <Field label="教學課程期間 *" icon={Calendar}>
                            <select value={extras.term_period} onChange={e => updateExtras({ term_period: e.target.value })}
                                className="bh-input" aria-label="教學課程期間">
                                <option value="">請選擇寒假、學期間或暑假</option>
                                {termPeriodChoices(reportOptions).map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                            </select>
                        </Field>
                        <Field label="本次發出教材數量" icon={Package}>
                            <input type="text" maxLength={REPORT_TEXT_MAX} placeholder="例：楓葉10，無則打 0"
                                value={extras.materials_issued} onChange={e => updateExtras({ materials_issued: e.target.value })}
                                className="bh-input" aria-label="本次發出教材數量" />
                            <span className="block text-xs text-bauhaus-black/50 mt-1">填寫項目簡稱＋數字；沒有發教材請填 0。</span>
                        </Field>
                        <OptionPicker
                            label="本次上課單位名稱 *"
                            ariaLabel="本次上課單位"
                            icon={Building2}
                            options={reportOptions.partner_unit}
                            placeholder="請選擇合作單位"
                            otherPlaceholder="清單沒有時，請填寫單位全名與班別"
                            extras={extras}
                            onChange={updateExtras}
                        />
                    </section>
                )}

                {reportGroup === 'camp' && (
                    <section aria-label="營隊資訊" className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <p className="sm:col-span-2 text-xs font-bold text-bauhaus-black/60">寒暑假營隊回報資訊（人數請填您負責的學員數）</p>
                        <OptionPicker
                            label="營隊梯次 *"
                            ariaLabel="營隊梯次"
                            icon={Tent}
                            options={reportOptions.camp_batch}
                            placeholder="請選擇營隊梯次"
                            otherPlaceholder="清單沒有時，請填寫地區、日期與營隊名稱"
                            extras={extras}
                            onChange={updateExtras}
                        />
                    </section>
                )}

                {reportGroup !== 'collab' && (
                    <section aria-label="交通補助" className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <label className="sm:col-span-2 flex items-start gap-3 min-h-[44px] cursor-pointer rounded-xl border-2 border-bauhaus-black/20 px-3 py-2.5 hover:border-bauhaus-black">
                            <input type="checkbox" checked={extras.transport_requested}
                                onChange={e => updateExtras({ transport_requested: e.target.checked })}
                                className="mt-0.5 h-5 w-5 shrink-0 accent-bauhaus-blue" aria-label="申請交通補助" />
                            <span className="min-w-0">
                                <span className="flex items-center gap-1 text-sm font-bold text-bauhaus-black"><Car className="w-4 h-4" /> 需要申請交通補助</span>
                                <span className="block text-xs text-bauhaus-black/60 mt-0.5">到府或外出上課需要交通補助時勾選，並填寫單趟公里數。</span>
                            </span>
                        </label>
                        {extras.transport_requested && (
                            <Field label="單趟公里數 *" icon={Car}>
                                <input type="number" min="0.1" max={TRANSPORT_DISTANCE_MAX} step="0.1" inputMode="decimal"
                                    placeholder="例：12.5（只填單趟）" value={extras.transport_distance_km}
                                    onChange={e => updateExtras({ transport_distance_km: e.target.value })}
                                    className="bh-input" aria-label="單趟公里數" />
                            </Field>
                        )}
                    </section>
                )}

                <hr className="border-t-2 border-bauhaus-black/10" />

                {/* 講師回報 */}
                <Field label="課程自評" icon={MessageSquare}>
                    <textarea rows={3} maxLength={4000} placeholder="這場課的整體狀況、學生反應…" value={form.self_review}
                        onChange={e => setForm({ ...form, self_review: e.target.value })}
                        className="bh-input" />
                </Field>

                <Field label={`學習進度${progressRequired ? ' *' : '（非常態課選填）'}`}>
                    <textarea rows={2} maxLength={4000} required={progressRequired} placeholder="今天教到哪個段落、下一場預計教什麼…" value={form.progress_note}
                        onChange={e => setForm({ ...form, progress_note: e.target.value })}
                        className="bh-input" />
                </Field>

                <Field label="特殊狀況回報">
                    <textarea rows={2} maxLength={4000} placeholder="如有突發狀況、需要管理員注意的事（例：臨時換教室、學員缺席）" value={form.incident_report}
                        onChange={e => setForm({ ...form, incident_report: e.target.value })}
                        className="bh-input" />
                </Field>

                {error && <div role="alert" className="text-sm font-bold text-white bg-bauhaus-red border-2 border-bauhaus-black rounded-xl px-3 py-2">{error}</div>}

                <div className="flex justify-end gap-3 pt-2">
                    <Link to="/my/salary" className="bh-btn-ghost px-5 py-2.5">取消</Link>
                    <button type="submit" disabled={submitting || instructorLoading}
                        className="bh-btn bh-btn-blue px-5 py-2.5">
                        <Send className="w-4 h-4" />
                        {submitting ? '送出中…' : (instructorLoading ? '載入講師資料…' : '送出回報')}
                    </button>
                </div>
            </form>
        </div>
    );
};

// 清單選項＋「其它」自填；清單讀不到時直接改成自由輸入
const OptionPicker = ({ label, ariaLabel, icon, options, placeholder, otherPlaceholder, extras, onChange }) => {
    if (!options.length) {
        return (
            <Field label={label} icon={icon} full>
                <input type="text" maxLength={REPORT_TEXT_MAX} placeholder={otherPlaceholder}
                    value={extras.unit_choice === OTHER_OPTION ? extras.unit_other : ''}
                    onChange={e => onChange({ unit_choice: OTHER_OPTION, unit_other: e.target.value })}
                    className="bh-input" aria-label={ariaLabel} />
            </Field>
        );
    }
    const known = extras.unit_choice === OTHER_OPTION || options.some(option => option.value === extras.unit_choice);
    const selected = known ? extras.unit_choice : '';
    return (
        <Field label={label} icon={icon} full>
            <select value={selected} onChange={e => onChange({ unit_choice: e.target.value })}
                className="bh-input" aria-label={ariaLabel}>
                <option value="">{placeholder}</option>
                {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                <option value={OTHER_OPTION}>其它（清單沒有，自行填寫）</option>
            </select>
            {selected === OTHER_OPTION && (
                <input type="text" maxLength={REPORT_TEXT_MAX} placeholder={otherPlaceholder}
                    value={extras.unit_other} onChange={e => onChange({ unit_other: e.target.value })}
                    className="bh-input mt-2" aria-label={`${ariaLabel}（自行填寫）`} />
            )}
        </Field>
    );
};

const Field = ({ label, icon: Icon, children, full = false }) => (
    <label className={full ? 'sm:col-span-2 block' : 'block'}>
        <span className="bh-label flex items-center gap-1 mb-1.5">
            {Icon && <Icon className="w-3.5 h-3.5" />} {label}
        </span>
        {children}
    </label>
);

export default MySalaryNew;
