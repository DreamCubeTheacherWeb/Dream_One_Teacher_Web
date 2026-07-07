import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { ShieldCheck, Mail, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

/**
 * 簽名前的本人身分驗證：寄一組 6 碼到登入者信箱，輸入正確才解鎖簽名。
 * 使用 Supabase 內建 Email OTP（signInWithOtp / verifyOtp）。
 *
 * props:
 *   - email：目前登入者的 email（驗證碼寄到這裡）
 *   - verified：是否已通過（由父層保存，通過後鎖定不可重來）
 *   - onVerified(isoTime)：驗證成功時回呼，帶通過時間（ISO 字串）
 */
const RESEND_SECONDS = 60;

const EmailOtpGate = ({ email, verified, onVerified }) => {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState(null);
  const [info, setInfo] = useState(null);
  const [cooldown, setCooldown] = useState(0);

  // 重寄倒數（Supabase 限每 60 秒一封）
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown(c => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleSend = async () => {
    if (sending || cooldown > 0 || !email) return;
    setSending(true);
    setError(null);
    setInfo(null);
    try {
      const { error: sendErr } = await supabase.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false },
      });
      if (sendErr) {
        const msg = sendErr.message || '';
        if (sendErr.status === 429 || /rate limit|security purposes|only request/i.test(msg)) {
          setError('寄送太頻繁，請稍候約 60 秒後再試。');
          setCooldown(RESEND_SECONDS);
        } else if (/not found|signups.*disabled|no.*user/i.test(msg)) {
          setError('系統找不到此信箱的帳號，請聯繫管理員。');
        } else {
          setError('驗證碼寄送失敗：' + (msg || '未知錯誤，請稍後再試。'));
        }
      } else {
        setSent(true);
        setInfo(`驗證碼已寄至 ${email}，請查收信箱（含垃圾郵件匣），並於下方輸入 6 碼。`);
        setCooldown(RESEND_SECONDS);
      }
    } catch (e) {
      setError('驗證碼寄送失敗：' + (e.message || '請稍後再試。'));
    }
    setSending(false);
  };

  const handleVerify = async () => {
    if (verifying || code.length !== 6 || !email) return;
    setVerifying(true);
    setError(null);
    try {
      const { error: verifyErr } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: 'email',
      });
      if (verifyErr) {
        const msg = verifyErr.message || '';
        if (/expired|invalid|token/i.test(msg)) {
          setError('驗證碼錯誤或已過期，請確認後重試，或點「重新寄送」取得新碼。');
        } else {
          setError('驗證失敗：' + (msg || '請稍後再試。'));
        }
      } else {
        onVerified?.(new Date().toISOString());
      }
    } catch (e) {
      setError('驗證失敗：' + (e.message || '請稍後再試。'));
    }
    setVerifying(false);
  };

  if (verified) {
    return (
      <div className="mb-6 border-2 border-green-200 rounded-xl p-4 bg-green-50">
        <span className="text-sm font-bold text-green-700 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4" /> 本人身分已驗證
        </span>
        <p className="text-xs text-green-600 mt-1">已確認為本人操作，可進行簽名。</p>
      </div>
    );
  }

  return (
    <div className="mb-6 border border-blue-100 rounded-xl p-4 bg-blue-50/50">
      <h4 className="text-sm font-bold text-slate-700 mb-1 flex items-center gap-1.5">
        <ShieldCheck className="w-4 h-4 text-blue-600" /> 本人身分驗證
      </h4>
      <p className="text-xs text-slate-500 mb-3">
        為確認是本人簽署，簽名前需先驗證信箱。系統會寄一組 6 碼到您的登入信箱。
      </p>

      <button
        type="button"
        onClick={handleSend}
        disabled={sending || cooldown > 0}
        className={`w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold rounded-xl transition-all ${
          sending || cooldown > 0
            ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
            : 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-500/25'
        }`}
      >
        {sending ? (
          <><Loader2 className="w-4 h-4 animate-spin" /> 寄送中...</>
        ) : cooldown > 0 ? (
          <><Mail className="w-4 h-4" /> 重新寄送（{cooldown}s）</>
        ) : (
          <><Mail className="w-4 h-4" /> {sent ? '重新寄送驗證碼' : '寄送驗證碼到我的信箱'}</>
        )}
      </button>

      {info && (
        <p className="mt-3 text-xs text-blue-700 flex items-start gap-1.5">
          <Mail className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {info}
        </p>
      )}

      {sent && (
        <div className="mt-4 flex flex-col sm:flex-row gap-2 sm:items-center">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={e => { setError(null); setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); }}
            placeholder="輸入 6 碼驗證碼"
            className="w-full sm:w-48 px-4 py-2.5 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all font-mono tracking-[0.3em] text-center"
          />
          <button
            type="button"
            onClick={handleVerify}
            disabled={verifying || code.length !== 6}
            className={`flex items-center justify-center gap-2 px-6 py-2.5 text-sm font-bold rounded-xl transition-all ${
              verifying || code.length !== 6
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                : 'bg-green-600 text-white hover:bg-green-700 shadow-lg shadow-green-500/25'
            }`}
          >
            {verifying ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> 驗證中...</>
            ) : (
              <><CheckCircle2 className="w-4 h-4" /> 確認</>
            )}
          </button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-600 flex items-start gap-1.5">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
};

export default EmailOtpGate;
