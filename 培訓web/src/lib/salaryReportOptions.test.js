import test from 'node:test';
import assert from 'node:assert/strict';
import {
    OPTION_KINDS,
    OPTION_LABEL_MAX,
    canMove,
    isDuplicateError,
    kindConfig,
    nextSortOrder,
    optionErrorMessage,
    optionsOfKind,
    optionsOfScope,
    otherScope,
    planMove,
    planScopeChange,
    scopeLabel,
    sortOptions,
    termPeriodInfo,
    validateOptionLabel,
} from './salaryReportOptions.js';

const opt = (id, kind, label, sort_order, extra = {}) => ({ id, kind, value: label, label, sort_order, is_active: true, ...extra });

test('三個分頁固定，且只有期間不可新增', () => {
    assert.deepEqual(OPTION_KINDS.map((item) => item.kind), ['term_period', 'partner_unit', 'camp_batch']);
    assert.equal(kindConfig('term_period').canAdd, false);
    assert.equal(kindConfig('partner_unit').canAdd, true);
    assert.equal(kindConfig('camp_batch').canAdd, true);
    assert.equal(kindConfig('nope'), null);
});

test('期間分頁說明講清楚文字會原樣出現在講師下拉，並指向兩組清單', () => {
    const hint = kindConfig('term_period').hint;
    assert.match(hint, /原樣出現在講師回報頁的下拉/);
    assert.match(hint, /115學年度下學期/);
    assert.match(hint, /寒暑假清單/);
    assert.match(kindConfig('partner_unit').hint, /學期間清單/);
});

test('sortOptions 依排序值，相同時依文字，且不改動原陣列', () => {
    const input = [opt('c', 'partner_unit', 'C', 30), opt('a', 'partner_unit', 'B', 10), opt('b', 'partner_unit', 'A', 10)];
    assert.deepEqual(sortOptions(input).map((o) => o.id), ['b', 'a', 'c']);
    assert.deepEqual(input.map((o) => o.id), ['c', 'a', 'b']);
    assert.deepEqual(sortOptions(null), []);
});

test('optionsOfKind 只留該分頁並含停用項', () => {
    const input = [opt('1', 'camp_batch', 'X', 20), opt('2', 'partner_unit', 'Y', 10), opt('3', 'camp_batch', 'Z', 10, { is_active: false })];
    assert.deepEqual(optionsOfKind(input, 'camp_batch').map((o) => o.id), ['3', '1']);
});

test('nextSortOrder 為最大值加 10，空清單為 10，容忍壞值', () => {
    assert.equal(nextSortOrder([]), 10);
    assert.equal(nextSortOrder(undefined), 10);
    assert.equal(nextSortOrder([opt('1', 'partner_unit', 'A', 10), opt('2', 'partner_unit', 'B', 40)]), 50);
    assert.equal(nextSortOrder([{ id: 'x', sort_order: null }]), 10);
});

test('validateOptionLabel：空白、過長、重複會被擋，並回傳去頭尾空白的文字', () => {
    const siblings = [opt('1', 'partner_unit', '新竹國小', 10)];
    assert.deepEqual(validateOptionLabel('   ', siblings), { ok: false, message: '請輸入選項文字。' });
    assert.deepEqual(validateOptionLabel(undefined, siblings), { ok: false, message: '請輸入選項文字。' });
    assert.equal(validateOptionLabel('長'.repeat(OPTION_LABEL_MAX + 1), siblings).ok, false);
    assert.deepEqual(validateOptionLabel('長'.repeat(OPTION_LABEL_MAX), siblings), { ok: true, label: '長'.repeat(OPTION_LABEL_MAX) });
    assert.deepEqual(validateOptionLabel('  新竹國小 ', siblings), { ok: false, message: '這個分頁已經有相同的選項。' });
    assert.deepEqual(validateOptionLabel(' 台北國小 ', siblings), { ok: true, label: '台北國小' });
});

test('validateOptionLabel 改名時可忽略自己', () => {
    const siblings = [opt('1', 'partner_unit', '新竹國小', 10), opt('2', 'partner_unit', '台北國小', 20)];
    assert.equal(validateOptionLabel('新竹國小', siblings, { ignoreId: '1' }).ok, true);
    assert.equal(validateOptionLabel('台北國小', siblings, { ignoreId: '1' }).ok, false);
});

test('planMove 交換相鄰兩筆排序值', () => {
    const list = [opt('a', 'partner_unit', 'A', 10), opt('b', 'partner_unit', 'B', 20), opt('c', 'partner_unit', 'C', 30)];
    assert.deepEqual(planMove(list, 'b', 'up'), [{ id: 'b', sort_order: 10 }, { id: 'a', sort_order: 20 }]);
    assert.deepEqual(planMove(list, 'b', 'down'), [{ id: 'b', sort_order: 30 }, { id: 'c', sort_order: 20 }]);
});

test('planMove 到頂／到底／找不到都不動', () => {
    const list = [opt('a', 'partner_unit', 'A', 10), opt('b', 'partner_unit', 'B', 20)];
    assert.deepEqual(planMove(list, 'a', 'up'), []);
    assert.deepEqual(planMove(list, 'b', 'down'), []);
    assert.deepEqual(planMove(list, 'zzz', 'up'), []);
    assert.equal(canMove(list, 'a', 'up'), false);
    assert.equal(canMove(list, 'a', 'down'), true);
    assert.equal(canMove(list, 'b', 'up'), true);
    assert.equal(canMove(list, 'b', 'down'), false);
});

