import test from 'node:test';
import assert from 'node:assert/strict';
import { isApprovedUser } from './roles.js';

test('approved platform roles can view instructor-only content', () => {
    assert.equal(isApprovedUser({ role: 'teacher' }), true);
    assert.equal(isApprovedUser({ role: 'mentor' }), true);
    assert.equal(isApprovedUser({ role: 'admin' }), true);
});

test('pending, unknown, and signed-out users cannot view instructor-only content', () => {
    assert.equal(isApprovedUser({ role: 'pending' }), false);
    assert.equal(isApprovedUser({ role: 'unknown' }), false);
    assert.equal(isApprovedUser(null), false);
    assert.equal(isApprovedUser(undefined), false);
});
