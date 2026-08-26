import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import { Search, Plus, AlertTriangle, X, CheckCircle2, Clock, Wallet, Edit3, MessageSquare, RefreshCw } from 'lucide-react';
import { COURSE_LABELS, ROLE_LABELS, speedQualificationLabel } from '../../lib/constants';
import { getSalaryQuote, money, salaryErrorMessage, taipeiToday } from '../../lib/salary';
import SalaryQuotePanel from '../../components/SalaryQuotePanel';

const STATUS_STYLES = {
    pending:  { label: '待核准',   color: 'bg-bauhaus-yellow text-bauhaus-black', icon: Clock },
    approved: { label: '已核准',   color: 'bg-bauhaus-blue text-white', icon: CheckCircle2 },
    paid:     { label: '已付款',   color: 'bg-bauhaus-black text-white', icon: Wallet },
};

const TAIPEI_TODAY = taipeiToday();

const useDialogDismiss = (onClose) => {
    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        const handleKeyDown = (event) => {
            if (event.key === 'Escape') onClose();
        };
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [onClose]);
};

const SalaryRegister = () => {
    const { profile } = useAuth();
    const [sessions, setSessions] = useState([]);
    const [instructors, setInstructors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [search, setSearch] = useState('');
    const [monthFilter, setMonthFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [anomalyOnly, setAnomalyOnly] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [editing, setEditing] = useState(null);  // session being edited

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        const [s, i] = await Promise.all([
            supabase.from('class_sessions').select('*').order('session_date', { ascending: false }).limit(500),
            supabase.from('instructors').select('id, full_name, instructor_role, speed_qualification').order('full_name'),
        ]);
        if (s.error || i.error) {
            setLoadError(salaryErrorMessage(s.error || i.error, '薪資資料載入失敗，請稍後再試。'));
        } else {
            setSessions(s.data || []);
            setInstructors(i.data || []);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(load, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    const filtered = useMemo(() => {
        return sessions.filter(s => {
            if (monthFilter && s.month_label !== monthFilter) return false;
            if (statusFilter && s.status !== statusFilter) return false;
            if (anomalyOnly && !s.is_anomaly) return false;
            if (search) {
                const q = search.toLowerCase();
                return s.instructor_name?.toLowerCase().includes(q)
                    || s.course_name?.toLowerCase().includes(q)
                    || s.course_type?.toLowerCase().includes(q);
            }
            return true;
        }).sort((a, b) => {
            const aPriority = a.status === 'pending' ? 0 : a.status === 'approved' ? 1 : 2;
            const bPriority = b.status === 'pending' ? 0 : b.status === 'approved' ? 1 : 2;
            return aPriority - bPriority || String(b.session_date).localeCompare(String(a.session_date));
        });
    }, [sessions, monthFilter, statusFilter, anomalyOnly, search]);

    const months = useMemo(() => [...new Set(sessions.map(s => s.month_label).filter(Boolean))].sort().reverse(), [sessions]);
    const anomalyCount = sessions.filter(s => s.is_anomaly).length;
    const pendingCount = sessions.filter(s => s.status === 'pending').length;
    const needsPricingCount = sessions.filter(s => s.pricing_status === 'needs_review').length;

    const stats = useMemo(() => {
        const total = filtered.reduce((sum, s) => sum + Number(s.total_salary || 0), 0);
        const paid = filtered.reduce((sum, s) => sum + Number(s.paid_amount || 0), 0);
        return { total, paid, unpaid: total - paid, count: filtered.length };
    }, [filtered]);

    return (
        <div className="p-4 sm:p-8">
            <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">薪資登記中心</h1>
                    <p className="text-bauhaus-black/60 font-medium mt-1 text-sm">
                        先處理講師回報，確認報酬規則後再核准與付款。共 {sessions.length} 筆紀錄。
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => setShowAdd(true)}
                    disabled={loading || Boolean(loadError)}
                    className="bh-btn bh-btn-blue px-4 py-2.5"
                >
                    <Plus className="w-4 h-4" /> 新增薪資紀錄
                </button>
            </div>

            {(pendingCount > 0 || anomalyCount > 0) && (
                <div className="flex flex-wrap gap-2 mb-6" aria-label="快速篩選">
                    {pendingCount > 0 && (
                        <button type="button" onClick={() => setStatusFilter(statusFilter === 'pending' ? '' : 'pending')}
                            aria-pressed={statusFilter === 'pending'}
                            className={`bh-btn px-4 py-2.5 ${statusFilter === 'pending' ? 'bg-bauhaus-yellow text-bauhaus-black' : 'bh-btn-outline'}`}>
                            <Clock className="w-4 h-4" />待處理 {pendingCount}
                            {needsPricingCount > 0 && <span className="text-xs">（待核薪 {needsPricingCount}）</span>}
                        </button>
                    )}
                    {anomalyCount > 0 && (
                        <button type="button" onClick={() => setAnomalyOnly(!anomalyOnly)} aria-pressed={anomalyOnly}
                            className={`bh-btn px-4 py-2.5 ${anomalyOnly ? 'bg-bauhaus-red text-white' : 'bh-btn-outline'}`}>
                            <AlertTriangle className="w-4 h-4" />異常 {anomalyCount}
                        </button>
                    )}
                </div>
            )}

            {/* 統計卡 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
                <StatCard label="篩選筆數" value={stats.count.toLocaleString()} idx={0} />
                <StatCard label="總薪資" value={`$${Math.round(stats.total).toLocaleString()}`} color="text-bauhaus-blue" idx={1} />
                <StatCard label="已付款" value={`$${Math.round(stats.paid).toLocaleString()}`} color="text-bauhaus-blue" idx={2} />
                <StatCard label="未付款" value={`$${Math.round(stats.unpaid).toLocaleString()}`} color="text-bauhaus-red" idx={0} />
            </div>

            {/* 篩選列 */}
            <div className="flex flex-wrap gap-2 mb-4 items-center">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bauhaus-black/40" />
                    <input
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="搜尋姓名、課程名稱..."
                        className="bh-input w-full pl-9 pr-3 py-2 text-sm"
                    />
                </div>
                <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)}
                    className="bh-input text-sm px-3 py-2 w-auto">
                    <option value="">全部月份</option>
                    {months.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                    className="bh-input text-sm px-3 py-2 w-auto">
                    <option value="">全部狀態</option>
                    <option value="pending">待核准</option>
                    <option value="approved">已核准</option>
                    <option value="paid">已付款</option>
                </select>
                <label className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-xl border-2 border-bauhaus-black cursor-pointer hover:bg-bauhaus-cream">
                    <input type="checkbox" checked={anomalyOnly} onChange={e => setAnomalyOnly(e.target.checked)} className="w-5 h-5 accent-bauhaus-red" />
                    僅看異常
                </label>
            </div>

            {/* 表格 */}
            {loading ? (
                <div className="p-12 text-center text-bauhaus-black/60 font-bold">載入中...</div>
            ) : loadError ? (
                <div role="alert" className="bh-card bg-bauhaus-red text-white p-5">
                    <div className="font-black">{loadError}</div>
                    <button type="button" onClick={load} className="bh-btn bg-white text-bauhaus-black px-4 py-2.5 mt-4">
                        <RefreshCw className="w-4 h-4" />重新載入
                    </button>
                </div>
            ) : (
                <div className="bh-card overflow-hidden">
                    <div className="md:hidden divide-y-2 divide-bauhaus-black/20">
                        {filtered.slice(0, 200).map(s => <SalaryCard key={s.id} session={s} onEdit={() => setEditing(s)} />)}
                        {filtered.length === 0 && <div className="px-4 py-12 text-center text-bauhaus-black/50">沒有符合的紀錄</div>}
                    </div>
                    <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-bauhaus-black text-white text-xs uppercase tracking-wider">
                                <tr>
                                    <th className="px-4 py-3 text-left">日期</th>
                                    <th className="px-4 py-3 text-left">講師</th>
                                    <th className="px-4 py-3 text-left">課程</th>
                                    <th className="px-4 py-3 text-right">時數/人</th>
                                    <th className="px-4 py-3 text-right">薪資</th>
                                    <th className="px-4 py-3 text-right">獎金</th>
                                    <th className="px-4 py-3 text-right">總計</th>
                                    <th className="px-4 py-3 text-left">狀態</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y-2 divide-bauhaus-black/20">
                                {filtered.slice(0, 200).map(s => <SalaryRow key={s.id} session={s} onEdit={() => setEditing(s)} />)}
                                {filtered.length === 0 && (
                                    <tr><td colSpan={8} className="px-4 py-12 text-center text-bauhaus-black/50">沒有符合的紀錄</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    {filtered.length > 200 && (
                        <div className="px-4 py-3 text-xs text-bauhaus-black/50 text-center bg-bauhaus-cream border-t-2 border-bauhaus-black">
                            僅顯示前 200 筆,請使用篩選縮小範圍
                        </div>
                    )}
                </div>
            )}

            {showAdd && (
                <AddSalaryModal instructors={instructors} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} profile={profile} />
            )}

            {editing && (
                <EditSalaryModal session={editing} instructors={instructors} profile={profile} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
            )}
        </div>
    );
};


const STAT_DECO_SHAPES = ['bg-bauhaus-red', 'bg-bauhaus-blue rounded-full', 'bg-bauhaus-yellow'];
const STAT_DECO_STYLE = { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' };

const StatCard = ({ label, value, color = 'text-bauhaus-black', idx = 0 }) => (
    <div className="bh-card relative p-4">
        <span
            className={`absolute -top-2 -right-2 w-4 h-4 ${STAT_DECO_SHAPES[idx % 3]}`}
            style={idx % 3 === 2 ? STAT_DECO_STYLE : undefined}
            aria-hidden="true"
        />
        <div className="bh-label text-bauhaus-black/60">{label}</div>
        <div className={`text-2xl sm:text-4xl font-black tabular-nums mt-1 ${color}`}>{value}</div>
    </div>
);

const recordState = (session) => {
    if (session.pricing_status === 'rejected') {
        return { label: '已退回', color: 'bg-bauhaus-red text-white', icon: AlertTriangle, unpriced: true };
    }
    if (session.pricing_status === 'needs_review') {
        return { label: '待核薪', color: 'bg-bauhaus-yellow text-bauhaus-black', icon: Clock, unpriced: true };
    }
    const status = STATUS_STYLES[session.status] || STATUS_STYLES.approved;
    return { ...status, unpriced: false };
};

const SalaryCard = ({ session, onEdit }) => {
    const state = recordState(session);
    const StateIcon = state.icon;
    return (
        <button type="button" onClick={onEdit} className="w-full text-left p-4 hover:bg-bauhaus-cream focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-bauhaus-blue/40">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="font-black text-bauhaus-black">{session.instructor_name}</div>
                    <div className="text-sm text-bauhaus-black/70 mt-1">{COURSE_LABELS[session.course_type] || session.course_type}</div>
                    <div className="text-xs text-bauhaus-black/50 mt-1">{session.session_date}{session.course_name ? `・${session.course_name}` : ''}</div>
                </div>
                <span className={`bh-chip shrink-0 ${state.color}`}><StateIcon className="w-3 h-3" />{state.label}</span>
            </div>
            <div className="flex items-end justify-between gap-3 mt-4 pt-3 border-t-2 border-bauhaus-black/10">
                <div className="text-xs text-bauhaus-black/50">
                    {session.duration_hours ? `${session.duration_hours}h` : '未填時數'}
                    {session.student_count ? `・${session.student_count} 人` : ''}
                </div>
                <div className="font-black text-bauhaus-black tabular-nums">
                    {state.unpriced ? state.label : money(session.total_salary)}
                </div>
            </div>
        </button>
    );
};


const SalaryRow = ({ session, onEdit }) => {
    const s = session;
    const state = recordState(s);
    const StatusIcon = state.icon;
    return (
        <tr
            onClick={onEdit}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onEdit();
                }
            }}
            tabIndex={0}
            aria-label={`開啟 ${s.instructor_name} ${s.session_date} 薪資紀錄`}
            className={`cursor-pointer ${s.is_anomaly ? 'bg-bauhaus-red/10 hover:bg-bauhaus-red/20' : s.status === 'pending' ? 'bg-bauhaus-yellow/20 hover:bg-bauhaus-yellow/30' : 'hover:bg-bauhaus-cream'}`}
        >
            <td className="px-4 py-3">
                <div className="flex items-center gap-1.5">
                    {s.is_anomaly && <AlertTriangle className="w-3.5 h-3.5 text-bauhaus-red" title={s.anomaly_reasons?.join(', ')} />}
                    <span className="text-bauhaus-black/80">{s.session_date}</span>
                </div>
            </td>
            <td className="px-4 py-3">
                <div className="font-semibold text-bauhaus-black">{s.instructor_name}</div>
                {s.instructor_role_at_time && (
                    <div className="text-xs text-bauhaus-black/50">{s.instructor_role_at_time}</div>
                )}
                {s.speed_qualification_at_time && (
                    <div className="text-xs text-bauhaus-black/50">{speedQualificationLabel(s.speed_qualification_at_time)}</div>
                )}
            </td>
            <td className="px-4 py-3">
                <div className="text-bauhaus-black/80">{COURSE_LABELS[s.course_type] || s.course_type}</div>
                {s.course_name && <div className="text-xs text-bauhaus-black/50 truncate max-w-[200px]">{s.course_name}</div>}
            </td>
            <td className="px-4 py-3 text-right text-bauhaus-black/70 text-xs">
                {s.duration_hours ? `${s.duration_hours}h` : '–'}
                {s.student_count ? ` / ${s.student_count}人` : ''}
            </td>
            <td className="px-4 py-3 text-right text-bauhaus-black/80">
                {state.unpriced ? <span className="font-bold text-bauhaus-red">{state.label}</span> : (s.base_salary !== null ? money(s.base_salary) : '–')}
            </td>
            <td className="px-4 py-3 text-right text-bauhaus-black/80">
                {s.bonus > 0 ? `$${Math.round(s.bonus).toLocaleString()}` : '–'}
            </td>
            <td className="px-4 py-3 text-right font-bold text-bauhaus-black">
                {state.unpriced ? state.label : `$${Math.round(s.total_salary || 0).toLocaleString()}`}
            </td>
            <td className="px-4 py-3">
                <span className={`bh-chip ${state.color}`}>
                    <StatusIcon className="w-3 h-3" />{state.label}
                </span>
            </td>
        </tr>
    );
};


const AddSalaryModal = ({ instructors, onClose, onSaved, profile }) => {
    useDialogDismiss(onClose);
    const [form, setForm] = useState({
        instructor_id: '',
        course_type: 'regular_basic',
        course_name: '',
        session_date: TAIPEI_TODAY,
        role_in_session: 'lead',
        duration_hours: '',
        student_count: '',
        base_salary: '',
        bonus: '',
        manual_adjustment_reason: '',
        notes: '',
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [quote, setQuote] = useState(null);
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quoteError, setQuoteError] = useState('');

    useEffect(() => {
        if (!form.instructor_id || !form.course_type || !form.session_date) {
            setQuote(null);
            return undefined;
        }
        let active = true;
        const timer = window.setTimeout(async () => {
            setQuoteLoading(true);
            setQuoteError('');
            try {
                const nextQuote = await getSalaryQuote({
                    instructorId: form.instructor_id,
                    courseType: form.course_type,
                    sessionDate: form.session_date,
                    roleInSession: form.role_in_session,
                    durationHours: form.duration_hours,
                    studentCount: form.student_count,
                });
                if (!active) return;
                setQuote(nextQuote);
                setForm(prev => ({
                    ...prev,
                    base_salary: nextQuote?.matched && nextQuote.base_salary !== null
                        ? String(nextQuote.base_salary)
                        : '',
                    manual_adjustment_reason: '',
                }));
            } catch (err) {
                if (active) {
                    setQuote(null);
                    setQuoteError(salaryErrorMessage(err, '薪資試算失敗，請稍後再試。'));
                }
            } finally {
                if (active) setQuoteLoading(false);
            }
        }, 250);
        return () => { active = false; window.clearTimeout(timer); };
    }, [
        form.instructor_id,
        form.course_type,
        form.session_date,
        form.role_in_session,
        form.duration_hours,
        form.student_count,
    ]);

    const submit = async (event) => {
        event?.preventDefault();
        if (!form.instructor_id) { setError('請選擇講師'); return; }
        if (!form.session_date || form.session_date > TAIPEI_TODAY) {
            setError('請填寫不晚於今天的課程日期'); return;
        }
        if (form.duration_hours !== '' && (Number(form.duration_hours) <= 0 || Number(form.duration_hours) > 24)) {
            setError('時數必須大於 0 且不得超過 24 小時'); return;
        }
        if (form.student_count !== '' && (Number(form.student_count) < 1 || Number(form.student_count) > 999)) {
            setError('人數必須介於 1 至 999 人'); return;
        }
        setSaving(true); setError('');
        let freshQuote;
        try {
            freshQuote = await getSalaryQuote({
                instructorId: form.instructor_id,
                courseType: form.course_type,
                sessionDate: form.session_date,
                roleInSession: form.role_in_session,
                durationHours: form.duration_hours,
                studentCount: form.student_count,
            });
        } catch (err) {
            setSaving(false);
            setError(salaryErrorMessage(err, '薪資試算失敗，請稍後再試。'));
            return;
        }
        if (!freshQuote) {
            setSaving(false);
            setError('薪資試算沒有回傳結果，請稍後再試');
            return;
        }
        const instr = instructors.find(i => i.id === form.instructor_id);
        const hasManualAmount = form.base_salary !== '';
        const quotedAmount = freshQuote?.base_salary;
        const isManual = hasManualAmount && (
            freshQuote?.needs_review
            || quotedAmount === null
            || Number(form.base_salary) !== Number(quotedAmount)
        );

        if (isManual && !form.manual_adjustment_reason.trim()) {
            setSaving(false);
            setError('人工調整薪資時必須填寫調整原因');
            return;
        }

        const unresolved = freshQuote?.needs_review && !isManual;
        const payload = {
            instructor_id: form.instructor_id,
            instructor_name: instr?.full_name || '',
            instructor_role_at_time: instr?.instructor_role || null,
            speed_qualification_at_time: instr?.speed_qualification || null,
            course_type: form.course_type,
            course_name: form.course_name || null,
            session_date: form.session_date,
            role_in_session: form.role_in_session,
            duration_hours: form.duration_hours ? Number(form.duration_hours) : null,
            student_count: form.student_count ? Number(form.student_count) : null,
            pricing_mode: freshQuote?.pricing_mode || null,
            rate_card_id: freshQuote?.rate_card_id || null,
            pricing_basis: isManual ? 'manual' : freshQuote?.pricing_basis,
            pricing_label: isManual ? '人工調整' : freshQuote?.pricing_label,
            applied_rate: freshQuote?.applied_rate ?? null,
            base_salary: unresolved ? null : (hasManualAmount ? Number(form.base_salary) : freshQuote?.base_salary ?? null),
            bonus: form.bonus ? Number(form.bonus) : 0,
            pricing_status: isManual ? 'manual_override' : (unresolved ? 'needs_review' : 'quoted'),
            pricing_message: isManual ? '管理員人工調整薪資' : freshQuote?.message,
            pricing_quoted_at: new Date().toISOString(),
            manual_adjustment_reason: isManual ? form.manual_adjustment_reason.trim() : null,
            notes: form.notes || null,
            status: unresolved ? 'pending' : 'approved',
            approved_by: unresolved ? null : profile?.id,
            approved_at: unresolved ? null : new Date().toISOString(),
            registered_by: profile?.id,
            registered_by_name: profile?.name || profile?.email,
            source: 'manual',
        };
        const { error } = await supabase.from('class_sessions').insert(payload);
        setSaving(false);
        if (error) { setError(salaryErrorMessage(error)); return; }
        onSaved();
    };

    const manualRequired = form.base_salary !== '' && quote && (
        quote.needs_review
        || quote.base_salary === null
        || Number(form.base_salary) !== Number(quote.base_salary)
    );

    return (
        <div className="fixed inset-0 bg-bauhaus-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
            <form role="dialog" aria-modal="true" aria-labelledby="add-salary-title" className="bh-card shadow-hard-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto" onSubmit={submit} onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-6 border-b-2 border-bauhaus-black">
                    <h2 id="add-salary-title" className="text-xl font-black text-bauhaus-black">新增薪資紀錄</h2>
                    <button type="button" onClick={onClose} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-bauhaus-black/50 hover:text-bauhaus-black hover:bg-bauhaus-muted" aria-label="關閉新增薪資紀錄">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="講師*">
                        <select required autoFocus value={form.instructor_id} onChange={e => setForm({ ...form, instructor_id: e.target.value })}
                            className="bh-input">
                            <option value="">請選擇</option>
                            {instructors.map(i => (
                                <option key={i.id} value={i.id}>
                                    {i.full_name}（一般：{i.instructor_role || '未設定'}／速解：{speedQualificationLabel(i.speed_qualification)}）
                                </option>
                            ))}
                        </select>
                    </Field>

                    <Field label="日期*">
                        <input type="date" required max={TAIPEI_TODAY} value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="課程類型*">
                        <select value={form.course_type} onChange={e => setForm({ ...form, course_type: e.target.value })}
                            className="bh-input">
                            {Object.entries(COURSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>

                    <Field label="角色">
                        <select value={form.role_in_session} onChange={e => setForm({ ...form, role_in_session: e.target.value })}
                            className="bh-input">
                            {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>

                    <Field label="課程名稱" full>
                        <input type="text" maxLength={160} value={form.course_name} onChange={e => setForm({ ...form, course_name: e.target.value })}
                            placeholder="例：OO 國小週二班 5/20"
                            className="bh-input" />
                    </Field>

                    <Field label="時數">
                        <input type="number" min="0.5" max="24" step="0.5" value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="人數">
                        <input type="number" min="1" max="999" step="1" value={form.student_count} onChange={e => setForm({ ...form, student_count: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <SalaryQuotePanel quote={quote} loading={quoteLoading} error={quoteError} />

                    <Field label={quote?.needs_review ? '人工核定基本薪資（可留空待後續處理）' : '最終基本薪資'}>
                        <input type="number" value={form.base_salary} onChange={e => setForm({ ...form, base_salary: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="獎金">
                        <input type="number" value={form.bonus} onChange={e => setForm({ ...form, bonus: e.target.value })}
                            className="bh-input" />
                    </Field>

                    {manualRequired && (
                        <Field label="人工調整原因*" full>
                            <textarea
                                value={form.manual_adjustment_reason}
                                onChange={e => setForm({ ...form, manual_adjustment_reason: e.target.value })}
                                rows={2}
                                placeholder="例：依專案書面約定、代課特殊加給…"
                                className="bh-input"
                            />
                        </Field>
                    )}

                    <Field label="備註" full>
                        <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2}
                            className="bh-input" />
                    </Field>
                </div>

                {error && (
                    <div role="alert" className="px-6 pb-2 text-sm text-bauhaus-red font-bold">{error}</div>
                )}

                <div className="flex justify-end gap-2 p-6 border-t-2 border-bauhaus-black">
                    <button type="button" onClick={onClose} className="bh-btn bh-btn-outline px-4 py-2">取消</button>
                    <button type="submit" disabled={saving || quoteLoading} className="bh-btn bh-btn-blue px-4 py-2">
                        {saving ? '儲存中…' : (quoteLoading ? '試算中…' : '儲存')}
                    </button>
                </div>
            </form>
        </div>
    );
};

const Field = ({ label, children, full = false }) => (
    <label className={full ? 'sm:col-span-2 block' : 'block'}>
        <span className="bh-label block mb-1">{label}</span>
        {children}
    </label>
);


// ───────────────────────────────────────────────────────────────
// 編輯/審核 Modal:可改薪資、狀態、付款金額,並做核薪動作
// ───────────────────────────────────────────────────────────────
const EditSalaryModal = ({ session, instructors, profile, onClose, onSaved }) => {
    useDialogDismiss(onClose);
    const [form, setForm] = useState({
        course_type: session.course_type,
        course_name: session.course_name || '',
        session_date: session.session_date,
        duration_hours: session.duration_hours || '',
        student_count: session.student_count || '',
        role_in_session: session.role_in_session || 'lead',
        base_salary: session.base_salary ?? '',
        bonus: session.bonus || 0,
        paid_amount: session.paid_amount || 0,
        status: session.status,
        notes: session.notes || '',
        manual_override: session.pricing_status === 'manual_override',
        manual_adjustment_reason: session.manual_adjustment_reason || '',
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [calculatedQuote, setCalculatedQuote] = useState(null);
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quoteError, setQuoteError] = useState('');

    const total = Number(form.base_salary || 0) + Number(form.bonus || 0);
    const instructor = instructors.find(i => i.id === session.instructor_id);

    const recalculate = async () => {
        setQuoteLoading(true);
        setQuoteError('');
        setError('');
        try {
            const nextQuote = await getSalaryQuote({
                instructorId: session.instructor_id,
                courseType: form.course_type,
                sessionDate: form.session_date,
                roleInSession: form.role_in_session,
                durationHours: form.duration_hours,
                studentCount: form.student_count,
            });
            setCalculatedQuote(nextQuote);
            setForm(prev => ({
                ...prev,
                base_salary: nextQuote?.matched && nextQuote.base_salary !== null ? String(nextQuote.base_salary) : '',
                status: nextQuote?.needs_review ? 'pending' : prev.status,
                manual_override: false,
                manual_adjustment_reason: '',
            }));
        } catch (err) {
            setQuoteError(salaryErrorMessage(err, '薪資試算失敗，請稍後再試。'));
        } finally {
            setQuoteLoading(false);
        }
    };

    const save = async (overrides = {}) => {
        setError('');
        const pricingInputsChanged = form.course_type !== session.course_type
            || form.session_date !== session.session_date
            || Number(form.duration_hours || 0) !== Number(session.duration_hours || 0)
            || Number(form.student_count || 0) !== Number(session.student_count || 0);
        const salaryChanged = Number(form.base_salary || 0) !== Number(session.base_salary || 0);

        if (form.manual_override && (form.base_salary === '' || !form.manual_adjustment_reason.trim())) {
            setError('人工調整薪資必須填寫金額與原因');
            return;
        }
        if (!form.session_date || form.session_date > TAIPEI_TODAY) {
            setError('請填寫不晚於今天的課程日期');
            return;
        }
        if (form.duration_hours !== '' && (Number(form.duration_hours) <= 0 || Number(form.duration_hours) > 24)) {
            setError('時數必須大於 0 且不得超過 24 小時');
            return;
        }
        if (form.student_count !== '' && (Number(form.student_count) < 1 || Number(form.student_count) > 999)) {
            setError('人數必須介於 1 至 999 人');
            return;
        }
        if ([form.base_salary, form.bonus, form.paid_amount].some(value => value !== '' && Number(value) < 0)) {
            setError('薪資、獎金與已付金額不得為負數');
            return;
        }
        if (!form.manual_override && pricingInputsChanged && !calculatedQuote) {
            setError('課程類型、日期、時數或人數已變更，請先重新依報酬表試算');
            return;
        }
        if (!form.manual_override && salaryChanged && !calculatedQuote) {
            setError('直接變更基本薪資時，請勾選人工調整並填寫原因');
            return;
        }
        const nextStatus = overrides.status || form.status;
        const remainsUnpriced = calculatedQuote
            ? calculatedQuote.needs_review
            : ['needs_review', 'rejected'].includes(session.pricing_status);
        if (!form.manual_override && remainsUnpriced && nextStatus !== 'pending') {
            setError('這筆紀錄尚未完成定價，請先補齊資格後重新試算，或使用人工調整');
            return;
        }

        setSaving(true);
        const payload = {
            course_type: form.course_type,
            course_name: form.course_name || null,
            session_date: form.session_date,
            duration_hours: form.duration_hours ? Number(form.duration_hours) : null,
            student_count: form.student_count ? Number(form.student_count) : null,
            role_in_session: form.role_in_session,
            base_salary: form.base_salary === '' ? null : Number(form.base_salary),
            bonus: Number(form.bonus || 0),
            paid_amount: Number(form.paid_amount || 0),
            status: form.status,
            notes: form.notes || null,
            ...overrides,
        };
        if (form.manual_override) {
            Object.assign(payload, {
                pricing_status: 'manual_override',
                pricing_basis: 'manual',
                pricing_label: '人工調整',
                pricing_message: '管理員人工調整薪資',
                manual_adjustment_reason: form.manual_adjustment_reason.trim(),
            });
        } else if (calculatedQuote) {
            Object.assign(payload, {
                pricing_mode: calculatedQuote.pricing_mode || null,
                rate_card_id: calculatedQuote.rate_card_id || null,
                pricing_status: calculatedQuote.needs_review ? 'needs_review' : 'quoted',
                pricing_basis: calculatedQuote.pricing_basis,
                pricing_label: calculatedQuote.pricing_label,
                pricing_message: calculatedQuote.message,
                applied_rate: calculatedQuote.applied_rate ?? null,
                base_salary: calculatedQuote.needs_review ? null : calculatedQuote.base_salary,
                pricing_quoted_at: new Date().toISOString(),
                manual_adjustment_reason: null,
                speed_qualification_at_time: instructor?.speed_qualification || null,
                instructor_role_at_time: instructor?.instructor_role || null,
            });
            if (calculatedQuote.needs_review) payload.status = 'pending';
        }
        // 若這次切到 approved,記下 approved_by + approved_at
        if (payload.status === 'approved' && session.status !== 'approved') {
            payload.approved_by = profile?.id;
            payload.approved_at = new Date().toISOString();
        }
        if (payload.status === 'paid' && session.status !== 'paid') {
            payload.paid_at = new Date().toISOString();
            if (!payload.paid_amount) payload.paid_amount = payload.base_salary + payload.bonus;
        }
        const { error: err } = await supabase.from('class_sessions').update(payload).eq('id', session.id);
        setSaving(false);
        if (err) { setError(salaryErrorMessage(err)); return; }
        onSaved();
    };

    const approve = () => save({ status: 'approved', approved_by: profile?.id, approved_at: new Date().toISOString() });

    const reject = async () => {
        if (!form.notes.trim()) {
            setError('退回回報前，請在備註填寫退回原因');
            return;
        }
        setSaving(true);
        setError('');
        const { error: err } = await supabase.from('class_sessions').update({
            status: 'pending',
            base_salary: null,
            pricing_status: 'rejected',
            pricing_basis: null,
            pricing_label: null,
            pricing_message: `管理員退回：${form.notes.trim()}`,
            manual_adjustment_reason: null,
            notes: form.notes.trim(),
        }).eq('id', session.id);
        setSaving(false);
        if (err) { setError(salaryErrorMessage(err)); return; }
        onSaved();
    };

    return (
        <div className="fixed inset-0 bg-bauhaus-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
            <div role="dialog" aria-modal="true" aria-labelledby="edit-salary-title" className="bh-card shadow-hard-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-6 border-b-2 border-bauhaus-black">
                    <div>
                        <h2 id="edit-salary-title" className="text-xl font-black text-bauhaus-black">
                            審核 / 編輯薪資紀錄
                        </h2>
                        <p className="text-sm text-bauhaus-black/60 mt-0.5">
                            {session.instructor_name} {session.instructor_role_at_time && `(${session.instructor_role_at_time})`}
                            {session.source === 'self_report' && <span className="bh-chip ml-2 bg-bauhaus-blue text-white">講師自填</span>}
                            {session.source === 'historical_import' && <span className="bh-chip ml-2 bg-bauhaus-muted text-bauhaus-black">歷史匯入</span>}
                        </p>
                    </div>
                    <button type="button" onClick={onClose} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl text-bauhaus-black/50 hover:text-bauhaus-black hover:bg-bauhaus-muted" aria-label="關閉薪資紀錄">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* 異常提示 */}
                {session.is_anomaly && session.anomaly_reasons?.length > 0 && (
                    <div className="mx-6 mt-4 bg-bauhaus-red/10 rounded-xl border-2 border-bauhaus-red p-3 flex gap-2">
                        <AlertTriangle className="w-4 h-4 text-bauhaus-red shrink-0 mt-0.5" />
                        <div className="text-sm">
                            <div className="font-bold text-bauhaus-red">系統偵測到異常</div>
                            <div className="text-bauhaus-red/80 text-xs mt-0.5">{session.anomaly_reasons.join('、')}</div>
                        </div>
                    </div>
                )}

                {/* 講師原本填的回報 */}
                {(session.self_review || session.progress_note || session.incident_report) && (
                    <div className="mx-6 mt-4 bg-bauhaus-cream rounded-xl border-2 border-bauhaus-black p-4 space-y-2">
                        <div className="text-xs font-bold text-bauhaus-black/70 flex items-center gap-1">
                            <MessageSquare className="w-3.5 h-3.5" /> 講師回報
                        </div>
                        {session.self_review && (
                            <div><span className="text-xs text-bauhaus-black/50">自評:</span><div className="text-sm text-bauhaus-black/80 whitespace-pre-wrap">{session.self_review}</div></div>
                        )}
                        {session.progress_note && (
                            <div><span className="text-xs text-bauhaus-black/50">學習進度:</span><div className="text-sm text-bauhaus-black/80 whitespace-pre-wrap">{session.progress_note}</div></div>
                        )}
                        {session.incident_report && (
                            <div><span className="text-xs text-bauhaus-black/50">特殊狀況:</span><div className="text-sm text-bauhaus-red whitespace-pre-wrap">{session.incident_report}</div></div>
                        )}
                    </div>
                )}

                <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="課程類型">
                        <select value={form.course_type} onChange={e => setForm({ ...form, course_type: e.target.value })}
                            className="bh-input">
                            {Object.entries(COURSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>
                    <Field label="日期">
                        <input type="date" max={TAIPEI_TODAY} value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })}
                            className="bh-input" />
                    </Field>
                    <Field label="課程名稱" full>
                        <input maxLength={160} value={form.course_name} onChange={e => setForm({ ...form, course_name: e.target.value })}
                            className="bh-input" />
                    </Field>
                    <Field label="時數">
                        <input type="number" min="0.5" max="24" step="0.5" value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                            className="bh-input" />
                    </Field>
                    <Field label="人數">
                        <input type="number" min="1" max="999" step="1" value={form.student_count} onChange={e => setForm({ ...form, student_count: e.target.value })}
                            className="bh-input" />
                    </Field>
                    <Field label="角色">
                        <select value={form.role_in_session} onChange={e => setForm({ ...form, role_in_session: e.target.value })}
                            className="bh-input">
                            {Object.entries(ROLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                    </Field>
                    <Field label="狀態">
                        <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })}
                            className="bh-input">
                            <option value="pending">待核准</option>
                            <option value="approved">已核准</option>
                            <option value="paid">已付款</option>
                        </select>
                    </Field>
                </div>

                {/* 薪資區塊 */}
                <div className="mx-6 mb-4 bg-bauhaus-cream rounded-xl border-2 border-bauhaus-black p-4">
                    <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                        <div>
                            <div className="text-xs font-bold text-bauhaus-black/70 uppercase tracking-widest">薪資設定</div>
                            <div className="text-xs text-bauhaus-black/50 mt-1">
                                原採用：{session.pricing_label || session.instructor_role_at_time || '舊資料'}
                                {session.pricing_message && ` · ${session.pricing_message}`}
                            </div>
                        </div>
                        <button type="button" onClick={recalculate} disabled={quoteLoading}
                            className="bh-btn bh-btn-outline px-3 py-2 text-xs">
                            <Edit3 className="w-3.5 h-3.5" /> {quoteLoading ? '試算中…' : '重新依報酬表試算'}
                        </button>
                    </div>
                    <SalaryQuotePanel quote={calculatedQuote} loading={quoteLoading} error={quoteError} />
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <Field label="基本薪資">
                            <input type="number" min="0" value={form.base_salary} onChange={e => setForm({ ...form, base_salary: e.target.value })}
                                className="bh-input" />
                        </Field>
                        <Field label="獎金">
                            <input type="number" min="0" value={form.bonus} onChange={e => setForm({ ...form, bonus: e.target.value })}
                                className="bh-input" />
                        </Field>
                        <Field label="總計(自動)">
                            <div className="w-full px-3 py-2 bg-white rounded-xl border-2 border-bauhaus-black font-bold text-bauhaus-blue">
                                ${Math.round(total).toLocaleString()}
                            </div>
                        </Field>
                        <Field label="已付款金額">
                            <input type="number" min="0" value={form.paid_amount} onChange={e => setForm({ ...form, paid_amount: e.target.value })}
                                className="bh-input" />
                        </Field>
                    </div>
                    <label className="mt-4 flex items-center gap-2 text-sm font-bold text-bauhaus-black cursor-pointer">
                        <input
                            type="checkbox"
                            checked={form.manual_override}
                            onChange={e => setForm({ ...form, manual_override: e.target.checked })}
                            className="w-5 h-5 accent-bauhaus-blue"
                        />
                        人工調整基本薪資
                    </label>
                    {form.manual_override && (
                        <div className="mt-3">
                            <Field label="人工調整原因*">
                                <textarea
                                    rows={2}
                                    value={form.manual_adjustment_reason}
                                    onChange={e => setForm({ ...form, manual_adjustment_reason: e.target.value })}
                                    placeholder="例：依專案書面約定、代課特殊加給…"
                                    className="bh-input"
                                />
                            </Field>
                        </div>
                    )}
                </div>

                <div className="px-6 pb-4">
                    <Field label="備註" full>
                        <textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                            className="bh-input" />
                    </Field>
                </div>

                {error && <div role="alert" className="px-6 pb-3 text-sm text-bauhaus-red font-bold">{error}</div>}

                <div className="flex flex-wrap items-center justify-between gap-2 p-6 border-t-2 border-bauhaus-black">
                    <div className="text-xs text-bauhaus-black/50">
                        {session.registered_by_name && `登記者:${session.registered_by_name} · `}
                        建立於 {new Date(session.created_at).toLocaleString('zh-TW')}
                    </div>
                    <div className="flex gap-2">
                        {session.source === 'self_report' && session.pricing_status !== 'rejected' && (
                            <button onClick={reject} disabled={saving}
                                className="bh-btn bh-btn-outline px-4 py-2 text-sm text-bauhaus-red">
                                退回回報
                            </button>
                        )}
                        {session.status === 'pending' && (
                            <button onClick={approve} disabled={saving}
                                className="bh-btn bh-btn-blue px-4 py-2 text-sm">
                                <CheckCircle2 className="w-4 h-4" /> 核准
                            </button>
                        )}
                        <button onClick={onClose} className="bh-btn bh-btn-outline px-4 py-2 text-sm">取消</button>
                        <button onClick={() => save()} disabled={saving}
                            className="bh-btn bh-btn-blue px-4 py-2 text-sm">
                            {saving ? '儲存中...' : '儲存'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SalaryRegister;
