import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Wallet, TrendingUp, Calendar, AlertCircle, Plus, ExternalLink, ChevronDown, RefreshCw, CheckCircle2, X, ClipboardCheck } from 'lucide-react';
import { TERM_PERIOD_LABELS, courseCategoryConfig, courseCategoryFor, reportChannelFor, reportItemLabel } from '../lib/constants';
import { isSafeHttpUrl } from '../lib/siteLinks';
import { taipeiToday } from '../lib/salary';
import { monthNameOf, payoutScheduleFromResponse, resolvePayout, shortDateOf, summarizePayrollPeriod } from '../lib/salaryPayday';

const STATUS_LABELS = { pending: '待核准', approved: '已核准', paid: '已付款' };
const STATUS_COLORS = {
    pending:  'bg-bauhaus-yellow text-bauhaus-black',
    approved: 'bg-bauhaus-muted text-bauhaus-black',
    paid:     'bg-bauhaus-blue text-white',
};

// 報酬確認區：對照業主「回報查詢表」試算表的「登記查詢表」分頁（2026-10-20 業主要求搬進站內）。
// 試算表分「合作單位」「直營課程」兩區、各寫提問窗口；站內多一區「其他課程」放兩份表單都沒有的課，有紀錄才顯示。
const CONFIRM_GROUPS = [
    { key: 'b2b', title: '合作單位課程', note: '補習班、學校社團、講座', contact: 'SEP', nameHeader: '單位' },
    { key: 'b2c', title: '直營課程', note: '體驗課、營隊、到府、速解', contact: '芳儒', nameHeader: '課程名稱' },
    // 薪資總表匯入時原課程種類「其他」「徵稿」等雜項轉成 course_type='other'（scripts/salary_master_import/build_upload_csv.py），歸這區；
    // 楓葉體驗課由 08_reclassify_maple_trial.sql 改成 trial（業主 2026-10-20 選方案 A），總表裡沒有學校社團
    { key: 'other', title: '其他課程', note: '常態課、幼兒啟蒙、速解培訓、站櫃／擺攤，以及薪資總表裡登記為「其他」的課', contact: null, nameHeader: '課程名稱', hideWhenEmpty: true },
];
const CONFIRM_PAGE_SIZE = 50;

const fmt = (n) => `$${Math.round(Number(n || 0)).toLocaleString()}`;

