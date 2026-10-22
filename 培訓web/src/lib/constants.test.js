import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COURSE_CATEGORIES, COURSE_LABELS, REPORT_CHANNELS, TEACHER_REPORT_HIDDEN_TYPES,
    COOPERATION_STATUS_LABELS, PERSONNEL_TYPE_LABELS, SPEED_QUALIFICATION_LABELS,
    categoriesInChannel, courseCategoryFor, courseTypesInCategory, isInstructorPersonnel, normalizeCooperationStatus,
    normalizePersonnelTypes, reportChannelFor, reportItemLabel, teacherCourseItems,
} from './constants.js';

test('回報類別為 B2C 直營、B2B 合作單位、其他課程，各有備註', () => {
    assert.deepEqual(REPORT_CHANNELS.map(c => c.key), ['b2c', 'b2b', 'other']);
    for (const channel of REPORT_CHANNELS) assert.ok(channel.hint.length > 10, `${channel.label} 缺備註`);
});

test('B2C 課程種類照二處表單選項；B2B 只有合作單位課程', () => {
    assert.deepEqual(categoriesInChannel('b2c').map(c => c.label), [
        '到府家教課 or 到府揪團課', '線上課程', '體驗課', '速解研究所｜實體課程', '速解研究所｜線上課程', '寒暑假營隊 二日營、五日營',
    ]);
    assert.deepEqual(categoriesInChannel('b2b').map(c => c.key), ['collab']);
});

test('每個 course_type 都恰好屬於一個課程種類，且每個種類都掛在存在的回報類別下', () => {
    const channelKeys = new Set(REPORT_CHANNELS.map(c => c.key));
    const seen = new Map();
    for (const category of COURSE_CATEGORIES) {
        assert.ok(channelKeys.has(category.channel), `${category.label} 的回報類別 ${category.channel} 不存在`);
        assert.ok(category.types.length > 0, `${category.label} 沒有項目`);
        for (const type of category.types) {
            assert.ok(COURSE_LABELS[type], `${category.label} 含不存在的 ${type}`);
            assert.equal(seen.get(type), undefined, `${type} 重複出現在 ${seen.get(type)} 與 ${category.key}`);
            seen.set(type, category.key);
        }
    }
    for (const type of Object.keys(COURSE_LABELS)) assert.ok(seen.has(type), `${type} 沒有歸類`);
});

test('合作課全部在 B2B；講師端身分別只有主講／助教（專案不列）；營隊項目照表單問法', () => {
    for (const type of Object.keys(COURSE_LABELS)) {
        if (type.startsWith('collab_')) assert.equal(reportChannelFor(type), 'b2b', type);
    }
    assert.ok(TEACHER_REPORT_HIDDEN_TYPES.has('collab_project'));
    assert.deepEqual(teacherCourseItems('collab'), ['collab_lead', 'collab_assistant']);
    assert.deepEqual(teacherCourseItems('collab').map(reportItemLabel), ['合作課程 主講', '合作課程 助教']);
    assert.deepEqual(teacherCourseItems('camp').map(reportItemLabel), [
        '否（一般講師）', '否（一般講師，速解營）', '是（5 日營負責人）', '是（4 日營負責人）', '是（2 日營負責人）',
    ]);
    assert.equal(reportItemLabel('onsite_2hr'), COURSE_LABELS.onsite_2hr);
});

test('查詢函式', () => {
    assert.equal(courseCategoryFor('speed_camp'), 'camp');
    assert.equal(reportChannelFor('regular_basic'), 'other');
    assert.equal(reportChannelFor('trial'), 'b2c');
    assert.equal(courseCategoryFor('nope'), 'misc');
    assert.deepEqual(courseTypesInCategory('onsite'), ['onsite_2hr', 'onsite_1_5hr']);
    assert.deepEqual(courseTypesInCategory('nope'), []);
});

test('人員類別：沒有欄位、空陣列、非陣列一律當講師；只有職員或工讀計時才是非講師', () => {
    assert.equal(isInstructorPersonnel(undefined), true);
    assert.equal(isInstructorPersonnel(null), true);
    assert.equal(isInstructorPersonnel([]), true);
    assert.equal(isInstructorPersonnel(['instructor']), true);
    assert.equal(isInstructorPersonnel(['staff', 'instructor']), true);
    assert.equal(isInstructorPersonnel(['staff']), false);
    assert.equal(isInstructorPersonnel(['part_time', 'staff']), false);
    assert.deepEqual(normalizePersonnelTypes(undefined), ['instructor']);
    assert.deepEqual(normalizePersonnelTypes([]), ['instructor']);
    assert.deepEqual(normalizePersonnelTypes(['staff']), ['staff']);
    assert.deepEqual(PERSONNEL_TYPE_LABELS, { instructor: '講師', staff: '職員', part_time: '工讀計時' });
});

test('合作狀態只剩三個；NULL 與舊的身分代碼視為合作中；速解資格統一用速解老師／速解大師', () => {
    assert.deepEqual(Object.keys(COOPERATION_STATUS_LABELS), ['active', 'frozen', 'cancelled']);
    assert.equal(normalizeCooperationStatus(null), 'active');
    assert.equal(normalizeCooperationStatus(''), 'active');
    assert.equal(normalizeCooperationStatus('staff'), 'active');
    assert.equal(normalizeCooperationStatus('frozen'), 'frozen');
    assert.equal(normalizeCooperationStatus('cancelled'), 'cancelled');
    assert.deepEqual(SPEED_QUALIFICATION_LABELS, { speed_teacher: '速解老師', speed_master: '速解大師' });
});
