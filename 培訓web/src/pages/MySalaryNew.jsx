import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Calendar, BookOpen, Users, Clock, MessageSquare, AlertCircle, Send, ArrowLeft, Building2, Package, Car, Tent } from 'lucide-react';
import {
    REPORT_CHANNELS,
    ROLE_LABELS,
    categoriesInChannel,
    courseCategoryConfig,
    courseCategoryFor,
    reportChannelFor,
    reportItemLabel,
    speedQualificationLabel,
    teacherCourseItems,
} from '../lib/constants';
import { getSalaryQuote, salaryErrorMessage, taipeiToday } from '../lib/salary';
import SalaryQuotePanel from '../components/SalaryQuotePanel';
import {
    EMPTY_REPORT_EXTRAS,
    HOURS_PRESETS,
    INCIDENT_LABELS,
    OTHER_OPTION,
    REPORT_TEXT_MAX,
    TRANSPORT_DISTANCE_MAX,
    TRANSPORT_SUBSIDY_NOTE,
    buildReportBasicParams,
    buildReportExtrasParams,
    deriveCourseType,
    groupReportOptions,
    periodByValue,
    reportGroupFor,
    reportLayoutFor,
    roleForCourseType,
    termPeriodChoices,
    unitChoicesFor,
    validateReportBasics,
    validateReportExtras,
} from '../lib/salaryReportForm';
import {
    CUSTOM_ANSWER_MAX,
    buildExtraFieldsParam,
    validateCustomAnswers,
    visibleFieldsOfLayout,
} from '../lib/salaryReportFields';

const PROGRESS_REQUIRED_COURSES = new Set(['regular_basic', 'regular_advanced']);
// 講師端可見範圍門檻（與 migration 20261018150000 的 instructor_salary_visible_from() 一致）
const SALARY_VISIBLE_FROM = '2026-01-01';
// 預設落在 B2C 表單的第一個課程種類（到府家教課）
const DEFAULT_COURSE_TYPE = 'onsite_2hr';

