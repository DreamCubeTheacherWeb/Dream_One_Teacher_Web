const MIN_FONT_SIZE_PX = 8;
const MAX_FONT_SIZE_PX = 200;

export function normalizeCanvasFontSizePx(value) {
  if (String(value).trim() === '') return null;
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return null;
  return Math.max(MIN_FONT_SIZE_PX, Math.min(MAX_FONT_SIZE_PX, numeric));
}

function getTextOffset(root, container, offset) {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

export function captureTextSelection(root, selection) {
  if (!root || !selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

  return {
    start: getTextOffset(root, range.startContainer, range.startOffset),
    end: getTextOffset(root, range.endContainer, range.endOffset),
  };
}

function findTextBoundary(root, targetOffset) {
  const showText = root.ownerDocument.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
  const walker = root.ownerDocument.createTreeWalker(root, showText);
  let consumed = 0;
  let lastTextNode = null;
  let node = walker.nextNode();

  while (node) {
    const next = consumed + node.data.length;
    if (targetOffset <= next) {
      return { node, offset: Math.max(0, targetOffset - consumed) };
    }
    consumed = next;
    lastTextNode = node;
    node = walker.nextNode();
  }

  if (lastTextNode) return { node: lastTextNode, offset: lastTextNode.data.length };
  return { node: root, offset: 0 };
}

export function restoreTextSelection(root, selection, bookmark) {
  if (!root || !selection || !bookmark) return false;
  const start = findTextBoundary(root, bookmark.start);
  const end = findTextBoundary(root, bookmark.end);
  const range = root.ownerDocument.createRange();

  try {
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  } catch {
    return false;
  }
}
