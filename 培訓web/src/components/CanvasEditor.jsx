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
import { toYouTubeEmbedUrl as toEmbedUrl } from '../lib/youtube';
import {
  MARQUEE_DRAG_THRESHOLD,
  clampSelectionDelta,
  createPastedElements,
  getMarqueeSelectionIds,
  getSelectionBounds,
  normalizeRect,
  resizeSelectionFromHandle,
} from '../lib/canvasSelection';
import {
  CANVAS_AUTOSAVE_DELAY_MS,
  buildCanvasElementPayload,
  createCanvasSavedFingerprints,
  getDirtyCanvasElements,
} from '../lib/canvasPersistence';
import { applyTextSelectionIndent } from '../lib/canvasTextIndent';
import {
  captureTextSelection,
  normalizeCanvasFontSizePx,
  restoreTextSelection,
} from '../lib/canvasTextFormatting';
import { sanitizeRichHtml } from '../lib/sanitizeRichHtml';

const CANVAS_WIDTH = 960;
const MIN_CANVAS_HEIGHT = 600;
const GRID_SIZE = 10;
const COL_COUNT = 12;
const COL_WIDTH = CANVAS_WIDTH / COL_COUNT;
const SNAP_THRESHOLD = 6;
const GUIDE_PADDING = 20;

