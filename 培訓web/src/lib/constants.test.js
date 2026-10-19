import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COURSE_CATEGORIES, COURSE_LABELS, REPORT_CHANNELS,
    categoriesInChannel, courseCategoryFor, courseTypesInCategory, reportChannelFor,
} from './constants.js';

test('回報類別為 B2C 直營與 B2B 合作單位，各有備註', () => {
    assert.deepEqual(REPORT_CHANNELS.map(c => c.key), ['b2c', 'b2b']);
    for (const channel of REPORT_CHANNELS) assert.ok(channel.hint.length > 10, `${channel.label} 缺備註`);
});

test('每個 course_type 都恰好屬於一個課程類型，且每個類型都掛在存在的回報類別下', () => {
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

test('合作課全部在 B2B，其餘在 B2C；查詢函式', () => {
    for (const type of Object.keys(COURSE_LABELS)) {
        assert.equal(reportChannelFor(type), type.startsWith('collab_') ? 'b2b' : 'b2c', type);
    }
    assert.deepEqual(categoriesInChannel('b2b').map(c => c.key), ['collab']);
    assert.equal(courseCategoryFor('speed_camp'), 'camp');
    assert.equal(courseCategoryFor('nope'), 'other');
    assert.deepEqual(courseTypesInCategory('onsite'), ['onsite_2hr', 'onsite_1_5hr']);
    assert.deepEqual(courseTypesInCategory('trial'), ['trial']);
    assert.deepEqual(courseTypesInCategory('nope'), []);
});
