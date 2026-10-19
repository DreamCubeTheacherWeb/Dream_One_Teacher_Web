import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OPTION_LABEL_MAX,
    PERIOD_SECTIONS,
    SORT_STEP,
    applyOrder,
    isDuplicateError,
    itemsOfPeriod,
    newPeriodValue,
    nextSortOrder,
    optionErrorMessage,
    optionsLoadErrorMessage,
    periodCounts,
    periodsOf,
    pickPeriodId,
    planCopyItems,
    reorderIds,
    sectionConfig,
    sortOptions,
    validateOptionLabel,
} from './salaryReportOptions.js';

const period = (id, label, sort_order, extra = {}) => ({ id, kind: 'term_period', value: `code_${id}`, label, sort_order, is_active: true, period_id: null, ...extra });
const item = (id, kind, label, sort_order, period_id, extra = {}) => ({ id, kind, value: label, label, sort_order, is_active: true, period_id, ...extra });

// 3 個期間：寒假（2 單位、1 梯次）、學期（1 單位）、暑假（空）
const seed = () => [
    period('t1', '2026年寒假', 10),
    period('t2', '115學年度上學期', 20),
    period('t3', '2026年暑假', 30, { is_active: false }),
    item('u1', 'partner_unit', '【新竹】康乃薾', 10, 't1'),
    item('u2', 'partner_unit', '【週二】再興', 20, 't1', { is_active: false }),
    item('u3', 'partner_unit', '【學期】信義', 10, 't2'),
    item('c1', 'camp_batch', '【臺北A】中山', 10, 't1'),
];

test('每個期間底下固定兩份清單：上課單位、營隊梯次', () => {
    assert.deepEqual(PERIOD_SECTIONS.map((section) => section.kind), ['partner_unit', 'camp_batch']);
    assert.deepEqual(PERIOD_SECTIONS.map((section) => section.title), ['上課單位', '營隊梯次']);
    assert.equal(sectionConfig('partner_unit').noun, '單位');
    assert.equal(sectionConfig('camp_batch').noun, '梯次');
    assert.equal(sectionConfig('term_period'), null);
});

test('sortOptions 依排序值，相同時依文字，且不改動原陣列', () => {
    const input = [item('c', 'partner_unit', 'C', 30, 't1'), item('a', 'partner_unit', 'B', 10, 't1'), item('b', 'partner_unit', 'A', 10, 't1')];
    assert.deepEqual(sortOptions(input).map((o) => o.id), ['b', 'a', 'c']);
    assert.deepEqual(input.map((o) => o.id), ['c', 'a', 'b']);
    assert.deepEqual(sortOptions(null), []);
});

test('periodsOf 只留期間（含停用）並依排序', () => {
    const rows = [...seed()].reverse();
    assert.deepEqual(periodsOf(rows).map((o) => o.id), ['t1', 't2', 't3']);
    assert.deepEqual(periodsOf(undefined), []);
});

test('itemsOfPeriod 只回傳該期間、該種類的列（含停用），其他期間不混入', () => {
    const rows = seed();
    assert.deepEqual(itemsOfPeriod(rows, 't1', 'partner_unit').map((o) => o.id), ['u1', 'u2']);
    assert.deepEqual(itemsOfPeriod(rows, 't2', 'partner_unit').map((o) => o.id), ['u3']);
    assert.deepEqual(itemsOfPeriod(rows, 't1', 'camp_batch').map((o) => o.id), ['c1']);
    assert.deepEqual(itemsOfPeriod(rows, 't3', 'partner_unit'), []);
    assert.deepEqual(itemsOfPeriod(rows, null, 'partner_unit'), []);
    assert.deepEqual(itemsOfPeriod(null, 't1', 'partner_unit'), []);
});

test('periodCounts 回報各清單的總數與啟用數', () => {
    assert.deepEqual(periodCounts(seed(), 't1'), { partner_unit: { total: 2, active: 1 }, camp_batch: { total: 1, active: 1 } });
    assert.deepEqual(periodCounts(seed(), 't3'), { partner_unit: { total: 0, active: 0 }, camp_batch: { total: 0, active: 0 } });
});

