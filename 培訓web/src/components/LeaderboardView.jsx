import { useMemo } from 'react';
import { Trophy, Crown, Medal } from 'lucide-react';
import { toHours, highestMilestone } from '../lib/leaderboard';

// 單一排行維度：接課時數。championTitle＝該榜第 1 名要顯示的冠軍稱號字串
// （通用機制：任何 metric 想在第一名頭上顯示稱號，設這個欄位就好；
// 不設或設 null／undefined，該榜就不顯示稱號徽章）。
const METRIC = { label: '接課時數', unit: '小時', accent: 'blue', getValue: (r) => toHours(r.total_hours), championTitle: '桃李之王' };

const ACCENT = {
    blue: 'bg-bauhaus-blue',
};

// 名次視覺（Bauhaus 重新詮釋金銀銅）：黃＝第1（黃底黑字）、黑框白底＝第2、紅＝第3。
// 理由：獎座漸層／光暈是擬態金屬光澤，違反扁平幾何鐵律；改用三原色體系（黃/紅）＋
// 黑白，沿用全站既有語意（黃＝亮點／成就，milestone 徽章已用黃），第一名依然最搶眼。
const PODIUM = {
    1: { icon: Crown, iconClass: 'text-bauhaus-black', ring: 'border-bauhaus-yellow', value: 'text-bauhaus-black', pedestal: 'bg-bauhaus-yellow', pedestalText: 'text-bauhaus-black', h: 'h-32 sm:h-36' },
    2: { icon: Medal, iconClass: 'text-bauhaus-black', ring: 'border-bauhaus-black', value: 'text-bauhaus-black', pedestal: 'bg-white', pedestalText: 'text-bauhaus-black', h: 'h-24 sm:h-28' },
    3: { icon: Medal, iconClass: 'text-bauhaus-black', ring: 'border-bauhaus-red', value: 'text-bauhaus-red', pedestal: 'bg-bauhaus-red', pedestalText: 'text-white', h: 'h-20 sm:h-24' },
};

const initialOf = (name) => (name ? name.trim().charAt(0) : '?');

const Avatar = ({ url, name, size = 'w-12 h-12', textSize = 'text-lg' }) => (
    <div className={`${size} rounded-full overflow-hidden shrink-0 bg-bauhaus-muted flex items-center justify-center border-2 border-bauhaus-black`}>
        {url ? (
            <img src={url} alt={name} className="w-full h-full object-cover" />
        ) : (
            <span className={`${textSize} font-black text-bauhaus-black/50`}>{initialOf(name)}</span>
        )}
    </div>
);

