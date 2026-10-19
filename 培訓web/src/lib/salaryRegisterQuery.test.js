import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SALARY_REGISTER_PAGE_SIZE,
    applySalaryRegisterFilters,
    applySalaryRegisterOrder,
    defaultMonthKey,
    fetchRows,
    mergeById,
    monthKeyOf,
    monthLabel,
    monthOptions,
    monthRange,
    searchOrFilter,
    searchPattern,
    sumSalaryStats,
} from './salaryRegisterQuery.js';

// 記錄呼叫順序的假查詢物件，模擬 supabase-js 的鏈式寫法
const recorder = () => {
    const calls = [];
    const query = new Proxy({}, {
        get: (_target, method) => (...args) => {
            calls.push([method, ...args]);
            return query;
        },
    });
    return { query, calls };
};

test('monthKeyOf／monthLabel 只接受合法年月', () => {
    assert.equal(monthKeyOf('2025-08-31'), '2025-08');
    assert.equal(monthKeyOf('2025-13-01'), '');
    assert.equal(monthKeyOf(null), '');
    assert.equal(monthLabel('2025-08'), '2025/08');
    assert.equal(monthLabel('全部'), '');
});

test('monthRange 為該月一號到下個月一號（不含），跨年正確', () => {
    assert.deepEqual(monthRange('2025-08'), { from: '2025-08-01', to: '2025-09-01' });
    assert.deepEqual(monthRange('2025-12'), { from: '2025-12-01', to: '2026-01-01' });
    assert.equal(monthRange(''), null);
    assert.equal(monthRange('2025/08'), null);
});

test('monthOptions 從最新到最早列出每個月，包含本月', () => {
    const options = monthOptions('2024-02-03', '2026-10-15', '2026-10-19');
    assert.equal(options[0], '2026-10');
    assert.equal(options.at(-1), '2024-02');
    assert.equal(options.length, 33);
    assert.ok(options.includes('2025-08'));
    // 最新一筆比本月早：仍列到本月，方便看本月（可能還沒有資料）
    assert.deepEqual(monthOptions('2026-08-01', '2026-09-30', '2026-10-19'), ['2026-10', '2026-09', '2026-08']);
    // 完全沒有資料：只有本月
    assert.deepEqual(monthOptions(null, null, '2026-10-19'), ['2026-10']);
});

test('monthOptions 遇到打錯年份（資料庫只標異常不擋）仍包含本月，打錯的月份另外補上', () => {
    const future = monthOptions('2024-02-03', '2062-03-01', '2026-10-19');
    assert.equal(future[0], '2062-03');
    assert.equal(future[1], '2028-10');
    assert.ok(future.includes('2026-10'));
    assert.equal(future.at(-1), '2024-02');
    assert.equal(future.length, 58);
    const past = monthOptions('0202-03-01', '2026-10-15', '2026-10-19');
    assert.equal(past[0], '2026-10');
    assert.equal(past.at(-1), '0202-03');
    assert.equal(past.length, 241);
    assert.equal(defaultMonthKey('2062-03-01', '2026-10-19'), '2026-10');
});

test('defaultMonthKey 取最新一筆的月份，但不跑到未來', () => {
    assert.equal(defaultMonthKey('2026-10-15', '2026-10-19'), '2026-10');
    assert.equal(defaultMonthKey('2026-09-30', '2026-10-19'), '2026-09');
    assert.equal(defaultMonthKey('2026-12-01', '2026-10-19'), '2026-10');
    assert.equal(defaultMonthKey(null, '2026-10-19'), '2026-10');
});

test('searchPattern 把 PostgREST 保留字與萬用字元換成單字元萬用字 _', () => {
    assert.equal(searchPattern('  王小明 '), '%王小明%');
    assert.equal(searchPattern(''), '');
    assert.equal(searchPattern('   '), '');
    assert.equal(searchPattern('A,B(C)"D\\E%F*G'), '%A_B_C__D_E_F_G%');
    assert.equal(searchPattern('x'.repeat(80)).length, 52);
});

test('searchOrFilter 搜三個欄位且值用雙引號包起來', () => {
    assert.equal(
        searchOrFilter('速解'),
        'instructor_name.ilike."%速解%",course_name.ilike."%速解%",course_type.ilike."%速解%"',
    );
    assert.equal(searchOrFilter(' '), '');
});

test('applySalaryRegisterFilters 把月份、狀態、異常、搜尋都送到查詢端', () => {
    const { query, calls } = recorder();
    applySalaryRegisterFilters(query, { month: '2025-08', status: 'pending', anomalyOnly: true, search: '王' });
    assert.deepEqual(calls, [
        ['gte', 'session_date', '2025-08-01'],
        ['lt', 'session_date', '2025-09-01'],
        ['eq', 'status', 'pending'],
        ['eq', 'is_anomaly', true],
        ['or', 'instructor_name.ilike."%王%",course_name.ilike."%王%",course_type.ilike."%王%"'],
    ]);
});

