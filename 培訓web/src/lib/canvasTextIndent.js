const TEXT_BLOCK_TAGS = new Set([
  'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE',
]);

export const TEXT_INDENT_STEP_EM = 2;

export function parseTextIndentEm(value, fontSizePx = 16) {
  const numeric = Number.parseFloat(value);
  if (!Number.isFinite(numeric)) return 0;
  if (String(value).trim().toLowerCase().endsWith('px')) {
    return fontSizePx > 0 ? numeric / fontSizePx : 0;
  }
  return numeric;
}

export function getNextTextIndentEm(currentValue, direction) {
  const current = Math.max(0, Number(currentValue) || 0);
  if (direction === 'outdent') {
    return Math.max(0, current - TEXT_INDENT_STEP_EM);
  }
  return current + TEXT_INDENT_STEP_EM;
}

function getIndentTarget(node, root) {
  let element = node?.nodeType === 1 ? node : node?.parentElement;
  let closestBlock = null;

  while (element && element !== root) {
    if (element.nodeName === 'LI') return element;
    if (!closestBlock && TEXT_BLOCK_TAGS.has(element.nodeName)) closestBlock = element;
    element = element.parentElement;
  }

  return closestBlock;
}

function sortInDocumentOrder(elements) {
  return elements.sort((first, second) => {
    if (first === second) return 0;
    const relation = first.compareDocumentPosition(second);
    if (relation & 2) return 1;
    if (relation & 4) return -1;
    return 0;
  });
}

function getSelectedIndentTargets(root, range) {
  const targets = new Set();
  const addTarget = (node) => {
    const target = getIndentTarget(node, root);
    if (target) targets.add(target);
  };

  addTarget(range.startContainer);
  addTarget(range.endContainer);

  if (!range.collapsed) {
    const showText = root.ownerDocument.defaultView?.NodeFilter?.SHOW_TEXT ?? 4;
    const walker = root.ownerDocument.createTreeWalker(root, showText);
    let node = walker.nextNode();
    while (node) {
      try {
        if (range.intersectsNode(node)) addTarget(node);
      } catch {
        // Ignore detached nodes while the browser is updating the editable DOM.
      }
      node = walker.nextNode();
    }
  }

  return sortInDocumentOrder([...targets]);
}

function indentListItem(listItem) {
  const previous = listItem.previousElementSibling;
  if (!previous || previous.nodeName !== 'LI') return false;

  const parentList = listItem.parentNode;
  const listTag = parentList.nodeName;
  let nestedList = previous.lastElementChild;
  if (!nestedList || (nestedList.nodeName !== 'UL' && nestedList.nodeName !== 'OL')) {
    nestedList = listItem.ownerDocument.createElement(listTag);
    previous.appendChild(nestedList);
  }
  nestedList.appendChild(listItem);
  return true;
}

function outdentListItem(listItem) {
  const parentList = listItem.parentNode;
  const parentListItem = parentList?.parentNode;
  if (!parentListItem || parentListItem.nodeName !== 'LI') return false;

  const outerList = parentListItem.parentNode;
  const trailingItems = [];
  let sibling = listItem.nextElementSibling;
  while (sibling) {
    trailingItems.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  if (trailingItems.length > 0) {
    const carryList = listItem.ownerDocument.createElement(parentList.nodeName);
    trailingItems.forEach((item) => carryList.appendChild(item));
    listItem.appendChild(carryList);
  }
  outerList.insertBefore(listItem, parentListItem.nextSibling);
  if (parentList.children.length === 0) parentList.remove();
  return true;
}

function getBlockIndentEm(block) {
  const inlineIndent = block.style.marginLeft || block.style.textIndent;
  if (!inlineIndent) return 0;
  const fontSize = Number.parseFloat(block.ownerDocument.defaultView?.getComputedStyle(block).fontSize) || 16;
  return parseTextIndentEm(inlineIndent, fontSize);
}

function applyBlockIndent(block, direction) {
  const current = getBlockIndentEm(block);
  const next = getNextTextIndentEm(current, direction);
  if (next === current && !block.style.textIndent) return false;

  block.style.marginLeft = next > 0 ? `${next}em` : '';
  block.style.textIndent = '';
  if (!block.getAttribute('style')) block.removeAttribute('style');
  return true;
}

export function applyTextSelectionIndent(root, selection, direction = 'indent') {
  if (!root || !selection || selection.rangeCount === 0) return false;

  let range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;

  let targets = getSelectedIndentTargets(root, range);
  if (targets.length === 0) {
    root.ownerDocument.execCommand?.('formatBlock', false, 'div');
    if (selection.rangeCount === 0) return false;
    range = selection.getRangeAt(0);
    targets = getSelectedIndentTargets(root, range);
  }
  if (targets.length === 0) return false;

  const savedRange = range.cloneRange();
  let changed = false;
  targets.forEach((target) => {
    if (target.nodeName === 'LI') {
      changed = (direction === 'outdent' ? outdentListItem(target) : indentListItem(target)) || changed;
    } else {
      changed = applyBlockIndent(target, direction) || changed;
    }
  });

  if (changed) {
    try {
      selection.removeAllRanges();
      selection.addRange(savedRange);
    } catch {
      // The content change is kept even if a browser cannot restore a moved list range.
    }
  }
  return changed;
}
