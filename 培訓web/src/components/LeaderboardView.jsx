import { useMemo } from 'react';
import { Trophy, Crown, Medal } from 'lucide-react';
import { toHours, highestMilestone, rankTitle } from '../lib/leaderboard';

// 單一排行維度：接課時數
const METRIC = { label: '接課時數', unit: '小時', accent: 'blue', getValue: (r) => toHours(r.total_hours) };

const ACCENT = {
    blue: 'from-blue-500 to-indigo-500',
};

// 名次視覺（金銀銅）：獎座、光暈、皇冠
const PODIUM = {
    1: { icon: Crown, iconClass: 'text-amber-400 drop-shadow-[0_2px_6px_rgba(245,158,11,0.55)]', ring: 'ring-amber-300', value: 'text-amber-600', pedestal: 'from-amber-300 via-amber-400 to-amber-500', pedestalText: 'text-amber-50', h: 'h-32 sm:h-36' },
    2: { icon: Medal, iconClass: 'text-slate-400', ring: 'ring-slate-300', value: 'text-slate-600', pedestal: 'from-slate-200 via-slate-300 to-slate-400', pedestalText: 'text-slate-600', h: 'h-24 sm:h-28' },
    3: { icon: Medal, iconClass: 'text-orange-400', ring: 'ring-orange-300', value: 'text-orange-600', pedestal: 'from-orange-200 via-orange-300 to-orange-400', pedestalText: 'text-orange-700', h: 'h-20 sm:h-24' },
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

// 里程碑小徽章
const MilestoneChip = ({ hours, small }) => {
    const m = highestMilestone(hours);
    if (!m) return null;
    return (
        <span className={`inline-flex items-center gap-0.5 rounded-full bg-amber-50 text-amber-700 font-bold ring-1 ring-amber-200 shrink-0 whitespace-nowrap ${small ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5'}`}>
            <span>{m.emoji}</span> {m.name}
        </span>
    );
};

const subLine = (r) => {
    const parts = [];
    if (r.session_count) parts.push(`${r.session_count} 場`);
    if (r.student_reach) parts.push(`${r.student_reach} 人次`);
    return parts.join(' · ');
};

/**
 * 排行榜純呈現元件（不含資料抓取）。預設呈現「講師榮譽榜」（接課時數），
 * 也可透過 metric 等 prop 重用於其他排行榜（例如方塊競速——見 Leaderboard.jsx）。
 * props:
 *   - rows：資料列陣列。預設情境（講師榮譽榜）含 total_hours / session_count /
 *     student_reach；重用於其他榜單時，至少要有 instructor_id（識別用）、
 *     user_id（用於高亮「你」）、display_name。
 *   - avatarMap：{ instructor_id: signedUrl }
 *   - currentUserId：目前登入者 id（用於高亮「你」）
 *   - years：有資料的年份陣列（新到舊）；空陣列則不顯示年份切換列
 *   - selectedYear：目前選的年份（null＝歷屆總榜）
 *   - onYearChange：(yearOrNull) => void
 *   - metric：排行維度設定，預設＝原本寫死的 METRIC（接課時數）。欄位：
 *     label / unit / accent（'blue'）/ getValue(r) / 可選 format(value) /
 *     可選 higherIsBetter（預設 true＝數值越大名次越前；方塊計時要設 false）
 *   - title / subtitlePrefix / showYearLabel / icon / emptyTitle / emptyDesc：
 *     頁首與空狀態文案，皆有預設值＝目前寫死的講師榮譽榜文案，不傳則行為不變。
 */
const LeaderboardView = ({
    rows = [],
    avatarMap = {},
    currentUserId,
    years = [],
    selectedYear = null,
    onYearChange,
    metric = METRIC,
    title = '講師榮譽榜',
    subtitlePrefix = '看看誰在講台上發光發熱',
    showYearLabel = true,
    icon,
    emptyTitle = '這個區間還沒有接課紀錄',
    emptyDesc = '接課登記後就會出現在這裡！',
}) => {
    const HeaderIcon = icon || Trophy;
    const activeTab = metric;
    const fmt = activeTab.format || ((v) => v);
    const sortDir = activeTab.higherIsBetter === false ? 1 : -1;

    const sorted = useMemo(() => {
        return [...rows]
            .map((r) => ({ ...r, value: activeTab.getValue(r) }))
            .sort((a, b) => (a.value - b.value) * sortDir || (a.display_name || '').localeCompare(b.display_name || ''));
    }, [rows, activeTab, sortDir]);

    const myRankIndex = sorted.findIndex((r) => r.user_id && r.user_id === currentUserId);
    const myRow = myRankIndex >= 0 ? sorted[myRankIndex] : null;

    const top3 = sorted.slice(0, 3);
    const rest = sorted.slice(3);
    const podiumOrder = [top3[1], top3[0], top3[2]].filter(Boolean); // 2 / 1 / 3

    const yearLabel = selectedYear ? `${selectedYear} 年度` : '歷屆總榜';

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto">
            {/* Header */}
            <div className={`relative overflow-hidden rounded-3xl bg-gradient-to-r ${ACCENT[activeTab.accent]} p-6 sm:p-8 text-white shadow-lg mb-6`}>
                <div className="pointer-events-none absolute -right-8 -top-10 w-40 h-40 rounded-full bg-white/10 blur-2xl" />
                <div className="pointer-events-none absolute right-16 bottom-0 w-24 h-24 rounded-full bg-white/10 blur-xl" />
                <div className="relative flex items-center gap-3">
                    <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-white/20 backdrop-blur flex items-center justify-center shrink-0">
                        <HeaderIcon className="w-6 h-6 sm:w-7 sm:h-7" />
                    </div>
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-black tracking-tight">{title}</h1>
                        <p className="text-white/80 text-sm mt-0.5">{subtitlePrefix}{showYearLabel ? ` · ${yearLabel}` : ''}</p>
                    </div>
                </div>
                {myRow && (
                    <div className="relative mt-5 bg-white/15 backdrop-blur rounded-2xl px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 ring-1 ring-white/20">
                        <span className="text-sm font-medium text-white/90 whitespace-nowrap">你目前的名次</span>
                        <span className="text-2xl font-black tabular-nums leading-none">#{myRankIndex + 1}</span>
                        <span className="w-full sm:w-auto sm:ml-auto text-sm text-white/80 whitespace-nowrap">
                            {activeTab.label} <b className="font-black text-white">{fmt(myRow.value)}</b> {activeTab.unit}
                        </span>
                    </div>
                )}
            </div>

            {/* 年份切換 */}
            {years.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-6">
                    <YearPill active={selectedYear === null} onClick={() => onYearChange?.(null)}>歷屆總榜</YearPill>
                    {years.map((y) => (
                        <YearPill key={y} active={selectedYear === y} onClick={() => onYearChange?.(y)}>{y}</YearPill>
                    ))}
                </div>
            )}

            {sorted.length === 0 ? (
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                    <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <HeaderIcon className="w-8 h-8 text-slate-300" />
                    </div>
                    <h2 className="text-xl font-black text-slate-900">{emptyTitle}</h2>
                    <p className="text-slate-500 mt-2 text-sm">{emptyDesc}</p>
                </div>
            ) : (
                <>
                    {/* Podium 前三名 */}
                    {top3.length > 0 && (
                        <div key={selectedYear ?? 'all'} className="grid grid-cols-3 gap-1.5 sm:gap-4 mb-6 items-end">
                            {podiumOrder.map((r, i) => {
                                const rank = sorted.findIndex((x) => x.instructor_id === r.instructor_id) + 1;
                                const p = PODIUM[rank] || PODIUM[3];
                                const Icon = p.icon;
                                const isMe = r.user_id && r.user_id === currentUserId;
                                const isFirst = rank === 1;
                                const title = rankTitle(rank, selectedYear);
                                return (
                                    <div
                                        key={r.instructor_id}
                                        className="flex flex-col items-center"
                                        style={{ animation: 'lb-fade-up 0.5s ease-out both', animationDelay: `${i * 90}ms` }}
                                    >
                                        <Icon className={`w-6 h-6 sm:w-8 sm:h-8 mb-1 ${p.iconClass}`} />
                                        {title && (
                                            <span className="mb-1 text-[10px] sm:text-[11px] font-black text-amber-700 bg-amber-100 ring-1 ring-amber-200 px-2 py-0.5 rounded-full text-center leading-tight">{title}</span>
                                        )}
                                        <div className="relative flex flex-col items-center">
                                            {isFirst && <div className="pointer-events-none absolute -inset-2 rounded-full bg-amber-300/40 blur-xl" />}
                                            <div className={`relative ring-4 ${isMe ? 'ring-blue-400' : p.ring} rounded-full ${isFirst ? 'p-0.5' : ''}`}>
                                                <Avatar
                                                    url={avatarMap[r.instructor_id]}
                                                    name={r.display_name}
                                                    size={isFirst ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-12 h-12 sm:w-16 sm:h-16'}
                                                    textSize={isFirst ? 'text-2xl' : 'text-lg'}
                                                />
                                            </div>
                                        </div>
                                        <div className="mt-2 text-center w-full px-0.5">
                                            <div className="font-black text-slate-800 text-xs sm:text-base truncate">
                                                {r.display_name || '匿名講師'}
                                                {isMe && <span className="hidden sm:inline ml-1.5 text-[10px] font-bold text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded-full align-middle">你</span>}
                                            </div>
                                            <div className={`text-lg sm:text-2xl font-black tabular-nums ${p.value}`}>{fmt(r.value)}</div>
                                            {activeTab.unit && (
                                                <div className="text-[10px] sm:text-[11px] text-slate-400 font-medium -mt-0.5">{activeTab.unit}</div>
                                            )}
                                        </div>
                                        <div className="mt-1.5 h-5 flex items-center justify-center">
                                            <MilestoneChip hours={r.total_hours} small />
                                        </div>
                                        <div
                                            className={`mt-1 w-full ${p.h} rounded-t-xl bg-gradient-to-b ${p.pedestal} shadow-inner flex items-start justify-center pt-2 origin-bottom ${isMe ? 'ring-2 ring-blue-400/60' : ''}`}
                                            style={{ animation: 'lb-rise 0.55s cubic-bezier(0.22,1,0.36,1) both', animationDelay: `${i * 90 + 120}ms` }}
                                        >
                                            <span className={`text-3xl sm:text-5xl font-black ${p.pedestalText} drop-shadow-sm tabular-nums`}>{rank}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* 其餘名次列表 */}
                    {rest.length > 0 && (
                        <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden divide-y divide-slate-100">
                            {rest.map((r) => {
                                const rank = sorted.findIndex((x) => x.instructor_id === r.instructor_id) + 1;
                                const isMe = r.user_id && r.user_id === currentUserId;
                                const sub = subLine(r);
                                return (
                                    <div
                                        key={r.instructor_id}
                                        className={`group flex items-center gap-3 px-4 sm:px-5 py-3 transition-colors ${isMe ? 'bg-blue-50/80' : 'hover:bg-slate-50'}`}
                                    >
                                        <div className={`w-8 text-center text-lg font-black tabular-nums ${isMe ? 'text-blue-600' : 'text-slate-300 group-hover:text-slate-400'}`}>
                                            {rank}
                                        </div>
                                        <Avatar url={avatarMap[r.instructor_id]} name={r.display_name} size="w-11 h-11" />
                                        <div className="flex-1 min-w-0">
                                            <div className={`font-bold truncate flex items-center gap-2 ${isMe ? 'text-blue-700' : 'text-slate-800'}`}>
                                                <span className="truncate">{r.display_name || '匿名講師'}</span>
                                                {isMe && <span className="shrink-0 text-[11px] font-bold text-blue-500 bg-blue-100 px-2 py-0.5 rounded-full">你</span>}
                                            </div>
                                            {(sub || highestMilestone(r.total_hours)) && (
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5 min-w-0">
                                                    <MilestoneChip hours={r.total_hours} small />
                                                    {sub && <span className="text-[11px] text-slate-500">{sub}</span>}
                                                </div>
                                            )}
                                        </div>
                                        <div className="text-right shrink-0">
                                            <span className={`text-lg font-black tabular-nums ${isMe ? 'text-blue-700' : 'text-slate-800'}`}>{fmt(r.value)}</span>
                                            {activeTab.unit && <span className="text-xs text-slate-500 ml-1">{activeTab.unit}</span>}
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

const YearPill = ({ active, onClick, children }) => (
    <button
        onClick={onClick}
        className={`px-3.5 py-3 md:py-1.5 rounded-full text-sm font-bold transition-all ${
            active
                ? 'bg-slate-900 text-white shadow-sm'
                : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50 hover:text-slate-700'
        }`}
    >
        {children}
    </button>
);

export default LeaderboardView;
