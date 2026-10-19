import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EMPTY_REPORT_EXTRAS,
    OTHER_OPTION,
    buildReportExtrasParams,
    groupReportOptions,
    reportGroupFor,
    reportLayoutFor,
    reportFieldsFor,
    roleForCourseType,
    validateReportBasics,
    buildReportBasicParams,
    partnerUnitsFor,
    campBatchesFor,
    deriveCourseType,
    termPeriodChoices,
    validateReportExtras,
} from './salaryReportForm.js';
import { DEFAULT_REPORT_FIELDS, visibleFieldsOfLayout } from './salaryReportFields.js';

const extras = (patch = {}) => ({ ...EMPTY_REPORT_EXTRAS, ...patch });

test('course types map to the Google form sections', () => {
    assert.equal(reportGroupFor('collab_lead'), 'collab');
    assert.equal(reportGroupFor('collab_assistant'), 'collab');
    assert.equal(reportGroupFor('camp'), 'camp');
    assert.equal(reportGroupFor('camp_director_5d'), 'camp');
    assert.equal(reportGroupFor('speed_camp'), 'camp');
    assert.equal(reportGroupFor('onsite_1_5hr'), 'direct');
    assert.equal(reportGroupFor('regular_basic'), 'direct');
    assert.equal(reportGroupFor(undefined), 'direct');
});

test('collab reports require term period and unit, matching the RPC messages', () => {
    assert.equal(validateReportExtras('collab_lead', extras()), '合作課程請選擇教學課程期間。');
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'spring' })), '教學課程期間不正確。');
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'semester' })), '合作課程請選擇本次上課單位。');
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'semester', unit_choice: OTHER_OPTION, unit_other: '  ' })), '合作課程請選擇本次上課單位。');
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'semester', unit_choice: OTHER_OPTION, unit_other: '新單位', materials_issued: '楓'.repeat(201) })), '上課單位／營隊梯次或教材數量不得超過 200 字。');
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'semester', unit_choice: '【臺北】新生國小' })), '請填寫本次發出教材數量（沒有發教材請填 0）。');
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'semester', unit_choice: '【臺北】新生國小', materials_issued: '0' })), '');
});

test('camp reports require a batch', () => {
    assert.equal(validateReportExtras('camp', extras()), '營隊課程請選擇營隊梯次。');
    assert.equal(validateReportExtras('camp_director_2d', extras({ unit_choice: '【臺北A】中山 | 7/1~7/3 三日營' })), '');
});

test('direct transport subsidy needs a distance in (0, 500] after rounding', () => {
    assert.equal(validateReportExtras('onsite_1_5hr', extras()), '');
    assert.equal(validateReportExtras('onsite_1_5hr', extras({ transport_requested: true })), '申請交通補助請填寫單趟公里數。');
    for (const value of ['0', '0.04', '-3', '500.1', 'abc']) {
        assert.equal(validateReportExtras('onsite_1_5hr', extras({ transport_requested: true, transport_distance_km: value })), '單趟公里數必須大於 0 且不超過 500 公里。', value);
    }
    assert.equal(validateReportExtras('onsite_1_5hr', extras({ transport_requested: true, transport_distance_km: '500' })), '');
});

test('params only carry fields visible for the selected course type', () => {
    const leftover = extras({
        term_period: 'semester',
        unit_choice: '【臺北】新生國小',
        materials_issued: ' 楓葉10 ',
        transport_requested: true,
        transport_distance_km: '12.35',
    });
    assert.deepEqual(buildReportExtrasParams('collab_lead', leftover), {
        p_term_period: 'semester',
        p_unit_name: '【臺北】新生國小',
        p_materials_issued: '楓葉10',
        p_transport_subsidy_requested: false,
        p_transport_distance_km: null,
    });
    assert.deepEqual(buildReportExtrasParams('camp', leftover), {
        p_term_period: null,
        p_unit_name: '【臺北】新生國小',
        p_materials_issued: null,
        p_transport_subsidy_requested: true,
        p_transport_distance_km: 12.4,
    });
    assert.deepEqual(buildReportExtrasParams('onsite_1_5hr', leftover), {
        p_term_period: null,
        p_unit_name: null,
        p_materials_issued: null,
        p_transport_subsidy_requested: true,
        p_transport_distance_km: 12.4,
    });
    assert.equal(buildReportExtrasParams('onsite_1_5hr', { ...leftover, transport_requested: false }).p_transport_distance_km, null);
    assert.equal(buildReportExtrasParams('camp', extras({ unit_choice: OTHER_OPTION, unit_other: ' 自辦營隊 ' })).p_unit_name, '自辦營隊');
});