// 一筆課程在確認區顯示的名稱與課程類型。
// 合作課的單位：站內回報存在 unit_name；薪資總表匯入的舊資料沒有 unit_name，單位寫在 course_name。
const confirmRowOf = (session) => {
    const channel = reportChannelFor(session.course_type);
    const category = courseCategoryConfig(courseCategoryFor(session.course_type));
    if (channel === 'b2b') {
        return {
            channel,
            name: session.unit_name || session.course_name || '–',
            type: reportItemLabel(session.course_type),
            typeSub: TERM_PERIOD_LABELS[session.term_period] || '',
        };
    }
    // 同一類有多個報酬項目（到府、常態課、營隊）→ 主標用表單上的課程類型、副標寫報酬項目；「其他」類直接寫項目名稱。
    // 營隊的項目文字照表單問法是「否（一般講師）」「是（5 日營負責人）」，離開題目就看不懂，只留括號內文字。
    const grouped = category && category.key !== 'misc';
    const type = grouped ? category.label : reportItemLabel(session.course_type);
    const item = reportItemLabel(session.course_type).replace(/^[是否]（(.+)）$/, '$1');
    return {
        channel,
        name: session.course_name || session.unit_name || '–',
        type,
        typeSub: grouped && category.types.length > 1 && item !== type ? item : '',
    };
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
                console.error('讀取報酬表單連結失敗,使用預設值：', error.message);
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
    // 後台設定的匯款日（supabase/migrations/20261020160000_salary_payout_schedule.sql）；讀不到就用每月 10 號
    const [payoutSchedule, setPayoutSchedule] = useState({ nextPayday: null, regularDay: null, failed: false });
    const payout = resolvePayout(payoutSchedule, taipeiToday());

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        // 先取自己的彙總(依 user_id 篩出本人的講師主檔)，清單再用它的 instructor_id 限定本人：
        // 管理員／輔導員的 RLS 可讀全部報酬紀錄，清單若不帶本人條件，會變成全體講師最近 1000 筆。
        // 匯款日設定一起讀，「重新載入」時也會重讀。
        const [sumRes, scheduleRes] = await Promise.all([
            supabase.from('instructor_salary_summary').select('*').eq('user_id', user.id).maybeSingle(),
            supabase.from('salary_payout_schedule').select('next_payday, regular_day').maybeSingle(),
        ]);
        const schedule = payoutScheduleFromResponse(scheduleRes);
        if (schedule.failed) console.warn('讀取匯款日設定失敗，先以每月 10 號預估：', scheduleRes.error?.message);
        setPayoutSchedule(schedule);
        if (sumRes.error) {
            setLoadError('報酬資料暫時無法載入，請稍後再試。');
            setLoading(false);
            return;
        }
        const ownInstructorId = sumRes.data?.instructor_id;
        if (!ownInstructorId) {
            // 沒有講師主檔：沒有本人的紀錄，不送不帶條件的清單查詢
            setSummary(sumRes.data);
            setSessions([]);
            setLoading(false);
            return;
        }
        const sessRes = await supabase.from('class_sessions').select('*')
            .eq('instructor_id', ownInstructorId)
            .order('session_date', { ascending: false }).limit(1000);
        if (sessRes.error) {
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
    const confirmGroups = useMemo(() => {
        const grouped = { b2b: [], b2c: [], other: [] };
        for (const session of filtered) {
            const row = { session, ...confirmRowOf(session) };
            (grouped[row.channel] || grouped.other).push(row);
        }
        return grouped;
    }, [filtered]);
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

    // 下次匯款日匯的那一期（例：12/10 匯 11 月＝10/26～11/25）
    const payroll = summarizePayrollPeriod(sessions, payout);

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    if (loadError) {
        return (
            <div className="p-4 sm:p-8 max-w-3xl mx-auto">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-6">
                    <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">我的報酬</h1>
                    {pointsLink && <a href={pointsLink.url} target="_blank" rel="noopener noreferrer" className="bh-btn bh-btn-outline px-4 py-2.5"><ExternalLink className="w-4 h-4" />報酬／點數試算表</a>}
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
                    {pointsLink && <a href={pointsLink.url} target="_blank" rel="noopener noreferrer" className="bh-btn bh-btn-outline px-4 py-2.5"><ExternalLink className="w-4 h-4" />報酬／點數試算表</a>}
                </div>
                {showSubmitSuccess && <SubmitSuccess onClose={() => setShowSubmitSuccess(false)} />}
                <div className="bh-card py-16 px-6 text-center">
                    <div className="w-16 h-16 border-2 border-bauhaus-black bg-bauhaus-muted rounded-full flex items-center justify-center mx-auto mb-4">
                        <Wallet className="w-8 h-8 text-bauhaus-black/40" />
                    </div>
                    <h2 className="text-xl font-black text-bauhaus-black">還沒有報酬紀錄</h2>
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

    const fmtHr = (n) => `${Number(n || 0).toFixed(1)} 小時`;
    const scrollToConfirm = () => {
        document.getElementById('compensation-confirm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">我的報酬</h1>
                    <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">{summary.full_name}・每堂課只需回報一次</p>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                    <button type="button" onClick={scrollToConfirm}
                        className="bh-btn bh-btn-outline px-4 py-2.5 w-full sm:w-auto">
                        <ClipboardCheck className="w-4 h-4" aria-hidden="true" />報酬確認區
                    </button>
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
                        <div className="font-black">有 {needsReviewCount} 筆回報正在等待管理員核准</div>
                        <div className="text-xs mt-1 text-bauhaus-black/70">這些紀錄不會顯示成 0 元；確認資格或規則後才會納入報酬金額。</div>
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

            {/* 主要數字:本月 + 今年 + 下次匯款日要匯的那個月 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
                <BigStat
                    icon={Calendar}
                    label="本月報酬"
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
                    label={`${monthNameOf(payout.periodMonth)}累計報酬`}
                    value={fmt(payroll.total)}
                    badge={`${shortDateOf(payout.payday)} 匯款${payoutSchedule.failed ? '（預估）' : ''}`}
                    sub={[
                        `${shortDateOf(payout.periodStart)}～${shortDateOf(payout.periodEnd)}`,
                        `${payroll.count} 場`,
                        payroll.pendingTotal > 0 ? `含待核准 ${fmt(payroll.pendingTotal)}` : '',
                        payroll.awaitingPriceCount > 0 ? `${payroll.awaitingPriceCount} 筆待確認金額` : '',
                    ].filter(Boolean).join('・')}
                    tone="yellow"
                />
            </div>

            {/* 細項:累計 + 待核准 + 已匯款 */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
                <MiniStat label="累計總報酬" value={fmt(summary.total_salary)} />
                <MiniStat label="總場次" value={summary.total_sessions} sub={fmtHr(summary.total_hours)} />
                <MiniStat label="待核准" value={fmt(summary.pending_salary)} accent="yellow" />
                <MiniStat label="已匯款" value={fmt(summary.paid_salary)} accent="blue" />
            </div>

            {/* 報酬確認區（原「月份明細」）：照試算表「登記查詢表」分合作單位／直營課程列出自己的每筆課程 */}
            <section id="compensation-confirm" aria-labelledby="compensation-confirm-title" className="mb-6 scroll-mt-24">
                <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
                    <h2 id="compensation-confirm-title" className="text-lg font-black text-bauhaus-black">報酬確認區</h2>
                    <select value={monthFilter} onChange={e => setMonthFilter(e.target.value)} aria-label="篩選月份"
                        className="text-sm min-h-[44px] px-3 py-2 border-2 border-bauhaus-black rounded-xl bg-white font-bold outline-none focus:ring-2 focus:ring-bauhaus-blue">
                        <option value="">全部月份</option>
                        {months.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                </div>
                <p className="text-sm text-bauhaus-black/70 mb-1 font-medium">核對你回報的每一堂課有沒有漏報、填錯；有問題請找各區標示的窗口。</p>
                <p className="text-xs text-bauhaus-black/60 mb-4">目前只顯示 2026 年 1 月起的課程紀錄；更早的紀錄整理中，有疑問請洽課程派發窗口。</p>

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

                <div className="space-y-6">
                    {CONFIRM_GROUPS.map(group => {
                        const rows = confirmGroups[group.key] || [];
                        if (group.hideWhenEmpty && rows.length === 0) return null;
                        return <ConfirmGroup key={`${group.key}-${monthFilter}`} group={group} rows={rows} />;
                    })}
                </div>

                {pointsLink && (
                    <p className="text-sm text-bauhaus-black/70 mt-4 font-medium">
                        用舊 Google 表單回報的課，以及教學點數／非教學點數，請到
                        <a href={pointsLink.url} target="_blank" rel="noopener noreferrer"
                            className="font-black underline inline-flex items-center gap-1 min-h-[44px] px-1 text-bauhaus-black">
                            報酬／點數試算表<ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                        </a>
                        查詢。
                    </p>
                )}
            </section>

            <LegacySalaryLinks links={salaryLinks} />
        </div>
    );
};

const isRejected = (session) => session.pricing_status === 'rejected';

const StatusChip = ({ session }) => (
    <span className={`bh-chip shrink-0 whitespace-nowrap ${isRejected(session) ? 'bg-bauhaus-red text-white' : (STATUS_COLORS[session.status] || 'bg-bauhaus-muted text-bauhaus-black')}`}>
        {isRejected(session) ? '已退回' : (STATUS_LABELS[session.status] || session.status)}
    </span>
);

const amountText = (session) => {
    if (isRejected(session)) return '已退回';
    if (session.pricing_status === 'needs_review') return '待核准';
    return fmt(session.total_salary);
};

const ConfirmGroup = ({ group, rows }) => {
    const [expanded, setExpanded] = useState(false);
    const visible = expanded ? rows : rows.slice(0, CONFIRM_PAGE_SIZE);
    const titleId = `confirm-${group.key}-title`;
    const emptyText = `這段期間沒有${group.title}紀錄`;
    return (
        <div className="bh-card overflow-hidden" role="region" aria-labelledby={titleId}>
            <div className="bg-bauhaus-black text-white px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                    <h3 id={titleId} className="font-black">
                        {group.title}<span className="ml-2 text-sm font-bold text-white/70 tabular-nums">{rows.length} 筆</span>
                    </h3>
                    <p className="text-xs text-white/70 mt-0.5">{group.note}</p>
                </div>
                <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black whitespace-nowrap">
                    {group.contact ? `有問題找 ${group.contact}` : '有問題請洽課程派發窗口'}
                </span>
            </div>

            {/* 手機版：卡片 */}
            <ul className="md:hidden divide-y-2 divide-bauhaus-black/20">
                {visible.map(({ session, name, type, typeSub }) => (
                    <li key={session.id} className="p-4">
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                                <div className="text-xs font-bold text-bauhaus-black/60 tabular-nums">{session.session_date}</div>
                                <div className="text-sm font-bold text-bauhaus-black mt-0.5 break-words">{name}</div>
                                <div className="text-xs text-bauhaus-black/60 mt-0.5">{typeSub ? `${type}・${typeSub}` : type}</div>
                                {isRejected(session) && session.pricing_message && <div className="text-sm font-bold text-bauhaus-red mt-1">{session.pricing_message}</div>}
                            </div>
                            <StatusChip session={session} />
                        </div>
                        <div className="flex items-center justify-between mt-3 pt-3 border-t-2 border-bauhaus-black/10">
                            <span className="text-xs text-bauhaus-black/60">
                                {[session.student_count ? `${session.student_count} 人` : '', session.duration_hours ? `${session.duration_hours} 小時` : '']
                                    .filter(Boolean).join('・') || '–'}
                            </span>
                            <span className="text-base font-bold text-bauhaus-black tabular-nums">{amountText(session)}</span>
                        </div>
                    </li>
                ))}
                {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-bauhaus-black/40 font-medium">{emptyText}</li>}
            </ul>

            {/* 桌面版：表格（欄位順序對照試算表：日期、單位／課程名稱、課程類型、人數） */}
            <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm lg:table-fixed">
                    <thead className="bg-bauhaus-cream text-bauhaus-black text-xs font-black border-b-2 border-bauhaus-black">
                        <tr>
                            <th scope="col" className="px-4 py-2.5 text-left whitespace-nowrap lg:w-32">上課日期</th>
                            <th scope="col" className="px-4 py-2.5 text-left">{group.nameHeader}</th>
                            <th scope="col" className="px-4 py-2.5 text-left lg:w-56">課程類型</th>
                            <th scope="col" className="px-4 py-2.5 text-right whitespace-nowrap lg:w-24">上課人數</th>
                            <th scope="col" className="px-4 py-2.5 text-right whitespace-nowrap lg:w-20">時數</th>
                            <th scope="col" className="px-4 py-2.5 text-right whitespace-nowrap lg:w-32">報酬</th>
                            <th scope="col" className="px-4 py-2.5 text-left whitespace-nowrap lg:w-28">狀態</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-bauhaus-black/10">
                        {visible.map(({ session, name, type, typeSub }) => (
                            <tr key={session.id} className="hover:bg-bauhaus-cream transition-colors duration-200 align-top">
                                <td className="px-4 py-3 text-bauhaus-black/80 whitespace-nowrap tabular-nums">{session.session_date}</td>
                                <td className="px-4 py-3">
                                    <div className="font-bold text-bauhaus-black break-words">{name}</div>
                                    {isRejected(session) && session.pricing_message && <div className="text-sm font-bold text-bauhaus-red mt-0.5">{session.pricing_message}</div>}
                                </td>
                                <td className="px-4 py-3">
                                    <div className="text-bauhaus-black/80">{type}</div>
                                    {typeSub && <div className="text-xs text-bauhaus-black/50">{typeSub}</div>}
                                </td>
                                <td className="px-4 py-3 text-right text-bauhaus-black/80 tabular-nums whitespace-nowrap">{session.student_count ?? '–'}</td>
                                <td className="px-4 py-3 text-right text-bauhaus-black/80 tabular-nums whitespace-nowrap">{session.duration_hours ?? '–'}</td>
                                <td className="px-4 py-3 text-right font-bold text-bauhaus-black tabular-nums whitespace-nowrap">
                                    {amountText(session)}
                                    {!isRejected(session) && session.pricing_status !== 'needs_review' && Number(session.bonus) > 0 && (
                                        <div className="text-xs font-medium text-bauhaus-black/50">含獎金 {fmt(session.bonus)}</div>
                                    )}
                                </td>
                                <td className="px-4 py-3"><StatusChip session={session} /></td>
                            </tr>
                        ))}
                        {rows.length === 0 && (
                            <tr><td colSpan={7} className="px-4 py-8 text-center text-bauhaus-black/40 font-medium">{emptyText}</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {rows.length > CONFIRM_PAGE_SIZE && (
                <div className="border-t-2 border-bauhaus-black/10 p-3 text-center">
                    <button type="button" onClick={() => setExpanded(value => !value)}
                        className="bh-btn bh-btn-outline min-h-[44px] px-4 py-2">
                        {expanded ? `收合，只顯示最近 ${CONFIRM_PAGE_SIZE} 筆` : `顯示全部 ${rows.length} 筆`}
                    </button>
                </div>
            )}
        </div>
    );
};

const SubmitSuccess = ({ onClose }) => (
    <div role="status" className="mb-6 bg-bauhaus-blue text-white border-2 lg:border-4 border-bauhaus-black rounded-xl px-4 py-3 flex items-center gap-3">
        <CheckCircle2 className="w-5 h-5 shrink-0" aria-hidden="true" />
        <div className="font-bold flex-1">課程回報已送出，管理員核准後會更新狀態。</div>
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

const BigStat = ({ icon, label, value, sub, tone, badge }) => {
    const Icon = icon;
    const t = TONE_STYLES[tone] || TONE_STYLES.black;
    return (
    <div className={`${t.bg} border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard lg:shadow-hard-lg p-5`}>
        <div className="flex items-start justify-between gap-2">
            <div className={`flex items-center gap-2 text-sm font-bold uppercase tracking-wide ${t.sub}`}>
                <Icon className="w-4 h-4" /> {label}
            </div>
            {badge && (
                <span className="shrink-0 rounded-full border-2 border-bauhaus-black bg-white px-2.5 py-0.5 text-xs font-black text-bauhaus-black tabular-nums">
                    {badge}
                </span>
            )}
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
