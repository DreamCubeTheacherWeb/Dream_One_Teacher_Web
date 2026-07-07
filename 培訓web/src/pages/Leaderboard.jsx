import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { Trophy, Crown, Medal, BookOpen, Heart, ClipboardCheck, GraduationCap, AlertTriangle, Users } from 'lucide-react';

// 排行維度設定
const TABS = [
    { key: 'completed_lessons', label: '完成章節', icon: BookOpen, unit: '章節', accent: 'blue' },
    { key: 'likes_received', label: '累積獲讚', icon: Heart, unit: '讚', accent: 'rose' },
    { key: 'assignments_submitted', label: '作業數', icon: ClipboardCheck, unit: '份', accent: 'emerald' },
    { key: 'completed_courses', label: '完訓課程', icon: GraduationCap, unit: '門', accent: 'amber' },
];

const ACCENT = {
    blue: 'from-blue-500 to-indigo-500',
    rose: 'from-rose-500 to-pink-500',
    emerald: 'from-emerald-500 to-teal-500',
    amber: 'from-amber-500 to-orange-500',
};

// 名次配色（金銀銅）
const MEDALS = {
    1: { ring: 'ring-amber-300', bg: 'bg-gradient-to-b from-amber-100 to-amber-50', text: 'text-amber-600', label: '🥇', icon: Crown },
    2: { ring: 'ring-slate-300', bg: 'bg-gradient-to-b from-slate-100 to-slate-50', text: 'text-slate-500', label: '🥈', icon: Medal },
    3: { ring: 'ring-orange-300', bg: 'bg-gradient-to-b from-orange-100 to-orange-50', text: 'text-orange-600', label: '🥉', icon: Medal },
};

const initialOf = (name) => (name ? name.trim().charAt(0) : '?');

const Avatar = ({ url, name, size = 'w-12 h-12', textSize = 'text-lg' }) => (
    <div className={`${size} rounded-full overflow-hidden shrink-0 bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center border-2 border-white shadow-sm`}>
        {url ? (
            <img src={url} alt={name} className="w-full h-full object-cover" />
        ) : (
            <span className={`${textSize} font-black text-slate-500`}>{initialOf(name)}</span>
        )}
    </div>
);

