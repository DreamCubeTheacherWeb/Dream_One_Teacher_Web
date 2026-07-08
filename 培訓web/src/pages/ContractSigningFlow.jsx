import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { PDFDocument } from 'pdf-lib';
import DocumentViewer from '../components/DocumentViewer';
import SignaturePadComponent from '../components/SignaturePad';
import EmailOtpGate from '../components/EmailOtpGate';
import {
  FileText, FileCheck, PenTool, CheckCircle2, ChevronRight,
  ChevronLeft, AlertCircle, Download, PartyPopper, Shield, User,
  MapPin, Phone, CreditCard, ArrowLeft, BookOpen
} from 'lucide-react';

const ContractSigningFlow = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [steps, setSteps] = useState([]);
  const [step, setStep] = useState(0);
  const [docs, setDocs] = useState({});
  const [docUrls, setDocUrls] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [existingContract, setExistingContract] = useState(null);

  const [formData, setFormData] = useState({
    name: '', instructorRole: '', idNumber: '', address: '', phone: '',
  });
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedElectronic, setAgreedElectronic] = useState(false);
  const [signatureDataUrl, setSignatureDataUrl] = useState(null);
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [newContractId, setNewContractId] = useState(null);

  // 本人身分驗證（簽名前的 email OTP gate）
  const [verified, setVerified] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState(null);
  // 缺簽名欄位座標的文件（admin 未設定 → 會產出無效合約，須擋下）
  const [missingSigTitles, setMissingSigTitles] = useState([]);

  // 只在使用者身分（id）確立時載入一次；避免 token 續期或 OTP 驗證換 session
  // 導致 user 參考改變而重跑 loadData、洗掉使用者已填/已簽的內容。
  useEffect(() => { if (user) loadData(); }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 找出「需簽署但尚未設定簽名欄位座標」的文件標題。
  // 回傳 { missing:[標題], failed:boolean }；failed 表示無法確認（查詢出錯），
  // 呼叫端據此決定是否保守擋下。
  const findDocsMissingSignatureField = async (docsMap, stepsList) => {
    const fillSign = stepsList.filter(s => s.docMode === 'fill_sign');
    const missing = [];
    let failed = false;
    for (const s of fillSign) {
      const doc = docsMap[s.docType];
      if (!doc) continue;
      const { data: positions, error: posErr } = await supabase
        .from('contract_field_positions')
        .select('field_type')
        .eq('doc_type', doc.doc_type)
        .eq('doc_version', doc.version);
      if (posErr) { failed = true; continue; }
      if (!(positions || []).some(p => p.field_type === 'signature')) missing.push(s.title);
    }
    return { missing, failed };
  };

  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data: docsData } = await supabase
        .from('contract_documents')
        .select('*')
        .eq('is_active', true)
        .order('sort_order')
        .order('version', { ascending: false });

      const activeMap = {};
      const stepList = [];
      const seen = new Set();
      (docsData || []).forEach(d => {
        if (seen.has(d.doc_type)) return;
        seen.add(d.doc_type);
        activeMap[d.doc_type] = d;
        stepList.push({
          id: d.doc_type,
          title: d.display_name || d.doc_type,
          docType: d.doc_type,
          docMode: d.doc_mode || 'view_only',
          icon: d.doc_mode === 'fill_sign' ? PenTool : BookOpen,
        });
      });
      setSteps(stepList);
      setDocs(activeMap);

      // 最佳努力：預先偵測缺簽名欄位的文件，於畫面顯示提示並停用送出（查詢出錯則不預先擋，
      // 交由送出前的權威檢查把關）。
      const sigCheck = await findDocsMissingSignatureField(activeMap, stepList);
      setMissingSigTitles(sigCheck.missing);

      const urls = {};
      for (const [type, doc] of Object.entries(activeMap)) {
        const { data: urlData } = await supabase.storage
          .from('contract-documents')
          .createSignedUrl(doc.file_path, 3600);
        if (urlData?.signedUrl) urls[type] = urlData.signedUrl;
      }
      setDocUrls(urls);

      const { data: instrData } = await supabase
        .from('instructors')
        .select('full_name, instructor_role, id_number, address, phone_mobile')
        .eq('user_id', user.id)
        .single();

      if (instrData) {
        setFormData(prev => ({
          ...prev,
          name: instrData.full_name || '',
          instructorRole: instrData.instructor_role || '',
          idNumber: instrData.id_number || '',
          address: instrData.address || '',
          phone: instrData.phone_mobile || '',
        }));
      }

      const { data: contractData } = await supabase
        .from('instructor_contracts')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'signed')
        .order('signed_at', { ascending: false })
        .limit(1)
        .single();
      if (contractData) setExistingContract(contractData);
    } catch (e) {
      console.error('[ContractSigningFlow] loadData 失敗：', e);
      setLoadError('資料載入失敗，請重新整理頁面，或聯繫管理員。');
    }
    setLoading(false);
  };

  const handleSignatureConfirm = (dataUrl) => {
    setSignatureDataUrl(dataUrl);
    setShowSignaturePad(false);
  };

  const hasFillSignSteps = steps.some(s => s.docMode === 'fill_sign');
  const isLastStep = step === steps.length - 1;
  const currentStep = steps[step];
  const isFillSign = currentStep?.docMode === 'fill_sign';
  const showFormOnThisStep = isFillSign && isLastStep;

  // 講師等級空白＝缺前置資料（唯讀欄，由系統帶入），不是使用者操作錯
  const roleMissing = hasFillSignSteps && !formData.instructorRole.trim();

  const isFormValid = () => {
    if (!hasFillSignSteps) return true;
    return (
      formData.name.trim() &&
      formData.instructorRole.trim() &&
      formData.idNumber.trim().length === 10 &&
      formData.address.trim() &&
      formData.phone.trim() &&
      agreedTerms && agreedElectronic && verified && signatureDataUrl &&
      missingSigTitles.length === 0
    );
  };

  const DPR = 3;

  const textToPngBuffer = async (text, opts = {}) => {
    const { fontSize = 14, color = '#000000', maxWidth = 300, fontWeight = '500', lineHeight = 1.4 } = opts;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontFamily = '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    const fontStr = `${fontWeight} ${fontSize * DPR}px ${fontFamily}`;
    ctx.font = fontStr;

    const breakText = (src) => {
      if (!src) return [''];
      const rows = []; let row = '';
      for (const ch of src) {
        const next = row + ch;
        if (ctx.measureText(next).width > maxWidth * DPR && row) { rows.push(row); row = ch; }
        else row = next;
      }
      if (row) rows.push(row);
      return rows;
    };

    const lines = breakText(String(text || ''));
    const padX = 4 * DPR, padY = 2 * DPR;
    const linePx = Math.round(fontSize * lineHeight * DPR);
    const cw = Math.max(...lines.map(l => ctx.measureText(l).width), 10);
    const width = Math.ceil(Math.min(maxWidth * DPR, cw) + padX * 2);
    const height = Math.ceil(lines.length * linePx + padY * 2);
    canvas.width = width; canvas.height = height;
    const ctx2 = canvas.getContext('2d');
    ctx2.clearRect(0, 0, width, height);
    ctx2.font = fontStr; ctx2.fillStyle = color; ctx2.textBaseline = 'top';
    lines.forEach((line, i) => ctx2.fillText(line, padX, padY + i * linePx));

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => { if (!b) reject(new Error('建立文字影像失敗')); else resolve(b); }, 'image/png');
    });
    return { buffer: await blob.arrayBuffer(), widthPt: width / DPR, heightPt: height / DPR };
  };

  const generateSignedPdfs = async () => {
    const fillSignDocs = steps.filter(s => s.docMode === 'fill_sign');
    const results = {};

    const fieldValueMap = {
      name: formData.name,
      instructor_role: formData.instructorRole ? `${formData.instructorRole}級` : '',
      id_number: formData.idNumber,
      address: formData.address,
      phone: formData.phone,
    };

    for (const s of fillSignDocs) {
      const doc = docs[s.docType];
      if (!doc) continue;

      const { data: positions } = await supabase
        .from('contract_field_positions')
        .select('*')
        .eq('doc_type', doc.doc_type)
        .eq('doc_version', doc.version);

      const { data: fileData, error: dlErr } = await supabase.storage
        .from('contract-documents')
        .download(doc.file_path);
      if (dlErr || !fileData) throw new Error(`無法下載 ${s.title}`);

      const pdfBytes = await fileData.arrayBuffer();
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const pages = pdfDoc.getPages();

      if (positions?.length) {
        for (const pos of positions) {
          const page = pages[pos.page_number - 1];
          if (!page) continue;
          const { height: pageH } = page.getSize();

          if (pos.field_type === 'signature' && signatureDataUrl) {
            const sigBytes = await fetch(signatureDataUrl).then(r => r.arrayBuffer());
            const sigImage = await pdfDoc.embedPng(sigBytes);
            page.drawImage(sigImage, {
              x: pos.x,
              y: pageH - pos.y_from_top - pos.height,
              width: pos.width,
              height: pos.height,
            });
          } else {
            const text = fieldValueMap[pos.field_type];
            if (!text) continue;
            const { buffer, widthPt, heightPt } = await textToPngBuffer(text, {
              fontSize: pos.font_size || 13,
              maxWidth: pos.width,
              color: '#000000',
            });
            const png = await pdfDoc.embedPng(buffer);
            page.drawImage(png, {
              x: pos.x,
              y: pageH - pos.y_from_top - heightPt,
              width: widthPt,
              height: heightPt,
            });
          }
        }
      }

      results[s.docType] = {
        bytes: await pdfDoc.save(),
        version: doc.version,
      };
    }
    return results;
  };

  const handleSubmit = async () => {
    if (!isFormValid()) return;
    setSubmitting(true);

    try {
      // 送出前權威檢查：每份需簽署文件都必須有簽名欄位座標，否則會產出「沒有簽名的 PDF」
      // 卻顯示簽約成功。缺欄位或無法確認時，一律擋在任何寫入（含作廢舊約）之前。
      const sigCheck = await findDocsMissingSignatureField(docs, steps);
      if (sigCheck.missing.length > 0) {
        setMissingSigTitles(sigCheck.missing);
        alert(`「${sigCheck.missing.join('、')}」尚未設定簽名欄位，請聯繫管理員設定後再簽署。`);
        setSubmitting(false);
        return;
      }
      if (sigCheck.failed) {
        alert('無法確認合約簽名欄位設定，請稍後再試或聯繫管理員。');
        setSubmitting(false);
        return;
      }

      if (existingContract) {
        await supabase.from('instructor_contracts')
          .update({ status: 'voided' })
          .eq('id', existingContract.id);
      }

      const sigBlob = await (await fetch(signatureDataUrl)).blob();
      const sigFileName = `signed/${user.id}/signature_${Date.now()}.png`;
      const { error: sigErr } = await supabase.storage
        .from('contract-documents')
        .upload(sigFileName, sigBlob, { contentType: 'image/png' });
      if (sigErr) throw sigErr;

      const signedPdfs = await generateSignedPdfs();
      const signedPdfPaths = {};
      for (const [docType, { bytes }] of Object.entries(signedPdfs)) {
        const pdfFileName = `signed/${user.id}/${docType}_${Date.now()}.pdf`;
        const { error: pdfErr } = await supabase.storage
          .from('contract-documents')
          .upload(pdfFileName, new Blob([bytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
        if (pdfErr) throw new Error(`${docType} PDF 上傳失敗：${pdfErr.message}`);
        signedPdfPaths[docType] = pdfFileName;
      }

      const docVersions = {};
      for (const s of steps) {
        const doc = docs[s.docType];
        if (doc) docVersions[s.docType] = doc.version;
      }

      const firstSignedPath = Object.values(signedPdfPaths)[0] || null;

      const contractRecord = {
        user_id: user.id,
        filled_name: formData.name.trim(),
        filled_instructor_role: formData.instructorRole.trim(),
        filled_id_number: formData.idNumber.trim(),
        filled_address: formData.address.trim(),
        filled_phone: formData.phone.trim(),
        signature_path: sigFileName,
        rules_doc_version: docVersions.rules || 0,
        compensation_doc_version: docVersions.compensation || 0,
        contract_doc_version: docVersions.contract || 0,
        doc_versions: docVersions,
        signed_pdf_paths: signedPdfPaths,
        signed_pdf_path: firstSignedPath,
        ip_address: null,
        user_agent: navigator.userAgent,
        verified_at: verifiedAt,
        verify_method: 'email_otp',
      };

      try {
        const resp = await fetch('https://api.ipify.org?format=json');
        contractRecord.ip_address = (await resp.json()).ip;
      } catch { /* ignore */ }

      const { data: newContract, error: insertErr } = await supabase
        .from('instructor_contracts')
        .insert(contractRecord)
        .select()
        .single();
      if (insertErr) throw insertErr;

      setNewContractId(newContract.id);
      setCompleted(true);
    } catch (err) {
      alert('簽約送出失敗：' + (err.message || '未知錯誤'));
    }
    setSubmitting(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-lg p-8 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">資料載入失敗</h2>
          <p className="text-slate-500 mb-6">{loadError}</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button onClick={() => loadData()} className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all">
              重新載入
            </button>
            <button onClick={() => navigate('/profile')} className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-all">
              返回個人資料
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (completed) {
    return (
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-lg p-8 sm:p-12 text-center">
          <div className="w-20 h-20 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-6">
            <PartyPopper className="w-10 h-10 text-green-500" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-slate-900 mb-3">簽約完成！</h1>
          <p className="text-slate-500 mb-8">您的電子合約已成功簽署並存檔。</p>
          <div className="bg-slate-50 rounded-2xl p-5 mb-8 text-left space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">簽約人</span>
              <span className="font-bold text-slate-900">{formData.name}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">講師等級</span>
              <span className="font-bold text-slate-900">{formData.instructorRole}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">簽約時間</span>
              <span className="font-bold text-slate-900">{new Date().toLocaleString('zh-TW')}</span>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button onClick={() => navigate(`/contract/view/${newContractId}`)}
              className="px-6 py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/25">
              查看合約
            </button>
            <button onClick={() => navigate('/profile')}
              className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-all">
              返回個人資料
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-lg p-8 text-center">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">文件尚未就緒</h2>
          <p className="text-slate-500 mb-4">合約文件尚未設定，請通知管理員。</p>
          <button onClick={() => navigate('/profile')} className="mt-2 px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-all">
            返回個人資料
          </button>
        </div>
      </div>
    );
  }

  const missingDocs = steps.filter(s => !docs[s.docType] || !docUrls[s.docType]);
  if (missingDocs.length > 0) {
    return (
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
        <div className="bg-white rounded-3xl border border-slate-200 shadow-lg p-8 text-center">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-slate-900 mb-2">文件尚未就緒</h2>
          <p className="text-slate-500 mb-4">以下合約文件尚未上傳，請通知管理員：</p>
          <ul className="text-sm text-slate-600 space-y-1">
            {missingDocs.map(d => <li key={d.id}>{d.title}</li>)}
          </ul>
          <button onClick={() => navigate('/profile')} className="mt-6 px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-bold hover:bg-slate-200 transition-all">
            返回個人資料
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8">
      {/* Step progress */}
      <div className="mb-8">
        <button onClick={() => navigate('/profile')} className="flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 mb-4 transition-colors py-3 md:py-0">
          <ArrowLeft className="w-4 h-4" /> 返回個人資料
        </button>
        <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto pb-2">
          {steps.map((s, i) => {
            const StepIcon = s.icon;
            const isActive = i === step;
            const isDone = i < step;
            return (
              <div key={s.id} className="flex items-center gap-2 shrink-0">
                <div className={`flex items-center gap-2 px-3 sm:px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                  isActive ? 'bg-blue-600 text-white shadow-lg shadow-blue-500/25' :
                  isDone ? 'bg-green-50 text-green-600' : 'bg-slate-100 text-slate-400'
                }`}>
                  {isDone ? <CheckCircle2 className="w-4 h-4" /> : <StepIcon className="w-4 h-4" />}
                  <span className="hidden sm:inline">{s.title}</span>
                  <span className="sm:hidden">Step {i + 1}</span>
                </div>
                {i < steps.length - 1 && <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 shadow-lg overflow-hidden">
        <div className="p-5 sm:p-6 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <h2 className="text-lg sm:text-xl font-bold text-slate-900">{currentStep?.title}</h2>
          <p className="text-sm text-slate-500 mt-1">
            {isFillSign ? '請仔細閱讀文件內容，並填寫下方欄位後進行簽名' : '請仔細閱讀以下文件內容'}
          </p>
        </div>

        <div className="p-4 sm:p-6">
          <DocumentViewer
            fileUrl={docUrls[currentStep?.docType]}
            onFinishReading={!isFillSign ? () => setStep(step + 1) : null}
          />
        </div>

        {/* Contract form - shown on the last fill_sign step */}
        {showFormOnThisStep && (
          <div className="px-4 sm:px-6 pb-6">
            <div className="border-t border-slate-100 pt-6 mt-2">
              <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                <PenTool className="w-5 h-5 text-blue-600" /> 填寫契約資料
              </h3>

              {roleMissing && (
                <div className="mb-5 rounded-xl border-2 border-red-200 bg-red-50 p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-red-700">尚無法簽署：您的講師等級尚未設定</p>
                    <p className="text-sm text-red-600 mt-1">
                      講師等級由系統依您的資料自動帶入，目前為空白，屬於缺少前置資料（非您操作錯誤）。
                      請聯繫管理員設定講師等級後，再回來完成簽署。
                    </p>
                  </div>
                </div>
              )}

              {missingSigTitles.length > 0 && (
                <div className="mb-5 rounded-xl border-2 border-red-200 bg-red-50 p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-red-700">尚無法簽署：合約尚未設定簽名欄位</p>
                    <p className="text-sm text-red-600 mt-1">
                      以下文件尚未由管理員設定簽名欄位位置，若強行簽署會產生沒有簽名的無效合約：
                      「{missingSigTitles.join('、')}」。請聯繫管理員設定後再簽署。
                    </p>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="text-sm font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                    <User className="w-4 h-4 text-slate-400" /> 立契約書人（甲方姓名）<span className="text-red-500">*</span>
                  </label>
                  <input type="text" value={formData.name} onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                    autoComplete="name"
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="請輸入姓名" />
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                    <Shield className="w-4 h-4 text-slate-400" /> 講師等級<span className="text-red-500">*</span>
                  </label>
                  <input type="text" value={formData.instructorRole} readOnly
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl bg-slate-50 text-slate-600 outline-none" placeholder="由系統自動帶入" />
                  <p className="text-xs text-slate-400 mt-1">此欄位由系統帶入，如需調整請聯繫管理員</p>
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                    <CreditCard className="w-4 h-4 text-slate-400" /> 身分證字號<span className="text-red-500">*</span>
                  </label>
                  <input type="text" value={formData.idNumber}
                    onChange={e => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); setFormData(p => ({ ...p, idNumber: v })); }}
                    maxLength={10}
                    autoComplete="off"
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-mono tracking-wider"
                    placeholder="A123456789" />
                  <p className="text-xs text-slate-400 mt-1">共 10 碼英數字元（{formData.idNumber.length}/10）</p>
                </div>
                <div>
                  <label className="text-sm font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                    <MapPin className="w-4 h-4 text-slate-400" /> 地址<span className="text-red-500">*</span>
                  </label>
                  <input type="text" value={formData.address} onChange={e => setFormData(p => ({ ...p, address: e.target.value }))}
                    autoComplete="street-address"
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="請輸入通訊地址" />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-sm font-bold text-slate-700 mb-1.5 flex items-center gap-1.5">
                    <Phone className="w-4 h-4 text-slate-400" /> 電話<span className="text-red-500">*</span>
                  </label>
                  <input type="tel" value={formData.phone} onChange={e => setFormData(p => ({ ...p, phone: e.target.value }))}
                    inputMode="tel" autoComplete="tel"
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all"
                    placeholder="請輸入聯絡電話" />
                </div>
              </div>

              <div className="space-y-3 mb-6 bg-amber-50 rounded-xl p-4 border border-amber-100">
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input type="checkbox" checked={agreedTerms} onChange={e => setAgreedTerms(e.target.checked)}
                    className="mt-0.5 w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                  <span className="text-sm text-slate-700 group-hover:text-slate-900 transition-colors">
                    清楚看過所有合約文件內容，皆可遵守並配合。
                  </span>
                </label>
                <label className="flex items-start gap-3 cursor-pointer group">
                  <input type="checkbox" checked={agreedElectronic} onChange={e => setAgreedElectronic(e.target.checked)}
                    className="mt-0.5 w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                  <span className="text-sm text-slate-700 group-hover:text-slate-900 transition-colors">
                    清楚且接受線上電子簽名與實體簽約具備一樣的法律效力。
                  </span>
                </label>
              </div>

              <EmailOtpGate
                email={user?.email}
                verified={verified}
                onVerified={(ts) => { setVerified(true); setVerifiedAt(ts); }}
              />

              <div className="mb-6">
                <h4 className="text-sm font-bold text-slate-700 mb-3">甲方簽名</h4>
                {signatureDataUrl ? (
                  <div className="border-2 border-green-200 rounded-xl p-4 bg-green-50">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-sm font-bold text-green-700 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" /> 已簽名
                      </span>
                      <button onClick={() => { setSignatureDataUrl(null); setShowSignaturePad(true); }}
                        className="text-sm text-blue-600 hover:text-blue-700 font-bold py-3 px-2 md:py-0 md:px-0">重新簽名</button>
                    </div>
                    <div className="bg-white rounded-lg p-3 border border-green-100">
                      <img src={signatureDataUrl} alt="簽名" className="max-h-24 mx-auto" />
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setShowSignaturePad(true)}
                    disabled={!agreedTerms || !agreedElectronic || !verified}
                    className={`w-full py-8 border-2 border-dashed rounded-xl transition-all flex flex-col items-center gap-2 ${
                      agreedTerms && agreedElectronic && verified
                        ? 'border-blue-300 bg-blue-50/50 hover:bg-blue-50 hover:border-blue-400 cursor-pointer text-blue-600'
                        : 'border-slate-200 bg-slate-50 text-slate-400 cursor-not-allowed'
                    }`}>
                    <PenTool className="w-8 h-8" />
                    <span className="font-bold">
                      {!agreedTerms || !agreedElectronic
                        ? '請先勾選上方兩個同意項目'
                        : !verified
                          ? '請先完成上方 Email 身分驗證'
                          : '點擊此處進行簽名'}
                    </span>
                  </button>
                )}
              </div>

              <div className="flex flex-col sm:flex-row gap-3 items-center justify-between pt-4 border-t border-slate-100">
                <button onClick={() => setStep(step - 1)}
                  className="flex items-center gap-2 px-5 py-3 md:py-2.5 text-sm font-bold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-all w-full sm:w-auto justify-center">
                  <ChevronLeft className="w-4 h-4" /> 上一步
                </button>
                <button onClick={handleSubmit} disabled={!isFormValid() || submitting}
                  className={`flex items-center gap-2 px-8 py-3 text-sm font-bold rounded-xl transition-all w-full sm:w-auto justify-center ${
                    isFormValid() && !submitting
                      ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:from-blue-700 hover:to-indigo-700 shadow-lg shadow-blue-500/25 hover:shadow-xl hover:-translate-y-0.5'
                      : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  }`}>
                  {submitting ? (
                    <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> 簽約中...</>
                  ) : (
                    <><CheckCircle2 className="w-4 h-4" /> 確認送出簽約</>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Non-last fill_sign step: show prev/next buttons */}
        {isFillSign && !isLastStep && (
          <div className="px-4 sm:px-6 pb-6">
            <div className="flex justify-between pt-4 border-t border-slate-100">
              {step > 0 && (
                <button onClick={() => setStep(step - 1)}
                  className="flex items-center gap-2 px-5 py-3 md:py-2.5 text-sm font-bold text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200 transition-all">
                  <ChevronLeft className="w-4 h-4" /> 上一步
                </button>
              )}
              <button onClick={() => setStep(step + 1)}
                className="flex items-center gap-2 px-5 py-3 md:py-2.5 text-sm font-bold text-blue-600 bg-blue-50 rounded-xl hover:bg-blue-100 transition-all ml-auto">
                下一步 <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <SignaturePadComponent
        isOpen={showSignaturePad}
        onConfirm={handleSignatureConfirm}
        onCancel={() => setShowSignaturePad(false)}
      />
    </div>
  );
};

export default ContractSigningFlow;
