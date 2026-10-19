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
    deriveCourseType,
    termPeriodChoices,
    validateReportExtras,
} from './salaryReportForm.js';

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
    assert.equal(validateReportExtras('collab_lead', extras({ term_period: 'semester', unit_choice: '【臺北】新生國小' })), '');
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
    assert.deepEqual([...reportFieldsFor('collab_lead')], ['hours', 'students']);
    assert.deepEqual([...reportFieldsFor('online')], ['course_name', 'hours_preset', 'students', 'transport']);
    assert.deepEqual([...reportFieldsFor('camp')], ['students', 'transport']);
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

test('合作單位依教學期間分組；未選期間為空；沒有 term_scope 時退回整份', () => {
    const options = groupReportOptions([
        { kind: 'partner_unit', term_scope: 'vacation', value: 'A校', label: 'A校', sort_order: 10, is_active: true },
        { kind: 'partner_unit', term_scope: 'semester', value: 'B校115上', label: 'B校115上', sort_order: 490, is_active: true },
    ]);
    assert.deepEqual(partnerUnitsFor(options, '').map(u => u.value), []);
    assert.deepEqual(partnerUnitsFor(options, 'winter_break').map(u => u.value), ['A校']);
    assert.deepEqual(partnerUnitsFor(options, 'summer_break').map(u => u.value), ['A校']);
    assert.deepEqual(partnerUnitsFor(options, 'semester').map(u => u.value), ['B校115上']);
    const legacy = groupReportOptions([
        { kind: 'partner_unit', value: 'A校', label: 'A校', sort_order: 10, is_active: true },
        { kind: 'partner_unit', value: 'B校', label: 'B校', sort_order: 20, is_active: true },
    ]);
    assert.deepEqual(partnerUnitsFor(legacy, 'semester').map(u => u.value), ['A校', 'B校']);
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
