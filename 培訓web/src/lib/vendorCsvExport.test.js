import test from 'node:test';
import assert from 'node:assert/strict';
import {
    VENDOR_CSV_HEADERS,
    buildVendorCsv,
    createVendorExportFilename,
    filterVendorInstructors,
    getVendorExportMissingFields,
    instructorToVendorRow,
} from './vendorCsvExport.js';

const completeInstructor = {
    id: 'teacher-a',
    full_name: '王小明',
    instructor_role: 'A',
    id_number: 'A123456789',
    household_address: '臺北市信義區一號',
    address: '臺北市大安區二號',
    phone_mobile: '0912345678',
    bank_code: '0080001',
    bank_account_number: '001234567890',
    email_primary: 'teacher@example.com',
};

test('供應商格式固定為 16 欄，並保留範例中的空白欄', () => {
    assert.equal(VENDOR_CSV_HEADERS.length, 16);
    assert.deepEqual(instructorToVendorRow(completeInstructor), [
        'Z007', '', '王小明', '王小明', 'TW', 'A123456789',
        '臺北市信義區一號', '臺北市大安區二號', '', '', '0912345678',
        '0080001', '001234567890', 'teacher@example.com', '', '',
    ]);
});

test('CSV 使用 UTF-8 BOM、CRLF、第一列空白列與相同標題列', () => {
    const csv = buildVendorCsv([completeInstructor]);
    const lines = csv.slice(1).split('\r\n');
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    assert.equal(lines[0], ',,,,,,,,,,,,,,,');
    assert.equal(lines[1], VENDOR_CSV_HEADERS.join(','));
    assert.equal(lines[2].split(',').length, 16);
    assert.equal(lines.at(-1), '');
});

test('CSV 正確處理逗號、雙引號與公式開頭文字', () => {
    const csv = buildVendorCsv([{
        ...completeInstructor,
        full_name: '=HYPERLINK("bad")',
        address: '臺北市,測試路',
    }]);
    assert.match(csv, /'=HYPERLINK\(""bad""\)/);
    assert.match(csv, /"臺北市,測試路"/);
});

test('可篩選單一或多位老師', () => {
    const instructors = [
        completeInstructor,
        { ...completeInstructor, id: 'teacher-b', full_name: '李小華' },
        { ...completeInstructor, id: 'teacher-c', full_name: '陳小美' },
    ];
    const result = filterVendorInstructors({
        instructors,
        sessions: [],
        selectedInstructorIds: ['teacher-a', 'teacher-c'],
    });
    assert.deepEqual(result.map((item) => item.id).sort(), ['teacher-a', 'teacher-c']);
});

test('可依目前講師等級篩選', () => {
    const instructors = [
        completeInstructor,
        { ...completeInstructor, id: 'teacher-b', instructor_role: 'B' },
    ];
    const result = filterVendorInstructors({
        instructors,
        sessions: [],
        instructorLevel: 'B',
    });
    assert.deepEqual(result.map((item) => item.id), ['teacher-b']);
});

test('指定日期區間時，只保留區間內有報酬紀錄的老師且每人一列', () => {
    const instructors = [
        completeInstructor,
        { ...completeInstructor, id: 'teacher-b', full_name: '李小華' },
    ];
    const sessions = [
        { instructor_id: 'teacher-a', session_date: '2026-06-01' },
        { instructor_id: 'teacher-a', session_date: '2026-06-15' },
        { instructor_id: 'teacher-b', session_date: '2026-07-01' },
    ];
    const result = filterVendorInstructors({
        instructors,
        sessions,
        startDate: '2026-06-01',
        endDate: '2026-06-30',
    });
    assert.deepEqual(result.map((item) => item.id), ['teacher-a']);
});

test('未指定日期時可匯出沒有報酬紀錄的講師主檔', () => {
    const result = filterVendorInstructors({
        instructors: [completeInstructor],
        sessions: [],
    });
    assert.equal(result.length, 1);
});

test('缺漏欄位會列出可理解的中文名稱', () => {
    assert.deepEqual(
        getVendorExportMissingFields({ ...completeInstructor, id_number: '', bank_code: null }),
        ['身分證字號', '銀行代號'],
    );
});

test('檔名包含篩選區間與匯出日期', () => {
    assert.equal(
        createVendorExportFilename({
            startDate: '2026-06-01',
            endDate: '2026-06-30',
            today: '2026-08-26',
        }),
        '夢想講師供應商_2026-06-01-2026-06-30_20260826.csv',
    );
});
