import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getNextTextIndentEm,
  parseTextIndentEm,
  TEXT_INDENT_STEP_EM,
} from './canvasTextIndent.js';

test('plain text indentation moves in consistent two-em steps', () => {
  assert.equal(TEXT_INDENT_STEP_EM, 2);
  assert.equal(getNextTextIndentEm(0, 'indent'), 2);
  assert.equal(getNextTextIndentEm(2, 'indent'), 4);
  assert.equal(getNextTextIndentEm(4, 'outdent'), 2);
});

test('outdent never creates a negative margin', () => {
  assert.equal(getNextTextIndentEm(0, 'outdent'), 0);
  assert.equal(getNextTextIndentEm(1, 'outdent'), 0);
});

test('legacy em and pixel indentation values can be normalized', () => {
  assert.equal(parseTextIndentEm('2em'), 2);
  assert.equal(parseTextIndentEm('32px', 16), 2);
  assert.equal(parseTextIndentEm('', 16), 0);
});
