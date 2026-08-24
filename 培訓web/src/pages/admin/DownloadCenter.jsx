import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import JSZip from 'jszip';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import {
  Download, FileText, Search, CheckCircle2, AlertCircle,
  Loader2, Users, FileWarning, ChevronDown, Filter, ArrowLeft, Settings,
  Plus, Upload, Trash2, PenTool, X
} from 'lucide-react';
import { generateFilledForm, loadFormTemplate } from '../../lib/formGenerator';
import FieldPositionEditor from '../../components/FieldPositionEditor';
import { getInstructorProfileCompletion, isInstructorProfileComplete } from '../../lib/profileCompletion';

const missingItems = (inst) => getInstructorProfileCompletion(inst).missingItems;
const isComplete = isInstructorProfileComplete;

const DownloadCenter = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [instructors, setInstructors] = useState([]);
  const [forms, setForms] = useState([]); // contract_documents WHERE doc_category='form' (active only, for 下載選單)
  const [formTypes, setFormTypes] = useState([]); // 全部 form 類型（含未上傳/停用版本），供管理面板
  const [formDocs, setFormDocs] = useState({}); // doc_type -> 目前啟用版本
  const [selectedForm, setSelectedForm] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all'); // all | complete | incomplete
  const [expandedIds, setExpandedIds] = useState(new Set()); // 展開完整缺項清單的講師
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [errors, setErrors] = useState([]);

  // ── 表單模板管理（獨立於合約：這裡新增的文件一律 doc_category='form'）──
  const [showManager, setShowManager] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSlug, setNewSlug] = useState('');
  const [uploading, setUploading] = useState({});
  const fileRefs = useRef({});
  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  const [fieldEditorTarget, setFieldEditorTarget] = useState(null);
  const [fieldEditorUrl, setFieldEditorUrl] = useState(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: instData } = await supabase
        .from('instructors')
        .select('*')
        .order('full_name');
      setInstructors(instData || []);

      // 抓「全部」form 類型的所有版本（含未上傳 placeholder、停用舊版），一次供下載選單＋管理面板
      const { data: formDocsData } = await supabase
        .from('contract_documents')
        .select('*')
        .eq('doc_category', 'form')
        .order('sort_order')
        .order('version', { ascending: false });

      const typeMap = {};
      const activeMap = {};
      (formDocsData || []).forEach(d => {
        if (!typeMap[d.doc_type]) {
          typeMap[d.doc_type] = {
            doc_type: d.doc_type,
            display_name: d.display_name || d.doc_type,
            sort_order: d.sort_order ?? 0,
          };
        }
        if (!activeMap[d.doc_type] && d.is_active) activeMap[d.doc_type] = d;
      });
      setFormTypes(Object.values(typeMap).sort((a, b) => a.sort_order - b.sort_order));
      setFormDocs(activeMap);

      const activeForms = Object.values(activeMap)
        .sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
      setForms(activeForms);
      setSelectedForm((current) => (
        activeForms.some((form) => form.doc_type === current)
          ? current
          : activeForms[0]?.doc_type || null
      ));
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── 新增表單類型（doc_category 一律 form；doc_mode 一律 fill_sign 以便定位欄位）──
  const handleAddForm = async () => {
    const name = newName.trim();
    const slug = newSlug.trim() || name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (!name) { alert('請輸入文件名稱'); return; }
    if (formTypes.find(d => d.doc_type === slug)) { alert('此識別碼已存在'); return; }

    const maxOrder = formTypes.reduce((m, d) => Math.max(m, d.sort_order || 0), 0);
    const { error } = await supabase.from('contract_documents').insert({
      doc_type: slug,
      version: 0,
      file_path: `templates/${slug}/placeholder`,
      file_name: '',
      uploaded_by: user.id,
      is_active: false,
      display_name: name,
      doc_mode: 'fill_sign',
      doc_category: 'form',
      sort_order: maxOrder + 1,
    });
    if (error) { alert('新增失敗：' + error.message); return; }
    setShowAddForm(false);
    setNewName('');
    setNewSlug('');
    await loadData();
  };

  const handleDeleteForm = async (docType) => {
    if (!window.confirm(`確定要刪除表單「${docType}」嗎？所有版本與欄位定位都會被移除。`)) return;
    await supabase.from('contract_field_positions').delete().eq('doc_type', docType);
    await supabase.from('contract_documents').delete().eq('doc_type', docType);
    await loadData();
  };

  // 上傳表單 PDF：新版本啟用、舊版停用。表單是後台下載用，不發講師通知。
  const handleUploadForm = async (docType, displayName) => {
    const file = fileRefs.current[docType]?.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { alert('請上傳 PDF 格式的文件'); return; }

    setUploading(p => ({ ...p, [docType]: true }));
    try {
      const currentDoc = formDocs[docType];
      const newVersion = currentDoc ? currentDoc.version + 1 : 1;
      const filePath = `templates/${docType}/v${newVersion}_${Date.now()}.pdf`;

      const { error: uploadErr } = await supabase.storage
        .from('contract-documents')
        .upload(filePath, file, { contentType: 'application/pdf' });
      if (uploadErr) throw uploadErr;

      if (currentDoc) {
        await supabase.from('contract_documents')
          .update({ is_active: false })
          .eq('id', currentDoc.id);
      }

      const dt = formTypes.find(d => d.doc_type === docType);
      const { error: insertErr } = await supabase.from('contract_documents').insert({
        doc_type: docType,
        version: newVersion,
        file_path: filePath,
        file_name: file.name,
        uploaded_by: user.id,
        is_active: true,
        display_name: dt?.display_name || displayName,
        doc_mode: 'fill_sign',
        doc_category: 'form',
        sort_order: dt?.sort_order ?? 0,
      });
      if (insertErr) throw insertErr;

      if (fileRefs.current[docType]) fileRefs.current[docType].value = '';
      await loadData();
      alert('上傳成功！');
    } catch (err) {
      alert('上傳失敗：' + (err.message || '未知錯誤'));
    }
    setUploading(p => ({ ...p, [docType]: false }));
  };

  const openFieldEditorForm = async (docType) => {
    const doc = formDocs[docType];
    if (!doc) { alert('請先上傳此表單的 PDF'); return; }
    const { data } = await supabase.storage
      .from('contract-documents')
      .createSignedUrl(doc.file_path, 3600);
    if (!data?.signedUrl) { alert('無法取得文件連結'); return; }
    setFieldEditorTarget({ docType: doc.doc_type, docVersion: doc.version });
    setFieldEditorUrl(data.signedUrl);
    setFieldEditorOpen(true);
  };

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return instructors.filter(inst => {
      if (term) {
        const hay = [
          inst.full_name, inst.nickname, inst.email_primary,
          inst.phone_mobile, inst.id_number,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(term)) return false;
      }
      if (filterStatus === 'complete' && !isComplete(inst)) return false;
      if (filterStatus === 'incomplete' && isComplete(inst)) return false;
      return true;
    });
  }, [instructors, searchTerm, filterStatus]);

  const toggleOne = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const allIds = filtered.map(i => i.id);
    const allSelected = allIds.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) allIds.forEach(id => next.delete(id));
      else allIds.forEach(id => next.add(id));
      return next;
    });
  };

  const toggleExpand = (id) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const downloadSingle = async (inst) => {
    if (!selectedForm) { alert('請先選擇要下載的表單'); return; }
    setGenerating(true);
    setErrors([]);
    try {
      const { docMeta, positions } = await loadFormTemplate(selectedForm);
      const bytes = await generateFilledForm({ docMeta, positions, instructor: inst });
      const safe = (inst.full_name || 'unknown').replace(/[/\\?%*:|"<>]/g, '_');
      const filename = `${safe}-${docMeta.display_name || selectedForm}.pdf`;

      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);

      await supabase.from('instructor_form_downloads').insert({
        downloaded_by: user.id,
        target_user_id: inst.user_id,
        target_instructor_id: inst.id,
        doc_type: docMeta.doc_type,
        doc_version: docMeta.version,
      });
    } catch (e) {
      alert('產生失敗：' + e.message);
    }
    setGenerating(false);
  };

  const downloadBatch = async () => {
    if (!selectedForm) { alert('請先選擇要下載的表單'); return; }
    const targets = filtered.filter(i => selectedIds.has(i.id));
    if (!targets.length) { alert('請至少勾選一位講師'); return; }

    setGenerating(true);
    setErrors([]);
    setProgress({ done: 0, total: targets.length, current: '' });

    try {
      const { docMeta, positions } = await loadFormTemplate(selectedForm);
      const zip = new JSZip();
      const logs = [];
      const errs = [];

      for (let i = 0; i < targets.length; i++) {
        const inst = targets[i];
        setProgress({ done: i, total: targets.length, current: inst.full_name || '' });
        try {
          const bytes = await generateFilledForm({ docMeta, positions, instructor: inst });
          const safe = (inst.full_name || `unknown_${i}`).replace(/[/\\?%*:|"<>]/g, '_');
          zip.file(`${safe}-${docMeta.display_name || selectedForm}.pdf`, bytes);
          logs.push({
            downloaded_by: user.id,
            target_user_id: inst.user_id,
            target_instructor_id: inst.id,
            doc_type: docMeta.doc_type,
            doc_version: docMeta.version,
          });
        } catch (e) {
          errs.push(`${inst.full_name}：${e.message}`);
        }
      }

      setProgress({ done: targets.length, total: targets.length, current: '打包中...' });
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${docMeta.display_name || selectedForm}-${targets.length}份-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);

      if (logs.length) {
        await supabase.from('instructor_form_downloads').insert(logs);
      }
      setErrors(errs);
    } catch (e) {
      alert('批次下載失敗：' + e.message);
    }

    setGenerating(false);
    setProgress({ done: 0, total: 0, current: '' });
  };

  if (loading) {
    return (
      <div className="p-12 flex items-center justify-center text-bauhaus-black/60 font-bold">
        <Loader2 className="w-6 h-6 animate-spin mr-2" /> 載入中...
      </div>
    );
  }

  const selectedFormMeta = forms.find(f => f.doc_type === selectedForm);
  const allVisibleSelected = filtered.length > 0 && filtered.every(i => selectedIds.has(i.id));

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <Link to="/admin" className="text-sm text-bauhaus-black/60 hover:text-bauhaus-black flex items-center gap-1 mb-3 min-h-[44px]">
          <ArrowLeft className="w-4 h-4" /> 返回後台首頁
        </Link>
        <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight flex items-center gap-2">
          <Download className="w-7 h-7 text-bauhaus-blue" /> 講師表單下載中心
        </h1>
        <p className="text-bauhaus-black/60 font-medium mt-1 text-sm">
          選擇要下載的表單與講師後，系統會把講師資料自動套入模板並下載 PDF。
        </p>
      </div>

      {/* ── 表單選擇 ── */}
      <div className="bh-card p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-black text-bauhaus-black flex items-center gap-2">
            <FileText className="w-4 h-4 text-bauhaus-blue" /> 選擇表單模板
          </h2>
          <button
            onClick={() => setShowManager(v => !v)}
            className="text-xs text-bauhaus-blue hover:underline flex items-center gap-1 min-h-[44px]"
          >
            <Settings className="w-3 h-3" /> {showManager ? '收合管理' : '管理表單模板'}
          </button>
        </div>

        {forms.length === 0 ? (
          <div className="bg-bauhaus-yellow/20 rounded-xl border-2 border-bauhaus-black p-4 text-sm text-bauhaus-black flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              尚未設定任何表單模板。請點右上角
              <strong className="mx-1">「管理表單模板」</strong>新增表單、上傳 PDF，再用欄位定位編輯器設定要填入的欄位位置。
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {forms.map(f => (
              <button
                key={f.doc_type}
                onClick={() => setSelectedForm(f.doc_type)}
                className={`px-4 py-2 text-sm font-bold transition-all rounded-xl border-2 border-bauhaus-black ${
                  selectedForm === f.doc_type
                    ? 'bg-bauhaus-black text-white'
                    : 'bg-white text-bauhaus-black hover:bg-bauhaus-cream'
                }`}
              >
                {f.display_name || f.doc_type}
                <span className="ml-1 text-xs opacity-70">v{f.version}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 表單模板管理（獨立於合約） ── */}
      {showManager && (
        <div className="bh-card p-5 mb-5 border-bauhaus-blue">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-sm font-black text-bauhaus-black flex items-center gap-2">
                <Settings className="w-4 h-4 text-bauhaus-blue" /> 表單模板管理
              </h2>
              <p className="text-xs text-bauhaus-black/50 mt-0.5">
                這裡新增的文件只會出現在表單下載中心，不會進入講師簽約流程。
              </p>
            </div>
            <button onClick={() => setShowAddForm(true)} className="bh-btn bh-btn-blue px-4 py-2 text-sm min-h-[44px]">
              <Plus className="w-4 h-4" /> 新增表單
            </button>
          </div>

          {/* 新增表單 modal */}
          {showAddForm && (
            <div className="mb-4 bg-bauhaus-cream rounded-2xl border-2 lg:border-4 border-bauhaus-black p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-bauhaus-black">新增表單模板</h3>
                <button onClick={() => { setShowAddForm(false); setNewName(''); setNewSlug(''); }} className="p-1 text-bauhaus-black/50 hover:text-bauhaus-black">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="bh-label mb-1 block">文件名稱 *</label>
                  <input
                    type="text" value={newName} onChange={e => setNewName(e.target.value)}
                    placeholder="例如：勞報單、鐘點費印領清冊"
                    className="bh-input text-sm"
                  />
                </div>
                <div>
                  <label className="bh-label mb-1 block">識別碼（英文/數字，可留空自動產生）</label>
                  <input
                    type="text" value={newSlug}
                    onChange={e => setNewSlug(e.target.value.replace(/[^a-z0-9_]/gi, '').toLowerCase())}
                    placeholder="自動產生"
                    className="bh-input text-sm font-mono"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={handleAddForm} className="bh-btn bh-btn-blue px-4 py-2 text-sm">確認新增</button>
                <button onClick={() => { setShowAddForm(false); setNewName(''); setNewSlug(''); }} className="bh-btn bh-btn-outline px-4 py-2 text-sm">取消</button>
              </div>
            </div>
          )}

          {/* 表單卡片列表 */}
          <div className="space-y-3">
            {formTypes.map(dt => {
              const doc = formDocs[dt.doc_type];
              return (
                <div key={dt.doc_type} className="rounded-2xl border-2 border-bauhaus-black/20 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-lg border-2 border-bauhaus-black flex items-center justify-center shrink-0 bg-bauhaus-blue text-white">
                      <FileText className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-bold text-bauhaus-black text-sm truncate">{dt.display_name}</h3>
                      {doc ? (
                        <p className="text-xs text-bauhaus-black/50 truncate">v{doc.version} · {doc.file_name}</p>
                      ) : (
                        <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black mt-0.5">尚未上傳 PDF</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      ref={el => fileRefs.current[dt.doc_type] = el}
                      type="file" accept="application/pdf" className="hidden"
                      onChange={() => handleUploadForm(dt.doc_type, dt.display_name)}
                    />
                    <button
                      onClick={() => fileRefs.current[dt.doc_type]?.click()}
                      disabled={uploading[dt.doc_type]}
                      className="bh-btn bh-btn-outline text-xs px-3 py-2"
                    >
                      {uploading[dt.doc_type] ? (
                        <><Loader2 className="w-3 h-3 animate-spin" /> 上傳中...</>
                      ) : (
                        <><Upload className="w-3.5 h-3.5" /> {doc ? '更新版本' : '上傳 PDF'}</>
                      )}
                    </button>
                    <button
                      onClick={() => openFieldEditorForm(dt.doc_type)}
                      disabled={!doc}
                      className="bh-btn bh-btn-blue text-xs px-3 py-2 disabled:opacity-40"
                      title={doc ? '設定要填入 PDF 的欄位位置' : '請先上傳 PDF'}
                    >
                      <PenTool className="w-3.5 h-3.5" /> 定位欄位
                    </button>
                    <button
                      onClick={() => handleDeleteForm(dt.doc_type)}
                      className="p-2 text-bauhaus-black/40 hover:text-bauhaus-red hover:bg-bauhaus-red/10 transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
            {formTypes.length === 0 && (
              <div className="text-center py-8 text-bauhaus-black/50 text-sm">
                尚無表單模板，請點「新增表單」開始設定。
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── 工具列 ── */}
      <div className="bh-card p-4 mb-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-bauhaus-black/40 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            placeholder="搜尋姓名、暱稱、email、電話、身分證..."
            className="bh-input w-full pl-9 pr-3 py-2 text-sm"
          />
        </div>
        <div className="relative">
          <Filter className="w-4 h-4 text-bauhaus-black/40 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <select
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
            className="bh-input pl-9 pr-8 py-2 text-sm appearance-none cursor-pointer"
          >
            <option value="all">全部講師</option>
            <option value="complete">資料齊全</option>
            <option value="incomplete">資料未完整</option>
          </select>
          <ChevronDown className="w-3 h-3 text-bauhaus-black/40 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        </div>
        <button
          onClick={toggleAllVisible}
          className="bh-btn bh-btn-outline px-3 py-2 text-sm min-h-[44px]"
        >
          {allVisibleSelected ? '取消全選' : '全選此頁'}
        </button>
        <button
          onClick={downloadBatch}
          disabled={generating || !selectedForm || selectedIds.size === 0}
          className="bh-btn bh-btn-blue ml-auto px-5 py-2 text-sm min-h-[44px]"
        >
          {generating ? (
            <><Loader2 className="w-4 h-4 animate-spin" /> 產生中... ({progress.done}/{progress.total})</>
          ) : (
            <><Download className="w-4 h-4" /> 批次下載 {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}</>
          )}
        </button>
      </div>

      {generating && progress.current && (
        <div className="bg-bauhaus-blue/10 rounded-2xl border-2 border-bauhaus-blue p-3 mb-3 text-sm text-bauhaus-blue flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          正在處理：<strong>{progress.current}</strong>
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-bauhaus-red/10 rounded-2xl border-2 border-bauhaus-red p-3 mb-3 text-sm text-bauhaus-red">
          <div className="font-bold flex items-center gap-1 mb-1">
            <FileWarning className="w-4 h-4" /> 部分失敗（{errors.length} 筆）
          </div>
          <ul className="text-xs space-y-0.5 ml-5 list-disc">
            {errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        </div>
      )}

      {/* ── 講師列表 ── */}
      <div className="bh-card overflow-hidden">
        <div className="px-4 py-3 border-b-2 border-bauhaus-black bg-bauhaus-black text-white text-xs uppercase tracking-wider flex items-center gap-2 flex-wrap">
          <Users className="w-4 h-4" />
          <span>顯示 {filtered.length} / {instructors.length} 位講師</span>
          {filtered.length > 0 && (
            <span className="text-white/60 normal-case tracking-normal">
              · 資料齊全 {filtered.filter(isComplete).length} 位
            </span>
          )}
        </div>

        {filtered.length === 0 ? (
          <div className="p-12 text-center text-bauhaus-black/50">沒有符合條件的講師</div>
        ) : (
          <div className="divide-y-2 divide-bauhaus-black/20">
            {filtered.map(inst => {
              const checked = selectedIds.has(inst.id);
              const missing = missingItems(inst);
              const complete = missing.length === 0;
              const pct = getInstructorProfileCompletion(inst).percent;
              const expanded = expandedIds.has(inst.id);
              const barColor = pct >= 80 ? 'bg-bauhaus-blue' : pct >= 40 ? 'bg-bauhaus-yellow' : 'bg-bauhaus-red';
              const pctColor = pct >= 80 ? 'text-bauhaus-blue' : pct >= 40 ? 'text-bauhaus-black' : 'text-bauhaus-red';
              const MAX_CHIPS = 6;
              const shown = expanded ? missing : missing.slice(0, MAX_CHIPS);
              return (
                <div
                  key={inst.id}
                  className={`px-4 py-3.5 flex items-start gap-3 transition-colors ${checked ? 'bg-bauhaus-cream' : 'hover:bg-bauhaus-cream'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(inst.id)}
                    className="w-5 h-5 accent-bauhaus-blue mt-0.5 shrink-0"
                  />

                  {/* 講師資訊 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-bauhaus-black text-sm">{inst.full_name || '(未填姓名)'}</span>
                      {inst.nickname && (
                        <span className="text-xs text-bauhaus-black/50">@{inst.nickname}</span>
                      )}
                      {inst.instructor_role && (
                        <span className="bh-chip bg-bauhaus-muted text-bauhaus-black text-[10px] px-1.5 py-0.5">
                          {inst.instructor_role}級
                        </span>
                      )}
                      <span className={`bh-chip text-[10px] px-1.5 py-0.5 ${inst.user_id ? 'bg-bauhaus-blue text-white' : 'bg-bauhaus-muted text-bauhaus-black'}`}>
                        {inst.user_id ? '已認領' : '未認領'}
                      </span>
                    </div>
                    <div className="text-xs text-bauhaus-black/60 mt-0.5 truncate">
                      {inst.email_primary || '—'} · {inst.phone_mobile || '—'}
                    </div>

                    {/* 還缺什麼資料 */}
                    {!complete && (
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-bold text-bauhaus-black/45">
                          還缺 {missing.length} 項
                        </span>
                        {shown.map(m => (
                          <span
                            key={m}
                            className="inline-flex items-center rounded-md bg-bauhaus-red/10 text-bauhaus-red text-[11px] font-bold px-1.5 py-0.5"
                          >
                            {m}
                          </span>
                        ))}
                        {missing.length > MAX_CHIPS && (
                          <button
                            onClick={() => toggleExpand(inst.id)}
                            className="text-[11px] font-bold text-bauhaus-blue hover:underline px-1 min-h-[24px]"
                          >
                            {expanded ? '收合' : `＋ 還有 ${missing.length - MAX_CHIPS} 項`}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 完成度 + 下載 */}
                  <div className="flex flex-col items-end gap-2 shrink-0 w-24 sm:w-28">
                    {complete ? (
                      <span className="bh-chip bg-bauhaus-blue text-white text-[10px] px-2 py-1">
                        <CheckCircle2 className="w-3 h-3" /> 齊全
                      </span>
                    ) : (
                      <div className="w-full">
                        <div className="flex items-center justify-end mb-1">
                          <span className={`text-xs font-black ${pctColor}`}>{pct}%</span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-bauhaus-black/10 overflow-hidden border border-bauhaus-black/15">
                          <div className={`h-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    )}
                    <button
                      onClick={() => downloadSingle(inst)}
                      disabled={generating || !selectedForm}
                      className="bh-btn bh-btn-outline text-xs px-3 py-1.5 w-full justify-center"
                      title={selectedFormMeta ? `下載「${selectedFormMeta.display_name}」` : ''}
                    >
                      <Download className="w-3 h-3" /> 下載
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 欄位定位編輯器 */}
      {fieldEditorOpen && fieldEditorTarget && (
        <FieldPositionEditor
          isOpen={fieldEditorOpen}
          onClose={() => { setFieldEditorOpen(false); setFieldEditorTarget(null); setFieldEditorUrl(null); }}
          docType={fieldEditorTarget.docType}
          docVersion={fieldEditorTarget.docVersion}
          pdfUrl={fieldEditorUrl}
        />
      )}
    </div>
  );
};

export default DownloadCenter;