test('options are grouped, sorted, and fall back to built-in term labels', () => {
    const grouped = groupReportOptions([
        { kind: 'camp_batch', value: 'B', label: 'B', sort_order: 20 },
        { kind: 'camp_batch', value: 'A', label: 'A', sort_order: 10 },
        { kind: 'camp_batch', value: 'X', label: 'X', sort_order: 5, is_active: false },
        { kind: 'unknown', value: 'Z', label: 'Z' },
    ]);
    assert.deepEqual(grouped.camp_batch.map(o => o.value), ['A', 'B']);
    assert.deepEqual(grouped.partner_unit, []);
    assert.deepEqual(termPeriodChoices(groupReportOptions(null)).map(o => o.label), ['寒假', '學期間', '暑假']);
});

test('版面依回報類別：B2B／B2C 直營／B2C 營隊／其他', () => {
    assert.equal(reportLayoutFor('collab_assistant'), 'b2b');
    assert.equal(reportLayoutFor('onsite_1_5hr'), 'b2c_direct');
    assert.equal(reportLayoutFor('trial'), 'b2c_direct');
    assert.equal(reportLayoutFor('camp_director_5d'), 'b2c_camp');
    assert.equal(reportLayoutFor('speed_camp'), 'b2c_camp');
    assert.equal(reportLayoutFor('regular_basic'), 'other');
    assert.equal(reportLayoutFor('counter'), 'other');
});

test('B2B 與 B2C 只保留表單上的基本欄位；其他課程維持完整欄位', () => {
    assert.deepEqual([...reportFieldsFor('collab_lead')], ['term_period', 'unit', 'hours', 'students', 'materials', 'incident']);
    assert.deepEqual([...reportFieldsFor('online')], ['course_name', 'hours', 'students', 'transport', 'incident']);
    assert.deepEqual([...reportFieldsFor('camp')], ['camp_batch', 'students', 'transport', 'incident']);
    assert.ok(reportFieldsFor('regular_basic').has('location') && reportFieldsFor('regular_basic').has('progress'));
});

test('角色由報酬項目推定', () => {
    assert.equal(roleForCourseType('collab_lead'), 'lead');
    assert.equal(roleForCourseType('collab_assistant'), 'assistant');
    assert.equal(roleForCourseType('camp_director_2d'), 'project_lead');
    assert.equal(roleForCourseType('counter'), 'counter');
    assert.equal(roleForCourseType('trial'), 'lead');
});

test('表單必填：B2C 直營要課程名稱、時數、人數；B2B 要時數、人數；營隊要人數；其他不強制', () => {
    const base = { course_name: '', duration_hours: '', student_count: '' };
    assert.equal(validateReportBasics('online', base), '請填寫課程名稱（學生代表姓名或課程地點）。');
    assert.equal(validateReportBasics('online', { ...base, course_name: '王小明' }), '請填寫上課時數。');
    assert.equal(validateReportBasics('online', { ...base, course_name: '王小明', duration_hours: '1.5' }), '請填寫本次上課人數。');
    assert.equal(validateReportBasics('online', { course_name: '王小明', duration_hours: '1.5', student_count: '2' }), '');
    assert.equal(validateReportBasics('collab_lead', base), '請填寫上課時數。');
    assert.equal(validateReportBasics('collab_lead', { ...base, duration_hours: '2' }), '請填寫本次上課人數。');
    assert.equal(validateReportBasics('camp', base), '請填寫本次上課人數。');
    assert.equal(validateReportBasics('regular_basic', base), '');
});

