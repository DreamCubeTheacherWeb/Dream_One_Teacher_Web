// 月結匯款匯出的純函式測試（node --test）。測試資料一律是假人名、假號碼。
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
    ADJUSTMENT_COURSE_KIND,
    COST_CENTER_UNSET,
    DEFAULT_MEMO_TEMPLATE,
    DETAIL_HEADERS,
    SHEET_NAMES,
    SUMMARY_HEADERS,
    TRANSFER_HEADERS,
    buildDetailRows,
    buildPayoutWorkbook,
    buildSummaryRows,
    buildTransferCsv,
    buildTransferRows,
    computePayoutPeople,
    decodeCsvBytes,
    defaultPaydayForPeriod,
    defaultPayoutPlan,
    isMissingPartnerNoError,
    maskAccount,
    maskIdNumber,
    memoLength,
    parseAdjustment,
    parseCsv,
    payoutFilename,
    periodOfDate,
    periodRange,
    planPartnerImport,
    recentPeriods,
    renderMemo,
    sessionPayableCents,
    toBankDate,
    validatePayoutExport,
} from './payoutBankExport.js';
import { VENDOR_CSV_HEADERS } from './vendorCsvExport.js';

// ── 假資料
const T = {
    ding: '10000000-0000-4000-8000-0000000000a1',   // 丁：2 畫
    wang: '10000000-0000-4000-8000-0000000000a2',   // 王：4 畫
    lin: '10000000-0000-4000-8000-0000000000a3',    // 林：8 畫
    chen: '10000000-0000-4000-8000-0000000000a4',   // 陳：11 畫
    bad: '10000000-0000-4000-8000-0000000000a5',
};
const instructor = (id, overrides) => ({
    id,
    full_name: '測試',
    bank_code: '0081832',
    bank_account_number: '00291234567890',
    bank_account_name: '測試',
    id_number: 'Z100000001',
    email_primary: 'fake@example.test',
    partner_no: null,
    household_address: '測試戶籍地址',
    address: '測試通訊地址',
    phone_mobile: '0900000000',
    ...overrides,
});
const INSTRUCTORS = [
    instructor(T.chen, { full_name: '陳測四', bank_account_name: '陳測四', id_number: 'Z100000004', partner_no: 'A036872' }),
    instructor(T.ding, { full_name: '丁測一', bank_account_name: '丁測一', id_number: 'Z100000001' }),
    instructor(T.lin, { full_name: '林測三', bank_account_name: '林測三', bank_code: '0130017', bank_account_number: '012-345-678-901', id_number: 'z100000003' }),
    instructor(T.wang, { full_name: '王測二', bank_account_name: '王測二', id_number: 'Z100000002' }),
];
let seq = 0;
const session = (instructorId, overrides = {}) => {
    seq += 1;
    return {
        id: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        instructor_id: instructorId,
        instructor_name: '測試',
        session_date: '2026-10-05',
        course_type: 'regular_basic',
        course_name: `測試課${seq}`,
        base_salary: 1000,
        bonus: 0,
        total_salary: 1000,
        paid_amount: 0,
        status: 'approved',
        pricing_status: 'quoted',
        ...overrides,
    };
};
const SETTINGS = {
    payDate: '2026-11-10',
    payerAccount: '0123-4567-8901',
    payerBranch: '0123',
    noticeMethod: '3',
    feeBearer: '2',
    memoTemplate: DEFAULT_MEMO_TEMPLATE,
};
const compute = (sessions, edits = {}, instructors = INSTRUCTORS) => computePayoutPeople({
    sessions, instructors, periodMonth: '2026/10', memoTemplate: DEFAULT_MEMO_TEMPLATE, edits,
});
const person = (result, id) => result.people.find((p) => p.instructorId === id);

