import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Award, BookOpen, ChevronRight, Compass, Layers3, Plus, Timer, Trophy, Wallet } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { taipeiToday } from '../lib/salary';
import { monthNameOf, payoutScheduleFromResponse, resolvePayout, shortDateOf, summarizePayrollPeriod } from '../lib/salaryPayday';
import { toHours } from '../lib/leaderboard';
import { fetchTeacherBadges } from '../lib/badges';
import { PERSONNEL_TYPE_LABELS, isInstructorPersonnel, normalizePersonnelTypes } from '../lib/constants';
import { OPEN_TOUR_EVENT } from '../lib/onboarding';
import BadgeVisual from '../components/BadgeVisual';
import ProfileAvatar from '../components/ProfileAvatar';

// 「關於我」總覽（業主 2026-10-21：我的課程／排行榜／我的報酬資訊不多，合成一頁 Dashboard）。
// 業主選「總覽＋保留明細」：這頁只放三塊摘要，完整內容仍在 /my/salary、/courses、/leaderboard（通知連結與書籤都不變）。
// 各區塊各自讀資料、各自顯示錯誤，一塊讀不到不影響其他塊。

const ROLE_LABELS = { admin: '管理員', mentor: '輔導員', teacher: '講師', pending: '待審核' };
const fmt = (n) => `$${Math.round(Number(n || 0)).toLocaleString()}`;
// 講師等級顯示文字（同個人資料頁）
const LEVEL_LABELS = { S: 'S 級', 'A+': 'A+ 級', A: 'A 級', B: 'B 級' };
const MAX_CATEGORY_ROWS = 4;
const MAX_BADGE_ICONS = 6;

// 讀本人的講師主檔：報酬清單與徽章都要用 instructor_id 限定本人
// （管理員／輔導員的 RLS 可讀全部，不帶本人條件會讀到全體講師）
const useOwnInstructor = (userId) => {
    const [state, setState] = useState({ loading: true, instructor: null, error: false });
    useEffect(() => {
        if (!userId) return undefined;
        let active = true;
        (async () => {
            let { data, error } = await supabase
                .from('instructors')
                .select('id, instructor_role, personnel_types')
                .eq('user_id', userId)
                .maybeSingle();
            // 資料庫還沒有人員類別欄位時退回舊查詢（全部當講師），畫面維持原樣
            if (error) {
                ({ data, error } = await supabase
                    .from('instructors')
                    .select('id, instructor_role')
                    .eq('user_id', userId)
                    .maybeSingle());
            }
            if (!active) return;
            if (error) console.error('讀取講師主檔失敗：', error.message);
            setState({ loading: false, instructor: data || null, error: Boolean(error) });
        })();
        return () => { active = false; };
    }, [userId]);
    return state;
};

const SectionError = ({ children, to, linkLabel }) => (
    <div role="alert" className="mt-4 rounded-xl border-2 border-bauhaus-red bg-bauhaus-red/10 p-4 text-sm font-bold text-bauhaus-black flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-bauhaus-red" aria-hidden="true" />
        <div>
            {children}
            {to && <Link to={to} className="ml-1 underline text-bauhaus-blue">{linkLabel}</Link>}
        </div>
    </div>
);

const SkeletonLines = ({ lines = 3 }) => (
    <div className="mt-4 space-y-3" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
            <div key={i} className={`h-4 rounded bg-bauhaus-muted animate-pulse ${i === 0 ? 'w-2/3' : 'w-full'}`} />
        ))}
    </div>
);

