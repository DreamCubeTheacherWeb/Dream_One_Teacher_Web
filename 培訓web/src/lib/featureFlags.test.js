import test from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTOR_CONTRACTS_ENABLED, canAccessInstructorContracts } from './featureFlags.js';

test('contract signing is enabled and open to approved roles', () => {
    assert.equal(INSTRUCTOR_CONTRACTS_ENABLED, true);
    assert.equal(canAccessInstructorContracts('teacher'), true);
    assert.equal(canAccessInstructorContracts('mentor'), true);
    assert.equal(canAccessInstructorContracts('admin'), true);
});

test('pending, unknown, and signed-out users never see the contract entry points', () => {
    assert.equal(canAccessInstructorContracts('pending'), false);
    assert.equal(canAccessInstructorContracts('unknown'), false);
    assert.equal(canAccessInstructorContracts(null), false);
    assert.equal(canAccessInstructorContracts(undefined), false);
});
