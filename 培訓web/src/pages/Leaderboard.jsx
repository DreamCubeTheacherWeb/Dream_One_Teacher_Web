import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { AlertTriangle, Timer, Globe } from 'lucide-react';
import LeaderboardView from '../components/LeaderboardView';
import { formatCubeTime } from '../lib/cubeEngine';
import { wcaEventName, wcaMetric } from '../lib/wca';

// 方塊競速排行榜的 metric 設定（重用 LeaderboardView，時間越短名次越前）。
const CUBE_METRIC = {
    label: '最快成績',
    unit: '',
    accent: 'blue',
    higherIsBetter: false,
    getValue: (r) => r.best_ms,
    format: (ms) => `${formatCubeTime(ms)}s`,
};

// 教學時數次選：category 對應 get_teaching_leaderboard_v2 的 p_category
const TEACHING_CATEGORIES = [
    { key: 'all', label: '總時數' },
    { key: 'big', label: '大班課' },
    { key: 'small', label: '小班課' },
];

const TabButton = ({ active, onClick, children }) => (
    <button
        type="button"
        onClick={onClick}
        className={`px-4 py-2.5 min-h-[44px] rounded-full text-sm font-bold transition-all ${
            active ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:text-slate-700'
        }`}
    >
        {children}
    </button>
);

// 次選 pill（視覺比頂層 tab 輕一階）：教學時數的三個 category、WCA 的單次/平均切換
const PillButton = ({ active, onClick, disabled, children }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`px-3.5 py-2.5 min-h-[44px] rounded-full text-sm font-bold transition-all ${
            disabled
                ? 'bg-slate-50 text-slate-300 border border-slate-100 cursor-not-allowed'
                : active
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:text-slate-700'
        }`}
    >
        {children}
    </button>
);

const LoadingSkeleton = () => (
    <div>
        <div className="h-40 rounded-3xl bg-slate-100 animate-pulse mb-6" />
        <div className="space-y-3">
            {[...Array(5)].map((_, i) => (
                <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />
            ))}
        </div>
    </div>
);

const ErrorState = ({ title = '排行榜載入失敗', desc = '請稍後再試，或重新整理頁面。' }) => (
    <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
            <AlertTriangle className="w-8 h-8 text-red-400" />
        </div>
        <h2 className="text-xl font-black text-slate-900">{title}</h2>
        <p className="text-slate-500 mt-2 text-sm">{desc}</p>
    </div>
);

const EmptyState = ({ icon, title, desc }) => {
    const Icon = icon || Timer;
    return (
        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <Icon className="w-8 h-8 text-slate-300" />
            </div>
            <h2 className="text-xl font-black text-slate-900">{title}</h2>
            <p className="text-slate-500 mt-2 text-sm">{desc}</p>
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
    const [tab, setTab] = useState('teaching'); // 'teaching' | 'cube' | 'wca'

    // ── 教學時數 ──
    const [year, setYear] = useState(null); // null＝歷屆總榜
    const [years, setYears] = useState([]);
    const [category, setCategory] = useState('all'); // 'all' | 'big' | 'small'
    const [rows, setRows] = useState([]);
    const [avatarMap, setAvatarMap] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    // ── 方塊競速（獨立於教學排行榜，行為完全不變） ──
    const [cubeRows, setCubeRows] = useState([]);
    const [cubeState, setCubeState] = useState('loading'); // loading | ok | unavailable | error
    const [cubeMode, setCubeMode] = useState('virtual'); // 'virtual' | 'physical'

    // ── WCA 賽事 ──
    const [wcaEvents, setWcaEvents] = useState([]); // [{event_id, single_count, average_count}]
    const [wcaEventsState, setWcaEventsState] = useState('loading'); // loading | ok | unavailable | error
    const [wcaEvent, setWcaEvent] = useState(null);
    const [wcaType, setWcaType] = useState('single'); // 'single' | 'average'
    const [wcaRows, setWcaRows] = useState([]);
    const [wcaAvatarMap, setWcaAvatarMap] = useState({});
    const [wcaState, setWcaState] = useState('loading'); // loading | ok | error

    // 有接課資料的年份（一次載入，給年份切換器）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const { data } = await supabase.rpc('get_teaching_years');
            if (!cancelled && Array.isArray(data)) setYears(data.map((d) => d.yr));
        })();
        return () => { cancelled = true; };
    }, []);

    // 依年份＋分類載入教學排行榜
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
                    setWcaEvent(list[0].event_id);
                    setWcaType(list[0].single_count > 0 ? 'single' : 'average');
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

    const currentWcaEventMeta = wcaEvents.find((e) => e.event_id === wcaEvent);

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto">
            <div className="flex flex-wrap gap-2 mb-6">
                <TabButton active={tab === 'teaching'} onClick={() => setTab('teaching')}>教學時數</TabButton>
                <TabButton active={tab === 'cube'} onClick={() => setTab('cube')}>方塊競速</TabButton>
                <TabButton active={tab === 'wca'} onClick={() => setTab('wca')}>WCA 賽事</TabButton>
            </div>

            {tab === 'teaching' && (
                <div>
                    <div className="flex flex-wrap gap-2 mb-6">
                        {TEACHING_CATEGORIES.map((c) => (
                            <PillButton key={c.key} active={category === c.key} onClick={() => setCategory(c.key)}>
                                {c.label}
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
                        />
                    )}
                </div>
            )}

            {tab === 'cube' && (
                <div>
                    <div className="flex gap-2 mb-6">
                        <TabButton active={cubeMode === 'virtual'} onClick={() => setCubeMode('virtual')}>鍵盤模式</TabButton>
                        <TabButton active={cubeMode === 'physical'} onClick={() => setCubeMode('physical')}>實體計時</TabButton>
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
                    {wcaEventsState === 'loading' ? (
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
                                    className="px-4 py-2.5 min-h-[44px] rounded-full text-sm font-bold bg-slate-50 border border-slate-100 text-slate-300 cursor-not-allowed"
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
                                    className="px-4 py-2.5 min-h-[44px] rounded-full text-sm font-bold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50"
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
                    )}
                </div>
            )}
        </div>
    );
};

export default Leaderboard;