const MySalaryNew = () => {
    const { user } = useAuth();
    const navigate = useNavigate();
    const [instructor, setInstructor] = useState(null);
    const [form, setForm] = useState({
        course_type: DEFAULT_COURSE_TYPE,
        course_name: '',
        session_date: taipeiToday(),
        role_in_session: roleForCourseType(DEFAULT_COURSE_TYPE),
        duration_hours: '',
        student_count: '',
        location: '',
        self_review: '',
        progress_note: '',
        incident_report: '',
    });
    const [hoursOther, setHoursOther] = useState(false);
    const [extras, setExtras] = useState(EMPTY_REPORT_EXTRAS);
    const [reportOptions, setReportOptions] = useState(() => groupReportOptions([]));
    // 後台「回報表單欄位」設定；讀不到時用預設欄位（null／[] 都會退回預設）
    const [fieldRows, setFieldRows] = useState(null);
    const [customAnswers, setCustomAnswers] = useState({});
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
                    .select('id, kind, value, label, sort_order, is_active, period_id')
                    .eq('is_active', true)
                    .order('sort_order', { ascending: true });
                if (active) setReportOptions(groupReportOptions(optionsError ? [] : data));
            } catch {
                if (active) setReportOptions(groupReportOptions([]));
            }
        })();
        return () => { active = false; };
    }, [user]);

    // 回報表單欄位設定（顯示哪些欄位、順序、自訂欄位）；讀取失敗就用預設欄位，不擋回報
    const fetchFieldRows = useCallback(async () => {
        try {
            const { data, error: fieldsError } = await supabase
                .from('salary_report_fields')
                .select('layout, field_key, source, label, field_type, options, help_text, is_required, is_visible, sort_order')
                .order('sort_order', { ascending: true });
            return fieldsError ? [] : (data || []);
        } catch {
            return [];
        }
    }, []);

    useEffect(() => {
        if (!user) return undefined;
        let active = true;
        fetchFieldRows().then(rows => { if (active) setFieldRows(rows); });
        return () => { active = false; };
    }, [user, fetchFieldRows]);

    const layout = reportLayoutFor(form.course_type);
    const layoutFields = useMemo(() => visibleFieldsOfLayout(fieldRows, layout), [fieldRows, layout]);

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
                    setQuoteError(salaryErrorMessage(err, '試算失敗，仍可送出交由管理員核准。'));
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

    // 講師改任何欄位就清掉上一次送出的錯誤訊息（避免修正後紅字還掛著）
    useEffect(() => { setError(''); }, [form, extras, customAnswers]);

    // 到府課不問報酬項目：依時數自動落到 1.5hr／2hr 規則
    useEffect(() => {
        const derived = deriveCourseType(form.course_type, form.duration_hours);
        if (derived !== form.course_type) {
            setForm(current => ({ ...current, course_type: derived, role_in_session: roleForCourseType(derived) }));
        }
    }, [form.course_type, form.duration_hours]);

    // 換報酬項目時角色跟著推定（表單沒有角色欄位；「其他課程」版仍可手動改）
    // 換到另一種回報（合作課／營隊／直營）時清掉已選的單位或梯次，避免殘留到別的清單
    const setCourseType = (courseType) => {
        if (!courseType) return;
        if (reportGroupFor(courseType) !== reportGroupFor(form.course_type)) {
            setExtras(current => ({ ...current, unit_choice: '', unit_other: '' }));
        }
        setForm(current => ({ ...current, course_type: courseType, role_in_session: roleForCourseType(courseType) }));
    };

    const submit = async (event) => {
        event?.preventDefault();
        setError('');
        if (!form.course_type) { setError('請選擇課程類型'); return; }
        if (!form.session_date) { setError('請填寫日期'); return; }
        // 每次送出時重算「今天」：分頁開過午夜仍能回報當天的課
        if (form.session_date > taipeiToday()) { setError('請在課程結束後再回報，日期不能晚於今天。'); return; }
        const basicsError = validateReportBasics(form.course_type, form, layoutFields);
        if (basicsError) { setError(basicsError); return; }
        if (form.duration_hours !== '' && (Number(form.duration_hours) <= 0 || Number(form.duration_hours) > 24)) {
            setError('時數必須大於 0 且不得超過 24 小時。'); return;
        }
        if (form.student_count !== '' && (Number(form.student_count) < 1 || Number(form.student_count) > 999)) {
            setError('人數必須介於 1 至 999 人。'); return;
        }
        if (PROGRESS_REQUIRED_COURSES.has(form.course_type) && !form.progress_note.trim()) {
            setError('常態課請填寫學習進度。'); return;
        }
        const extrasContext = { fields: layoutFields, options: reportOptions };
        const extrasError = validateReportExtras(form.course_type, extras, extrasContext);
        if (extrasError) { setError(extrasError); return; }
        const customError = validateCustomAnswers(layoutFields, customAnswers);
        if (customError) { setError(customError); return; }
        if (!instructor) { setError('找不到您的講師資料，請聯絡管理員。'); return; }

        setSubmitting(true);
        try {
            // 沒有自訂欄位時不帶 p_extra_fields，資料庫更新前的舊版函式也收得到
            const extraFields = buildExtraFieldsParam(layoutFields, customAnswers);
            const { error: submitError } = await supabase.rpc('submit_my_class_session', {
                p_course_type: form.course_type,
                p_session_date: form.session_date,
                ...buildReportBasicParams(form.course_type, form, layoutFields),
                ...buildReportExtrasParams(form.course_type, extras, extrasContext),
                ...(extraFields ? { p_extra_fields: extraFields } : {}),
            });
            if (submitError) throw submitError;
            navigate('/my/salary', { replace: true, state: { salaryReportSubmitted: true } });
        } catch (submitError) {
            // 填寫途中管理員改了表單欄位：直接重新載入欄位設定，已填的內容保留，講師確認後再送一次
            if (String(submitError?.message || '').includes('欄位已更新')) {
                setFieldRows(await fetchFieldRows());
                setError('管理員剛更新了回報表單的欄位，已重新載入；已填的內容都還在，請確認後再按一次送出。');
                return;
            }
            setError(salaryErrorMessage(submitError, '回報送出失敗，請稍後再試。'));
        } finally {
            setSubmitting(false);
        }
    };

    const progressRequired = PROGRESS_REQUIRED_COURSES.has(form.course_type);
    const courseCategory = courseCategoryFor(form.course_type);
    const categoryConfig = courseCategoryConfig(courseCategory);
    const reportChannel = reportChannelFor(form.course_type);
    const channelCategories = categoriesInChannel(reportChannel);
    const courseItems = courseCategory === 'onsite' ? [] : teacherCourseItems(courseCategory);
    const unitChoices = unitChoicesFor(form.course_type, reportOptions, extras.term_period);
    const selectedPeriod = periodByValue(reportOptions, extras.term_period);
    const itemLabel = categoryConfig?.itemLabel || '報酬項目';
    const hoursChoice = hoursOther
        ? OTHER_OPTION
        : (HOURS_PRESETS.includes(String(form.duration_hours)) ? String(form.duration_hours) : (form.duration_hours === '' ? '' : OTHER_OPTION));
    const studentLabel = { b2b: '本次上課人數 *', b2c_direct: '實際上課人數 *', b2c_camp: '上課人數 *', other: '人數' }[layout];
    const updateExtras = (patch) => setExtras(current => ({ ...current, ...patch }));
    const pickTermPeriod = (termPeriod) => setExtras(current => ({ ...current, term_period: termPeriod, unit_choice: '', unit_other: '' }));
    const setCustomAnswer = (fieldKey, value) => setCustomAnswers(current => ({ ...current, [fieldKey]: value }));

    // 依後台設定的順序逐一畫出欄位（回報類別、日期、課程種類、報酬項目固定在最上面，不在設定裡）
    const renderField = (field) => {
        const required = field.is_required;
        switch (field.field_key) {
        case 'term_period':
            return (
                <Field key="term_period" label="請點選目前教學課程期間 *" icon={Calendar}>
                    <select value={extras.term_period} onChange={e => pickTermPeriod(e.target.value)}
                        className="bh-input" aria-label="教學課程期間">
                        <option value="">請選擇教學課程期間</option>
                        {termPeriodChoices(reportOptions).map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                    </select>
                </Field>
            );
        case 'unit':
            return extras.term_period ? (
                <OptionPicker
                    key="unit"
                    label="本次上課單位名稱 *"
                    ariaLabel="本次上課單位"
                    icon={Building2}
                    options={unitChoices}
                    placeholder="請選擇合作單位"
                    otherPlaceholder="清單沒有時，請填寫單位全名與班別"
                    hint={selectedPeriod && unitChoices.length ? `列出「${selectedPeriod.label}」的合作單位。` : ''}
                    extras={extras}
                    onChange={updateExtras}
                />
            ) : (
                <Field key="unit" label="本次上課單位名稱 *" icon={Building2} full>
                    <select value="" disabled className="bh-input opacity-60" aria-label="本次上課單位">
                        <option value="">請先選擇教學課程期間，再選單位</option>
                    </select>
                </Field>
            );
        case 'camp_batch':
            return (
                <OptionPicker
                    key="camp_batch"
                    label="營隊梯次 *"
                    ariaLabel="營隊梯次"
                    icon={Tent}
                    options={unitChoices}
                    placeholder="請選擇營隊梯次"
                    otherPlaceholder="清單沒有時，請填寫地區、日期與營隊名稱"
                    extras={extras}
                    onChange={updateExtras}
                />
            );
        case 'role':
            return (
                <Field key="role" label="角色">
                    <select value={form.role_in_session} onChange={e => setForm({ ...form, role_in_session: e.target.value })}
                        className="bh-input" aria-label="角色">
                        {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                </Field>
            );
        case 'course_name':
            return (
                <Field key="course_name" label={`課程名稱${required ? ' *' : ''}`}>
                    <input type="text" maxLength={160}
                        placeholder={layout === 'b2c_direct' ? '請打上學生代表姓名 or 課程地點' : '例：OO 國小週二班'}
                        value={form.course_name}
                        onChange={e => setForm({ ...form, course_name: e.target.value })}
                        className="bh-input" aria-label="課程名稱" />
                    {layout === 'b2c_direct' && <span className="block text-xs text-bauhaus-black/50 mt-1">方便登記並辨識課程。</span>}
                </Field>
            );
        case 'hours':
            if (layout === 'b2c_direct') {
                return (
                    <Field key="hours" label="上課時數 (小時) *" icon={Clock}>
                        <select value={hoursChoice} onChange={e => pickHours(e.target.value)} className="bh-input" aria-label="上課時數">
                            <option value="">請選擇</option>
                            {HOURS_PRESETS.map(hours => <option key={hours} value={hours}>{hours}</option>)}
                            <option value={OTHER_OPTION}>其他（自行填寫）</option>
                        </select>
                        {hoursChoice === OTHER_OPTION && (
                            <input type="number" min="0.5" max="24" step="0.5" inputMode="decimal" placeholder="如 90 分鐘則為 1.5"
                                value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                                className="bh-input mt-2" aria-label="上課時數（自行填寫）" />
                        )}
                        <span className="block text-xs text-bauhaus-black/50 mt-1">如 90 分鐘則為 1.5；請據實填寫。</span>
                    </Field>
                );
            }
            return (
                <Field key="hours" label={layout === 'b2b' ? '上課時數 (單位 HR) *' : '時數'} icon={Clock}>
                    <input type="number" min="0.5" max="24" step="0.5" inputMode="decimal" placeholder="例：1.5" value={form.duration_hours}
                        onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                        className="bh-input" aria-label="上課時數" />
                    {layout === 'b2b' && <span className="block text-xs text-bauhaus-black/50 mt-1">填寫數字即可；低於 1 小時或有零頭請換算成小數。</span>}
                </Field>
            );
        case 'students':
            return (
                <Field key="students" label={studentLabel} icon={Users}>
                    <input type="number" min="1" max="999" step="1" inputMode="numeric" placeholder={layout === 'b2b' ? '例：20' : '例：6'} value={form.student_count}
                        onChange={e => setForm({ ...form, student_count: e.target.value })}
                        className="bh-input" aria-label="上課人數" />
                    {layout === 'b2c_camp' && <span className="block text-xs text-bauhaus-black/50 mt-1">帶營隊時負責的學員數量。</span>}
                </Field>
            );
        case 'materials':
            return (
                <Field key="materials" label={`本次發出教材數量${required ? ' *' : '（選填）'}`} icon={Package}>
                    <input type="text" maxLength={REPORT_TEXT_MAX} placeholder="例：楓葉10，無則打 0"
                        value={extras.materials_issued} onChange={e => updateExtras({ materials_issued: e.target.value })}
                        className="bh-input" aria-label="本次發出教材數量" />
                    <span className="block text-xs text-bauhaus-black/50 mt-1">填寫項目簡稱＋數字；沒有發教材請填 0。</span>
                </Field>
            );
        case 'location':
            return (
                <Field key="location" label={`地點${required ? ' *' : ''}`} full>
                    <input type="text" maxLength={160} placeholder={required ? '例：台北市大安區 OO 教室' : '選填'} value={form.location}
                        onChange={e => setForm({ ...form, location: e.target.value })}
                        className="bh-input" aria-label="地點" />
                </Field>
            );
        case 'transport':
            return (
                <section key="transport" aria-label="交通補助" className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <label className="sm:col-span-2 flex items-start gap-3 min-h-[44px] cursor-pointer rounded-xl border-2 border-bauhaus-black/20 px-3 py-2.5 hover:border-bauhaus-black">
                        <input type="checkbox" checked={extras.transport_requested}
                            onChange={e => updateExtras({ transport_requested: e.target.checked })}
                            className="mt-0.5 h-5 w-5 shrink-0 accent-bauhaus-blue" aria-label="申請交通補助" />
                        <span className="min-w-0">
                            <span className="flex items-center gap-1 text-sm font-bold text-bauhaus-black"><Car className="w-4 h-4" /> 是否需要申請交通補助？</span>
                            <span className="block text-xs text-bauhaus-black/60 mt-0.5">需要時勾選並填寫【單趟】公里數；不需要就不用勾。</span>
                            <span className="block text-xs font-bold text-bauhaus-red mt-1">{TRANSPORT_SUBSIDY_NOTE}</span>
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
            );
        case 'self_review':
            return (
                <Field key="self_review" label={`課程自評${required ? ' *' : ''}`} icon={MessageSquare} full>
                    <textarea rows={3} maxLength={4000} placeholder="這場課的整體狀況、學生反應…" value={form.self_review}
                        onChange={e => setForm({ ...form, self_review: e.target.value })}
                        className="bh-input" aria-label="課程自評" />
                </Field>
            );
        case 'progress':
            return (
                <Field key="progress" label={`學習進度${progressRequired ? ' *' : '（非常態課選填）'}`} full>
                    <textarea rows={2} maxLength={4000} required={progressRequired} placeholder="今天教到哪個段落、下一場預計教什麼…" value={form.progress_note}
                        onChange={e => setForm({ ...form, progress_note: e.target.value })}
                        className="bh-input" aria-label="學習進度" />
                </Field>
            );
        case 'incident':
            return (
                <Field key="incident" label={required ? INCIDENT_LABELS[layout].replace('（選填）', ' *') : INCIDENT_LABELS[layout]} icon={MessageSquare} full>
                    <textarea rows={2} maxLength={4000}
                        placeholder={layout === 'other' ? '如有突發狀況、需要管理員注意的事（例：臨時換教室、學員缺席）' : '若沒有可以不用填，有建議也歡迎填寫'}
                        value={form.incident_report}
                        onChange={e => setForm({ ...form, incident_report: e.target.value })}
                        className="bh-input" aria-label="特殊狀況回報" />
                </Field>
            );
        default:
            if (field.source !== 'custom') return null;
            return (
                <CustomField key={field.field_key} field={field} value={customAnswers[field.field_key]}
                    onChange={value => setCustomAnswer(field.field_key, value)} />
            );
        }
    };

    const pickHours = (value) => {
        if (value === OTHER_OPTION) {
            setHoursOther(true);
            setForm(current => ({ ...current, duration_hours: '' }));
            return;
        }
        setHoursOther(false);
        setForm(current => ({ ...current, duration_hours: value }));
    };

    return (
        <div className="p-4 sm:p-8 max-w-3xl mx-auto">
            <Link to="/my/salary" className="relative inline-flex items-center gap-1 text-sm text-bauhaus-black/60 hover:text-bauhaus-blue mb-4 min-h-[44px]">
                <ArrowLeft className="w-4 h-4" /> 回我的報酬
            </Link>

            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">登記課程回報</h1>
                <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">
                    上完課後填寫這份回報，送出後管理員會審核並登記報酬。
                </p>
                {instructor && (
                    <div className="flex flex-wrap gap-2 mt-3 text-xs font-bold">
                        {instructor.full_name && <span className="bh-chip bg-bauhaus-black text-white">回報人：{instructor.full_name}</span>}
                        <span className="bh-chip bg-bauhaus-blue text-white">講師級別：{instructor.instructor_role || '未設定'}</span>
                        <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black">速解資格：{speedQualificationLabel(instructor.speed_qualification)}</span>
                    </div>
                )}
            </div>

            <div className="bg-bauhaus-yellow border-2 border-bauhaus-black rounded-2xl p-4 mb-6 flex gap-3">
                <AlertCircle className="w-5 h-5 text-bauhaus-black shrink-0 mt-0.5" />
                <div className="text-sm text-bauhaus-black">
                    <div className="font-bold">報酬金額、姓名與級別不需要您填寫</div>
                    <div className="text-bauhaus-black/70 mt-0.5 text-xs">
                        系統會依課程類型選用一般等級或速解資格試算。若資格或報酬規則尚未齊全，
                        仍可送出，金額會顯示「待核准」交由管理員處理，不會記成 0 元。同一堂課請只在站內或舊表單擇一回報。
                    </div>
                </div>
            </div>

            <form className="bh-card p-4 sm:p-6 space-y-5" onSubmit={submit} noValidate>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="回報類別 *" icon={BookOpen} full>
                        <select value={reportChannel} aria-label="回報類別"
                            onChange={e => setCourseType(categoriesInChannel(e.target.value)[0]?.types[0])}
                            className="bh-input">
                            {REPORT_CHANNELS.map(channel => <option key={channel.key} value={channel.key}>{channel.label}</option>)}
                        </select>
                        <ul className="mt-2 space-y-0.5 text-xs text-bauhaus-black/60 font-medium">
                            {REPORT_CHANNELS.map(channel => (
                                <li key={channel.key}><span className="font-bold text-bauhaus-black/80">{channel.label}</span>：{channel.hint}</li>
                            ))}
                        </ul>
                    </Field>

                    <Field label="上課日期 *" icon={Calendar}>
                        <input type="date" min={SALARY_VISIBLE_FROM} max={taipeiToday()} required value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })}
                            className="bh-input" aria-label="上課日期" />
                        {layout === 'b2b' && <span className="block text-xs text-bauhaus-black/50 mt-1">當日課程日期，不是填寫日期。</span>}
                    </Field>

                    {channelCategories.length > 1 && (
                        <Field label={layout === 'other' ? '課程類型 *' : '課程種類 *'}>
                            <select value={courseCategory} aria-label="課程種類"
                                onChange={e => setCourseType(teacherCourseItems(e.target.value)[0])}
                                className="bh-input">
                                {channelCategories.map(category => <option key={category.key} value={category.key}>{category.label}</option>)}
                            </select>
                        </Field>
                    )}

                    {courseItems.length > 1 && (
                        <Field label={`${itemLabel} *`}>
                            <select value={form.course_type} aria-label={itemLabel}
                                onChange={e => setCourseType(e.target.value)}
                                className="bh-input">
                                {courseItems.map(k => <option key={k} value={k}>{reportItemLabel(k)}</option>)}
                            </select>
                        </Field>
                    )}

                    {layoutFields.map(renderField)}

                    <hr className="sm:col-span-2 border-t-2 border-bauhaus-black/10" />
                    <SalaryQuotePanel quote={quote} loading={quoteLoading} error={quoteError} />
                </div>

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

