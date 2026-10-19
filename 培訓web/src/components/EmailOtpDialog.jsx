import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  describeOtpRpcError,
  formatCountdown,
  getOtpPurposeText,
  interpretRequestResult,
  interpretVerifyResult,
  isOtpComplete,
  normalizeOtpInput,
  secondsUntil,
  secondsUntilIso,
} from '../lib/emailOtp';
import { AlertCircle, CheckCircle2, Loader2, Mail, MailCheck, RefreshCw, ShieldCheck, X } from 'lucide-react';

/**
 * Email 驗證碼視窗（帳號啟用、簽約前身分驗證共用）。
 *
 * 父層用 `{open && <EmailOtpDialog ... />}` 控制開關：掛載時自動呼叫 request_email_otp 寄出驗證碼
 * （使用者按下的那顆按鈕就是「寄送」的同意）。驗證碼只寄到「公司已確認」的 Email，
 * 畫面只顯示遮罩後的信箱（伺服器回傳 masked_email）。
 *
 * props:
 *   - purpose：'account_activation'｜'contract_sign'（見 lib/emailOtp.js 的 OTP_PURPOSES）
 *   - onClose()：使用者按取消／關閉
 *   - onVerified({ challengeId, verifiedAt, activated, maskedEmail })：驗證成功
 *
 * 介面契約：docs/specs/2026-10-20-claim-activation-esign.md §1.4
 */
