import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Rnd } from 'react-rnd';
import {
  Save, ChevronLeft, Plus, Trash2, Type, ImagePlus, Video,
  Bold, Italic, Underline, Heading1, Heading2, AlignLeft, AlignCenter, AlignRight,
  Move, Lock, Unlock, Copy, Grid, Eye, EyeOff,
  Square, Circle as CircleIcon, Triangle, Minus, Star, Diamond, Hexagon, ArrowRight, Shapes,
  Link as LinkIcon, Unlink, MousePointer,
  List, ListOrdered,
} from 'lucide-react';
import { supabase } from '../lib/supabaseClient';

const CANVAS_WIDTH = 960;
const MIN_CANVAS_HEIGHT = 600;
const GRID_SIZE = 10;
const COL_COUNT = 12;
const COL_WIDTH = CANVAS_WIDTH / COL_COUNT;
const SNAP_THRESHOLD = 6;
const GUIDE_PADDING = 20;

const SHAPE_TYPES = [
  { key: 'rect', label: '矩形', Icon: Square },
  { key: 'rounded_rect', label: '圓角矩形', Icon: Square },
  { key: 'circle', label: '圓形', Icon: CircleIcon },
  { key: 'triangle', label: '三角形', Icon: Triangle },
  { key: 'diamond', label: '菱形', Icon: Diamond },
  { key: 'star', label: '星形', Icon: Star },
  { key: 'hexagon', label: '六邊形', Icon: Hexagon },
  { key: 'line', label: '線條', Icon: Minus },
  { key: 'arrow', label: '箭頭', Icon: ArrowRight },
  { key: 'button', label: '按鈕', Icon: MousePointer },
];

const DEFAULT_SHAPE_PROPS = {
  shapeType: 'rect', fillColor: '#3b82f6', borderColor: '#1e40af',
  borderWidth: 2, borderRadius: 0, opacity: 1, linkUrl: '',
};

const PRESET_COLORS = [
  '#000000', '#434343', '#666666', '#999999', '#cccccc', '#ffffff',
  '#f44336', '#e91e63', '#9c27b0', '#673ab7', '#3f51b5', '#2196f3',
  '#00bcd4', '#009688', '#4caf50', '#8bc34a', '#ffeb3b', '#ffc107',
  '#ff9800', '#ff5722', '#795548', '#607d8b', '#b3e5fc', '#f8bbd0',
];

const loadRecentColors = () => {
  try { return JSON.parse(localStorage.getItem('canvas_recent_colors') || '[]'); }
  catch { return []; }
};

