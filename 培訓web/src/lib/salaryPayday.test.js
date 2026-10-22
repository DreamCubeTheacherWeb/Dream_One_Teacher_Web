import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_PAYDAY_DAY,
    markPaidPeriodChoices,
    monthNameOf,
    normalizePaydayDay,
    parseIsoDate,
    payoutScheduleFromResponse,
    regularPaydayFor,
    resolvePayout,
    shortDateOf,
    summarizeMarkPaid,
    summarizePayrollPeriod,
} from './salaryPayday.js';

const at = (schedule, today) => {
    const { payday, periodMonth } = resolvePayout(schedule, today);
    return `${payday} ${periodMonth}`;
};

test('後台設定的日期還沒過（含當天）就照用，匯上個月', () => {
    assert.equal(at({ nextPayday: '2026-11-10', regularDay: 10 }, '2026-10-20'), '2026-11-10 2026/10');
    assert.equal(at({ nextPayday: '2026-11-10', regularDay: 10 }, '2026-11-10'), '2026-11-10 2026/10');
    assert.equal(at({ nextPayday: '2026-12-10', regularDay: 10 }, '2026-12-01'), '2026-12-10 2026/11');
    // 遇假日提前到 12/9：仍是匯 11 月
    assert.equal(at({ nextPayday: '2026-12-09', regularDay: 10 }, '2026-12-01'), '2026-12-09 2026/11');
});

test('日期過了自動跳到下一期的固定日', () => {
    assert.equal(at({ nextPayday: '2026-11-10', regularDay: 10 }, '2026-11-11'), '2026-12-10 2026/11');
    // 提前到 12/9 匯過了，隔天不能又跳回 12/10（那樣會以為 11 月還沒匯）
    assert.equal(at({ nextPayday: '2026-12-09', regularDay: 10 }, '2026-12-10'), '2027-01-10 2026/12');
    // 好幾個月沒人改：一路往後找到第一個不早於今天的
    assert.equal(at({ nextPayday: '2026-08-10', regularDay: 10 }, '2026-10-20'), '2026-11-10 2026/10');
    assert.equal(at({ nextPayday: '2026-08-10', regularDay: 10 }, '2026-10-05'), '2026-10-10 2026/09');
    // 跨年
    assert.equal(at({ nextPayday: '2026-12-10', regularDay: 10 }, '2026-12-25'), '2027-01-10 2026/12');
});

test('提前／延後跨到別的月份，仍算原本那一期（審查 2026-10-20 建議 2）', () => {
    // 固定 28 號，12/28 延到 1/4：匯的是 11 月；1/4 過後下一期是 1/28 匯 12 月，不能跳過
    assert.equal(at({ nextPayday: '2027-01-04', regularDay: 28 }, '2026-12-30'), '2027-01-04 2026/11');
    assert.equal(at({ nextPayday: '2027-01-04', regularDay: 28 }, '2027-01-05'), '2027-01-28 2026/12');
    // 固定 1 號，11/1 提前到 10/31：匯的是 10 月；10/31 過後下一期是 12/1 匯 11 月
    assert.equal(at({ nextPayday: '2026-10-31', regularDay: 1 }, '2026-10-20'), '2026-10-31 2026/10');
    assert.equal(at({ nextPayday: '2026-10-31', regularDay: 1 }, '2026-11-01'), '2026-12-01 2026/11');
    // 固定 10 號，延到 11/25（與 11/10、12/10 等距）取較早的那期：匯 10 月
    assert.equal(at({ nextPayday: '2026-11-25', regularDay: 10 }, '2026-11-20'), '2026-11-25 2026/10');
});

test('讀不到設定時用每月 10 號', () => {
    assert.equal(DEFAULT_PAYDAY_DAY, 10);
    assert.equal(at({}, '2026-10-20'), '2026-11-10 2026/10');
    assert.equal(at(undefined, '2026-10-10'), '2026-10-10 2026/09');
    assert.equal(at({ nextPayday: 'bad', regularDay: 'x' }, '2026-10-09'), '2026-10-10 2026/09');
    assert.equal(at({ nextPayday: null, regularDay: 25 }, '2026-10-26'), '2026-11-25 2026/10');
    assert.equal(at({}, '2027-01-11'), '2027-02-10 2027/01');
});

