// 「我的報酬」黃卡：X 月累計報酬＋下次匯款日（2026-10-20 業主需求）
// 規則：每月固定一天（預設 10 號）匯上一期的報酬，例如 12/10 匯「11 月」。
// 一期＝結算週期「上月 26 日～本月 25 日」，以結束的月份命名：11 月＝10/26～11/25（業主 10/20 確認；
// 同日業主也說「9/26 以後的才沒有付款」，與舊表單說明「每月 25 號結算（上月 26 日～本月 25 日）」一致）。
// 後台可改「下次匯款日」（遇假日提前／延後）；日期過了自動跳到下一期的固定日，不必每月去改。
// 提前／延後的日期屬於「最接近它的那個固定日」那一期：固定 28 號、12/28 延到 1/4，仍是匯 11 月。
// 日期一律用 'YYYY-MM-DD' 字串運算，不經過 Date 物件的時區，避免日期被推前一天。

export const DEFAULT_PAYDAY_DAY = 10;
export const PAYDAY_DAY_MIN = 1;
export const PAYDAY_DAY_MAX = 28;
export const SETTLEMENT_CUTOFF_DAY = 25;  // 每期結算到這天（含），下一期從隔天開始

// salary_payout_schedule 還沒建（migration 20261020160000 尚未套用）時 PostgREST 回的代碼
export const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

const pad = (n) => String(n).padStart(2, '0');
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const toIso = ({ year, month, day }) => `${year}-${pad(month)}-${pad(day)}`;
const dayNumber = ({ year, month, day }) => Date.UTC(year, month - 1, day) / 86400000;
const shiftMonth = ({ year, month }, delta) => {
    const index = year * 12 + (month - 1) + delta;
    return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};
const paydayIn = (yearMonth, day) => ({ ...yearMonth, day: Math.min(day, daysInMonth(yearMonth.year, yearMonth.month)) });
const monthLabelOf = ({ year, month }) => `${year}/${pad(month)}`;

// 「YYYY 年 M 月」那一期的結算區間：上月 26 日～本月 25 日
const settlementOf = (yearMonth) => {
    const previous = shiftMonth(yearMonth, -1);
    return {
        periodMonth: monthLabelOf(yearMonth),
        periodStart: toIso({ ...previous, day: SETTLEMENT_CUTOFF_DAY + 1 }),
        periodEnd: toIso({ ...yearMonth, day: SETTLEMENT_CUTOFF_DAY }),
    };
};

export const parseIsoDate = (value) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return { year, month, day };
};

export const normalizePaydayDay = (value) => {
    const day = Number(value);
    return Number.isInteger(day) && day >= PAYDAY_DAY_MIN && day <= PAYDAY_DAY_MAX ? day : DEFAULT_PAYDAY_DAY;
};

// 這個日期是哪一期的匯款：前一個月、當月、下個月三個固定日裡最接近的那個（等距取較早的）
const periodOf = (date, day) => {
    let best = null;
    for (const delta of [-1, 0, 1]) {
        const candidate = paydayIn(shiftMonth(date, delta), day);
        const distance = Math.abs(dayNumber(candidate) - dayNumber(date));
        if (!best || distance < best.distance) best = { candidate, distance };
    }
    return { year: best.candidate.year, month: best.candidate.month };
};

// 下次匯款日與它匯的那一期（periodMonth 'YYYY/MM'、periodStart／periodEnd 'YYYY-MM-DD'）：
// 後台設定的日期還沒過（含當天）就用它；過了（或沒設定）就從它那一期的下一期起，找第一個不早於今天的固定日。
export const resolvePayout = ({ nextPayday, regularDay } = {}, today) => {
    const todayParts = parseIsoDate(today);
    if (!todayParts) throw new Error(`today 必須是 YYYY-MM-DD：${today}`);
    const day = normalizePaydayDay(regularDay);
    const stored = parseIsoDate(nextPayday);
    if (stored && toIso(stored) >= today) {
        return { payday: toIso(stored), ...settlementOf(shiftMonth(periodOf(stored, day), -1)) };
    }

    let period = stored ? shiftMonth(periodOf(stored, day), 1) : { year: todayParts.year, month: todayParts.month };
    for (let guard = 0; guard < 1200; guard += 1) {
        const candidate = toIso(paydayIn(period, day));
        if (candidate >= today) return { payday: candidate, ...settlementOf(shiftMonth(period, -1)) };
        period = shiftMonth(period, 1);
    }
    throw new Error('找不到下次匯款日');
};