test('轉帳檔表頭固定 14 欄，名稱與順序照財務範本、不含換行', () => {
    assert.deepEqual(TRANSFER_HEADERS, [
        '序號', '付款日期', '付款帳號', '付款分行', '解款行', '收款人帳號', '收款人戶名',
        '付款金額', '收款人ID', '匯款通知方式', '匯款通知資訊', '付款相關附言', '手續費負擔方式', '夥伴號碼',
    ]);
    assert.ok(TRANSFER_HEADERS.every((h) => !/[\r\n]/.test(h)));
    assert.deepEqual(DETAIL_HEADERS, ['成本中心', '講師名稱', '課程種類', '課程日期', '課程名稱', '行政薪資', '薪資', '獎金']);
    assert.deepEqual(SUMMARY_HEADERS, ['講師姓名', '夥伴號碼', '成本中心', '行政薪資', '課程薪資', '獎金', '應付薪資', '二代健保', '實收薪資']);
});

test('期別：上月 26 日～本月 25 日，以結束月份命名；跨年正確', () => {
    assert.deepEqual(periodRange('2026/10'), { periodMonth: '2026/10', year: 2026, month: 10, periodStart: '2026-09-26', periodEnd: '2026-10-25' });
    assert.equal(periodRange('2026/01').periodStart, '2025-12-26');
    assert.equal(periodRange('2026/01').periodEnd, '2026-01-25');
    assert.equal(periodRange('2026/13'), null);
    assert.equal(periodOfDate('2026-10-25'), '2026/10');
    assert.equal(periodOfDate('2026-10-26'), '2026/11');
    assert.equal(periodOfDate('2026-12-26'), '2027/01');
    assert.deepEqual(recentPeriods('2026/02', 3), ['2026/02', '2026/01', '2025/12']);
    assert.equal(recentPeriods('2026/10').length, 12);
});

test('預設期別＝下一個匯款日要匯的那期；讀取失敗改用今天所在的期', () => {
    const plan = defaultPayoutPlan({ nextPayday: '2026-11-10', regularDay: 10, failed: false }, '2026-10-22');
    assert.deepEqual(plan, { periodMonth: '2026/10', payday: '2026-11-10', source: 'schedule' });
    // 假日延後：後台把 11/10 改成 11/12，仍是匯 10 月期
    assert.equal(defaultPayoutPlan({ nextPayday: '2026-11-12', regularDay: 10 }, '2026-10-22').payday, '2026-11-12');
    // 表還沒建（nextPayday null、failed false）→ 每月 10 號推算
    assert.deepEqual(defaultPayoutPlan({ nextPayday: null, regularDay: null, failed: false }, '2026-10-05'),
        { periodMonth: '2026/09', payday: '2026-10-10', source: 'schedule' });
    // 網路或伺服器錯誤 → 今天所在的期
    assert.deepEqual(defaultPayoutPlan({ nextPayday: null, regularDay: null, failed: true }, '2026-10-27'),
        { periodMonth: '2026/11', payday: '2026-12-10', source: 'fallback' });
    // 改選別期：是 next_payday 那期就用 next_payday，否則用固定日
    const shifted = { periodMonth: '2026/10', payday: '2026-11-12' };
    assert.equal(defaultPaydayForPeriod('2026/10', shifted, 10), '2026-11-12');
    assert.equal(defaultPaydayForPeriod('2026/09', shifted, 10), '2026-10-10');
    assert.equal(defaultPaydayForPeriod('2026/09', shifted, 15), '2026-10-15');
});

test('附言範本支援 {YYYY} {YY} {MM}，依期別替換', () => {
    assert.equal(renderMemo(DEFAULT_MEMO_TEMPLATE, '2026/09'), '26/09報酬夢想一號文化教育股份有限公司');
    assert.equal(renderMemo('{YYYY}年{MM}月報酬', '2027/01'), '2027年01月報酬');
    assert.equal(memoLength(renderMemo(DEFAULT_MEMO_TEMPLATE, '2026/09')), 21);
});

