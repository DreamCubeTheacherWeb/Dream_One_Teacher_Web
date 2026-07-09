// ═══════════════════════════════════════════════════════════════
// WCA 賽事排行榜顯示規則：項目中文對照 + 成績格式化。
// 注意：這裡的 best_ms 單位是「百分之一秒（centiseconds）」，
// 跟方塊競速頁面 cubeEngine.formatCubeTime 吃的「毫秒」不同單位，
// 兩邊格式化函式不可互換使用。
// ═══════════════════════════════════════════════════════════════

// event_id → 中文名稱。下拉選單只顯示 get_wca_events() 實際回傳的項目，
// 找不到對照的代碼就直接顯示原始 event_id。
export const WCA_EVENT_NAMES = {
  '333': '三階',
  '222': '二階',
  '444': '四階',
  '555': '五階',
  '666': '六階',
  '777': '七階',
  '333oh': '三階單手',
  '333bf': '三階盲解',
  '444bf': '四階盲解',
  '555bf': '五階盲解',
  '333fm': '三階最少步',
  '333mbf': '三階多顆盲解',
  pyram: '金字塔',
  skewb: 'Skewb 斜方',
  minx: '五魔方',
  clock: '魔錶',
  sq1: 'Square-1',
};

export const wcaEventName = (eventId) => WCA_EVENT_NAMES[eventId] || eventId;

// 老師「自填」時可選的時間制項目（順序＝顯示順序）。
// 刻意排除 333fm（最少步，值＝步數）與 333mbf（多顆盲解，複合編碼）──格式難自填、
// 易亂填，與離線匯入的排除規則一致。後端 upsert_my_wca_results 的白名單須與此一致。
export const WCA_SELF_EVENTS = [
  '333', '222', '444', '555', '666', '777',
  '333oh', '333bf', '444bf', '555bf',
  'pyram', 'skewb', 'minx', 'clock', 'sq1',
].map((id) => ({ id, name: WCA_EVENT_NAMES[id] || id }));

/**
 * 老師輸入的時間字串 → centiseconds（整數）。給 upsert_my_wca_results 用。
 * 接受格式：'12.34'（秒.百分秒）、'1:23.45'（分:秒.百分秒）、'9'（純秒）。
 * 空字串 → null（＝未填）；無法解析 → NaN（呼叫端據此擋下並提示）。
 * 註：與 formatWcaResult 為一組往返函式（formatWcaResult 產出的字串可被本函式解析回原值）。
 */
export function parseTimeToCs(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,2}))?$/);
  if (!m) return NaN;
  const min = m[1] ? parseInt(m[1], 10) : 0;
  const sec = parseInt(m[2], 10);
  // 有分鐘時，秒數必須 < 60（例如 '1:75.00' 不合法）
  if (m[1] && sec >= 60) return NaN;
  const cs = m[3] ? parseInt(m[3].padEnd(2, '0'), 10) : 0;
  return (min * 60 + sec) * 100 + cs;
}

/**
 * centiseconds → 顯示字串。
 * <6000 → `S.cs`（如 1234 → "12.34"）；>=6000 → `M:SS.cs`（如 8567 → "1:25.67"）。
 *
 * 例外：
 * - 333fm（最少步）：值＝步數×100，v1 顯示整數步數（如 2500 → "25 步"）。
 *   TODO：若後端改傳其他編碼（例如平均步數含小數）需要重新確認。
 * - 333mbf（多顆盲解）：官方用複合編碼（成功數/嘗試數/時間打包），
 *   v1 先原始數字顯示，之後有真實資料再補正式解析。
 */
export function formatWcaResult(eventId, value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '—';

  if (eventId === '333fm') {
    return `${Math.round(v / 100)} 步`;
  }
  if (eventId === '333mbf') {
    return `${v}`;
  }

  const cs = Math.round(v);
  const totalSec = Math.floor(cs / 100);
  const rem = String(cs % 100).padStart(2, '0');
  if (cs < 6000) {
    return `${totalSec}.${rem}`;
  }
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, '0');
  return `${min}:${sec}.${rem}`;
}

// 給 LeaderboardView 用的 metric 設定（時間/步數越小名次越前）。
// championTitle：「台灣最速傳說」只在三階（333）出現，其餘項目不設稱號（值為 null）。
export function wcaMetric(eventId, type) {
  return {
    label: type === 'average' ? '平均成績' : '單次成績',
    unit: '',
    accent: 'blue',
    higherIsBetter: false,
    getValue: (r) => r.best_ms,
    format: (v) => formatWcaResult(eventId, v),
    championTitle: eventId === '333' ? '台灣最速傳說' : null,
  };
}

// WCA 全能王排行榜（get_wca_allaround_leaderboard）的 metric 設定。
// score 越大越好；沒有 event/type 區分，因此是單一常數而非工廠函式。
export const WCA_ALLAROUND_METRIC = {
  label: '全能積分',
  unit: '分',
  accent: 'blue',
  higherIsBetter: true,
  getValue: (r) => r.score,
  format: (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(2) : '—';
  },
  championTitle: '六面全能之神',
};
