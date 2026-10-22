import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransferRows, computePayoutPeople } from './payoutBankExport.js';
import {
    MIGRATION_NEEDED_TEXT,
    batchStatusText,
    buildMarkPaidPlan,
    exclusionLines,
    markPaidErrorText,
    mismatchLines,
} from './payoutMarkPaid.js';

const ok = (id, name, overrides = {}) => ({
    id, full_name: name, bank_code: '0081832', bank_account_number: '00291234567890', bank_account_name: name,
    id_number: 'A123456789', email_primary: `${id}@example.test`, partner_no: 'A1', ...overrides,
});
const INSTRUCTORS = [
    ok('i-ding', '丁一'),
    ok('i-wang', '王二', { partner_no: 'A2' }),
    ok('i-lin', '林三', { bank_account_number: '' }),       // 缺帳號 → 擋下
    ok('i-chen', '陳四', { partner_no: 'A4' }),             // 管理員取消勾選
];
const s = (id, instructorId, total, { paid = 0, anomaly = false, base } = {}) => ({
    id, instructor_id: instructorId, instructor_name: 'x', session_date: '2026-09-10', course_type: 'regular_basic', course_name: id,
    base_salary: base ?? total, bonus: 0, total_salary: total, paid_amount: paid, status: 'approved', pricing_status: 'quoted',
    is_anomaly: anomaly, anomaly_reasons: anomaly ? ['疑似重複'] : [],
});
const SESSIONS = [
    s('s-ding-1', 'i-ding', 1000),
    s('s-ding-2', 'i-ding', 600, { paid: 100 }),            // 本次應付 500
    s('s-ding-over', 'i-ding', 300, { paid: 500 }),         // 已領超過總額 → 應付 0
    s('s-ding-dup', 'i-ding', 1000, { anomaly: true }),     // 異常 → 預設排除
    s('s-wang-1', 'i-wang', 1200),
    s('s-wang-x', 'i-wang', 650),                           // 手動排除
    s('s-lin-1', 'i-lin', 900),                             // 擋下的人
    s('s-chen-1', 'i-chen', 700),                           // 取消勾選的人
    s('s-none', null, 350),                                 // 對不到講師
];
const EDITS = {
    excludedSessionIds: new Set(['s-wang-x']),
    excludedInstructorIds: new Set(['i-chen']),
    adjustments: { 'i-wang': { amount: '-200', reason: '扣回溢付' } },
};
const compute = (edits = EDITS) => computePayoutPeople({ sessions: SESSIONS, instructors: INSTRUCTORS, periodMonth: '2026/09', edits });

test('只收轉帳檔實際納入的課：納入講師底下沒被排除的課，金額＝本次應付', () => {
    const plan = buildMarkPaidPlan(compute());
    assert.deepEqual(plan.items.map((item) => `${item.id}:${item.amount}`).sort(), ['s-ding-1:1000', 's-ding-2:500', 's-ding-over:0', 's-wang-1:1200']);
    assert.equal(plan.itemCount, 4);
    assert.equal(plan.peopleCount, 2);
    assert.equal(plan.sessionCents, 270000);
    assert.equal(plan.zeroCount, 1);
    assert.equal(plan.overpaidCount, 1);
});

test('清單與轉帳檔同一份資料：清單的人＝轉帳檔的人，課程應付＋人工調整＝轉帳檔總額', () => {
    const computed = compute();
    const plan = buildMarkPaidPlan(computed);
    const rows = buildTransferRows({ people: computed.people, settings: { payDate: '2026-10-10', payerAccount: '1', payerBranch: '0001', noticeMethod: '3', feeBearer: '2' } });
    const fileCents = rows.reduce((sum, row) => sum + Math.round(Number(row[7]) * 100), 0);
    assert.equal(rows.length, plan.peopleCount);
    assert.equal(plan.transferCents, fileCents);
    assert.equal(plan.sessionCents + plan.adjustmentCents, fileCents);
    assert.deepEqual(plan.adjustments, [{ instructor_id: 'i-wang', name: '王二', amount: -200, reason: '扣回溢付' }]);
});