test('金額：各課 max(total − paid, 0) 加總再加人工調整，用「分」計算不受浮點誤差影響', () => {
    assert.equal(sessionPayableCents({ total_salary: 800, paid_amount: 300 }), 50000);
    assert.equal(sessionPayableCents({ total_salary: 1000, paid_amount: 1200 }), 0);
    const result = compute([
        session(T.wang, { base_salary: 1200, bonus: 300, total_salary: 1500 }),
        session(T.wang, { base_salary: 800, total_salary: 800, paid_amount: 300 }),
        session(T.wang, { total_salary: 1000, paid_amount: 1200 }),
        session(T.ding, { base_salary: 1000.5, total_salary: 1000.5 }),
        session(T.ding, { base_salary: 999.5, total_salary: 999.5 }),
    ], { adjustments: { [T.wang]: { amount: '200', reason: '交通補助' } } });
    const wang = person(result, T.wang);
    assert.equal(wang.systemCents, 200000);
    assert.equal(wang.payCents, 220000);
    assert.equal(person(result, T.ding).payCents, 200000, '1000.5 + 999.5 = 2000，整數可匯');
    assert.equal(person(result, T.ding).blocked, false);
    assert.equal(result.totalCents, 420000);
    assert.deepEqual(parseAdjustment('-500'), { cents: -50000, valid: true });
    assert.deepEqual(parseAdjustment('1,000'), { cents: 100000, valid: true });
    assert.equal(parseAdjustment('12.5').valid, false);
    assert.deepEqual(parseAdjustment(''), { cents: 0, valid: true });
});

test('人工調整沒填原因就擋匯出；填了原因才可以', () => {
    const sessions = [session(T.wang)];
    const noReason = compute(sessions, { adjustments: { [T.wang]: { amount: '-300', reason: '  ' } } });
    assert.ok(validatePayoutExport({ settings: SETTINGS, people: noReason.people }).some((e) => e.includes('王測二') && e.includes('沒填原因')));
    const withReason = compute(sessions, { adjustments: { [T.wang]: { amount: '-300', reason: '重複登記扣回' } } });
    assert.deepEqual(validatePayoutExport({ settings: SETTINGS, people: withReason.people }), []);
    assert.equal(person(withReason, T.wang).payCents, 70000);
    const badNumber = compute(sessions, { adjustments: { [T.wang]: { amount: '50.5', reason: '測試' } } });
    assert.ok(validatePayoutExport({ settings: SETTINGS, people: badNumber.people }).some((e) => e.includes('整數')));
});

test('阻擋項自動不納入；警告項照樣納入但標出來', () => {
    const instructors = [
        ...INSTRUCTORS,
        instructor(T.bad, { full_name: '李測五', bank_account_name: '李測五', bank_code: '008183' }),
    ];
    const result = compute([
        session(T.bad),
        session(T.ding, { pricing_status: 'needs_review' }),
        session(T.wang, { pricing_status: 'rejected', paid_amount: 100 }),
        session(T.lin),
        session('10000000-0000-4000-8000-0000000000ff'),   // 主檔不存在
        session(null, { instructor_name: '對不到的人' }),
    ], {}, instructors.map((i) => (i.id === T.ding ? { ...i, email_primary: '', bank_account_name: '丁測一的媽媽' } : i)));

    const bad = person(result, T.bad);
    assert.equal(bad.blocked, true);
    assert.equal(bad.included, false);
    assert.match(bad.blockers.join(), /解款行需為 7 碼數字（目前 6 碼）/);
    const ghost = person(result, '10000000-0000-4000-8000-0000000000ff');
    assert.deepEqual(ghost.blockers, ['找不到講師主檔']);
    assert.equal(result.unmatchedSessions.length, 1, 'instructor_id 空白的課列為「對不到講師」');

    // 被勾掉的阻擋者也不能勾回來：excludedInstructorIds 不含他，仍然不納入
    assert.equal(compute([session(T.bad)], { excludedInstructorIds: [] }, instructors).people[0].included, false);

    const ding = person(result, T.ding);
    assert.equal(ding.included, true);
    assert.ok(ding.warnings.includes('戶名與姓名不同'));
    assert.ok(ding.warnings.includes('缺 Email'));
    assert.ok(ding.warnings.includes('需新增夥伴號碼'));
    assert.ok(ding.warnings.includes('含待確認報價 1 筆'));
    const wang = person(result, T.wang);
    assert.ok(wang.warnings.includes('含已退回報價 1 筆'));
    assert.ok(wang.warnings.includes('有部分已付 1 筆'));
    assert.equal(wang.payCents, 90000);

    const lin = person(result, T.lin);
    assert.equal(lin.accountNumber, '012345678901', '帳號去掉連字號');
    assert.equal(lin.idNumber, 'Z100000003', '身分證轉大寫');

    const rows = buildTransferRows({ people: result.people, settings: SETTINGS });
    assert.deepEqual(rows.map((r) => r[6]), ['丁測一的媽媽', '王測二', '林測三'], '阻擋的人不在轉帳檔裡');
    assert.equal(result.blockedCount, 2);
});

