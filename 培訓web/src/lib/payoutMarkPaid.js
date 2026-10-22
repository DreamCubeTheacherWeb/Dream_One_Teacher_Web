// 月結匯款「匯款完成，標記為已付款」（2026-10-22）：從 computePayoutPeople() 的結果算出要送給資料庫的清單與確認框數字。
// 只收「轉帳檔實際納入」的課＝納入的講師（included）底下沒被排除的課，金額＝轉帳檔裡的本次應付；
// 其他（異常課、手動排除的課、對不到講師、資料不全被擋下的講師、取消勾選的講師）一律不標，維持已核准，下次匯款會再出現。
// 資料庫函式 mark_salary_sessions_paid 會逐筆再核對一次（狀態、期別、講師、金額），任一不符整批不改。
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

export const buildMarkPaidPlan = (computed) => {
    const items = [];
    const excluded = {
        anomaly: bucket(),
        manual: bucket(),
        unmatched: bucket(),
        blocked: { ...bucket(), people: 0, reasons: [] },
        unchecked: { ...bucket(), people: 0 },
    };
    const blockedReasons = new Map();
    const adjustments = [];
    const people = [];
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
            items.push({ id: row.session.id, amount: row.payableCents / 100 });
            sessionCents += row.payableCents;
            if (row.payableCents === 0) zeroCount += 1;
            if (toCents(row.session.paid_amount) > toCents(row.session.total_salary)) overpaidCount += 1;
        }
        if (person.adjustmentCents !== 0) {
            adjustmentCents += person.adjustmentCents;
            adjustments.push({ instructor_id: person.instructorId, name: person.name, amount: person.adjustmentCents / 100, reason: person.adjustmentReason });
        }
        people.push(`${person.instructorId}:${person.payCents}`);
    }
    for (const session of computed?.unmatchedSessions || []) add(excluded.unmatched, session.payableCents ?? 0);
    excluded.blocked.reasons = [...blockedReasons.entries()].map(([tag, count]) => ({ tag, people: count }));

    const excludedCount = excluded.anomaly.count + excluded.manual.count + excluded.unmatched.count + excluded.blocked.count + excluded.unchecked.count;
    // 名單指紋：下載轉帳檔當下與按「標記」當下要完全相同（課、各堂金額、各人實付都一樣）才能標
    const fingerprint = JSON.stringify([
        items.map((item) => `${item.id}:${Math.round(item.amount * 100)}`).sort(),
        [...people].sort(),
    ]);
    return {
        items,
        itemCount: items.length,
        peopleCount: people.length,
        sessionCents,
        transferCents: computed?.totalCents ?? sessionCents + adjustmentCents,
        adjustmentCents,
        adjustments,
        zeroCount,
        overpaidCount,
        excluded,
        excludedCount,
        fingerprint,
    };
};

// 確認框「這次不會標記」的每一行（沒有排除就回空陣列）
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

export const isMissingRpcError = (error) => Boolean(error) && (
    error.code === 'PGRST202' || /could not find the function/i.test(String(error.message || ''))
);
export const isMissingTableError = (error) => Boolean(error) && MISSING_TABLE_CODES.has(String(error.code));
export const MIGRATION_NEEDED_TEXT = `需先套用資料庫更新（${MARK_PAID_MIGRATION_FILE}）才能標記已付款。`;

export const markPaidErrorText = (error) => {
    if (isMissingRpcError(error) || isMissingTableError(error)) return MIGRATION_NEEDED_TEXT;
    if (error?.code === '42501') return '只有管理員可以標記或還原已付款。';
    if (error?.code === '22023') return String(error.message || '資料不正確，這次沒有改任何紀錄。');
    return `操作失敗：${error?.message || '請稍後再試'}，這次沒有改任何紀錄。`;
};

// 資料庫回 ok=false 時要列的不符明細（最多 limit 筆，其餘只講筆數）
export const mismatchLines = (mismatches, limit = 10) => {
    const list = Array.isArray(mismatches) ? mismatches : [];
    const lines = list.slice(0, limit).map((m) => `${m.instructor_name || '（無姓名）'}・${m.session_date || '日期不明'}：${m.message || m.reason}`);
    if (list.length > limit) lines.push(`…另有 ${list.length - limit} 筆`);
    return lines;
};

// 批次狀態文字
export const batchStatusText = (batch) => {
    const total = Number(batch?.item_count || 0);
    const reverted = Number(batch?.reverted_count || 0);
    if (reverted <= 0) return '有效';
    if (reverted >= total) return '已全部還原';
    return `已還原 ${reverted}/${total} 筆`;
};
export const amountToCents = toCents;
