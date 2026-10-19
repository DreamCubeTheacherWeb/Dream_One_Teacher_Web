// 後台「薪資登記中心」的查詢條件：月份區間、狀態、異常、搜尋都交給 Supabase 在伺服器端過濾，
// 畫面只分頁抓需要的筆數（class_sessions 2026-10-19 起有 5,535 筆，不能再一次抓固定 500 筆再前端篩）。
// 純函式不碰網路，supabase 查詢物件由呼叫端傳入，方便 node --test 直接驗證。

export const SALARY_REGISTER_PAGE_SIZE = 100;
export const SALARY_STATS_CHUNK_SIZE = 1000;
export const SALARY_FETCH_MAX_ROWS = 50000;
export const SALARY_SEARCH_MAX_LENGTH = 50;
export const SALARY_STATUS_VALUES = ['pending', 'approved', 'paid'];

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const MAX_MONTH_OPTIONS = 240;
const MAX_FUTURE_MONTHS = 24;

export const isMonthKey = (value) => MONTH_KEY.test(String(value ?? ''));

// 'YYYY-MM-DD'（或任何以 YYYY-MM 開頭的日期字串）→ 'YYYY-MM'；格式不對回空字串
export const monthKeyOf = (date) => {
    const key = String(date ?? '').slice(0, 7);
    return isMonthKey(key) ? key : '';
};

// 顯示用，與資料庫 month_label 相同的 'YYYY/MM' 格式
export const monthLabel = (key) => (isMonthKey(key) ? key.replace('-', '/') : '');

const shiftMonth = (key, delta) => {
    const [, year, month] = key.match(MONTH_KEY);
    const index = Number(year) * 12 + Number(month) - 1 + delta;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

// 月份 → session_date 區間 [from, to)；to 是下個月一號（不含）
export const monthRange = (key) => (isMonthKey(key)
    ? { from: `${key}-01`, to: `${shiftMonth(key, 1)}-01` }
    : null);

// 月份下拉選項（新到舊）：從最早一筆的月份到「最新一筆或本月，取較晚者」。
// 資料庫對 2020 年以前、兩個月後的日期只標異常不擋，打錯年份（例如 2062）時連續月份最多列到本月後兩年，
// 打錯的那個月另外補在選單裡，本月也一定在選單裡（預設月份不會缺）。
export const monthOptions = (earliestDate, latestDate, today) => {
    const current = monthKeyOf(today);
    const latest = monthKeyOf(latestDate);
    const earliest = monthKeyOf(earliestDate);
    const top = [latest, current].filter(Boolean).sort().pop() || '';
    if (!top) return [];
    const ceiling = current ? shiftMonth(current, MAX_FUTURE_MONTHS) : top;
    const newest = top > ceiling ? ceiling : top;
    const oldest = earliest && earliest < newest ? earliest : newest;
    const options = [];
    for (let key = newest; key >= oldest && options.length < MAX_MONTH_OPTIONS; key = shiftMonth(key, -1)) {
        options.push(key);
    }
    for (const extra of [latest, current, earliest]) {
        if (extra && !options.includes(extra)) options.push(extra);
    }
    return options.sort().reverse();
};

// 預設月份：最新一筆紀錄所在月份；若最新一筆在未來（預排或打錯），改用本月
export const defaultMonthKey = (latestDate, today) => {
    const current = monthKeyOf(today);
    const latest = monthKeyOf(latestDate);
    if (!latest) return current;
    if (!current) return latest;
    return latest < current ? latest : current;
};

// 搜尋字 → ILIKE 樣式。PostgREST 的 or() 語法保留 , ( ) " \ 等字元，% 與 * 是萬用字元；
// 一律換成單字元萬用字 _，仍能比對到原字元，又不會讓查詢字串被拆壞。
export const searchPattern = (text) => {
    const term = String(text ?? '').trim().slice(0, SALARY_SEARCH_MAX_LENGTH);
    if (!term) return '';
    return `%${term.replace(/[,()"\\%*]/g, '_')}%`;
};

// 搜尋講師姓名、課程名稱、課程類型代碼（與舊版前端搜尋相同的三個欄位）
export const searchOrFilter = (text) => {
    const pattern = searchPattern(text);
    if (!pattern) return '';
    return ['instructor_name', 'course_name', 'course_type']
        .map((column) => `${column}.ilike."${pattern}"`)
        .join(',');
};

export const applySalaryRegisterFilters = (query, { month = '', status = '', anomalyOnly = false, search = '' } = {}) => {
    let next = query;
    const range = monthRange(month);
    if (range) next = next.gte('session_date', range.from).lt('session_date', range.to);
    if (SALARY_STATUS_VALUES.includes(status)) next = next.eq('status', status);
    if (anomalyOnly) next = next.eq('is_anomaly', true);
    const orFilter = searchOrFilter(search);
    if (orFilter) next = next.or(orFilter);
    return next;
};

// 待處理優先：status 是 enum（pending → approved → paid 的宣告順序），由小到大排即待核准、已核准、已付款；
// 同狀態再依日期新到舊，最後用 id 讓分頁順序穩定、不重複不漏筆。
export const applySalaryRegisterOrder = (query) => query
    .order('status', { ascending: true })
    .order('session_date', { ascending: false })
    .order('id', { ascending: false });

// 依序分段抓 [from, from + limit) 的資料；limit 省略時抓到伺服器回報的總筆數為止。
// buildQuery 每次都要回傳新的查詢（含 count: 'exact'），這裡只負責接 range()。
// 以總筆數判斷是否抓完，不靠「這段比要求的少」，避免伺服器每次最多回傳筆數比 chunkSize 小時漏抓。
// 分段之間若有人新增資料，同一筆可能出現兩次：有 id 的列只留第一次（rows），fetched 則是實際抓到的原始筆數，
// 下一次「載入更多」要從 from + fetched 接著抓，才不會卡在同一段。
export async function fetchRows(buildQuery, { from = 0, limit = Infinity, chunkSize = SALARY_REGISTER_PAGE_SIZE } = {}) {
    const rows = [];
    const seen = new Set();
    let fetched = 0;
    let total = null;
    while (fetched < limit && fetched < SALARY_FETCH_MAX_ROWS) {
        const start = from + fetched;
        const size = Math.min(chunkSize, limit - fetched);
        const { data, error, count } = await buildQuery().range(start, start + size - 1);
        if (error) throw error;
        if (typeof count === 'number') total = count;
        const batch = Array.isArray(data) ? data : [];
        if (!batch.length) break;
        fetched += batch.length;
        for (const row of batch) {
            if (row?.id !== undefined && row?.id !== null) {
                if (seen.has(row.id)) continue;
                seen.add(row.id);
            }
            rows.push(row);
        }
        if (total !== null ? start + batch.length >= total : batch.length < size) break;
    }
    return { rows, fetched, total: total ?? from + fetched };
}

// 「載入更多」時合併：同一筆（分頁之間資料剛好有異動）只留第一次出現的
export const mergeById = (current, incoming) => {
    const seen = new Set(current.map((row) => row.id));
    return [...current, ...incoming.filter((row) => !seen.has(row.id) && seen.add(row.id))];
};

export const sumSalaryStats = (rows, count) => {
    const total = rows.reduce((sum, row) => sum + Number(row.total_salary || 0), 0);
    const paid = rows.reduce((sum, row) => sum + Number(row.paid_amount || 0), 0);
    return { total, paid, unpaid: total - paid, count: Number.isFinite(count) ? count : rows.length };
};