test('其他阻擋：帳號含非數字、缺戶名、缺身分證、金額小數、實付 ≤ 0', () => {
    const instructors = [
        instructor(T.ding, { full_name: '丁測一', bank_account_number: '0029-ABC' }),
        instructor(T.wang, { full_name: '王測二', bank_account_name: '' }),
        instructor(T.lin, { full_name: '林測三', id_number: ' ' }),
        instructor(T.chen, { full_name: '陳測四', bank_account_name: '陳測四' }),
    ];
    const result = compute([
        session(T.ding), session(T.wang), session(T.lin),
        session(T.chen, { base_salary: 100.1, total_salary: 100.1 }),
    ], {}, instructors);
    assert.ok(person(result, T.ding).blockers.includes('收款帳號含非數字字元'));
    assert.ok(person(result, T.wang).blockers.includes('缺收款人戶名'));
    assert.ok(person(result, T.lin).blockers.includes('缺身分證字號'));
    assert.ok(person(result, T.chen).blockers.includes('金額有小數，請人工確認'));
    assert.equal(result.includedPeople.length, 0);

    const zero = compute([session(T.chen)], { adjustments: { [T.chen]: { amount: '-1000', reason: '全額扣回' } } }, instructors);
    assert.ok(zero.people[0].blockers.includes('實付金額需大於 0'));
    const allExcluded = compute([session(T.chen, { id: 's-only' })], { excludedSessionIds: ['s-only'] }, instructors);
    assert.ok(allExcluded.people[0].blockers.includes('實付金額需大於 0'));
});

test('依姓名筆畫排序，「需新增N」依最終順序編號、只算有納入的人', () => {
    const result = compute([session(T.chen), session(T.lin), session(T.wang), session(T.ding)], { excludedInstructorIds: [T.wang] });
    assert.deepEqual(result.people.map((p) => p.name), ['丁測一', '王測二', '林測三', '陳測四']);
    assert.deepEqual(result.people.map((p) => p.partnerLabel), ['需新增1', '', '需新增2', 'A036872']);
    const rows = buildTransferRows({ people: result.people, settings: SETTINGS });
    assert.deepEqual(rows.map((r) => [r[0], r[6], r[13]]), [['1', '丁測一', '需新增1'], ['2', '林測三', '需新增2'], ['3', '陳測四', 'A036872']]);
});

test('轉帳 CSV：UTF-8 BOM、CRLF、14 欄、前導 0 保留、金額不加千分位、沒有總額列', () => {
    const result = compute([
        session(T.ding, { base_salary: 12000, bonus: 500, total_salary: 12500 }),
        session(T.wang, { total_salary: 800, base_salary: 800 }),
    ], { memoOverrides: { [T.wang]: '26/10報酬補發' } });
    const csv = buildTransferCsv({ people: result.people, settings: SETTINGS });
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    assert.ok(csv.endsWith('\r\n'));
    assert.ok(!/[^\r]\n/.test(csv), '只用 CRLF 換行');
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines.at(-1), '');
    assert.equal(lines.length, 1 + 2 + 1, '表頭＋2 人＋結尾空字串（沒有總額列）');
    assert.equal(lines[0], TRANSFER_HEADERS.join(','));
    const cells = lines.slice(0, -1).map((line) => line.split(','));
    assert.ok(cells.every((row) => row.length === 14));
    assert.deepEqual(cells[1], [
        '1', '20261110', '012345678901', '0123', '0081832', '00291234567890', '丁測一',
        '12500', 'Z100000001', '3', 'fake@example.test', '26/10報酬夢想一號文化教育股份有限公司', '2', '需新增1',
    ]);
    assert.equal(cells[2][7], '800');
    assert.equal(cells[2][11], '26/10報酬補發', '每人可覆寫附言');
    assert.equal(cells[2][13], '需新增2');
    assert.ok(!csv.includes('合計') && !csv.includes('13300'), '沒有總額列');
    assert.equal(toBankDate('2026-11-05'), '20261105');
});

