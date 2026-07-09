import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import JSZip from 'jszip';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import {
  Download, FileText, Search, CheckCircle2, AlertCircle,
  Loader2, Users, FileWarning, ChevronDown, Filter, ArrowLeft, Settings
} from 'lucide-react';
import { generateFilledForm, loadFormTemplate } from '../../lib/formGenerator';

// 必填欄位（與 ProfilePage 同步，但這邊只做完整度判斷不擋人）
const REQUIRED_KEYS = [
  'full_name', 'nickname', 'gender', 'birth_date', 'id_number',
  'phone_mobile', 'line_id', 'address', 'email_primary',
  'instructor_role', 'teaching_freq_semester', 'teaching_freq_vacation',
  'bio_notes',
  'bank_account_name', 'bank_name', 'bank_branch',
  'bank_account_number', 'bank_code',
];
const REQUIRED_PATHS = ['photo_path', 'id_front_path', 'id_back_path', 'bankbook_path'];

const isComplete = (inst) => {
  if (!inst) return false;
  if (!inst.teaching_regions?.length) return false;
  for (const k of REQUIRED_KEYS) {
    const v = inst[k];
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return false;
  }
  for (const p of REQUIRED_PATHS) {
    if (!inst[p]) return false;
  }
  return true;
};

const completionPercent = (inst) => {
  if (!inst) return 0;
  const total = REQUIRED_KEYS.length + REQUIRED_PATHS.length + 1; // +1 for regions
  let filled = 0;
  for (const k of REQUIRED_KEYS) {
    const v = inst[k];
    if (v !== null && v !== undefined && (typeof v !== 'string' || v.trim())) filled++;
  }
  for (const p of REQUIRED_PATHS) {
    if (inst[p]) filled++;
  }
  if (inst.teaching_regions?.length) filled++;
  return Math.round((filled / total) * 100);
};

const DownloadCenter = () => {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [instructors, setInstructors] = useState([]);
  const [forms, setForms] = useState([]); // contract_documents WHERE doc_category='form'
  const [selectedForm, setSelectedForm] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('all'); // all | complete | incomplete
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' });
  const [errors, setErrors] = useState([]);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: instData } = await supabase
        .from('instructors')
        .select('*')
        .not('user_id', 'is', null)
        .order('full_name');
      setInstructors(instData || []);

      const { data: formsData } = await supabase
        .from('contract_documents')
        .select('*')
        .eq('doc_category', 'form')
        .eq('is_active', true)
        .order('display_name');
      setForms(formsData || []);
      if (formsData?.length && !selectedForm) {
        setSelectedForm(formsData[0].doc_type);
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
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
    const allIds = filtered.map(i => i.user_id);
    const allSelected = allIds.every(id => selectedIds.has(id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allSelected) allIds.forEach(id => next.delete(id));
      else allIds.forEach(id => next.add(id));
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
    const targets = filtered.filter(i => selectedIds.has(i.user_id));
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
  const allVisibleSelected = filtered.length > 0 && filtered.every(i => selectedIds.has(i.user_id));

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
          <Link to="/admin/contracts" className="text-xs text-bauhaus-blue hover:underline flex items-center gap-1 min-h-[44px]">
            <Settings className="w-3 h-3" /> 管理模板
          </Link>
        </div>

        {forms.length === 0 ? (
          <div className="bg-bauhaus-yellow/20 border-2 border-bauhaus-black p-4 text-sm text-bauhaus-black flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              尚未設定任何「表單」類型的模板。請至「合約管理」上傳 PDF 模板，並把
              <strong className="mx-1">doc_category 設為 form</strong>，然後用欄位定位編輯器設定要填入的欄位位置。
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {forms.map(f => (
              <button
                key={f.doc_type}
                onClick={() => setSelectedForm(f.doc_type)}
                className={`px-4 py-2 text-sm font-bold transition-all border-2 border-bauhaus-black ${
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
        <div className="bg-bauhaus-blue/10 border-2 border-bauhaus-blue p-3 mb-3 text-sm text-bauhaus-blue flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" />
          正在處理：<strong>{progress.current}</strong>
        </div>
      )}

      {errors.length > 0 && (
        <div className="bg-bauhaus-red/10 border-2 border-bauhaus-red p-3 mb-3 text-sm text-bauhaus-red">
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
        <div className="px-4 py-3 border-b-2 border-bauhaus-black bg-bauhaus-black text-white text-xs uppercase tracking-wider flex items-center gap-2">
          <Users className="w-4 h-4" />
          顯示 {filtered.length} / {instructors.length} 位講師
        </div>

        {filtered.length === 0 ? (
          <div className="p-12 text-center text-bauhaus-black/50">沒有符合條件的講師</div>
        ) : (
          <div className="divide-y-2 divide-bauhaus-black/20">
            {filtered.map(inst => {
              const checked = selectedIds.has(inst.user_id);
              const complete = isComplete(inst);
              const pct = completionPercent(inst);
              return (
                <div
                  key={inst.user_id}
                  className={`px-4 py-3 flex items-center gap-3 transition-colors ${checked ? 'bg-bauhaus-cream' : 'hover:bg-bauhaus-cream'}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(inst.user_id)}
                    className="w-5 h-5 accent-bauhaus-blue"
                  />
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
                      {complete ? (
                        <span className="bh-chip bg-bauhaus-blue text-white text-[10px] px-1.5 py-0.5">
                          <CheckCircle2 className="w-3 h-3" /> 齊全
                        </span>
                      ) : (
                        <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black text-[10px] px-1.5 py-0.5">
                          {pct}% 完成
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-bauhaus-black/60 mt-0.5 truncate">
                      {inst.email_primary || '—'} · {inst.phone_mobile || '—'}
                    </div>
                  </div>
                  <button
                    onClick={() => downloadSingle(inst)}
                    disabled={generating || !selectedForm}
                    className="bh-btn bh-btn-outline text-xs px-3 py-1.5"
                    title={selectedFormMeta ? `下載「${selectedFormMeta.display_name}」` : ''}
                  >
                    <Download className="w-3 h-3" /> 下載
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default DownloadCenter;