// 清單選項＋「其它」自填；清單讀不到時直接改成自由輸入。
// 選項的 key 是列 id（不同期間可能同名）；跨多個期間時依期間分組顯示
const OptionPicker = ({ label, ariaLabel, icon, options, placeholder, otherPlaceholder, extras, onChange, hint = '' }) => {
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
    const known = extras.unit_choice === OTHER_OPTION || options.some(option => option.key === extras.unit_choice);
    const selected = known ? extras.unit_choice : '';
    const groups = [...new Set(options.map(option => option.period_label || ''))];
    const renderOption = option => <option key={option.key} value={option.key}>{option.label}</option>;
    return (
        <Field label={label} icon={icon} full>
            <select value={selected} onChange={e => onChange({ unit_choice: e.target.value })}
                className="bh-input" aria-label={ariaLabel}>
                <option value="">{placeholder}</option>
                {groups.length > 1
                    ? groups.map(group => (
                        <optgroup key={group || 'none'} label={group || '其他'}>
                            {options.filter(option => (option.period_label || '') === group).map(renderOption)}
                        </optgroup>
                    ))
                    : options.map(renderOption)}
                <option value={OTHER_OPTION}>其它（清單沒有，自行填寫）</option>
            </select>
            {selected === OTHER_OPTION && (
                <input type="text" maxLength={REPORT_TEXT_MAX} placeholder={otherPlaceholder}
                    value={extras.unit_other} onChange={e => onChange({ unit_other: e.target.value })}
                    className="bh-input mt-2" aria-label={`${ariaLabel}（自行填寫）`} />
            )}
            {hint && <span className="block text-xs text-bauhaus-black/50 mt-1">{hint}</span>}
        </Field>
    );
};