const EmailOtpDialog = ({ purpose, onClose, onVerified }) => {
  const copy = getOtpPurposeText(purpose);

  // phase：sending（寄送中）｜ready（可輸入或等待重寄）｜blocked（不能寄，要找行政人員等）｜error｜verified
  const [phase, setPhase] = useState('sending');
  const [challenge, setChallenge] = useState(null); // { id, expiresAt, maskedEmail, dead }
  const [maskedEmail, setMaskedEmail] = useState(null);
  const [resendAt, setResendAt] = useState(0);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [notice, setNotice] = useState(null); // { type: 'info'|'error', text }
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(false);
  const startedRef = useRef(false);
  const inputRef = useRef(null);
  const sendingRef = useRef(false);
  const verifyingRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // 每秒更新一次，驅動「有效時間」與「可重寄」倒數
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 視窗開著時鎖住背景捲動
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);

  const requestCode = useCallback(async () => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setPhase('sending');
    setNotice(null);
    setCode('');
    try {
      const { data, error } = await supabase.rpc('request_email_otp', { p_purpose: purpose });
      if (!aliveRef.current) return;
      if (error) {
        setPhase('error');
        setNotice({ type: 'error', text: describeOtpRpcError(error) });
        return;
      }
      const result = interpretRequestResult(data);
      const clock = Date.now();
      setNow(clock);

      if (result.kind === 'sent') {
        setChallenge({ id: result.challengeId, expiresAt: result.expiresAt, maskedEmail: result.maskedEmail, dead: false });
        setMaskedEmail(result.maskedEmail);
        setResendAt(clock + result.retryAfterSeconds * 1000);
        setPhase('ready');
        setNotice({
          type: 'info',
          text: `驗證碼已寄到 ${result.maskedEmail || '公司已確認的信箱'}，請查收（含垃圾郵件匣）。`,
        });
      } else if (result.kind === 'cooldown') {
        setResendAt(clock + result.retryAfterSeconds * 1000);
        setPhase('ready');
        if (result.challengeId) {
          // 資料庫在冷卻回覆裡帶回進行中的驗證碼，就接著輸入
          setChallenge({ id: result.challengeId, expiresAt: result.expiresAt, maskedEmail: result.maskedEmail, dead: false });
          if (result.maskedEmail) setMaskedEmail(result.maskedEmail);
        } else {
          setChallenge(null);
        }
        setNotice({ type: 'info', text: result.message });
      } else {
        setPhase(result.kind === 'blocked' ? 'blocked' : 'error');
        setNotice({ type: 'error', text: result.message });
      }
    } catch (error) {
      if (!aliveRef.current) return;
      setPhase('error');
      setNotice({ type: 'error', text: describeOtpRpcError(error) });
    } finally {
      sendingRef.current = false;
    }
  }, [purpose]);

  // 掛載時自動寄一次（ref 防呆：StrictMode 開發模式會連跑兩次 effect，不能寄兩封）
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    requestCode();
  }, [requestCode]);

  const expiresIn = challenge?.expiresAt ? secondsUntilIso(challenge.expiresAt, now) : 0;
  const expired = Boolean(challenge) && !challenge.dead && challenge.expiresAt ? expiresIn <= 0 : false;
  const canType = phase === 'ready' && Boolean(challenge) && !challenge.dead && !expired && !verifying;
  const resendIn = secondsUntil(resendAt, now);
  const canResend = (phase === 'ready' || phase === 'error') && resendIn <= 0 && !verifying;

  // 進入可輸入狀態時把游標放進輸入框
  useEffect(() => {
    if (canType) inputRef.current?.focus();
  }, [canType, challenge?.id]);

  const submit = async (event) => {
    event?.preventDefault();
    if (!canType || verifyingRef.current || !isOtpComplete(code)) return;
    verifyingRef.current = true;
    setVerifying(true);
    setNotice(null);
    try {
      const { data, error } = await supabase.rpc('verify_email_otp', {
        p_challenge_id: challenge.id,
        p_code: normalizeOtpInput(code),
      });
      if (!aliveRef.current) return;
      if (error) {
        setNotice({ type: 'error', text: describeOtpRpcError(error) });
        return;
      }
      const result = interpretVerifyResult(data);
      if (result.kind === 'verified') {
        setPhase('verified');
        onVerified?.({
          challengeId: challenge.id,
          verifiedAt: result.verifiedAt,
          activated: result.activated,
          maskedEmail: maskedEmail,
        });
        return;
      }
      setCode('');
      setNotice({ type: 'error', text: result.message });
      if (result.kind === 'dead') {
        setChallenge((current) => (current ? { ...current, dead: true } : current));
      }
    } catch (error) {
      if (!aliveRef.current) return;
      setNotice({ type: 'error', text: describeOtpRpcError(error) });
    } finally {
      verifyingRef.current = false;
      if (aliveRef.current) setVerifying(false);
    }
  };

  const busy = verifying || phase === 'verified';
  const close = () => { if (!busy) onClose?.(); };

  // Esc 關閉
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !verifyingRef.current && phase !== 'verified') onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, phase]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-bauhaus-black/60 sm:p-4"
      data-testid="email-otp-dialog"
      onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-otp-title"
        className="w-full sm:max-w-md max-h-[92dvh] overflow-y-auto bg-white border-2 lg:border-4 border-bauhaus-black rounded-t-2xl sm:rounded-2xl shadow-hard-lg p-5 sm:p-6"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 id="email-otp-title" className="text-lg font-black text-bauhaus-black flex items-center gap-2 min-w-0">
            <ShieldCheck className="w-5 h-5 text-bauhaus-blue shrink-0" />
            <span>{copy.title}</span>
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="關閉"
            className="shrink-0 w-11 h-11 -mt-2 -mr-2 flex items-center justify-center text-bauhaus-black/50 hover:text-bauhaus-black disabled:opacity-30"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {phase === 'sending' && (
          <div className="py-8 flex flex-col items-center gap-3 text-bauhaus-black/70 font-bold" role="status">
            <Loader2 className="w-8 h-8 animate-spin text-bauhaus-blue" />
            <span>正在寄送驗證碼…</span>
          </div>
        )}

        {phase === 'verified' && (
          <div className="py-8 flex flex-col items-center gap-3 text-center" role="status">
            <div className="w-14 h-14 rounded-full bg-bauhaus-blue border-2 border-bauhaus-black flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7 text-white" />
            </div>
            <p className="font-black text-bauhaus-black">{copy.verifiedMessage}</p>
            <p className="text-sm text-bauhaus-black/60 font-medium flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> 處理中，請稍候…
            </p>
          </div>
        )}

        {(phase === 'ready' || phase === 'blocked' || phase === 'error') && (
          <>
            <p className="text-sm text-bauhaus-black/70 font-medium mb-4">{copy.intro}</p>

            {notice && (
              <div
                role={notice.type === 'error' ? 'alert' : 'status'}
                data-testid="otp-notice"
                className={`mb-4 rounded-xl border-2 px-3 py-2.5 text-sm font-bold flex items-start gap-2 ${
                  notice.type === 'error'
                    ? 'bg-red-50 border-bauhaus-red text-bauhaus-red'
                    : 'bg-bauhaus-cream border-bauhaus-black text-bauhaus-black'
                }`}
              >
                {notice.type === 'error'
                  ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  : <MailCheck className="w-4 h-4 mt-0.5 shrink-0" />}
                <span className="min-w-0 break-words">{notice.text}</span>
              </div>
            )}

            {phase === 'ready' && challenge && (
              <form onSubmit={submit} className="space-y-3">
                <div>
                  <label htmlFor="email-otp-code" className="bh-label block mb-1.5">
                    6 碼驗證碼
                  </label>
                  <input
                    id="email-otp-code"
                    ref={inputRef}
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    value={code}
                    disabled={!canType}
                    // 不設 maxLength：貼上「123 456」這種有空白的格式時，先截斷會少一碼；交給 normalizeOtpInput 清理再取 6 碼
                    onChange={(event) => setCode(normalizeOtpInput(event.target.value))}
                    placeholder="______"
                    aria-describedby="email-otp-status"
                    className="w-full min-h-[56px] text-center text-3xl font-black tabular-nums tracking-[0.4em] pl-[0.4em] border-2 border-bauhaus-black rounded-xl bg-white outline-none focus:border-bauhaus-blue focus:ring-2 focus:ring-bauhaus-blue/30 disabled:bg-bauhaus-muted disabled:text-bauhaus-black/40"
                  />
                </div>
                <p id="email-otp-status" className="text-xs font-bold text-bauhaus-black/60 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span data-testid="otp-expiry" className={expired || expiresIn <= 60 ? 'text-bauhaus-red' : ''}>
                    {challenge.dead
                      ? '這組驗證碼已失效'
                      : expired
                        ? '驗證碼已過期，請重新寄送'
                        : challenge.expiresAt
                          ? `驗證碼有效時間 ${formatCountdown(expiresIn)}`
                          : '驗證碼 5 分鐘內有效'}
                  </span>
                </p>
                <button
                  type="submit"
                  disabled={!canType || !isOtpComplete(code)}
                  className="bh-btn bh-btn-blue w-full min-h-[48px] px-5 py-3 text-sm justify-center"
                >
                  {verifying
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> 驗證中…</>
                    : <><CheckCircle2 className="w-4 h-4" /> 驗證</>}
                </button>
              </form>
            )}

            {(phase === 'ready' || phase === 'error') && (
              <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                <button
                  type="button"
                  onClick={requestCode}
                  disabled={!canResend}
                  data-testid="otp-resend"
                  className="bh-btn bh-btn-outline min-h-[44px] px-4 py-2.5 text-sm justify-center disabled:opacity-50"
                >
                  {phase === 'error' && !challenge
                    ? <><RefreshCw className="w-4 h-4" /> 再試一次</>
                    : <><Mail className="w-4 h-4" /> {resendIn > 0 ? `重新寄送（${resendIn} 秒後）` : '沒收到？重新寄送'}</>}
                </button>
              </div>
            )}

            <div className="mt-4 pt-3 border-t-2 border-bauhaus-black/10 flex justify-end">
              <button
                type="button"
                onClick={close}
                disabled={busy}
                className="min-h-[44px] px-4 text-sm font-bold text-bauhaus-black/60 hover:text-bauhaus-black"
              >
                {phase === 'blocked' ? '我知道了' : '取消'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default EmailOtpDialog;