test('轉帳 CSV 欄位不得含逗號／雙引號／換行或以公式字元開頭：先在檢查擋下，產生器也拒絕', () => {
    const result = compute([session(T.ding)], { memoOverrides: { [T.ding]: '報酬,補發' } });
    assert.ok(validatePayoutExport({ settings: SETTINGS, people: result.people }).some((e) => e.includes('附言含逗號')));
    assert.throws(() => buildTransferCsv({ people: result.people, settings: SETTINGS }), /逗號/);
    const formula = compute([session(T.ding)], { memoOverrides: { [T.ding]: '=1+1' } });
    assert.ok(validatePayoutExport({ settings: SETTINGS, people: formula.people }).some((e) => e.includes('開頭')));
    const evilName = compute([session(T.ding)], {}, [instructor(T.ding, { full_name: '丁測一', bank_account_name: '@丁測一' })]);
    assert.equal(evilName.people[0].blocked, true);
});

test('整批設定檢查：付款帳號／分行必填、分行 4 碼、日期有效、至少一人', () => {
    const people = compute([session(T.ding)]).people;
    const errors = (overrides) => validatePayoutExport({ settings: { ...SETTINGS, ...overrides }, people });
    assert.deepEqual(errors({}), []);
    assert.ok(errors({ payerAccount: '' }).includes('請填付款帳號（公司帳號）'));
    assert.ok(errors({ payerBranch: '' }).includes('請填付款分行'));
    assert.ok(errors({ payerBranch: '123' }).includes('付款分行需為 4 碼數字'));
    assert.ok(errors({ payDate: '2026-02-30' }).includes('付款日期無效'));
    assert.ok(errors({ payDate: '' }).includes('付款日期無效'));
    assert.ok(validatePayoutExport({ settings: SETTINGS, people: compute([session(T.ding)], { excludedInstructorIds: [T.ding] }).people })
        .includes('沒有任何人納入匯款'));
});

test('薪資明細：一課一列、人工調整多一列「手動調整」、每人小計、合計＝轉帳總額', () => {
    const result = compute([
        session(T.wang, { session_date: '2026-09-05', course_type: 'online', course_name: '線上測試課', base_salary: 1200, bonus: 300, total_salary: 1500, id: 's-w1' }),
        session(T.wang, { session_date: '2026-10-01', base_salary: 800, total_salary: 800, paid_amount: 300, id: 's-w2' }),
        session(T.ding, { session_date: '2026-10-02', id: 's-d1' }),
        session(T.ding, { session_date: '2026-10-03', id: 's-d2' }),
    ], {
        adjustments: { [T.wang]: { amount: '-200', reason: '教材費扣回', costCenter: '90182' } },
        excludedSessionIds: ['s-d2'],
        costCenters: { 's-w1': '90180', 's-w2': '90181' },
    });
    const rows = buildDetailRows(result.people);
    assert.deepEqual(rows[0], DETAIL_HEADERS);
    assert.deepEqual(rows[1], ['', '丁測一', '實體常態-初階', '2026/10/2', '測試課' + rows[1][4].replace('測試課', ''), 0, 1000, 0]);
    assert.deepEqual(rows[2], ['小計', '丁測一', '', '', '', 0, 1000, 0]);
    assert.deepEqual(rows[3], ['90180', '王測二', '線上課程', '2026/9/5', '線上測試課', 0, 1200, 300]);
    assert.deepEqual(rows[4].slice(0, 4), ['90181', '王測二', '實體常態-初階', '2026/10/1']);
    assert.deepEqual(rows[4].slice(5), [0, 500, 0], '部分已付：本次應付整筆放薪資、獎金 0');
    assert.deepEqual(rows[5], ['90182', '王測二', ADJUSTMENT_COURSE_KIND, '', '教材費扣回', 0, -200, 0]);
    assert.deepEqual(rows[6], ['小計', '王測二', '', '', '', 0, 1500, 300]);
    const total = rows.at(-1);
    assert.equal(total[0], '合計');
    assert.equal(total[5] + total[6] + total[7], result.totalCents / 100);
    assert.equal(result.totalCents / 100, 2800);
    assert.equal(rows.length, 8, '被排除的那一課不在明細裡');
});

