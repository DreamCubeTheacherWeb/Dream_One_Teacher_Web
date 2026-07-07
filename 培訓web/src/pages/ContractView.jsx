import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import DocumentViewer from '../components/DocumentViewer';
import {
  ArrowLeft, Download, FileText, Calendar, User, Shield,
  CreditCard, MapPin, Phone, CheckCircle2, PenTool, AlertTriangle, BookOpen
} from 'lucide-react';

const ContractView = () => {
  const { contractId } = useParams();
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [contract, setContract] = useState(null);
  const [signatureUrl, setSignatureUrl] = useState(null);
  const [signedPdfUrls, setSignedPdfUrls] = useState({});
  const [docUrls, setDocUrls] = useState({});
  const [docMeta, setDocMeta] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => {
    if (user && contractId) loadContract();
  }, [user, contractId]);

  const loadContract = async () => {
    setLoading(true);
    try {
      let query = supabase.from('instructor_contracts').select('*').eq('id', contractId);
      if (profile?.role !== 'admin') query = query.eq('user_id', user.id);
      const { data, error } = await query.single();
      if (error || !data) { navigate('/profile'); return; }
      setContract(data);

      if (data.signature_path) {
        const { data: sigUrl } = await supabase.storage
          .from('contract-documents')
          .createSignedUrl(data.signature_path, 3600);
        if (sigUrl?.signedUrl) setSignatureUrl(sigUrl.signedUrl);
      }

      const pdfPaths = data.signed_pdf_paths || {};
      if (data.signed_pdf_path && !Object.keys(pdfPaths).length) {
        pdfPaths.contract = data.signed_pdf_path;
      }
      const pdfUrls = {};
      for (const [docType, path] of Object.entries(pdfPaths)) {
        if (!path) continue;
        const { data: u } = await supabase.storage
          .from('contract-documents')
          .createSignedUrl(path, 3600);
        if (u?.signedUrl) pdfUrls[docType] = u.signedUrl;
      }
      setSignedPdfUrls(pdfUrls);

      const { data: docs } = await supabase
        .from('contract_documents')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');

      const urls = {};
      const meta = [];
      for (const doc of (docs || [])) {
        meta.push({
          doc_type: doc.doc_type,
          display_name: doc.display_name || doc.doc_type,
          doc_mode: doc.doc_mode || 'view_only',
        });
        const { data: u } = await supabase.storage
          .from('contract-documents')
          .createSignedUrl(doc.file_path, 3600);
        if (u?.signedUrl) urls[doc.doc_type] = u.signedUrl;
      }
      setDocUrls(urls);
      setDocMeta(meta);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  const handleDownloadPdf = async (docType) => {
    const url = signedPdfUrls[docType];
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    const meta = docMeta.find(d => d.doc_type === docType);
    a.download = `${meta?.display_name || docType}_${contract?.filled_name || ''}_${new Date(contract?.signed_at).toLocaleDateString('zh-TW')}.pdf`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
        <p className="text-slate-600">找不到此合約</p>
        <button onClick={() => navigate('/profile')} className="mt-4 px-5 py-2 bg-slate-100 rounded-xl font-bold text-sm hover:bg-slate-200">返回</button>
      </div>
    );
  }

  const tabs = [
    { id: 'overview', label: '合約摘要', icon: FileText },
    ...docMeta.map(d => ({
      id: d.doc_type,
      label: d.display_name,
      icon: d.doc_mode === 'fill_sign' ? PenTool : BookOpen,
    })),
  ];

  const docVersions = contract.doc_versions || {};
  const hasAnySignedPdf = Object.keys(signedPdfUrls).length > 0;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8">
      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-2 transition-colors">
            <ArrowLeft className="w-4 h-4" /> 返回
          </button>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900">合約檢視</h1>
        </div>
        {hasAnySignedPdf && (
          <div className="flex gap-2 flex-wrap">
            {Object.keys(signedPdfUrls).map(dt => {
              const meta = docMeta.find(d => d.doc_type === dt);
              return (
                <button key={dt} onClick={() => handleDownloadPdf(dt)}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/25 shrink-0">
                  <Download className="w-4 h-4" /> {meta?.display_name || dt}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {contract.status === 'voided' && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-red-500 shrink-0" />
          <p className="text-sm text-red-700">此合約已作廢（因重新簽約）</p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 overflow-x-auto pb-1">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold transition-all shrink-0 ${
              activeTab === t.id
                ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/20'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            }`}>
            <t.icon className="w-4 h-4" />
            {t.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 shadow-lg overflow-hidden">
        {activeTab === 'overview' && (
          <div className="p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 bg-green-50 rounded-xl flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-green-500" />
              </div>
              <div>
                <h3 className="font-bold text-slate-900">
                  {contract.status === 'signed' ? '合約已簽署' : '合約已作廢'}
                </h3>
                <p className="text-sm text-slate-500">簽署時間：{new Date(contract.signed_at).toLocaleString('zh-TW')}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              <InfoRow icon={User} label="立契約書人" value={contract.filled_name} />
              <InfoRow icon={Shield} label="講師等級" value={contract.filled_instructor_role} />
              <InfoRow icon={CreditCard} label="身分證字號" value={contract.filled_id_number?.replace(/(.{3}).+(.{3})/, '$1****$2')} />
              <InfoRow icon={MapPin} label="地址" value={contract.filled_address} />
              <InfoRow icon={Phone} label="電話" value={contract.filled_phone} />
              <InfoRow icon={Calendar} label="簽約日期" value={new Date(contract.signed_at).toLocaleDateString('zh-TW')} />
            </div>

            <div className="bg-slate-50 rounded-xl p-4 text-sm text-slate-500 space-y-1 mb-6">
              <p className="font-bold text-slate-700 mb-2">文件版本</p>
              {Object.keys(docVersions).length > 0 ? (
                Object.entries(docVersions).map(([k, v]) => {
                  const meta = docMeta.find(d => d.doc_type === k);
                  return <p key={k}>{meta?.display_name || k}：v{v}</p>;
                })
              ) : (
                <>
                  {contract.rules_doc_version > 0 && <p>講師管理辦法：v{contract.rules_doc_version}</p>}
                  {contract.compensation_doc_version > 0 && <p>報酬表：v{contract.compensation_doc_version}</p>}
                  {contract.contract_doc_version > 0 && <p>契約書：v{contract.contract_doc_version}</p>}
                </>
              )}
            </div>

            {signatureUrl && (
              <div>
                <h4 className="text-sm font-bold text-slate-700 mb-2">甲方簽名</h4>
                <div className="border border-slate-200 rounded-xl p-4 bg-white">
                  <img src={signatureUrl} alt="簽名" className="max-h-20 mx-auto" />
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab !== 'overview' && (
          <div className="p-4 sm:p-6">
            {signedPdfUrls[activeTab] ? (
              <DocumentViewer fileUrl={signedPdfUrls[activeTab]} />
            ) : docUrls[activeTab] ? (
              <DocumentViewer fileUrl={docUrls[activeTab]} />
            ) : (
              <p className="text-center text-slate-400 py-12">文件不可用</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const InfoRow = ({ label, value }) => (
  <div className="flex items-start gap-3 p-3 bg-slate-50 rounded-xl">
    <Icon className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
    <div>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-sm font-bold text-slate-900">{value || '-'}</div>
    </div>
  </div>
);

export default ContractView;
