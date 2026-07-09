import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import { Search, Plus, AlertTriangle, X, Calendar, ChevronDown, CheckCircle2, Clock, Wallet, Edit3, MessageSquare } from 'lucide-react';
import { COURSE_LABELS, ROLE_LABELS } from '../../lib/constants';

const STATUS_STYLES = {
    pending:  { label: '待核准',   color: 'bg-bauhaus-yellow text-bauhaus-black', icon: Clock },
    approved: { label: '已核准',   color: 'bg-bauhaus-blue text-white', icon: CheckCircle2 },
    paid:     { label: '已付款',   color: 'bg-bauhaus-black text-white', icon: Wallet },
};

const SalaryRegister = () => {
    const { profile } = useAuth();
    const [sessions, setSessions] = useState([]);
    const [instructors, setInstructors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [monthFilter, setMonthFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [anomalyOnly, setAnomalyOnly] = useState(false);
    const [showAdd, setShowAdd] = useState(false);
    const [editing, setEditing] = useState(null);  // session being edited

    useEffect(() => { load(); }, []);

    const load = async () => {
        setLoading(true);
        const [s, i] = await Promise.all([
            supabase.from('class_sessions').select('*').order('session_date', { ascending: false }).limit(500),
            supabase.from('instructors').select('id, full_name, instructor_role').order('full_name'),
        ]);
        setSessions(s.data || []);
        setInstructors(i.data || []);
        setLoading(false);
    };

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
        });
    }, [sessions, monthFilter, statusFilter, anomalyOnly, search]);

    const months = useMemo(() => [...new Set(sessions.map(s => s.month_label).filter(Boolean))].sort().reverse(), [sessions]);
    const anomalyCount = sessions.filter(s => s.is_anomaly).length;
    const pendingCount = sessions.filter(s => s.status === 'pending').length;

    const stats = useMemo(() => {
        const total = filtered.reduce((sum, s) => sum + Number(s.total_salary || 0), 0);
        const paid = filtered.reduce((sum, s) => sum + Number(s.paid_amount || 0), 0);
        return { total, paid, unpaid: total - paid, count: filtered.length };
    }, [filtered]);

    return (
        <div className="p-4 sm:p-8">
            <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
                <div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">薪資登記</h1>
                    <p className="text-bauhaus-black/60 font-medium mt-1 text-sm">
                        共 {sessions.length} 筆紀錄
                        {pendingCount > 0 && (
                            <button onClick={() => setStatusFilter('pending')} className="ml-2 text-bauhaus-black font-bold hover:underline">
                                🔔 {pendingCount} 筆待審核
                            </button>
                        )}
                        {anomalyCount > 0 && (
                            <button onClick={() => setAnomalyOnly(!anomalyOnly)} className="ml-2 text-bauhaus-red font-bold hover:underline">
                                ⚠️ {anomalyCount} 筆異常
                            </button>
                        )}
                    </p>
                </div>
                <button
                    onClick={() => setShowAdd(true)}
                    className="bh-btn bh-btn-blue px-4 py-2.5"
                >
                    <Plus className="w-4 h-4" /> 新增薪資紀錄
                </button>
            </div>

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
                <label className="inline-flex items-center gap-2 text-sm px-3 py-2 border-2 border-bauhaus-black cursor-pointer hover:bg-bauhaus-cream">
                    <input type="checkbox" checked={anomalyOnly} onChange={e => setAnomalyOnly(e.target.checked)} className="w-5 h-5 accent-bauhaus-red" />
                    僅看異常
                </label>
            </div>

            {/* 表格 */}
            {loading ? (
                <div className="p-12 text-center text-bauhaus-black/60 font-bold">載入中...</div>
            ) : (
                <div className="bh-card overflow-hidden">
                    <div className="overflow-x-auto">
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
                <EditSalaryModal session={editing} profile={profile} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
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


const SalaryRow = ({ session, onEdit }) => {
    const s = session;
    const status = STATUS_STYLES[s.status] || STATUS_STYLES.approved;
    const StatusIcon = status.icon;
    return (
        <tr
            onClick={onEdit}
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
                {s.base_salary > 0 ? `$${Math.round(s.base_salary).toLocaleString()}` : '–'}
            </td>
            <td className="px-4 py-3 text-right text-bauhaus-black/80">
                {s.bonus > 0 ? `$${Math.round(s.bonus).toLocaleString()}` : '–'}
            </td>
            <td className="px-4 py-3 text-right font-bold text-bauhaus-black">
                ${Math.round(s.total_salary || 0).toLocaleString()}
            </td>
            <td className="px-4 py-3">
                <span className={`bh-chip ${status.color}`}>
                    <StatusIcon className="w-3 h-3" />{status.label}
                </span>
            </td>
        </tr>
    );
};


const AddSalaryModal = ({ instructors, onClose, onSaved, profile }) => {
    const [form, setForm] = useState({
        instructor_id: '',
        course_type: 'regular_basic',
        course_name: '',
        session_date: new Date().toISOString().slice(0, 10),
        role_in_session: 'lead',
        duration_hours: '',
        student_count: '',
        base_salary: '',
        bonus: '',
        notes: '',
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const submit = async () => {
        if (!form.instructor_id) { setError('請選擇講師'); return; }
        setSaving(true); setError('');
        const instr = instructors.find(i => i.id === form.instructor_id);
        const payload = {
            instructor_id: form.instructor_id,
            instructor_name: instr?.full_name || '',
            instructor_role_at_time: instr?.instructor_role || null,
            course_type: form.course_type,
            course_name: form.course_name || null,
            session_date: form.session_date,
            role_in_session: form.role_in_session,
            duration_hours: form.duration_hours ? Number(form.duration_hours) : null,
            student_count: form.student_count ? Number(form.student_count) : null,
            base_salary: form.base_salary ? Number(form.base_salary) : 0,
            bonus: form.bonus ? Number(form.bonus) : 0,
            notes: form.notes || null,
            status: 'approved',
            registered_by: profile?.id,
            registered_by_name: profile?.name || profile?.email,
            source: 'manual',
        };
        const { error } = await supabase.from('class_sessions').insert(payload);
        setSaving(false);
        if (error) { setError(error.message); return; }
        onSaved();
    };

    return (
        <div className="fixed inset-0 bg-bauhaus-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
            <div className="bh-card shadow-hard-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-6 border-b-2 border-bauhaus-black">
                    <h2 className="text-xl font-black text-bauhaus-black">新增薪資紀錄</h2>
                    <button onClick={onClose} className="text-bauhaus-black/50 hover:text-bauhaus-black p-1">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="p-6 grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Field label="講師*">
                        <select value={form.instructor_id} onChange={e => setForm({ ...form, instructor_id: e.target.value })}
                            className="bh-input">
                            <option value="">請選擇</option>
                            {instructors.map(i => <option key={i.id} value={i.id}>{i.full_name} {i.instructor_role && `(${i.instructor_role})`}</option>)}
                        </select>
                    </Field>

                    <Field label="日期*">
                        <input type="date" value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })}
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
                        <input type="text" value={form.course_name} onChange={e => setForm({ ...form, course_name: e.target.value })}
                            placeholder="例:OO 國小週二班 5/20"
                            className="bh-input" />
                    </Field>

                    <Field label="時數">
                        <input type="number" step="0.5" value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="人數">
                        <input type="number" value={form.student_count} onChange={e => setForm({ ...form, student_count: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="薪資">
                        <input type="number" value={form.base_salary} onChange={e => setForm({ ...form, base_salary: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="獎金">
                        <input type="number" value={form.bonus} onChange={e => setForm({ ...form, bonus: e.target.value })}
                            className="bh-input" />
                    </Field>

                    <Field label="備註" full>
                        <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2}
                            className="bh-input" />
                    </Field>
                </div>

                {error && (
                    <div className="px-6 pb-2 text-sm text-bauhaus-red font-bold">{error}</div>
                )}

                <div className="flex justify-end gap-2 p-6 border-t-2 border-bauhaus-black">
                    <button onClick={onClose} className="bh-btn bh-btn-outline px-4 py-2">取消</button>
                    <button onClick={submit} disabled={saving} className="bh-btn bh-btn-blue px-4 py-2">
                        {saving ? '儲存中...' : '儲存'}
                    </button>
                </div>
            </div>
        </div>
    );
};

const Field = ({ label, children, full = false }) => (
    <div className={full ? 'sm:col-span-2' : ''}>
        <label className="bh-label block mb-1">{label}</label>
        {children}
    </div>
);


// ───────────────────────────────────────────────────────────────
// 編輯/審核 Modal:可改薪資、狀態、付款金額,並做核薪動作
// ───────────────────────────────────────────────────────────────
const EditSalaryModal = ({ session, profile, onClose, onSaved }) => {
    const [form, setForm] = useState({
        course_type: session.course_type,
        course_name: session.course_name || '',
        session_date: session.session_date,
        duration_hours: session.duration_hours || '',
        student_count: session.student_count || '',
        role_in_session: session.role_in_session || 'lead',
        base_salary: session.base_salary || 0,
        bonus: session.bonus || 0,
        paid_amount: session.paid_amount || 0,
        status: session.status,
        notes: session.notes || '',
    });
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    const total = Number(form.base_salary || 0) + Number(form.bonus || 0);

    const save = async (overrides = {}) => {
        setSaving(true); setError('');
        const payload = {
            course_type: form.course_type,
            course_name: form.course_name || null,
            session_date: form.session_date,
            duration_hours: form.duration_hours ? Number(form.duration_hours) : null,
            student_count: form.student_count ? Number(form.student_count) : null,
            role_in_session: form.role_in_session,
            base_salary: Number(form.base_salary || 0),
            bonus: Number(form.bonus || 0),
            paid_amount: Number(form.paid_amount || 0),
            status: form.status,
            notes: form.notes || null,
            ...overrides,
        };
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
        if (err) { setError(err.message); return; }
        onSaved();
    };

    const approve = () => save({ status: 'approved', approved_by: profile?.id, approved_at: new Date().toISOString() });

    return (
        <div className="fixed inset-0 bg-bauhaus-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
            <div className="bh-card shadow-hard-lg max-w-3xl w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-6 border-b-2 border-bauhaus-black">
                    <div>
                        <h2 className="text-xl font-black text-bauhaus-black">
                            審核 / 編輯薪資紀錄
                        </h2>
                        <p className="text-sm text-bauhaus-black/60 mt-0.5">
                            {session.instructor_name} {session.instructor_role_at_time && `(${session.instructor_role_at_time})`}
                            {session.source === 'self_report' && <span className="bh-chip ml-2 bg-bauhaus-blue text-white">講師自填</span>}
                            {session.source === 'historical_import' && <span className="bh-chip ml-2 bg-bauhaus-muted text-bauhaus-black">歷史匯入</span>}
                        </p>
                    </div>
                    <button onClick={onClose} className="text-bauhaus-black/50 hover:text-bauhaus-black p-1">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* 異常提示 */}
                {session.is_anomaly && session.anomaly_reasons?.length > 0 && (
                    <div className="mx-6 mt-4 bg-bauhaus-red/10 border-2 border-bauhaus-red p-3 flex gap-2">
                        <AlertTriangle className="w-4 h-4 text-bauhaus-red shrink-0 mt-0.5" />
                        <div className="text-sm">
                            <div className="font-bold text-bauhaus-red">系統偵測到異常</div>
                            <div className="text-bauhaus-red/80 text-xs mt-0.5">{session.anomaly_reasons.join('、')}</div>
                        </div>
                    </div>
                )}

                {/* 講師原本填的回報 */}
                {(session.self_review || session.progress_note || session.incident_report) && (
                    <div className="mx-6 mt-4 bg-bauhaus-cream border-2 border-bauhaus-black p-4 space-y-2">
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
                        <input type="date" value={form.session_date} onChange={e => setForm({ ...form, session_date: e.target.value })}
                            className="bh-input" />
                    </Field>
                    <Field label="課程名稱" full>
                        <input value={form.course_name} onChange={e => setForm({ ...form, course_name: e.target.value })}
                            className="bh-input" />
                    </Field>
                    <Field label="時數">
                        <input type="number" step="0.5" value={form.duration_hours} onChange={e => setForm({ ...form, duration_hours: e.target.value })}
                            className="bh-input" />
                    </Field>
                    <Field label="人數">
                        <input type="number" value={form.student_count} onChange={e => setForm({ ...form, student_count: e.target.value })}
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
                <div className="mx-6 mb-4 bg-bauhaus-cream border-2 border-bauhaus-black p-4">
                    <div className="text-xs font-bold text-bauhaus-black/70 mb-3 uppercase tracking-widest">薪資設定</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <Field label="基本薪資">
                            <input type="number" value={form.base_salary} onChange={e => setForm({ ...form, base_salary: e.target.value })}
                                className="bh-input" />
                        </Field>
                        <Field label="獎金">
                            <input type="number" value={form.bonus} onChange={e => setForm({ ...form, bonus: e.target.value })}
                                className="bh-input" />
                        </Field>
                        <Field label="總計(自動)">
                            <div className="w-full px-3 py-2 bg-white border-2 border-bauhaus-black font-bold text-bauhaus-blue">
                                ${Math.round(total).toLocaleString()}
                            </div>
                        </Field>
                        <Field label="已付款金額">
                            <input type="number" value={form.paid_amount} onChange={e => setForm({ ...form, paid_amount: e.target.value })}
                                className="bh-input" />
                        </Field>
                    </div>
                </div>

                <div className="px-6 pb-4">
                    <Field label="備註" full>
                        <textarea rows={2} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
                            className="bh-input" />
                    </Field>
                </div>

                {error && <div className="px-6 pb-3 text-sm text-bauhaus-red font-bold">{error}</div>}

                <div className="flex flex-wrap items-center justify-between gap-2 p-6 border-t-2 border-bauhaus-black">
                    <div className="text-xs text-bauhaus-black/50">
                        {session.registered_by_name && `登記者:${session.registered_by_name} · `}
                        建立於 {new Date(session.created_at).toLocaleString('zh-TW')}
                    </div>
                    <div className="flex gap-2">
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
