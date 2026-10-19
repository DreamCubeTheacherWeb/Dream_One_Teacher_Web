import { useState, useEffect, useEffectEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import DocumentViewer from '../components/DocumentViewer';
import { downloadContractFile } from '../lib/contractFiles';
import { contractStatusLabel, formatTaipeiTime, safeDownloadName } from '../lib/esign';
import {
  ArrowLeft, Download, FileText, Calendar, User, Shield,
  CreditCard, MapPin, Phone, CheckCircle2, PenTool, AlertTriangle, BookOpen
} from 'lucide-react';

// 簽署成品 PDF 的路徑表 {doc_type: path}；舊資料只有單一 signed_pdf_path。
const signedPdfPathsOf = (contract) => {
  const paths = { ...(contract?.signed_pdf_paths || {}) };
  if (contract?.signed_pdf_path && !Object.keys(paths).length) paths.contract = contract.signed_pdf_path;
  return paths;
};

const ContractView = () => {
  const { contractId } = useParams();
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [contract, setContract] = useState(null);
  const [signatureUrl, setSignatureUrl] = useState(null);
  const [signedPdfUrls, setSignedPdfUrls] = useState({});
  const [docUrls, setDocUrls] = useState({});
  const [docMeta, setDocMeta] = useState([]);
  const [history, setHistory] = useState([]);
  const [downloadError, setDownloadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');

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

      // 同一位講師的所有簽署版本（含已作廢）：重簽不會讓舊版消失
      const { data: allVersions } = await supabase
        .from('instructor_contracts')
        .select('id, status, signed_at, voided_at, voided_reason, doc_versions, signed_pdf_paths, signed_pdf_path, filled_name')
        .eq('user_id', data.user_id)
        .order('signed_at', { ascending: false });
      setHistory(allVersions || []);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  // 只在登入者或合約編號改變時載入；用 Effect Event 讀最新的 loadContract，不把它列進依賴
  // （origin/main cc1e737 的 react-hooks lint 修正）。延到下一個 tick 執行並在清除時取消：
  // StrictMode 開發模式掛載兩次時只載入一次。
  const onContractTargetChange = useEffectEvent(() => {
    if (user && contractId) loadContract();
  });
  useEffect(() => {
    if (!user || !contractId) return undefined;
    const timer = window.setTimeout(() => onContractTargetChange(), 0);
    return () => window.clearTimeout(timer);
  }, [user, contractId]);

  const handleDownloadPdf = async (docType, target = contract) => {
    const paths = signedPdfPathsOf(target);
    const meta = docMeta.find(d => d.doc_type === docType);
    const filename = safeDownloadName(
      meta?.display_name || docType,
      target?.filled_name,
      formatTaipeiTime(target?.signed_at).slice(0, 10),
    ) + '.pdf';
    setDownloadError('');
    const result = await downloadContractFile(paths[docType], filename);
    if (!result.ok) setDownloadError(`下載失敗：${result.error}`);
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

      {downloadError && (
        <div role="alert" className="mb-4 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl px-4 py-3 text-sm font-bold text-bauhaus-black">
          {downloadError}
        </div>
      )}

      {contract.status === 'voided' && (
        <div data-testid="voided-banner" className="mb-6 bg-bauhaus-red border-2 border-bauhaus-black rounded-2xl p-4 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-white shrink-0 mt-0.5" />
          <p className="text-sm font-bold text-white break-words">
            此合約已作廢
            {contract.voided_at ? `（${formatTaipeiTime(contract.voided_at)}）` : ''}
            {contract.voided_reason ? `：${contract.voided_reason}` : '（因重新簽約）'}
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-6 overflow-x-auto pb-1">
        <div className="inline-flex border-2 lg:border-4 border-bauhaus-black rounded-xl overflow-hidden divide-x-2 divide-bauhaus-black">
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
              <div className="w-12 h-12 border-2 border-bauhaus-black bg-bauhaus-blue rounded-lg flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-white" />
              </div>
              <div>
                <h3 className="font-bold text-bauhaus-black">
                  {contract.status === 'signed' ? '合約已簽署' : '合約已作廢'}
                </h3>
                <p className="text-sm text-bauhaus-black/60">簽署時間：{formatTaipeiTime(contract.signed_at)}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              <InfoRow icon={User} label="立契約書人" value={contract.filled_name} />
              <InfoRow icon={Shield} label="講師等級" value={contract.filled_instructor_role} />
              <InfoRow icon={CreditCard} label="身分證字號" value={contract.filled_id_number?.replace(/(.{3}).+(.{3})/, '$1****$2')} />
              <InfoRow icon={MapPin} label="地址" value={contract.filled_address} />
              <InfoRow icon={Phone} label="電話" value={contract.filled_phone} />
              <InfoRow icon={Calendar} label="簽約日期" value={formatTaipeiTime(contract.signed_at).slice(0, 10)} />
            </div>

            <div className="bg-bauhaus-paper border-2 border-bauhaus-black/10 rounded-xl p-4 text-sm text-bauhaus-black/60 space-y-1 mb-6">
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

            {history.length > 0 && (
              <div className="mb-6" data-testid="contract-versions">
                <h4 className="text-sm font-bold text-bauhaus-black mb-2">所有簽署版本（含已作廢）</h4>
                <ul className="space-y-2">
                  {history.map((version) => {
                    const versionPaths = signedPdfPathsOf(version);
                    const isCurrent = version.id === contract.id;
                    return (
                      <li key={version.id} className={`border-2 rounded-xl p-3 ${isCurrent ? 'border-bauhaus-black bg-bauhaus-cream' : 'border-bauhaus-black/20'}`}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`bh-chip ${version.status === 'signed' ? 'bg-bauhaus-blue text-white' : 'bg-bauhaus-muted text-bauhaus-black'}`}>
                            {contractStatusLabel(version.status)}
                          </span>
                          <span className="text-sm font-bold text-bauhaus-black">{formatTaipeiTime(version.signed_at)}</span>
                          {isCurrent && <span className="text-xs font-bold text-bauhaus-black/50">（目前檢視）</span>}
                          {!isCurrent && (
                            <Link to={`/contract/view/${version.id}`} className="text-xs font-bold text-bauhaus-blue hover:underline py-3 md:py-0">查看</Link>
                          )}
                        </div>
                        {version.status === 'voided' && (
                          <p className="text-xs text-bauhaus-black/60 mt-1 break-words">
                            作廢時間：{version.voided_at ? formatTaipeiTime(version.voided_at) : '未記錄'}
                            ；原因：{version.voided_reason || '重新簽約'}
                          </p>
                        )}
                        {Object.keys(versionPaths).length > 0 && (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {Object.keys(versionPaths).map((docType) => {
                              const meta = docMeta.find(d => d.doc_type === docType);
                              return (
                                <button
                                  key={docType}
                                  type="button"
                                  onClick={() => handleDownloadPdf(docType, version)}
                                  className="bh-btn bh-btn-outline min-h-[44px] px-3 py-2 text-xs"
                                >
                                  <Download className="w-3.5 h-3.5" /> {meta?.display_name || docType}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {signatureUrl && (
              <div>
                <h4 className="text-sm font-bold text-bauhaus-black mb-2">講師簽名</h4>
                <div className="border-2 border-bauhaus-black rounded-xl p-4 bg-white">
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
    <div className="flex items-start gap-3 p-3 border-2 border-bauhaus-black/10 rounded-xl bg-bauhaus-paper">
      <Icon className="w-4 h-4 text-bauhaus-black/40 mt-0.5 shrink-0" />
      <div>
        <div className="text-xs text-bauhaus-black/50">{label}</div>
        <div className="text-sm font-bold text-bauhaus-black">{value || '-'}</div>
      </div>
    </div>
  );
};

export default ContractView;
