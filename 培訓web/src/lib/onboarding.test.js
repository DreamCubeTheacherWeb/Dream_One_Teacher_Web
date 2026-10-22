import test from 'node:test';
import assert from 'node:assert/strict';
import { hasSeenTour, markTourSeen, tourStorageKey, TOUR_VERSION } from './onboarding.js';

const memoryStorage = () => {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
    };
};

test('導覽紀錄按使用者分開、帶版本號', () => {
    assert.equal(tourStorageKey('u1'), `dreamone_onboarding_v${TOUR_VERSION}_u1`);
    assert.notEqual(tourStorageKey('u1'), tourStorageKey('u2'));
});

test('沒看過 → false；標記後 → true；別的使用者仍是 false', () => {
    const storage = memoryStorage();
    assert.equal(hasSeenTour('u1', storage), false);
    markTourSeen('u1', storage, new Date('2026-10-22T04:00:00Z'));
    assert.equal(hasSeenTour('u1', storage), true);
    assert.equal(storage.getItem(tourStorageKey('u1')), '2026-10-22T04:00:00.000Z');
    assert.equal(hasSeenTour('u2', storage), false);
});

test('讀不到 localStorage（被瀏覽器擋）時當成看過，不會每次都跳', () => {
    const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } };
    assert.equal(hasSeenTour('u1', blocked), true);
    assert.doesNotThrow(() => markTourSeen('u1', blocked));
});

test('沒有使用者 id 時不跳也不寫', () => {
    const storage = memoryStorage();
    assert.equal(hasSeenTour(null, storage), true);
    markTourSeen(undefined, storage);
    assert.equal(storage.getItem(tourStorageKey(undefined)), null);
});
