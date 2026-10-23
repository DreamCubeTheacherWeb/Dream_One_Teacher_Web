// 月結匯款：把某一期「已核准、未付款」的講師報酬，整理成財務部的銀行批次轉帳檔（2026-10-22 第一版）。
// 業主：「每月薪資確認以後要可以匯出成這樣的 sheet 形式，可以匯出 csv 檔案，但是像是付款日期、付款金額
// 和付款相關附言等等的要是可以調整的內容」。格式尚未經財務確認，一律採保守做法：
//   - 錯一碼就會匯錯或退匯 → 解款行、帳號、戶名、身分證有問題的人直接擋下（不納入、不能勾選），不猜、不補 0
//   - 金額一律用「分」做整數運算；總額有小數或 ≤ 0 也擋下，請人工確認
//   - 轉帳 CSV 任何欄位不得含逗號、雙引號、換行，也不得以 = + - @ 開頭（網銀上傳不跳脫、不加前綴，有就擋）
//   - 不加總額列（銀行上傳可能把總額列當資料讀）
// 一期＝上月 26 日～本月 25 日，以結束月份命名，隔月匯款日匯（見 salaryPayday.js；本檔只讀它的函式，不改它）。
import { COURSE_LABELS } from './constants.js';
import { SETTLEMENT_CUTOFF_DAY, parseIsoDate, regularPaydayFor, resolvePayout } from './salaryPayday.js';
import { buildVendorRows } from './vendorCsvExport.js';
import { XLSX_STYLE, buildXlsx } from './simpleXlsx.js';

export const TRANSFER_HEADERS = [
    '序號', '付款日期', '付款帳號', '付款分行', '解款行', '收款人帳號', '收款人戶名',
    '付款金額', '收款人ID', '匯款通知方式', '匯款通知資訊', '付款相關附言', '手續費負擔方式', '夥伴號碼',
];
export const DETAIL_HEADERS = ['成本中心', '講師名稱', '課程種類', '課程日期', '課程名稱', '行政薪資', '薪資', '獎金'];
export const SUMMARY_HEADERS = ['講師姓名', '夥伴號碼', '成本中心', '行政薪資', '課程薪資', '獎金', '應付薪資', '二代健保', '實收薪資'];
export const COST_CENTER_SUMMARY_HEADERS = ['成本中心', '行政薪資', '課程薪資', '獎金', '應付薪資'];
export const SHEET_NAMES = ['轉帳檔案', '薪資明細', '薪資總計', '供應商'];
export const COST_CENTERS = ['90180', '90181', '90182', '90183', '90184'];
export const COST_CENTER_UNSET = '未填';
export const ADJUSTMENT_COURSE_KIND = '手動調整';
export const DEFAULT_MEMO_TEMPLATE = '{YY}/{MM}報酬夢想一號文化教育股份有限公司';
export const DEFAULT_NOTICE_METHOD = '3';
export const DEFAULT_FEE_BEARER = '2';
export const PARTNER_NO_PATTERN = /^[A-Z0-9]{1,20}$/;
export const NEW_PARTNER_PREFIX = '需新增';

// partner_no 欄位不存在的判斷放在 vendorCsvExport.js（供應商頁也要用，避免它為此載入 jszip）
export { MISSING_COLUMN_CODES, isMissingPartnerNoError } from './vendorCsvExport.js';