test('薪資總計：講師 × 成本中心一列、空白顯示「未填」、實收只填第一列、二代健保 0、成本中心合計＝總額', () => {
    const result = compute([
        session(T.wang, { id: 's-1', base_salary: 1200, bonus: 300, total_salary: 1500 }),
        session(T.wang, { id: 's-2', base_salary: 800, total_salary: 800 }),
        session(T.wang, { id: 's-3', base_salary: 700, total_salary: 700 }),
        session(T.chen, { id: 's-4', base_salary: 1000, total_salary: 1000 }),
    ], {
        costCenters: { 's-1': '90183', 's-2': '90180' },
        adjustments: { [T.chen]: { amount: '100', reason: '獎勵' } },
    });
    const { rows, headerRows } = buildSummaryRows(result.people);
    assert.deepEqual(rows[0], SUMMARY_HEADERS);
    assert.deepEqual(rows[1], ['王測二', '需新增1', '90180', 0, 800, 0, 800, 0, 3000], '實收＝1500＋800＋700');
    assert.deepEqual(rows[2], ['王測二', '需新增1', '90183', 0, 1200, 300, 1500, 0, null]);
    assert.deepEqual(rows[3], ['王測二', '需新增1', COST_CENTER_UNSET, 0, 700, 0, 700, 0, null]);
    assert.deepEqual(rows[4], ['陳測四', 'A036872', COST_CENTER_UNSET, 0, 1100, 0, 1100, 0, 1100]);
    assert.deepEqual(rows[5], ['總合計', '', '', 0, 3800, 300, 4100, 0, 4100]);
    assert.deepEqual(rows[7], ['成本中心合計']);
    assert.deepEqual(headerRows, [0, 8]);
    assert.deepEqual(rows.slice(9), [
        ['90180', 0, 800, 0, 800],
        ['90183', 0, 1200, 300, 1500],
        [COST_CENTER_UNSET, 0, 1800, 0, 1800],
        ['合計', 0, 3800, 300, 4100],
    ]);
});