const ColorPalette = ({ title, icon, onApply, onOpen, recentColors, dropUp = false }) => {
  const [open, setOpen] = useState(false);
  const [lastColor, setLastColor] = useState('#000000');
  const panelRef = useRef(null);
  const nativeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const apply = (color) => {
    setLastColor(color);
    onApply(color);
    setOpen(false);
  };

  const isWhite = (c) => c === '#ffffff' || c === '#fff' || c === 'white';

  return (
    <div className="relative" ref={panelRef}>
      <button
        onMouseDown={(e) => { e.preventDefault(); onOpen(); setOpen(!open); }}
        className="flex items-center gap-0.5 p-1 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200"
        title={title}>
        <div className="w-5 h-5 flex items-center justify-center relative overflow-hidden border-2 border-bauhaus-black">
          {isWhite(lastColor) ? (
            <><div className="absolute inset-0" style={{ background: 'repeating-conic-gradient(#e2e8f0 0% 25%, #fff 0% 50%) 0 0/6px 6px' }} /><div className="absolute inset-0 bg-white/70" /></>
          ) : (
            <div className="w-full h-full" style={{ background: lastColor }} />
          )}
        </div>
        {icon}
        <span className="text-[7px] text-bauhaus-black/40 leading-none">▼</span>
      </button>
      {open && (
        <div className={`absolute ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'} left-1/2 -translate-x-1/2 bg-white border-2 border-bauhaus-black rounded-xl shadow-hard p-3 z-[60]`} style={{ width: 216 }}>
          <div className="text-[10px] text-bauhaus-black/60 font-bold mb-2">{title}</div>
          <div className="grid grid-cols-6 gap-1.5 mb-2">
            {PRESET_COLORS.map(c => (
              <button key={c}
                onMouseDown={(e) => { e.preventDefault(); apply(c); }}
                className={`w-7 h-7 hover:scale-125 hover:z-10 transition-transform duration-200 ${isWhite(c) ? 'border-2 border-bauhaus-black' : 'border border-bauhaus-black/30'}`}
                style={{ background: c }}
                title={c}
              />
            ))}
          </div>
          {recentColors.length > 0 && (
            <>
              <div className="text-[10px] text-bauhaus-black/40 mb-1">最近使用</div>
              <div className="flex gap-1.5 mb-2 flex-wrap">
                {recentColors.slice(0, 8).map((c, i) => (
                  <button key={`r-${i}`}
                    onMouseDown={(e) => { e.preventDefault(); apply(c); }}
                    className={`w-7 h-7 hover:scale-125 transition-transform duration-200 ${isWhite(c) ? 'border-2 border-bauhaus-black' : 'border border-bauhaus-black/30'}`}
                    style={{ background: c }}
                    title={c}
                  />
                ))}
              </div>
            </>
          )}
          <div className="flex items-center gap-2 pt-2 border-t-2 border-bauhaus-black/10">
            <button
              onMouseDown={(e) => { e.preventDefault(); nativeRef.current?.click(); }}
              className="text-[11px] text-bauhaus-blue hover:text-bauhaus-black font-medium">
              自訂顏色...
            </button>
            <input ref={nativeRef} type="color" value={lastColor}
              className="opacity-0 absolute w-0 h-0 pointer-events-none"
              onInput={(e) => apply(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

const toEmbedUrl = (url) => {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (u.pathname.startsWith('/embed/')) return url;
    if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.searchParams.get('v'))
      return `https://www.youtube.com/embed/${u.searchParams.get('v')}`;
    if (u.hostname === 'youtu.be' && u.pathname.length > 1)
      return `https://www.youtube.com/embed${u.pathname}`;
    if (u.pathname.startsWith('/shorts/'))
      return `https://www.youtube.com/embed/${u.pathname.replace('/shorts/', '')}`;
  } catch { /* ignore */ }
  return url;
};

function ShapeSVG({ shapeType, fill, stroke, strokeWidth, borderRadius }) {
  const sw = strokeWidth ?? 2;
  const pad = sw / 2;
  const iw = 100 - sw;

  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none" className="pointer-events-none select-none">
      {shapeType === 'rect' && <rect x={pad} y={pad} width={iw} height={iw} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {shapeType === 'rounded_rect' && <rect x={pad} y={pad} width={iw} height={iw} rx={borderRadius || 12} ry={borderRadius || 12} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {shapeType === 'circle' && <ellipse cx="50" cy="50" rx={50 - pad} ry={50 - pad} fill={fill} stroke={stroke} strokeWidth={sw} />}
      {shapeType === 'triangle' && <polygon points={`50,${pad} ${100 - pad},${100 - pad} ${pad},${100 - pad}`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
      {shapeType === 'diamond' && <polygon points={`50,${pad} ${100 - pad},50 50,${100 - pad} ${pad},50`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
      {shapeType === 'star' && <polygon points="50,2 61,35 97,35 68,57 79,91 50,70 21,91 32,57 3,35 39,35" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
      {shapeType === 'hexagon' && <polygon points={`50,${pad} ${100 - pad},25 ${100 - pad},75 50,${100 - pad} ${pad},75 ${pad},25`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
      {shapeType === 'line' && <line x1={pad} y1="50" x2={100 - pad} y2="50" stroke={stroke} strokeWidth={Math.max(sw, 3)} strokeLinecap="round" />}
      {shapeType === 'arrow' && (
        <>
          <line x1={pad} y1="50" x2={80} y2="50" stroke={stroke} strokeWidth={Math.max(sw, 3)} strokeLinecap="round" />
          <polygon points={`${100 - pad},50 72,30 72,70`} fill={stroke} stroke={stroke} strokeWidth={1} />
        </>
      )}
    </svg>
  );
}

// Ref-based text box — saves on blur but does NOT exit editing mode
const TextBoxContent = ({ body, isEditing, onContentChange, onStartEdit }) => {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && !isEditing) {
      ref.current.innerHTML = body || '';
    }
  }, [body, isEditing]);

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = body || '';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const getBlockParent = (node) => {
    while (node && node !== ref.current) {
      if (node.nodeType === 1 && /^(P|DIV|H[1-6]|BLOCKQUOTE)$/i.test(node.nodeName)) return node;
      node = node.parentNode;
    }
    return null;
  };

  const findParentLi = (node) => {
    while (node && node !== ref.current) {
      if (node.nodeName === 'LI') return node;
      node = node.parentNode;
    }
    return null;
  };

  const indentListItem = (li) => {
    const prev = li.previousElementSibling;
    if (!prev || prev.nodeName !== 'LI') return;
    const parentList = li.parentNode;
    const tag = parentList.nodeName;
    let subList = prev.lastElementChild;
    if (!subList || (subList.nodeName !== 'UL' && subList.nodeName !== 'OL')) {
      subList = document.createElement(tag);
      prev.appendChild(subList);
    }
    subList.appendChild(li);
  };

  const outdentListItem = (li) => {
    const parentList = li.parentNode;
    const grandLi = parentList.parentNode;
    if (!grandLi || grandLi.nodeName !== 'LI') return;
    const outerList = grandLi.parentNode;
    const trailing = [];
    let sib = li.nextElementSibling;
    while (sib) { trailing.push(sib); sib = sib.nextElementSibling; }
    if (trailing.length > 0) {
      const carry = document.createElement(parentList.nodeName);
      trailing.forEach((s) => carry.appendChild(s));
      li.appendChild(carry);
    }
    outerList.insertBefore(li, grandLi.nextSibling);
    if (parentList.children.length === 0) parentList.remove();
  };

  const handleKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0).cloneRange();

    const li = findParentLi(sel.anchorNode);
    if (li) {
      if (e.shiftKey) { outdentListItem(li); } else { indentListItem(li); }
      try { sel.removeAllRanges(); sel.addRange(range); } catch { /* noop */ }
    } else {
      let block = getBlockParent(sel.anchorNode);
      if (!block) {
        document.execCommand('formatBlock', false, 'div');
        block = getBlockParent(sel.anchorNode);
      }
      if (block) {
        const cur = parseFloat(block.style.textIndent) || 0;
        if (e.shiftKey) {
          block.style.textIndent = cur <= 2 ? '' : `${cur - 2}em`;
        } else {
          block.style.textIndent = `${cur + 2}em`;
        }
      }
    }
  };

  return (
    <div ref={ref}
      className="w-full h-full p-3 overflow-auto rounded-lg canvas-text-content"
      contentEditable={isEditing} suppressContentEditableWarning
      onKeyDown={isEditing ? handleKeyDown : undefined}
      onBlur={() => {
        if (ref.current) onContentChange(ref.current.innerHTML);
      }}
      onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
      style={{
        outline: 'none', minHeight: '100%', fontSize: 16, lineHeight: 1.6,
        wordBreak: 'break-word', background: isEditing ? '#f8fafc' : 'transparent',
      }}
    />
  );
};

const ButtonContent = ({ body, isEditing, onContentChange, onStartEdit, fillColor, borderColor, borderWidth, borderRadius, textColor }) => {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current && !isEditing) ref.current.textContent = body || '按鈕';
  }, [body, isEditing]);

  useEffect(() => {
    if (ref.current) ref.current.textContent = body || '按鈕';
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="w-full h-full flex items-center justify-center rounded-lg select-none"
      style={{
        background: fillColor || '#3b82f6',
        border: `${borderWidth ?? 2}px solid ${borderColor || '#1e40af'}`,
        borderRadius: borderRadius || 8,
        cursor: isEditing ? 'text' : 'move',
      }}>
      <span ref={ref}
        contentEditable={isEditing} suppressContentEditableWarning
        onBlur={() => { if (ref.current) onContentChange(ref.current.textContent); }}
        onDoubleClick={(e) => { e.stopPropagation(); onStartEdit(); }}
        className="font-bold text-center px-2"
        style={{ color: textColor || '#ffffff', outline: 'none', fontSize: 16, minWidth: 20 }}
      />
    </div>
  );
};

function computeSnapGuides(draggingEl, allElements, canvasW) {
  const guides = { vertical: [], horizontal: [], snapX: null, snapY: null };
  const dL = draggingEl.x, dR = draggingEl.x + draggingEl.width, dCx = draggingEl.x + draggingEl.width / 2;
  const dT = draggingEl.y, dB = draggingEl.y + draggingEl.height, dCy = draggingEl.y + draggingEl.height / 2;

  const vTargets = [{ pos: 0 }, { pos: canvasW / 2 }, { pos: canvasW }, { pos: GUIDE_PADDING }, { pos: canvasW - GUIDE_PADDING }];
  const hTargets = [{ pos: 0 }, { pos: GUIDE_PADDING }];
  for (let i = 1; i < COL_COUNT; i++) vTargets.push({ pos: i * COL_WIDTH });

  for (const el of allElements) {
    if (el.id === draggingEl.id) continue;
    vTargets.push({ pos: el.x }, { pos: el.x + el.width }, { pos: el.x + el.width / 2 });
    hTargets.push({ pos: el.y }, { pos: el.y + el.height }, { pos: el.y + el.height / 2 });
  }

  let bestV = SNAP_THRESHOLD + 1, bestH = SNAP_THRESHOLD + 1;
  for (const de of [dL, dR, dCx]) {
    for (const vt of vTargets) {
      const dist = Math.abs(de - vt.pos);
      if (dist < SNAP_THRESHOLD && dist < bestV) {
        bestV = dist; guides.snapX = draggingEl.x + (vt.pos - de); guides.vertical = [{ x: vt.pos }];
      }
    }
  }
  for (const de of [dT, dB, dCy]) {
    for (const ht of hTargets) {
      const dist = Math.abs(de - ht.pos);
      if (dist < SNAP_THRESHOLD && dist < bestH) {
        bestH = dist; guides.snapY = draggingEl.y + (ht.pos - de); guides.horizontal = [{ y: ht.pos }];
      }
    }
  }
  return guides;
}

function computeDistances(selected, allElements) {
  if (!selected) return [];
  const ds = [];
  const sL = selected.x, sR = sL + selected.width, sT = selected.y, sB = sT + selected.height;
  for (const el of allElements) {
    if (el.id === selected.id) continue;
    const eL = el.x, eR = eL + el.width, eT = el.y, eB = eT + el.height;
    if (sT < eB && sB > eT) {
      const midY = Math.max(sT, eT) + (Math.min(sB, eB) - Math.max(sT, eT)) / 2;
      if (sR <= eL && eL - sR < 300) ds.push({ x1: sR, x2: eL, y: midY, dist: Math.round(eL - sR), dir: 'h' });
      else if (eR <= sL && sL - eR < 300) ds.push({ x1: eR, x2: sL, y: midY, dist: Math.round(sL - eR), dir: 'h' });
    }
    if (sL < eR && sR > eL) {
      const midX = Math.max(sL, eL) + (Math.min(sR, eR) - Math.max(sL, eL)) / 2;
      if (sB <= eT && eT - sB < 300) ds.push({ y1: sB, y2: eT, x: midX, dist: Math.round(eT - sB), dir: 'v' });
      else if (eB <= sT && sT - eB < 300) ds.push({ y1: eB, y2: sT, x: midX, dist: Math.round(sT - eB), dir: 'v' });
    }
  }
  return ds;
}

const CanvasEditor = ({ lessonId, onBack, onSwitchToClassic }) => {
  const [elements, setElements] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [lessonTitle, setLessonTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fontPxInput, setFontPxInput] = useState('16');
  const [canvasHeight, setCanvasHeight] = useState(MIN_CANVAS_HEIGHT);
  const [showGrid, setShowGrid] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [snapGuides, setSnapGuides] = useState({ vertical: [], horizontal: [] });
  const [isDragging, setIsDragging] = useState(false);
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [recentColors, setRecentColors] = useState(loadRecentColors);
  const canvasRef = useRef(null);
  const shapeMenuRef = useRef(null);
  const selectionRef = useRef(null);

  const saveSelection = useCallback(() => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      selectionRef.current = sel.getRangeAt(0).cloneRange();
    }
  }, []);

  const restoreSelection = useCallback(() => {
    if (!selectionRef.current) return;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(selectionRef.current);
  }, []);

  const addRecentColor = useCallback((color) => {
    setRecentColors(prev => {
      const next = [color, ...prev.filter(c => c !== color)].slice(0, 8);
      localStorage.setItem('canvas_recent_colors', JSON.stringify(next));
      return next;
    });
  }, []);

  const exitEditing = useCallback(() => {
    if (!editingId) return;
    setEditingId(null);
  }, [editingId]);

  // 編輯文字時，游標/選取移動即時顯示目前字級
  useEffect(() => {
    if (!editingId) return;
    const handler = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      let node = range.startContainer;
      if (node.nodeType === 1) {
        node = node.childNodes[range.startOffset] || node.firstChild || node;
        while (node && node.nodeType === 1 && node.firstChild) node = node.firstChild;
      }
      const el = node?.nodeType === 1 ? node : node?.parentElement;
      if (!el?.closest?.('.canvas-text-content')) return;
      const px = String(Math.round(parseFloat(getComputedStyle(el).fontSize) || 16));
      setFontPxInput(prev => (prev === px ? prev : px));
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [editingId]);

  // Derive minimum canvas height directly from elements (always in sync, no stale closures)
  const computedMinHeight = useMemo(() => {
    let maxBottom = MIN_CANVAS_HEIGHT;
    for (const el of elements) {
      const bottom = (el.y || 0) + (el.height || 100) + 400;
      if (bottom > maxBottom) maxBottom = bottom;
    }
    return maxBottom;
  }, [elements]);

  // During drag, canvasHeight may exceed computedMinHeight; take the max
  const renderedHeight = Math.max(computedMinHeight, canvasHeight);

  useEffect(() => {
    if (!shapeMenuOpen) return;
    const close = (e) => { if (shapeMenuRef.current && !shapeMenuRef.current.contains(e.target)) setShapeMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [shapeMenuOpen]);

  // ── Load data ──
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const { data: lesson } = await supabase.from('lessons').select('title').eq('id', lessonId).single();
        if (lesson) setLessonTitle(lesson.title);

        const { data: contents } = await supabase.from('contents').select('*')
          .eq('lesson_id', lessonId).order('order', { ascending: true });

        let autoY = 40;
        const mapped = (contents || []).map((c) => {
          const pos = c.position_data || {};
          const hasPos = c.position_data != null;
          let imageUrl = null;
          if (c.type === 'image_text' && c.video_url)
            imageUrl = supabase.storage.from('content-images').getPublicUrl(c.video_url).data?.publicUrl;

          const defaultW = c.type === 'video' ? 560 : 400;
          const defaultH = c.type === 'video' ? 315 : 200;
          const x = hasPos ? pos.x : 40;
          const y = hasPos ? pos.y : autoY;
          const w = pos.width ?? defaultW;
          const h = pos.height ?? defaultH;
          if (!hasPos) autoY += h + 30;

          const isShape = pos.shapeType != null;
          return {
            id: c.id, dbId: c.id,
            type: isShape ? 'shape' : (c.type === 'article' ? 'text_box' : c.type === 'image_text' ? 'image' : c.type),
            x, y, width: w, height: h,
            body: c.body || '', title: c.title || '',
            videoUrl: c.video_url || '',
            storagePath: c.type === 'image_text' ? c.video_url : '',
            imageUrl, order: c.order ?? 0, locked: false,
            opacity: pos.opacity ?? 1,
            shapeType: pos.shapeType || 'rect',
            fillColor: pos.fillColor || '#3b82f6',
            borderColor: pos.borderColor || '#1e40af',
            borderWidth: pos.borderWidth ?? 2,
            borderRadius: pos.borderRadius ?? 0,
            linkUrl: pos.linkUrl || '',
            textColor: pos.textColor || '#ffffff',
          };
        });
        setElements(mapped);
      } catch (err) { console.error('載入失敗:', err); }
      finally { setLoading(false); }
    };
    if (lessonId) fetchData();
  }, [lessonId]);

  const addElement = (type, extraProps = {}) => {
    const id = `new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    let nextY = 40;
    for (const el of elements) {
      const bottom = (el.y || 0) + (el.height || 100) + 30;
      if (bottom > nextY) nextY = bottom;
    }
    const base = {
      id, dbId: null, type,
      x: 40, y: nextY,
      width: type === 'video' ? 560 : type === 'shape' ? 150 : 300,
      height: type === 'video' ? 315 : type === 'shape' ? 150 : (type === 'image' ? 200 : 120),
      body: '', title: '', videoUrl: '', storagePath: '', imageUrl: null,
      order: elements.length, locked: false, opacity: 1,
      linkUrl: '', textColor: '#ffffff',
      ...DEFAULT_SHAPE_PROPS, ...extraProps,
    };
    const next = [...elements, base];
    setElements(next);
    setSelectedId(id);
    // Scroll the new element into view after React renders
    requestAnimationFrame(() => {
      const canvasTop = canvasRef.current?.getBoundingClientRect().top ?? 0;
      const scrollTarget = window.scrollY + canvasTop + nextY - 120;
      window.scrollTo({ top: scrollTarget, behavior: 'smooth' });
    });
    return id;
  };

  const updateElement = (id, patch) => {
    setElements((prev) => prev.map((el) => (el.id === id ? { ...el, ...patch } : el)));
  };

  const deleteElement = async (id) => {
    const el = elements.find((e) => e.id === id);
    if (!el || !window.confirm('確定要刪除此元素嗎？')) return;
    if (el.storagePath) await supabase.storage.from('content-images').remove([el.storagePath]);
    if (el.dbId) await supabase.from('contents').delete().eq('id', el.dbId);
    setElements((prev) => prev.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
    if (editingId === id) setEditingId(null);
  };

  const duplicateElement = (id) => {
    const src = elements.find((e) => e.id === id);
    if (!src) return;
    addElement(src.type, {
      x: src.x + 30, y: src.y + 30, width: src.width, height: src.height,
      body: src.body, title: src.title, videoUrl: src.videoUrl, imageUrl: src.imageUrl,
      storagePath: '', opacity: src.opacity, linkUrl: src.linkUrl, textColor: src.textColor,
      shapeType: src.shapeType, fillColor: src.fillColor, borderColor: src.borderColor,
      borderWidth: src.borderWidth, borderRadius: src.borderRadius,
    });
  };

  const handleImageUpload = async (file, elementId) => {
    if (!file.type.startsWith('image/')) { alert('僅接受圖片檔案'); return; }
    if (file.size > 10 * 1024 * 1024) { alert('檔案大小不可超過 10MB'); return; }
    const ext = file.name.split('.').pop();
    const path = `content/${lessonId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('content-images').upload(path, file);
    if (error) { alert('圖片上傳失敗：' + error.message); return; }
    const url = supabase.storage.from('content-images').getPublicUrl(path).data?.publicUrl;
    updateElement(elementId, { storagePath: path, imageUrl: url });
  };

  const triggerImageUpload = (elementId) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = (e) => { if (e.target.files[0]) handleImageUpload(e.target.files[0], elementId); };
    input.click();
  };

  const handleAddImage = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      const id = addElement('image'); await handleImageUpload(file, id);
    };
    input.click();
  };

  const handleAddVideo = () => {
    const url = window.prompt('請輸入 YouTube 影片網址：');
    if (url) addElement('video', { videoUrl: url });
  };

  const handleAddShape = (shapeType) => {
    const defaults = {
      rect: { fillColor: '#3b82f6', borderColor: '#1e40af' },
      rounded_rect: { fillColor: '#8b5cf6', borderColor: '#6d28d9', borderRadius: 12 },
      circle: { fillColor: '#10b981', borderColor: '#047857' },
      triangle: { fillColor: '#f59e0b', borderColor: '#d97706' },
      diamond: { fillColor: '#ec4899', borderColor: '#be185d' },
      star: { fillColor: '#eab308', borderColor: '#ca8a04' },
      hexagon: { fillColor: '#06b6d4', borderColor: '#0891b2' },
      line: { fillColor: 'transparent', borderColor: '#334155', borderWidth: 3, height: 30 },
      arrow: { fillColor: 'transparent', borderColor: '#334155', borderWidth: 3, height: 40 },
      button: { fillColor: '#3b82f6', borderColor: '#1e40af', borderRadius: 8, borderWidth: 0, width: 180, height: 50, body: '按鈕文字' },
    };
    const d = defaults[shapeType] || {};
    addElement('shape', { shapeType, ...d, width: d.width || 150, height: d.height || 150 });
    setShapeMenuOpen(false);
  };

  // ── Save ──
  const handleSave = async () => {
    setSaving(true);
    try {
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const positionData = {
          x: el.x, y: el.y, width: el.width, height: el.height,
          opacity: el.opacity ?? 1,
        };
        if (el.type === 'shape') {
          positionData.shapeType = el.shapeType;
          positionData.fillColor = el.fillColor;
          positionData.borderColor = el.borderColor;
          positionData.borderWidth = el.borderWidth;
          positionData.borderRadius = el.borderRadius;
          if (el.linkUrl) positionData.linkUrl = el.linkUrl;
          if (el.shapeType === 'button') positionData.textColor = el.textColor || '#ffffff';
        }
        const dbType = el.type === 'text_box' ? 'article' : el.type === 'image' ? 'image_text' : el.type === 'shape' ? 'article' : el.type;
        const payload = {
          lesson_id: lessonId, type: dbType,
          title: el.title || ({ text_box: '文字框', image: '圖片', video: '影片', shape: '圖形' }[el.type] || '元素'),
          body: el.body || '', video_url: el.type === 'image' ? (el.storagePath || null) : (el.videoUrl || null),
          order: i, status: 'draft', position_data: positionData,
        };
        if (el.dbId) {
          const { error } = await supabase.from('contents').update(payload).eq('id', el.dbId);
          if (error) throw error;
        } else {
          const { data, error } = await supabase.from('contents').insert(payload).select('id').single();
          if (error) throw error;
          if (data) updateElement(el.id, { dbId: data.id });
        }
      }
      alert('畫布內容已儲存！');
    } catch (err) {
      console.error('儲存失敗:', err);
      alert('儲存失敗：' + (err?.message || JSON.stringify(err)));
    } finally { setSaving(false); }
  };

  const execCommand = (cmd, value = null) => document.execCommand(cmd, false, value);

  // ── 任意 px 字級 ──────────────────────────────────────────────
  // execCommand('fontSize') 只支援 1-7 檔，改用「先套 7 再換成 span px」的手法
  const getEditingRoot = () => {
    const sel = window.getSelection();
    const node = sel?.anchorNode;
    if (!node) return null;
    const el = node.nodeType === 1 ? node : node.parentElement;
    return el?.closest('.canvas-text-content') || null;
  };

  const getSelectionFontPx = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 16;
    const range = sel.getRangeAt(0);
    let node = range.startContainer;
    if (node.nodeType === 1) {
      // 錨在容器上（如全選）→ 鑽到範圍內第一個文字節點，才能讀到實際字級
      node = node.childNodes[range.startOffset] || node.firstChild || node;
      while (node && node.nodeType === 1 && node.firstChild) node = node.firstChild;
    }
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el?.closest) return 16;
    return Math.round(parseFloat(getComputedStyle(el).fontSize) || 16);
  };

  const applyPxToSelection = (root, px) => {
    const v = Math.max(8, Math.min(200, Math.round(Number(px))));
    if (!v) return;
    // 標記既有的 size=7，避免被誤換
    root.querySelectorAll('font[size="7"]').forEach(f => f.setAttribute('data-orig', '1'));
    execCommand('fontSize', '7');
    root.querySelectorAll('font[size="7"]:not([data-orig])').forEach(f => {
      const span = document.createElement('span');
      span.style.fontSize = `${v}px`;
      span.innerHTML = f.innerHTML;
      f.replaceWith(span);
    });
    root.querySelectorAll('font[data-orig]').forEach(f => f.removeAttribute('data-orig'));
    root.focus();   // 焦點還給編輯框，之後 blur 才會回存內容
    setFontPxInput(String(v));
  };

  const withTextSelection = (fn) => {
    let root = getEditingRoot();
    if (!root) { restoreSelection(); root = getEditingRoot(); }
    if (root) fn(root);
  };

  const applyFontSizePx = (px) => withTextSelection((root) => applyPxToSelection(root, px));
  const applyFontSizeDelta = (d) => withTextSelection((root) => applyPxToSelection(root, getSelectionFontPx() + d));

  const handleCreateLink = () => {
    saveSelection();
    const url = window.prompt('請輸入連結網址：', 'https://');
    if (url) {
      restoreSelection();
      execCommand('createLink', url);
    }
  };

  const handleCanvasClick = (e) => {
    if (e.target === canvasRef.current || e.target.classList.contains('canvas-grid') || e.target.classList.contains('col-line')) {
      setSelectedId(null);
      exitEditing();
    }
  };

  const handleElementClick = useCallback((e, elId) => {
    e.stopPropagation();
    if (editingId && editingId !== elId) exitEditing();
    setSelectedId(elId);
  }, [editingId, exitEditing]);

  const handleDrag = useCallback((elId, x, y) => {
    const el = elements.find((e) => e.id === elId);
    if (!el) return;
    // Functional updater avoids stale closure – always reads latest canvasHeight
    const bottom = y + (el.height || 100) + 400;
    setCanvasHeight((prev) => Math.max(prev, bottom));
    if (showGuides) {
      setSnapGuides(computeSnapGuides({ ...el, x, y }, elements, CANVAS_WIDTH));
    }
  }, [elements, showGuides]);

  const handleDragStop = useCallback((elId, x, y) => {
    setIsDragging(false);
    const el = elements.find((e) => e.id === elId);
    if (!el) return;
    let finalX = x, finalY = y;
    if (showGuides) {
      const guides = computeSnapGuides({ ...el, x, y }, elements, CANVAS_WIDTH);
      finalX = guides.snapX ?? x;
      finalY = guides.snapY ?? y;
      setTimeout(() => setSnapGuides({ vertical: [], horizontal: [] }), 300);
    } else {
      setSnapGuides({ vertical: [], horizontal: [] });
    }
    finalX = Math.max(0, Math.min(finalX, CANVAS_WIDTH - el.width));
    finalY = Math.max(0, finalY);
    updateElement(elId, { x: finalX, y: finalY });
    // Reset drag-time height; computedMinHeight (useMemo) takes over from here
    setCanvasHeight(MIN_CANVAS_HEIGHT);
  }, [elements, showGuides]);

  const distances = useMemo(() => {
    if (!selectedId || isDragging) return [];
    return computeDistances(elements.find((e) => e.id === selectedId), elements);
  }, [selectedId, elements, isDragging]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && editingId) { e.preventDefault(); exitEditing(); return; }
      if (!selectedId || editingId) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteElement(selectedId); }
      const sel = elements.find((el) => el.id === selectedId);
      if (!sel || sel.locked) return;
      const step = e.shiftKey ? 1 : GRID_SIZE;
      if (e.key === 'ArrowLeft') { e.preventDefault(); updateElement(selectedId, { x: sel.x - step }); }
      if (e.key === 'ArrowRight') { e.preventDefault(); updateElement(selectedId, { x: sel.x + step }); }
      if (e.key === 'ArrowUp') { e.preventDefault(); updateElement(selectedId, { y: sel.y - step }); }
      if (e.key === 'ArrowDown') { e.preventDefault(); updateElement(selectedId, { y: sel.y + step }); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // handler 內用到的 updateElement/deleteElement/exitEditing 皆以 functional setState
    // 或閉包讀取下列狀態，identity 變動不帶新資訊，故僅依賴狀態值即可（安全省略函式）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, selectedId, elements]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-bauhaus-blue border-t-transparent" />
        <span className="ml-3 text-bauhaus-black/50 font-medium">載入中...</span>
      </div>
    );
  }

  const selected = elements.find((el) => el.id === selectedId);
  const elLabel = (t) => ({ text_box: '文字框', image: '圖片', video: '影片', shape: '圖形' }[t] || t);
  const showOpacity = selected && (selected.type === 'image' || selected.type === 'shape');
  const showShapeProps = selected && selected.type === 'shape';
  const isButton = selected?.type === 'shape' && selected?.shapeType === 'button';

  return (
    <div className="min-h-screen bg-bauhaus-paper pb-20">
      {/* 手機版提示：此編輯器不適合觸控操作 */}
      <div className="md:hidden bg-bauhaus-yellow border-b-2 border-bauhaus-black px-4 py-2 text-xs font-bold text-bauhaus-black text-center">
        🖥️ 此編輯器為桌面工具，建議使用電腦操作
      </div>
      {/* ── Top bar ── */}
      <div className="sticky top-0 z-50 bg-white/95 backdrop-blur border-b-2 lg:border-b-4 border-bauhaus-black px-4 py-3">
        <div className="max-w-[1100px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={onBack} className="flex items-center gap-1 px-3 py-2 rounded-xl border-2 border-bauhaus-black text-sm font-bold text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
              <ChevronLeft className="w-4 h-4" /> 返回
            </button>
            <span className="text-lg font-black text-bauhaus-black truncate max-w-[220px]">{lessonTitle}</span>
            <span className="text-xs bg-bauhaus-black text-white px-2 py-0.5 rounded-lg border-2 border-bauhaus-black font-bold uppercase tracking-wide">畫布模式</span>
            {onSwitchToClassic && (
              <button onClick={onSwitchToClassic} className="text-xs text-bauhaus-black/50 hover:text-bauhaus-blue underline ml-1 transition-colors duration-200">傳統模式</button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={() => setShowGrid(!showGrid)}
              className={`p-2 rounded-xl border-2 border-bauhaus-black text-xs font-bold transition-colors duration-200 min-h-[44px] min-w-[44px] ${showGrid ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'}`}
              title="12 欄格線"><Grid className="w-4 h-4" /></button>
            <button onClick={() => setShowGuides(!showGuides)}
              className={`p-2 rounded-xl border-2 border-bauhaus-black text-xs font-bold transition-colors duration-200 min-h-[44px] min-w-[44px] ${showGuides ? 'bg-bauhaus-red text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'}`}
              title="對齊輔助線">{showGuides ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}</button>
            <div className="w-px h-6 bg-bauhaus-black/20 mx-1" />
            <button onClick={() => addElement('text_box')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black text-sm font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
              <Type className="w-4 h-4" /> 文字框</button>
            <button onClick={handleAddImage}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black text-sm font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
              <ImagePlus className="w-4 h-4" /> 圖片</button>
            <button onClick={handleAddVideo}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black text-sm font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
              <Video className="w-4 h-4" /> 影片</button>
            <div className="relative" ref={shapeMenuRef}>
              <button onClick={() => setShapeMenuOpen(!shapeMenuOpen)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border-2 border-bauhaus-black text-sm font-bold transition-colors duration-200 min-h-[44px] ${shapeMenuOpen ? 'bg-bauhaus-yellow text-bauhaus-black' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'}`}>
                <Shapes className="w-4 h-4" /> 圖形
              </button>
              {shapeMenuOpen && (
                <div className="absolute right-0 top-full mt-2 bg-white border-2 border-bauhaus-black rounded-xl shadow-hard p-2 grid grid-cols-3 gap-1 w-[210px] z-50">
                  {SHAPE_TYPES.map(({ key, label, Icon: shapeIcon }) => {
                    const Icon = shapeIcon;
                    return (
                    <button key={key} onClick={() => handleAddShape(key)}
                      className="flex flex-col items-center gap-1 p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200 text-bauhaus-black">
                      <Icon className="w-5 h-5" />
                      <span className="text-[10px] font-medium">{label}</span>
                    </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="w-px h-6 bg-bauhaus-black/20 mx-1" />
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-bauhaus-blue text-white border-2 border-bauhaus-black text-sm font-bold hover:bg-bauhaus-blue/90 shadow-hard transition-colors duration-200 disabled:opacity-40 min-h-[44px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none">
              <Save className="w-4 h-4" /> {saving ? '儲存中...' : '儲存'}</button>
          </div>
        </div>
      </div>

      {/* ── Text format toolbar（固定在畫面底部）── */}
      {editingId && selected?.type === 'text_box' && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t-2 border-bauhaus-black rounded-t-xl px-4 py-2">
          <div className="max-w-[1100px] mx-auto flex items-center gap-1 flex-wrap">
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('bold'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="粗體"><Bold className="w-4 h-4" /></button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('italic'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="斜體"><Italic className="w-4 h-4" /></button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('underline'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="底線"><Underline className="w-4 h-4" /></button>
            <div className="w-px h-5 bg-bauhaus-black/20 mx-1" />

            <button onMouseDown={(e) => { e.preventDefault(); execCommand('formatBlock', '<h1>'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="標題 1"><Heading1 className="w-4 h-4" /></button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('formatBlock', '<h2>'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="標題 2"><Heading2 className="w-4 h-4" /></button>
            <div className="w-px h-5 bg-bauhaus-black/20 mx-1" />

            <button onMouseDown={(e) => { e.preventDefault(); execCommand('justifyLeft'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="靠左"><AlignLeft className="w-4 h-4" /></button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('justifyCenter'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="置中"><AlignCenter className="w-4 h-4" /></button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('justifyRight'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="靠右"><AlignRight className="w-4 h-4" /></button>
            <div className="w-px h-5 bg-bauhaus-black/20 mx-1" />

            {/* Lists */}
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('insertUnorderedList'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="項目符號列表">
              <List className="w-4 h-4" />
            </button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('insertOrderedList'); }} className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black transition-colors duration-200" title="編號列表">
              <ListOrdered className="w-4 h-4" />
            </button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('indent'); }}
              className="p-1.5 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black/70 text-[11px] font-bold transition-colors duration-200" title="增加縮排">
              →|
            </button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('outdent'); }}
              className="p-1.5 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black/70 text-[11px] font-bold transition-colors duration-200" title="減少縮排">
              |←
            </button>
            <div className="w-px h-5 bg-bauhaus-black/20 mx-1" />

            {/* Hyperlinks */}
            <button onMouseDown={(e) => { e.preventDefault(); handleCreateLink(); }}
              className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-blue transition-colors duration-200" title="插入超連結">
              <LinkIcon className="w-4 h-4" />
            </button>
            <button onMouseDown={(e) => { e.preventDefault(); execCommand('unlink'); }}
              className="p-2 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-red transition-colors duration-200" title="移除超連結">
              <Unlink className="w-4 h-4" />
            </button>
            <div className="w-px h-5 bg-bauhaus-black/20 mx-1" />

            {/* Font size：任意 px（A−／A＋、直接輸入、常用尺寸） */}
            <div className="flex items-center rounded-xl overflow-hidden border-2 border-bauhaus-black bg-white">
              <button onMouseDown={(e) => { e.preventDefault(); applyFontSizeDelta(-2); }}
                className="px-2 py-1 text-xs font-black text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200" title="縮小字級 −2px">A−</button>
              <input type="number" min="8" max="200" value={fontPxInput}
                onMouseDown={() => saveSelection()}
                onChange={(e) => setFontPxInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFontSizePx(fontPxInput); } }}
                className="w-12 px-1 py-1 text-sm text-center text-bauhaus-black outline-none border-x-2 border-bauhaus-black/20 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                title="字級 px（輸入後按 Enter 套用）" />
              <span className="text-[10px] text-bauhaus-black/40 px-0.5">px</span>
              <button onMouseDown={(e) => { e.preventDefault(); applyFontSizeDelta(2); }}
                className="px-2 py-1 text-xs font-black text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200" title="放大字級 +2px">A＋</button>
            </div>
            <select
              onMouseDown={() => saveSelection()}
              onChange={(e) => { applyFontSizePx(e.target.value); e.target.value = ''; }}
              className="px-1.5 py-1 text-sm rounded-xl border-2 border-bauhaus-black text-bauhaus-black w-[4.5rem]" defaultValue="" title="常用字級">
              <option value="" disabled>常用</option>
              {[12, 14, 16, 18, 20, 24, 28, 32, 36, 42, 48, 56, 64, 72, 84, 96].map(px => (
                <option key={px} value={px}>{px}px</option>
              ))}
            </select>

            {/* Text color with palette */}
            <ColorPalette
              title="文字顏色"
              icon={<span className="text-[9px] font-black text-bauhaus-black/60">A</span>}
              onApply={(c) => { restoreSelection(); execCommand('foreColor', c); addRecentColor(c); }}
              onOpen={saveSelection}
              recentColors={recentColors}
              dropUp
            />

            {/* Background highlight color with palette */}
            <ColorPalette
              title="文字底色標記"
              icon={<span className="text-[9px] font-black text-bauhaus-black/60 bg-bauhaus-yellow px-0.5">A</span>}
              onApply={(c) => { restoreSelection(); execCommand('hiliteColor', c); addRecentColor(c); }}
              onOpen={saveSelection}
              recentColors={recentColors}
              dropUp
            />
          </div>
        </div>
      )}

      {/* ── Selected element controls（固定在畫面底部）── */}
      {selected && !editingId && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t-2 border-bauhaus-black rounded-t-xl px-4 py-2">
          <div className="max-w-[1100px] mx-auto flex items-center gap-2 text-sm flex-wrap">
            <span className="text-bauhaus-black font-bold">{isButton ? '按鈕' : elLabel(selected.type)}</span>
            <div className="w-px h-5 bg-bauhaus-black/20" />
            <span className="text-bauhaus-black/50 font-mono text-xs">
              x:{Math.round(selected.x)} y:{Math.round(selected.y)} | {Math.round(selected.width)}x{Math.round(selected.height)}
            </span>

            {showOpacity && (
              <>
                <div className="w-px h-5 bg-bauhaus-black/20" />
                <span className="text-bauhaus-black/50 text-xs">透明度</span>
                <input type="range" min="0" max="100" value={Math.round((selected.opacity ?? 1) * 100)}
                  onChange={(e) => updateElement(selected.id, { opacity: parseInt(e.target.value) / 100 })}
                  className="w-20 h-1.5 accent-bauhaus-blue" />
                <span className="text-bauhaus-black/50 text-xs font-mono w-8">{Math.round((selected.opacity ?? 1) * 100)}%</span>
              </>
            )}

            {showShapeProps && !isButton && (
              <>
                <div className="w-px h-5 bg-bauhaus-black/20" />
                <label className="text-bauhaus-black/50 text-xs">填色</label>
                <input type="color" value={selected.fillColor || '#3b82f6'}
                  onChange={(e) => updateElement(selected.id, { fillColor: e.target.value })}
                  className="w-6 h-6 border-2 border-bauhaus-black cursor-pointer" />
                <label className="text-bauhaus-black/50 text-xs">邊框</label>
                <input type="color" value={selected.borderColor || '#1e40af'}
                  onChange={(e) => updateElement(selected.id, { borderColor: e.target.value })}
                  className="w-6 h-6 border-2 border-bauhaus-black cursor-pointer" />
                <select value={selected.borderWidth ?? 2}
                  onChange={(e) => updateElement(selected.id, { borderWidth: parseInt(e.target.value) })}
                  className="px-1.5 py-0.5 text-xs rounded-xl border-2 border-bauhaus-black text-bauhaus-black w-14">
                  <option value="0">無邊框</option><option value="1">1px</option><option value="2">2px</option>
                  <option value="3">3px</option><option value="4">4px</option><option value="6">6px</option>
                </select>
                <button onClick={() => updateElement(selected.id, { fillColor: 'transparent' })}
                  className="px-2 py-0.5 text-xs rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200">無填色</button>
              </>
            )}

            {isButton && (
              <>
                <div className="w-px h-5 bg-bauhaus-black/20" />
                <label className="text-bauhaus-black/50 text-xs">底色</label>
                <input type="color" value={selected.fillColor || '#3b82f6'}
                  onChange={(e) => updateElement(selected.id, { fillColor: e.target.value })}
                  className="w-6 h-6 border-2 border-bauhaus-black cursor-pointer" />
                <label className="text-bauhaus-black/50 text-xs">文字色</label>
                <input type="color" value={selected.textColor || '#ffffff'}
                  onChange={(e) => updateElement(selected.id, { textColor: e.target.value })}
                  className="w-6 h-6 border-2 border-bauhaus-black cursor-pointer" />
                <label className="text-bauhaus-black/50 text-xs">圓角</label>
                <input type="range" min="0" max="30" value={selected.borderRadius ?? 8}
                  onChange={(e) => updateElement(selected.id, { borderRadius: parseInt(e.target.value) })}
                  className="w-14 h-1.5 accent-bauhaus-blue" />
              </>
            )}

            {showShapeProps && (
              <>
                <div className="w-px h-5 bg-bauhaus-black/20" />
                <LinkIcon className="w-3.5 h-3.5 text-bauhaus-black/50" />
                <input type="text" placeholder="超連結網址..."
                  value={selected.linkUrl || ''}
                  onChange={(e) => updateElement(selected.id, { linkUrl: e.target.value })}
                  className="px-2 py-0.5 text-xs rounded-xl border-2 border-bauhaus-black text-bauhaus-black w-40 focus:ring-1 focus:ring-bauhaus-blue outline-none" />
              </>
            )}

            <div className="flex-1" />
            {selected.type === 'image' && (
              <button onClick={() => triggerImageUpload(selected.id)} className="px-3 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
                <ImagePlus className="w-3.5 h-3.5 inline mr-1" />更換</button>
            )}
            {selected.type === 'video' && (
              <button onClick={() => { const u = window.prompt('YouTube 網址：', selected.videoUrl); if (u !== null) updateElement(selected.id, { videoUrl: u }); }}
                className="px-3 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
                <Video className="w-3.5 h-3.5 inline mr-1" />網址</button>
            )}
            <button onClick={() => updateElement(selected.id, { locked: !selected.locked })}
              className="px-2 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px] min-w-[44px]">
              {selected.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}</button>
            <button onClick={() => duplicateElement(selected.id)}
              className="px-2 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px] min-w-[44px]">
              <Copy className="w-3.5 h-3.5" /></button>
            <button onClick={() => deleteElement(selected.id)}
              className="px-2 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-red font-bold hover:bg-bauhaus-red hover:text-white transition-colors duration-200 min-h-[44px] min-w-[44px]">
              <Trash2 className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      )}

      {/* ── Canvas ── */}
      <div className="flex justify-center mt-6 px-4">
        <div style={{ width: CANVAS_WIDTH, position: 'relative' }}>
          {showGrid && (
            <div className="flex mb-1" style={{ width: CANVAS_WIDTH }}>
              {Array.from({ length: COL_COUNT }).map((_, i) => (
                <div key={i} className="text-center text-[9px] font-mono text-slate-400 select-none" style={{ width: COL_WIDTH }}>{i + 1}</div>
              ))}
            </div>
          )}

          <div ref={canvasRef} className="relative bg-white shadow-2xl rounded-xl"
            style={{ width: CANVAS_WIDTH, height: renderedHeight }} onClick={handleCanvasClick}>

            <div className="canvas-grid absolute left-0 top-0 pointer-events-none" style={{
              width: CANVAS_WIDTH, height: renderedHeight,
              backgroundImage: 'radial-gradient(circle, #e2e8f0 1px, transparent 1px)',
              backgroundSize: `${GRID_SIZE * 2}px ${GRID_SIZE * 2}px`, opacity: 0.4,
            }} />

            {showGrid && Array.from({ length: COL_COUNT - 1 }).map((_, i) => (
              <div key={`col-${i}`} className="col-line absolute top-0 pointer-events-none"
                style={{ left: (i + 1) * COL_WIDTH, width: 1, height: renderedHeight, background: 'rgba(99,102,241,0.12)' }} />
            ))}
            {showGrid && <div className="absolute top-0 pointer-events-none" style={{ left: CANVAS_WIDTH / 2, width: 1, height: renderedHeight, background: 'rgba(239,68,68,0.15)', borderLeft: '1px dashed rgba(239,68,68,0.25)' }} />}

            {snapGuides.vertical.map((g, i) => <div key={`sv-${i}`} className="absolute top-0 pointer-events-none z-30" style={{ left: g.x, width: 1, height: renderedHeight, background: '#f43f5e' }} />)}
            {snapGuides.horizontal.map((g, i) => <div key={`sh-${i}`} className="absolute left-0 right-0 pointer-events-none z-30" style={{ top: g.y, height: 1, background: '#f43f5e' }} />)}

            {distances.map((d, i) => d.dir === 'h' ? (
              <div key={`d-${i}`} className="absolute pointer-events-none z-30 flex items-center" style={{ left: d.x1, top: d.y - 8, width: d.x2 - d.x1, height: 16 }}>
                <div className="flex-1 h-px bg-blue-400 relative">
                  <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-2 bg-blue-400" />
                  <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-2 bg-blue-400" />
                </div>
                <span className="absolute left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[9px] px-1 rounded font-mono">{d.dist}px</span>
              </div>
            ) : (
              <div key={`d-${i}`} className="absolute pointer-events-none z-30 flex flex-col items-center" style={{ left: d.x - 8, top: d.y1, width: 16, height: d.y2 - d.y1 }}>
                <div className="flex-1 w-px bg-blue-400 relative">
                  <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-1 bg-blue-400" />
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-2 h-1 bg-blue-400" />
                </div>
                <span className="absolute top-1/2 -translate-y-1/2 bg-blue-500 text-white text-[9px] px-1 rounded font-mono whitespace-nowrap">{d.dist}px</span>
              </div>
            ))}

            {/* ── Elements ── */}
            {elements.map((el) => (
              <Rnd key={el.id}
                position={{ x: el.x, y: el.y }} size={{ width: el.width, height: el.height }}
                minWidth={30} minHeight={el.type === 'shape' && (el.shapeType === 'line' || el.shapeType === 'arrow') ? 10 : 30}
                disableDragging={el.locked || editingId === el.id}
                enableResizing={!el.locked && editingId !== el.id}
                dragGrid={[GRID_SIZE, GRID_SIZE]} resizeGrid={[GRID_SIZE, GRID_SIZE]}
                onDragStart={() => setIsDragging(true)}
                onDrag={(e, d) => handleDrag(el.id, d.x, d.y)}
                onDragStop={(e, d) => handleDragStop(el.id, d.x, d.y)}
                onResizeStop={(e, dir, ref, delta, pos) => {
                  const w = parseInt(ref.style.width), h = parseInt(ref.style.height);
                  const cx = Math.max(0, Math.min(pos.x, CANVAS_WIDTH - w));
                  const cy = Math.max(0, pos.y);
                  updateElement(el.id, { width: w, height: h, x: cx, y: cy });
                }}
                onClick={(e) => handleElementClick(e, el.id)}
                onDoubleClick={() => { if (el.type === 'text_box' || (el.type === 'shape' && el.shapeType === 'button')) setEditingId(el.id); }}
                className={`group ${selectedId === el.id ? 'z-20' : 'z-10'}`}
                style={{
                  outline: selectedId === el.id ? '2px solid #3b82f6' : '1px solid transparent',
                  borderRadius: el.type === 'shape' ? 0 : 8,
                  transition: editingId === el.id ? 'none' : 'outline 0.15s',
                  cursor: el.locked ? 'default' : (editingId === el.id ? 'text' : 'move'),
                  opacity: el.opacity ?? 1,
                }}
              >
                {selectedId === el.id && !el.locked && editingId !== el.id && (
                  <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] px-2 py-0.5 rounded-t-md font-bold whitespace-nowrap flex items-center gap-1">
                    <Move className="w-3 h-3" />
                    {el.type === 'shape' && el.shapeType === 'button' ? '按鈕' : elLabel(el.type)}
                    {el.type === 'shape' && el.linkUrl && <LinkIcon className="w-3 h-3 text-blue-200" />}
                  </div>
                )}

                {el.type === 'text_box' && (
                  <TextBoxContent
                    body={el.body}
                    isEditing={editingId === el.id}
                    onContentChange={(html) => updateElement(el.id, { body: html })}
                    onStartEdit={() => setEditingId(el.id)}
                  />
                )}

                {el.type === 'image' && (
                  <div className="w-full h-full rounded-lg overflow-hidden flex items-center justify-center bg-slate-50">
                    {el.imageUrl ? (
                      <img src={el.imageUrl} alt="" className="w-full h-full object-contain pointer-events-none select-none" draggable={false} />
                    ) : (
                      <button onClick={(e) => { e.stopPropagation(); triggerImageUpload(el.id); }}
                        className="flex flex-col items-center gap-2 text-slate-400 hover:text-blue-500 transition">
                        <ImagePlus className="w-10 h-10" /><span className="text-sm font-medium">點擊上傳圖片</span>
                      </button>
                    )}
                  </div>
                )}

                {el.type === 'video' && (
                  <div className="w-full h-full rounded-lg overflow-hidden bg-black">
                    {el.videoUrl ? (
                      <iframe src={toEmbedUrl(el.videoUrl)} title="Video" className="w-full h-full" allowFullScreen
                        style={{ pointerEvents: selectedId === el.id ? 'none' : 'auto' }} />
                    ) : <div className="w-full h-full flex items-center justify-center text-white/50"><Video className="w-10 h-10" /></div>}
                  </div>
                )}

                {el.type === 'shape' && el.shapeType === 'button' && (
                  <ButtonContent
                    body={el.body}
                    isEditing={editingId === el.id}
                    onContentChange={(text) => updateElement(el.id, { body: text })}
                    onStartEdit={() => setEditingId(el.id)}
                    fillColor={el.fillColor} borderColor={el.borderColor}
                    borderWidth={el.borderWidth} borderRadius={el.borderRadius}
                    textColor={el.textColor}
                  />
                )}

                {el.type === 'shape' && el.shapeType !== 'button' && (
                  <div className="w-full h-full">
                    <ShapeSVG shapeType={el.shapeType} fill={el.fillColor || 'transparent'}
                      stroke={el.borderColor || '#000'} strokeWidth={el.borderWidth ?? 2}
                      borderRadius={el.borderRadius ?? 0} />
                  </div>
                )}
              </Rnd>
            ))}

            {elements.length === 0 && (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400 pointer-events-none">
                <Plus className="w-16 h-16 mb-4 opacity-30" />
                <p className="text-lg font-bold">空白畫布</p>
                <p className="text-sm mt-1">使用上方工具列新增文字框、圖片、影片或圖形</p>
                <p className="text-xs mt-2 text-slate-300">方向鍵微調位置 (Shift+方向鍵 = 1px)</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        .canvas-text-content h1 { font-size: 2em; font-weight: 800; margin: 0.3em 0; }
        .canvas-text-content h2 { font-size: 1.5em; font-weight: 700; margin: 0.3em 0; }
        .canvas-text-content h3 { font-size: 1.25em; font-weight: 700; margin: 0.2em 0; }
        .canvas-text-content p { margin: 0.3em 0; }

        .canvas-text-content ul,
        .canvas-text-content ol { padding-left: 1.5em !important; margin: 0.3em 0; }
        .canvas-text-content li { margin: 0.15em 0; }

        /* ── Ordered list: 1 → a → i → • ── */
        .canvas-text-content ol                { list-style-type: decimal !important; }
        .canvas-text-content ol ol             { list-style-type: lower-alpha !important; }
        .canvas-text-content ol ol ol          { list-style-type: lower-roman !important; }
        .canvas-text-content ol ol ol ol       { list-style-type: disc !important; }
        .canvas-text-content ol ol ol ol ol    { list-style-type: circle !important; }

        /* ── Unordered list: • → ○ → ■ → – → • ── */
        .canvas-text-content ul                { list-style-type: disc !important; }
        .canvas-text-content ul ul             { list-style-type: circle !important; }
        .canvas-text-content ul ul ul          { list-style-type: square !important; }
        .canvas-text-content ul ul ul ul       { list-style-type: '– ' !important; }
        .canvas-text-content ul ul ul ul ul    { list-style-type: disc !important; }

        .canvas-text-content a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
        .canvas-text-content a:hover { color: #1d4ed8; }
        .react-draggable-dragging { opacity: 0.85; }
      `}} />
    </div>
  );
};

export default CanvasEditor;