// ───────────────────────── 期別 ─────────────────────────
const pad2 = (n) => String(n).padStart(2, '0');
const parsePeriod = (periodMonth) => {
    const match = /^(\d{4})\/(\d{2})$/.exec(String(periodMonth ?? ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? { year, month } : null;
};
const formatPeriod = ({ year, month }) => `${year}/${pad2(month)}`;

export const shiftPeriod = (periodMonth, delta) => {
    const parsed = parsePeriod(periodMonth);
    if (!parsed) return null;
    const index = parsed.year * 12 + (parsed.month - 1) + delta;
    return formatPeriod({ year: Math.floor(index / 12), month: (index % 12) + 1 });
};

// '2026/10' → 9/26～10/25
export const periodRange = (periodMonth) => {
    const parsed = parsePeriod(periodMonth);
    if (!parsed) return null;
    const previous = parsePeriod(shiftPeriod(periodMonth, -1));
    return {
        periodMonth: formatPeriod(parsed),
        year: parsed.year,
        month: parsed.month,
        periodStart: `${previous.year}-${pad2(previous.month)}-${pad2(SETTLEMENT_CUTOFF_DAY + 1)}`,
        periodEnd: `${parsed.year}-${pad2(parsed.month)}-${pad2(SETTLEMENT_CUTOFF_DAY)}`,
    };
};

// 日期落在哪一期：26 日（含）以後算下一期
export const periodOfDate = (isoDate) => {
    const parts = parseIsoDate(isoDate);
    if (!parts) return null;
    const own = formatPeriod(parts);
    return parts.day > SETTLEMENT_CUTOFF_DAY ? shiftPeriod(own, 1) : own;
};

// 近 count 期（含 anchor，由新到舊）
export const recentPeriods = (anchorPeriod, count = 12) => (
    parsePeriod(anchorPeriod) ? Array.from({ length: count }, (_, i) => shiftPeriod(anchorPeriod, -i)) : []
);

// 預設期別＝下一個匯款日要匯的那一期；匯款日設定讀取失敗（不是「表還沒建」）或推算出錯，就用今天所在的期
// schedule：payoutScheduleFromResponse() 的結果 { nextPayday, regularDay, failed }
export const defaultPayoutPlan = (schedule, today) => {
    if (!schedule?.failed) {
        try {
            const resolved = resolvePayout(schedule || {}, today);
            return { periodMonth: resolved.periodMonth, payday: resolved.payday, source: 'schedule' };
        } catch { /* 改用今天所在的期 */ }
    }
    const periodMonth = periodOfDate(today);
    return { periodMonth, payday: regularPaydayFor(periodMonth, schedule?.regularDay), source: 'fallback' };
};

// 某一期的預設付款日：就是下一個匯款日要匯的那期 → 用那個匯款日；否則用該期的固定匯款日
export const defaultPaydayForPeriod = (periodMonth, plan, regularDay) => (
    plan && periodMonth === plan.periodMonth ? plan.payday : regularPaydayFor(periodMonth, regularDay)
);

// ───────────────────────── 附言 ─────────────────────────
export const renderMemo = (template, periodMonth) => {
    const parsed = parsePeriod(periodMonth);
    if (!parsed) return String(template ?? '');
    return String(template ?? '')
        .replaceAll('{YYYY}', String(parsed.year))
        .replaceAll('{YY}', String(parsed.year).slice(-2))
        .replaceAll('{MM}', pad2(parsed.month));
};
export const memoLength = (memo) => [...String(memo ?? '')].length;

// ───────────────────────── 正規化與遮罩 ─────────────────────────
// 去掉空白（含全形空白）與連字號（半形、全形、各種 dash）；不轉換全形數字——轉不了的就讓檢查擋下，回頭修主檔
const stripSeparators = (value) => String(value ?? '').replace(/[\s\-‐‑‒–—－]/g, '');
export const normalizeBankCode = stripSeparators;
export const normalizeAccountNumber = stripSeparators;
export const normalizeIdNumber = (value) => String(value ?? '').replace(/\s/g, '').toUpperCase();  // 匯入比對用
// 轉帳檔的收款人ID：只去前後空白、轉大寫（中間有空白或全形字就留著，交給下面的格式警告）
export const normalizeRecipientId = (value) => String(value ?? '').trim().toUpperCase();
// 本國身分證、新式居留證（第 2 碼 8／9）、舊式居留證（2 碼英文）；其他（含全形字元）一律警告
const COMMON_ID_PATTERNS = [/^[A-Z][12]\d{8}$/, /^[A-Z][89]\d{8}$/, /^[A-Z]{2}\d{8}$/];
export const isCommonIdFormat = (value) => COMMON_ID_PATTERNS.some((pattern) => pattern.test(String(value ?? '')));
export const ID_FORMAT_WARNING = '身分證／居留證格式不常見，請確認';
const normalizeName = (value) => String(value ?? '').replace(/\s/g, '');

export const maskAccount = (value) => {
    const digits = normalizeAccountNumber(value);
    return digits ? `••••${digits.slice(-4)}` : '';
};
export const maskIdNumber = (value) => {
    const id = normalizeIdNumber(value);
    if (!id) return '';
    if (id.length <= 4) return '•'.repeat(id.length);
    return `${id.slice(0, 1)}${'•'.repeat(id.length - 4)}${id.slice(-3)}`;
};

// ───────────────────────── 金額（一律用「分」） ─────────────────────────
const toCents = (value) => {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
export const centsToAmount = (cents) => cents / 100;
const formatYuan = (cents) => {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(cents);
    const yuan = Math.floor(abs / 100).toLocaleString('en-US');
    const rest = abs % 100;
    return `${sign}$${yuan}${rest ? `.${pad2(rest)}` : ''}`;
};
export const formatMoney = formatYuan;

// 單堂本次應付＝max(total_salary − paid_amount, 0)
// 分頁讀取時資料若有變動，同一列可能出現在兩頁：依 id 去重（保留第一次出現的）
export const dedupeById = (rows) => {
    const seen = new Map();
    for (const row of rows || []) if (!seen.has(row.id)) seen.set(row.id, row);
    return [...seen.values()];
};

export const sessionPayableCents = (session) => Math.max(toCents(session?.total_salary) - toCents(session?.paid_amount), 0);

// 明細的「薪資／獎金」拆分：沒付過且金額正常 → 原本的底薪／獎金；部分已付或金額異常 → 本次應付整筆放薪資、獎金 0
const splitSessionCents = (session) => {
    const payable = sessionPayableCents(session);
    const base = toCents(session?.base_salary);
    const bonus = toCents(session?.bonus);
    if (toCents(session?.paid_amount) === 0 && base >= 0 && bonus >= 0 && base + bonus === payable) {
        return { salaryCents: base, bonusCents: bonus };
    }
    return { salaryCents: payable, bonusCents: 0 };
};

// 人工調整：空白＝0；只收整數（可負數，例：-500）
export const parseAdjustment = (raw) => {
    const text = String(raw ?? '').replace(/[\s,]/g, '');
    if (text === '') return { cents: 0, valid: true };
    if (!/^[+-]?\d{1,9}$/.test(text)) return { cents: 0, valid: false };
    return { cents: Number(text) * 100, valid: true };
};

// 轉帳 CSV 欄位不可含的內容（網銀檔不跳脫，有就擋）
export const unsafeTransferCellReason = (value) => {
    const text = String(value ?? '');
    if (/[,"\r\n]/.test(text)) return '含逗號、雙引號或換行';
    if (/^[=+\-@]/.test(text)) return '以 = + - @ 開頭';
    return '';
};

// ───────────────────────── 排序 ─────────────────────────
// 財務原檔依姓名筆畫排序；不支援筆畫排序的環境退回 zh-Hant（ICU 的 zh-Hant 預設也是筆畫）
export const makeStrokeCollator = () => {
    try {
        if (Intl.Collator.supportedLocalesOf(['zh-Hant-TW']).length) return new Intl.Collator('zh-Hant-TW-u-co-stroke');
    } catch { /* 退回 */ }
    return new Intl.Collator('zh-Hant');
};

const toSet = (value) => (value instanceof Set ? value : new Set(value || []));
const sessionDateText = (iso) => {
    const parts = parseIsoDate(String(iso ?? '').slice(0, 10));
    return parts ? `${parts.year}/${parts.month}/${parts.day}` : String(iso ?? '');
};
const compareSessions = (a, b) => (
    String(a.session_date).localeCompare(String(b.session_date))
    || String(a.course_name ?? '').localeCompare(String(b.course_name ?? ''))
    || String(a.id).localeCompare(String(b.id))
);

// ───────────────────────── 每人一列 ─────────────────────────
// sessions：該期 status='approved' 的課（已依期別起訖篩好）
// instructors：講師主檔（id、full_name、bank_code、bank_account_number、bank_account_name、id_number、email_primary、partner_no…）
// 有異常標記（is_anomaly，例如疑似重複登記）的課「預設排除」，避免同一堂被匯兩次；
// 管理者確認無誤後把它放進 includedAnomalySessionIds 才會計入。
// edits：{ excludedSessionIds, includedAnomalySessionIds, excludedInstructorIds, adjustments: { [instructorId]: { amount, reason, costCenter } },
//          memoOverrides: { [instructorId]: string }, costCenters: { [sessionId]: '90180'… } }
export const computePayoutPeople = ({ sessions = [], instructors = [], periodMonth, memoTemplate = DEFAULT_MEMO_TEMPLATE, edits = {} }) => {
    const excludedSessionIds = toSet(edits.excludedSessionIds);
    const includedAnomalyIds = toSet(edits.includedAnomalySessionIds);
    const excludedInstructorIds = toSet(edits.excludedInstructorIds);
    const adjustments = edits.adjustments || {};
    const memoOverrides = edits.memoOverrides || {};
    const costCenters = edits.costCenters || {};
    const defaultMemo = renderMemo(memoTemplate, periodMonth);

    const instructorById = new Map(instructors.map((instructor) => [instructor.id, instructor]));
    const partnerHolders = new Map();
    for (const instructor of instructors) {
        const partnerNo = String(instructor.partner_no ?? '').trim();
        if (!partnerNo) continue;
        if (!partnerHolders.has(partnerNo)) partnerHolders.set(partnerNo, []);
        partnerHolders.get(partnerNo).push(instructor);
    }

    const unmatchedSessions = [];
    const groups = new Map();
    for (const session of sessions) {
        if (!session?.instructor_id) {
            unmatchedSessions.push({ ...session, payableCents: sessionPayableCents(session) });
            continue;
        }
        if (!groups.has(session.instructor_id)) groups.set(session.instructor_id, []);
        groups.get(session.instructor_id).push(session);
    }

    const people = [...groups.entries()].map(([instructorId, ownSessions]) => {
        const instructor = instructorById.get(instructorId) || null;
        const name = String(instructor?.full_name || ownSessions[0]?.instructor_name || '').trim();
        const sessionRows = [...ownSessions].sort(compareSessions).map((session) => ({
            session,
            anomaly: Boolean(session.is_anomaly),
            anomalyReasons: Array.isArray(session.anomaly_reasons) ? session.anomaly_reasons.filter(Boolean).map(String) : [],
            excluded: session.is_anomaly ? !includedAnomalyIds.has(session.id) : excludedSessionIds.has(session.id),
            payableCents: sessionPayableCents(session),
            ...splitSessionCents(session),
            costCenter: COST_CENTERS.includes(costCenters[session.id]) ? costCenters[session.id] : '',
        }));
        const included = sessionRows.filter((row) => !row.excluded);
        const systemCents = included.reduce((sum, row) => sum + row.payableCents, 0);
        const adjustmentInput = adjustments[instructorId] || {};
        const adjustment = parseAdjustment(adjustmentInput.amount);
        const adjustmentReason = String(adjustmentInput.reason ?? '').trim();
        const adjustmentCostCenter = COST_CENTERS.includes(adjustmentInput.costCenter) ? adjustmentInput.costCenter : '';
        const payCents = systemCents + adjustment.cents;

        const bankCode = normalizeBankCode(instructor?.bank_code);
        const accountNumber = normalizeAccountNumber(instructor?.bank_account_number);
        const accountName = String(instructor?.bank_account_name ?? '').trim();
        const idNumber = normalizeRecipientId(instructor?.id_number);
        const email = String(instructor?.email_primary ?? '').trim();
        const partnerNo = String(instructor?.partner_no ?? '').trim();
        const overrideMemo = String(memoOverrides[instructorId] ?? '').trim();
        const memo = overrideMemo || defaultMemo;

        const blockers = [];
        const blockerTags = [];  // 手機姓名格內的簡短標籤（例：不匯：缺解款行）
        const block = (message, tag) => { blockers.push(message); blockerTags.push(tag); };
        const warnings = [];
        if (!instructor) {
            block('找不到講師主檔', '找不到主檔');
        } else {
            if (!bankCode) block('缺解款行（銀行＋分行代碼）', '缺解款行');
            else if (!/^\d{7}$/.test(bankCode)) block(`解款行需為 7 碼數字（目前 ${[...bankCode].length} 碼${/^\d+$/.test(bankCode) ? '' : '，含非數字'}）`, '解款行有誤');
            if (!accountNumber) block('缺收款帳號', '缺帳號');
            else if (!/^\d+$/.test(accountNumber)) block('收款帳號含非數字字元', '帳號有誤');
            if (!accountName) block('缺收款人戶名', '缺戶名');
            else if (unsafeTransferCellReason(accountName)) block(`收款人戶名${unsafeTransferCellReason(accountName)}`, '戶名有誤');
            if (!idNumber) block('缺身分證字號', '缺身分證');
            else if (unsafeTransferCellReason(idNumber)) block(`身分證字號${unsafeTransferCellReason(idNumber)}`, '身分證有誤');
            if (email && unsafeTransferCellReason(email)) block(`Email ${unsafeTransferCellReason(email)}`, 'Email 有誤');
            if (partnerNo && !PARTNER_NO_PATTERN.test(partnerNo)) block('夥伴號碼格式不符', '夥伴號碼有誤');
        }
        if (payCents % 100 !== 0) block('金額有小數，請人工確認', '金額有小數');
        if (payCents <= 0) block('實付金額需大於 0', '金額為 0');

        if (instructor) {
            if (accountName && name && normalizeName(accountName) !== normalizeName(name)) warnings.push('戶名與姓名不同');
            if (!email) warnings.push('缺 Email');
            if (!partnerNo) warnings.push('需新增夥伴號碼');
            else if ((partnerHolders.get(partnerNo) || []).length > 1) {
                const others = partnerHolders.get(partnerNo).filter((other) => other.id !== instructorId).map((other) => other.full_name || '（未填姓名）');
                warnings.push(`夥伴號碼與 ${others.join('、')} 重複`);
            }
            if (/^\d+$/.test(accountNumber) && (accountNumber.length < 11 || accountNumber.length > 14)) warnings.push(`帳號 ${accountNumber.length} 碼（常見 11～14 碼），請核對`);
        }
        const needsReview = included.filter((row) => row.session.pricing_status === 'needs_review').length;
        const rejected = included.filter((row) => row.session.pricing_status === 'rejected').length;
        const partiallyPaid = included.filter((row) => toCents(row.session.paid_amount) > 0).length;
        if (needsReview) warnings.push(`含待確認報價 ${needsReview} 筆`);
        if (rejected) warnings.push(`含已退回報價 ${rejected} 筆`);
        if (partiallyPaid) warnings.push(`有部分已付 ${partiallyPaid} 筆`);
        if (instructor && idNumber && !isCommonIdFormat(idNumber)) warnings.push(ID_FORMAT_WARNING);
        const anomalyExcluded = sessionRows.filter((row) => row.anomaly && row.excluded).length;
        const anomalyIncluded = sessionRows.filter((row) => row.anomaly && !row.excluded).length;
        if (anomalyExcluded) warnings.push(`異常標記課 ${anomalyExcluded} 筆已預設排除`);
        if (anomalyIncluded) warnings.push(`已勾回異常標記課 ${anomalyIncluded} 筆，請確認不是重複登記`);

        const blocked = blockers.length > 0;
        return {
            instructorId,
            instructor,
            name,
            sessions: sessionRows,
            sessionCount: included.length,
            excludedSessionCount: sessionRows.length - included.length,
            systemCents,
            adjustmentCents: adjustment.cents,
            adjustmentValid: adjustment.valid,
            adjustmentRaw: String(adjustmentInput.amount ?? ''),
            adjustmentReason,
            adjustmentCostCenter,
            hasAdjustment: adjustment.cents !== 0 || !adjustment.valid,
            payCents,
            bankCode,
            accountNumber,
            accountName,
            idNumber,
            email,
            partnerNo,
            memo,
            memoOverridden: Boolean(overrideMemo),
            blockers,
            blockerTags,
            warnings,
            anomalyExcluded,
            anomalyIncluded,
            blocked,
            included: !blocked && !excludedInstructorIds.has(instructorId),
            partnerLabel: partnerNo,
        };
    });

    const collator = makeStrokeCollator();
    people.sort((a, b) => collator.compare(a.name, b.name) || String(a.instructorId).localeCompare(String(b.instructorId)));
    let newPartnerSeq = 0;
    for (const person of people) {
        if (person.included && !person.partnerNo) {
            newPartnerSeq += 1;
            person.partnerLabel = `${NEW_PARTNER_PREFIX}${newPartnerSeq}`;
        }
    }

    const includedPeople = people.filter((person) => person.included);
    return {
        people,
        includedPeople,
        unmatchedSessions,
        totalCents: includedPeople.reduce((sum, person) => sum + person.payCents, 0),
        blockedCount: people.filter((person) => person.blocked).length,
        anomalyExcludedCount: people.reduce((sum, person) => sum + person.anomalyExcluded, 0),
        anomalyIncludedCount: people.reduce((sum, person) => sum + person.anomalyIncluded, 0),
        warningCount: people.filter((person) => !person.blocked && person.warnings.length > 0).length,  // 被擋的人另算在 blockedCount
    };
};

// ───────────────────────── 匯出前檢查 ─────────────────────────
// settings：{ payDate: 'YYYY-MM-DD', payerAccount, payerBranch, noticeMethod, feeBearer, memoTemplate }
// 回傳錯誤訊息陣列；空陣列才可以下載
export const validatePayoutExport = ({ settings = {}, people = [] }) => {
    const errors = [];
    const payerAccount = normalizeAccountNumber(settings.payerAccount);
    const payerBranch = normalizeBankCode(settings.payerBranch);
    if (!payerAccount) errors.push('請填付款帳號（公司帳號）');
    else if (!/^\d+$/.test(payerAccount)) errors.push('付款帳號只能是數字');
    if (!payerBranch) errors.push('請填付款分行');
    else if (!/^\d{4}$/.test(payerBranch)) errors.push('付款分行需為 4 碼數字');
    if (!parseIsoDate(settings.payDate)) errors.push('付款日期無效');
    if (!/^\d{1,2}$/.test(String(settings.noticeMethod ?? '').trim())) errors.push('匯款通知方式需為數字');
    if (!/^\d{1,2}$/.test(String(settings.feeBearer ?? '').trim())) errors.push('手續費負擔方式需為數字');

    const included = people.filter((person) => person.included);
    if (included.length === 0) errors.push('沒有任何人納入匯款');
    for (const person of included) {
        if (!person.adjustmentValid) errors.push(`${person.name}：調整金額需為整數（可用負數）`);
        else if (person.adjustmentCents !== 0 && !person.adjustmentReason) errors.push(`${person.name}：有調整金額但沒填原因`);
        if (!person.memo) errors.push(`${person.name}：附言空白`);
        const memoProblem = unsafeTransferCellReason(person.memo);
        if (memoProblem) errors.push(`${person.name}：附言${memoProblem}`);
        if (person.adjustmentReason && /[\r\n]/.test(person.adjustmentReason)) errors.push(`${person.name}：調整原因不可換行`);
    }
    return errors;
};

// ───────────────────────── 轉帳檔 ─────────────────────────
export const toBankDate = (isoDate) => {
    const parts = parseIsoDate(isoDate);
    return parts ? `${parts.year}${pad2(parts.month)}${pad2(parts.day)}` : '';
};

// 一人一列，全部是字串（前導 0 原樣保留、金額不加千分位）；只輸出 included 的人，順序同 people
export const buildTransferRows = ({ people = [], settings = {} }) => people
    .filter((person) => person.included)
    .map((person, index) => [
        String(index + 1),
        toBankDate(settings.payDate),
        normalizeAccountNumber(settings.payerAccount),
        normalizeBankCode(settings.payerBranch),
        person.bankCode,
        person.accountNumber,
        person.accountName,
        String(person.payCents / 100),
        person.idNumber,
        String(settings.noticeMethod ?? '').trim(),
        person.email,
        person.memo,
        String(settings.feeBearer ?? '').trim(),
        person.partnerLabel,
    ]);

export const buildTransferCsv = ({ people = [], settings = {} }) => {
    const rows = [TRANSFER_HEADERS, ...buildTransferRows({ people, settings })];
    for (const row of rows) {
        if (row.length !== TRANSFER_HEADERS.length) throw new Error('轉帳檔欄數不符');
        for (const cell of row) {
            const problem = unsafeTransferCellReason(cell);
            if (problem) throw new Error(`轉帳檔欄位${problem}：${cell}`);
        }
    }
    return `\uFEFF${rows.map((row) => row.join(',')).join('\r\n')}\r\n`;
};

// ───────────────────────── 薪資明細（一課一列） ─────────────────────────
// 每位講師：各課 → 人工調整（課程種類「手動調整」、課程名稱＝原因、金額放薪資欄）→ 小計；最後一列合計。
// 數字欄是 number（Excel 數值儲存格），其他都是字串（文字儲存格）
export const buildDetailRows = (people = []) => {
    const rows = [DETAIL_HEADERS];
    const grand = { admin: 0, salary: 0, bonus: 0 };
    for (const person of people.filter((p) => p.included)) {
        const sub = { admin: 0, salary: 0, bonus: 0 };
        for (const row of person.sessions.filter((r) => !r.excluded)) {
            const { session } = row;
            rows.push([
                row.costCenter,
                person.name,
                COURSE_LABELS[session.course_type] || String(session.course_type ?? ''),
                sessionDateText(session.session_date),
                String(session.course_name ?? ''),
                0,
                row.salaryCents / 100,
                row.bonusCents / 100,
            ]);
            sub.salary += row.salaryCents;
            sub.bonus += row.bonusCents;
        }
        if (person.adjustmentCents !== 0) {
            rows.push([person.adjustmentCostCenter, person.name, ADJUSTMENT_COURSE_KIND, '', person.adjustmentReason, 0, person.adjustmentCents / 100, 0]);
            sub.salary += person.adjustmentCents;
        }
        rows.push(['小計', person.name, '', '', '', sub.admin / 100, sub.salary / 100, sub.bonus / 100]);
        grand.admin += sub.admin;
        grand.salary += sub.salary;
        grand.bonus += sub.bonus;
    }
    rows.push(['合計', '', '', '', '', grand.admin / 100, grand.salary / 100, grand.bonus / 100]);
    return rows;
};

// ───────────────────────── 薪資總計（講師 × 成本中心） ─────────────────────────
const costCenterOrder = (label) => {
    const index = COST_CENTERS.indexOf(label);
    return index === -1 ? COST_CENTERS.length : index;
};
export const buildSummaryRows = (people = []) => {
    const rows = [SUMMARY_HEADERS];
    const byCenter = new Map();
    const grand = { admin: 0, salary: 0, bonus: 0, payable: 0, nhi: 0, net: 0 };
    for (const person of people.filter((p) => p.included)) {
        const groups = new Map();
        const add = (center, salaryCents, bonusCents) => {
            const label = center || COST_CENTER_UNSET;
            if (!groups.has(label)) groups.set(label, { salary: 0, bonus: 0 });
            groups.get(label).salary += salaryCents;
            groups.get(label).bonus += bonusCents;
        };
        for (const row of person.sessions.filter((r) => !r.excluded)) add(row.costCenter, row.salaryCents, row.bonusCents);
        if (person.adjustmentCents !== 0) add(person.adjustmentCostCenter, person.adjustmentCents, 0);
        const labels = [...groups.keys()].sort((a, b) => costCenterOrder(a) - costCenterOrder(b) || a.localeCompare(b));
        labels.forEach((label, index) => {
            const { salary, bonus } = groups.get(label);
            const payable = salary + bonus;
            rows.push([
                person.name,
                person.partnerLabel,
                label,
                0,
                salary / 100,
                bonus / 100,
                payable / 100,
                0, // 二代健保：第一版未計算
                index === 0 ? person.payCents / 100 : null,
            ]);
            if (!byCenter.has(label)) byCenter.set(label, { salary: 0, bonus: 0 });
            byCenter.get(label).salary += salary;
            byCenter.get(label).bonus += bonus;
            grand.salary += salary;
            grand.bonus += bonus;
            grand.payable += payable;
        });
        grand.net += person.payCents;
    }
    rows.push(['總合計', '', '', grand.admin / 100, grand.salary / 100, grand.bonus / 100, grand.payable / 100, grand.nhi / 100, grand.net / 100]);
    rows.push([]);
    rows.push(['成本中心合計']);
    const centerHeaderRow = rows.length;
    rows.push(COST_CENTER_SUMMARY_HEADERS);
    const centerTotal = { salary: 0, bonus: 0 };
    for (const label of [...byCenter.keys()].sort((a, b) => costCenterOrder(a) - costCenterOrder(b) || a.localeCompare(b))) {
        const { salary, bonus } = byCenter.get(label);
        rows.push([label, 0, salary / 100, bonus / 100, (salary + bonus) / 100]);
        centerTotal.salary += salary;
        centerTotal.bonus += bonus;
    }
    rows.push(['合計', 0, centerTotal.salary / 100, centerTotal.bonus / 100, (centerTotal.salary + centerTotal.bonus) / 100]);
    return { rows, headerRows: [0, centerHeaderRow] };
};

// ───────────────────────── 完整 Excel（四分頁） ─────────────────────────
export const buildPayoutWorkbook = async ({ people = [], settings = {} }) => {
    const included = people.filter((person) => person.included);
    const transferRows = buildTransferRows({ people, settings }).map((row) => [
        Number(row[0]), ...row.slice(1, 7), Number(row[7]), ...row.slice(8),
    ]);
    const summary = buildSummaryRows(people);
    const vendorRows = buildVendorRows(included.map((person) => person.instructor));
    return buildXlsx([
        {
            name: SHEET_NAMES[0],
            rows: [TRANSFER_HEADERS, ...transferRows],
            headerRows: [0],
            numberStyle: XLSX_STYLE.integer,
            colWidths: [6, 11, 16, 9, 10, 18, 14, 10, 13, 12, 26, 40, 14, 12],
        },
        {
            name: SHEET_NAMES[1],
            rows: buildDetailRows(people),
            headerRows: [0],
            colWidths: [10, 12, 18, 12, 28, 10, 10, 10],
        },
        {
            name: SHEET_NAMES[2],
            rows: summary.rows,
            headerRows: summary.headerRows,
            colWidths: [14, 12, 10, 10, 10, 10, 10, 10, 10],
        },
        {
            name: SHEET_NAMES[3],
            rows: vendorRows,
            headerRows: [1],
            colWidths: [10, 12, 12, 12, 6, 13, 30, 30, 4, 4, 13, 10, 18, 26, 4, 4],
        },
    ]);
};

// 檔名：{YYYYMM}夢想講師轉帳檔_{付款日期}.csv／.xlsx；有匯出紀錄時加上 _匯出{編號}（檔案內容不變，編號只放檔名）
export const payoutFilename = ({ periodMonth, payDate, ext, exportId }) => {
    const parsed = parsePeriod(periodMonth);
    const period = parsed ? `${parsed.year}${pad2(parsed.month)}` : 'unknown';
    const suffix = Number.isInteger(exportId) && exportId > 0 ? `_匯出${exportId}` : '';
    return `${period}夢想講師轉帳檔_${toBankDate(payDate) || 'unknown'}${suffix}.${ext}`;
};

// ───────────────────────── 夥伴號碼匯入（財務供應商分頁匯出的 CSV） ─────────────────────────
// 先試 UTF-8（Google 試算表、Excel「CSV UTF-8」）；解不開或找不到表頭就改試 Big5（Excel 傳統 CSV）
export const decodeCsvBytes = (bytes) => {
    const candidates = ['utf-8', 'big5'];
    let fallback = null;
    for (const encoding of candidates) {
        let text;
        try {
            text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        } catch {
            continue;
        }
        text = text.replace(/^\uFEFF/, '');
        if (!fallback) fallback = { text, encoding };
        if (findPartnerHeader(parseCsv(text))) return { text, encoding };
    }
    return fallback || { text: new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''), encoding: 'utf-8' };
};

// RFC 4180：逗號分隔、雙引號包起來的欄位可含逗號／換行，"" 代表一個雙引號
export const parseCsv = (text) => {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const source = String(text ?? '').replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        if (quoted) {
            if (ch === '"') {
                if (source[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
            } else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && source[i + 1] === '\n') i += 1;
            row.push(cell); rows.push(row); row = []; cell = '';
        } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
};

const findPartnerHeader = (rows) => {
    for (let r = 0; r < rows.length; r += 1) {
        const cells = rows[r].map((cell) => String(cell ?? '').trim());
        const partnerCol = cells.findIndex((cell) => cell.includes('夥伴號碼'));
        if (partnerCol === -1) continue;
        const idCol = cells.findIndex((cell) => cell.includes('身份證') || cell.includes('身分證'));
        if (idCol === -1) continue;
        return { headerRow: r, partnerCol, idCol };
    }
    return null;
};

// 預覽：change（會變更）、same（不變）、unmatched（對不到）、conflict（衝突）、invalid（號碼格式不符）
export const planPartnerImport = ({ csvText, instructors = [] }) => {
    const rows = parseCsv(csvText);
    const header = findPartnerHeader(rows);
    if (!header) {
        return { error: '找不到含「夥伴號碼」與「身分證／身份證」的表頭列。請確認上傳的是財務供應商分頁匯出的 CSV。', entries: [], counts: {} };
    }

    const byIdNumber = new Map();
    for (const instructor of instructors) {
        const id = normalizeIdNumber(instructor.id_number);
        if (!id) continue;
        if (!byIdNumber.has(id)) byIdNumber.set(id, []);
        byIdNumber.get(id).push(instructor);
    }

    let skipped = 0;
    const seen = new Map();
    const raw = [];
    for (let r = header.headerRow + 1; r < rows.length; r += 1) {
        const partnerNo = String(rows[r][header.partnerCol] ?? '').replace(/\s/g, '').toUpperCase();
        const idNumber = normalizeIdNumber(rows[r][header.idCol]);
        if (!partnerNo || !idNumber || partnerNo.startsWith(NEW_PARTNER_PREFIX)) { skipped += 1; continue; }
        const key = `${idNumber}\u0000${partnerNo}`;
        if (seen.has(key)) { skipped += 1; continue; }  // 同一人同一號碼重複出現：當成一筆
        seen.set(key, true);
        raw.push({ line: r + 1, idNumber, partnerNo });
    }

    const idsByPartner = new Map();
    const partnersById = new Map();
    for (const entry of raw) {
        if (!idsByPartner.has(entry.partnerNo)) idsByPartner.set(entry.partnerNo, new Set());
        idsByPartner.get(entry.partnerNo).add(entry.idNumber);
        if (!partnersById.has(entry.idNumber)) partnersById.set(entry.idNumber, new Set());
        partnersById.get(entry.idNumber).add(entry.partnerNo);
    }

    const entries = raw.map((entry) => {
        const matches = byIdNumber.get(entry.idNumber) || [];
        const base = { ...entry, maskedId: maskIdNumber(entry.idNumber) };
        if (!PARTNER_NO_PATTERN.test(entry.partnerNo)) return { ...base, status: 'invalid', reason: '號碼只能是英數 1～20 碼' };
        if (idsByPartner.get(entry.partnerNo).size > 1) return { ...base, status: 'conflict', reason: '同一號碼對到多人', name: matches[0]?.full_name };
        if (partnersById.get(entry.idNumber).size > 1) return { ...base, status: 'conflict', reason: '同一人出現兩個號碼', name: matches[0]?.full_name };
        if (matches.length === 0) return { ...base, status: 'unmatched', reason: '系統找不到這個身分證' };
        if (matches.length > 1) return { ...base, status: 'conflict', reason: `身分證對到 ${matches.length} 位講師`, name: matches.map((m) => m.full_name).join('、') };
        const [instructor] = matches;
        const oldPartnerNo = String(instructor.partner_no ?? '').trim();
        return {
            ...base,
            instructorId: instructor.id,
            name: instructor.full_name,
            oldPartnerNo,
            status: oldPartnerNo === entry.partnerNo ? 'same' : 'change',
        };
    });

    // 匯入後會不會跟「沒在這次變更裡」的別位講師同號（不擋，只提醒）
    const finalPartner = new Map(instructors.map((instructor) => [instructor.id, String(instructor.partner_no ?? '').trim()]));
    for (const entry of entries) if (entry.status === 'change') finalPartner.set(entry.instructorId, entry.partnerNo);
    for (const entry of entries) {
        if (entry.status !== 'change') continue;
        const holders = instructors.filter((instructor) => instructor.id !== entry.instructorId && finalPartner.get(instructor.id) === entry.partnerNo);
        if (holders.length) entry.warning = `匯入後與 ${holders.map((h) => h.full_name || '（未填姓名）').join('、')} 同號`;
    }

    const counts = { matched: 0, change: 0, same: 0, unmatched: 0, conflict: 0, invalid: 0, skipped };
    for (const entry of entries) {
        counts[entry.status] += 1;
        if (entry.status === 'change' || entry.status === 'same') counts.matched += 1;
    }
    return { error: '', entries, counts, headerLine: header.headerRow + 1 };
};
