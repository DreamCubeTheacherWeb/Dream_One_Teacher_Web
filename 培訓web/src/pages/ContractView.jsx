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
        <div className="animate-spin w-10 h-10 border-4 border-bauhaus-black border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!contract) {
    return (
      <div className="max-w-2xl mx-auto p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-bauhaus-yellow mx-auto mb-4" />
        <p className="text-bauhaus-black/70 font-medium">找不到此合約</p>
        <button onClick={() => navigate('/profile')} className="bh-btn bh-btn-outline mt-4 px-5 py-2 text-sm">返回</button>
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
          <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-bauhaus-black/60 hover:text-bauhaus-black mb-2 transition-colors py-3 md:py-0">
            <ArrowLeft className="w-4 h-4" /> 返回
          </button>
          <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black">合約檢視</h1>
        </div>
        {hasAnySignedPdf && (
          <div className="flex gap-2 flex-wrap">
            {Object.keys(signedPdfUrls).map(dt => {
              const meta = docMeta.find(d => d.doc_type === dt);
              return (
                <button key={dt} onClick={() => handleDownloadPdf(dt)}
                  className="bh-btn bh-btn-blue px-4 py-3 md:py-2 text-sm shrink-0">
                  <Download className="w-4 h-4" /> {meta?.display_name || dt}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {contract.status === 'voided' && (
        <div className="mb-6 bg-bauhaus-red border-2 border-bauhaus-black p-4 flex items-center gap-3">
          <AlertTriangle className="w-5 h-5 text-white shrink-0" />
          <p className="text-sm font-bold text-white">此合約已作廢（因重新簽約）</p>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 overflow-x-auto pb-1">
        <div className="inline-flex border-2 lg:border-4 border-bauhaus-black divide-x-2 divide-bauhaus-black">
          {tabs.map(t => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-3 md:py-2 text-sm font-bold uppercase tracking-wide transition-colors duration-200 shrink-0 ${
                activeTab === t.id
                  ? 'bg-bauhaus-black text-white'
                  : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
              }`}>
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bh-card overflow-hidden">
        {activeTab === 'overview' && (
          <div className="p-6 sm:p-8">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-12 h-12 border-2 border-bauhaus-black bg-bauhaus-blue flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-white" />
              </div>
              <div>
                <h3 className="font-bold text-bauhaus-black">
                  {contract.status === 'signed' ? '合約已簽署' : '合約已作廢'}
                </h3>
                <p className="text-sm text-bauhaus-black/60">簽署時間：{new Date(contract.signed_at).toLocaleString('zh-TW')}</p>
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

            <div className="bg-bauhaus-paper border-2 border-bauhaus-black/10 p-4 text-sm text-bauhaus-black/60 space-y-1 mb-6">
              <p className="font-bold text-bauhaus-black mb-2">文件版本</p>
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
                <h4 className="text-sm font-bold text-bauhaus-black mb-2">甲方簽名</h4>
                <div className="border-2 border-bauhaus-black p-4 bg-white">
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
              <p className="text-center text-bauhaus-black/40 py-12 font-medium">文件不可用</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

const InfoRow = ({ icon, label, value }) => {
  const Icon = icon;
  return (
    <div className="flex items-start gap-3 p-3 border-2 border-bauhaus-black/10 bg-bauhaus-paper">
      <Icon className="w-4 h-4 text-bauhaus-black/40 mt-0.5 shrink-0" />
      <div>
        <div className="text-xs text-bauhaus-black/50">{label}</div>
        <div className="text-sm font-bold text-bauhaus-black">{value || '-'}</div>
      </div>
    </div>
  );
};

export default ContractView;