test('nextSortOrder 為最大值加 10，空清單為 10，容忍壞值', () => {
    assert.equal(SORT_STEP, 10);
    assert.equal(nextSortOrder([]), 10);
    assert.equal(nextSortOrder(undefined), 10);
    assert.equal(nextSortOrder(itemsOfPeriod(seed(), 't1', 'partner_unit')), 30);
    assert.equal(nextSortOrder(periodsOf(seed())), 40);
    assert.equal(nextSortOrder([{ id: 'x', sort_order: null }]), 10);
});

test('validateOptionLabel：空白、過長、重複會被擋，訊息帶入名詞，回傳去頭尾空白的文字', () => {
    const siblings = itemsOfPeriod(seed(), 't1', 'partner_unit');
    assert.deepEqual(validateOptionLabel('   ', siblings, { noun: '單位' }), { ok: false, message: '請輸入單位名稱。' });
    assert.deepEqual(validateOptionLabel(undefined, siblings), { ok: false, message: '請輸入選項名稱。' });
    assert.deepEqual(validateOptionLabel('長'.repeat(OPTION_LABEL_MAX + 1), siblings, { noun: '期間' }), { ok: false, message: `期間名稱不得超過 ${OPTION_LABEL_MAX} 字。` });
    assert.deepEqual(validateOptionLabel('長'.repeat(OPTION_LABEL_MAX), siblings), { ok: true, label: '長'.repeat(OPTION_LABEL_MAX) });
    assert.deepEqual(validateOptionLabel('  【新竹】康乃薾 ', siblings, { noun: '單位' }), { ok: false, message: '這份清單已經有相同的單位。' });
    assert.deepEqual(validateOptionLabel(' 【桃園】新單位 ', siblings, { noun: '單位' }), { ok: true, label: '【桃園】新單位' });
});

test('同名單位只在同一份清單內才算重複：不同期間可以各有一份', () => {
    const rows = seed();
    assert.equal(validateOptionLabel('【新竹】康乃薾', itemsOfPeriod(rows, 't2', 'partner_unit')).ok, true);
    assert.equal(validateOptionLabel('【新竹】康乃薾', itemsOfPeriod(rows, 't1', 'partner_unit')).ok, false);
    // 停用的列也算重複（資料庫唯一鍵不分啟用與否）
    assert.equal(validateOptionLabel('【週二】再興', itemsOfPeriod(rows, 't1', 'partner_unit')).ok, false);
});

test('validateOptionLabel 改名時可忽略自己，但不能撞到別人', () => {
    const siblings = itemsOfPeriod(seed(), 't1', 'partner_unit');
    assert.equal(validateOptionLabel('【新竹】康乃薾', siblings, { ignoreId: 'u1' }).ok, true);
    assert.equal(validateOptionLabel('【週二】再興', siblings, { ignoreId: 'u1' }).ok, false);
});

test('newPeriodValue：term_ 開頭加 10 碼英數，可注入亂數', () => {
    assert.match(newPeriodValue(), /^term_[a-z0-9]{10}$/);
    assert.equal(newPeriodValue(() => 0), 'term_aaaaaaaaaa');
    assert.equal(newPeriodValue(() => 0.999999), 'term_9999999999');
    assert.notEqual(newPeriodValue(), newPeriodValue());
});

test('planCopyItems：單位與梯次照抄名稱、順序、啟用狀態，掛到新期間，不帶 id', () => {
    const plan = planCopyItems(seed(), 't1', 'NEW');
    assert.deepEqual(plan, [
        { kind: 'partner_unit', value: '【新竹】康乃薾', label: '【新竹】康乃薾', sort_order: 10, is_active: true, period_id: 'NEW' },
        { kind: 'partner_unit', value: '【週二】再興', label: '【週二】再興', sort_order: 20, is_active: false, period_id: 'NEW' },
        { kind: 'camp_batch', value: '【臺北A】中山', label: '【臺北A】中山', sort_order: 10, is_active: true, period_id: 'NEW' },
    ]);
    assert.ok(plan.every((row) => !('id' in row)));
});

test('planCopyItems：來源空清單、缺少來源或新期間都回傳空陣列', () => {
    assert.deepEqual(planCopyItems(seed(), 't3', 'NEW'), []);
    assert.deepEqual(planCopyItems(seed(), null, 'NEW'), []);
    assert.deepEqual(planCopyItems(seed(), 't1', null), []);
    assert.deepEqual(planCopyItems(null, 't1', 'NEW'), []);
});