test('某一期照固定日的匯款日（後台改固定日時用來帶出同一期的新日期）', () => {
    assert.equal(regularPaydayFor('2026/10', 10), '2026-11-10');
    assert.equal(regularPaydayFor('2026/10', 28), '2026-11-28');
    assert.equal(regularPaydayFor('2026/12', 5), '2027-01-05');
    assert.equal(regularPaydayFor('2027/01', 28), '2027-02-28');
    assert.equal(regularPaydayFor('bad', 10), null);
    // 帶出來的日期回頭算期別，必須還是同一期（審查 2026-10-20 必修：只改固定日不能換期）
    for (const day of [1, 5, 10, 15, 20, 25, 26, 27, 28]) {
        const payday = regularPaydayFor('2026/10', day);
        assert.equal(resolvePayout({ nextPayday: payday, regularDay: day }, '2026-10-20').periodMonth, '2026/10', String(day));
    }
});

test('讀取結果：表還沒建或沒資料就安靜退回；其他錯誤標 failed', () => {
    assert.deepEqual(payoutScheduleFromResponse({ data: { next_payday: '2026-11-10', regular_day: 10 }, error: null }),
        { nextPayday: '2026-11-10', regularDay: 10, failed: false });
    assert.deepEqual(payoutScheduleFromResponse({ data: null, error: null }), { nextPayday: null, regularDay: null, failed: false });
    assert.equal(payoutScheduleFromResponse({ error: { code: 'PGRST205' } }).failed, false);
    assert.equal(payoutScheduleFromResponse({ error: { code: '42P01' } }).failed, false);
    assert.equal(payoutScheduleFromResponse({ error: { code: '', message: 'Failed to fetch' } }).failed, true);
    assert.equal(payoutScheduleFromResponse({ error: { code: '500' } }).failed, true);
});

test('固定日只收 1～28，其他退回 10', () => {
    assert.equal(normalizePaydayDay(5), 5);
    assert.equal(normalizePaydayDay('28'), 28);
    for (const bad of [0, 29, 31, -1, 2.5, '', null, undefined, 'abc']) assert.equal(normalizePaydayDay(bad), 10, String(bad));
});

test('today 格式錯誤直接拋錯，不默默算錯', () => {
    assert.throws(() => resolvePayout({}, '2026/10/20'));
    assert.throws(() => resolvePayout({}, ''));
});

test('日期解析擋掉不存在的日期', () => {
    assert.deepEqual(parseIsoDate('2026-02-28'), { year: 2026, month: 2, day: 28 });
    assert.equal(parseIsoDate('2026-02-30'), null);
    assert.equal(parseIsoDate('2026-13-01'), null);
    assert.equal(parseIsoDate('2026-1-01'), null);
});

test('顯示用格式', () => {
    assert.equal(monthNameOf('2026/11'), '11月');
    assert.equal(monthNameOf('2026/01'), '1月');
    assert.equal(monthNameOf(''), '');
    assert.equal(shortDateOf('2026-12-10'), '12/10');
    assert.equal(shortDateOf('2027-01-09'), '1/9');
});

test('每期結算區間＝上月 26 日～本月 25 日，跨年也對（業主 10/20 確認）', () => {
    const period = (schedule, today) => {
        const { periodMonth, periodStart, periodEnd } = resolvePayout(schedule, today);
        return `${periodMonth} ${periodStart}~${periodEnd}`;
    };
    assert.equal(period({ nextPayday: '2026-11-10', regularDay: 10 }, '2026-10-20'), '2026/10 2026-09-26~2026-10-25');
    assert.equal(period({ nextPayday: '2026-12-10', regularDay: 10 }, '2026-12-01'), '2026/11 2026-10-26~2026-11-25');
    assert.equal(period({ nextPayday: '2027-01-10', regularDay: 10 }, '2026-12-11'), '2026/12 2026-11-26~2026-12-25');
    assert.equal(period({}, '2026-01-20'), '2026/01 2025-12-26~2026-01-25');
    assert.equal(period({}, '2026-03-05'), '2026/02 2026-01-26~2026-02-25');
});