const createCanvasElementId = () => `new_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const isEditableTarget = (target) => Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));

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

const GROUP_RESIZE_HANDLES = [
  {
    key: 'nw', label: '從左上角等比例縮放', cursor: 'nwse-resize',
    buttonClass: '-left-3 -top-3', handleClass: 'h-3 w-3 rounded-full',
  },
  {
    key: 'n', label: '調整整組高度（上方）', cursor: 'ns-resize',
    buttonClass: 'left-1/2 -top-3 -translate-x-1/2', handleClass: 'h-2.5 w-5 rounded-full',
  },
  {
    key: 'ne', label: '從右上角等比例縮放', cursor: 'nesw-resize',
    buttonClass: '-right-3 -top-3', handleClass: 'h-3 w-3 rounded-full',
  },
  {
    key: 'e', label: '調整整組寬度（右側）', cursor: 'ew-resize',
    buttonClass: '-right-3 top-1/2 -translate-y-1/2', handleClass: 'h-5 w-2.5 rounded-full',
  },
  {
    key: 'se', label: '從右下角等比例縮放', cursor: 'nwse-resize',
    buttonClass: '-bottom-3 -right-3', handleClass: 'h-3 w-3 rounded-full',
  },
  {
    key: 's', label: '調整整組高度（下方）', cursor: 'ns-resize',
    buttonClass: '-bottom-3 left-1/2 -translate-x-1/2', handleClass: 'h-2.5 w-5 rounded-full',
  },
  {
    key: 'sw', label: '從左下角等比例縮放', cursor: 'nesw-resize',
    buttonClass: '-bottom-3 -left-3', handleClass: 'h-3 w-3 rounded-full',
  },
  {
    key: 'w', label: '調整整組寬度（左側）', cursor: 'ew-resize',
    buttonClass: '-left-3 top-1/2 -translate-y-1/2', handleClass: 'h-5 w-2.5 rounded-full',
  },
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
      ref.current.innerHTML = sanitizeRichHtml(body || '');
    }
  }, [body, isEditing]);

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = sanitizeRichHtml(body || '');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleKeyDown = (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    e.stopPropagation();

    const sel = window.getSelection();
    const changed = applyTextSelectionIndent(ref.current, sel, e.shiftKey ? 'outdent' : 'indent');
    if (changed && ref.current) {
      onContentChange(ref.current.innerHTML);
    }
  };

  return (
    <div ref={ref}
      className="w-full h-full p-3 overflow-auto rounded-lg canvas-text-content"
      contentEditable={isEditing} suppressContentEditableWarning
      onKeyDown={isEditing ? handleKeyDown : undefined}
      onInput={() => {
        if (ref.current) onContentChange(ref.current.innerHTML);
      }}
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
        onInput={() => { if (ref.current) onContentChange(ref.current.textContent); }}
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
  const [selectedIds, setSelectedIds] = useState([]);
  const [marqueeRect, setMarqueeRect] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [lessonTitle, setLessonTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState('saved');
  const [saveError, setSaveError] = useState('');
  const [lastSavedAt, setLastSavedAt] = useState(null);
  const [fontPxInput, setFontPxInput] = useState('16');
  const [canvasHeight, setCanvasHeight] = useState(MIN_CANVAS_HEIGHT);
  const [showGrid, setShowGrid] = useState(true);
  const [showGuides, setShowGuides] = useState(true);
  const [snapGuides, setSnapGuides] = useState({ vertical: [], horizontal: [] });
  const [isDragging, setIsDragging] = useState(false);
  const [isGroupResizing, setIsGroupResizing] = useState(false);
  const [shapeMenuOpen, setShapeMenuOpen] = useState(false);
  const [recentColors, setRecentColors] = useState(loadRecentColors);
  const canvasRef = useRef(null);
  const shapeMenuRef = useRef(null);
  const selectionRef = useRef(null);
  const marqueeStateRef = useRef(null);
  const dragStateRef = useRef(null);
  const groupResizeStateRef = useRef(null);
  const ignoreNextClickRef = useRef(false);
  const clipboardRef = useRef([]);
  const pasteCountRef = useRef(0);
  const elementsRef = useRef([]);
  const savedFingerprintsRef = useRef(new Map());
  const persistedIdByClientIdRef = useRef(new Map());
  const loadedLessonIdRef = useRef(null);
  const saveQueueRef = useRef(Promise.resolve(true));

  elementsRef.current = elements;

  const selectedId = selectedIds.at(-1) || null;

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
      loadedLessonIdRef.current = null;
      setSaveStatus('saved');
      setSaveError('');
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
            body: sanitizeRichHtml(c.body || ''), title: c.title || '',
            videoUrl: c.video_url || '',
            storagePath: c.type === 'image_text' ? c.video_url : '',
            imageUrl, order: c.order ?? 0, locked: pos.locked ?? false,
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
        elementsRef.current = mapped;
        savedFingerprintsRef.current = createCanvasSavedFingerprints(mapped, lessonId);
        persistedIdByClientIdRef.current = new Map(
          mapped.filter((element) => element.dbId).map((element) => [element.id, element.dbId]),
        );
        loadedLessonIdRef.current = lessonId;
        setElements(mapped);
        setSelectedIds([]);
        setEditingId(null);
        setLastSavedAt(null);
      } catch (err) { console.error('載入失敗:', err); }
      finally { setLoading(false); }
    };
    if (lessonId) fetchData();
  }, [lessonId]);

  const addElement = (type, extraProps = {}) => {
    const id = createCanvasElementId();
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
    setSelectedIds([id]);
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

  const deleteElements = async (ids) => {
    const idSet = new Set(ids);
    const targets = elements.filter((element) => idSet.has(element.id));
    if (targets.length === 0) return;

    const message = targets.length === 1
      ? '確定要刪除此元素嗎？'
      : `確定要刪除選取的 ${targets.length} 個元素嗎？`;
    if (!window.confirm(message)) return;

    const dbIds = targets.map((element) => (
      element.dbId || persistedIdByClientIdRef.current.get(element.id)
    )).filter(Boolean);
    if (dbIds.length > 0) {
      const { error } = await supabase.from('contents').delete().in('id', dbIds);
      if (error) {
        console.error('刪除元素失敗:', error);
        alert('刪除失敗：' + error.message);
        return;
      }
    }

    const remainingStoragePaths = new Set(
      elements.filter((element) => !idSet.has(element.id)).map((element) => element.storagePath).filter(Boolean),
    );
    const removablePaths = [...new Set(
      targets.map((element) => element.storagePath).filter((path) => path && !remainingStoragePaths.has(path)),
    )];
    if (removablePaths.length > 0) {
      const { error } = await supabase.storage.from('content-images').remove(removablePaths);
      if (error) console.error('圖片檔案清理失敗:', error);
    }

    idSet.forEach((id) => {
      savedFingerprintsRef.current.delete(id);
      persistedIdByClientIdRef.current.delete(id);
    });
    setElements((prev) => prev.filter((element) => !idSet.has(element.id)));
    setSelectedIds((prev) => prev.filter((id) => !idSet.has(id)));
    if (editingId && idSet.has(editingId)) setEditingId(null);
  };

  const copyElements = (ids = selectedIds) => {
    const idSet = new Set(ids);
    const copied = elements.filter((element) => idSet.has(element.id)).map((element) => ({ ...element }));
    clipboardRef.current = copied;
    pasteCountRef.current = 0;
    return copied;
  };

  const pasteElements = (sourceElements = clipboardRef.current) => {
    if (sourceElements.length === 0) return;
    pasteCountRef.current += 1;
    const pasted = createPastedElements(sourceElements, {
      offset: pasteCountRef.current * 20,
      canvasWidth: CANVAS_WIDTH,
      orderStart: elements.length,
      createId: createCanvasElementId,
    });
    setElements((prev) => [...prev, ...pasted]);
    setSelectedIds(pasted.map((element) => element.id));
    setEditingId(null);
  };

  const duplicateElements = (ids) => {
    const copied = copyElements(ids);
    pasteElements(copied);
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
  const hasUnsavedChanges = useCallback((snapshot = elementsRef.current) => (
    loadedLessonIdRef.current === lessonId
    && getDirtyCanvasElements(snapshot, savedFingerprintsRef.current, lessonId).length > 0
  ), [lessonId]);

  const persistCanvasSnapshot = useCallback(async (requestedElements) => {
    if (loadedLessonIdRef.current !== lessonId) return false;

    const currentIds = new Set(elementsRef.current.map((element) => element.id));
    const snapshot = requestedElements.filter((element) => currentIds.has(element.id));
    const dirtyElements = getDirtyCanvasElements(snapshot, savedFingerprintsRef.current, lessonId);
    if (dirtyElements.length === 0) {
      if (!hasUnsavedChanges()) setSaveStatus('saved');
      return true;
    }

    setSaving(true);
    setSaveStatus('saving');
    setSaveError('');
    try {
      const insertedIds = new Map();
      for (const { element, index, fingerprint } of dirtyElements) {
        const basePayload = buildCanvasElementPayload(element, index, lessonId);
        const payload = { ...basePayload, body: sanitizeRichHtml(basePayload.body) };
        const persistedId = element.dbId || persistedIdByClientIdRef.current.get(element.id);
        if (persistedId) {
          const { error } = await supabase.from('contents').update(payload).eq('id', persistedId);
          if (error) throw error;
        } else {
          const { data, error } = await supabase.from('contents').insert(payload).select('id').single();
          if (error) throw error;
          if (data?.id) {
            const stillExists = elementsRef.current.some((current) => current.id === element.id);
            if (!stillExists) {
              const { error: cleanupError } = await supabase.from('contents').delete().eq('id', data.id);
              if (cleanupError) throw cleanupError;
              continue;
            }
            persistedIdByClientIdRef.current.set(element.id, data.id);
            insertedIds.set(element.id, data.id);
          }
        }
        savedFingerprintsRef.current.set(element.id, fingerprint);
      }

      if (insertedIds.size > 0) {
        setElements((current) => {
          const next = current.map((element) => insertedIds.has(element.id)
            ? { ...element, dbId: insertedIds.get(element.id) }
            : element);
          elementsRef.current = next;
          return next;
        });
      }

      setLastSavedAt(new Date());
      setSaveStatus('saved');
      return true;
    } catch (err) {
      console.error('儲存失敗:', err);
      setSaveError(err?.message || JSON.stringify(err));
      setSaveStatus('error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [hasUnsavedChanges, lessonId]);

  const queueCanvasSave = useCallback((snapshot = elementsRef.current) => {
    const requestedElements = snapshot.map((element) => ({ ...element }));
    const task = saveQueueRef.current.then(
      () => persistCanvasSnapshot(requestedElements),
      () => persistCanvasSnapshot(requestedElements),
    );
    saveQueueRef.current = task;
    return task;
  }, [persistCanvasSnapshot]);

  const handleSave = useCallback(() => queueCanvasSave(elementsRef.current), [queueCanvasSave]);

  useEffect(() => {
    if (loading || loadedLessonIdRef.current !== lessonId) return undefined;
    if (!hasUnsavedChanges(elements)) return undefined;

    const timer = window.setTimeout(() => {
      void queueCanvasSave(elementsRef.current);
    }, CANVAS_AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [elements, hasUnsavedChanges, lessonId, loading, queueCanvasSave]);

  useEffect(() => {
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden' && hasUnsavedChanges()) {
        void queueCanvasSave(elementsRef.current);
      }
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => document.removeEventListener('visibilitychange', flushWhenHidden);
  }, [hasUnsavedChanges, queueCanvasSave]);

  useEffect(() => {
    const warnBeforeUnload = (event) => {
      if (!saving && !hasUnsavedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [hasUnsavedChanges, saving]);

  const saveBeforeLeaving = useCallback(async (callback) => {
    const saved = await queueCanvasSave(elementsRef.current);
    if (saved && !hasUnsavedChanges()) callback?.();
  }, [hasUnsavedChanges, queueCanvasSave]);

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
    const v = normalizeCanvasFontSizePx(px);
    if (!v) return false;
    const selection = window.getSelection();
    const bookmark = captureTextSelection(root, selection);
    if (!bookmark) return false;

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
    root.focus({ preventScroll: true });
    restoreTextSelection(root, selection, bookmark);
    if (selection.rangeCount > 0) selectionRef.current = selection.getRangeAt(0).cloneRange();
    if (editingId) updateElement(editingId, { body: root.innerHTML });
    setFontPxInput(String(v));
    return true;
  };

  const withTextSelection = (fn) => {
    let root = getEditingRoot();
    if (!root) { restoreSelection(); root = getEditingRoot(); }
    if (root) fn(root);
  };

  const applyIndent = (direction) => withTextSelection((root) => {
    const changed = applyTextSelectionIndent(root, window.getSelection(), direction);
    if (changed && editingId) updateElement(editingId, { body: root.innerHTML });
  });

  const applyFontSizePx = (px) => {
    restoreSelection();
    withTextSelection((root) => applyPxToSelection(root, px));
  };
  const applyFontSizeDelta = (d) => {
    restoreSelection();
    withTextSelection((root) => applyPxToSelection(root, getSelectionFontPx() + d));
  };

  const handleCreateLink = () => {
    saveSelection();
    const url = window.prompt('請輸入連結網址：', 'https://');
    if (url) {
      restoreSelection();
      execCommand('createLink', url);
    }
  };

  const getCanvasPoint = useCallback((event) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.max(0, Math.min(event.clientX - rect.left, CANVAS_WIDTH)),
      y: Math.max(0, Math.min(event.clientY - rect.top, renderedHeight)),
    };
  }, [renderedHeight]);

  const handleCanvasPointerDown = useCallback((event) => {
    if (event.pointerType !== 'mouse' || event.button !== 0 || event.target !== event.currentTarget) return;
    const start = getCanvasPoint(event);
    if (!start) return;

    event.preventDefault();
    exitEditing();
    const initialIds = event.shiftKey ? selectedIds : [];
    marqueeStateRef.current = {
      pointerId: event.pointerId,
      start,
      initialIds,
      additive: event.shiftKey,
      moved: false,
    };
    setMarqueeRect(null);
    if (!event.shiftKey) setSelectedIds([]);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* noop */ }
  }, [exitEditing, getCanvasPoint, selectedIds]);

  const handleCanvasPointerMove = useCallback((event) => {
    const state = marqueeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const current = getCanvasPoint(event);
    if (!current) return;

    const moved = Math.hypot(current.x - state.start.x, current.y - state.start.y) >= MARQUEE_DRAG_THRESHOLD;
    if (!state.moved && !moved) return;
    state.moved = true;
    const rect = normalizeRect(state.start, current);
    const intersectingIds = getMarqueeSelectionIds(elements, rect);
    const nextIds = state.additive
      ? [...new Set([...state.initialIds, ...intersectingIds])]
      : intersectingIds;
    setMarqueeRect(rect);
    setSelectedIds(nextIds);
  }, [elements, getCanvasPoint]);

  const finishMarquee = useCallback((event, cancelled = false) => {
    const state = marqueeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (cancelled) setSelectedIds(state.initialIds);
    else if (!state.moved && !state.additive) setSelectedIds([]);
    marqueeStateRef.current = null;
    setMarqueeRect(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  }, []);

  const handleElementClick = useCallback((event, elementId) => {
    event.stopPropagation();
    if (ignoreNextClickRef.current) {
      ignoreNextClickRef.current = false;
      return;
    }
    if (editingId && editingId !== elementId) exitEditing();
    const element = elements.find((item) => item.id === elementId);
    if (element?.locked) {
      setSelectedIds((current) => event.shiftKey && current.length === 1 && current[0] === elementId
        ? []
        : [elementId]);
      return;
    }
    if (event.shiftKey) {
      setSelectedIds((current) => current.includes(elementId)
        ? current.filter((id) => id !== elementId)
        : [...current, elementId]);
    } else {
      setSelectedIds([elementId]);
    }
  }, [editingId, elements, exitEditing]);

  const handleDragStart = useCallback((event, elementId) => {
    const element = elements.find((item) => item.id === elementId);
    if (!element || element.locked) return false;

    exitEditing();
    const nextSelectionIds = selectedIds.includes(elementId)
      ? selectedIds
      : (event.shiftKey ? [...selectedIds, elementId] : [elementId]);
    const groupIds = nextSelectionIds.filter(
      (id) => !elements.find((item) => item.id === id)?.locked,
    );

    const idSet = new Set(groupIds);
    const origins = new Map(
      elements.filter((item) => idSet.has(item.id)).map((item) => [item.id, { ...item }]),
    );
    dragStateRef.current = {
      anchorId: elementId,
      anchorStart: { x: element.x, y: element.y },
      bounds: getSelectionBounds(elements, idSet),
      groupIds: idSet,
      origins,
      otherElements: elements.filter((item) => !idSet.has(item.id)),
      nextSelectionIds,
      selectionApplied: false,
      moved: false,
    };
    ignoreNextClickRef.current = false;
    setIsDragging(true);
    return true;
  }, [elements, exitEditing, selectedIds]);

  const handleDrag = useCallback((elementId, x, y) => {
    const state = dragStateRef.current;
    if (!state || state.anchorId !== elementId) return;
    const delta = clampSelectionDelta(
      state.bounds,
      x - state.anchorStart.x,
      y - state.anchorStart.y,
      CANVAS_WIDTH,
    );
    if (delta.deltaX !== 0 || delta.deltaY !== 0) {
      state.moved = true;
      if (!state.selectionApplied) {
        state.selectionApplied = true;
        setSelectedIds(state.nextSelectionIds);
      }
    }

    setElements((current) => current.map((element) => {
      const origin = state.origins.get(element.id);
      return origin
        ? { ...element, x: origin.x + delta.deltaX, y: origin.y + delta.deltaY }
        : element;
    }));

    const maxBottom = Math.max(...[...state.origins.values()].map(
      (element) => element.y + delta.deltaY + (element.height || 100) + 400,
    ));
    setCanvasHeight((current) => Math.max(current, maxBottom));

    if (showGuides) {
      const anchor = state.origins.get(elementId);
      setSnapGuides(computeSnapGuides({
        ...anchor,
        x: anchor.x + delta.deltaX,
        y: anchor.y + delta.deltaY,
      }, state.otherElements, CANVAS_WIDTH));
    }
  }, [showGuides]);

  const handleDragStop = useCallback((elementId, x, y) => {
    const state = dragStateRef.current;
    if (!state || state.anchorId !== elementId) return;

    let delta = clampSelectionDelta(
      state.bounds,
      x - state.anchorStart.x,
      y - state.anchorStart.y,
      CANVAS_WIDTH,
    );
    if (showGuides) {
      const anchor = state.origins.get(elementId);
      const guides = computeSnapGuides({
        ...anchor,
        x: anchor.x + delta.deltaX,
        y: anchor.y + delta.deltaY,
      }, state.otherElements, CANVAS_WIDTH);
      delta = clampSelectionDelta(
        state.bounds,
        (guides.snapX ?? (anchor.x + delta.deltaX)) - anchor.x,
        (guides.snapY ?? (anchor.y + delta.deltaY)) - anchor.y,
        CANVAS_WIDTH,
      );
      setTimeout(() => setSnapGuides({ vertical: [], horizontal: [] }), 300);
    } else {
      setSnapGuides({ vertical: [], horizontal: [] });
    }

    setElements((current) => current.map((element) => {
      const origin = state.origins.get(element.id);
      return origin
        ? { ...element, x: origin.x + delta.deltaX, y: origin.y + delta.deltaY }
        : element;
    }));
    setIsDragging(false);
    setCanvasHeight(MIN_CANVAS_HEIGHT);
    dragStateRef.current = null;

    if (state.moved) {
      if (!state.selectionApplied) setSelectedIds(state.nextSelectionIds);
      ignoreNextClickRef.current = true;
      setTimeout(() => { ignoreNextClickRef.current = false; }, 0);
    }
  }, [showGuides]);

  const selectionBounds = useMemo(
    () => getSelectionBounds(elements, selectedIds),
    [elements, selectedIds],
  );

  const applyGroupResize = useCallback((event) => {
    const state = groupResizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const currentPoint = getCanvasPoint(event);
    if (!currentPoint) return;

    const resizedElements = resizeSelectionFromHandle(
      state.originElements,
      state.selectedIds,
      state.bounds,
      state.handle,
      currentPoint.x - state.start.x,
      currentPoint.y - state.start.y,
      CANVAS_WIDTH,
    );
    const geometryById = new Map(resizedElements.map((element) => [element.id, {
      x: element.x,
      y: element.y,
      width: element.width,
      height: element.height,
    }]));

    setElements((current) => current.map((element) => {
      const geometry = geometryById.get(element.id);
      return geometry ? { ...element, ...geometry } : element;
    }));
  }, [getCanvasPoint]);

  const cancelGroupResize = useCallback(() => {
    const state = groupResizeStateRef.current;
    if (!state) return false;

    setElements((current) => current.map((element) => {
      const origin = state.origins.get(element.id);
      return origin ? {
        ...element,
        x: origin.x,
        y: origin.y,
        width: origin.width,
        height: origin.height,
      } : element;
    }));
    groupResizeStateRef.current = null;
    setIsGroupResizing(false);
    setCanvasHeight(MIN_CANVAS_HEIGHT);
    setSnapGuides({ vertical: [], horizontal: [] });
    try { state.captureTarget.releasePointerCapture(state.pointerId); } catch { /* noop */ }
    return true;
  }, []);

  const startGroupResize = useCallback((event, handle) => {
    if (event.button !== 0 || !selectionBounds || selectedIds.length < 2) return;
    const start = getCanvasPoint(event);
    if (!start) return;

    event.preventDefault();
    event.stopPropagation();
    exitEditing();
    const selectedSet = new Set(selectedIds);
    const originElements = elements
      .filter((element) => selectedSet.has(element.id) && !element.locked)
      .map((element) => ({ ...element }));
    if (originElements.length < 2) return;

    groupResizeStateRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      handle,
      start,
      bounds: { ...selectionBounds },
      selectedIds: selectedSet,
      originElements,
      origins: new Map(originElements.map((element) => [element.id, element])),
    };
    setIsGroupResizing(true);
    setSnapGuides({ vertical: [], horizontal: [] });
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* noop */ }
  }, [elements, exitEditing, getCanvasPoint, selectedIds, selectionBounds]);

  const finishGroupResize = useCallback((event, cancelled = false) => {
    const state = groupResizeStateRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (cancelled) cancelGroupResize();
    else {
      applyGroupResize(event);
      groupResizeStateRef.current = null;
      setIsGroupResizing(false);
      setCanvasHeight(MIN_CANVAS_HEIGHT);
    }
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* noop */ }
  }, [applyGroupResize, cancelGroupResize]);

  const distances = useMemo(() => {
    if (!selectionBounds || isDragging || isGroupResizing) return [];
    const selectedSet = new Set(selectedIds);
    const measurementTarget = selectedIds.length === 1
      ? elements.find((element) => element.id === selectedId)
      : { ...selectionBounds, x: selectionBounds.left, y: selectionBounds.top, id: '__selection__' };
    return computeDistances(measurementTarget, elements.filter((element) => !selectedSet.has(element.id)));
  }, [selectedId, selectedIds, selectionBounds, elements, isDragging, isGroupResizing]);

  const moveSelectedBy = useCallback((deltaX, deltaY) => {
    const movableIds = selectedIds.filter(
      (id) => !elements.find((element) => element.id === id)?.locked,
    );
    if (movableIds.length === 0) return;
    const movableSet = new Set(movableIds);
    const bounds = getSelectionBounds(elements, movableSet);
    const delta = clampSelectionDelta(bounds, deltaX, deltaY, CANVAS_WIDTH);
    setElements((current) => current.map((element) => movableSet.has(element.id)
      ? { ...element, x: element.x + delta.deltaX, y: element.y + delta.deltaY }
      : element));
  }, [elements, selectedIds]);

  useEffect(() => {
    const handler = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (cancelGroupResize()) return;
        if (editingId) exitEditing();
        marqueeStateRef.current = null;
        setMarqueeRect(null);
        setSelectedIds([]);
        return;
      }
      if (isGroupResizing) return;
      if (editingId || isEditableTarget(event.target)) return;

      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 'a') {
        event.preventDefault();
        setSelectedIds(elements.filter((element) => !element.locked).map((element) => element.id));
        return;
      }
      if (modifier && key === 'c' && selectedIds.length > 0) {
        event.preventDefault();
        copyElements();
        return;
      }
      if (modifier && key === 'v' && clipboardRef.current.length > 0) {
        event.preventDefault();
        pasteElements();
        return;
      }
      if (selectedIds.length === 0) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        deleteElements(selectedIds);
        return;
      }

      const step = event.shiftKey ? 1 : GRID_SIZE;
      if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelectedBy(-step, 0); }
      if (event.key === 'ArrowRight') { event.preventDefault(); moveSelectedBy(step, 0); }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveSelectedBy(0, -step); }
      if (event.key === 'ArrowDown') { event.preventDefault(); moveSelectedBy(0, step); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // Keyboard actions intentionally read the latest selection and element snapshots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId, elements, selectedIds, moveSelectedBy, exitEditing, cancelGroupResize, isGroupResizing]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-bauhaus-blue border-t-transparent" />
        <span className="ml-3 text-bauhaus-black/50 font-medium">載入中...</span>
      </div>
    );
  }

  const selected = elements.find((el) => el.id === selectedId);
  const isMultiSelection = selectedIds.length > 1;
  const elLabel = (t) => ({ text_box: '文字框', image: '圖片', video: '影片', shape: '圖形' }[t] || t);
  const showOpacity = !isMultiSelection && selected && (selected.type === 'image' || selected.type === 'shape');
  const showShapeProps = !isMultiSelection && selected && selected.type === 'shape';
  const isButton = !isMultiSelection && selected?.type === 'shape' && selected?.shapeType === 'button';
  const effectiveSaveStatus = saveStatus === 'saving' || saveStatus === 'error'
    ? saveStatus
    : hasUnsavedChanges(elements)
      ? 'pending'
      : 'saved';
  const saveStatusText = effectiveSaveStatus === 'saving'
    ? '自動儲存中...'
    : effectiveSaveStatus === 'pending'
      ? '有變更，準備自動儲存'
      : effectiveSaveStatus === 'error'
        ? `自動儲存失敗${saveError ? `：${saveError}` : ''}`
        : lastSavedAt
          ? `已儲存 ${lastSavedAt.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
          : '所有變更已儲存';
  const saveStatusClass = effectiveSaveStatus === 'error'
    ? 'text-bauhaus-red'
    : effectiveSaveStatus === 'saved'
      ? 'text-emerald-700'
      : 'text-bauhaus-black/60';

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
            <button onClick={() => { void saveBeforeLeaving(onBack); }} className="flex items-center gap-1 px-3 py-2 rounded-xl border-2 border-bauhaus-black text-sm font-bold text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
              <ChevronLeft className="w-4 h-4" /> 返回
            </button>
            <span className="text-lg font-black text-bauhaus-black truncate max-w-[220px]">{lessonTitle}</span>
            <span className="text-xs bg-bauhaus-black text-white px-2 py-0.5 rounded-lg border-2 border-bauhaus-black font-bold uppercase tracking-wide">畫布模式</span>
            {onSwitchToClassic && (
              <button onClick={() => { void saveBeforeLeaving(onSwitchToClassic); }} className="text-xs text-bauhaus-black/50 hover:text-bauhaus-blue underline ml-1 transition-colors duration-200">傳統模式</button>
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
            <div role="status" aria-live="polite" data-testid="canvas-autosave-status"
              className={`max-w-[210px] truncate text-xs font-bold ${saveStatusClass}`}
              title={saveStatusText}>
              {saveStatusText}
            </div>
            <button onClick={handleSave} disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-bauhaus-blue text-white border-2 border-bauhaus-black text-sm font-bold hover:bg-bauhaus-blue/90 shadow-hard transition-colors duration-200 disabled:opacity-40 min-h-[44px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none">
              <Save className="w-4 h-4" /> {saving ? '儲存中...' : saveStatus === 'error' ? '重試儲存' : '立即儲存'}</button>
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
            <button onMouseDown={(e) => { e.preventDefault(); applyIndent('indent'); }}
              className="p-1.5 border-2 border-transparent hover:border-bauhaus-black hover:bg-bauhaus-muted text-bauhaus-black/70 text-[11px] font-bold transition-colors duration-200" title="增加縮排">
              →|
            </button>
            <button onMouseDown={(e) => { e.preventDefault(); applyIndent('outdent'); }}
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
              <button onMouseDown={(e) => { e.preventDefault(); saveSelection(); applyFontSizeDelta(-2); }}
                className="px-2 py-1 text-xs font-black text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200" title="縮小字級 −2px">A−</button>
              <input type="number" min="8" max="200" value={fontPxInput}
                onMouseDown={() => saveSelection()}
                onChange={(e) => setFontPxInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyFontSizePx(fontPxInput); } }}
                className="w-12 px-1 py-1 text-sm text-center text-bauhaus-black outline-none border-x-2 border-bauhaus-black/20 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                title="字級 px（輸入後按 Enter 套用）" />
              <span className="text-[10px] text-bauhaus-black/40 px-0.5">px</span>
              <button onMouseDown={(e) => { e.preventDefault(); saveSelection(); applyFontSizeDelta(2); }}
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
            <span className="text-bauhaus-black font-bold">
              {isMultiSelection ? `已選取 ${selectedIds.length} 個元素` : (isButton ? '按鈕' : elLabel(selected.type))}
            </span>
            <div className="w-px h-5 bg-bauhaus-black/20" />
            <span className="text-bauhaus-black/50 font-mono text-xs">
              {isMultiSelection && selectionBounds
                ? `x:${Math.round(selectionBounds.left)} y:${Math.round(selectionBounds.top)} | ${Math.round(selectionBounds.width)}x${Math.round(selectionBounds.height)}`
                : `x:${Math.round(selected.x)} y:${Math.round(selected.y)} | ${Math.round(selected.width)}x${Math.round(selected.height)}`}
            </span>
            {isMultiSelection && (
              <>
                <div className="w-px h-5 bg-bauhaus-black/20" />
                <span className="text-bauhaus-black/50 text-xs">
                  拖曳邊線調整寬高，拖曳角落等比例縮放
                </span>
              </>
            )}

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
            {!isMultiSelection && selected.type === 'image' && (
              <button onClick={() => triggerImageUpload(selected.id)} className="px-3 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
                <ImagePlus className="w-3.5 h-3.5 inline mr-1" />更換</button>
            )}
            {!isMultiSelection && selected.type === 'video' && (
              <button onClick={() => { const u = window.prompt('YouTube 網址：', selected.videoUrl); if (u !== null) updateElement(selected.id, { videoUrl: u }); }}
                className="px-3 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px]">
                <Video className="w-3.5 h-3.5 inline mr-1" />網址</button>
            )}
            {!isMultiSelection && (
              <button onClick={() => updateElement(selected.id, { locked: !selected.locked })}
                className="px-2 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px] min-w-[44px]"
                title={selected.locked ? '解除鎖定' : '鎖定元素'}>
                {selected.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              </button>
            )}
            <button onClick={() => duplicateElements(selectedIds)}
              className="px-2 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-black font-bold hover:bg-bauhaus-muted transition-colors duration-200 min-h-[44px] min-w-[44px]"
              title={isMultiSelection ? '複製選取元素' : '複製元素'}>
              <Copy className="w-3.5 h-3.5" /></button>
            <button onClick={() => deleteElements(selectedIds)}
              className="px-2 py-1.5 rounded-xl bg-white border-2 border-bauhaus-black text-bauhaus-red font-bold hover:bg-bauhaus-red hover:text-white transition-colors duration-200 min-h-[44px] min-w-[44px]"
              title={isMultiSelection ? '刪除選取元素' : '刪除元素'}>
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
            style={{ width: CANVAS_WIDTH, height: renderedHeight, cursor: marqueeRect ? 'crosshair' : 'default' }}
            role="region" aria-label="畫布編輯區" data-testid="canvas-editor-surface"
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={(event) => finishMarquee(event)}
            onPointerCancel={(event) => finishMarquee(event, true)}>

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

            {isMultiSelection && selectionBounds && (
              <div className="absolute pointer-events-none z-30 border-2 border-dashed border-blue-600"
                data-testid="group-selection-bounds"
                style={{
                  left: selectionBounds.left,
                  top: selectionBounds.top,
                  width: selectionBounds.width,
                  height: selectionBounds.height,
                }}>
                <div className="absolute -top-7 left-0 bg-blue-600 text-white text-[10px] px-2 py-1 rounded-md font-bold whitespace-nowrap">
                  {selectedIds.length} 個元素
                </div>
                {GROUP_RESIZE_HANDLES.map((handle) => (
                  <button key={handle.key}
                    type="button"
                    aria-label={handle.label}
                    title={handle.label}
                    data-group-resize-handle={handle.key}
                    className={`absolute pointer-events-auto flex h-6 w-6 items-center justify-center touch-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-bauhaus-blue ${handle.buttonClass}`}
                    style={{ cursor: handle.cursor }}
                    onPointerDown={(event) => startGroupResize(event, handle.key)}
                    onPointerMove={applyGroupResize}
                    onPointerUp={(event) => finishGroupResize(event)}
                    onPointerCancel={(event) => finishGroupResize(event, true)}>
                    <span aria-hidden="true"
                      className={`block border-2 border-blue-600 bg-white ${handle.handleClass}`} />
                  </button>
                ))}
              </div>
            )}

            {marqueeRect && (
              <div className="absolute pointer-events-none z-40 border-2 border-blue-600 bg-blue-500/15"
                style={{
                  left: marqueeRect.left,
                  top: marqueeRect.top,
                  width: marqueeRect.width,
                  height: marqueeRect.height,
                }} />
            )}

            {/* ── Elements ── */}
            {elements.map((el) => {
              const isSelected = selectedIds.includes(el.id);
              return (
              <Rnd key={el.id}
                data-canvas-element-id={el.id}
                data-canvas-element-locked={el.locked ? 'true' : 'false'}
                position={{ x: el.x, y: el.y }} size={{ width: el.width, height: el.height }}
                minWidth={30} minHeight={el.type === 'shape' && (el.shapeType === 'line' || el.shapeType === 'arrow') ? 10 : 30}
                disableDragging={el.locked || editingId === el.id || isGroupResizing}
                enableResizing={!isMultiSelection && !el.locked && editingId !== el.id}
                dragGrid={[GRID_SIZE, GRID_SIZE]} resizeGrid={[GRID_SIZE, GRID_SIZE]}
                onDragStart={(event) => handleDragStart(event, el.id)}
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
                className={`group ${isSelected ? 'z-20' : 'z-10'}`}
                style={{
                  outline: isSelected ? '2px solid #3b82f6' : '1px solid transparent',
                  borderRadius: el.type === 'shape' ? 0 : 8,
                  transition: editingId === el.id ? 'none' : 'outline 0.15s',
                  cursor: el.locked ? 'default' : (editingId === el.id ? 'text' : 'move'),
                  opacity: el.opacity ?? 1,
                }}
              >
                {selectedIds.length === 1 && isSelected && !el.locked && editingId !== el.id && (
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
                        style={{ pointerEvents: isSelected ? 'none' : 'auto' }} />
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
              );
            })}

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
