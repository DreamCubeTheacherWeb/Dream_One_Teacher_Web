export const MARQUEE_DRAG_THRESHOLD = 3;

export function normalizeRect(start, end) {
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const right = Math.max(start.x, end.x);
  const bottom = Math.max(start.y, end.y);

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function elementRect(element) {
  const left = element.x || 0;
  const top = element.y || 0;
  const right = left + (element.width || 0);
  const bottom = top + (element.height || 0);

  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

export function rectanglesIntersect(first, second) {
  return first.left <= second.right
    && first.right >= second.left
    && first.top <= second.bottom
    && first.bottom >= second.top;
}

export function getMarqueeSelectionIds(elements, marqueeRect) {
  if (!marqueeRect) return [];
  return elements
    .filter((element) => !element.locked && rectanglesIntersect(elementRect(element), marqueeRect))
    .map((element) => element.id);
}

export function getSelectionBounds(elements, selectedIds) {
  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const selected = elements.filter((element) => idSet.has(element.id));
  if (selected.length === 0) return null;

  const rects = selected.map(elementRect);
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.right));
  const bottom = Math.max(...rects.map((rect) => rect.bottom));

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
  };
}

export function clampSelectionDelta(bounds, deltaX, deltaY, canvasWidth) {
  if (!bounds) return { deltaX, deltaY };

  const minDeltaX = -bounds.left;
  const maxDeltaX = canvasWidth - bounds.right;
  const clampedX = bounds.width > canvasWidth
    ? minDeltaX
    : Math.max(minDeltaX, Math.min(deltaX, maxDeltaX));

  return {
    deltaX: clampedX,
    deltaY: Math.max(-bounds.top, deltaY),
  };
}

export function createPastedElements(sourceElements, {
  offset,
  canvasWidth,
  orderStart,
  createId,
}) {
  if (sourceElements.length === 0) return [];

  const bounds = getSelectionBounds(sourceElements, sourceElements.map((element) => element.id));
  const targetLeft = bounds.width > canvasWidth
    ? 0
    : Math.max(0, Math.min(bounds.left + offset, canvasWidth - bounds.width));
  const deltaX = targetLeft - bounds.left;
  const deltaY = Math.max(-bounds.top, offset);

  return sourceElements.map((source, index) => ({
    ...source,
    id: createId(),
    dbId: null,
    x: source.x + deltaX,
    y: source.y + deltaY,
    order: orderStart + index,
    locked: false,
  }));
}
