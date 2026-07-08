import { useState, useCallback, useEffect, useRef } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Rnd } from 'react-rnd';
import { supabase } from '../lib/supabaseClient';
import {
  X, Save, Plus, Trash2, ChevronLeft, ChevronRight,
  User, Shield, CreditCard, MapPin, Phone, PenTool, Eye,
  Mail, Landmark, Hash, Image as ImageIcon, Camera
} from 'lucide-react';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const FIELD_DEFS = [
  // 合約用既有欄位
  { type: 'name', label: '姓名', icon: User, color: '#22c55e', defaultW: 160, defaultH: 24, group: '合約' },
  { type: 'instructor_role', label: '講師等級', icon: Shield, color: '#3b82f6', defaultW: 100, defaultH: 24, group: '合約' },
  { type: 'id_number', label: '身分證字號', icon: CreditCard, color: '#f97316', defaultW: 160, defaultH: 24, group: '合約' },
  { type: 'address', label: '地址', icon: MapPin, color: '#a855f7', defaultW: 280, defaultH: 24, group: '合約' },
  { type: 'phone', label: '電話', icon: Phone, color: '#ef4444', defaultW: 160, defaultH: 24, group: '合約' },
  { type: 'signature', label: '簽名', icon: PenTool, color: '#eab308', defaultW: 140, defaultH: 50, group: '合約' },

  // 匯款申請書用新欄位
  { type: 'nickname', label: '講師暱稱', icon: User, color: '#10b981', defaultW: 160, defaultH: 24, group: '匯款表單' },
  { type: 'email_primary', label: 'Email', icon: Mail, color: '#0ea5e9', defaultW: 220, defaultH: 24, group: '匯款表單' },
  { type: 'bank_account_name', label: '匯款戶名', icon: Landmark, color: '#84cc16', defaultW: 160, defaultH: 24, group: '匯款表單' },
  { type: 'bank_name', label: '銀行別', icon: Landmark, color: '#06b6d4', defaultW: 120, defaultH: 24, group: '匯款表單' },
  { type: 'bank_branch', label: '分行別', icon: Landmark, color: '#14b8a6', defaultW: 120, defaultH: 24, group: '匯款表單' },
  { type: 'bank_account_number', label: '銀行帳號', icon: Hash, color: '#f59e0b', defaultW: 180, defaultH: 24, group: '匯款表單' },
  { type: 'bank_code', label: '銀行代碼', icon: Hash, color: '#d97706', defaultW: 100, defaultH: 24, group: '匯款表單' },

  // 圖片欄位
  { type: 'photo', label: '大頭照', icon: Camera, color: '#ec4899', defaultW: 100, defaultH: 130, group: '圖片' },
  { type: 'id_front_image', label: '身分證正面', icon: ImageIcon, color: '#f43f5e', defaultW: 180, defaultH: 110, group: '圖片' },
  { type: 'id_back_image', label: '身分證反面', icon: ImageIcon, color: '#e11d48', defaultW: 180, defaultH: 110, group: '圖片' },
  { type: 'bankbook_image', label: '存摺封面', icon: ImageIcon, color: '#be123c', defaultW: 200, defaultH: 130, group: '圖片' },
];

const IMAGE_FIELDS = new Set(['photo', 'id_front_image', 'id_back_image', 'bankbook_image']);
const SIGN_FIELDS = new Set(['signature']);

