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

const DEFAULT_ELEMENT_MIN_SIZE = 30;
const LINE_ELEMENT_MIN_HEIGHT = 10;

function clamp(value, min, max = Number.POSITIVE_INFINITY) {
  return Math.min(max, Math.max(min, value));
}

function roundCanvasValue(value) {
  return Math.round(value * 100) / 100;
}

function getElementMinimumHeight(element) {
  return element.type === 'shape' && ['line', 'arrow'].includes(element.shapeType)
    ? LINE_ELEMENT_MIN_HEIGHT
    : DEFAULT_ELEMENT_MIN_SIZE;
}

function getMinimumScale(selectedElements, axis) {
  return Math.max(...selectedElements.map((element) => {
    const size = axis === 'x' ? element.width : element.height;
    const minimum = axis === 'x' ? DEFAULT_ELEMENT_MIN_SIZE : getElementMinimumHeight(element);
    return size > 0 ? minimum / size : 1;
  }));
}

export function resizeSelectionFromHandle(
  elements,
  selectedIds,
  bounds,
  handle,
  deltaX,
  deltaY,
  canvasWidth,
) {
  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  const selectedElements = elements.filter((element) => idSet.has(element.id));
  if (!bounds || selectedElements.length === 0 || bounds.width <= 0 || bounds.height <= 0) {
    return elements;
  }

  const minimumScaleX = getMinimumScale(selectedElements, 'x');
  const minimumScaleY = getMinimumScale(selectedElements, 'y');
  let anchorX = bounds.left;
  let anchorY = bounds.top;
  let scaleX = 1;
  let scaleY = 1;

  if (handle.length === 2) {
    const movesEast = handle.includes('e');
    const movesSouth = handle.includes('s');
    anchorX = movesEast ? bounds.left : bounds.right;
    anchorY = movesSouth ? bounds.top : bounds.bottom;
    const vectorX = movesEast ? bounds.width : -bounds.width;
    const vectorY = movesSouth ? bounds.height : -bounds.height;
    const projectedScale = (
      ((vectorX + deltaX) * vectorX) + ((vectorY + deltaY) * vectorY)
    ) / ((vectorX ** 2) + (vectorY ** 2));

    const horizontalMaximum = movesEast
      ? (canvasWidth - anchorX) / bounds.width
      : anchorX / bounds.width;
    const verticalMaximum = movesSouth
      ? Number.POSITIVE_INFINITY
      : anchorY / bounds.height;
    const scale = clamp(
      projectedScale,
      Math.max(minimumScaleX, minimumScaleY),
      Math.min(horizontalMaximum, verticalMaximum),
    );
    scaleX = scale;
    scaleY = scale;
  } else if (handle === 'e' || handle === 'w') {
    const movesEast = handle === 'e';
    anchorX = movesEast ? bounds.left : bounds.right;
    const requestedWidth = movesEast
      ? bounds.width + deltaX
      : bounds.width - deltaX;
    const maximumWidth = movesEast ? canvasWidth - anchorX : anchorX;
    scaleX = clamp(requestedWidth, bounds.width * minimumScaleX, maximumWidth) / bounds.width;
  } else if (handle === 's' || handle === 'n') {
    const movesSouth = handle === 's';
    anchorY = movesSouth ? bounds.top : bounds.bottom;
    const requestedHeight = movesSouth
      ? bounds.height + deltaY
      : bounds.height - deltaY;
    const maximumHeight = movesSouth ? Number.POSITIVE_INFINITY : anchorY;
    scaleY = clamp(requestedHeight, bounds.height * minimumScaleY, maximumHeight) / bounds.height;
  } else {
    return elements;
  }

  return elements.map((element) => {
    if (!idSet.has(element.id)) return element;
    return {
      ...element,
      x: roundCanvasValue(anchorX + ((element.x - anchorX) * scaleX)),
      y: roundCanvasValue(anchorY + ((element.y - anchorY) * scaleY)),
      width: roundCanvasValue(element.width * scaleX),
      height: roundCanvasValue(element.height * scaleY),
    };
  });
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
