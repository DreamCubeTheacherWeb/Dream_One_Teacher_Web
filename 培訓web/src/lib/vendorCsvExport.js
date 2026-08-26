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

export const getVendorExportMissingFields = (instructor) => REQUIRED_EXPORT_FIELDS
    .filter(([key]) => !normalizeCsvValue(instructor?.[key]))
    .map(([, label]) => label);

export const instructorToVendorRow = (instructor) => [
    'Z007',
    '', // 財務系統夥伴號碼目前沒有存於講師主檔，禁止自行推算。
    instructor.full_name,
    instructor.full_name,
    'TW',
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

export const buildVendorCsv = (instructors) => {
    const blankRow = Array(VENDOR_CSV_HEADERS.length).fill('');
    const rows = [
        blankRow,
        VENDOR_CSV_HEADERS,
        ...instructors.map(instructorToVendorRow),
    ];

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
