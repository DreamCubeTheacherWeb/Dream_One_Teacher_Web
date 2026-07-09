import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { AlertTriangle, Timer, Globe, Heart, Award } from 'lucide-react';
import LeaderboardView from '../components/LeaderboardView';
import { formatCubeTime } from '../lib/cubeEngine';
import { toHours } from '../lib/leaderboard';
import { wcaEventName, wcaMetric, WCA_ALLAROUND_METRIC } from '../lib/wca';

// 方塊競速排行榜的 metric 設定（重用 LeaderboardView，時間越短名次越前）。
const CUBE_METRIC = {
    label: '最快成績',
    unit: '',
    accent: 'blue',
    higherIsBetter: false,
    getValue: (r) => r.best_ms,
    format: (ms) => `${formatCubeTime(ms)}s`,
    championTitle: '殘影本人',
};

// 人氣互動排行榜的 metric 設定（被讚數越多名次越前；get_interaction_leaderboard）。
const INTERACTION_METRIC = {
    label: '被讚數',
    unit: '讚',
    accent: 'blue',
    higherIsBetter: true,
    getValue: (r) => r.likes_received || 0,
    championTitle: '講師界天花板',
};

// 教學時數第一排次選「範圍」：對應 get_teaching_leaderboard_v2 的 p_category
const TEACHING_SCOPES = [
    { key: 'all', label: '全部' },
    { key: 'big', label: '大班課' },
    { key: 'small', label: '小班課' },
    { key: 'online', label: '線上' },
    { key: 'speed', label: '速解' },
    { key: 'kids', label: '幼兒' },
];

// 教學時數第二排次選「依據」：同一份資料切換三個欄位，不重新呼叫 RPC
const TEACHING_BASES = [
    { key: 'hours', label: '時數' },
    { key: 'sessions', label: '場次' },
    { key: 'reach', label: '人次' },
];

// 教學排行榜第一名的冠軍稱號：依「範圍＋依據」對照，沒列到的組合就不顯示稱號
function teachingChampionTitle(scope, basis) {
    if (basis === 'hours') {
        if (scope === 'all') return '桃李之王';
        if (scope === 'big') return '百人斬';
        if (scope === 'small') return '到府刺客';
        return null;
    }
    if (scope === 'all' && basis === 'sessions') return '接課狂魔';
    if (scope === 'all' && basis === 'reach') return '人類導師';
    return null;
}

// 依「範圍＋依據」組出 LeaderboardView 用的 metric（同一份 rows 切換欄位，不重抓資料）
function buildTeachingMetric(scope, basis) {
    const championTitle = teachingChampionTitle(scope, basis);
    if (basis === 'sessions') {
        return { label: '接課場次', unit: '場', accent: 'blue', higherIsBetter: true, getValue: (r) => r.session_count || 0, championTitle };
    }
    if (basis === 'reach') {
        return { label: '接課人次', unit: '人次', accent: 'blue', higherIsBetter: true, getValue: (r) => r.student_reach || 0, championTitle };
    }
    return { label: '接課時數', unit: '小時', accent: 'blue', higherIsBetter: true, getValue: (r) => toHours(r.total_hours), championTitle };
}

const TabButton = ({ active, onClick, children }) => (
    <button
        type="button"
        onClick={onClick}
        className={`px-4 py-2.5 min-h-[44px] whitespace-nowrap text-sm font-bold uppercase tracking-wide transition-colors duration-200 ${
            active ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
        }`}
    >
        {children}
    </button>
);

// 次選 pill（視覺比頂層 tab 輕一階）：教學時數的範圍/依據、WCA 的單次/平均切換
const PillButton = ({ active, onClick, disabled, children }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`px-3.5 py-2.5 min-h-[44px] rounded-full text-sm font-bold border-2 transition-colors duration-200 ${
            disabled
                ? 'bg-bauhaus-muted text-bauhaus-black/30 border-bauhaus-black/10 cursor-not-allowed'
                : active
                    ? 'bg-bauhaus-blue text-white border-bauhaus-black'
                    : 'bg-white text-bauhaus-black border-bauhaus-black hover:bg-bauhaus-muted'
        }`}
    >
        {children}
    </button>
);

