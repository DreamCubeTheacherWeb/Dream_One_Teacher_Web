// 月結匯款：下載轉帳檔時存「匯出紀錄」、匯款完成後對那一份標記已付款（2026-10-22）。純函式，有單元測試。
// buildExportPayload：從 computePayoutPeople() 的結果算出要存進資料庫的清單＝轉帳檔實際納入的課
//   （納入的講師底下沒被排除的課，金額＝本次應付，連同講師），以及每位講師的實付與人工調整。
//   其他（異常課、手動排除的課、對不到講師、資料不全被擋下的講師、取消勾選的講師）不在清單裡，維持已核准，下次匯款會再出現。
// 資料庫 record_salary_payout_export 存的時候、mark_salary_payout_export_paid 標的時候都會逐筆再核對
//   （狀態、期別、講師、金額），任一不符整份不存／不改。
import { formatMoney } from './payoutBankExport.js';

export const MARK_PAID_MIGRATION_FILE = '20261022140000_mark_salary_sessions_paid.sql';
const MISSING_TABLE_CODES = new Set(['42P01', 'PGRST205']);

const toCents = (value) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const bucket = () => ({ count: 0, cents: 0 });
const add = (target, cents) => {
    target.count += 1;
    target.cents += cents;
};

export const buildExportPayload = (computed) => {
    const items = [];
    const people = [];
    const excluded = {
        anomaly: bucket(),
        manual: bucket(),
        unmatched: bucket(),
        blocked: { ...bucket(), people: 0, reasons: [] },
        unchecked: { ...bucket(), people: 0 },
    };
    const blockedReasons = new Map();
    let sessionCents = 0;
    let adjustmentCents = 0;
    let zeroCount = 0;
    let overpaidCount = 0;

    for (const person of computed?.people || []) {
        if (person.blocked) {
            excluded.blocked.people += 1;
            for (const row of person.sessions) add(excluded.blocked, row.payableCents);
            for (const tag of new Set(person.blockerTags || [])) blockedReasons.set(tag, (blockedReasons.get(tag) || 0) + 1);
            continue;
        }
        if (!person.included) {
            excluded.unchecked.people += 1;
            for (const row of person.sessions) add(excluded.unchecked, row.payableCents);
            continue;
        }
        for (const row of person.sessions) {
            if (row.excluded) {
                add(row.anomaly ? excluded.anomaly : excluded.manual, row.payableCents);
                continue;
            }
            items.push({ id: row.session.id, instructor_id: person.instructorId, amount: row.payableCents / 100 });
            sessionCents += row.payableCents;
            if (row.payableCents === 0) zeroCount += 1;
            if (toCents(row.session.paid_amount) > toCents(row.session.total_salary)) overpaidCount += 1;
        }
        adjustmentCents += person.adjustmentCents;
        people.push({
            instructor_id: person.instructorId,
            name: String(person.name || '').slice(0, 200),
            amount: person.payCents / 100,
            adjustment: person.adjustmentCents / 100,
            adjustment_reason: person.adjustmentCents !== 0 ? String(person.adjustmentReason || '').slice(0, 500) : null,
        });
    }
    for (const session of computed?.unmatchedSessions || []) add(excluded.unmatched, session.payableCents ?? 0);
    excluded.blocked.reasons = [...blockedReasons.entries()].map(([tag, count]) => ({ tag, people: count }));
    const excludedCount = excluded.anomaly.count + excluded.manual.count + excluded.unmatched.count + excluded.blocked.count + excluded.unchecked.count;

    const plan = {
        items,
        people,
        itemCount: items.length,
        peopleCount: people.length,
        sessionCents,
        transferCents: computed?.totalCents ?? sessionCents + adjustmentCents,
        adjustmentCents,
        zeroCount,
        overpaidCount,
        excluded,
        excludedCount,
    };
    return { ...plan, exclusionLines: exclusionLines(plan) };
};

// 「下載當時沒有納入」的每一行（沒有排除就回空陣列）；存進匯出紀錄，標記時的確認框會列出來
export const exclusionLines = (plan) => {
    const lines = [];
    const { anomaly, manual, unmatched, blocked, unchecked } = plan?.excluded || {};
    if (anomaly?.count) lines.push(`異常標記預設排除 ${anomaly.count} 筆（${formatMoney(anomaly.cents)}）`);
    if (manual?.count) lines.push(`手動排除的課 ${manual.count} 筆（${formatMoney(manual.cents)}）`);
    if (unmatched?.count) lines.push(`對不到講師 ${unmatched.count} 筆（${formatMoney(unmatched.cents)}）`);
    if (blocked?.people) {
        const reasons = blocked.reasons.map((reason) => `${reason.tag} ${reason.people} 位`).join('、');
        lines.push(`資料不全被擋下的講師 ${blocked.people} 位、${blocked.count} 筆（${formatMoney(blocked.cents)}）：${reasons}`);
    }
    if (unchecked?.people) lines.push(`取消勾選的講師 ${unchecked.people} 位、${unchecked.count} 筆（${formatMoney(unchecked.cents)}）`);
    return lines;
};

