import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTransferRows, computePayoutPeople } from './payoutBankExport.js';
import {
    MIGRATION_NEEDED_TEXT,
    UNCERTAIN_TEXT,
    buildExportPayload,
    canRevertExport,
    classifyRpcFailure,
    exportStatusText,
    mismatchLines,
    negativeAdjustments,
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
const s = (id, instructorId, total, { paid = 0, anomaly = false } = {}) => ({
    id, instructor_id: instructorId, instructor_name: 'x', session_date: '2026-09-10', course_type: 'regular_basic', course_name: id,
    base_salary: total, bonus: 0, total_salary: total, paid_amount: paid, status: 'approved', pricing_status: 'quoted',
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

test('清單只收轉帳檔實際納入的課（連同講師），金額＝本次應付', () => {
    const plan = buildExportPayload(compute());
    assert.deepEqual(plan.items.map((item) => `${item.id}:${item.instructor_id}:${item.amount}`).sort(),
        ['s-ding-1:i-ding:1000', 's-ding-2:i-ding:500', 's-ding-over:i-ding:0', 's-wang-1:i-wang:1200']);
    assert.equal(plan.itemCount, 4);
    assert.equal(plan.peopleCount, 2);
    assert.equal(plan.sessionCents, 270000);
    assert.equal(plan.zeroCount, 1);
    assert.equal(plan.overpaidCount, 1);
});

test('每位講師的實付＝轉帳檔那一列；實付＝他的課加總＋人工調整；合計＝轉帳檔總額', () => {
    const computed = compute();
    const plan = buildExportPayload(computed);
    const rows = buildTransferRows({ people: computed.people, settings: { payDate: '2026-10-10', payerAccount: '1', payerBranch: '0001', noticeMethod: '3', feeBearer: '2' } });
    assert.deepEqual(plan.people.map((p) => `${p.name}:${p.amount}`), rows.map((row) => `${row[6]}:${row[7]}`));
    assert.deepEqual(plan.people, [
        { instructor_id: 'i-ding', name: '丁一', amount: 1500, adjustment: 0, adjustment_reason: null },
        { instructor_id: 'i-wang', name: '王二', amount: 1000, adjustment: -200, adjustment_reason: '扣回溢付' },
    ]);
    for (const person of plan.people) {
        const sessions = plan.items.filter((item) => item.instructor_id === person.instructor_id).reduce((sum, item) => sum + item.amount * 100, 0);
        assert.equal(Math.round(person.amount * 100), sessions + Math.round(person.adjustment * 100));
    }
    assert.equal(plan.transferCents, plan.people.reduce((sum, p) => sum + Math.round(p.amount * 100), 0));
    assert.equal(plan.transferCents, 250000);
});

test('被排除的課分類互斥、筆數與金額正確，摘要逐行列出原因', () => {
    const plan = buildExportPayload(compute());
    assert.equal(plan.excludedCount, 5);
    assert.deepEqual(plan.exclusionLines, [
        '異常標記預設排除 1 筆（$1,000）',
        '手動排除的課 1 筆（$650）',
        '對不到講師 1 筆（$350）',
        '資料不全被擋下的講師 1 位、1 筆（$900）：缺帳號 1 位',
        '取消勾選的講師 1 位、1 筆（$700）',
    ]);
    assert.equal(plan.itemCount + plan.excludedCount, SESSIONS.length);
});

test('勾回異常課就會進清單；沒有資料時回空', () => {
    const withAnomaly = buildExportPayload(compute({ ...EDITS, includedAnomalySessionIds: new Set(['s-ding-dup']) }));
    assert.ok(withAnomaly.items.some((item) => item.id === 's-ding-dup'));
    const empty = buildExportPayload(null);
    assert.equal(empty.itemCount, 0);
    assert.deepEqual(empty.exclusionLines, []);
});

test('負數人工調整列出姓名、金額、原因', () => {
    const plan = buildExportPayload(compute());
    assert.deepEqual(negativeAdjustments(plan.people), [{ name: '王二', cents: -20000, reason: '扣回溢付' }]);
    assert.deepEqual(negativeAdjustments([{ name: 'x', adjustment: 300 }]), []);
});

test('失敗分類：函式／表不存在＝需先更新；4xx 帶代碼＝確定沒改；斷線、5xx、看不懂＝結果不確定', () => {
    assert.deepEqual(classifyRpcFailure({ error: { code: 'PGRST202', message: 'Could not find the function' }, status: 404 }), { kind: 'missing', text: MIGRATION_NEEDED_TEXT });
    assert.equal(classifyRpcFailure({ error: { code: 'PGRST205', message: 'table' }, status: 404 }).kind, 'missing');
    assert.match(MIGRATION_NEEDED_TEXT, /20261022140000_mark_salary_sessions_paid\.sql/);
    assert.deepEqual(classifyRpcFailure({ error: { code: '22023', message: '這一期到 10/25 才結束，結束後才能標記已付款。' }, status: 400 }),
        { kind: 'definite', text: '這一期到 10/25 才結束，結束後才能標記已付款。' });
    assert.equal(classifyRpcFailure({ error: { code: '42501', message: 'x' }, status: 403 }).kind, 'definite');
    assert.match(classifyRpcFailure({ error: { code: 'P0001', message: 'boom' }, status: 400 }).text, /沒有改任何紀錄/);
    assert.deepEqual(classifyRpcFailure({ error: { message: 'TypeError: Failed to fetch', code: '' }, status: 0 }), { kind: 'uncertain', text: UNCERTAIN_TEXT });
    assert.equal(classifyRpcFailure({ error: { code: '57014', message: 'canceling statement due to statement timeout' }, status: 500 }).kind, 'uncertain');
    assert.equal(classifyRpcFailure({ error: { message: '<html>502 Bad Gateway</html>' }, status: 502 }).kind, 'uncertain');
    assert.equal(classifyRpcFailure({ error: null, status: 200 }).kind, 'uncertain', '成功但回應看不懂也算不確定');
});

test('不符明細最多列 10 筆；匯出紀錄的狀態與能不能還原', () => {
    const list = Array.from({ length: 12 }, (_, i) => ({ instructor_name: `講師${i}`, session_date: '2026-09-01', message: '狀態已不是「已核准」（現在：已付款）' }));
    const lines = mismatchLines(list);
    assert.equal(lines.length, 11);
    assert.equal(lines[0], '講師0・2026-09-01：狀態已不是「已核准」（現在：已付款）');
    assert.equal(lines[10], '…另有 2 筆');
    assert.equal(exportStatusText({ marked_at: null, item_count: 8 }), '未標記');
    assert.equal(exportStatusText({ marked_at: 'x', marked_count: 8, reverted_count: 0 }), '已標記');
    assert.equal(exportStatusText({ marked_at: 'x', marked_count: 8, reverted_count: 7 }), '已還原 7/8 筆');
    assert.equal(exportStatusText({ marked_at: 'x', marked_count: 8, reverted_count: 8 }), '已還原');
    assert.equal(canRevertExport({ marked_at: null, item_count: 8 }), false);
    assert.equal(canRevertExport({ marked_at: 'x', marked_count: 8, reverted_count: 7 }), true);
    assert.equal(canRevertExport({ marked_at: 'x', marked_count: 8, reverted_count: 8 }), false);
});
