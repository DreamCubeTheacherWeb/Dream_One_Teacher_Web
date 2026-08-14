import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampSelectionDelta,
  createPastedElements,
  getMarqueeSelectionIds,
  getSelectionBounds,
  normalizeRect,
  rectanglesIntersect,
  resizeSelectionFromHandle,
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

test('east and south handles resize one axis while preserving the other', () => {
  const bounds = getSelectionBounds(elements, ['a', 'b']);
  const wider = resizeSelectionFromHandle(elements, ['a', 'b'], bounds, 'e', 190, 0, 960);
  assert.deepEqual(wider.slice(0, 2).map(({ x, y, width, height }) => ({ x, y, width, height })), [
    { x: 10, y: 20, width: 200, height: 80 },
    { x: 270, y: 50, width: 120, height: 40 },
  ]);

  const taller = resizeSelectionFromHandle(elements, ['a', 'b'], bounds, 's', 0, 80, 960);
  assert.deepEqual(taller.slice(0, 2).map(({ x, y, width, height }) => ({ x, y, width, height })), [
    { x: 10, y: 20, width: 100, height: 160 },
    { x: 140, y: 80, width: 60, height: 80 },
  ]);
});

test('west and north handles keep the opposite selection edges anchored', () => {
  const bounds = getSelectionBounds(elements, ['a', 'b']);
  const widerFromLeft = resizeSelectionFromHandle(elements, ['a', 'b'], bounds, 'w', -10, 0, 960);
  const widerBounds = getSelectionBounds(widerFromLeft, ['a', 'b']);
  assert.equal(widerBounds.left, 0);
  assert.equal(widerBounds.right, bounds.right);
  assert.equal(widerBounds.height, bounds.height);

  const tallerFromTop = resizeSelectionFromHandle(elements, ['a', 'b'], bounds, 'n', 0, -20, 960);
  const tallerBounds = getSelectionBounds(tallerFromTop, ['a', 'b']);
  assert.equal(tallerBounds.top, 0);
  assert.equal(tallerBounds.bottom, bounds.bottom);
  assert.equal(tallerBounds.width, bounds.width);
});

test('corner handles scale positions and sizes proportionally', () => {
  const bounds = getSelectionBounds(elements, ['a', 'b']);
  const resized = resizeSelectionFromHandle(elements, ['a', 'b'], bounds, 'se', 190, 80, 960);

  assert.deepEqual(resized.slice(0, 2).map(({ x, y, width, height }) => ({ x, y, width, height })), [
    { x: 10, y: 20, width: 200, height: 160 },
    { x: 270, y: 80, width: 120, height: 80 },
  ]);
});

test('group resizing respects canvas edges and per-element minimum sizes', () => {
  const bounds = getSelectionBounds(elements, ['a', 'b']);
  const againstTopLeft = resizeSelectionFromHandle(elements, ['a', 'b'], bounds, 'nw', -500, -500, 960);
  const constrainedBounds = getSelectionBounds(againstTopLeft, ['a', 'b']);
  assert.equal(constrainedBounds.left, 0);
  assert.ok(constrainedBounds.top >= 0);

  const compressed = resizeSelectionFromHandle(elements, ['a', 'b'], bounds, 'e', -1000, 0, 960);
  assert.equal(compressed.find((element) => element.id === 'b').width, 30);
  assert.equal(compressed.find((element) => element.id === 'a').height, 80);
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
