import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Wallet, TrendingUp, Calendar, AlertCircle, Plus, ExternalLink, ChevronDown, RefreshCw, CheckCircle2, X } from 'lucide-react';
import { COURSE_LABELS } from '../lib/constants';
import { isSafeHttpUrl } from '../lib/siteLinks';

const STATUS_LABELS = { pending: '待核准', approved: '已核准', paid: '已付款' };
const STATUS_COLORS = {
    pending:  'bg-bauhaus-yellow text-bauhaus-black',
    approved: 'bg-bauhaus-muted text-bauhaus-black',
    paid:     'bg-bauhaus-blue text-white',
};

// 表單連結預設值(對應 supabase/2026-07-09_site_links.sql 的 seed)：
// 若 site_links 資料表還沒建好或讀取失敗，頁面會 fallback 用這組。
const DEFAULT_SALARY_LINKS = [
    {
        key: 'salary_direct',
        label: '直營課程',
        description: '營隊、體驗課、到府課、速解課',
        url: 'https://docs.google.com/forms/d/e/1FAIpQLScKSEUXDctk1cqB7UqDc7CwY9I0g8e6T1XBaX-52c6C5GdTjg/viewform',
    },
    {
        key: 'salary_partner',
        label: '合作單位',
        description: '補習班、學校社團、講座課程',
        url: 'https://forms.gle/CBfwjZv34vT35nZTA',
    },
    {
        key: 'salary_points',
        label: '報酬 / 點數確認區',
        description: '查看每月報酬與點數結算結果',
        url: 'https://docs.google.com/spreadsheets/d/1RQP_7NZFeEQTKcGJPjkoRe758LeADSpDIkY2-s2Q8NI/edit?gid=450117981#gid=450117981',
    },
];

const useSalaryLinks = () => {
    const [links, setLinks] = useState(DEFAULT_SALARY_LINKS);

    useEffect(() => {
        let active = true;
        (async () => {
            const { data, error } = await supabase
                .from('site_links')
                .select('key, label, description, url')
                .in('key', DEFAULT_SALARY_LINKS.map(d => d.key));
            if (error) {
                console.error('讀取薪資表單連結失敗,使用預設值：', error.message);
                return;
            }
            if (!active || !data || data.length === 0) return;
            setLinks(DEFAULT_SALARY_LINKS.map((fallback) => {
                const configured = data.find(row => row.key === fallback.key);
                return configured && isSafeHttpUrl(configured.url) ? configured : fallback;
            }));
        })();
        return () => { active = false; };
    }, []);

    return links;
};

