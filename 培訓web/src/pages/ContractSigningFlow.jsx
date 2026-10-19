import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { PDFDocument } from 'pdf-lib';
import DocumentViewer from '../components/DocumentViewer';
import SignaturePadComponent from '../components/SignaturePad';
import EmailOtpDialog from '../components/EmailOtpDialog';
import { downloadContractFile, fetchContractFileBytes } from '../lib/contractFiles';
import {
  buildDocEntries, describeContractRpcError, formatTaipeiTime, isSha256Hex, safeDownloadName, sha256Hex,
} from '../lib/esign';
import {
  CONTRACT_OTP_VALID_MINUTES, ESIGN_COPY_VERSIONS, buildConsentCopy, buildDeclineCopy, buildFinalConfirm,
  buildPaperPendingCopy, buildReadAck, formatDocList, splitEsignInline,
} from '../lib/esignCopy';
import { OTP_PURPOSES, formatCountdown, secondsUntil } from '../lib/emailOtp';
import { interpretActivationStatus } from '../lib/accountActivation';
import {
  FileText, FileCheck, PenTool, CheckCircle2, ChevronRight,
  ChevronLeft, AlertCircle, Download, PartyPopper, Shield, User,
  MapPin, Phone, CreditCard, ArrowLeft, BookOpen, ShieldCheck, Mail, Loader2, X,
} from 'lucide-react';

// 電子簽約流程（2026-10-20 改版，規格 docs/specs/2026-10-20-claim-activation-esign.md §2）：
//   閱讀文件（可下載範本）→ 電子簽約同意頁（同意／不同意改紙本）→ 填資料＋Email 驗證碼＋手寫簽名 → 確認簽署
// 送出前在瀏覽器用 WebCrypto 算每份範本（下載到的原始位元組）與每份成品 PDF 的 SHA-256，
// 連同 OTP challenge、同意紀錄一起交給 submit_my_contract；所有判定由伺服器負責，前端只是依序帶資料。
// 文案全部來自 src/lib/esignCopy.js（法規顧問定稿）。

// 同意紀錄有效 2 小時（伺服器為準）；前端 90 分鐘內重用同一筆，避免來回上下一步產生一堆同意紀錄。
const CONSENT_REUSE_MS = 90 * 60 * 1000;

const Inline = ({ text }) => (
  <>
    {splitEsignInline(text).map((part, index) => (
      part.bold ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>
    ))}
  </>
);

// 驗證通過後的倒數獨立成小元件，每秒重繪不會牽動整個簽約頁。
const OtpValidityNote = ({ verifiedAtMs, onExpire }) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const remaining = secondsUntil(verifiedAtMs + CONTRACT_OTP_VALID_MINUTES * 60 * 1000, now);
  useEffect(() => {
    if (remaining <= 0) onExpire();
  }, [remaining, onExpire]);
  return (
    <p data-testid="otp-validity" className={`text-xs mt-0.5 ${remaining <= 120 ? 'text-white font-black' : 'text-white/80'}`}>
      驗證後需在 {CONTRACT_OTP_VALID_MINUTES} 分鐘內按下「確認簽署」，剩餘 {formatCountdown(remaining)}
    </p>
  );
};

