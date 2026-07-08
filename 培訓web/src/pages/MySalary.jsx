import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Wallet, TrendingUp, Calendar, Clock, AlertCircle, Plus } from 'lucide-react';
import { COURSE_LABELS } from '../lib/constants';

const STATUS_LABELS = { pending: '待核准', approved: '已核准', paid: '已付款' };
const STATUS_COLORS = {
    pending:  'bg-amber-50 text-amber-700',
    approved: 'bg-blue-50 text-blue-700',
    paid:     'bg-emerald-50 text-emerald-700',
};

const MySalary = () => {
    const { user } = useAuth();
    const [summary, setSummary] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [monthFilter, setMonthFilter] = useState('');

    useEffect(() => {
        if (user) load();
    }, [user]);

    const load = async () => {
        setLoading(true);
        // 自己的彙總(VIEW 自動依 RLS 過濾)
        const [sumRes, sessRes] = await Promise.all([
            supabase.from('instructor_salary_summary').select('*').eq('user_id', user.id).maybeSingle(),
            supabase.from('class_sessions').select('*').order('session_date', { ascending: false }).limit(1000),
        ]);
        setSummary(sumRes.data);
        setSessions(sessRes.data || []);
        setLoading(false);
    };

    const months = useMemo(() => [...new Set(sessions.map(s => s.month_label).filter(Boolean))].sort().reverse(), [sessions]);
    const filtered = useMemo(() => monthFilter ? sessions.filter(s => s.month_label === monthFilter) : sessions, [sessions, monthFilter]);

    // 月份統計(這個月 + 排序)
    const monthlyStats = useMemo(() => {
        const map = {};
        for (const s of sessions) {
            if (!s.month_label) continue;
            if (!map[s.month_label]) map[s.month_label] = { total: 0, count: 0, hours: 0 };
            map[s.month_label].total += Number(s.total_salary || 0);
            map[s.month_label].count += 1;
            map[s.month_label].hours += Number(s.duration_hours || 0);
        }
        return Object.entries(map).map(([m, v]) => ({ month: m, ...v })).sort((a, b) => b.month.localeCompare(a.month));
    }, [sessions]);

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    if (!summary) {
        return (
            <div className="p-4 sm:p-8 max-w-3xl mx-auto">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 px-6 text-center">
                    <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Wallet className="w-8 h-8 text-slate-300" />
                    </div>
                    <h2 className="text-xl font-black text-slate-900">還沒有薪資紀錄</h2>
                    <p className="text-slate-500 mt-2 text-sm">完成接課後登記課程回報，你的鐘點與獎金就會顯示在這裡。</p>
                    <Link
                        to="/my/salary/new"
                        className="inline-flex items-center justify-center gap-2 mt-6 min-h-[44px] px-6 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors"
                    >
                        <Plus className="w-4 h-4" /> 登記課程回報
                    </Link>
                </div>
            </div>
        );
    }

    const fmt = (n) => `$${Math.round(Number(n || 0)).toLocaleString()}`;
    const fmtHr = (n) => `${Number(n || 0).toFixed(1)} 小時`;

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-slate-900">我的薪資</h1>
                    <p className="text-slate-500 mt-1 text-sm">{summary.full_name}</p>
                </div>
                <Link to="/my/salary/new"
                    className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2.5 rounded-xl transition-colors shadow-sm w-full sm:w-auto">
                    <Plus className="w-4 h-4" /> 登記課程回報
                </Link>
            </div>

            {/* 主要數字:本月 + 累計 + 應領未領 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <BigStat
                    icon={Calendar}
                    label="本月薪資"
                    value={fmt(summary.this_month_salary)}
                    sub={`${summary.this_month_sessions} 場`}
                    color="from-blue-500 to-blue-600"
                />
                <BigStat
                    icon={TrendingUp}
                    label="今年累計"
                    value={fmt(summary.this_year_salary)}
                    color="from-emerald-500 to-emerald-600"
                />
                <BigStat
                    icon={Wallet}
                    label="未領金額"
                    value={fmt(summary.total_unpaid)}
                    sub={`已領 ${fmt(summary.total_paid)}`}
                    color="from-amber-500 to-amber-600"
                />
            </div>

            {/* 細項:累計 + 三狀態分桶 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                <MiniStat label="累計總薪資" value={fmt(summary.total_salary)} />
                <MiniStat label="總場次" value={summary.total_sessions} sub={fmtHr(summary.total_hours)} />
                <MiniStat label="待核准" value={fmt(summary.pending_salary)} color="text-amber-600" />
                <MiniStat label="已核准未付" value={fmt(summary.approved_unpaid_salary)} color="text-blue-600" />
            </div>

            {/* 月份明細 */}
            <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-black text-slate-900">月份明細</h2>
                    <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)}
                        className="text-sm px-3 py-2 rounded-lg border border-slate-200 outline-none">
                        <option value="">全部月份</option>
                        {months.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </div>

                {!monthFilter && monthlyStats.length > 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 mb-6 overflow-hidden">
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-slate-100 text-center">
                            {monthlyStats.slice(0, 6).map(m => (
                                <button
                                    key={m.month}
                                    onClick={() => setMonthFilter(m.month)}
                                    className="p-3 hover:bg-slate-50 transition-colors"
                                >
                                    <div className="text-xs text-slate-400 font-medium">{m.month}</div>
                                    <div className="text-lg font-black text-slate-900 mt-1">{fmt(m.total)}</div>
                                    <div className="text-xs text-slate-400">{m.count} 場</div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* 課程紀錄列表 */}
                <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
                    {/* 手機版：卡片列表 */}
                    <div className="md:hidden divide-y divide-slate-100">
                        {filtered.slice(0, 100).map(s => (
                            <div key={s.id} className="p-4">
                                <div className="flex items-start justify-between gap-2">
                                    <div>
                                        <div className="text-sm font-bold text-slate-800">{s.session_date}</div>
                                        <div className="text-sm text-slate-700 mt-0.5">{COURSE_LABELS[s.course_type] || s.course_type}</div>
                                        {s.course_name && <div className="text-xs text-slate-500 mt-0.5">{s.course_name}</div>}
                                    </div>
                                    <span className={`shrink-0 inline-flex text-xs font-bold px-2 py-1 rounded-full ${STATUS_COLORS[s.status] || ''}`}>
                                        {STATUS_LABELS[s.status] || s.status}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-50">
                                    <span className="text-xs text-slate-500">
                                        {s.duration_hours ? `${s.duration_hours}h` : '–'}
                                        {s.student_count ? ` / ${s.student_count}人` : ''}
                                    </span>
                                    <span className="text-base font-bold text-slate-900">{fmt(s.total_salary)}</span>
                                </div>
                            </div>
                        ))}
                        {filtered.length === 0 && (
                            <div className="px-4 py-12 text-center text-slate-400">這個月還沒有薪資紀錄</div>
                        )}
                    </div>

                    {/* 桌面版：表格 */}
                    <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-slate-50 text-slate-400 text-xs uppercase tracking-wider">
                                <tr>
                                    <th className="px-4 py-3 text-left">日期</th>
                                    <th className="px-4 py-3 text-left">課程</th>
                                    <th className="px-4 py-3 text-right">時數/人</th>
                                    <th className="px-4 py-3 text-right">薪資</th>
                                    <th className="px-4 py-3 text-right">獎金</th>
                                    <th className="px-4 py-3 text-right">總計</th>
                                    <th className="px-4 py-3 text-left">狀態</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-100">
                                {filtered.slice(0, 100).map(s => (
                                    <tr key={s.id} className="hover:bg-slate-50">
                                        <td className="px-4 py-3 text-slate-700">{s.session_date}</td>
                                        <td className="px-4 py-3">
                                            <div className="text-slate-700">{COURSE_LABELS[s.course_type] || s.course_type}</div>
                                            {s.course_name && <div className="text-xs text-slate-500">{s.course_name}</div>}
                                        </td>
                                        <td className="px-4 py-3 text-right text-slate-600 text-xs">
                                            {s.duration_hours ? `${s.duration_hours}h` : '–'}
                                            {s.student_count ? ` / ${s.student_count}人` : ''}
                                        </td>
                                        <td className="px-4 py-3 text-right text-slate-700">
                                            {s.base_salary > 0 ? fmt(s.base_salary) : '–'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-slate-700">
                                            {s.bonus > 0 ? fmt(s.bonus) : '–'}
                                        </td>
                                        <td className="px-4 py-3 text-right font-bold text-slate-900">{fmt(s.total_salary)}</td>
                                        <td className="px-4 py-3">
                                            <span className={`inline-flex text-xs font-bold px-2 py-1 rounded-full ${STATUS_COLORS[s.status] || ''}`}>
                                                {STATUS_LABELS[s.status] || s.status}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                                {filtered.length === 0 && (
                                    <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">這個月還沒有薪資紀錄</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
};


const BigStat = ({ icon, label, value, sub, color }) => {
    const Icon = icon;
    return (
    <div className={`bg-gradient-to-br ${color} rounded-2xl p-5 text-white shadow-sm`}>
        <div className="flex items-center gap-2 text-white/80 text-sm font-medium">
            <Icon className="w-4 h-4" /> {label}
        </div>
        <div className="text-3xl font-black mt-2">{value}</div>
        {sub && <div className="text-xs text-white/80 mt-1">{sub}</div>}
    </div>
    );
};

const MiniStat = ({ label, value, sub, color = 'text-slate-900' }) => (
    <div className="bg-white rounded-xl border border-slate-200 p-3">
        <div className="text-xs text-slate-400 font-medium">{label}</div>
        <div className={`text-lg font-black mt-1 ${color}`}>{value}</div>
        {sub && <div className="text-xs text-slate-400 mt-0.5">{sub}</div>}
    </div>
);

export default MySalary;