const LegacySalaryLinks = ({ links }) => {
    const reportLinks = links.filter(link => link.key !== 'salary_points');
    return (
        <details className="group border-2 lg:border-4 border-bauhaus-black rounded-2xl bg-white overflow-hidden shadow-hard mt-8">
            <summary className="list-none cursor-pointer min-h-[64px] p-4 sm:p-5 flex items-center justify-between gap-4 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-bauhaus-blue/40">
                <div>
                    <h2 className="font-black text-bauhaus-black">仍在使用舊表單？</h2>
                    <p className="text-sm text-bauhaus-black/60 mt-1 font-medium">轉換期間可繼續使用；同一堂課請擇一回報，不要重複送出。</p>
                </div>
                <ChevronDown className="w-5 h-5 shrink-0 transition-transform duration-200 group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="border-t-2 lg:border-t-4 border-bauhaus-black p-4 sm:p-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {reportLinks.map((link) => (
                        <a
                            key={link.key}
                            href={link.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-h-[52px] rounded-xl border-2 border-bauhaus-black px-4 py-3 flex items-center justify-between gap-3 font-bold text-bauhaus-black hover:bg-bauhaus-cream focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-bauhaus-blue/40"
                        >
                            <div>
                                <div>{link.label}舊表單</div>
                                {link.description && <div className="text-xs text-bauhaus-black/60 mt-0.5 font-medium">{link.description}</div>}
                            </div>
                            <ExternalLink className="w-4 h-4 shrink-0" aria-hidden="true" />
                        </a>
                    ))}
                </div>
                <div className="mt-4 bg-bauhaus-yellow rounded-xl border-2 border-bauhaus-black p-4 text-sm font-medium text-bauhaus-black leading-relaxed">
                    每月 25 號結算（上月 26 日～本月 25 日）；逾期回報併入下月。站內試算與狀態供核對，正式入帳金額仍以 <a href="mailto:hi@dreamcube.tw" className="font-black underline inline-flex items-center min-h-[44px] py-1">hi@dreamcube.tw</a> 信件為準。
                </div>
            </div>
        </details>
    );
};

const MySalary = () => {
    const { user } = useAuth();
    const location = useLocation();
    const navigate = useNavigate();
    const [summary, setSummary] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [monthFilter, setMonthFilter] = useState('');
    const [showSubmitSuccess, setShowSubmitSuccess] = useState(Boolean(location.state?.salaryReportSubmitted));
    const salaryLinks = useSalaryLinks();
    const pointsLink = salaryLinks.find(link => link.key === 'salary_points');

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        // 自己的彙總(VIEW 自動依 RLS 過濾)
        const [sumRes, sessRes] = await Promise.all([
            supabase.from('instructor_salary_summary').select('*').eq('user_id', user.id).maybeSingle(),
            supabase.from('class_sessions').select('*').order('session_date', { ascending: false }).limit(1000),
        ]);
        if (sumRes.error || sessRes.error) {
            setLoadError('報酬資料暫時無法載入，請稍後再試。');
        } else {
            setSummary(sumRes.data);
            setSessions(sessRes.data || []);
        }
        setLoading(false);
    }, [user]);

    useEffect(() => {
        if (!user) return undefined;
        const timer = window.setTimeout(load, 0);
        return () => window.clearTimeout(timer);
    }, [user, load]);

    useEffect(() => {
        if (!location.state?.salaryReportSubmitted) return;
        navigate(location.pathname, { replace: true, state: null });
    }, [location.pathname, location.state, navigate]);

    const months = useMemo(() => [...new Set(sessions.map(s => s.month_label).filter(Boolean))].sort().reverse(), [sessions]);
    const filtered = useMemo(() => monthFilter ? sessions.filter(s => s.month_label === monthFilter) : sessions, [sessions, monthFilter]);
    const needsReviewCount = sessions.filter(s => s.pricing_status === 'needs_review').length;
    const rejectedCount = sessions.filter(s => s.pricing_status === 'rejected').length;

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

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    if (loadError) {
        return (
            <div className="p-4 sm:p-8 max-w-3xl mx-auto">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
                    <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">我的報酬</h1>
                    {pointsLink && <a href={pointsLink.url} target="_blank" rel="noopener noreferrer" className="bh-btn bh-btn-outline px-4 py-2.5"><ExternalLink className="w-4 h-4" />報酬／點數確認區</a>}
                </div>
                {showSubmitSuccess && <SubmitSuccess onClose={() => setShowSubmitSuccess(false)} />}
                <div role="alert" className="bh-card bg-bauhaus-red text-white p-5">
                    <div className="font-black">{loadError}</div>
                    <button type="button" onClick={load} className="bh-btn bg-white text-bauhaus-black px-4 py-2.5 mt-4">
                        <RefreshCw className="w-4 h-4" />重新載入
                    </button>
                </div>
                <LegacySalaryLinks links={salaryLinks} />
            </div>
        );
    }

    if (!summary) {
        return (
            <div className="p-4 sm:p-8 max-w-3xl mx-auto">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
                    <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">我的報酬</h1>
                    {pointsLink && <a href={pointsLink.url} target="_blank" rel="noopener noreferrer" className="bh-btn bh-btn-outline px-4 py-2.5"><ExternalLink className="w-4 h-4" />報酬／點數確認區</a>}
                </div>
                {showSubmitSuccess && <SubmitSuccess onClose={() => setShowSubmitSuccess(false)} />}
                <div className="bh-card py-16 px-6 text-center">
                    <div className="w-16 h-16 border-2 border-bauhaus-black bg-bauhaus-muted rounded-full flex items-center justify-center mx-auto mb-4">
                        <Wallet className="w-8 h-8 text-bauhaus-black/40" />
                    </div>
                    <h2 className="text-xl font-black text-bauhaus-black">還沒有薪資紀錄</h2>
                    <p className="text-bauhaus-black/60 mt-2 text-sm font-medium">完成接課後登記課程回報，你的鐘點與獎金就會顯示在這裡。</p>
                    <Link
                        to="/my/salary/new"
                        className="bh-btn bh-btn-blue mt-6 min-h-[44px] px-6"
                    >
                        <Plus className="w-4 h-4" /> 登記課程回報
                    </Link>
                </div>
                <LegacySalaryLinks links={salaryLinks} />
            </div>
        );
    }

    const fmt = (n) => `$${Math.round(Number(n || 0)).toLocaleString()}`;
    const fmtHr = (n) => `${Number(n || 0).toFixed(1)} 小時`;

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">我的報酬</h1>
                    <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">{summary.full_name}・每堂課只需回報一次</p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                    {pointsLink && (
                        <a href={pointsLink.url} target="_blank" rel="noopener noreferrer"
                            className="bh-btn bh-btn-outline px-4 py-2.5 w-full sm:w-auto">
                            <ExternalLink className="w-4 h-4" />報酬／點數確認區
                        </a>
                    )}
                    <Link to="/my/salary/new"
                        className="bh-btn bh-btn-blue px-4 py-2.5 w-full sm:w-auto">
                        <Plus className="w-4 h-4" />登記課程回報
                    </Link>
                </div>
            </div>

            {showSubmitSuccess && <SubmitSuccess onClose={() => setShowSubmitSuccess(false)} />}

            {needsReviewCount > 0 && (
                <div className="mb-6 bg-bauhaus-yellow/30 border-2 border-bauhaus-black rounded-xl p-4 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                    <div className="text-sm text-bauhaus-black">
                        <div className="font-black">有 {needsReviewCount} 筆回報正在等待管理員核薪</div>
                        <div className="text-xs mt-1 text-bauhaus-black/70">這些紀錄不會顯示成 0 元；確認資格或規則後才會納入薪資金額。</div>
                    </div>
                </div>
            )}
            {rejectedCount > 0 && (
                <div className="mb-6 bg-bauhaus-red/10 border-2 border-bauhaus-red rounded-xl p-4 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 shrink-0 mt-0.5 text-bauhaus-red" />
                    <div className="text-sm text-bauhaus-black">
                        <div className="font-black">有 {rejectedCount} 筆回報被退回</div>
                        <div className="text-xs mt-1 text-bauhaus-black/70">請查看紀錄備註，修正後再重新回報。</div>
                    </div>
                </div>
            )}

            {/* 主要數字:本月 + 累計 + 應領未領 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <BigStat
                    icon={Calendar}
                    label="本月薪資"
                    value={fmt(summary.this_month_salary)}
                    sub={`${summary.this_month_sessions} 場`}
                    tone="blue"
                />
                <BigStat
                    icon={TrendingUp}
                    label="今年累計"
                    value={fmt(summary.this_year_salary)}
                    tone="black"
                />
                <BigStat
                    icon={Wallet}
                    label="未領金額"
                    value={fmt(summary.total_unpaid)}
                    sub={`已領 ${fmt(summary.total_paid)}`}
                    tone="yellow"
                />
            </div>

            {/* 細項:累計 + 三狀態分桶 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                <MiniStat label="累計總薪資" value={fmt(summary.total_salary)} />
                <MiniStat label="總場次" value={summary.total_sessions} sub={fmtHr(summary.total_hours)} />
                <MiniStat label="待核准" value={fmt(summary.pending_salary)} accent="yellow" />
                <MiniStat label="已核准未付" value={fmt(summary.approved_unpaid_salary)} accent="blue" />
            </div>

            {/* 月份明細 */}
            <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                    <h2 className="text-lg font-black text-bauhaus-black">月份明細</h2>
                    <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)}
                        className="text-sm px-3 py-2 border-2 border-bauhaus-black rounded-xl bg-white font-bold outline-none focus:ring-2 focus:ring-bauhaus-blue">
                        <option value="">全部月份</option>
                        {months.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </div>

                {!monthFilter && monthlyStats.length > 0 && (
                    <div className="bh-card mb-6 overflow-hidden">
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x-2 divide-bauhaus-black/20 text-center">
                            {monthlyStats.slice(0, 6).map(m => (
                                <button
                                    type="button"
                                    key={m.month}
                                    onClick={() => setMonthFilter(m.month)}
                                    className="p-3 hover:bg-bauhaus-cream transition-colors duration-200"
                                >
                                    <div className="text-xs text-bauhaus-black/50 font-bold">{m.month}</div>
                                    <div className="text-lg font-black text-bauhaus-black mt-1 tabular-nums">{fmt(m.total)}</div>
                                    <div className="text-xs text-bauhaus-black/50">{m.count} 場</div>
                                </button>
                            ))}
                        </div>
                    </div>
                )}

                {/* 課程紀錄列表 */}
                <div className="bh-card overflow-hidden">
                    {/* 手機版：卡片列表 */}
                    <div className="md:hidden divide-y-2 divide-bauhaus-black/20">
                        {filtered.slice(0, 100).map(s => (
                            <div key={s.id} className="p-4">
                                <div className="flex items-start justify-between gap-2">
                                    <div>
                                        <div className="text-sm font-bold text-bauhaus-black">{s.session_date}</div>
                                        <div className="text-sm text-bauhaus-black/80 mt-0.5">{COURSE_LABELS[s.course_type] || s.course_type}</div>
                                        {s.course_name && <div className="text-xs text-bauhaus-black/50 mt-0.5">{s.course_name}</div>}
                                        {s.pricing_status === 'rejected' && s.pricing_message && <div className="text-xs text-bauhaus-red mt-1">{s.pricing_message}</div>}
                                    </div>
                                    <span className={`bh-chip shrink-0 ${s.pricing_status === 'rejected' ? 'bg-bauhaus-red text-white' : (STATUS_COLORS[s.status] || 'bg-bauhaus-muted text-bauhaus-black')}`}>
                                        {s.pricing_status === 'rejected' ? '已退回' : (STATUS_LABELS[s.status] || s.status)}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between mt-3 pt-3 border-t-2 border-bauhaus-black/10">
                                    <span className="text-xs text-bauhaus-black/50">
                                        {s.duration_hours ? `${s.duration_hours}h` : '–'}
                                        {s.student_count ? ` / ${s.student_count}人` : ''}
                                    </span>
                                    <span className="text-base font-bold text-bauhaus-black tabular-nums">
                                        {s.pricing_status === 'rejected' ? '已退回' : (s.pricing_status === 'needs_review' ? '待核薪' : fmt(s.total_salary))}
                                    </span>
                                </div>
                            </div>
                        ))}
                        {filtered.length === 0 && (
                            <div className="px-4 py-12 text-center text-bauhaus-black/40 font-medium">這個月還沒有薪資紀錄</div>
                        )}
                    </div>

                    {/* 桌面版：表格 */}
                    <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-bauhaus-black text-white text-xs uppercase tracking-wider">
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
                            <tbody className="divide-y-2 divide-bauhaus-black/20">
                                {filtered.slice(0, 100).map(s => (
                                    <tr key={s.id} className="hover:bg-bauhaus-cream transition-colors duration-200">
                                        <td className="px-4 py-3 text-bauhaus-black/80">{s.session_date}</td>
                                        <td className="px-4 py-3">
                                            <div className="text-bauhaus-black/80">{COURSE_LABELS[s.course_type] || s.course_type}</div>
                                            {s.course_name && <div className="text-xs text-bauhaus-black/50">{s.course_name}</div>}
                                            {s.pricing_status === 'rejected' && s.pricing_message && <div className="text-xs text-bauhaus-red">{s.pricing_message}</div>}
                                        </td>
                                        <td className="px-4 py-3 text-right text-bauhaus-black/60 text-xs">
                                            {s.duration_hours ? `${s.duration_hours}h` : '–'}
                                            {s.student_count ? ` / ${s.student_count}人` : ''}
                                        </td>
                                        <td className="px-4 py-3 text-right text-bauhaus-black/80">
                                            {s.pricing_status === 'rejected' ? '已退回' : (s.pricing_status === 'needs_review' ? '待核薪' : (s.base_salary !== null ? fmt(s.base_salary) : '–'))}
                                        </td>
                                        <td className="px-4 py-3 text-right text-bauhaus-black/80">
                                            {s.bonus > 0 ? fmt(s.bonus) : '–'}
                                        </td>
                                        <td className="px-4 py-3 text-right font-bold text-bauhaus-black tabular-nums">
                                            {s.pricing_status === 'rejected' ? '已退回' : (s.pricing_status === 'needs_review' ? '待核薪' : fmt(s.total_salary))}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className={`bh-chip ${s.pricing_status === 'rejected' ? 'bg-bauhaus-red text-white' : (STATUS_COLORS[s.status] || 'bg-bauhaus-muted text-bauhaus-black')}`}>
                                                {s.pricing_status === 'rejected' ? '已退回' : (STATUS_LABELS[s.status] || s.status)}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                                {filtered.length === 0 && (
                                    <tr><td colSpan={7} className="px-4 py-12 text-center text-bauhaus-black/40 font-medium">這個月還沒有薪資紀錄</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <LegacySalaryLinks links={salaryLinks} />
        </div>
    );
};

const SubmitSuccess = ({ onClose }) => (
    <div role="status" className="mb-6 bg-bauhaus-blue text-white border-2 lg:border-4 border-bauhaus-black rounded-xl px-4 py-3 flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
        <div className="font-bold flex-1">課程回報已送出，管理員核薪後會更新狀態。</div>
        <button type="button" onClick={onClose} className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl hover:bg-white/15" aria-label="關閉成功提示">
            <X className="w-4 h-4" aria-hidden="true" />
        </button>
    </div>
);

const TONE_STYLES = {
    blue:   { bg: 'bg-bauhaus-blue',   text: 'text-white',           sub: 'text-white/80' },
    black:  { bg: 'bg-bauhaus-black',  text: 'text-white',           sub: 'text-white/60' },
    yellow: { bg: 'bg-bauhaus-yellow', text: 'text-bauhaus-black',   sub: 'text-bauhaus-black/70' },
};

const BigStat = ({ icon, label, value, sub, tone }) => {
    const Icon = icon;
    const t = TONE_STYLES[tone] || TONE_STYLES.black;
    return (
    <div className={`${t.bg} border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard lg:shadow-hard-lg p-5`}>
        <div className={`flex items-center gap-2 text-sm font-bold uppercase tracking-wide ${t.sub}`}>
            <Icon className="w-4 h-4" /> {label}
        </div>
        <div className={`text-3xl font-black mt-2 tabular-nums ${t.text}`}>{value}</div>
        {sub && <div className={`text-xs mt-1 ${t.sub}`}>{sub}</div>}
    </div>
    );
};

const MiniStat = ({ label, value, sub, accent }) => (
    <div className="bh-card p-3">
        <div className="flex items-center gap-1.5">
            {accent && <span className={`w-2 h-2 shrink-0 ${accent === 'yellow' ? 'bg-bauhaus-yellow' : 'bg-bauhaus-blue'}`} aria-hidden="true" />}
            <div className="text-xs text-bauhaus-black/50 font-bold uppercase tracking-wide">{label}</div>
        </div>
        <div className="text-lg font-black mt-1 text-bauhaus-black tabular-nums">{value}</div>
        {sub && <div className="text-xs text-bauhaus-black/40 mt-0.5">{sub}</div>}
    </div>
);

export default MySalary;