// ── 報酬：和「我的報酬」頁黃卡同一套算法（lib/salaryPayday.js），數字兩頁一致 ──
const SalarySummaryCard = ({ userId }) => {
    const [state, setState] = useState({ loading: true, error: false, summary: null, sessions: [], schedule: null });

    useEffect(() => {
        if (!userId) return undefined;
        let active = true;
        (async () => {
            const [sumRes, scheduleRes] = await Promise.all([
                supabase.from('instructor_salary_summary').select('*').eq('user_id', userId).maybeSingle(),
                supabase.from('salary_payout_schedule').select('next_payday, regular_day').maybeSingle(),
            ]);
            const schedule = payoutScheduleFromResponse(scheduleRes);
            if (sumRes.error) {
                if (active) setState({ loading: false, error: true, summary: null, sessions: [], schedule });
                return;
            }
            const instructorId = sumRes.data?.instructor_id;
            let sessions = [];
            if (instructorId) {
                const sessRes = await supabase.from('class_sessions')
                    .select('session_date, pricing_status, status, total_salary')
                    .eq('instructor_id', instructorId)
                    .order('session_date', { ascending: false }).limit(1000);
                if (sessRes.error) {
                    if (active) setState({ loading: false, error: true, summary: null, sessions: [], schedule });
                    return;
                }
                sessions = sessRes.data || [];
            }
            if (active) setState({ loading: false, error: false, summary: sumRes.data || null, sessions, schedule });
        })();
        return () => { active = false; };
    }, [userId]);

    const payout = resolvePayout(state.schedule || {}, taipeiToday());
    const payroll = summarizePayrollPeriod(state.sessions, payout);
    const needsReviewCount = state.sessions.filter(s => s.pricing_status === 'needs_review').length;
    const rejectedCount = state.sessions.filter(s => s.pricing_status === 'rejected').length;
    const hasRecords = Boolean(state.summary);

    return (
        <section
            aria-labelledby="about-salary-title"
            className="relative bg-bauhaus-yellow border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard lg:shadow-hard-lg p-5 sm:p-6"
            data-testid="about-salary"
        >
            <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5">
                <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h2 id="about-salary-title" className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-bauhaus-black">
                            <Wallet className="w-4 h-4" aria-hidden="true" />
                            {state.loading ? '本期' : monthNameOf(payout.periodMonth)}累計報酬
                        </h2>
                        {!state.loading && (
                            <span className="rounded-full border-2 border-bauhaus-black bg-white px-2.5 py-0.5 text-xs font-black text-bauhaus-black tabular-nums">
                                {shortDateOf(payout.payday)} 匯款{state.schedule?.failed ? '（預估）' : ''}
                            </span>
                        )}
                    </div>
                    {state.loading ? (
                        <div className="mt-3 h-10 w-40 rounded bg-white/60 animate-pulse" aria-label="報酬載入中" />
                    ) : (
                        <>
                            <div className="mt-2 text-4xl sm:text-5xl font-black text-bauhaus-black tabular-nums" data-testid="about-salary-total">
                                {state.error ? '—' : fmt(payroll.total)}
                            </div>
                            <p className="mt-2 text-sm font-bold text-bauhaus-black/80 text-balance">
                                {[
                                    `${shortDateOf(payout.periodStart)}～${shortDateOf(payout.periodEnd)}`,
                                    `${payroll.count} 場`,
                                    payroll.pendingTotal > 0 ? `含待核准 ${fmt(payroll.pendingTotal)}` : '',
                                    payroll.awaitingPriceCount > 0 ? `${payroll.awaitingPriceCount} 筆待確認金額` : '',
                                ].filter(Boolean).join('・')}
                            </p>
                            {hasRecords && !state.error && (
                                <p className="mt-1 text-sm font-bold text-bauhaus-black tabular-nums">
                                    今年累計 {fmt(state.summary.this_year_salary)}・總場次 {Number(state.summary.total_sessions || 0)}
                                </p>
                            )}
                        </>
                    )}
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto shrink-0">
                    <Link to="/my/salary/new" className="bh-btn bh-btn-blue px-5 py-3 min-h-[48px] w-full sm:w-auto">
                        <Plus className="w-4 h-4" aria-hidden="true" />登記課程回報
                    </Link>
                    <Link to="/my/salary" className="bh-btn bg-white text-bauhaus-black px-5 py-3 min-h-[48px] w-full sm:w-auto">
                        查看報酬明細<ChevronRight className="w-4 h-4" aria-hidden="true" />
                    </Link>
                </div>
            </div>

            {!state.loading && state.error && (
                <SectionError to="/my/salary" linkLabel="到「我的報酬」查看">報酬資料暫時無法載入，請稍後重新整理，或</SectionError>
            )}
            {!state.loading && !state.error && !hasRecords && (
                <p className="mt-4 rounded-xl border-2 border-bauhaus-black bg-white p-4 text-sm font-bold text-bauhaus-black">
                    還沒有報酬紀錄。完成接課後按「登記課程回報」，鐘點與獎金就會出現在這裡。
                </p>
            )}
            {!state.loading && !state.error && (needsReviewCount > 0 || rejectedCount > 0) && (
                <div className="mt-4 flex flex-col sm:flex-row gap-2">
                    {needsReviewCount > 0 && (
                        <Link to="/my/salary" className="flex items-center gap-2 rounded-xl border-2 border-bauhaus-black bg-white px-4 py-3 min-h-[44px] text-sm font-bold text-bauhaus-black hover:bg-bauhaus-cream">
                            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span className="text-balance">{needsReviewCount} 筆回報等待管理員核准</span>
                        </Link>
                    )}
                    {rejectedCount > 0 && (
                        <Link to="/my/salary" className="flex items-center gap-2 rounded-xl border-2 border-bauhaus-red bg-white px-4 py-3 min-h-[44px] text-sm font-bold text-bauhaus-black hover:bg-bauhaus-cream">
                            <AlertCircle className="w-4 h-4 shrink-0 text-bauhaus-red" aria-hidden="true" />
                            <span className="text-balance">{rejectedCount} 筆回報被退回，請查看備註後重新回報</span>
                        </Link>
                    )}
                </div>
            )}
        </section>
    );
};