const ContractSigningFlow = () => {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [steps, setSteps] = useState([]);
  const [step, setStep] = useState(0);
  // read（閱讀文件）｜consent（電子簽約同意）｜declined（已選紙本）｜sign（填資料、驗證、簽名）
  const [phase, setPhase] = useState('read');
  const [docs, setDocs] = useState({});
  const [docUrls, setDocUrls] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [maskedEmail, setMaskedEmail] = useState(null);

  const [formData, setFormData] = useState({
    name: '', instructorRole: '', idNumber: '', address: '', phone: '',
  });
  const [readAck, setReadAck] = useState(false);
  const [consentChecked, setConsentChecked] = useState(false);
  const [consent, setConsent] = useState(null); // { id, atMs, key }
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState('');
  const [showDeclineConfirm, setShowDeclineConfirm] = useState(false);
  const [downloadError, setDownloadError] = useState('');

  const [otp, setOtp] = useState(null); // { challengeId, verifiedAtMs }
  const [showOtpDialog, setShowOtpDialog] = useState(false);
  const [otpNotice, setOtpNotice] = useState('');

  const [signatureDataUrl, setSignatureDataUrl] = useState(null);
  const [showSignaturePad, setShowSignaturePad] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  // 簽署途中被帶回前面步驟（同意逾時、文件改版）時，在頁面上方說明原因
  const [flowNotice, setFlowNotice] = useState('');
  const [completed, setCompleted] = useState(null); // { contractId, signedAt, copyEmailMasked }
  const submittingRef = useRef(false);
  const consentBusyRef = useRef(false);

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
        .eq('doc_category', 'contract') // 匯款申請書等後台行政表單（'form'）不屬於簽約流程
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

      // 同意頁要顯示「驗證碼會寄到哪個信箱」（遮罩後）。讀不到就用通用說法，不擋流程。
      try {
        const { data: statusData } = await supabase.rpc('get_my_activation_status');
        setMaskedEmail(interpretActivationStatus(statusData).maskedEmail);
      } catch { /* 遮罩信箱只是顯示用 */ }
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

  const docVersions = useMemo(() => {
    const versions = {};
    steps.forEach((s) => {
      const doc = docs[s.docType];
      if (doc) versions[s.docType] = doc.version;
    });
    return versions;
  }, [steps, docs]);
  const docVersionsKey = JSON.stringify(docVersions);
  const docList = formatDocList(buildDocEntries(steps, docVersions));

  const hasFillSignSteps = steps.some(s => s.docMode === 'fill_sign');
  const isLastStep = step === steps.length - 1;
  const currentStep = steps[step];
  const isFillSign = currentStep?.docMode === 'fill_sign';

  // 講師等級空白＝缺前置資料（唯讀欄，由系統帶入），不是使用者操作錯
  const roleMissing = hasFillSignSteps && !formData.instructorRole.trim();

  const otpValid = Boolean(otp);
  const formFilled = !hasFillSignSteps || Boolean(
    formData.name.trim()
    && formData.instructorRole.trim()
    && formData.idNumber.trim().length === 10
    && formData.address.trim()
    && formData.phone.trim(),
  );

  const outstandingItems = [];
  if (!formFilled) outstandingItems.push('填寫完整的契約資料');
  if (!readAck) outstandingItems.push('勾選「已完整閱讀」');
  if (!otpValid) outstandingItems.push('完成 Email 身分驗證');
  if (!signatureDataUrl) outstandingItems.push('手寫簽名');
  if (missingSigTitles.length > 0) outstandingItems.push('等管理員設定簽名欄位');
  const canSubmit = outstandingItems.length === 0 && Boolean(consent?.id);

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

  // templateBytes：{docType: ArrayBuffer}，送出時才下載的範本原始位元組（同一份拿去算雜湊與填寫，
  // 雜湊算的就是實際被簽的那份檔案）。
  const generateSignedPdfs = async (templateBytes) => {
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

      const { data: positions, error: posErr } = await supabase
        .from('contract_field_positions')
        .select('*')
        .eq('doc_type', doc.doc_type)
        .eq('doc_version', doc.version);
      // 查不到欄位位置就不能產生簽署檔：照樣往下走會產出沒有簽名的 PDF，畫面卻顯示簽約完成。
      if (posErr) throw new Error(`無法讀取「${s.title}」的欄位位置，請稍後再試`);
      if (!(positions || []).some(p => p.field_type === 'signature')) {
        throw new Error(`「${s.title}」缺少簽名欄位設定，請聯繫管理員`);
      }

      const pdfBytes = templateBytes[s.docType];
      if (!pdfBytes) throw new Error(`無法下載 ${s.title}`);
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

  // ── 閱讀階段 ──
  const goNextFromRead = () => {
    if (isLastStep) {
      setPhase('consent');
      window.scrollTo?.({ top: 0 });
    } else {
      setStep(step + 1);
    }
  };

  const handleDownloadTemplate = async (docType) => {
    const doc = docs[docType];
    const meta = steps.find(s => s.docType === docType);
    if (!doc) return;
    setDownloadError('');
    const result = await downloadContractFile(
      doc.file_path,
      `${safeDownloadName(meta?.title || docType, `第${doc.version}版`)}.pdf`,
    );
    if (!result.ok) setDownloadError(`下載失敗：${result.error}`);
  };

  // ── 電子簽約同意 ──
  const recordConsent = async (decision, copyVersion) => {
    const { data, error } = await supabase.rpc('record_contract_consent', {
      p_decision: decision,
      p_doc_versions: docVersions,
      p_consent_text_version: copyVersion,
    });
    if (error) throw error;
    if (data?.status !== 'recorded' || !data.consent_id) throw new Error('伺服器回覆格式不符，沒有記錄到你的選擇');
    return data;
  };

  const describeConsentFailure = (err) => {
    const info = describeContractRpcError(err);
    return info.code === 'UNKNOWN'
      ? `無法記錄你的選擇，請稍後再試（${err?.message || '未知錯誤'}）`
      : info.message;
  };

  const handleAgree = async () => {
    if (!consentChecked || consentBusyRef.current) return;
    setConsentError('');
    // 90 分鐘內、文件版本沒變 → 沿用上一筆同意
    if (consent && consent.key === docVersionsKey && Date.now() - consent.atMs < CONSENT_REUSE_MS) {
      setPhase('sign');
      return;
    }
    consentBusyRef.current = true;
    setConsentBusy(true);
    try {
      const data = await recordConsent('agree_electronic', ESIGN_COPY_VERSIONS.consent);
      setConsent({ id: data.consent_id, atMs: Date.now(), key: docVersionsKey });
      setFlowNotice('');
      setPhase('sign');
    } catch (err) {
      setConsentError(describeConsentFailure(err));
    }
    consentBusyRef.current = false;
    setConsentBusy(false);
  };

  const handleConfirmDecline = async () => {
    if (consentBusyRef.current) return;
    setConsentError('');
    consentBusyRef.current = true;
    setConsentBusy(true);
    try {
      await recordConsent('decline_electronic', ESIGN_COPY_VERSIONS.declinePaper);
      setConsent(null);
      setShowDeclineConfirm(false);
      setPhase('declined');
    } catch (err) {
      setShowDeclineConfirm(false);
      setConsentError(describeConsentFailure(err));
    }
    consentBusyRef.current = false;
    setConsentBusy(false);
  };

  // ── Email 驗證 ──
  const handleOtpVerified = ({ challengeId }) => {
    setOtp({ challengeId, verifiedAtMs: Date.now() });
    setOtpNotice('');
    setShowOtpDialog(false);
  };

  const handleOtpExpire = useCallback(() => {
    setOtp(null);
    setOtpNotice('Email 驗證已逾時，請重新驗證後再簽署。');
  }, []);

  // ── 送出 ──
  const handleSubmitFailure = async (err) => {
    const info = describeContractRpcError(err);
    const redirected = info.action === 'consent' || info.action === 'reload';
    setSubmitError(redirected ? '' : info.message);
    setFlowNotice(redirected ? info.message : '');
    if (info.action === 'otp') {
      setOtp(null);
    } else if (info.action === 'consent') {
      setConsent(null);
      setConsentChecked(false);
      setPhase('consent');
    } else if (info.action === 'reload') {
      // 文件在簽約途中改版：舊的同意與已讀都不算數，從頭重新閱讀
      setConsent(null);
      setConsentChecked(false);
      setReadAck(false);
      setStep(0);
      setPhase('read');
      await loadData();
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true; // 同步旗標：連點兩下時第二下在 state 更新前就會被擋
    setSubmitting(true);
    setSubmitError('');

    try {
      // 送出前權威檢查：每份需簽署文件都必須有簽名欄位座標，否則會產出「沒有簽名的 PDF」
      // 卻顯示簽約成功。缺欄位或無法確認時，一律擋在任何寫入（含作廢舊約）之前。
      const sigCheck = await findDocsMissingSignatureField(docs, steps);
      if (sigCheck.missing.length > 0) {
        setMissingSigTitles(sigCheck.missing);
        setSubmitError(`「${sigCheck.missing.join('、')}」尚未設定簽名欄位，請聯繫管理員設定後再簽署。`);
        return;
      }
      if (sigCheck.failed) {
        setSubmitError('無法確認合約簽名欄位設定，請稍後再試或聯繫管理員。');
        return;
      }

      // 1) 下載每份範本的原始位元組並算 SHA-256（view_only 也要算：證據要涵蓋講師讀到的所有文件）
      const templateBytes = {};
      const documentSha256 = {};
      for (const s of steps) {
        const doc = docs[s.docType];
        if (!doc) continue;
        const bytes = await fetchContractFileBytes(doc.file_path);
        templateBytes[s.docType] = bytes;
        documentSha256[s.docType] = await sha256Hex(bytes);
      }

      // 2) 產出已簽署 PDF，雜湊與上傳用同一份位元組
      const signedPdfs = await generateSignedPdfs(templateBytes);
      const signedPdfSha256 = {};
      const signedPdfBlobs = {};
      for (const [docType, { bytes }] of Object.entries(signedPdfs)) {
        signedPdfSha256[docType] = await sha256Hex(bytes);
        signedPdfBlobs[docType] = new Blob([bytes], { type: 'application/pdf' });
      }
      const allHashes = [...Object.values(documentSha256), ...Object.values(signedPdfSha256)];
      if (allHashes.length === 0 || !allHashes.every(isSha256Hex)) {
        throw new Error('INVALID_HASH');
      }

      // 3) 上傳簽名與成品（路徑含時間戳，重試不會撞檔；signed/ 底下上傳後不可再改）
      const sigBlob = await (await fetch(signatureDataUrl)).blob();
      const sigFileName = `signed/${user.id}/signature_${Date.now()}.png`;
      const { error: sigErr } = await supabase.storage
        .from('contract-documents')
        .upload(sigFileName, sigBlob, { contentType: 'image/png' });
      if (sigErr) throw sigErr;

      const signedPdfPaths = {};
      for (const [docType, blob] of Object.entries(signedPdfBlobs)) {
        const pdfFileName = `signed/${user.id}/${docType}_${Date.now()}.pdf`;
        const { error: pdfErr } = await supabase.storage
          .from('contract-documents')
          .upload(pdfFileName, blob, { contentType: 'application/pdf' });
        if (pdfErr) throw new Error(`${docType} PDF 上傳失敗：${pdfErr.message}`);
        signedPdfPaths[docType] = pdfFileName;
      }

      // 4) 唯一寫入通道：由後端 RPC 驗證 OTP、同意紀錄、文件版本與雜湊，並在同一交易作廢舊約、
      //    寫入新約與證據；IP 與時間由伺服器取得。
      const { data: result, error: insertErr } = await supabase.rpc('submit_my_contract', {
        p_filled_name: formData.name.trim(),
        p_filled_instructor_role: formData.instructorRole.trim(),
        p_filled_id_number: formData.idNumber.trim(),
        p_filled_address: formData.address.trim(),
        p_filled_phone: formData.phone.trim(),
        p_signature_path: sigFileName,
        p_signed_pdf_paths: signedPdfPaths,
        p_doc_versions: docVersions,
        p_user_agent: navigator.userAgent,
        p_otp_challenge_id: otp.challengeId,
        p_consent_id: consent.id,
        p_document_sha256: documentSha256,
        p_signed_pdf_sha256: signedPdfSha256,
      });
      if (insertErr) throw insertErr;
      if (result?.status !== 'signed' || !result.contract_id) {
        throw new Error('伺服器回覆格式不符，無法確認是否簽署成功，請到個人資料頁查看簽約狀態');
      }

      setCompleted({
        contractId: result.contract_id,
        signedAt: result.signed_at,
        copyEmailMasked: result.copy_email_masked || null,
      });
    } catch (err) {
      await handleSubmitFailure(err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin w-10 h-10 border-4 border-bauhaus-black border-t-transparent rounded-full" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-2xl mx-auto p-4 sm:p-8">
        <div className="bg-bauhaus-red border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard lg:shadow-hard-lg p-8 text-center text-white">
          <AlertCircle className="w-12 h-12 text-white mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">資料載入失敗</h2>
          <p className="text-white/80 mb-6">{loadError}</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button onClick={() => loadData()} className="bh-btn bh-btn-blue border-white shadow-hard-white px-6 py-3">
              重新載入
            </button>
            <button onClick={() => navigate('/profile')} className="bh-btn bh-btn-outline border-white shadow-hard-white px-6 py-3">
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
        <div className="bh-card p-6 sm:p-12 text-center" data-testid="signing-complete">
          <div className="w-20 h-20 border-2 border-bauhaus-black bg-bauhaus-blue rounded-full flex items-center justify-center mx-auto mb-6">
            <PartyPopper className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-3">簽約完成！</h1>
          <p className="text-bauhaus-black/60 mb-6">您的電子合約已成功簽署並存檔。</p>
          <div className="bg-bauhaus-paper border-2 border-bauhaus-black/10 rounded-xl p-5 mb-6 text-left space-y-2">
            <div className="flex justify-between gap-4 text-sm">
              <span className="text-bauhaus-black/60 shrink-0">簽約人</span>
              <span className="font-bold text-bauhaus-black text-right break-words">{formData.name}</span>
            </div>
            <div className="flex justify-between gap-4 text-sm">
              <span className="text-bauhaus-black/60 shrink-0">講師等級</span>
              <span className="font-bold text-bauhaus-black text-right">{formData.instructorRole}</span>
            </div>
            <div className="flex justify-between gap-4 text-sm">
              <span className="text-bauhaus-black/60 shrink-0">簽署時間</span>
              <span data-testid="signed-at" className="font-bold text-bauhaus-black text-right">
                {formatTaipeiTime(completed.signedAt, { seconds: true }) || '以系統紀錄為準'}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2 text-left bg-bauhaus-cream border-2 border-bauhaus-black rounded-xl p-4 mb-8 text-sm font-medium text-bauhaus-black">
            <Mail className="w-4 h-4 mt-0.5 shrink-0" />
            <p data-testid="copy-email-note" className="break-words">
              {completed.copyEmailMasked
                ? <>簽署完成通知已寄到 <strong>{completed.copyEmailMasked}</strong>。信中的連結需登入你的帳號才能開啟並下載已簽署文件。</>
                : '簽署完成通知會寄到公司已確認的信箱；若稍後沒有收到，請查看垃圾郵件匣或聯絡行政人員。'}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <button onClick={() => navigate(`/contract/view/${completed.contractId}`)}
              className="bh-btn bh-btn-blue px-6 py-3">
              查看合約
            </button>
            <button onClick={() => navigate('/profile')}
              className="bh-btn bh-btn-outline px-6 py-3">
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
        <div className="bh-card p-8 text-center">
          <AlertCircle className="w-12 h-12 text-bauhaus-black/60 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-bauhaus-black mb-2">文件尚未就緒</h2>
          <p className="text-bauhaus-black/60 mb-4">合約文件尚未設定，請通知管理員。</p>
          <button onClick={() => navigate('/profile')} className="bh-btn bh-btn-outline mt-2 px-6 py-3">
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
        <div className="bh-card p-8 text-center">
          <AlertCircle className="w-12 h-12 text-bauhaus-black/60 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-bauhaus-black mb-2">文件尚未就緒</h2>
          <p className="text-bauhaus-black/60 mb-4">以下合約文件尚未上傳，請通知管理員：</p>
          <ul className="text-sm text-bauhaus-black/70 space-y-1">
            {missingDocs.map(d => <li key={d.id}>{d.title}</li>)}
          </ul>
          <button onClick={() => navigate('/profile')} className="bh-btn bh-btn-outline mt-6 px-6 py-3">
            返回個人資料
          </button>
        </div>
      </div>
    );
  }

  const consentCopy = buildConsentCopy({ docList, maskedEmail });
  const declineCopy = buildDeclineCopy({ docList });
  const readAckCopy = buildReadAck({ docList });
  const finalConfirm = buildFinalConfirm({ instructorName: formData.name.trim(), docList });

  // 進度條：文件各一步，再加「簽約方式」「驗證與簽署」兩步
  const displaySteps = [
    ...steps,
    { id: '__consent', title: '選擇簽約方式', icon: Shield },
    { id: '__sign', title: '驗證與簽署', icon: PenTool },
  ];
  const activeIndex = phase === 'read' ? step : phase === 'sign' ? steps.length + 1 : steps.length;

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8">
      {/* Step progress */}
      <div className="mb-8">
        <button onClick={() => navigate('/profile')} className="flex items-center gap-1 text-sm text-bauhaus-black/60 hover:text-bauhaus-black mb-4 transition-colors py-3 md:py-0">
          <ArrowLeft className="w-4 h-4" /> 返回個人資料
        </button>
        <div className="flex items-center gap-2 sm:gap-4 overflow-x-auto pb-2">
          {displaySteps.map((s, i) => {
            const StepIcon = s.icon;
            const isActive = i === activeIndex;
            const isDone = i < activeIndex;
            const shapeIdx = i % 3;
            const shapeClass = shapeIdx === 0 ? 'rounded-full' : shapeIdx === 1 ? 'rounded-none' : 'rounded-none rotate-45';
            const toneClass = isActive
              ? 'bg-bauhaus-black text-white border-bauhaus-black'
              : isDone
                ? 'bg-bauhaus-blue text-white border-bauhaus-black'
                : 'bg-white text-bauhaus-black/40 border-bauhaus-black/20';
            return (
              <div key={s.id} className="flex items-center gap-2 shrink-0">
                <div className="flex items-center gap-2">
                  <div className={`w-8 h-8 flex items-center justify-center border-2 shrink-0 ${shapeClass} ${toneClass}`}>
                    <span className={shapeIdx === 2 ? 'flex -rotate-45' : 'flex'}>
                      {isDone ? <CheckCircle2 className="w-4 h-4" /> : <StepIcon className="w-4 h-4" />}
                    </span>
                  </div>
                  <span className={`text-sm font-bold uppercase tracking-wide ${
                    isActive ? 'text-bauhaus-black' : isDone ? 'text-bauhaus-blue' : 'text-bauhaus-black/40'
                  }`}>
                    <span className="hidden sm:inline">{s.title}</span>
                    <span className="sm:hidden">Step {i + 1}</span>
                  </span>
                </div>
                {i < displaySteps.length - 1 && <ChevronRight className="w-4 h-4 text-bauhaus-black/20 shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>

      {flowNotice && (
        <div role="alert" data-testid="flow-notice" className="mb-6 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-2xl px-4 py-3 text-sm font-bold text-bauhaus-black flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span className="break-words">{flowNotice}</span>
        </div>
      )}

      {/* ── 1. 閱讀文件 ── */}
      {phase === 'read' && (
        <div className="bh-card overflow-hidden" data-testid="read-phase">
          <div className="p-5 sm:p-6 border-b-2 border-bauhaus-black bg-bauhaus-paper flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold text-bauhaus-black">{currentStep?.title}</h2>
              <p className="text-sm text-bauhaus-black/60 mt-1">
                請仔細閱讀文件內容；可先下載範本留存。之後會再請你選擇簽約方式。
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleDownloadTemplate(currentStep.docType)}
              data-testid="download-template"
              className="bh-btn bh-btn-outline min-h-[44px] px-4 py-2 text-sm shrink-0 justify-center"
            >
              <Download className="w-4 h-4" /> 下載這份文件
            </button>
          </div>

          {downloadError && (
            <div role="alert" className="mx-4 sm:mx-6 mt-4 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl px-4 py-3 text-sm font-bold text-bauhaus-black">
              {downloadError}
            </div>
          )}

          <div className="p-4 sm:p-6">
            <DocumentViewer
              fileUrl={docUrls[currentStep?.docType]}
              onFinishReading={!isFillSign ? goNextFromRead : null}
              finishButtonText={isLastStep ? '我已看完，前往選擇簽約方式' : undefined}
            />
          </div>

          {isFillSign && (
            <div className="px-4 sm:px-6 pb-6">
              <div className="flex justify-between gap-3 pt-4 border-t-2 border-bauhaus-black/10">
                {step > 0 ? (
                  <button onClick={() => setStep(step - 1)}
                    className="bh-btn bh-btn-outline px-5 py-3 md:py-2.5 text-sm">
                    <ChevronLeft className="w-4 h-4" /> 上一步
                  </button>
                ) : <span />}
                <button onClick={goNextFromRead}
                  data-testid="read-next"
                  className="bh-btn bh-btn-blue px-5 py-3 md:py-2.5 text-sm ml-auto">
                  {isLastStep ? '前往選擇簽約方式' : '下一步'} <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
          {!isFillSign && step > 0 && (
            <div className="px-4 sm:px-6 pb-6">
              <button onClick={() => setStep(step - 1)}
                className="bh-btn bh-btn-outline px-5 py-3 md:py-2.5 text-sm">
                <ChevronLeft className="w-4 h-4" /> 上一步
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 2. 電子簽約同意 ── */}
      {phase === 'consent' && (
        <div className="bh-card overflow-hidden" data-testid="consent-page">
          <div className="p-5 sm:p-6 border-b-2 border-bauhaus-black bg-bauhaus-paper">
            <h2 className="text-lg sm:text-xl font-bold text-bauhaus-black">{consentCopy.title}</h2>
          </div>
          <div className="p-4 sm:p-6 space-y-4">
            <div className="space-y-3 text-sm sm:text-base leading-relaxed text-bauhaus-black font-medium">
              {consentCopy.paragraphs.map((paragraph, index) => (
                <p key={index} className="break-words"><Inline text={paragraph} /></p>
              ))}
            </div>

            <details open className="border-2 border-bauhaus-black/30 rounded-xl bg-bauhaus-paper" data-testid="privacy-notice">
              <summary className="cursor-pointer min-h-[44px] flex items-center px-4 text-sm font-black text-bauhaus-black">
                {consentCopy.privacy.title}
              </summary>
              <div className="px-4 pb-4 text-xs sm:text-sm leading-relaxed text-bauhaus-black/80 font-medium space-y-2">
                <p className="break-words">{consentCopy.privacy.intro}</p>
                <ul className="list-disc pl-5 space-y-1.5">
                  {consentCopy.privacy.items.map((item, index) => (
                    <li key={index} className="break-words"><Inline text={item} /></li>
                  ))}
                </ul>
                <p>{consentCopy.privacy.outro}</p>
              </div>
            </details>

            <label className="flex items-start gap-3 cursor-pointer bg-bauhaus-yellow border-2 border-bauhaus-black rounded-2xl p-4">
              <input
                type="checkbox"
                data-testid="consent-checkbox"
                checked={consentChecked}
                onChange={e => setConsentChecked(e.target.checked)}
                className="mt-0.5 w-6 h-6 shrink-0 rounded-none border-2 border-bauhaus-black accent-bauhaus-black focus:ring-bauhaus-black"
              />
              <span className="text-sm font-medium text-bauhaus-black break-words">{consentCopy.checkboxLabel}</span>
            </label>

            {consentError && (
              <div role="alert" data-testid="consent-error" className="bg-red-50 border-2 border-bauhaus-red rounded-xl px-4 py-3 text-sm font-bold text-bauhaus-red flex items-start gap-2">
                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span className="break-words">{consentError}</span>
              </div>
            )}

            {/* 兩顆按鈕一樣大、一樣醒目：不同意不是藏起來的小連結 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                data-testid="consent-agree"
                onClick={handleAgree}
                disabled={!consentChecked || consentBusy}
                className="bh-btn bh-btn-blue min-h-[56px] px-4 py-3 text-sm sm:text-base justify-center disabled:opacity-50"
              >
                {consentBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                {consentCopy.agreeButton}
              </button>
              <button
                type="button"
                data-testid="consent-decline"
                onClick={() => { setConsentError(''); setShowDeclineConfirm(true); }}
                disabled={consentBusy}
                className="bh-btn bh-btn-yellow min-h-[56px] px-4 py-3 text-sm sm:text-base justify-center disabled:opacity-50"
              >
                <FileText className="w-4 h-4" />
                {consentCopy.declineButton}
              </button>
            </div>

            <div className="pt-2">
              <button onClick={() => { setPhase('read'); }}
                className="bh-btn bh-btn-outline px-5 py-3 md:py-2.5 text-sm">
                <ChevronLeft className="w-4 h-4" /> 回到文件
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 選擇紙本之後 ── */}
      {phase === 'declined' && (() => {
        const paper = buildPaperPendingCopy({ docList });
        return (
          <div className="bh-card overflow-hidden" data-testid="paper-flow">
            <div className="p-5 sm:p-6 border-b-2 border-bauhaus-black bg-bauhaus-paper">
              <h2 className="text-lg sm:text-xl font-bold text-bauhaus-black flex items-center gap-2">
                <FileCheck className="w-5 h-5 text-bauhaus-blue shrink-0" /> {paper.title}
              </h2>
            </div>
            <div className="p-4 sm:p-6 space-y-3 text-sm sm:text-base font-medium text-bauhaus-black leading-relaxed">
              {paper.body.map((line, index) => <p key={index} className="break-words">{line}</p>)}
              <div className="flex flex-col sm:flex-row gap-3 pt-4">
                <button onClick={() => navigate('/profile')} className="bh-btn bh-btn-blue min-h-[48px] px-6 py-3 text-sm justify-center">
                  返回個人資料
                </button>
                <button
                  onClick={() => { setConsentChecked(false); setPhase('consent'); }}
                  className="bh-btn bh-btn-outline min-h-[48px] px-6 py-3 text-sm justify-center"
                >
                  改變主意，回到簽約方式
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── 3. 填資料、Email 驗證、簽名、確認簽署 ── */}
      {phase === 'sign' && (
        <div className="bh-card overflow-hidden" data-testid="sign-phase">
          <div className="p-5 sm:p-6 border-b-2 border-bauhaus-black bg-bauhaus-paper">
            <h2 className="text-lg sm:text-xl font-bold text-bauhaus-black">驗證與簽署</h2>
            <p className="text-sm text-bauhaus-black/60 mt-1">
              確認契約資料 → 驗證信箱 → 手寫簽名 → 確認簽署
            </p>
          </div>

          <div className="px-4 sm:px-6 py-6">
            <h3 className="text-lg font-bold text-bauhaus-black mb-4 flex items-center gap-2">
              <PenTool className="w-5 h-5 text-bauhaus-blue" /> 填寫契約資料
            </h3>

            {roleMissing && (
              <div className="mb-5 border-2 border-bauhaus-black bg-bauhaus-red rounded-2xl p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-white shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-white">尚無法簽署：您的講師等級尚未設定</p>
                  <p className="text-sm text-white/90 mt-1">
                    講師等級由系統依您的資料自動帶入，目前為空白，屬於缺少前置資料（非您操作錯誤）。
                    請聯繫管理員設定講師等級後，再回來完成簽署。
                  </p>
                </div>
              </div>
            )}

            {missingSigTitles.length > 0 && (
              <div className="mb-5 border-2 border-bauhaus-black bg-bauhaus-red rounded-2xl p-4 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-white shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-white">尚無法簽署：合約尚未設定簽名欄位</p>
                  <p className="text-sm text-white/90 mt-1">
                    以下文件尚未由管理員設定簽名欄位位置，若強行簽署會產生沒有簽名的無效合約：
                    「{missingSigTitles.join('、')}」。請聯繫管理員設定後再簽署。
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
              <div>
                <label className="bh-label mb-1.5 flex items-center gap-1.5">
                  <User className="w-4 h-4 text-bauhaus-black/40" /> 立契約書人（甲方姓名）<span className="text-bauhaus-red">*</span>
                </label>
                <input type="text" value={formData.name} onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  autoComplete="name"
                  className="bh-input"
                  placeholder="請輸入姓名" />
              </div>
              <div>
                <label className="bh-label mb-1.5 flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-bauhaus-black/40" /> 講師等級<span className="text-bauhaus-red">*</span>
                </label>
                <input type="text" value={formData.instructorRole} readOnly
                  className="bh-input !bg-bauhaus-muted !text-bauhaus-black/60 !cursor-not-allowed" placeholder="由系統自動帶入" />
                <p className="text-xs text-bauhaus-black/40 mt-1">此欄位由系統帶入，如需調整請聯繫管理員</p>
              </div>
              <div>
                <label className="bh-label mb-1.5 flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4 text-bauhaus-black/40" /> 身分證字號<span className="text-bauhaus-red">*</span>
                </label>
                <input type="text" value={formData.idNumber}
                  onChange={e => { const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); setFormData(p => ({ ...p, idNumber: v })); }}
                  maxLength={10}
                  autoComplete="off"
                  className="bh-input font-mono tracking-wider"
                  placeholder="A123456789" />
                <p className="text-xs text-bauhaus-black/40 mt-1">共 10 碼英數字元（{formData.idNumber.length}/10）</p>
              </div>
              <div>
                <label className="bh-label mb-1.5 flex items-center gap-1.5">
                  <MapPin className="w-4 h-4 text-bauhaus-black/40" /> 地址<span className="text-bauhaus-red">*</span>
                </label>
                <input type="text" value={formData.address} onChange={e => setFormData(p => ({ ...p, address: e.target.value }))}
                  autoComplete="street-address"
                  className="bh-input"
                  placeholder="請輸入通訊地址" />
              </div>
              <div className="sm:col-span-2">
                <label className="bh-label mb-1.5 flex items-center gap-1.5">
                  <Phone className="w-4 h-4 text-bauhaus-black/40" /> 電話<span className="text-bauhaus-red">*</span>
                </label>
                <input type="tel" value={formData.phone} onChange={e => setFormData(p => ({ ...p, phone: e.target.value }))}
                  inputMode="tel" autoComplete="tel"
                  className="bh-input"
                  placeholder="請輸入聯絡電話" />
              </div>
            </div>

            <div className="mb-6 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-2xl p-4">
              <label className="flex items-start gap-3 cursor-pointer group">
                <input type="checkbox" data-testid="read-ack-checkbox" checked={readAck} onChange={e => setReadAck(e.target.checked)}
                  className="mt-0.5 w-6 h-6 shrink-0 rounded-none border-2 border-bauhaus-black accent-bauhaus-black focus:ring-bauhaus-black" />
                <span className="text-sm font-medium text-bauhaus-black break-words">{readAckCopy.label}</span>
              </label>
            </div>

            {/* Email 身分驗證：驗證碼寄到公司已確認的信箱（不是 Google 登入信箱） */}
            <div
              data-testid="contract-otp-card"
              className={`mb-6 p-5 border-2 border-bauhaus-black rounded-2xl shadow-hard ${otpValid ? 'bg-bauhaus-blue' : 'bg-white'}`}
            >
              {otpValid ? (
                <div className="flex items-start gap-3">
                  <div className="w-11 h-11 rounded-full bg-white border-2 border-bauhaus-black flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-6 h-6 text-bauhaus-blue" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-black text-white">本人身分已驗證</p>
                    <OtpValidityNote verifiedAtMs={otp.verifiedAtMs} onExpire={handleOtpExpire} />
                    <button
                      type="button"
                      onClick={() => { setOtp(null); setShowOtpDialog(true); }}
                      className="mt-1 text-xs font-bold text-white underline min-h-[44px] md:min-h-0 py-2 md:py-0"
                    >
                      重新驗證
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h4 className="text-sm font-black text-bauhaus-black mb-1 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-bauhaus-blue" /> 本人身分驗證
                  </h4>
                  <p className="text-xs text-bauhaus-black/60 mb-4">
                    為確認是本人簽署，簽名前需先驗證信箱。系統會寄一組 6 碼驗證碼到公司已確認的信箱{maskedEmail ? `（${maskedEmail}）` : ''}；驗證通過後需在 {CONTRACT_OTP_VALID_MINUTES} 分鐘內完成簽署。
                  </p>
                  {otpNotice && (
                    <p role="alert" data-testid="otp-notice-inline" className="mb-3 text-xs font-bold text-bauhaus-red flex items-start gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {otpNotice}
                    </p>
                  )}
                  <button
                    type="button"
                    data-testid="send-otp"
                    onClick={() => { setOtpNotice(''); setShowOtpDialog(true); }}
                    className="bh-btn bh-btn-blue w-full sm:w-auto min-h-[48px] px-5 py-3 text-sm justify-center"
                  >
                    <Mail className="w-4 h-4" /> 寄送驗證碼到我的信箱
                  </button>
                </>
              )}
            </div>

            <div className="mb-6">
              <h4 className="text-sm font-bold text-bauhaus-black mb-3">講師簽名</h4>
              {signatureDataUrl ? (
                <div className="border-2 border-bauhaus-black rounded-xl bg-white p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="bh-chip bg-bauhaus-blue text-white">
                      <CheckCircle2 className="w-3.5 h-3.5" /> 已簽名
                    </span>
                    <button onClick={() => { setSignatureDataUrl(null); setShowSignaturePad(true); }}
                      className="text-sm text-bauhaus-blue hover:text-bauhaus-black font-bold py-3 px-2 md:py-0 md:px-0">重新簽名</button>
                  </div>
                  <div className="bg-white border-2 border-bauhaus-black/10 rounded-lg p-3">
                    <img src={signatureDataUrl} alt="簽名" className="max-h-24 mx-auto" />
                  </div>
                </div>
              ) : (
                <button onClick={() => setShowSignaturePad(true)}
                  data-testid="open-signature"
                  disabled={!readAck || !otpValid}
                  className={`w-full py-8 border-2 border-dashed rounded-xl transition-all flex flex-col items-center gap-2 ${
                    readAck && otpValid
                      ? 'border-bauhaus-blue bg-white hover:bg-bauhaus-cream cursor-pointer text-bauhaus-blue'
                      : 'border-bauhaus-black/20 bg-bauhaus-muted text-bauhaus-black/40 cursor-not-allowed'
                  }`}>
                  <PenTool className="w-8 h-8" />
                  <span className="font-bold px-2 text-center">
                    {!readAck
                      ? '請先勾選上方「已完整閱讀」'
                      : !otpValid
                        ? '請先完成上方 Email 身分驗證'
                        : '點擊此處進行簽名'}
                  </span>
                </button>
              )}
            </div>

            {/* 最後確認句（esign-final-confirm-v1）緊貼在「確認簽署」按鈕正上方 */}
            <div className="pt-4 border-t-2 border-bauhaus-black/10">
              <div data-testid="final-confirm" className="mb-4 border-2 border-bauhaus-black rounded-2xl bg-bauhaus-cream p-4 text-sm font-medium text-bauhaus-black leading-relaxed">
                <p className="font-black mb-2">{finalConfirm.lead}</p>
                <ul className="list-disc pl-5 space-y-1">
                  {finalConfirm.items.map((item, index) => <li key={index} className="break-words">{item}</li>)}
                </ul>
                <p className="mt-2 break-words">{finalConfirm.outro}</p>
              </div>

              {submitError && (
                <div role="alert" data-testid="submit-error" className="mb-4 bg-red-50 border-2 border-bauhaus-red rounded-xl px-4 py-3 text-sm font-bold text-bauhaus-red flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" /> <span className="break-words">{submitError}</span>
                </div>
              )}

              {!canSubmit && outstandingItems.length > 0 && (
                <p data-testid="submit-missing" className="mb-3 text-xs font-bold text-bauhaus-black/60">
                  還需要：{outstandingItems.join('、')}
                </p>
              )}

              <div className="flex flex-col-reverse sm:flex-row gap-3 items-center justify-between">
                <button onClick={() => setPhase('consent')} disabled={submitting}
                  className="bh-btn bh-btn-outline px-5 py-3 md:py-2.5 text-sm w-full sm:w-auto justify-center">
                  <ChevronLeft className="w-4 h-4" /> 上一步
                </button>
                <button onClick={handleSubmit} disabled={!canSubmit || submitting}
                  data-testid="submit-contract"
                  className="bh-btn bh-btn-blue min-h-[48px] px-8 py-3 text-sm w-full sm:w-auto justify-center">
                  {submitting ? (
                    <><div className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> 簽約中...</>
                  ) : (
                    <><CheckCircle2 className="w-4 h-4" /> {finalConfirm.button}</>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 不同意電子簽約：確認視窗（esign-decline-paper-v1） */}
      {showDeclineConfirm && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-bauhaus-black/60 sm:p-4" data-testid="decline-dialog">
          <div role="dialog" aria-modal="true" aria-labelledby="decline-title"
            className="w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto bg-white border-2 lg:border-4 border-bauhaus-black rounded-t-2xl sm:rounded-2xl shadow-hard-lg p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3 mb-3">
              <h2 id="decline-title" className="text-lg font-black text-bauhaus-black">{declineCopy.title}</h2>
              <button type="button" onClick={() => setShowDeclineConfirm(false)} disabled={consentBusy} aria-label="關閉"
                className="shrink-0 w-11 h-11 -mt-2 -mr-2 flex items-center justify-center text-bauhaus-black/50 hover:text-bauhaus-black">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="space-y-3 text-sm font-medium text-bauhaus-black leading-relaxed">
              <p className="break-words">{declineCopy.intro}</p>
              <p>{declineCopy.lead}</p>
              <ol className="list-decimal pl-5 space-y-1.5">
                {declineCopy.steps.map((line, index) => <li key={index} className="break-words">{line}</li>)}
              </ol>
              <p className="break-words">{declineCopy.outro}</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-5">
              <button type="button" onClick={() => setShowDeclineConfirm(false)} disabled={consentBusy}
                className="bh-btn bh-btn-outline min-h-[48px] px-4 py-3 text-sm justify-center">
                {declineCopy.backButton}
              </button>
              <button type="button" data-testid="decline-confirm" onClick={handleConfirmDecline} disabled={consentBusy}
                className="bh-btn bh-btn-yellow min-h-[48px] px-4 py-3 text-sm justify-center">
                {consentBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {declineCopy.confirmButton}
              </button>
            </div>
          </div>
        </div>
      )}

      {showOtpDialog && (
        <EmailOtpDialog
          purpose={OTP_PURPOSES.CONTRACT}
          onClose={() => setShowOtpDialog(false)}
          onVerified={handleOtpVerified}
        />
      )}

      <SignaturePadComponent
        isOpen={showSignaturePad}
        onConfirm={handleSignatureConfirm}
        onCancel={() => setShowSignaturePad(false)}
      />
    </div>
  );
};

export default ContractSigningFlow;