test('只送出目前版面看得到的基本欄位', () => {
    const form = {
        course_name: '王小明', duration_hours: '1.5', student_count: '2', location: '台北', role_in_session: 'assistant',
        self_review: '還行', progress_note: '進度', incident_report: '無事',
    };
    assert.deepEqual(buildReportBasicParams('collab_assistant', form), {
        p_role_in_session: 'assistant', p_course_name: null, p_location: null, p_duration_hours: 1.5, p_student_count: 2,
        p_self_review: null, p_progress_note: null, p_incident_report: '無事',
    });
    assert.deepEqual(buildReportBasicParams('camp_director_5d', form), {
        p_role_in_session: 'project_lead', p_course_name: null, p_location: null, p_duration_hours: null, p_student_count: 2,
        p_self_review: null, p_progress_note: null, p_incident_report: '無事',
    });
    const direct = buildReportBasicParams('onsite_1_5hr', form);
    assert.equal(direct.p_course_name, '王小明');
    assert.equal(direct.p_location, null);
    assert.equal(direct.p_role_in_session, 'lead');
    const other = buildReportBasicParams('regular_basic', form);
    assert.equal(other.p_location, '台北');
    assert.equal(other.p_role_in_session, 'assistant');
    assert.equal(other.p_progress_note, '進度');
});

const periodRows = [
    { kind: 'term_period', id: 'p-w', value: 'winter_break', label: '2026年寒假', sort_order: 10, is_active: true },
    { kind: 'term_period', id: 'p-s', value: 'semester', label: '115學年度上學期', sort_order: 20, is_active: true },
    { kind: 'term_period', id: 'p-u', value: 'summer_break', label: '2026年暑假', sort_order: 30, is_active: true },
    { kind: 'partner_unit', id: 'u-1', period_id: 'p-w', value: 'A校', label: 'A校', sort_order: 10, is_active: true },
    { kind: 'partner_unit', id: 'u-2', period_id: 'p-s', value: 'B校115上', label: 'B校115上', sort_order: 10, is_active: true },
    { kind: 'partner_unit', id: 'u-3', period_id: 'p-u', value: 'A校', label: 'A校', sort_order: 10, is_active: true },
    { kind: 'camp_batch', id: 'c-2', period_id: 'p-u', value: '暑假梯次', label: '暑假梯次', sort_order: 10, is_active: true },
    { kind: 'camp_batch', id: 'c-1', period_id: 'p-w', value: '寒假梯次', label: '寒假梯次', sort_order: 10, is_active: true },
];

test('合作單位跟著選到的期間；未選或找不到期間為空', () => {
    const options = groupReportOptions(periodRows);
    assert.deepEqual(partnerUnitsFor(options, '').map(u => u.value), []);
    assert.deepEqual(partnerUnitsFor(options, 'no_such').map(u => u.value), []);
    assert.deepEqual(partnerUnitsFor(options, 'winter_break').map(u => u.key), ['u-1']);
    assert.deepEqual(partnerUnitsFor(options, 'summer_break').map(u => u.key), ['u-3']);
    assert.deepEqual(partnerUnitsFor(options, 'semester').map(u => u.value), ['B校115上']);
});

test('期間停用（講師讀不到期間列）時，它底下的單位與梯次一起收掉', () => {
    const options = groupReportOptions(periodRows.filter(row => row.id !== 'p-w'));
    assert.deepEqual(options.partner_unit.map(u => u.id), ['u-2', 'u-3']);
    assert.deepEqual(campBatchesFor(options).map(b => b.key), ['c-2']);
});

test('營隊梯次依期間順序排列，送出時帶上梯次所屬的期間', () => {
    const options = groupReportOptions(periodRows);
    const batches = campBatchesFor(options);
    assert.deepEqual(batches.map(b => [b.key, b.period_label]), [['c-1', '2026年寒假'], ['c-2', '2026年暑假']]);
    const params = buildReportExtrasParams('camp', extras({ unit_choice: 'c-2' }), { options });
    assert.equal(params.p_unit_name, '暑假梯次');
    assert.equal(params.p_term_period, 'summer_break');
    const typed = buildReportExtrasParams('camp', extras({ unit_choice: OTHER_OPTION, unit_other: '自辦營隊' }), { options });
    assert.equal(typed.p_term_period, null);
    assert.equal(validateReportExtras('camp', extras({ unit_choice: 'c-1' }), { options }), '');
});