test('該期累計：只算區間內（含頭尾）、退回不算、待核准算進總額並另列、待定價只算場次', () => {
    const range = { periodStart: '2026-09-26', periodEnd: '2026-10-25' };
    const sessions = [
        { session_date: '2026-09-25', status: 'paid', pricing_status: 'legacy', total_salary: 9999 },  // 上一期
        { session_date: '2026-09-26', status: 'approved', pricing_status: 'legacy', total_salary: 1000 },
        { session_date: '2026-10-10', status: 'approved', pricing_status: 'quoted', total_salary: 800 },
        { session_date: '2026-10-25', status: 'pending', pricing_status: 'quoted', total_salary: '600' },
        { session_date: '2026-10-12', status: 'pending', pricing_status: 'needs_review', total_salary: null },
        { session_date: '2026-10-13', status: 'pending', pricing_status: 'rejected', total_salary: 0 },
        { session_date: '2026-10-26', status: 'pending', pricing_status: 'quoted', total_salary: 7777 },  // 下一期
    ];
    assert.deepEqual(summarizePayrollPeriod(sessions, range), { total: 2400, count: 4, pendingTotal: 600, awaitingPriceCount: 1 });
    assert.deepEqual(summarizePayrollPeriod(sessions, { periodStart: '2026-10-26', periodEnd: '2026-11-25' }),
        { total: 7777, count: 1, pendingTotal: 7777, awaitingPriceCount: 0 });
    assert.deepEqual(summarizePayrollPeriod(null, range), { total: 0, count: 0, pendingTotal: 0, awaitingPriceCount: 0 });
});

test('「本期匯款完成」期別：預設目前這一期；它還沒結束就預設上一期（還沒結束的期別不能標）', () => {
    const pick = (schedule, today) => {
        const { choices, defaultMonth } = markPaidPeriodChoices(schedule, today);
        return `${defaultMonth} | ${choices.map(c => `${c.periodMonth} ${c.periodStart}~${c.periodEnd}${c.ended ? '' : ' 未結束'}`).join(' / ')}`;
    };
    const schedule = { nextPayday: '2026-11-10', regularDay: 10 };
    // 10/21：目前這一期 10 月（9/26～10/25）還沒結束 → 預設 9 月
    assert.equal(pick(schedule, '2026-10-21'),
        '2026/09 | 2026/10 2026-09-26~2026-10-25 未結束 / 2026/09 2026-08-26~2026-09-25 / 2026/08 2026-07-26~2026-08-25 / 2026/07 2026-06-26~2026-07-25');
    // 10/25 當天仍未結束；10/26 起 10 月可標
    assert.match(pick(schedule, '2026-10-25'), /^2026\/09 \| 2026\/10 2026-09-26~2026-10-25 未結束/);
    assert.match(pick(schedule, '2026-10-26'), /^2026\/10 \| 2026\/10 2026-09-26~2026-10-25 \//);
    // 匯款日當天 11/10：仍是 10 月
    assert.match(pick(schedule, '2026-11-10'), /^2026\/10 \| 2026\/10 /);
    // 匯款日過了 11/11：目前這一期換成 11 月（10/26～11/25，未結束）→ 預設仍是 10 月
    assert.match(pick(schedule, '2026-11-11'), /^2026\/10 \| 2026\/11 2026-10-26~2026-11-25 未結束 \/ 2026\/10 2026-09-26~2026-10-25 \//);
    // 跨年：2027/1/5 匯 12 月（11/26～12/25，已結束）
    assert.match(pick({ nextPayday: '2027-01-10', regularDay: 10 }, '2027-01-05'), /^2026\/12 \| 2026\/12 2026-11-26~2026-12-25 \/ 2026\/11 /);
    const { choices } = markPaidPeriodChoices(schedule, '2026-10-26');
    assert.equal(choices[0].payday, '2026-11-10');
    assert.equal(choices[1].payday, null);
});

test('「本期匯款完成」確認數字：總額、之前付過一部分的實匯金額、溢付與異常筆數', () => {
    assert.deepEqual(summarizeMarkPaid([
        { total_salary: 1000, paid_amount: 0, is_anomaly: false },
        { total_salary: '600.00', paid_amount: '100.00', is_anomaly: false },  // 付過 100，這次匯 500
        { total_salary: 300, paid_amount: 350, is_anomaly: true },             // 溢付 50，這次匯 0
        { total_salary: 200, paid_amount: null, is_anomaly: true },
    ]), { count: 4, amount: 2100, prepaidCount: 2, prepaidAmount: 450, toTransfer: 1700, overpaidCount: 1, anomalyCount: 2 });
    assert.deepEqual(summarizeMarkPaid(null), { count: 0, amount: 0, prepaidCount: 0, prepaidAmount: 0, toTransfer: 0, overpaidCount: 0, anomalyCount: 0 });
});