// 管理員在後台新增的自訂欄位
const CustomField = ({ field, value, onChange }) => {
    const label = `${field.label}${field.is_required ? ' *' : ''}`;
    const help = field.help_text ? <span className="block text-xs text-bauhaus-black/50 mt-1">{field.help_text}</span> : null;
    if (field.field_type === 'boolean') {
        return (
            <label className="sm:col-span-2 flex items-start gap-3 min-h-[44px] cursor-pointer rounded-xl border-2 border-bauhaus-black/20 px-3 py-2.5 hover:border-bauhaus-black">
                <input type="checkbox" checked={Boolean(value)} onChange={e => onChange(e.target.checked)}
                    className="mt-0.5 h-5 w-5 shrink-0 accent-bauhaus-blue" aria-label={field.label} />
                <span className="min-w-0">
                    <span className="block text-sm font-bold text-bauhaus-black">{field.label}</span>
                    {field.help_text && <span className="block text-xs text-bauhaus-black/60 mt-0.5">{field.help_text}</span>}
                </span>
            </label>
        );
    }
    if (field.field_type === 'textarea') {
        return (
            <Field label={label} full>
                <textarea rows={3} maxLength={CUSTOM_ANSWER_MAX} value={value ?? ''} onChange={e => onChange(e.target.value)}
                    className="bh-input" aria-label={field.label} />
                {help}
            </Field>
        );
    }
    if (field.field_type === 'select') {
        return (
            <Field label={label}>
                <select value={value ?? ''} onChange={e => onChange(e.target.value)} className="bh-input" aria-label={field.label}>
                    <option value="">請選擇</option>
                    {field.options.map(option => <option key={option} value={option}>{option}</option>)}
                </select>
                {help}
            </Field>
        );
    }
    return (
        <Field label={label}>
            <input type={field.field_type === 'number' ? 'number' : 'text'}
                inputMode={field.field_type === 'number' ? 'decimal' : undefined}
                step={field.field_type === 'number' ? 'any' : undefined}
                maxLength={field.field_type === 'number' ? undefined : CUSTOM_ANSWER_MAX}
                value={value ?? ''} onChange={e => onChange(e.target.value)}
                className="bh-input" aria-label={field.label} />
            {help}
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