test('planMove 排序值相同時整組重編，結果順序確實互換', () => {
    const list = [opt('a', 'camp_batch', 'A', 0), opt('b', 'camp_batch', 'B', 0), opt('c', 'camp_batch', 'C', 0)];
    const updates = planMove(list, 'c', 'up');
    const applied = list.map((o) => ({ ...o, sort_order: updates.find((u) => u.id === o.id)?.sort_order ?? o.sort_order }));
    assert.deepEqual(sortOptions(applied).map((o) => o.id), ['a', 'c', 'b']);
    assert.equal(new Set(applied.map((o) => o.sort_order)).size, 3);
    assert.equal(canMove(list, 'a', 'up'), false);
});

test('錯誤訊息：唯一鍵衝突、權限、其他', () => {
    assert.equal(isDuplicateError({ code: '23505' }), true);
    assert.equal(isDuplicateError({ code: '42501' }), false);
    assert.equal(optionErrorMessage({ code: '23505', message: 'duplicate key' }), '這個分頁已經有相同的選項。');
    assert.match(optionErrorMessage({ code: '42501', message: 'x' }), /沒有權限/);
    assert.match(optionErrorMessage({ message: 'new row violates row-level security policy' }), /沒有權限/);
    assert.equal(optionErrorMessage({ message: 'boom' }, '儲存失敗'), '儲存失敗（boom）');
    assert.equal(optionErrorMessage(null), '操作失敗，請稍後再試。');
});

const unit = (id, label, sort_order, term_scope, extra = {}) => opt(id, 'partner_unit', label, sort_order, { term_scope, ...extra });
const units = () => [
    unit('v1', '寒暑假A', 10, 'vacation'),
    unit('s1', '學期間A', 10, 'semester'),
    unit('v2', '寒暑假B', 20, 'vacation', { is_active: false }),
    unit('s2', '學期間B', 30, 'semester'),
    opt('c1', 'camp_batch', '營隊', 10),
];

test('optionsOfScope 依 term_scope 分組、含停用項、依排序，且不混入其他分頁', () => {
    assert.deepEqual(optionsOfScope(units(), 'partner_unit', 'vacation').map((o) => o.id), ['v1', 'v2']);
    assert.deepEqual(optionsOfScope(units(), 'partner_unit', 'semester').map((o) => o.id), ['s1', 's2']);
    assert.deepEqual(optionsOfScope(units(), 'camp_batch', 'vacation'), []);
    assert.deepEqual(optionsOfScope(null, 'partner_unit', 'vacation'), []);
});

test('新增單位的排序：只看該組最大值＋10；新增 payload 帶 term_scope', () => {
    const list = units();
    assert.equal(nextSortOrder(optionsOfScope(list, 'partner_unit', 'vacation')), 30);
    assert.equal(nextSortOrder(optionsOfScope(list, 'partner_unit', 'semester')), 40);
    const payload = { kind: 'partner_unit', value: 'X', label: 'X', sort_order: nextSortOrder(optionsOfScope(list, 'partner_unit', 'semester')), term_scope: 'semester' };
    assert.deepEqual(Object.keys(payload).sort(), ['kind', 'label', 'sort_order', 'term_scope', 'value']);
});

test('同一個單位名稱不能同時出現在兩組（驗證吃整個分頁）', () => {
    const all = optionsOfKind(units(), 'partner_unit');
    assert.equal(validateOptionLabel('學期間A', all).ok, false);
    assert.equal(validateOptionLabel('寒暑假A', all).ok, false);
    assert.equal(validateOptionLabel('全新單位', all).ok, true);
});

test('planMove／canMove 只在同組內移動', () => {
    const vacation = optionsOfScope(units(), 'partner_unit', 'vacation');
    assert.deepEqual(planMove(vacation, 'v2', 'up'), [{ id: 'v2', sort_order: 10 }, { id: 'v1', sort_order: 20 }]);
    assert.deepEqual(planMove(vacation, 'v2', 'down'), []);
    assert.equal(canMove(vacation, 'v1', 'up'), false);
    assert.equal(canMove(vacation, 'v2', 'down'), false);
    assert.deepEqual(planMove(vacation, 's1', 'up'), []);
});

test('planScopeChange：移到另一組，排序接在目標組最後', () => {
    const list = optionsOfKind(units(), 'partner_unit');
    assert.deepEqual(planScopeChange(list, 'v1', 'semester'), { term_scope: 'semester', sort_order: 40 });
    assert.deepEqual(planScopeChange(list, 's1', 'vacation'), { term_scope: 'vacation', sort_order: 30 });
    assert.equal(planScopeChange(list, 'v1', 'vacation'), null);
    assert.equal(planScopeChange(list, 'zzz', 'semester'), null);
    assert.equal(planScopeChange(list, 'v1', 'nope'), null);
    const onlyVacation = [unit('v1', 'A', 10, 'vacation')];
    assert.deepEqual(planScopeChange(onlyVacation, 'v1', 'semester'), { term_scope: 'semester', sort_order: 10 });
});

test('scopeLabel／otherScope／termPeriodInfo', () => {
    assert.equal(scopeLabel('vacation'), '寒暑假清單');
    assert.equal(scopeLabel('semester'), '學期間清單');
    assert.equal(otherScope('vacation'), 'semester');
    assert.equal(otherScope('semester'), 'vacation');
    assert.deepEqual(termPeriodInfo('winter_break'), { usage: '寒假', scopeLabel: '寒暑假清單' });
    assert.deepEqual(termPeriodInfo('semester'), { usage: '學期間', scopeLabel: '學期間清單' });
    assert.deepEqual(termPeriodInfo('summer_break'), { usage: '暑假', scopeLabel: '寒暑假清單' });
});
