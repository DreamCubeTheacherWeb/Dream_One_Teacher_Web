import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { fetchContractFileBytes } from '../lib/contractFiles';
import {
  compareHashMaps,
  consentDecisionLabel,
  contractStatusLabel,
  deliveryKindLabel,
  deliveryStatusLabel,
  formatTaipeiTime,
  isSha256Hex,
  sha256Hex,
  shortHash,
  summarizeIntegrity,
} from '../lib/esign';
import { AlertCircle, CheckCircle2, FileSearch, Link2, Loader2, ShieldCheck, XCircle } from 'lucide-react';

/*
 * 後台「簽署證據」：一份已簽契約背後留存的所有證據，並可事後驗證沒被動過。
 *   - 同意紀錄（contract_consent_records）、OTP 驗證時間、IP／裝置、範本與成品的 SHA-256、證據雜湊鏈
 *   - 寄送紀錄（email_delivery_log，依 related_contract_id）
 *   - 「驗證檔案完整性」：重新下載已簽 PDF 與當時的範本，重算 SHA-256 和簽署當下存下的比對
 *   - 「驗證證據鏈」：admin_verify_contract_evidence_chain（整條鏈，不只這一份）
 * 介面契約：docs/specs/2026-10-20-claim-activation-esign.md §1.2／§1.4
 */

const Row = ({ label, children }) => (
  <div className="flex flex-col sm:flex-row sm:gap-3 py-1.5 border-b border-bauhaus-black/10 last:border-b-0">
    <dt className="text-xs font-bold text-bauhaus-black/50 sm:w-36 shrink-0">{label}</dt>
    <dd className="text-sm text-bauhaus-black min-w-0 break-words">{children}</dd>
  </div>
);

const Hash = ({ value }) => (
  value
    ? <code title={value} className="font-mono text-[11px] break-all text-bauhaus-black/80">{value}</code>
    : <span className="text-bauhaus-black/40">—</span>
);

const HashMap = ({ map, docNames }) => {
  const entries = Object.entries(map || {});
  if (entries.length === 0) return <span className="text-bauhaus-black/40">—</span>;
  return (
    <ul className="space-y-1.5">
      {entries.map(([docType, hash]) => (
        <li key={docType}>
          <div className="text-xs font-bold text-bauhaus-black/60">{docNames[docType] || docType}</div>
          <Hash value={hash} />
        </li>
      ))}
    </ul>
  );
};