test('被排除的課分類互斥、筆數與金額正確，確認框逐行列出原因', () => {
    const plan = buildMarkPaidPlan(compute());
    assert.deepEqual(plan.excluded.anomaly, { count: 1, cents: 100000 });
    assert.deepEqual(plan.excluded.manual, { count: 1, cents: 65000 });
    assert.deepEqual(plan.excluded.unmatched, { count: 1, cents: 35000 });
    assert.equal(plan.excluded.blocked.people, 1);
    assert.equal(plan.excluded.blocked.count, 1);
    assert.deepEqual(plan.excluded.blocked.reasons, [{ tag: '缺帳號', people: 1 }]);
    assert.equal(plan.excluded.unchecked.people, 1);
    assert.equal(plan.excludedCount, 5);
    assert.deepEqual(exclusionLines(plan), [
        '異常標記預設排除 1 筆（$1,000）',
        '手動排除的課 1 筆（$650）',
        '對不到講師 1 筆（$350）',
        '資料不全被擋下的講師 1 位、1 筆（$900）：缺帳號 1 位',
        '取消勾選的講師 1 位、1 筆（$700）',
    ]);
    // 每一堂課剛好落在一個地方：納入＋各種排除＝全部
    assert.equal(plan.itemCount + plan.excludedCount, SESSIONS.length);
});

test('勾回異常課、改調整金額、取消勾選，指紋都會變（下載後有變動就要重新下載）', () => {
    const base = buildMarkPaidPlan(compute()).fingerprint;
    assert.equal(buildMarkPaidPlan(compute()).fingerprint, base, '同一份資料指紋相同');
    const withAnomaly = buildMarkPaidPlan(compute({ ...EDITS, includedAnomalySessionIds: new Set(['s-ding-dup']) }));
    assert.notEqual(withAnomaly.fingerprint, base);
    assert.ok(withAnomaly.items.some((item) => item.id === 's-ding-dup'));
    const newAdjustment = buildMarkPaidPlan(compute({ ...EDITS, adjustments: { 'i-wang': { amount: '-300', reason: '扣回溢付' } } }));
    assert.notEqual(newAdjustment.fingerprint, base);
    const unchecked = buildMarkPaidPlan(compute({ ...EDITS, excludedInstructorIds: new Set(['i-chen', 'i-ding']) }));
    assert.notEqual(unchecked.fingerprint, base);
    assert.ok(!unchecked.items.some((item) => item.id.startsWith('s-ding')));
});

test('沒有資料時回空清單', () => {
    const plan = buildMarkPaidPlan(null);
    assert.equal(plan.itemCount, 0);
    assert.equal(plan.excludedCount, 0);
    assert.deepEqual(exclusionLines(plan), []);
});

test('錯誤訊息：函式或表不存在→需先套用資料庫更新；42501；22023 原文', () => {
    assert.equal(markPaidErrorText({ code: 'PGRST202', message: 'Could not find the function public.mark_salary_sessions_paid' }), MIGRATION_NEEDED_TEXT);
    assert.equal(markPaidErrorText({ code: '404', message: 'Could not find the function x' }), MIGRATION_NEEDED_TEXT);
    assert.equal(markPaidErrorText({ code: 'PGRST205', message: 'table' }), MIGRATION_NEEDED_TEXT);
    assert.match(MIGRATION_NEEDED_TEXT, /20261022140000_mark_salary_sessions_paid\.sql/);
    assert.equal(markPaidErrorText({ code: '42501', message: 'x' }), '只有管理員可以標記或還原已付款。');
    assert.equal(markPaidErrorText({ code: '22023', message: '這一期到 10/25 才結束，結束後才能標記已付款。' }), '這一期到 10/25 才結束，結束後才能標記已付款。');
    assert.match(markPaidErrorText({ code: 'XX000', message: 'boom' }), /操作失敗：boom/);
});

test('不符明細最多列 10 筆，其餘只講筆數；批次狀態文字', () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ instructor_name: `講師${i}`, session_date: '2026-09-01', message: '狀態已不是「已核准」（現在：已付款）' }));
    const lines = mismatchLines(list);
    assert.equal(lines.length, 11);
    assert.equal(lines[0], '講師0・2026-09-01：狀態已不是「已核准」（現在：已付款）');
    assert.equal(lines[10], '…另有 2 筆');
    assert.equal(batchStatusText({ item_count: 8, reverted_count: 0 }), '有效');
    assert.equal(batchStatusText({ item_count: 8, reverted_count: 7 }), '已還原 7/8 筆');
    assert.equal(batchStatusText({ item_count: 8, reverted_count: 8 }), '已全部還原');
});