test('完整 Excel：四個分頁、代碼帳號身分證日期夥伴號碼是文字儲存格（保留前導 0）、金額是數字', async () => {
    const result = compute([
        session(T.ding, { base_salary: 12000, bonus: 500, total_salary: 12500, session_date: '2026-09-05' }),
        session(T.chen, { total_salary: 800, base_salary: 800 }),
    ]);
    const bytes = await buildPayoutWorkbook({ people: result.people, settings: SETTINGS });
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(String.fromCharCode(bytes[0], bytes[1]), 'PK');
    const zip = await JSZip.loadAsync(bytes);
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
        'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/worksheets/sheet4.xml']) {
        assert.ok(zip.file(part), `缺 ${part}`);
    }
    const workbook = await zip.file('xl/workbook.xml').async('string');
    assert.deepEqual([...workbook.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]), SHEET_NAMES);
    assert.deepEqual(SHEET_NAMES, ['轉帳檔案', '薪資明細', '薪資總計', '供應商']);
    const styles = await zip.file('xl/styles.xml').async('string');
    assert.match(styles, /<xf numFmtId="49"[^>]*applyNumberFormat="1"\/>/, '文字格式 @（numFmtId 49）');

    const sheet1 = await zip.file('xl/worksheets/sheet1.xml').async('string');
    const textCell = (ref, value) => new RegExp(`<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${value}</t></is></c>`);
    assert.match(sheet1, textCell('B2', '20261110'), '付款日期是文字');
    assert.match(sheet1, textCell('C2', '012345678901'), '付款帳號是文字');
    assert.match(sheet1, textCell('D2', '0123'), '付款分行是文字（保留前導 0）');
    assert.match(sheet1, textCell('E2', '0081832'), '解款行是文字（保留前導 0）');
    assert.match(sheet1, textCell('F2', '00291234567890'), '收款人帳號是文字（保留前導 0）');
    assert.match(sheet1, textCell('I2', 'Z100000001'), '身分證是文字');
    assert.match(sheet1, textCell('N2', '需新增1'));
    assert.match(sheet1, textCell('N3', 'A036872'), '夥伴號碼是文字');
    assert.match(sheet1, /<c r="H2" s="2"><v>12500<\/v><\/c>/, '金額是數字');
    assert.match(sheet1, /<c r="H3" s="2"><v>800<\/v><\/c>/);
    assert.doesNotMatch(sheet1, /<row r="4"/, '轉帳分頁沒有總額列');

    const sheet2 = await zip.file('xl/worksheets/sheet2.xml').async('string');
    assert.match(sheet2, /<t xml:space="preserve">2026\/9\/5<\/t>/, '課程日期是文字');
    assert.match(sheet2, /<t xml:space="preserve">合計<\/t>/);
    const sheet3 = await zip.file('xl/worksheets/sheet3.xml').async('string');
    assert.match(sheet3, /<t xml:space="preserve">總合計<\/t>/);
    assert.match(sheet3, /<v>13300<\/v>/, '總計含總額 13300');
    const sheet4 = await zip.file('xl/worksheets/sheet4.xml').async('string');
    assert.match(sheet4, new RegExp(`<t xml:space="preserve">${VENDOR_CSV_HEADERS[0].replace(/[/*]/g, '\\$&')}</t>`));
    assert.match(sheet4, /<t xml:space="preserve">0081832<\/t>/, '供應商分頁的銀行代號也是文字');
});

test('檔名、遮罩', () => {
    assert.equal(payoutFilename({ periodMonth: '2026/10', payDate: '2026-11-10', ext: 'csv' }), '202610夢想講師轉帳檔_20261110.csv');
    assert.equal(payoutFilename({ periodMonth: '2026/10', payDate: '2026-11-10', ext: 'xlsx' }), '202610夢想講師轉帳檔_20261110.xlsx');
    assert.equal(maskAccount('0029-1234-5678'), '••••5678');
    assert.equal(maskIdNumber('z100000001'), 'Z••••••001');
    assert.equal(maskAccount(''), '');
});

test('正式庫還沒套 migration：辨認 partner_no 欄位不存在的錯誤', () => {
    assert.equal(isMissingPartnerNoError({ code: '42703', message: 'column instructors.partner_no does not exist' }), true);
    assert.equal(isMissingPartnerNoError({ code: 'PGRST204', message: "Could not find the 'partner_no' column of 'instructors' in the schema cache" }), true);
    assert.equal(isMissingPartnerNoError({ code: '42703', message: 'column instructors.other_col does not exist' }), false);
    assert.equal(isMissingPartnerNoError({ code: '42501', message: 'permission denied' }), false);
    assert.equal(isMissingPartnerNoError(null), false);
});

const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));

const PARTNER_CSV = [
    ',,,,',
    '＊群組Z004/Z007個人/Z008公司,夥伴號碼,＊名稱 1,國籍,TW2 身份證字號',
    'Z007,A036872,陳測四,TW,Z100000004',      // 不變
    'Z007,A000001,丁測一,TW,z100000001',      // 會變更（身分證小寫也比得到）
    'Z007, A000002 ,王測二,TW,Z100000002',    // 會變更（號碼前後空白）
    'Z007,A000002,王測二,TW,Z100000002',      // 同一人同一號碼重複：當成一筆
    'Z007,需新增1,林測三,TW,Z100000003',      // 略過
    'Z007,,某測試,TW,Z100000009',             // 略過（空白）
    'Z007,A999999,不在系統,TW,Z199999999',    // 對不到
    'Z007,B000001,衝突甲,TW,Z188888881',      // 同一號碼兩人
    'Z007,B000001,衝突乙,TW,Z188888882',
    'Z007,C000001,衝突丙,TW,Z177777771',      // 同一人兩個號碼
    'Z007,C000002,衝突丙,TW,Z177777771',
    'Z007,A-01,格式錯,TW,Z166666661',         // 格式不符
    '"Z007","D000001","有,逗號","TW","Z155555551"',
].join('\r\n');

