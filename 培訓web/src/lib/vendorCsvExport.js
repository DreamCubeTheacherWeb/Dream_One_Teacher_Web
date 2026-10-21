export const VENDOR_CSV_HEADERS = [
    '＊群組Z004/Z007個人/Z008公司',
    '夥伴號碼',
    '＊名稱 1',
    '＊搜尋 1',
    '國籍',
    'TW2 身份證字號',
    '＊戶籍地址',
    '＊通訊地址',
    '',
    '',
    '電話',
    '銀行代號',
    '銀行帳號',
    '電子郵件',
    '',
    '',
];

// 正式庫還沒套 20261022093700_instructor_partner_no.sql 時，查詢帶 partner_no 會回這兩種代碼：
// 42703＝SELECT 的欄位不存在；PGRST204＝PATCH／INSERT 的欄位不在 schema cache
export const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);
export const isMissingPartnerNoError = (error) => Boolean(
    error
    && MISSING_COLUMN_CODES.has(String(error.code))
    && (!error.message || /partner_no/.test(error.message)),
);

const REQUIRED_EXPORT_FIELDS = [
    ['full_name', '姓名'],
    ['id_number', '身分證字號'],
    ['household_address', '戶籍地址'],
    ['address', '通訊地址'],
    ['phone_mobile', '電話'],
    ['bank_code', '銀行代號'],
    ['bank_account_number', '銀行帳號'],
    ['email_primary', '電子郵件'],
];

const normalizeCsvValue = (value) => {
    if (value === null || value === undefined) return '';
    const normalized = String(value).replace(/\r\n|\r|\n/g, ' ').trim();
    // Avoid spreadsheet formula execution while preserving ordinary identifiers
    // such as bank codes and account numbers with leading zeroes.
    return /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
};

const escapeCsvCell = (value) => {
    const normalized = normalizeCsvValue(value);
    return /[",\r\n]/.test(normalized)
        ? `"${normalized.replace(/"/g, '""')}"`
        : normalized;
};

// 國籍只在身分證是本國格式（1 碼英文＋性別碼 1／2＋8 碼數字）時才填 TW；
// 居留證、舊式統一證號或空白一律留空，交給財務確認（2026-10-22，原本寫死 TW）。
const TW_NATIONAL_ID = /^[A-Z][12]\d{8}$/;
export const vendorNationalityOf = (idNumber) => (
    TW_NATIONAL_ID.test(String(idNumber ?? '').replace(/\s/g, '').toUpperCase()) ? 'TW' : ''
);
export const NATIONALITY_UNCONFIRMED = '國籍需確認';

export const getVendorExportMissingFields = (instructor) => {
    const missing = REQUIRED_EXPORT_FIELDS
        .filter(([key]) => !normalizeCsvValue(instructor?.[key]))
        .map(([, label]) => label);
    if (!vendorNationalityOf(instructor?.id_number)) missing.push(NATIONALITY_UNCONFIRMED);
    return missing;
};

export const instructorToVendorRow = (instructor) => [
    'Z007',
    // 夥伴號碼只用資料庫裡財務給的值（instructors.partner_no，由後台匯入）；沒有就留白，禁止自行推算。
    instructor.partner_no || '',
    instructor.full_name,
    instructor.full_name,
    vendorNationalityOf(instructor.id_number),
    instructor.id_number,
    instructor.household_address,
    instructor.address,
    '',
    '',
    instructor.phone_mobile,
    instructor.bank_code,
    instructor.bank_account_number,
    instructor.email_primary,
    '',
    '',
];

// 財務供應商格式：第一列空白、第二列表頭、之後一人一列（CSV 與月結匯款 Excel 的「供應商」分頁共用）
export const buildVendorRows = (instructors) => [
    Array(VENDOR_CSV_HEADERS.length).fill(''),
    VENDOR_CSV_HEADERS,
    ...instructors.map(instructorToVendorRow),
];

export const buildVendorCsv = (instructors) => {
    const rows = buildVendorRows(instructors);
    return `\uFEFF${rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}\r\n`;
};

export const filterVendorInstructors = ({
    instructors,
    sessions,
    selectedInstructorIds = [],
    startDate = '',
    endDate = '',
    instructorLevel = '',
}) => {
    const selectedIds = new Set(selectedInstructorIds);
    const useSessionDateFilter = Boolean(startDate || endDate);
    const sessionInstructorIds = useSessionDateFilter
        ? new Set(sessions
            .filter((session) => {
                if (!session.instructor_id || !session.session_date) return false;
                if (startDate && session.session_date < startDate) return false;
                if (endDate && session.session_date > endDate) return false;
                return true;
            })
            .map((session) => session.instructor_id))
        : null;

    return instructors
        .filter((instructor) => {
            if (selectedIds.size > 0 && !selectedIds.has(instructor.id)) return false;
            if (instructorLevel && instructor.instructor_role !== instructorLevel) return false;
            if (sessionInstructorIds && !sessionInstructorIds.has(instructor.id)) return false;
            return true;
        })
        .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'zh-Hant'));
};

export const createVendorExportFilename = ({ startDate = '', endDate = '', today }) => {
    const rangeLabel = startDate || endDate
        ? `${startDate || '最早'}-${endDate || '最新'}`
        : '全部講師';
    return `夢想講師供應商_${rangeLabel}_${today.replaceAll('-', '')}.csv`;
};
