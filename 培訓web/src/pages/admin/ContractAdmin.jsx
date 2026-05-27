import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabaseClient';
import { Link } from 'react-router-dom';
import FieldPositionEditor from '../../components/FieldPositionEditor';
import {
  Upload, FileText, CheckCircle2, XCircle, Eye, Plus,
  AlertTriangle, Clock, Users, Search, ChevronUp, ChevronDown,
  Trash2, Settings, GripVertical, PenTool, BookOpen
} from 'lucide-react';

const ContractAdmin = () => {
  const { user, profile } = useAuth();
  const [docTypes, setDocTypes] = useState([]);
  const [documents, setDocuments] = useState({});
  const [contracts, setContracts] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState({});
  const [searchTerm, setSearchTerm] = useState('');
  const [showAll, setShowAll] = useState(false);
  const fileRefs = useRef({});

  const [showAddDoc, setShowAddDoc] = useState(false);
  const [newDocName, setNewDocName] = useState('');
  const [newDocSlug, setNewDocSlug] = useState('');
  const [newDocMode, setNewDocMode] = useState('view_only');
  const [newDocCategory, setNewDocCategory] = useState('contract');

  const [fieldEditorOpen, setFieldEditorOpen] = useState(false);
  const [fieldEditorTarget, setFieldEditorTarget] = useState(null);
  const [fieldEditorUrl, setFieldEditorUrl] = useState(null);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const { data: docsData } = await supabase
        .from('contract_documents')
        .select('*')
        .order('sort_order')
        .order('version', { ascending: false });

      const typeMap = {};
      const activeMap = {};
      (docsData || []).forEach(d => {
        if (!typeMap[d.doc_type]) {
          typeMap[d.doc_type] = {
            doc_type: d.doc_type,
            display_name: d.display_name || d.doc_type,
            doc_mode: d.doc_mode || 'view_only',
            sort_order: d.sort_order ?? 0,
          };
        }
        if (!activeMap[d.doc_type] && d.is_active) activeMap[d.doc_type] = d;
      });

      const types = Object.values(typeMap).sort((a, b) => a.sort_order - b.sort_order);
      setDocTypes(types);
      setDocuments(activeMap);

      const { data: contractsData } = await supabase
        .from('instructor_contracts')
        .select('*')
        .order('signed_at', { ascending: false });
      setContracts(contractsData || []);

      const { data: usersData } = await supabase
        .from('users')
        .select('id, email, name, role')
        .neq('role', 'pending');

      const { data: instrData } = await supabase
        .from('instructors')
        .select('user_id, full_name');

      const instrMap = {};
      (instrData || []).forEach(i => { instrMap[i.user_id] = i.full_name; });

      const enriched = (usersData || []).map(u => ({
        ...u,
        fullName: instrMap[u.id] || u.name || u.email,
      }));
      setAllUsers(enriched);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const handleAddDocType = async () => {
    const name = newDocName.trim();
    const slug = newDocSlug.trim() || name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    if (!name) { alert('請輸入文件名稱'); return; }
    if (docTypes.find(d => d.doc_type === slug)) { alert('此識別碼已存在'); return; }

    const maxOrder = docTypes.reduce((m, d) => Math.max(m, d.sort_order || 0), 0);
    const placeholderRecord = {
      doc_type: slug,
      version: 0,
      file_path: `templates/${slug}/placeholder`,
      file_name: '',
      uploaded_by: user.id,
      is_active: false,
      display_name: name,
      doc_mode: newDocMode,
      doc_category: newDocCategory,
      sort_order: maxOrder + 1,
    };
    const { error } = await supabase.from('contract_documents').insert(placeholderRecord);
    if (error) { alert('新增失敗：' + error.message); return; }

    setShowAddDoc(false);
    setNewDocName('');
    setNewDocSlug('');
    setNewDocMode('view_only');
    setNewDocCategory('contract');
    await loadData();
  };

  const handleDeleteDocType = async (docType) => {
    if (!window.confirm(`確定要刪除文件類型「${docType}」嗎？所有相關版本都會被移除。`)) return;
    await supabase.from('contract_field_positions').delete().eq('doc_type', docType);
    await supabase.from('contract_documents').delete().eq('doc_type', docType);
    await loadData();
  };

  const handleMoveOrder = async (docType, direction) => {
    const idx = docTypes.findIndex(d => d.doc_type === docType);
    if (idx < 0) return;
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= docTypes.length) return;

    const current = docTypes[idx];
    const swap = docTypes[swapIdx];

    await supabase.from('contract_documents').update({ sort_order: swap.sort_order }).eq('doc_type', current.doc_type);
    await supabase.from('contract_documents').update({ sort_order: current.sort_order }).eq('doc_type', swap.doc_type);
    await loadData();
  };

  const handleUpload = async (docType, displayName) => {
    const file = fileRefs.current[docType]?.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') { alert('請上傳 PDF 格式的文件'); return; }
    if (!window.confirm(`確定要上傳新版「${displayName}」嗎？\n此操作將通知所有講師文件已更新。`)) return;

    setUploading(p => ({ ...p, [docType]: true }));
    try {
      const currentDoc = documents[docType];
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

      const dt = docTypes.find(d => d.doc_type === docType);
      const { error: insertErr } = await supabase.from('contract_documents').insert({
        doc_type: docType,
        version: newVersion,
        file_path: filePath,
        file_name: file.name,
        uploaded_by: user.id,
        is_active: true,
        display_name: dt?.display_name || displayName,
        doc_mode: dt?.doc_mode || 'view_only',
        sort_order: dt?.sort_order ?? 0,
      });
      if (insertErr) throw insertErr;

      const { data: nonPendingUsers } = await supabase
        .from('users')
        .select('id')
        .neq('role', 'pending');

      if (nonPendingUsers?.length) {
        const notifications = nonPendingUsers.map(u => ({
          user_id: u.id,
          type: 'contract',
          title: '合約文件已更新',
          body: `${displayName} 已更新為第 ${newVersion} 版，請前往查看`,
          link: '/contract',
          is_read: false,
        }));
        const batchSize = 500;
        for (let i = 0; i < notifications.length; i += batchSize) {
          await supabase.from('notifications').insert(notifications.slice(i, i + batchSize));
        }
      }

      fileRefs.current[docType].value = '';
      await loadData();
      alert('上傳成功！已通知所有講師。');
    } catch (err) {
      alert('上傳失敗：' + (err.message || '未知錯誤'));
    }
    setUploading(p => ({ ...p, [docType]: false }));
  };

  const openFieldEditor = async (docType) => {
    const doc = documents[docType];
    if (!doc) { alert('請先上傳此文件的 PDF'); return; }
    const { data } = await supabase.storage
      .from('contract-documents')
      .createSignedUrl(doc.file_path, 3600);
    if (!data?.signedUrl) { alert('無法取得文件連結'); return; }

    setFieldEditorTarget({ docType: doc.doc_type, docVersion: doc.version });
    setFieldEditorUrl(data.signedUrl);
    setFieldEditorOpen(true);
  };

  const getContractForUser = (userId) => {
    return contracts.find(c => c.user_id === userId && c.status === 'signed');
  };

  const filteredUsers = allUsers.filter(u => {
    if (!searchTerm) return true;
    const q = searchTerm.toLowerCase();
    return u.fullName?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q);
  });

  const signedCount = allUsers.filter(u => getContractForUser(u.id)).length;
  const unsignedCount = allUsers.length - signedCount;

  if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

  return (
    <div className="p-4 sm:p-8">
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900">合約文件管理</h1>
        <p className="text-slate-500 mt-1">管理合約文件、設定欄位位置與查看講師簽約狀態</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatCard icon={Users} label="總人數" value={allUsers.length} color="slate" />
        <StatCard icon={CheckCircle2} label="已簽約" value={signedCount} color="green" />
        <StatCard icon={Clock} label="未簽約" value={unsignedCount} color="amber" />
      </div>

      {/* Document management */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-600" />
            文件管理
          </h2>
          <button
            onClick={() => setShowAddDoc(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20"
          >
            <Plus className="w-4 h-4" /> 新增文件
          </button>
        </div>

        {/* Add doc modal */}
        {showAddDoc && (
          <div className="mb-4 bg-blue-50 border border-blue-200 rounded-2xl p-5">
            <h3 className="font-bold text-slate-900 mb-3">新增合約文件類型</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
              <div>
                <label className="text-xs font-bold text-slate-600 mb-1 block">文件名稱 *</label>
                <input
                  type="text" value={newDocName} onChange={e => setNewDocName(e.target.value)}
                  placeholder="例如：匯款申請書"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600 mb-1 block">識別碼（英文/數字）</label>
                <input
                  type="text" value={newDocSlug}
                  onChange={e => setNewDocSlug(e.target.value.replace(/[^a-z0-9_]/gi, '').toLowerCase())}
                  placeholder="自動產生"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none font-mono"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600 mb-1 block">文件分類</label>
                <select
                  value={newDocCategory} onChange={e => setNewDocCategory(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="contract">合約（講師簽署）</option>
                  <option value="form">行政表單（後台下載）</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-bold text-slate-600 mb-1 block">文件模式</label>
                <select
                  value={newDocMode} onChange={e => setNewDocMode(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="view_only">純閱讀（僅瀏覽）</option>
                  <option value="fill_sign">可填寫 & 簽名</option>
                </select>
              </div>
            </div>
            {newDocCategory === 'form' && (
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 mb-3 text-xs text-emerald-700">
                💡 行政表單會出現在「表單下載中心」，由管理員批次下載；不會進入講師簽約流程。
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={handleAddDocType} className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700">
                確認新增
              </button>
              <button onClick={() => { setShowAddDoc(false); setNewDocName(''); setNewDocSlug(''); }} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-xl text-sm font-bold hover:bg-slate-200">
                取消
              </button>
            </div>
          </div>
        )}

        {/* Doc cards */}
        <div className="space-y-3">
          {docTypes.map((dt, idx) => {
            const doc = documents[dt.doc_type];
            const isFillSign = dt.doc_mode === 'fill_sign';
            return (
              <div key={dt.doc_type} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  {/* Sort + info */}
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="flex flex-col gap-0.5 shrink-0">
                      <button onClick={() => handleMoveOrder(dt.doc_type, -1)} disabled={idx === 0}
                        className="p-0.5 rounded hover:bg-slate-100 disabled:opacity-20 transition-colors">
                        <ChevronUp className="w-4 h-4 text-slate-400" />
                      </button>
                      <button onClick={() => handleMoveOrder(dt.doc_type, 1)} disabled={idx === docTypes.length - 1}
                        className="p-0.5 rounded hover:bg-slate-100 disabled:opacity-20 transition-colors">
                        <ChevronDown className="w-4 h-4 text-slate-400" />
                      </button>
                    </div>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${isFillSign ? 'bg-indigo-50 text-indigo-600' : 'bg-blue-50 text-blue-600'}`}>
                      {isFillSign ? <PenTool className="w-5 h-5" /> : <BookOpen className="w-5 h-5" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-slate-900 text-sm truncate">{dt.display_name}</h3>
                        <span className={`text-xs px-2 py-0.5 rounded-full font-bold shrink-0 ${isFillSign ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-100 text-slate-500'}`}>
                          {isFillSign ? '可填寫' : '純閱讀'}
                        </span>
                      </div>
                      {doc ? (
                        <p className="text-xs text-slate-400 truncate">
                          v{doc.version} · {new Date(doc.uploaded_at).toLocaleDateString('zh-TW')} · {doc.file_name}
                        </p>
                      ) : (
                        <p className="text-xs text-amber-500">尚未上傳 PDF</p>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      ref={el => fileRefs.current[dt.doc_type] = el}
                      type="file" accept="application/pdf" className="hidden"
                      onChange={() => handleUpload(dt.doc_type, dt.display_name)}
                    />
                    <button
                      onClick={() => fileRefs.current[dt.doc_type]?.click()}
                      disabled={uploading[dt.doc_type]}
                      className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all ${
                        uploading[dt.doc_type]
                          ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {uploading[dt.doc_type] ? (
                        <><div className="animate-spin w-3 h-3 border-2 border-current border-t-transparent rounded-full" /> 上傳中...</>
                      ) : (
                        <><Upload className="w-3.5 h-3.5" /> {doc ? '更新版本' : '上傳 PDF'}</>
                      )}
                    </button>

                    {isFillSign && (
                      <button
                        onClick={() => openFieldEditor(dt.doc_type)}
                        className="flex items-center gap-1.5 px-3 py-2 bg-indigo-50 text-indigo-600 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all"
                      >
                        <Settings className="w-3.5 h-3.5" /> 定位欄位
                      </button>
                    )}

                    <button
                      onClick={() => handleDeleteDocType(dt.doc_type)}
                      className="p-2 rounded-xl text-slate-400 hover:text-red-500 hover:bg-red-50 transition-all"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}

          {docTypes.length === 0 && (
            <div className="text-center py-12 text-slate-400">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">尚無合約文件，請點擊「新增文件」開始設定</p>
            </div>
          )}
        </div>
      </div>

      {/* Contract status overview */}
      <div>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Users className="w-5 h-5 text-indigo-600" />
            簽約狀態總覽
          </h2>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
              placeholder="搜尋講師..."
              className="pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none w-full sm:w-64"
            />
          </div>
        </div>

        {/* Desktop table */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm hidden md:block">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 text-left text-xs font-bold text-slate-500 uppercase tracking-wider">
                <th className="px-5 py-3">講師</th>
                <th className="px-5 py-3">簽約狀態</th>
                <th className="px-5 py-3">簽約日期</th>
                <th className="px-5 py-3">文件版本</th>
                <th className="px-5 py-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(showAll ? filteredUsers : filteredUsers.slice(0, 20)).map(u => {
                const c = getContractForUser(u.id);
                const versions = c?.doc_versions && Object.keys(c.doc_versions).length > 0
                  ? Object.entries(c.doc_versions).map(([k, v]) => `${k}:v${v}`).join(', ')
                  : c ? `v${c.contract_doc_version || '?'}` : '-';
                return (
                  <tr key={u.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3">
                      <div className="font-bold text-sm text-slate-900">{u.fullName}</div>
                      <div className="text-xs text-slate-400">{u.email}</div>
                    </td>
                    <td className="px-5 py-3">
                      {c ? (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-green-600 bg-green-50 px-2.5 py-1 rounded-full">
                          <CheckCircle2 className="w-3 h-3" /> 已簽約
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-600 bg-amber-50 px-2.5 py-1 rounded-full">
                          <Clock className="w-3 h-3" /> 未簽約
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3 text-sm text-slate-600">
                      {c ? new Date(c.signed_at).toLocaleDateString('zh-TW') : '-'}
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-600 font-mono">{versions}</td>
                    <td className="px-5 py-3">
                      {c && (
                        <Link to={`/contract/view/${c.id}`} className="text-sm font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1">
                          <Eye className="w-4 h-4" /> 查看
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {filteredUsers.length > 20 && !showAll && (
            <div className="p-4 text-center border-t border-slate-100">
              <button onClick={() => setShowAll(true)} className="text-sm text-blue-600 font-bold hover:text-blue-700">
                顯示全部 ({filteredUsers.length} 人)
              </button>
            </div>
          )}
        </div>

        {/* Mobile cards */}
        <div className="md:hidden space-y-3">
          {(showAll ? filteredUsers : filteredUsers.slice(0, 20)).map(u => {
            const c = getContractForUser(u.id);
            return (
              <div key={u.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <div className="font-bold text-sm text-slate-900">{u.fullName}</div>
                    <div className="text-xs text-slate-400">{u.email}</div>
                  </div>
                  {c ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-green-600 bg-green-50 px-2 py-1 rounded-full shrink-0">
                      <CheckCircle2 className="w-3 h-3" /> 已簽約
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-600 bg-amber-50 px-2 py-1 rounded-full shrink-0">
                      <Clock className="w-3 h-3" /> 未簽約
                    </span>
                  )}
                </div>
                {c && (
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                    <span className="text-xs text-slate-400">
                      {new Date(c.signed_at).toLocaleDateString('zh-TW')}
                    </span>
                    <Link to={`/contract/view/${c.id}`} className="text-xs font-bold text-blue-600 hover:text-blue-700 flex items-center gap-1">
                      <Eye className="w-3 h-3" /> 查看
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
          {filteredUsers.length > 20 && !showAll && (
            <button onClick={() => setShowAll(true)} className="w-full text-center text-sm text-blue-600 font-bold py-3">
              顯示全部 ({filteredUsers.length} 人)
            </button>
          )}
        </div>
      </div>

      {/* Field Position Editor Modal */}
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

const StatCard = ({ icon: Icon, label, value, color }) => (
  <div className="bg-white p-5 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
    <div className={`w-11 h-11 bg-${color}-50 text-${color}-600 rounded-xl flex items-center justify-center`}>
      <Icon className="w-5 h-5" />
    </div>
    <div>
      <div className="text-2xl font-black text-slate-900">{value}</div>
      <div className="text-sm font-medium text-slate-400">{label}</div>
    </div>
  </div>
);

export default ContractAdmin;