// 某一期（'YYYY/MM'）照固定日該在哪天匯：那一期的隔月固定日（'2026/10', 10 → '2026-11-10'）
export const regularPaydayFor = (periodMonth, regularDay) => {
    const match = /^(\d{4})\/(\d{2})$/.exec(String(periodMonth ?? ''));
    if (!match) return null;
    const next = shiftMonth({ year: Number(match[1]), month: Number(match[2]) }, 1);
    return toIso(paydayIn(next, normalizePaydayDay(regularDay)));
};

// 後台「本期匯款完成」可選的期別：「目前這一期」（resolvePayout 那一期）往前共 count 期，新到舊。
// ended＝結束日已過（早於今天）；還沒結束的期別不能標已付款（資料庫函式也會擋）。
// 預設選目前這一期；它還沒結束（例：匯款日 11/10 過了，目前這一期換成 10/26～11/25）就預設上一期。
export const markPaidPeriodChoices = (schedule, today, count = 4) => {
    const current = resolvePayout(schedule, today);
    const [year, month] = current.periodMonth.split('/').map(Number);
    const choices = Array.from({ length: count }, (_, index) => {
        const period = settlementOf(shiftMonth({ year, month }, -index));
        return { ...period, ended: period.periodEnd < today, payday: index === 0 ? current.payday : null };
    });
    return { choices, defaultMonth: (choices[0].ended ? choices[0] : choices[1]).periodMonth };
};

// 「本期匯款完成」要標記的列（已核准、在區間內）→ 確認框要列的數字。
// amount＝總額合計（資料庫函式回傳、比對的也是它）；之前已記錄付過一部分的列另算「這次實際要匯」，
// 已付超過總額的列另外點出來（標記後已領一律改成總額）；異常列提醒先確認是不是重複登記。
export const summarizeMarkPaid = (rows) => {
    const summary = { count: 0, amount: 0, prepaidCount: 0, prepaidAmount: 0, toTransfer: 0, overpaidCount: 0, anomalyCount: 0 };
    for (const row of rows || []) {
        const total = Number(row?.total_salary || 0);
        const paid = Number(row?.paid_amount || 0);
        summary.count += 1;
        summary.amount += total;
        summary.toTransfer += Math.max(total - paid, 0);
        if (paid > 0) {
            summary.prepaidCount += 1;
            summary.prepaidAmount += paid;
        }
        if (paid > total) summary.overpaidCount += 1;
        if (row?.is_anomaly) summary.anomalyCount += 1;
    }
    return summary;
};

// 前端讀 salary_payout_schedule 的結果 → 設定值；表還沒建或讀不到列時用每月 10 號，
// 其他錯誤（網路、伺服器）也先用 10 號，但標 failed 讓畫面註明「預估」。
export const payoutScheduleFromResponse = ({ data, error } = {}) => {
    if (error) return { nextPayday: null, regularDay: null, failed: !MISSING_TABLE_CODES.has(error.code) };
    return { nextPayday: data?.next_payday ?? null, regularDay: data?.regular_day ?? null, failed: false };
};

// '2026/11' → '11月'
export const monthNameOf = (monthLabel) => {
    const match = /^\d{4}\/(\d{2})$/.exec(String(monthLabel ?? ''));
    return match ? `${Number(match[1])}月` : '';
};

// '2026-12-10' → '12/10'
export const shortDateOf = (iso) => {
    const parts = parseIsoDate(iso);
    return parts ? `${parts.month}/${parts.day}` : '';
};

// 該期（periodStart～periodEnd，含頭尾）的累計：退回的不算；待核准的算進總額，另外列出來
export const summarizePayrollPeriod = (sessions, { periodStart, periodEnd }) => {
    let total = 0;
    let count = 0;
    let pendingTotal = 0;
    let awaitingPriceCount = 0;
    for (const session of sessions || []) {
        const date = String(session?.session_date ?? '').slice(0, 10);
        if (!date || date < periodStart || date > periodEnd || session.pricing_status === 'rejected') continue;
        count += 1;
        if (session.pricing_status === 'needs_review') {
            awaitingPriceCount += 1;
            continue;
        }
        const amount = Number(session.total_salary || 0);
        total += amount;
        if (session.status === 'pending') pendingTotal += amount;
    }
    return { total, count, pendingTotal, awaitingPriceCount };
};