// 負數人工調整（扣款）：確認框要列出來並勾選確認
export const negativeAdjustments = (people) => (Array.isArray(people) ? people : [])
    .filter((person) => toCents(person?.adjustment) < 0)
    .map((person) => ({ name: person.name || '（未填姓名）', cents: toCents(person.adjustment), reason: person.adjustment_reason || '' }));

export const isMissingRpcError = (error) => Boolean(error) && (
    error.code === 'PGRST202' || /could not find the function/i.test(String(error.message || ''))
);
export const isMissingTableError = (error) => Boolean(error) && MISSING_TABLE_CODES.has(String(error.code));
export const MIGRATION_NEEDED_TEXT = `需先套用資料庫更新（${MARK_PAID_MIGRATION_FILE}）才能建立匯出紀錄與標記已付款。`;
export const UNCERTAIN_TEXT = '結果不確定（網路或伺服器沒有正常回應），不知道這次有沒有寫進資料庫。請按「重新讀取」確認這一期的匯出紀錄與狀態後再決定下一步。';

// 呼叫資料庫函式失敗時，分成三種：
//   missing  ＝資料庫還沒套這次的更新（函式或表不存在）
//   definite ＝資料庫明確回錯（HTTP 4xx 且帶錯誤代碼）：函式整個取消，什麼都沒改
//   uncertain＝網路斷線、逾時、5xx、回應看不懂：不知道有沒有寫進去，要重新讀取確認
export const classifyRpcFailure = ({ error, status } = {}) => {
    if (isMissingRpcError(error) || isMissingTableError(error)) return { kind: 'missing', text: MIGRATION_NEEDED_TEXT };
    const code = String(error?.code ?? '');
    if (error && Number(status) >= 400 && Number(status) < 500 && code) {
        if (code === '42501') return { kind: 'definite', text: '只有管理員可以做這件事，這次沒有改任何紀錄。' };
        if (code === '22023') return { kind: 'definite', text: String(error.message || '資料不正確，這次沒有改任何紀錄。') };
        return { kind: 'definite', text: `資料庫拒絕這次操作（${code}：${error.message || '未說明'}），這次沒有改任何紀錄。` };
    }
    return { kind: 'uncertain', text: UNCERTAIN_TEXT };
};

// 資料庫回 ok=false 時要列的不符明細（最多 limit 筆，其餘只講筆數）
export const mismatchLines = (mismatches, limit = 10) => {
    const list = Array.isArray(mismatches) ? mismatches : [];
    const lines = list.slice(0, limit).map((m) => `${m.instructor_name || '（無姓名）'}・${m.session_date || '日期不明'}：${m.message || m.reason}`);
    if (list.length > limit) lines.push(`…另有 ${list.length - limit} 筆`);
    return lines;
};

// 匯出紀錄的狀態文字
export const exportStatusText = (row) => {
    if (!row?.marked_at) return '未標記';
    const total = Number(row.marked_count ?? row.item_count ?? 0);
    const reverted = Number(row.reverted_count || 0);
    if (reverted <= 0) return '已標記';
    if (reverted >= total) return '已還原';
    return `已還原 ${reverted}/${total} 筆`;
};
// 下載前提醒：這一期已有還沒標記的匯出（再下載一份會包含同樣的課，兩份都上傳會重複匯款）
export const duplicateExportWarning = (rows) => {
    const ids = (Array.isArray(rows) ? rows : []).map((row) => `#${row.id}`).join('、');
    return `這一期已有尚未標記的匯出 ${ids}。如果 ${ids} 已經交給銀行，請先回去標記它；再下載一份會包含同樣的課，兩份都上傳會重複匯款。確定要再下載一份嗎？`;
};
// 台北時間 YYYY/MM/DD HH:mm
export const formatTaipeiTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
export const canRevertExport = (row) => Boolean(row?.marked_at) && Number(row.reverted_count || 0) < Number(row.marked_count ?? row.item_count ?? 0);
export const amountToCents = toCents;
