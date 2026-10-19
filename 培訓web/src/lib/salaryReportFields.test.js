import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_REPORT_FIELDS,
    REPORT_LAYOUTS,
    allFieldsOfLayout,
    buildExtraFieldsParam,
    extraFieldEntries,
    newCustomFieldKey,
    parseOptionsText,
    validateCustomAnswers,
    validateCustomField,
    visibleFieldsOfLayout,
} from './salaryReportFields.js';

test('預設欄位與 migration 種子一致：四個版面 6／5／4／9 筆', () => {
    const counts = Object.fromEntries(REPORT_LAYOUTS.map(({ key }) => [key, allFieldsOfLayout(DEFAULT_REPORT_FIELDS, key).length]));
    assert.deepEqual(counts, { b2c_direct: 5, b2b: 6, b2c_camp: 4, other: 9 });
    assert.deepEqual(allFieldsOfLayout(DEFAULT_REPORT_FIELDS, 'b2b').filter(f => f.source === 'system').map(f => f.field_key),
        ['term_period', 'unit', 'hours', 'students']);
});

test('設定讀不到時退回預設；隱藏的內建欄位不顯示；算報酬欄位一定在', () => {
    assert.deepEqual(visibleFieldsOfLayout(null, 'b2c_camp').map(f => f.field_key), ['camp_batch', 'students', 'transport', 'incident']);
    const rows = [
        { layout: 'b2c_camp', field_key: 'incident', source: 'builtin', label: '特殊狀況回饋', sort_order: 5, is_visible: true },
        { layout: 'b2c_camp', field_key: 'transport', source: 'builtin', label: '交通補助', sort_order: 10, is_visible: false },
        { layout: 'b2c_camp', field_key: 'custom_x', source: 'custom', label: '自訂', field_type: 'select', options: ['甲'], sort_order: 15 },
        // camp_batch、students 不在設定裡（不應發生）→ 補在最後
    ];
    assert.deepEqual(visibleFieldsOfLayout(rows, 'b2c_camp').map(f => f.field_key), ['incident', 'custom_x', 'camp_batch', 'students']);
});

test('自訂欄位代碼符合資料庫格式', () => {
    const key = newCustomFieldKey();
    assert.match(key, /^custom_[a-z0-9]{10}$/);
    assert.notEqual(newCustomFieldKey(), key);
});

test('下拉選項一行一個，去空白與重複', () => {
    assert.deepEqual(parseOptionsText(' 滿意 \n\n普通\n滿意\r\n不滿意 '), ['滿意', '普通', '不滿意']);
});

test('新增自訂欄位的檢查', () => {
    assert.equal(validateCustomField({ label: ' ' }).message, '請輸入欄位名稱。');
    assert.equal(validateCustomField({ label: '甲'.repeat(61) }).ok, false);
    assert.equal(validateCustomField({ label: '滿意度', field_type: 'select', optionsText: '\n' }).message, '下拉選單至少要有一個選項（一行一個）。');
    assert.equal(validateCustomField({ label: '滿意度', field_type: 'weird' }).message, '請選擇欄位類型。');
    assert.equal(validateCustomField({ label: '地點' }, [{ id: 'x', label: '地點' }]).message, '這個版面已經有同名的欄位。');
    assert.equal(validateCustomField({ label: '地點' }, [{ id: 'x', label: '地點' }], { ignoreId: 'x' }).ok, true);
    const ok = validateCustomField({ label: ' 滿意度 ', field_type: 'select', optionsText: '滿意\n普通', help_text: ' 請家長回答 ', is_required: true });
    assert.deepEqual(ok.value, { label: '滿意度', field_type: 'select', options: ['滿意', '普通'], help_text: '請家長回答', is_required: true });
    // 是／否勾選不會是必填（沒勾就是「否」）
    assert.equal(validateCustomField({ label: '可拍照', field_type: 'boolean', is_required: true }).value.is_required, false);
});

const customFields = [
    { field_key: 'custom_sat', source: 'custom', label: '滿意度', field_type: 'select', options: ['滿意', '普通'], is_required: true },
    { field_key: 'custom_n', source: 'custom', label: '協助人數', field_type: 'number', options: [], is_required: false },
    { field_key: 'custom_ok', source: 'custom', label: '可拍照', field_type: 'boolean', options: [], is_required: false },
    { field_key: 'incident', source: 'builtin', label: '特殊狀況', field_type: 'text', options: [], is_required: true },
];

test('講師填自訂欄位：必填、數字、下拉值要在選項內', () => {
    assert.equal(validateCustomAnswers(customFields, {}), '請填寫「滿意度」。');
    assert.equal(validateCustomAnswers(customFields, { custom_sat: '超滿意' }), '請重新選擇「滿意度」。');
    assert.equal(validateCustomAnswers(customFields, { custom_sat: '滿意', custom_n: 'abc' }), '「協助人數」請填數字。');
    assert.equal(validateCustomAnswers(customFields, { custom_sat: '滿意', custom_n: '2' }), '');
});

test('送出自訂欄位：只送自訂欄位；空白不送；數字轉數字；勾選一律送 true／false', () => {
    assert.deepEqual(buildExtraFieldsParam(customFields, { custom_sat: ' 滿意 ', custom_n: '2', incident: '不該送' }),
        { custom_sat: '滿意', custom_n: 2, custom_ok: false });
    assert.equal(buildExtraFieldsParam(customFields.filter(f => f.field_type !== 'boolean'), { custom_sat: '  ' }), null);
});

test('後台顯示自訂欄位答案：用回報當時的名稱，是／否轉中文', () => {
    assert.deepEqual(extraFieldEntries({
        custom_sat: { label: '滿意度', value: '滿意' },
        custom_ok: { label: '可拍照', value: false },
        custom_n: { label: '協助人數', value: 2 },
    }), [
        { key: 'custom_sat', label: '滿意度', text: '滿意' },
        { key: 'custom_ok', label: '可拍照', text: '否' },
        { key: 'custom_n', label: '協助人數', text: '2' },
    ]);
    assert.deepEqual(extraFieldEntries(null), []);
    assert.deepEqual(extraFieldEntries(['x']), []);
});