const ContractEvidencePanel = ({ contract, docNames = {} }) => {
  const [state, setState] = useState({ loading: true, error: '', evidence: null, consent: null, deliveries: [] });
  const [integrity, setIntegrity] = useState(null); // { running, results, summary, error }
  const [chain, setChain] = useState(null); // { running, result, error }

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: '' }));
    try {
      const { data: evidenceRows, error: evidenceError } = await supabase
        .from('contract_signing_evidence')
        .select('*')
        .eq('contract_id', contract.id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (evidenceError) throw evidenceError;
      const evidence = evidenceRows?.[0] || null;

      let consent = null;
      const consentId = evidence?.consent_id || contract.consent_id;
      if (consentId) {
        const { data: consentRows } = await supabase
          .from('contract_consent_records')
          .select('*')
          .eq('id', consentId)
          .limit(1);
        consent = consentRows?.[0] || null;
      }

      const { data: deliveries } = await supabase
        .from('email_delivery_log')
        .select('id, kind, to_email, subject, requested_at, status, http_status, provider_message_id, error_text')
        .eq('related_contract_id', contract.id)
        .order('requested_at', { ascending: false });

      setState({ loading: false, error: '', evidence, consent, deliveries: deliveries || [] });
    } catch (error) {
      setState({ loading: false, error: error?.message || '讀取失敗', evidence: null, consent: null, deliveries: [] });
    }
  }, [contract.id, contract.consent_id]);

  useEffect(() => {
    const timer = window.setTimeout(load, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const { evidence, consent, deliveries } = state;

  const verifyFiles = async () => {
    if (!evidence || integrity?.running) return;
    setIntegrity({ running: true, results: [], summary: null, error: '' });
    const results = [];
    const nameOf = (docType) => docNames[docType] || docType;

    try {
      // 1) 已簽署成品 PDF：重新下載 → 重算 → 和簽署當下存下的成品雜湊比對
      for (const [docType, expected] of Object.entries(evidence.signed_pdf_sha256 || {})) {
        const path = (evidence.signed_pdf_paths || {})[docType];
        const label = `${nameOf(docType)}・已簽署成品`;
        if (!path) { results.push({ label, ok: false, expected, actual: '', note: '證據裡沒有這份成品的檔案路徑' }); continue; }
        try {
          const actual = await sha256Hex(await fetchContractFileBytes(path));
          results.push({ label, ok: actual === String(expected).toLowerCase(), expected, actual });
        } catch (error) {
          results.push({ label, ok: false, expected, actual: '', note: `檔案無法讀取：${error.message}` });
        }
      }

      // 2) 簽署當時的範本：依證據記的版本找到範本檔 → 重算 → 和簽署當下存下的範本雜湊比對
      for (const [docType, expected] of Object.entries(evidence.document_sha256 || {})) {
        const version = (evidence.doc_versions || {})[docType];
        const label = `${nameOf(docType)}・範本${version !== undefined ? `（第 ${version} 版）` : ''}`;
        const { data: docRows } = await supabase
          .from('contract_documents')
          .select('file_path, content_sha256')
          .eq('doc_type', docType)
          .eq('version', version)
          .limit(1);
        const doc = docRows?.[0];
        if (!doc?.file_path) { results.push({ label, ok: false, expected, actual: '', note: '找不到當時版本的範本紀錄' }); continue; }
        try {
          const actual = await sha256Hex(await fetchContractFileBytes(doc.file_path));
          const matchesEvidence = actual === String(expected).toLowerCase();
          const matchesRegistered = !doc.content_sha256 || actual === String(doc.content_sha256).toLowerCase();
          results.push({
            label,
            ok: matchesEvidence && matchesRegistered,
            expected,
            actual,
            note: matchesEvidence && !matchesRegistered ? '範本檔與上傳時登錄的雜湊不同' : '',
          });
        } catch (error) {
          results.push({ label, ok: false, expected, actual: '', note: `檔案無法讀取：${error.message}` });
        }
      }

      // 3) 契約列上的成品雜湊要和證據列一致（兩邊其中一邊被改動就會露餡）
      if (contract.signed_pdf_sha256 && evidence.signed_pdf_sha256) {
        const compared = compareHashMaps(evidence.signed_pdf_sha256, contract.signed_pdf_sha256);
        results.push({
          label: '契約列與證據列的成品雜湊',
          ok: compared.ok,
          expected: '',
          actual: '',
          note: compared.ok ? '' : `不一致：${[...compared.mismatched, ...compared.missing].join('、')}`,
        });
      }

      setIntegrity({ running: false, results, summary: summarizeIntegrity(results), error: '' });
    } catch (error) {
      setIntegrity({ running: false, results, summary: null, error: error?.message || '驗證過程發生錯誤' });
    }
  };

  const verifyChain = async () => {
    if (chain?.running) return;
    setChain({ running: true, result: null, error: '' });
    try {
      const { data, error } = await supabase.rpc('admin_verify_contract_evidence_chain');
      if (error) throw error;
      setChain({ running: false, result: data, error: '' });
    } catch (error) {
      setChain({ running: false, result: null, error: error?.message || '驗證失敗' });
    }
  };

  if (state.loading) {
    return <div className="py-6 text-center text-sm font-bold text-bauhaus-black/50 flex items-center justify-center gap-2" role="status"><Loader2 className="w-4 h-4 animate-spin" /> 讀取簽署證據中…</div>;
  }

  if (state.error) {
    return <div role="alert" className="py-3 text-sm font-bold text-bauhaus-red">讀取簽署證據失敗：{state.error}</div>;
  }

  return (
    <div data-testid="evidence-panel" className="space-y-5">
      {!evidence ? (
        <div className="bg-bauhaus-yellow/20 border-2 border-bauhaus-black rounded-xl p-3 text-sm font-medium text-bauhaus-black flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>這份契約沒有簽署證據紀錄（可能是電子簽約證據功能上線前簽署的舊契約）。</span>
        </div>
      ) : (
        <>
          <section>
            <h4 className="text-sm font-black text-bauhaus-black mb-1 flex items-center gap-1.5"><ShieldCheck className="w-4 h-4 text-bauhaus-blue" /> 簽署紀錄</h4>
            <dl>
              <Row label="契約狀態">{contractStatusLabel(contract.status)}{contract.status === 'voided' && contract.voided_at ? `（${formatTaipeiTime(contract.voided_at)}${contract.voided_reason ? `：${contract.voided_reason}` : ''}）` : ''}</Row>
              <Row label="簽署時間（伺服器）">{formatTaipeiTime(evidence.signed_at, { seconds: true })}</Row>
              <Row label="綁定 Email">{evidence.bound_email || '—'}</Row>
              <Row label="IP 位址">{evidence.ip_address || '—'}</Row>
              <Row label="裝置／瀏覽器">{evidence.user_agent || '—'}</Row>
              <Row label="文件版本">
                {Object.entries(evidence.doc_versions || {}).map(([docType, version]) => `${docNames[docType] || docType}：第 ${version} 版`).join('、') || '—'}
              </Row>
            </dl>
          </section>

          <section>
            <h4 className="text-sm font-black text-bauhaus-black mb-1">電子簽約同意與 Email 驗證</h4>
            <dl>
              <Row label="同意選擇">{consent ? consentDecisionLabel(consent.decision) : '—（查無同意紀錄）'}</Row>
              <Row label="同意時間">{formatTaipeiTime(consent?.created_at || evidence.consent_at, { seconds: true }) || '—'}</Row>
              <Row label="同意文案版本">{consent?.consent_text_version || '—'}</Row>
              {consent?.consent_text && (
                <Row label="同意當下全文">
                  <details>
                    <summary className="cursor-pointer text-bauhaus-blue font-bold min-h-[44px] sm:min-h-0 flex items-center">展開全文</summary>
                    <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-bauhaus-black/80 font-sans">{consent.consent_text}</pre>
                  </details>
                </Row>
              )}
              <Row label="Email 驗證時間">{formatTaipeiTime(evidence.otp_verified_at, { seconds: true }) || '—'}</Row>
              <Row label="驗證碼識別">{evidence.otp_challenge_id ? <code className="font-mono text-[11px] break-all">{evidence.otp_challenge_id}</code> : '—'}</Row>
            </dl>
          </section>

          <section>
            <h4 className="text-sm font-black text-bauhaus-black mb-1">檔案指紋（SHA-256）與證據鏈</h4>
            <dl>
              <Row label="範本（簽署當時）"><HashMap map={evidence.document_sha256} docNames={docNames} /></Row>
              <Row label="已簽署成品"><HashMap map={evidence.signed_pdf_sha256} docNames={docNames} /></Row>
              <Row label="前一筆證據雜湊"><Hash value={evidence.previous_evidence_sha256} /></Row>
              <Row label="本筆證據雜湊"><Hash value={evidence.evidence_sha256} /></Row>
            </dl>
          </section>
        </>
      )}

      <section>
        <h4 className="text-sm font-black text-bauhaus-black mb-1">通知信寄送紀錄</h4>
        {deliveries.length === 0 ? (
          <p className="text-sm text-bauhaus-black/50 font-medium">沒有寄送紀錄。</p>
        ) : (
          <ul className="space-y-2" data-testid="delivery-log">
            {deliveries.map((delivery) => (
              <li key={delivery.id} className="border-2 border-bauhaus-black/20 rounded-xl p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`bh-chip ${delivery.status === 'sent' ? 'bg-bauhaus-blue text-white' : delivery.status === 'queued' ? 'bg-bauhaus-yellow text-bauhaus-black' : 'bg-bauhaus-red text-white'}`}>
                    {deliveryStatusLabel(delivery.status)}
                  </span>
                  <span className="font-bold">{deliveryKindLabel(delivery.kind)}</span>
                  <span className="text-xs text-bauhaus-black/60">{formatTaipeiTime(delivery.requested_at, { seconds: true })}</span>
                </div>
                <div className="text-xs text-bauhaus-black/70 mt-1 break-all">
                  寄給 {delivery.to_email}
                  {delivery.http_status ? `・HTTP ${delivery.http_status}` : ''}
                  {delivery.provider_message_id ? `・服務商編號 ${delivery.provider_message_id}` : ''}
                </div>
                {delivery.error_text && <div className="text-xs font-bold text-bauhaus-red mt-1 break-words">{delivery.error_text}</div>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="border-t-2 border-bauhaus-black/10 pt-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <button
            type="button"
            onClick={verifyFiles}
            disabled={!evidence || integrity?.running}
            data-testid="verify-files"
            className="bh-btn bh-btn-blue min-h-[44px] px-4 py-2 text-sm justify-center"
          >
            {integrity?.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSearch className="w-4 h-4" />}
            驗證檔案完整性
          </button>
          <button
            type="button"
            onClick={verifyChain}
            disabled={chain?.running}
            data-testid="verify-chain"
            className="bh-btn bh-btn-outline min-h-[44px] px-4 py-2 text-sm justify-center"
          >
            {chain?.running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
            驗證證據鏈
          </button>
        </div>

        {integrity && !integrity.running && (
          <div data-testid="integrity-result" className="mt-3">
            {integrity.error && <p role="alert" className="text-sm font-bold text-bauhaus-red">驗證中斷：{integrity.error}</p>}
            {integrity.summary && (
              <p className={`text-sm font-black flex items-center gap-1.5 ${integrity.summary.ok ? 'text-bauhaus-blue' : 'text-bauhaus-red'}`}>
                {integrity.summary.ok ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                {integrity.summary.ok
                  ? `檔案完整性：一致（${integrity.summary.total} 項檢查全部通過）`
                  : `檔案完整性：不一致（${integrity.summary.failed.length}/${integrity.summary.total} 項有問題）`}
              </p>
            )}
            <ul className="mt-2 space-y-1.5">
              {integrity.results.map((item) => (
                <li key={item.label} className={`text-xs border-l-4 pl-2 ${item.ok ? 'border-bauhaus-blue' : 'border-bauhaus-red'}`}>
                  <div className="font-bold text-bauhaus-black">{item.ok ? '一致' : '不一致'}・{item.label}</div>
                  {item.note && <div className="text-bauhaus-red font-bold break-words">{item.note}</div>}
                  {!item.ok && isSha256Hex(item.actual) && (
                    <div className="text-bauhaus-black/60 break-all">證據記錄 {shortHash(item.expected)}／現在重算 {shortHash(item.actual)}</div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {chain && !chain.running && (
          <div data-testid="chain-result" className="mt-3">
            {chain.error && <p role="alert" className="text-sm font-bold text-bauhaus-red">證據鏈驗證失敗：{chain.error}</p>}
            {chain.result && (
              <p className={`text-sm font-black flex items-start gap-1.5 ${chain.result.ok ? 'text-bauhaus-blue' : 'text-bauhaus-red'}`}>
                {chain.result.ok ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
                <span className="break-words">
                  {chain.result.ok
                    ? `證據鏈：完整（共檢查 ${chain.result.checked} 筆，沒有被改動的痕跡）`
                    : `證據鏈：有斷裂（共檢查 ${chain.result.checked} 筆，第一筆有問題的證據編號 ${chain.result.first_broken_id}）`}
                </span>
              </p>
            )}
            <p className="text-xs text-bauhaus-black/50 mt-1">證據鏈驗證的是全部簽署證據，不只這一份。</p>
          </div>
        )}
      </section>
    </div>
  );
};

export default ContractEvidencePanel;
