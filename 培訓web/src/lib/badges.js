// 徽章判定引擎（資料驅動）
// ───────────────────────────────────────────────────────────────
// 徽章清單存在 DB 的 badge_definitions（後台可增刪改）；每位老師的原始統計由
// RPC get_teacher_badge_stats 提供；badge_overrides 讓 admin 強制給/收回。
// 本檔負責「把三者合起來算出某位老師解鎖了哪些徽章」，供成就牆與後台共用。
//
// rule_type：
//   threshold — 某統計欄位 與 rule_threshold 比大小（rule_operator gte/lte）
//   special   — 特殊邏輯，見 evalSpecialBadge（判定寫在這裡，後台不可新增此類）
//   manual    — 純手動，只能靠 badge_overrides 頒發

// 分類的中文標題與代表色。色循環用 Bauhaus 三原色（紅/藍/黃），
// 遵 DESIGN.md「無綠色」鐵律——別在這裡放綠色，前台/後台都吃這份。
export const BADGE_CATEGORIES = {
  teaching:     { label: '教學里程碑', color: '#D02020' }, // 紅
  wca_cube:     { label: 'WCA・方塊競速', color: '#1040C0' }, // 藍
  level_tenure: { label: '等級・年資', color: '#F0C020' }, // 黃
  region_role:  { label: '地域・角色', color: '#1040C0' }, // 藍
  fun:          { label: '搞笑・彩蛋', color: '#D02020' }, // 紅
};
export const CATEGORY_ORDER = ['teaching', 'wca_cube', 'level_tenure', 'region_role', 'fun'];

// special 徽章的判定（rule_special 代碼 → 是否解鎖）。stats 為 get_teacher_badge_stats 一列。
export function evalSpecialBadge(code, s) {
  if (!s) return false;
  switch (code) {
    case 'wca_has_bf':      return !!s.wca_has_bf;
    case 'wca_has_bigcube': return !!s.wca_has_bigcube;
    case 'level_s':         return s.instructor_level === 'S';
    case 'level_aplus':     return s.instructor_level === 'A+';
    case 'level_a':         return s.instructor_level === 'A';
    case 'level_b':         return s.instructor_level === 'B';
    case 'level_intern':    return s.instructor_level === '實習';
    case 'founder':         return !!s.is_founder;
    case 'region_offshore': return !!s.has_offshore_region;
    case 'streak_6':        return (s.streak_months || 0) >= 6;
    case 'day_4sessions':   return (s.max_day_sessions || 0) >= 4;
    case 'marathon_6h':     return Number(s.max_session_hours || 0) >= 6;
    case 'wca_turtle':      return s.wca_333_single != null && s.wca_333_single > 6000; // 3x3 > 60 秒
    case 'nightowl':        return !!s.has_night_solve;
    default:                return false;
  }
}

// 依規則判定是否解鎖（未套用 override）
export function isEarnedByRule(def, stats) {
  if (!def) return false;
  if (def.rule_type === 'threshold') {
    const v = stats ? stats[def.rule_metric] : null;
    if (v == null) return false;
    const n = Number(v);
    if (Number.isNaN(n)) return false;
    return def.rule_operator === 'lte'
      ? n <= Number(def.rule_threshold)
      : n >= Number(def.rule_threshold);
  }
  if (def.rule_type === 'special') return evalSpecialBadge(def.rule_special, stats);
  return false; // manual：只能靠 override
}

// 主函式：合併 定義 + 統計 + 覆蓋，回傳每個徽章的解鎖狀態
// definitions: badge_definitions（建議只傳 active=true）
// stats: get_teacher_badge_stats 的一列（可能為 null，代表沒統計）
// overrides: 該老師的 badge_overrides 陣列 [{badge_key, state}]
// 回傳：[{...def, earned, source}]，source = 'granted'|'revoked'|'auto'|'locked'
export function computeBadges(definitions = [], stats = null, overrides = []) {
  const ovr = new Map((overrides || []).map((o) => [o.badge_key, o.state]));
  return (definitions || [])
    .map((def) => {
      const override = ovr.get(def.key);
      const ruleEarned = isEarnedByRule(def, stats);
      let earned = ruleEarned;
      let source = ruleEarned ? 'auto' : 'locked';
      if (override === 'granted') { earned = true; source = 'granted'; }
      else if (override === 'revoked') { earned = false; source = 'revoked'; }
      return { ...def, earned, source };
    })
    .sort((a, b) => {
      const ca = CATEGORY_ORDER.indexOf(a.category);
      const cb = CATEGORY_ORDER.indexOf(b.category);
      if (ca !== cb) return ca - cb;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });
}

// 便利抓取：一次取回 定義 + 該老師統計 + 覆蓋，算好回傳。
// supabase 由呼叫端傳入（避免猜 import 路徑）。
export async function fetchTeacherBadges(supabase, instructorId) {
  const [defsRes, statsRes, ovrRes] = await Promise.all([
    supabase.from('badge_definitions').select('*').eq('active', true),
    supabase.rpc('get_teacher_badge_stats', { p_instructor_id: instructorId }),
    supabase.from('badge_overrides').select('badge_key, state').eq('instructor_id', instructorId),
  ]);
  const definitions = defsRes.data || [];
  // rpc 回一列（或陣列取第一列）
  const stats = Array.isArray(statsRes.data) ? statsRes.data[0] : statsRes.data;
  const overrides = ovrRes.data || [];
  const badges = computeBadges(definitions, stats, overrides);
  return { badges, stats: stats || null, error: defsRes.error || statsRes.error || ovrRes.error || null };
}

// 給成就牆用：把徽章依分類分組（只回有徽章的分類，照 CATEGORY_ORDER）
export function groupByCategory(badges = []) {
  return CATEGORY_ORDER
    .map((cat) => ({
      key: cat,
      ...BADGE_CATEGORIES[cat],
      badges: badges.filter((b) => b.category === cat),
    }))
    .filter((g) => g.badges.length > 0);
}
