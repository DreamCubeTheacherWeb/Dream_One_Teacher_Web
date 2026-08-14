import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanvasElementPayload,
  createCanvasSavedFingerprints,
  getCanvasElementSaveFingerprint,
  getDirtyCanvasElements,
} from './canvasPersistence.js';

const lessonId = 'lesson-1';
const textElement = {
  id: 'text-1',
  dbId: 'db-1',
  type: 'text_box',
  x: 10,
  y: 20,
  width: 300,
  height: 120,
  body: '<p>Hello</p>',
  opacity: 1,
  locked: false,
};

test('buildCanvasElementPayload preserves canvas fields in the existing contents schema', () => {
  assert.deepEqual(buildCanvasElementPayload(textElement, 2, lessonId), {
    lesson_id: lessonId,
    type: 'article',
    title: '文字框',
    body: '<p>Hello</p>',
    video_url: null,
    order: 2,
    status: 'draft',
    position_data: {
      x: 10,
      y: 20,
      width: 300,
      height: 120,
      opacity: 1,
      locked: false,
    },
  });
});

test('shape payload includes visual, link, lock, and button text properties', () => {
  const payload = buildCanvasElementPayload({
    ...textElement,
    type: 'shape',
    shapeType: 'button',
    fillColor: '#123456',
    borderColor: '#654321',
    borderWidth: 3,
    borderRadius: 12,
    linkUrl: 'https://example.com',
    textColor: '#ffffff',
    locked: true,
  }, 0, lessonId);

  assert.deepEqual(payload.position_data, {
    x: 10,
    y: 20,
    width: 300,
    height: 120,
    opacity: 1,
    locked: true,
    shapeType: 'button',
    fillColor: '#123456',
    borderColor: '#654321',
    borderWidth: 3,
    borderRadius: 12,
    linkUrl: 'https://example.com',
    textColor: '#ffffff',
  });
});

test('fingerprints ignore transient UI fields but change for persisted edits', () => {
  const initial = getCanvasElementSaveFingerprint(textElement, 0, lessonId);
  assert.equal(getCanvasElementSaveFingerprint({
    ...textElement,
    dbId: 'another-db-id',
    imageUrl: 'blob:preview-only',
  }, 0, lessonId), initial);
  assert.notEqual(getCanvasElementSaveFingerprint({
    ...textElement,
    x: 30,
  }, 0, lessonId), initial);
});

test('dirty detection returns only changed or newly-created elements', () => {
  const second = { ...textElement, id: 'text-2', dbId: 'db-2', y: 180 };
  const saved = createCanvasSavedFingerprints([textElement, second], lessonId);
  const newElement = { ...textElement, id: 'new-1', dbId: null, body: 'New' };
  const dirty = getDirtyCanvasElements([
    textElement,
    { ...second, body: 'Changed' },
    newElement,
  ], saved, lessonId);

  assert.deepEqual(dirty.map(({ element }) => element.id), ['text-2', 'new-1']);
});

test('dirty detection marks persisted elements when their order changes', () => {
  const second = { ...textElement, id: 'text-2', dbId: 'db-2', y: 180 };
  const saved = createCanvasSavedFingerprints([textElement, second], lessonId);
  const dirty = getDirtyCanvasElements([second, textElement], saved, lessonId);

  assert.deepEqual(dirty.map(({ element }) => element.id), ['text-2', 'text-1']);
});