const Leaderboard = () => {
    const { user } = useAuth();
    const [rows, setRows] = useState([]);
    const [avatarMap, setAvatarMap] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    const [tab, setTab] = useState('completed_lessons');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(false);
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_teacher_stats');
                if (rpcErr) throw rpcErr;
                if (cancelled) return;
                const list = data || [];
                setRows(list);

                // 解析頭像簽名 URL（沿用 AuthContext 的 createSignedUrl 作法）
                const withPhoto = list.filter((r) => r.photo_path);
                const entries = await Promise.all(
                    withPhoto.map(async (r) => {
                        const { data: urlData } = await supabase.storage
                            .from('instructor_uploads')
                            .createSignedUrl(r.photo_path, 7200);
                        return [r.user_id, urlData?.signedUrl || null];
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
    }, []);

    const activeTab = TABS.find((t) => t.key === tab) || TABS[0];

    const sorted = useMemo(() => {
        return [...rows]
            .map((r) => ({ ...r, value: Number(r[tab] || 0) }))
            .sort((a, b) => b.value - a.value || (a.display_name || '').localeCompare(b.display_name || ''));
    }, [rows, tab]);

    const myRankIndex = sorted.findIndex((r) => r.user_id === user?.id);
    const myRow = myRankIndex >= 0 ? sorted[myRankIndex] : null;

    // ── loading ──
    if (loading) {
        return (
            <div className="p-4 sm:p-8 max-w-4xl mx-auto">
                <div className="h-40 rounded-3xl bg-slate-100 animate-pulse mb-6" />
                <div className="space-y-3">
                    {[...Array(5)].map((_, i) => (
                        <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />
                    ))}
                </div>
            </div>
        );
    }

    // ── error ──
    if (error) {
        return (
            <div className="p-4 sm:p-8 max-w-4xl mx-auto">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                    <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <AlertTriangle className="w-8 h-8 text-red-400" />
                    </div>
                    <h2 className="text-xl font-black text-slate-900">排行榜載入失敗</h2>
                    <p className="text-slate-500 mt-2 text-sm">請稍後再試，或重新整理頁面。</p>
                </div>
            </div>
        );
    }

    const top3 = sorted.slice(0, 3);
    const rest = sorted.slice(3);
    // podium 排列順序：2 / 1 / 3
    const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean);

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto">
            {/* Header */}
            <div className={`rounded-3xl bg-gradient-to-r ${ACCENT[activeTab.accent]} p-6 sm:p-8 text-white shadow-lg mb-6`}>
                <div className="flex items-center gap-3">
                    <Trophy className="w-8 h-8 sm:w-10 sm:h-10" />
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-black">講師排行榜</h1>
                        <p className="text-white/80 text-sm mt-0.5">看看大家的學習成果，一起加油！</p>
                    </div>
                </div>
                {myRow && (
                    <div className="mt-5 bg-white/15 backdrop-blur rounded-2xl px-4 py-3 flex items-center gap-3">
                        <span className="text-sm font-medium text-white/90">你目前的名次</span>
                        <span className="text-2xl font-black">#{myRankIndex + 1}</span>
                        <span className="text-sm text-white/80">
                            {activeTab.label} {myRow.value} {activeTab.unit}
                        </span>
                    </div>
                )}
            </div>

            {/* Tabs */}
            <div className="flex flex-wrap gap-2 mb-6">
                {TABS.map((t) => {
                    const Icon = t.icon;
                    const active = t.key === tab;
                    return (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            className={`flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-bold transition-all ${
                                active
                                    ? `text-white bg-gradient-to-r ${ACCENT[t.accent]} shadow-md`
                                    : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
                            }`}
                        >
                            <Icon className="w-4 h-4" /> {t.label}
                        </button>
                    );
                })}
            </div>

            {/* 空清單 */}
            {sorted.length === 0 ? (
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                    <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Users className="w-8 h-8 text-slate-300" />
                    </div>
                    <h2 className="text-xl font-black text-slate-900">目前還沒有排行資料</h2>
                    <p className="text-slate-500 mt-2 text-sm">完成章節、繳交作業就會出現在這裡！</p>
                </div>
            ) : (
                <>
                    {/* Podium 前三名 */}
                    {top3.length > 0 && (
                        <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-6 items-end">
                            {podiumOrder.map((r) => {
                                const rank = sorted.findIndex((x) => x.user_id === r.user_id) + 1;
                                const m = MEDALS[rank] || MEDALS[3];
                                const isMe = r.user_id === user?.id;
                                const tall = rank === 1;
                                return (
                                    <div
                                        key={r.user_id}
                                        className={`${m.bg} rounded-2xl border ${isMe ? 'border-blue-400 ring-2 ring-blue-300' : 'border-slate-100'} p-3 sm:p-4 flex flex-col items-center text-center shadow-sm ${tall ? 'pt-6 sm:pt-8' : 'pt-4 sm:pt-5'}`}
                                    >
                                        <div className="text-2xl sm:text-3xl mb-1">{m.label}</div>
                                        <div className={`ring-4 ${m.ring} rounded-full`}>
                                            <Avatar
                                                url={avatarMap[r.user_id]}
                                                name={r.display_name}
                                                size={tall ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-14 h-14 sm:w-16 sm:h-16'}
                                                textSize="text-xl"
                                            />
                                        </div>
                                        <div className="mt-2 font-black text-slate-800 text-sm sm:text-base truncate max-w-full">
                                            {r.display_name || '匿名講師'}
                                        </div>
                                        <div className={`text-lg sm:text-2xl font-black ${m.text}`}>
                                            {r.value}
                                        </div>
                                        <div className="text-[11px] text-slate-400 font-medium">{activeTab.unit}</div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* 其餘名次列表 */}
                    {rest.length > 0 && (
                        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden divide-y divide-slate-100">
                            {rest.map((r) => {
                                const rank = sorted.findIndex((x) => x.user_id === r.user_id) + 1;
                                const isMe = r.user_id === user?.id;
                                return (
                                    <div
                                        key={r.user_id}
                                        className={`flex items-center gap-3 px-4 sm:px-5 py-3 ${isMe ? 'bg-blue-50' : 'hover:bg-slate-50'} transition-colors`}
                                    >
                                        <div className={`w-8 text-center font-black ${isMe ? 'text-blue-600' : 'text-slate-400'}`}>
                                            {rank}
                                        </div>
                                        <Avatar url={avatarMap[r.user_id]} name={r.display_name} size="w-11 h-11" />
                                        <div className="flex-1 min-w-0">
                                            <div className={`font-bold truncate ${isMe ? 'text-blue-700' : 'text-slate-800'}`}>
                                                {r.display_name || '匿名講師'}
                                                {isMe && <span className="ml-2 text-[11px] font-bold text-blue-500 bg-blue-100 px-2 py-0.5 rounded-full">你</span>}
                                            </div>
                                        </div>
                                        <div className="text-right shrink-0">
                                            <span className="text-lg font-black text-slate-800">{r.value}</span>
                                            <span className="text-xs text-slate-400 ml-1">{activeTab.unit}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

export default Leaderboard;