test('夥伴號碼匯入預覽：符合／會變更／不變／對不到／衝突，略過空白與「需新增…」', () => {
    const plan = planPartnerImport({ csvText: PARTNER_CSV, instructors: INSTRUCTORS });
    assert.equal(plan.error, '');
    assert.equal(plan.headerLine, 2);
    const byId = Object.fromEntries(plan.entries.map((e) => [e.idNumber, e]));
    assert.equal(byId.Z100000004.status, 'same');
    assert.equal(byId.Z100000001.status, 'change');
    assert.equal(byId.Z100000001.instructorId, T.ding);
    assert.equal(byId.Z100000002.status, 'change');
    assert.equal(byId.Z100000002.partnerNo, 'A000002');
    assert.equal(byId.Z199999999.status, 'unmatched');
    assert.equal(byId.Z188888881.status, 'conflict');
    assert.equal(byId.Z188888882.status, 'conflict');
    assert.equal(byId.Z177777771.status, 'conflict');
    assert.equal(byId.Z166666661.status, 'invalid');
    assert.equal(byId.Z155555551.status, 'unmatched', '引號內含逗號的欄位正確切開');
    assert.ok(!byId.Z100000003, '「需新增1」略過');
    assert.deepEqual(plan.counts, { matched: 3, change: 2, same: 1, unmatched: 2, conflict: 4, invalid: 1, skipped: 3 });
    assert.equal(byId.Z100000001.maskedId, 'Z••••••001');
});

test('夥伴號碼匯入：身分證對到多位講師算衝突；匯入後與別人同號會提醒', () => {
    const instructors = [
        ...INSTRUCTORS,
        instructor('dup-1', { full_name: '重複甲', id_number: 'Z133333331' }),
        instructor('dup-2', { full_name: '重複乙', id_number: 'Z133333331' }),
    ];
    const csv = '夥伴號碼,身分證\nE000001,Z133333331\nA036872,Z100000002\n';
    const plan = planPartnerImport({ csvText: csv, instructors });
    const [dup, clash] = plan.entries;
    assert.equal(dup.status, 'conflict');
    assert.match(dup.reason, /對到 2 位講師/);
    assert.equal(clash.status, 'change');
    assert.match(clash.warning, /匯入後與 陳測四 同號/);
});

test('夥伴號碼匯入：找不到表頭就回錯誤；Big5 編碼的 Excel CSV 也讀得懂', () => {
    assert.match(planPartnerImport({ csvText: '名稱,電話\n測試,0900\n', instructors: [] }).error, /找不到/);
    const big5 = hexBytes('2cb9d9a6f1b8b9bd582ca657bad92c54573220a8ada5f7c3d2a672b8b90d0a2c413033363837322cb4fab8d5a5d22c5a3130303030303030310d0a');
    const decoded = decodeCsvBytes(big5);
    assert.equal(decoded.encoding, 'big5');
    assert.ok(decoded.text.includes('夥伴號碼'));
    const plan = planPartnerImport({ csvText: decoded.text, instructors: INSTRUCTORS });
    assert.equal(plan.entries[0].status, 'change');
    assert.equal(plan.entries[0].partnerNo, 'A036872');
    const utf8 = decodeCsvBytes(new TextEncoder().encode('\uFEFF夥伴號碼,身份證\nA1,Z1\n'));
    assert.equal(utf8.encoding, 'utf-8');
    assert.equal(parseCsv(utf8.text)[0][0], '夥伴號碼');
});