test('合作課：單位以 id 選取、送出文字；期間要在啟用清單裡（新增的期間代碼也可以）', () => {
    const options = groupReportOptions([
        ...periodRows,
        { kind: 'term_period', id: 'p-n', value: 'term_abc123', label: '2027年寒假', sort_order: 40, is_active: true },
        { kind: 'partner_unit', id: 'u-9', period_id: 'p-n', value: 'C校', label: 'C校', sort_order: 10, is_active: true },
    ]);
    const filled = extras({ term_period: 'term_abc123', unit_choice: 'u-9', materials_issued: '0' });
    assert.equal(validateReportExtras('collab_lead', filled, { options }), '');
    assert.equal(validateReportExtras('collab_lead', { ...filled, term_period: 'spring' }, { options }), '教學課程期間不正確。');
    assert.deepEqual(buildReportExtrasParams('collab_lead', filled, { options }), {
        p_term_period: 'term_abc123',
        p_unit_name: 'C校',
        p_materials_issued: '0',
        p_transport_subsidy_requested: false,
        p_transport_distance_km: null,
    });
});

test('後台隱藏內建欄位：不顯示、不驗證、不送出；改必填會擋', () => {
    const hidden = (layout, keys) => visibleFieldsOfLayout(
        DEFAULT_REPORT_FIELDS.map(row => (row.layout === layout && keys.includes(row.field_key) ? { ...row, is_visible: false } : row)),
        layout,
    );
    const campFields = hidden('b2c_camp', ['transport', 'incident']);
    assert.deepEqual([...reportFieldsFor('camp', campFields)], ['camp_batch', 'students']);
    const camp = buildReportExtrasParams('camp', extras({ unit_choice: 'X', transport_requested: true, transport_distance_km: '' }), { fields: campFields });
    assert.equal(camp.p_transport_subsidy_requested, false);
    assert.equal(validateReportExtras('camp', extras({ unit_choice: 'X', transport_requested: true }), { fields: campFields }), '');
    assert.equal(buildReportBasicParams('camp', { student_count: '3', incident_report: '殘留' }, campFields).p_incident_report, null);

    const b2bFields = hidden('b2b', ['materials']);
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'semester', unit_choice: 'A' }), { fields: b2bFields }), '');
    assert.equal(buildReportExtrasParams('collab_lead', extras({ term_period: 'semester', unit_choice: 'A', materials_issued: '5' }), { fields: b2bFields }).p_materials_issued, null);

    const directFields = hidden('b2c_direct', ['course_name']);
    assert.equal(validateReportBasics('online', { course_name: '', duration_hours: '1', student_count: '1' }, directFields), '');
    assert.equal(buildReportBasicParams('online', { course_name: '殘留', duration_hours: '1', student_count: '1' }, directFields).p_course_name, null);

    const otherFields = visibleFieldsOfLayout(
        DEFAULT_REPORT_FIELDS.map(row => (row.layout === 'other' && row.field_key === 'location' ? { ...row, is_required: true } : row)),
        'other',
    );
    assert.equal(validateReportBasics('regular_basic', { location: ' ' }, otherFields), '請填寫地點。');
    assert.equal(validateReportBasics('regular_basic', { location: '台北' }, otherFields), '');
});

test('到府課依時數自動落到 1.5hr／2hr；其他課型不變', () => {
    assert.equal(deriveCourseType('onsite_2hr', '1.5'), 'onsite_1_5hr');
    assert.equal(deriveCourseType('onsite_2hr', '1'), 'onsite_1_5hr');
    assert.equal(deriveCourseType('onsite_1_5hr', '2'), 'onsite_2hr');
    assert.equal(deriveCourseType('onsite_1_5hr', '3'), 'onsite_2hr');
    assert.equal(deriveCourseType('onsite_1_5hr', ''), 'onsite_2hr');
    assert.equal(deriveCourseType('online', '1.5'), 'online');
    assert.equal(deriveCourseType('collab_lead', '1'), 'collab_lead');
});

test('切換課型後殘留、對不到清單的選擇視為未選，不會把 id 當單位名稱送出', () => {
    const options = groupReportOptions(periodRows);
    assert.equal(validateReportExtras('camp', extras({ unit_choice: 'u-1' }), { options }), '營隊課程請選擇營隊梯次。');
    assert.equal(buildReportExtrasParams('camp', extras({ unit_choice: 'u-1' }), { options }).p_unit_name, null);
});
