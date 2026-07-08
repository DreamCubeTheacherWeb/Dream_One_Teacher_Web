import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { AlertTriangle, Timer } from 'lucide-react';
import LeaderboardView from '../components/LeaderboardView';
import { formatCubeTime } from '../lib/cubeEngine';

// 方塊競速排行榜的 metric 設定（重用 LeaderboardView，時間越短名次越前）。
const CUBE_METRIC = {
    label: '最快成績',
    unit: '',
    accent: 'blue',
    higherIsBetter: false,
    getValue: (r) => r.best_ms,
    format: (ms) => `${formatCubeTime(ms)}s`,
};

const TabButton = ({ active, onClick, children }) => (
    <button
        type="button"
        onClick={onClick}
        className={`px-4 py-2.5 rounded-full text-sm font-bold transition-all ${
            active ? 'bg-slate-900 text-white shadow-sm' : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:text-slate-700'
        }`}
    >
        {children}
    </button>
);

const Leaderboard = () => {
    const { user } = useAuth();
    const [tab, setTab] = useState('teaching'); // 'teaching' | 'cube'

    const [year, setYear] = useState(null); // null＝歷屆總榜
    const [years, setYears] = useState([]);
    const [rows, setRows] = useState([]);
    const [avatarMap, setAvatarMap] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    // 方塊競速排行榜（獨立於教學排行榜，教學分頁行為完全不變）
    const [cubeRows, setCubeRows] = useState([]);
    const [cubeState, setCubeState] = useState('loading'); // loading | ok | unavailable | error
    const [cubeMode, setCubeMode] = useState('virtual'); // 'virtual' | 'physical'

    // 有接課資料的年份（一次載入，給年份切換器）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const { data } = await supabase.rpc('get_teaching_years');
            if (!cancelled && Array.isArray(data)) setYears(data.map((d) => d.yr));
        })();
        return () => { cancelled = true; };
    }, []);

    // 依年份載入排行榜
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(false);
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_teaching_leaderboard', { p_year: year });
                if (rpcErr) throw rpcErr;
                if (cancelled) return;
                const list = data || [];
                setRows(list);

                // 頭像簽名 URL（沿用 instructor_uploads bucket，以 instructor_id 為鍵）
                const withPhoto = list.filter((r) => r.photo_path);
                const entries = await Promise.all(
                    withPhoto.map(async (r) => {
                        const { data: urlData } = await supabase.storage
                            .from('instructor_uploads')
                            .createSignedUrl(r.photo_path, 7200);
                        return [r.instructor_id, urlData?.signedUrl || null];
                    })
                );
                if (cancelled) return;
                setAvatarMap(Object.fromEntries(entries));
            } catch (err) {
                console.error('Leaderboard load failed:', err);
                if (!cancelled) setError(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [year]);

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

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto">
            <div className="flex flex-wrap gap-2 mb-6">
                <TabButton active={tab === 'teaching'} onClick={() => setTab('teaching')}>教學排行</TabButton>
                <TabButton active={tab === 'cube'} onClick={() => setTab('cube')}>方塊競速</TabButton>
            </div>

            {tab === 'teaching' && (
                loading ? (
                    <div>
                        <div className="h-40 rounded-3xl bg-slate-100 animate-pulse mb-6" />
                        <div className="space-y-3">
                            {[...Array(5)].map((_, i) => (
                                <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />
                            ))}
                        </div>
                    </div>
                ) : error ? (
                    <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                        <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                            <AlertTriangle className="w-8 h-8 text-red-400" />
                        </div>
                        <h2 className="text-xl font-black text-slate-900">排行榜載入失敗</h2>
                        <p className="text-slate-500 mt-2 text-sm">請稍後再試，或重新整理頁面。</p>
                    </div>
                ) : (
                    <LeaderboardView
                        rows={rows}
                        avatarMap={avatarMap}
                        currentUserId={user?.id}
                        years={years}
                        selectedYear={year}
                        onYearChange={setYear}
                    />
                )
            )}

            {tab === 'cube' && (
                <div>
                    <div className="flex gap-2 mb-6">
                        <TabButton active={cubeMode === 'virtual'} onClick={() => setCubeMode('virtual')}>鍵盤模式</TabButton>
                        <TabButton active={cubeMode === 'physical'} onClick={() => setCubeMode('physical')}>實體計時</TabButton>
                    </div>
                    {cubeState === 'loading' ? (
                        <div>
                            <div className="h-40 rounded-3xl bg-slate-100 animate-pulse mb-6" />
                            <div className="space-y-3">
                                {[...Array(5)].map((_, i) => (
                                    <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />
                                ))}
                            </div>
                        </div>
                    ) : cubeState === 'unavailable' ? (
                        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                <Timer className="w-8 h-8 text-slate-300" />
                            </div>
                            <h2 className="text-xl font-black text-slate-900">排行榜功能待資料庫更新後開放</h2>
                            <p className="text-slate-500 mt-2 text-sm">請稍後再回來看看。</p>
                        </div>
                    ) : cubeState === 'error' ? (
                        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                            <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                                <AlertTriangle className="w-8 h-8 text-red-400" />
                            </div>
                            <h2 className="text-xl font-black text-slate-900">排行榜載入失敗</h2>
                            <p className="text-slate-500 mt-2 text-sm">請稍後再試，或重新整理頁面。</p>
                        </div>
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
        </div>
    );
};

export default Leaderboard;