// 里程碑小徽章
const MilestoneChip = ({ hours, small }) => {
    const m = highestMilestone(hours);
    if (!m) return null;
    return (
        <span className={`inline-flex items-center gap-0.5 rounded-full bg-bauhaus-yellow text-bauhaus-black font-bold border-2 border-bauhaus-black shrink-0 whitespace-nowrap ${small ? 'text-[10px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5'}`}>
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
            <div className={`relative overflow-hidden ${ACCENT[activeTab.accent]} border-2 lg:border-4 border-bauhaus-black shadow-hard lg:shadow-hard-lg p-6 sm:p-8 text-white mb-6`}>
                <div className="pointer-events-none absolute -right-8 -top-10 w-32 h-32 sm:w-40 sm:h-40 rounded-full bg-white/10" />
                <div className="pointer-events-none absolute right-10 bottom-0 w-20 h-20 sm:w-24 sm:h-24 bg-white/10 rotate-45" />
                <div className="relative flex items-center gap-3">
                    <div className="w-12 h-12 sm:w-14 sm:h-14 bg-white border-2 border-bauhaus-black flex items-center justify-center shrink-0">
                        <HeaderIcon className="w-6 h-6 sm:w-7 sm:h-7 text-bauhaus-blue" />
                    </div>
                    <div>
                        <h1 className="text-2xl sm:text-3xl font-black tracking-tight">{title}</h1>
                        <p className="text-white/80 text-sm mt-0.5">{subtitlePrefix}{showYearLabel ? ` · ${yearLabel}` : ''}</p>
                    </div>
                </div>
                {myRow && (
                    <div className="relative mt-5 bg-white/10 border-2 border-white px-4 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
                <div className="bg-white rounded-none border-2 lg:border-4 border-bauhaus-black shadow-hard py-16 text-center">
                    <div className="w-16 h-16 bg-bauhaus-muted border-2 border-bauhaus-black rounded-full flex items-center justify-center mx-auto mb-4">
                        <HeaderIcon className="w-8 h-8 text-bauhaus-black/40" />
                    </div>
                    <h2 className="text-xl font-black text-bauhaus-black">{emptyTitle}</h2>
                    <p className="text-bauhaus-black/50 mt-2 text-sm">{emptyDesc}</p>
                </div>
            ) : (
                <>
                    {/* Podium 前三名 */}
                    {top3.length > 0 && (
                        <div key={selectedYear ?? 'all'} className={`mb-6 items-end ${podiumOrder.length === 1 ? 'flex justify-center' : 'grid grid-cols-3 gap-1.5 sm:gap-4'}`}>
                            {podiumOrder.map((r, i) => {
                                const rank = sorted.findIndex((x) => x.instructor_id === r.instructor_id) + 1;
                                const p = PODIUM[rank] || PODIUM[3];
                                const Icon = p.icon;
                                const isMe = r.user_id && r.user_id === currentUserId;
                                const isFirst = rank === 1;
                                // 稱號徽章只在該 metric 設了 championTitle 時才顯示，且只在第一名頭上，
                                // 不可漏到第二、三名或沒設稱號的榜（例如未列出對照的教學範圍）。
                                const rankName = rank === 1 ? (activeTab.championTitle || null) : null;
                                return (
                                    <div
                                        key={r.instructor_id}
                                        className={`flex flex-col items-center ${podiumOrder.length === 1 ? 'w-36 sm:w-44' : ''}`}
                                        style={{ animation: 'lb-fade-up 0.5s ease-out both', animationDelay: `${i * 90}ms` }}
                                    >
                                        <Icon className={`w-6 h-6 sm:w-8 sm:h-8 mb-1 ${p.iconClass}`} />
                                        {rankName && (
                                            <span data-testid="rank-title" className="mb-1 text-[10px] sm:text-[11px] font-black text-bauhaus-black bg-bauhaus-yellow border-2 border-bauhaus-black px-2 py-0.5 rounded-full text-center leading-tight">{rankName}</span>
                                        )}
                                        <div className="relative flex flex-col items-center">
                                            <div className={`relative border-4 ${isMe ? 'border-bauhaus-blue' : p.ring} rounded-full ${isFirst ? 'p-0.5' : ''}`}>
                                                <Avatar
                                                    url={avatarMap[r.instructor_id]}
                                                    name={r.display_name}
                                                    size={isFirst ? 'w-16 h-16 sm:w-20 sm:h-20' : 'w-12 h-12 sm:w-16 sm:h-16'}
                                                    textSize={isFirst ? 'text-2xl' : 'text-lg'}
                                                />
                                            </div>
                                        </div>
                                        <div className="mt-2 text-center w-full px-0.5">
                                            <div className="font-black text-bauhaus-black text-xs sm:text-base truncate">
                                                {r.display_name || '匿名講師'}
                                                {isMe && <span className="hidden sm:inline ml-1.5 text-[10px] font-bold text-white bg-bauhaus-blue px-1.5 py-0.5 rounded-full align-middle">你</span>}
                                            </div>
                                            <div className={`text-lg sm:text-2xl font-black tabular-nums ${p.value}`}>{fmt(r.value)}</div>
                                            {activeTab.unit && (
                                                <div className="text-[10px] sm:text-[11px] text-bauhaus-black/40 font-medium -mt-0.5">{activeTab.unit}</div>
                                            )}
                                        </div>
                                        <div className="mt-1.5 h-5 flex items-center justify-center">
                                            <MilestoneChip hours={r.total_hours} small />
                                        </div>
                                        <div
                                            className={`mt-1 w-full ${p.h} border-2 lg:border-4 border-bauhaus-black border-b-0 ${p.pedestal} flex items-start justify-center pt-2 origin-bottom`}
                                            style={{ animation: 'lb-rise 0.55s cubic-bezier(0.22,1,0.36,1) both', animationDelay: `${i * 90 + 120}ms` }}
                                        >
                                            <span className={`text-3xl sm:text-5xl font-black ${p.pedestalText} tabular-nums`}>{rank}</span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {/* 其餘名次列表 */}
                    {rest.length > 0 && (
                        <div className="bg-white rounded-none border-2 lg:border-4 border-bauhaus-black shadow-hard overflow-hidden divide-y-2 divide-bauhaus-black/20">
                            {rest.map((r) => {
                                const rank = sorted.findIndex((x) => x.instructor_id === r.instructor_id) + 1;
                                const isMe = r.user_id && r.user_id === currentUserId;
                                const sub = subLine(r);
                                return (
                                    <div
                                        key={r.instructor_id}
                                        className={`group flex items-center gap-3 px-4 sm:px-5 py-3 transition-colors ${isMe ? 'bg-bauhaus-blue/10' : 'hover:bg-bauhaus-cream'}`}
                                    >
                                        <div className={`w-8 text-center text-lg font-black tabular-nums ${isMe ? 'text-bauhaus-blue' : 'text-bauhaus-black/30 group-hover:text-bauhaus-black/50'}`}>
                                            {rank}
                                        </div>
                                        <Avatar url={avatarMap[r.instructor_id]} name={r.display_name} size="w-11 h-11" />
                                        <div className="flex-1 min-w-0">
                                            <div className={`font-bold truncate flex items-center gap-2 ${isMe ? 'text-bauhaus-blue' : 'text-bauhaus-black'}`}>
                                                <span className="truncate">{r.display_name || '匿名講師'}</span>
                                                {isMe && <span className="shrink-0 text-[11px] font-bold text-white bg-bauhaus-blue px-2 py-0.5 rounded-full">你</span>}
                                            </div>
                                            {(sub || highestMilestone(r.total_hours)) && (
                                                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5 min-w-0">
                                                    <MilestoneChip hours={r.total_hours} small />
                                                    {sub && <span className="text-[11px] text-bauhaus-black/50">{sub}</span>}
                                                </div>
                                            )}
                                        </div>
                                        <div className="text-right shrink-0">
                                            <span className={`text-lg font-black tabular-nums ${isMe ? 'text-bauhaus-blue' : 'text-bauhaus-black'}`}>{fmt(r.value)}</span>
                                            {activeTab.unit && <span className="text-xs text-bauhaus-black/50 ml-1">{activeTab.unit}</span>}
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
        className={`px-3.5 py-3 md:py-1.5 rounded-full text-sm font-bold border-2 border-bauhaus-black transition-colors duration-200 ${
            active
                ? 'bg-bauhaus-black text-white'
                : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
        }`}
    >
        {children}
    </button>
);

export default LeaderboardView;
