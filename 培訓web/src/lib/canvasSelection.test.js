import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSelectionDelta,
  createPastedElements,
  getMarqueeSelectionIds,
  getSelectionBounds,
  normalizeRect,
  rectanglesIntersect,
} from './canvasSelection.js';

const elements = [
  { id: 'a', x: 10, y: 20, width: 100, height: 80, locked: false },
  { id: 'b', x: 140, y: 50, width: 60, height: 40, locked: false },
  { id: 'locked', x: 70, y: 70, width: 50, height: 50, locked: true },
];

test('normalizeRect supports dragging the marquee in any direction', () => {
  assert.deepEqual(normalizeRect({ x: 180, y: 120 }, { x: 40, y: 10 }), {
    left: 40,
    top: 10,
    right: 180,
    bottom: 120,
    width: 140,
    height: 110,
  });
});

test('rectanglesIntersect counts partial overlap and touching edges', () => {
  assert.equal(rectanglesIntersect(
    { left: 0, top: 0, right: 20, bottom: 20 },
    { left: 20, top: 5, right: 30, bottom: 15 },
  ), true);
  assert.equal(rectanglesIntersect(
    { left: 0, top: 0, right: 20, bottom: 20 },
    { left: 21, top: 0, right: 30, bottom: 20 },
  ), false);
});

test('marquee selects every intersecting unlocked element', () => {
  const marquee = normalizeRect({ x: 90, y: 40 }, { x: 150, y: 85 });
  assert.deepEqual(getMarqueeSelectionIds(elements, marquee), ['a', 'b']);
});

test('selection bounds and clamped movement keep the whole group on canvas', () => {
  const bounds = getSelectionBounds(elements, ['a', 'b']);
  assert.deepEqual(bounds, {
    left: 10,
    top: 20,
    right: 200,
    bottom: 100,
    width: 190,
    height: 80,
  });
  assert.deepEqual(clampSelectionDelta(bounds, -50, -30, 960), {
    deltaX: -10,
    deltaY: -20,
  });
  assert.deepEqual(clampSelectionDelta(bounds, 900, 30, 960), {
    deltaX: 760,
    deltaY: 30,
  });
});

test('pasting preserves relative positions and creates editable unsaved copies', () => {
  let nextId = 0;
  const pasted = createPastedElements(elements.slice(0, 2), {
    offset: 20,
    canvasWidth: 220,
    orderStart: 5,
    createId: () => `copy-${++nextId}`,
  });

  assert.deepEqual(pasted.map(({ id, dbId, x, y, order, locked }) => ({ id, dbId, x, y, order, locked })), [
    { id: 'copy-1', dbId: null, x: 30, y: 40, order: 5, locked: false },
    { id: 'copy-2', dbId: null, x: 160, y: 70, order: 6, locked: false },
  ]);
});