const FieldPositionEditor = ({ isOpen, onClose, docType, docVersion, pdfUrl }) => {
  const [numPages, setNumPages] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [fields, setFields] = useState([]);
  const [saving, setSaving] = useState(false);
  const [pdfPageSize, setPdfPageSize] = useState({ width: 595, height: 842 });
  const containerRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(560);
  const [previewMode, setPreviewMode] = useState(false);

  const scale = containerWidth / pdfPageSize.width;

  useEffect(() => {
    if (isOpen && docType && docVersion) loadExistingPositions();
  }, [isOpen, docType, docVersion]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setContainerWidth(e.contentRect.width);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [isOpen]);

  const loadExistingPositions = async () => {
    const { data } = await supabase
      .from('contract_field_positions')
      .select('*')
      .eq('doc_type', docType)
      .eq('doc_version', docVersion);
    if (data?.length) {
      setFields(data.map(d => ({
        id: d.id,
        fieldType: d.field_type,
        page: d.page_number,
        x: d.x,
        yFromTop: d.y_from_top,
        width: d.width,
        height: d.height,
        fontSize: d.font_size || 13,
      })));
    } else {
      setFields([]);
    }
  };

  const onDocumentLoadSuccess = useCallback(({ numPages: n }) => {
    setNumPages(n);
    setCurrentPage(1);
  }, []);

  const onPageLoadSuccess = useCallback((page) => {
    const vp = page.getViewport({ scale: 1 });
    setPdfPageSize({ width: vp.width, height: vp.height });
  }, []);

  const addField = (fieldType) => {
    const def = FIELD_DEFS.find(f => f.type === fieldType);
    if (!def) return;
    setFields(prev => [...prev, {
      id: `new_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      fieldType,
      page: currentPage,
      x: 100,
      yFromTop: 100,
      width: def.defaultW,
      height: def.defaultH,
      fontSize: SIGN_FIELDS.has(fieldType) || IMAGE_FIELDS.has(fieldType) ? 0 : 13,
    }]);
  };

  const removeField = (id) => {
    setFields(prev => prev.filter(f => f.id !== id));
  };

  const updateFieldPosition = (id, pxX, pxY) => {
    setFields(prev => prev.map(f => {
      if (f.id !== id) return f;
      return { ...f, x: pxX / scale, yFromTop: pxY / scale };
    }));
  };

  const updateFieldSize = (id, pxW, pxH) => {
    setFields(prev => prev.map(f => {
      if (f.id !== id) return f;
      return { ...f, width: pxW / scale, height: pxH / scale };
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await supabase
        .from('contract_field_positions')
        .delete()
        .eq('doc_type', docType)
        .eq('doc_version', docVersion);

      if (fields.length > 0) {
        const rows = fields.map(f => ({
          doc_type: docType,
          doc_version: docVersion,
          field_type: f.fieldType,
          page_number: f.page,
          x: Math.round(f.x * 100) / 100,
          y_from_top: Math.round(f.yFromTop * 100) / 100,
          width: Math.round(f.width * 100) / 100,
          height: Math.round(f.height * 100) / 100,
          font_size: f.fontSize,
        }));
        const { error } = await supabase.from('contract_field_positions').insert(rows);
        if (error) throw error;
      }
      alert('欄位位置已儲存！');
      onClose();
    } catch (err) {
      alert('儲存失敗：' + (err.message || '未知錯誤'));
    }
    setSaving(false);
  };

  const pageFields = fields.filter(f => f.page === currentPage);

  const getFieldDef = (fieldType) => FIELD_DEFS.find(d => d.type === fieldType);

  const sampleData = {
    name: '王小明',
    instructor_role: 'A+級',
    id_number: 'A123456789',
    address: '台北市中正區重慶南路一段122號',
    phone: '0912345678',
    signature: '[簽名]',
    nickname: '小明老師',
    email_primary: 'xiaoming@example.com',
    bank_account_name: '王小明',
    bank_name: '華南銀行',
    bank_branch: '仁愛分行',
    bank_account_number: '123-45-678901-2',
    bank_code: '0080001',
    photo: '[大頭照]',
    id_front_image: '[身分證正面]',
    id_back_image: '[身分證反面]',
    bankbook_image: '[存摺封面]',
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center">
      <div className="bg-white w-full h-full flex flex-col">
        {/* 手機版提示：此編輯器不適合觸控操作 */}
        <div className="md:hidden bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs font-bold text-amber-700 text-center shrink-0">
          🖥️ 此編輯器為桌面工具，建議使用電腦操作
        </div>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50 shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold text-slate-900">欄位定位編輯器</h2>
            <span className="text-sm text-slate-500">
              {docType} v{docVersion} · 第 {currentPage}/{numPages || '?'} 頁
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPreviewMode(!previewMode)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${
                previewMode ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              <Eye className="w-4 h-4" />
              {previewMode ? '預覽中' : '預覽'}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition-all disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              {saving ? '儲存中...' : '儲存'}
            </button>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 transition-colors">
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: PDF area */}
          <div className="flex-1 overflow-auto bg-slate-200 p-4 flex flex-col items-center">
            {/* Page nav */}
            <div className="flex items-center gap-3 mb-3 shrink-0">
              <button
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
                className="p-1.5 rounded-lg bg-white shadow-sm hover:bg-slate-50 disabled:opacity-30"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="text-sm font-bold text-slate-700">
                {currentPage} / {numPages || '?'}
              </span>
              <button
                onClick={() => setCurrentPage(p => Math.min(numPages || p, p + 1))}
                disabled={currentPage >= (numPages || 1)}
                className="p-1.5 rounded-lg bg-white shadow-sm hover:bg-slate-50 disabled:opacity-30"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>

            {/* PDF + overlays */}
            <div
              ref={containerRef}
              className="relative bg-white shadow-xl"
              style={{ width: '100%', maxWidth: 700 }}
            >
              <Document file={pdfUrl} onLoadSuccess={onDocumentLoadSuccess}>
                <Page
                  pageNumber={currentPage}
                  width={containerWidth}
                  onLoadSuccess={onPageLoadSuccess}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              </Document>

              {/* Field overlays */}
              {pageFields.map(f => {
                const def = getFieldDef(f.fieldType);
                if (!def) return null;
                const FieldIcon = def.icon;
                const pxX = f.x * scale;
                const pxY = f.yFromTop * scale;
                const pxW = f.width * scale;
                const pxH = f.height * scale;

                if (previewMode) {
                  if (IMAGE_FIELDS.has(f.fieldType)) {
                    return (
                      <div
                        key={f.id}
                        className="absolute pointer-events-none border border-dashed flex items-center justify-center"
                        style={{
                          left: pxX, top: pxY, width: pxW, height: pxH,
                          borderColor: def.color, backgroundColor: `${def.color}10`,
                        }}
                      >
                        <span className="text-[10px] font-bold" style={{ color: def.color }}>
                          {sampleData[f.fieldType]}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={f.id}
                      className="absolute pointer-events-none"
                      style={{
                        left: pxX,
                        top: pxY,
                        width: pxW,
                        height: pxH,
                      }}
                    >
                      <span
                        className="block truncate font-medium"
                        style={{ fontSize: (f.fontSize || 13) * scale, color: '#000', lineHeight: 1.3 }}
                      >
                        {sampleData[f.fieldType] || f.fieldType}
                      </span>
                    </div>
                  );
                }

                return (
                  <Rnd
                    key={f.id}
                    position={{ x: pxX, y: pxY }}
                    size={{ width: pxW, height: pxH }}
                    onDragStop={(e, d) => updateFieldPosition(f.id, d.x, d.y)}
                    onResizeStop={(e, dir, ref, delta, pos) => {
                      updateFieldSize(f.id, parseFloat(ref.style.width), parseFloat(ref.style.height));
                      updateFieldPosition(f.id, pos.x, pos.y);
                    }}
                    bounds="parent"
                    minWidth={40}
                    minHeight={18}
                    style={{
                      border: `2px solid ${def.color}`,
                      backgroundColor: `${def.color}22`,
                      borderRadius: 4,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'move',
                      zIndex: 10,
                    }}
                  >
                    <div className="flex items-center gap-1 select-none pointer-events-none px-1">
                      <FieldIcon className="w-3 h-3 shrink-0" style={{ color: def.color }} />
                      <span className="text-xs font-bold truncate" style={{ color: def.color }}>
                        {def.label}
                      </span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); removeField(f.id); }}
                      className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors pointer-events-auto z-20"
                      style={{ fontSize: 10 }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Rnd>
                );
              })}
            </div>
          </div>

          {/* Right: field panel */}
          <div className="w-64 border-l border-slate-200 bg-white flex flex-col shrink-0 overflow-y-auto">
            <div className="p-4 border-b border-slate-100">
              <h3 className="text-sm font-bold text-slate-900 mb-1">可用欄位</h3>
              <p className="text-xs text-slate-400">點擊下方按鈕新增欄位到當前頁面，然後拖拉定位</p>
            </div>
            <div className="p-3 space-y-3">
              {['合約', '匯款表單', '圖片'].map(group => {
                const groupFields = FIELD_DEFS.filter(d => d.group === group);
                if (groupFields.length === 0) return null;
                return (
                  <div key={group}>
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 px-1">
                      {group}
                    </h4>
                    <div className="space-y-1.5">
                      {groupFields.map(def => {
                        const FieldIcon = def.icon;
                        return (
                          <button
                            key={def.type}
                            onClick={() => addField(def.type)}
                            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-all text-left"
                          >
                            <div
                              className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                              style={{ backgroundColor: `${def.color}15` }}
                            >
                              <FieldIcon className="w-3.5 h-3.5" style={{ color: def.color }} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-bold text-slate-800 truncate">{def.label}</div>
                              <div className="text-[10px] text-slate-400 truncate">{def.type}</div>
                            </div>
                            <Plus className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Fields on current page */}
            <div className="p-3 border-t border-slate-100">
              <h4 className="text-xs font-bold text-slate-500 mb-2 uppercase tracking-wider">
                本頁欄位 ({pageFields.length})
              </h4>
              {pageFields.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-4">尚無欄位，請從上方新增</p>
              ) : (
                <div className="space-y-1.5">
                  {pageFields.map(f => {
                    const def = getFieldDef(f.fieldType);
                    if (!def) return null;
                    return (
                      <div key={f.id} className="flex items-center justify-between px-2 py-1.5 bg-slate-50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: def.color }} />
                          <span className="text-xs font-bold text-slate-700">{def.label}</span>
                        </div>
                        <button
                          onClick={() => removeField(f.id)}
                          className="p-1 rounded hover:bg-red-50 text-slate-400 hover:text-red-500 transition-colors"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* All pages summary */}
            <div className="p-3 border-t border-slate-100 mt-auto">
              <h4 className="text-xs font-bold text-slate-500 mb-2 uppercase tracking-wider">
                所有頁面摘要
              </h4>
              {Array.from({ length: numPages || 0 }, (_, i) => i + 1).map(pg => {
                const pgFields = fields.filter(f => f.page === pg);
                return (
                  <button
                    key={pg}
                    onClick={() => setCurrentPage(pg)}
                    className={`w-full flex items-center justify-between px-2 py-1.5 rounded-lg text-xs transition-all mb-1 ${
                      pg === currentPage ? 'bg-blue-50 text-blue-700 font-bold' : 'text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    <span>第 {pg} 頁</span>
                    <span className="font-bold">{pgFields.length} 個欄位</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FieldPositionEditor;
