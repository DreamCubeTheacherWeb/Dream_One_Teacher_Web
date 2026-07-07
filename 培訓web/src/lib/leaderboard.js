// ═══════════════════════════════════════════════════════════════
// 講師榮譽榜：點數 / 里程碑 / 稱號公式（集中在此，好隨時調整）
// 資料來源＝get_teaching_leaderboard 回傳的 total_hours（接課總時數）。
// 點數 = 時數 × 每小時點數 + 已達成里程碑的獎勵分。
// ═══════════════════════════════════════════════════════════════

// 每接課 1 小時的基礎點數
export const POINTS_PER_HOUR = 10;

// 接課時數里程碑：達標給「獎勵點數」+ 徽章（累積制，跨過就永久計入）。
// 獎勵刻意做得有份量，讓「點數榜」不會跟「接課時數榜」名次一模一樣。
export const MILESTONES = [
  { hours: 50, bonus: 300, name: '接課新星', emoji: '🌱' },
  { hours: 100, bonus: 800, name: '百時講師', emoji: '⭐' },
  { hours: 300, bonus: 2500, name: '教學好手', emoji: '🔥' },
  { hours: 500, bonus: 5000, name: '魔方宗師', emoji: '👑' },
];

// 時數顯示用（四捨五入到小數 1 位）
export const toHours = (v) => Math.round((Number(v) || 0) * 10) / 10;

// 點數 = 時數×每小時點數 + 已達成里程碑的獎勵總和
export function computePoints(totalHours) {
  const h = Number(totalHours) || 0;
  let pts = Math.round(h * POINTS_PER_HOUR);
  for (const m of MILESTONES) if (h >= m.hours) pts += m.bonus;
  return pts;
}

// 目前達成的最高里程碑（未達任何里程碑回 null）
export function highestMilestone(totalHours) {
  const h = Number(totalHours) || 0;
  let earned = null;
  for (const m of MILESTONES) if (h >= m.hours) earned = m;
  return earned;
}

// 下一個里程碑與還差多少小時（已達頂回 null）——給「再 X 小時解鎖」的激勵用
export function nextMilestone(totalHours) {
  const h = Number(totalHours) || 0;
  for (const m of MILESTONES) if (h < m.hours) return { ...m, remain: toHours(m.hours - h) };
  return null;
}

// 稱號：第一名依範圍（年度/歷屆）給頭銜；二三名交給獎牌呈現
export function rankTitle(rank, year) {
  if (rank !== 1) return null;
  return `${year ? `${year} 年度` : '歷屆'}教學王`;
}