const LoadingSkeleton = () => (
    <div>
        <div className="h-40 rounded-2xl border-2 border-bauhaus-black/10 bg-bauhaus-muted animate-pulse mb-6" />
        <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
                <div key={i} className="h-16 rounded-xl border-2 border-bauhaus-black/10 bg-bauhaus-muted animate-pulse" />
            ))}
        </div>
    </div>
);

const ErrorState = ({ title = '排行榜載入失敗', desc = '請稍後再試，或重新整理頁面。' }) => (
    <div className="bg-white rounded-2xl border-2 lg:border-4 border-bauhaus-black shadow-hard py-16 text-center">
        <div className="w-16 h-16 bg-bauhaus-red/10 border-2 border-bauhaus-red rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-bauhaus-red" />
        </div>
        <h2 className="text-xl font-black text-bauhaus-black">{title}</h2>
        <p className="text-bauhaus-black/50 mt-2 text-sm">{desc}</p>
    </div>
);

const EmptyState = ({ icon, title, desc }) => {
    const Icon = icon || Timer;
    return (
        <div className="bg-white rounded-2xl border-2 lg:border-4 border-bauhaus-black shadow-hard py-16 text-center">
            <div className="w-16 h-16 bg-bauhaus-muted border-2 border-bauhaus-black rounded-full flex items-center justify-center mx-auto mb-4">
                <Icon className="w-8 h-8 text-bauhaus-black/40" />
            </div>
            <h2 className="text-xl font-black text-bauhaus-black">{title}</h2>
            <p className="text-bauhaus-black/50 mt-2 text-sm">{desc}</p>
        </div>
    );
};

// 頭像簽名 URL（沿用 instructor_uploads bucket，以 instructor_id 為鍵）
async function fetchAvatarMap(rows) {
    const withPhoto = rows.filter((r) => r.photo_path);
    if (withPhoto.length === 0) return {};
    const entries = await Promise.all(
        withPhoto.map(async (r) => {
            const { data: urlData } = await supabase.storage
                .from('instructor_uploads')
                .createSignedUrl(r.photo_path, 7200);
            return [r.instructor_id, urlData?.signedUrl || null];
        })
    );
    return Object.fromEntries(entries);
}