// ── 我的課程：大分類＋課程數（看得到哪些由 RLS 依講師等級決定，與「我的課程」頁相同）──
const CoursesCard = ({ userId }) => {
    const [state, setState] = useState({ loading: true, error: false, categories: [], courses: [], completed: 0 });

    useEffect(() => {
        if (!userId) return undefined;
        let active = true;
        (async () => {
            const [catRes, courseRes, doneRes] = await Promise.all([
                supabase.from('course_categories').select('id, title').eq('is_published', true).order('order', { ascending: true }),
                supabase.from('courses').select('id, category_id').eq('is_published', true),
                supabase.from('course_training_status').select('id', { count: 'exact', head: true })
                    .eq('user_id', userId).eq('status', 'completed'),
            ]);
            if (!active) return;
            const error = catRes.error || courseRes.error;
            if (error) console.error('讀取課程摘要失敗：', error.message);
            setState({
                loading: false,
                error: Boolean(error),
                categories: catRes.data || [],
                courses: courseRes.data || [],
                completed: doneRes.error ? 0 : Number(doneRes.count || 0),
            });
        })();
        return () => { active = false; };
    }, [userId]);

    const countOf = (categoryId) => state.courses.filter(course => course.category_id === categoryId).length;
    const shown = state.categories.slice(0, MAX_CATEGORY_ROWS);

    return (
        <section aria-labelledby="about-courses-title" className="bh-card relative p-5 sm:p-6 flex flex-col" data-testid="about-courses">
            <span className="absolute top-4 right-4 w-4 h-4 bg-bauhaus-yellow" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} aria-hidden="true" />
            <div className="flex items-center gap-3">
                <div className="w-11 h-11 bg-bauhaus-red text-white border-2 border-bauhaus-black rounded-lg flex items-center justify-center shrink-0">
                    <BookOpen className="w-5 h-5" aria-hidden="true" />
                </div>
                <div>
                    <h2 id="about-courses-title" className="text-xl font-black text-bauhaus-black">我的課程</h2>
                    <p className="text-sm text-bauhaus-black/60 font-medium">依講師等級開放的培訓課程</p>
                </div>
            </div>

            {state.loading ? <SkeletonLines lines={4} /> : (
                <>
                    <dl className="mt-5 grid grid-cols-3 gap-2 text-center">
                        {[
                            ['培訓分類', state.categories.length],
                            ['課程', state.courses.length],
                            ['已完訓', state.completed],
                        ].map(([label, value]) => (
                            <div key={label} className="rounded-xl border-2 border-bauhaus-black bg-bauhaus-paper px-2 py-3">
                                <dt className="text-xs font-bold text-bauhaus-black/60">{label}</dt>
                                <dd className="text-2xl font-black text-bauhaus-black tabular-nums">{value}</dd>
                            </div>
                        ))}
                    </dl>
                    {state.error && <SectionError to="/courses" linkLabel="直接進入「我的課程」">課程資料暫時無法載入，</SectionError>}
                    {!state.error && shown.length > 0 && (
                        <ul className="mt-4 divide-y-2 divide-bauhaus-black/10 border-y-2 border-bauhaus-black/10">
                            {shown.map(category => (
                                <li key={category.id}>
                                    <Link
                                        to={`/courses?category=${category.id}`}
                                        className="group flex items-center gap-3 py-3 min-h-[48px] font-bold text-bauhaus-black hover:text-bauhaus-blue"
                                    >
                                        <Layers3 className="w-4 h-4 shrink-0 text-bauhaus-black/40" aria-hidden="true" />
                                        <span className="flex-1 min-w-0 truncate">{category.title}</span>
                                        <span className="text-xs font-black text-bauhaus-black/45 tabular-nums shrink-0">{countOf(category.id)} 門</span>
                                        <ChevronRight className="w-4 h-4 shrink-0 group-hover:translate-x-0.5 transition-transform" aria-hidden="true" />
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    )}
                    {!state.error && state.categories.length === 0 && (
                        <p className="mt-4 text-sm font-medium text-bauhaus-black/60">目前沒有開放給你的培訓分類。</p>
                    )}
                    {state.categories.length > MAX_CATEGORY_ROWS && (
                        <p className="mt-2 text-xs font-bold text-bauhaus-black/50">還有 {state.categories.length - MAX_CATEGORY_ROWS} 個分類，進入「我的課程」查看</p>
                    )}
                </>
            )}
            <div className="mt-auto pt-5">
                <Link to="/courses" className="bh-btn bh-btn-outline w-full px-5 py-3 min-h-[48px]">
                    進入我的課程<ChevronRight className="w-4 h-4" aria-hidden="true" />
                </Link>
            </div>
        </section>
    );
};

// ── 排名與成就：今年教學時數排名（同排行榜頁「教學時數／全部／時數」的排法）＋徽章 ──
const RankingCard = ({ userId, instructorState }) => {
    const year = Number(taipeiToday().slice(0, 4));
    const [rank, setRank] = useState({ loading: true, error: false, position: null, total: 0, mine: null });
    const [badges, setBadges] = useState({ loading: true, error: false, earned: [], total: 0 });

    useEffect(() => {
        if (!userId) return undefined;
        let active = true;
        (async () => {
            const { data, error } = await supabase.rpc('get_teaching_leaderboard_v2', { p_year: year, p_category: 'all' });
            if (!active) return;
            if (error) {
                console.error('讀取教學排名失敗：', error.message);
                setRank({ loading: false, error: true, position: null, total: 0, mine: null });
                return;
            }
            const sorted = [...(data || [])]
                .map(row => ({ ...row, value: toHours(row.total_hours) }))
                .sort((a, b) => (b.value - a.value) || (a.display_name || '').localeCompare(b.display_name || ''));
            const index = sorted.findIndex(row => row.user_id && row.user_id === userId);
            setRank({
                loading: false,
                error: false,
                position: index >= 0 ? index + 1 : null,
                total: sorted.length,
                mine: index >= 0 ? sorted[index] : null,
            });
        })();
        return () => { active = false; };
    }, [userId, year]);

    const instructorId = instructorState.instructor?.id;
    useEffect(() => {
        if (instructorState.loading) return undefined;
        let active = true;
        (async () => {
            if (!instructorId) {
                // 讀講師主檔失敗時不要說成「還沒綁定」
                if (active) setBadges({ loading: false, error: instructorState.error, earned: [], total: 0 });
                return;
            }
            const { badges: list, error } = await fetchTeacherBadges(supabase, instructorId);
            if (!active) return;
            if (error) console.error('讀取徽章失敗：', error.message || error);
            setBadges({ loading: false, error: Boolean(error), earned: list.filter(b => b.earned), total: list.length });
        })();
        return () => { active = false; };
    }, [instructorId, instructorState.loading, instructorState.error]);

    return (
        <section aria-labelledby="about-ranking-title" className="bh-card relative p-5 sm:p-6 flex flex-col" data-testid="about-ranking">
            <span className="absolute top-4 right-4 w-4 h-4 bg-bauhaus-blue" aria-hidden="true" />
            <div className="flex items-center gap-3">
                <div className="w-11 h-11 bg-bauhaus-blue text-white border-2 border-bauhaus-black rounded-lg flex items-center justify-center shrink-0">
                    <Trophy className="w-5 h-5" aria-hidden="true" />
                </div>
                <div>
                    <h2 id="about-ranking-title" className="text-xl font-black text-bauhaus-black">我的排名與成就</h2>
                    <p className="text-sm text-bauhaus-black/60 font-medium">{year} 年教學時數排名・徽章</p>
                </div>
            </div>

            <div className="mt-5 rounded-xl border-2 border-bauhaus-black bg-bauhaus-paper p-4" data-testid="about-rank">
                {rank.loading ? <SkeletonLines lines={2} /> : rank.error ? (
                    <p className="text-sm font-bold text-bauhaus-black/70">排名暫時無法載入，可到完整排行榜查看。</p>
                ) : rank.position ? (
                    <>
                        <div className="flex items-end justify-between gap-3 flex-wrap">
                            <div>
                                <div className="text-xs font-bold text-bauhaus-black/60">今年教學時數排名</div>
                                <div className="text-4xl font-black text-bauhaus-black tabular-nums">#{rank.position}</div>
                            </div>
                            <div className="text-sm font-bold text-bauhaus-black/70 tabular-nums">共 {rank.total} 位講師上榜</div>
                        </div>
                        <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                            {[
                                ['時數', `${rank.mine.value} 小時`],
                                ['場次', `${Number(rank.mine.session_count || 0)} 場`],
                                ['人次', `${Number(rank.mine.student_reach || 0)} 人次`],
                            ].map(([label, value]) => (
                                <div key={label} className="rounded-lg border-2 border-bauhaus-black bg-white px-2 py-2">
                                    <dt className="text-xs font-bold text-bauhaus-black/60">{label}</dt>
                                    <dd className="text-sm sm:text-base font-black text-bauhaus-black tabular-nums whitespace-nowrap">{value}</dd>
                                </div>
                            ))}
                        </dl>
                    </>
                ) : (
                    <p className="text-sm font-bold text-bauhaus-black/70">今年的排行榜上還沒有你的名次：可能還沒有登記過今年的課，或你的資料設定為不公開排名。</p>
                )}
            </div>

            <div className="mt-4" data-testid="about-badges">
                <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-sm font-black text-bauhaus-black">
                        <Award className="w-4 h-4" aria-hidden="true" />徽章
                    </div>
                    {!badges.loading && !badges.error && badges.total > 0 && (
                        <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black tabular-nums">{badges.earned.length} / {badges.total}</span>
                    )}
                </div>
                {badges.loading ? <SkeletonLines lines={1} /> : badges.error ? (
                    <p className="mt-2 text-sm font-medium text-bauhaus-black/60">徽章暫時無法載入。</p>
                ) : badges.earned.length > 0 ? (
                    <>
                        <ul className="mt-3 grid grid-cols-3 sm:grid-cols-6 lg:grid-cols-3 xl:grid-cols-6 gap-2">
                            {badges.earned.slice(0, MAX_BADGE_ICONS).map(badge => (
                                <li key={badge.key} className="flex flex-col items-center gap-1 text-center" title={badge.description || badge.name || ''}>
                                    <BadgeVisual badge={badge} size={44} />
                                    <span className="w-full text-xs font-bold text-bauhaus-black/80 leading-tight line-clamp-2">{badge.name}</span>
                                </li>
                            ))}
                        </ul>
                        <Link to="/profile" className="mt-1 text-sm font-bold text-bauhaus-blue underline min-h-[44px] inline-flex items-center">
                            看全部徽章（在個人資料頁）
                        </Link>
                    </>
                ) : (
                    <p className="mt-2 text-sm font-medium text-bauhaus-black/60">
                        {instructorId ? '還沒解鎖徽章，接課與比賽成績都會累積。' : '綁定講師資料後就會開始累積徽章。'}
                    </p>
                )}
            </div>

            <div className="mt-auto pt-5 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Link to={`/leaderboard?year=${year}`} className="bh-btn bh-btn-outline px-4 py-3 min-h-[48px]">
                    <Trophy className="w-4 h-4" aria-hidden="true" />完整排行榜
                </Link>
                <Link to="/cube" className="bh-btn bh-btn-outline px-4 py-3 min-h-[48px]">
                    <Timer className="w-4 h-4" aria-hidden="true" />方塊競速
                </Link>
            </div>
        </section>
    );
};

const AboutMe = () => {
    const { user, profile, instructorProfile, avatarUrl } = useAuth();
    const instructorState = useOwnInstructor(user?.id);
    const displayName = instructorProfile?.nickname || instructorProfile?.full_name || profile?.name || user?.email?.split('@')[0] || '';
    const level = instructorState.instructor?.instructor_role;
    // 純職員／工讀計時沒有講師等級：改顯示人員類別（舊資料沒有人員類別欄位時當作講師）
    const isInstructor = isInstructorPersonnel(instructorState.instructor?.personnel_types);
    const personnelLabel = normalizePersonnelTypes(instructorState.instructor?.personnel_types)
        .map(type => PERSONNEL_TYPE_LABELS[type] || type).join('・');

    return (
        <div className="p-4 sm:p-8 pb-12 sm:pb-12 max-w-6xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
                <div className="flex items-center gap-4 min-w-0">
                    <div className="w-16 h-16 rounded-full overflow-hidden border-2 border-bauhaus-black shrink-0">
                        <ProfileAvatar src={avatarUrl} alt="大頭貼" />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">關於我</h1>
                        <p className="text-bauhaus-black/60 font-medium truncate">嗨，{displayName}！這是你的講師總覽。</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                            <span className="bh-chip bg-bauhaus-black text-white">{ROLE_LABELS[profile?.role] || profile?.role}</span>
                            {isInstructor
                                ? level && <span className="bh-chip bg-white text-bauhaus-black">講師等級：{LEVEL_LABELS[level] || level}</span>
                                : instructorState.instructor && <span data-testid="about-personnel-types" className="bh-chip bg-white text-bauhaus-black">人員類別：{personnelLabel}</span>}
                        </div>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={() => window.dispatchEvent(new Event(OPEN_TOUR_EVENT))}
                    className="bh-btn bh-btn-ghost px-4 py-2.5 min-h-[44px] self-start sm:self-auto"
                >
                    <Compass className="w-4 h-4" aria-hidden="true" />重看導覽
                </button>
            </div>

            <SalarySummaryCard userId={user?.id} />

            <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
                <CoursesCard userId={user?.id} />
                <RankingCard userId={user?.id} instructorState={instructorState} />
            </div>
        </div>
    );
};

export default AboutMe;