test('applySalaryRegisterFilters 全部月份、全部狀態時不加條件，未知狀態被忽略', () => {
    const { query, calls } = recorder();
    applySalaryRegisterFilters(query, { month: '', status: 'deleted', anomalyOnly: false, search: '' });
    assert.deepEqual(calls, []);
});

test('applySalaryRegisterOrder 待處理優先，再依日期新到舊，id 收尾', () => {
    const { query, calls } = recorder();
    applySalaryRegisterOrder(query);
    assert.deepEqual(calls, [
        ['order', 'status', { ascending: true }],
        ['order', 'session_date', { ascending: false }],
        ['order', 'id', { ascending: false }],
    ]);
});

// 假的伺服器：rows 為完整資料，maxRows 模擬 Supabase 每次最多回傳筆數
const fakeServer = (rows, { maxRows = 1000, failAt = -1 } = {}) => {
    const requests = [];
    const buildQuery = () => ({
        range: async (from, to) => {
            requests.push([from, to]);
            if (requests.length - 1 === failAt) return { data: null, error: { message: 'boom' }, count: null };
            const end = Math.min(to + 1, from + maxRows);
            return { data: rows.slice(from, end), error: null, count: rows.length };
        },
    });
    return { buildQuery, requests };
};

const makeRows = (n) => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, total_salary: 100, paid_amount: i % 2 ? 100 : 0 }));

test('fetchRows 抓一頁：只要 100 筆並回報總筆數', async () => {
    const { buildQuery, requests } = fakeServer(makeRows(607));
    const page = await fetchRows(buildQuery, { from: 0, limit: SALARY_REGISTER_PAGE_SIZE });
    assert.equal(page.rows.length, 100);
    assert.equal(page.total, 607);
    assert.equal(page.fetched, 100);
    assert.deepEqual(requests, [[0, 99]]);
});

test('fetchRows 載入更多：從已載入筆數接著抓，最後一頁不足 100 筆', async () => {
    const { buildQuery, requests } = fakeServer(makeRows(607));
    const page = await fetchRows(buildQuery, { from: 600, limit: 100 });
    assert.equal(page.rows.length, 7);
    assert.equal(page.rows[0].id, 'r600');
    assert.deepEqual(requests, [[600, 699]]);
});

test('fetchRows 不設 limit 時抓到總筆數為止，伺服器上限比 chunk 小也不漏抓', async () => {
    const { buildQuery, requests } = fakeServer(makeRows(5535), { maxRows: 500 });
    const all = await fetchRows(buildQuery, { chunkSize: 1000 });
    assert.equal(all.rows.length, 5535);
    assert.equal(all.total, 5535);
    assert.equal(new Set(all.rows.map((row) => row.id)).size, 5535);
    assert.equal(requests.length, 12);
});

test('fetchRows 保留後的大量重載（例如核准後保留已載入 300 筆）分段抓', async () => {
    const { buildQuery, requests } = fakeServer(makeRows(607));
    const page = await fetchRows(buildQuery, { from: 0, limit: 300 });
    assert.equal(page.rows.length, 300);
    assert.deepEqual(requests, [[0, 99], [100, 199], [200, 299]]);
});

test('fetchRows 空資料與錯誤', async () => {
    const empty = await fetchRows(fakeServer([]).buildQuery, { limit: 100 });
    assert.deepEqual(empty, { rows: [], fetched: 0, total: 0 });
    await assert.rejects(fetchRows(fakeServer(makeRows(10), { failAt: 0 }).buildQuery), { message: 'boom' });
});

test('fetchRows 分段之間有人新增資料時不重複，fetched 仍是實際抓到的筆數', async () => {
    const rows = makeRows(250);
    let calls = 0;
    const buildQuery = () => ({
        range: async (from, to) => {
            calls += 1;
            // 第二段之前有一筆新資料插在最前面，整體往後擠一格
            const current = calls >= 2 ? [{ id: 'new', total_salary: 1, paid_amount: 0 }, ...rows] : rows;
            return { data: current.slice(from, to + 1), error: null, count: current.length };
        },
    });
    const result = await fetchRows(buildQuery, { limit: 200 });
    assert.equal(result.fetched, 200);
    assert.equal(result.rows.length, 199);
    assert.equal(new Set(result.rows.map((row) => row.id)).size, 199);
    assert.equal(result.total, 251);
});

test('mergeById 合併時去掉重複的紀錄並保留順序', () => {
    const merged = mergeById([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }, { id: 'c' }]);
    assert.deepEqual(merged.map((row) => row.id), ['a', 'b', 'c']);
});

test('sumSalaryStats 統計篩選範圍內全部紀錄（不是只有已載入的那頁）', () => {
    const stats = sumSalaryStats(makeRows(607), 607);
    assert.deepEqual(stats, { total: 60700, paid: 30300, unpaid: 30400, count: 607 });
    assert.deepEqual(sumSalaryStats([], 0), { total: 0, paid: 0, unpaid: 0, count: 0 });
});