test('reorderIds：回傳拖曳後的新 id 順序；沒移動或找不到回傳 null，不改原陣列', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    assert.deepEqual(reorderIds(list, 'a', 'c'), ['b', 'c', 'a', 'd']);
    assert.deepEqual(reorderIds(list, 'd', 'a'), ['d', 'a', 'b', 'c']);
    assert.deepEqual(reorderIds(list, 'b', 'c'), ['a', 'c', 'b', 'd']);
    assert.equal(reorderIds(list, 'a', 'a'), null);
    assert.equal(reorderIds(list, 'zzz', 'a'), null);
    assert.equal(reorderIds(list, 'a', 'zzz'), null);
    assert.equal(reorderIds(null, 'a', 'b'), null);
    assert.deepEqual(list.map((o) => o.id), ['a', 'b', 'c', 'd']);
});

test('applyOrder：依新順序改成 10、20、30…，只動名單內的列，不改原陣列', () => {
    const rows = seed();
    const next = applyOrder(rows, ['u2', 'u1']);
    assert.equal(next.find((o) => o.id === 'u2').sort_order, 10);
    assert.equal(next.find((o) => o.id === 'u1').sort_order, 20);
    assert.equal(next.find((o) => o.id === 'u3').sort_order, 10); // 別份清單不動
    assert.equal(next.find((o) => o.id === 't2').sort_order, 20);
    assert.equal(rows.find((o) => o.id === 'u1').sort_order, 10);
    assert.deepEqual(itemsOfPeriod(next, 't1', 'partner_unit').map((o) => o.id), ['u2', 'u1']);
    assert.deepEqual(applyOrder(null, ['a']), []);
});

test('拖曳後的畫面順序＝reorderIds 的結果（reorderIds → applyOrder → itemsOfPeriod）', () => {
    const rows = [
        period('t1', 'T', 10),
        item('a', 'camp_batch', 'A', 10, 't1'),
        item('b', 'camp_batch', 'B', 20, 't1'),
        item('c', 'camp_batch', 'C', 30, 't1'),
    ];
    const ids = reorderIds(itemsOfPeriod(rows, 't1', 'camp_batch'), 'a', 'c');
    assert.deepEqual(ids, ['b', 'c', 'a']);
    assert.deepEqual(itemsOfPeriod(applyOrder(rows, ids), 't1', 'camp_batch').map((o) => o.id), ids);
});

test('pickPeriodId：原選中的還在就沿用，否則第一個，沒有期間為 null', () => {
    const periods = periodsOf(seed());
    assert.equal(pickPeriodId(periods, 't2'), 't2');
    assert.equal(pickPeriodId(periods, 'gone'), 't1');
    assert.equal(pickPeriodId(periods, null), 't1');
    assert.equal(pickPeriodId([], 't1'), null);
    assert.equal(pickPeriodId(undefined, null), null);
});

test('錯誤訊息：唯一鍵衝突、權限、其他', () => {
    assert.equal(isDuplicateError({ code: '23505' }), true);
    assert.equal(isDuplicateError({ code: '42501' }), false);
    assert.equal(optionErrorMessage({ code: '23505', message: 'duplicate key' }), '這份清單已經有相同的名稱。');
    assert.match(optionErrorMessage({ code: '42501', message: 'x' }), /沒有權限/);
    assert.match(optionErrorMessage({ message: 'new row violates row-level security policy' }), /沒有權限/);
    assert.equal(optionErrorMessage({ message: 'boom' }, '儲存失敗'), '儲存失敗（boom）');
    assert.equal(optionErrorMessage(null), '操作失敗，請稍後再試。');
});

test('讀取失敗：欄位不存在時提示資料庫還沒套用 2026-10-20 的更新', () => {
    assert.match(optionsLoadErrorMessage({ code: '42703', message: 'column salary_report_options.period_id does not exist' }), /2026-10-20/);
    assert.match(optionsLoadErrorMessage({ message: 'column period_id does not exist' }), /2026-10-20/);
    assert.equal(optionsLoadErrorMessage({ message: 'network down' }), '讀取選項失敗（network down）');
});
