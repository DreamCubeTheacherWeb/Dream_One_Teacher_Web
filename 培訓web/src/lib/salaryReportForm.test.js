import test from 'node:test';
import assert from 'node:assert/strict';
import {
    EMPTY_REPORT_EXTRAS,
    OTHER_OPTION,
    buildReportExtrasParams,
    groupReportOptions,
    reportGroupFor,
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