const Leaderboard = () => {
    const { user } = useAuth();
    const [tab, setTab] = useState('teaching'); // 'teaching' | 'cube' | 'wca' | 'interaction'

    // ── 教學時數 ──
    const [year, setYear] = useState(null); // null＝歷屆總榜
    const [years, setYears] = useState([]);
    const [category, setCategory] = useState('all'); // 範圍：all/big/small/online/speed/kids
    const [basis, setBasis] = useState('hours'); // 依據：hours/sessions/reach（不重抓，只換 metric）
    const [rows, setRows] = useState([]);
    const [avatarMap, setAvatarMap] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    // ── 方塊競速（獨立於教學排行榜，行為完全不變） ──
    const [cubeRows, setCubeRows] = useState([]);
    const [cubeState, setCubeState] = useState('loading'); // loading | ok | unavailable | error
    const [cubeMode, setCubeMode] = useState('virtual'); // 'virtual' | 'physical'

    // ── WCA 賽事 ──
    const [wcaMode, setWcaMode] = useState('event'); // 'event' | 'allaround'
    const [wcaEvents, setWcaEvents] = useState([]); // [{event_id, single_count, average_count}]
    const [wcaEventsState, setWcaEventsState] = useState('loading'); // loading | ok | unavailable | error
    const [wcaEvent, setWcaEvent] = useState(null);
    const [wcaType, setWcaType] = useState('single'); // 'single' | 'average'
    const [wcaRows, setWcaRows] = useState([]);
    const [wcaAvatarMap, setWcaAvatarMap] = useState({});
    const [wcaState, setWcaState] = useState('loading'); // loading | ok | error
    const [wcaAllaroundRows, setWcaAllaroundRows] = useState([]);
    const [wcaAllaroundAvatarMap, setWcaAllaroundAvatarMap] = useState({});
    const [wcaAllaroundState, setWcaAllaroundState] = useState('loading'); // loading | ok | error

    // ── 人氣互動 ──
    const [interactionRows, setInteractionRows] = useState([]);
    const [interactionAvatarMap, setInteractionAvatarMap] = useState({});
    const [interactionState, setInteractionState] = useState('loading'); // loading | ok | error

    const teachingMetric = useMemo(() => buildTeachingMetric(category, basis), [category, basis]);

    // 有接課資料的年份（一次載入，給年份切換器）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const { data } = await supabase.rpc('get_teaching_years');
            if (!cancelled && Array.isArray(data)) setYears(data.map((d) => d.yr));
        })();
        return () => { cancelled = true; };
    }, []);

    // 依年份＋範圍載入教學排行榜（「依據」只切換顯示欄位，不在此依賴陣列裡）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(false);
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_teaching_leaderboard_v2', { p_year: year, p_category: category });
                if (rpcErr) throw rpcErr;
                if (cancelled) return;
                const list = data || [];
                setRows(list);
                const map = await fetchAvatarMap(list);
                if (cancelled) return;
                setAvatarMap(map);
            } catch (err) {
                console.error('Leaderboard load failed:', err);
                if (!cancelled) setError(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [year, category]);

    // 方塊競速排行榜（依模式載入；RPC 尚未上線時顯示友善提示，不讓頁面爆掉）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setCubeState('loading');
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_cube_leaderboard', { p_mode: cubeMode });
                if (rpcErr) {
                    if (rpcErr.code === '42883' || rpcErr.code === '42P01') {
                        if (!cancelled) setCubeState('unavailable');
                        return;
                    }
                    throw rpcErr;
                }
                if (cancelled) return;
                setCubeRows((data || []).map((r) => ({
                    instructor_id: r.user_id, // 借用 LeaderboardView 既有的識別欄位
                    user_id: r.user_id,
                    display_name: r.display_name,
                    best_ms: r.best_ms,
                    solve_count: r.solve_count,
                })));
                setCubeState('ok');
            } catch (err) {
                console.error('Cube leaderboard load failed:', err);
                if (!cancelled) setCubeState('error');
            }
        })();
        return () => { cancelled = true; };
    }, [cubeMode]);

    // WCA 項目清單（一次載入；成績尚未匯入時 get_wca_events() 回空陣列，屬正常狀態）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setWcaEventsState('loading');
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_wca_events');
                if (rpcErr) {
                    if (rpcErr.code === '42883' || rpcErr.code === '42P01') {
                        if (!cancelled) setWcaEventsState('unavailable');
                        return;
                    }
                    throw rpcErr;
                }
                if (cancelled) return;
                const list = data || [];
                setWcaEvents(list);
                setWcaEventsState('ok');
                if (list.length > 0) {
                    // 預設看 3x3（333）——最常見的方塊；沒有 333 資料才退回第一個項目
                    const preferred = list.find((e) => e.event_id === '333') || list[0];
                    setWcaEvent(preferred.event_id);
                    setWcaType(preferred.single_count > 0 ? 'single' : 'average');
                }
            } catch (err) {
                console.error('WCA events load failed:', err);
                if (!cancelled) setWcaEventsState('error');
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // 換項目時，若目前選的 single/average 在新項目沒有成績，自動切到有資料的那個
    useEffect(() => {
        if (!wcaEvent) return;
        const ev = wcaEvents.find((e) => e.event_id === wcaEvent);
        if (!ev) return;
        if (wcaType === 'single' && !ev.single_count && ev.average_count) setWcaType('average');
        else if (wcaType === 'average' && !ev.average_count && ev.single_count) setWcaType('single');
    }, [wcaEvent, wcaEvents, wcaType]);

    // 依項目＋單次/平均載入 WCA 排行榜
    useEffect(() => {
        if (!wcaEvent) return;
        let cancelled = false;
        (async () => {
            setWcaState('loading');
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_wca_leaderboard', { p_event: wcaEvent, p_type: wcaType });
                if (rpcErr) {
                    if (rpcErr.code === '42883' || rpcErr.code === '42P01') {
                        if (!cancelled) { setWcaRows([]); setWcaState('ok'); }
                        return;
                    }
                    throw rpcErr;
                }
                if (cancelled) return;
                const list = data || [];
                setWcaRows(list);
                const map = await fetchAvatarMap(list);
                if (cancelled) return;
                setWcaAvatarMap(map);
                setWcaState('ok');
            } catch (err) {
                console.error('WCA leaderboard load failed:', err);
                if (!cancelled) setWcaState('error');
            }
        })();
        return () => { cancelled = true; };
    }, [wcaEvent, wcaType]);

    // WCA 全能王（只在切到「全能王」次選時才呼叫，避免多餘的 RPC）
    useEffect(() => {
        if (wcaMode !== 'allaround') return;
        let cancelled = false;
        (async () => {
            setWcaAllaroundState('loading');
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_wca_allaround_leaderboard');
                if (rpcErr) {
                    if (rpcErr.code === '42883' || rpcErr.code === '42P01') {
                        if (!cancelled) { setWcaAllaroundRows([]); setWcaAllaroundState('ok'); }
                        return;
                    }
                    throw rpcErr;
                }
                if (cancelled) return;
                const list = data || [];
                setWcaAllaroundRows(list);
                const map = await fetchAvatarMap(list);
                if (cancelled) return;
                setWcaAllaroundAvatarMap(map);
                setWcaAllaroundState('ok');
            } catch (err) {
                console.error('WCA all-around leaderboard load failed:', err);
                if (!cancelled) setWcaAllaroundState('error');
            }
        })();
        return () => { cancelled = true; };
    }, [wcaMode]);

    // 人氣互動排行榜（只在切到這個 tab 時才呼叫）
    useEffect(() => {
        if (tab !== 'interaction') return;
        let cancelled = false;
        (async () => {
            setInteractionState('loading');
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_interaction_leaderboard');
                if (rpcErr) {
                    if (rpcErr.code === '42883' || rpcErr.code === '42P01') {
                        if (!cancelled) { setInteractionRows([]); setInteractionState('ok'); }
                        return;
                    }
                    throw rpcErr;
                }
                if (cancelled) return;
                const list = data || [];
                setInteractionRows(list);
                const map = await fetchAvatarMap(list);
                if (cancelled) return;
                setInteractionAvatarMap(map);
                setInteractionState('ok');
            } catch (err) {
                console.error('Interaction leaderboard load failed:', err);
                if (!cancelled) setInteractionState('error');
            }
        })();
        return () => { cancelled = true; };
    }, [tab]);

    const currentWcaEventMeta = wcaEvents.find((e) => e.event_id === wcaEvent);

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto">
            <div className="mb-6 flex items-start gap-3 bg-bauhaus-yellow rounded-2xl border-2 lg:border-4 border-bauhaus-black px-4 py-3 shadow-hard">
                <span aria-hidden="true" className="mt-1 shrink-0 w-0 h-0 border-l-[9px] border-r-[9px] border-b-[15px] border-l-transparent border-r-transparent border-b-bauhaus-black" />
                <p className="text-sm sm:text-base font-bold text-bauhaus-black leading-relaxed">
                    資料陸續整理中，當前數據很可能會不準，僅供參考
                </p>
            </div>
            <div className="mb-6 overflow-x-auto">
                <div className="inline-flex rounded-xl overflow-hidden border-2 lg:border-4 border-bauhaus-black divide-x-2 divide-bauhaus-black">
                    <TabButton active={tab === 'teaching'} onClick={() => setTab('teaching')}>教學時數</TabButton>
                    <TabButton active={tab === 'cube'} onClick={() => setTab('cube')}>方塊競速</TabButton>
                    <TabButton active={tab === 'wca'} onClick={() => setTab('wca')}>WCA 賽事</TabButton>
                    <TabButton active={tab === 'interaction'} onClick={() => setTab('interaction')}>人氣互動</TabButton>
                    <TabButton active={tab === 'cert'} onClick={() => setTab('cert')}>認證分數</TabButton>
                </div>
            </div>

            {tab === 'teaching' && (
                <div>
                    <div className="flex flex-wrap gap-2 mb-3">
                        {TEACHING_SCOPES.map((c) => (
                            <PillButton key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
                                {c.label}
                            </PillButton>
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-2 mb-6">
                        {TEACHING_BASES.map((b) => (
                            <PillButton key={b.key} active={basis === b.key} onClick={() => setBasis(b.key)}>
                                {b.label}
                            </PillButton>
                        ))}
                    </div>
                    {loading ? (
                        <LoadingSkeleton />
                    ) : error ? (
                        <ErrorState />
                    ) : (
                        <LeaderboardView
                            rows={rows}
                            avatarMap={avatarMap}
                            currentUserId={user?.id}
                            years={years}
                            selectedYear={year}
                            onYearChange={setYear}
                            metric={teachingMetric}
                        />
                    )}
                </div>
            )}

            {tab === 'cube' && (
                <div>
                    <div className="mb-6 overflow-x-auto">
                        <div className="inline-flex rounded-xl overflow-hidden border-2 lg:border-4 border-bauhaus-black divide-x-2 divide-bauhaus-black">
                            <TabButton active={cubeMode === 'virtual'} onClick={() => setCubeMode('virtual')}>鍵盤模式</TabButton>
                            <TabButton active={cubeMode === 'physical'} onClick={() => setCubeMode('physical')}>實體計時</TabButton>
                        </div>
                    </div>
                    {cubeState === 'loading' ? (
                        <LoadingSkeleton />
                    ) : cubeState === 'unavailable' ? (
                        <EmptyState icon={Timer} title="排行榜功能待資料庫更新後開放" desc="請稍後再回來看看。" />
                    ) : cubeState === 'error' ? (
                        <ErrorState />
                    ) : (
                        <LeaderboardView
                            rows={cubeRows}
                            avatarMap={{}}
                            currentUserId={user?.id}
                            metric={CUBE_METRIC}
                            title="方塊競速排行榜"
                            subtitlePrefix={cubeMode === 'virtual' ? '打亂、計時、解開，看看誰最快' : '拿實體方塊計時，看看誰最快'}
                            showYearLabel={false}
                            icon={Timer}
                            emptyTitle="還沒有人送出成績"
                            emptyDesc="到方塊競速頁面打亂計時，第一個上榜！"
                        />
                    )}
                </div>
            )}

            {tab === 'wca' && (
                <div>
                    <div className="mb-6 overflow-x-auto">
                        <div className="inline-flex rounded-xl overflow-hidden border-2 lg:border-4 border-bauhaus-black divide-x-2 divide-bauhaus-black">
                            <TabButton active={wcaMode === 'event'} onClick={() => setWcaMode('event')}>各項目</TabButton>
                            <TabButton active={wcaMode === 'allaround'} onClick={() => setWcaMode('allaround')}>🌀 全能王</TabButton>
                        </div>
                    </div>

                    {wcaMode === 'event' ? (
                        wcaEventsState === 'loading' ? (
                            <LoadingSkeleton />
                        ) : wcaEventsState === 'unavailable' ? (
                            <EmptyState icon={Globe} title="排行榜功能待資料庫更新後開放" desc="請稍後再回來看看。" />
                        ) : wcaEventsState === 'error' ? (
                            <ErrorState />
                        ) : wcaEvents.length === 0 ? (
                            <div>
                                {/* 保留停用態的次選列（下拉＋單次/平均），與有資料時版面結構一致 */}
                                <div className="flex flex-wrap items-center gap-3 mb-6">
                                    <select
                                        disabled
                                        value=""
                                        className="px-4 py-2.5 min-h-[44px] rounded-xl bg-bauhaus-muted border-2 border-bauhaus-black/10 text-bauhaus-black/30 cursor-not-allowed"
                                    >
                                        <option value="">項目</option>
                                    </select>
                                    <div className="flex gap-2">
                                        <PillButton disabled>單次</PillButton>
                                        <PillButton disabled>平均</PillButton>
                                    </div>
                                </div>
                                <EmptyState icon={Globe} title="WCA 成績比對中，管理員確認後顯示" desc="請稍後再回來看看。" />
                            </div>
                        ) : (
                            <div>
                                <div className="flex flex-wrap items-center gap-3 mb-6">
                                    <select
                                        value={wcaEvent || ''}
                                        onChange={(e) => setWcaEvent(e.target.value)}
                                        className="px-4 py-2.5 min-h-[44px] rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted"
                                    >
                                        {wcaEvents.map((ev) => (
                                            <option key={ev.event_id} value={ev.event_id}>{wcaEventName(ev.event_id)}</option>
                                        ))}
                                    </select>
                                    <div className="flex gap-2">
                                        <PillButton
                                            active={wcaType === 'single'}
                                            disabled={!currentWcaEventMeta?.single_count}
                                            onClick={() => setWcaType('single')}
                                        >
                                            單次
                                        </PillButton>
                                        <PillButton
                                            active={wcaType === 'average'}
                                            disabled={!currentWcaEventMeta?.average_count}
                                            onClick={() => setWcaType('average')}
                                        >
                                            平均
                                        </PillButton>
                                    </div>
                                </div>

                                {wcaState === 'loading' ? (
                                    <LoadingSkeleton />
                                ) : wcaState === 'error' ? (
                                    <ErrorState />
                                ) : (
                                    <LeaderboardView
                                        rows={wcaRows}
                                        avatarMap={wcaAvatarMap}
                                        currentUserId={user?.id}
                                        metric={wcaMetric(wcaEvent, wcaType)}
                                        title={`WCA ${wcaEventName(wcaEvent)}排行榜`}
                                        subtitlePrefix="官方賽事成績"
                                        showYearLabel={false}
                                        icon={Globe}
                                        emptyTitle="這個項目還沒有成績"
                                        emptyDesc="等待管理員比對 WCA 官方成績。"
                                    />
                                )}
                            </div>
                        )
                    ) : (
                        wcaAllaroundState === 'loading' ? (
                            <LoadingSkeleton />
                        ) : wcaAllaroundState === 'error' ? (
                            <ErrorState />
                        ) : (
                            <LeaderboardView
                                rows={wcaAllaroundRows}
                                avatarMap={wcaAllaroundAvatarMap}
                                currentUserId={user?.id}
                                metric={WCA_ALLAROUND_METRIC}
                                title="WCA 全能王排行榜"
                                subtitlePrefix="綜合各項目官方成績"
                                showYearLabel={false}
                                icon={Globe}
                                emptyTitle="還沒有全能排名"
                                emptyDesc="等待管理員比對更多項目的 WCA 官方成績。"
                            />
                        )
                    )}
                </div>
            )}

            {tab === 'interaction' && (
                <div>
                    {interactionState === 'loading' ? (
                        <LoadingSkeleton />
                    ) : interactionState === 'error' ? (
                        <ErrorState />
                    ) : (
                        <LeaderboardView
                            rows={interactionRows}
                            avatarMap={interactionAvatarMap}
                            currentUserId={user?.id}
                            metric={INTERACTION_METRIC}
                            title="人氣互動排行榜"
                            subtitlePrefix="看看誰最受學員喜愛"
                            showYearLabel={false}
                            icon={Heart}
                            emptyTitle="還沒有互動紀錄"
                            emptyDesc="被學員按讚後就會出現在這裡！"
                        />
                    )}
                </div>
            )}

            {tab === 'cert' && (
                <div>
                    <EmptyState
                        icon={Award}
                        title="魔術方塊綜合能力認證"
                        desc="敬請期待——認證分數排行即將開放，資料整理中。"
                    />
                </div>
            )}
        </div>
    );
};

export default Leaderboard;
