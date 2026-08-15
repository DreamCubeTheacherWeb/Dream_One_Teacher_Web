import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCanvasFontSizePx } from './canvasTextFormatting.js';

test('font sizes are rounded and stay within the editor limits', () => {
  assert.equal(normalizeCanvasFontSizePx(18), 18);
  assert.equal(normalizeCanvasFontSizePx('18.4'), 18);
  assert.equal(normalizeCanvasFontSizePx(2), 8);
  assert.equal(normalizeCanvasFontSizePx(300), 200);
});

test('invalid font size input is ignored', () => {
  assert.equal(normalizeCanvasFontSizePx(''), null);
  assert.equal(normalizeCanvasFontSizePx('not-a-number'), null);
});
