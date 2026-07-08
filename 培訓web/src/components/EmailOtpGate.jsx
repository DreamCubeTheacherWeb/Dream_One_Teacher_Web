import { useState, useEffect, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { ShieldCheck, Mail, Loader2, CheckCircle2, AlertCircle, MailCheck } from 'lucide-react';

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

// ── 6 格分格驗證碼輸入 ──
const OtpInput = ({ value, onChange, onComplete, disabled, invalid }) => {
    const refs = useRef([]);
    const digits = Array.from({ length: 6 }, (_, i) => value[i] || '');

    const focusIndex = (i) => {
        const el = refs.current[Math.max(0, Math.min(5, i))];
        if (el) { el.focus(); el.select?.(); }
    };

    const setDigit = (i, d) => {
        const arr = value.split('');
        arr[i] = d;
        const next = arr.join('').replace(/\D/g, '').slice(0, 6);
        onChange(next);
        return next;
    };

    const handleChange = (i, e) => {
        const raw = e.target.value.replace(/\D/g, '');
        if (!raw) { setDigit(i, ''); return; }
        // 若使用者一次輸入多碼（部分手機鍵盤 / 自動填入）
        if (raw.length > 1) {
            const next = (value.slice(0, i) + raw).replace(/\D/g, '').slice(0, 6);
            onChange(next);
            focusIndex(next.length);
            if (next.length === 6) onComplete?.(next);
            return;
        }
        const next = setDigit(i, raw);
        if (i < 5) focusIndex(i + 1);
        if (next.length === 6) onComplete?.(next);
    };

    const handleKeyDown = (i, e) => {
        if (e.key === 'Backspace') {
            if (digits[i]) {
                setDigit(i, '');
            } else if (i > 0) {
                setDigit(i - 1, '');
                focusIndex(i - 1);
            }
        } else if (e.key === 'ArrowLeft' && i > 0) {
            e.preventDefault(); focusIndex(i - 1);
        } else if (e.key === 'ArrowRight' && i < 5) {
            e.preventDefault(); focusIndex(i + 1);
        }
    };

    const handlePaste = (e) => {
        e.preventDefault();
        const pasted = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (!pasted) return;
        onChange(pasted);
        focusIndex(pasted.length);
        if (pasted.length === 6) onComplete?.(pasted);
    };

    return (
        <div className="flex gap-2 sm:gap-2.5" onPaste={handlePaste}>
            {digits.map((d, i) => (
                <input
                    key={i}
                    ref={(el) => (refs.current[i] = el)}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete={i === 0 ? 'one-time-code' : 'off'}
                    maxLength={i === 0 ? 6 : 1}
                    value={d}
                    disabled={disabled}
                    onChange={(e) => handleChange(i, e)}
                    onKeyDown={(e) => handleKeyDown(i, e)}
                    onFocus={(e) => e.target.select()}
                    aria-label={`驗證碼第 ${i + 1} 碼`}
                    className={`w-11 h-14 sm:w-12 sm:h-14 text-center text-2xl font-black rounded-xl border-2 outline-none transition-all tabular-nums
                        ${invalid
                            ? 'border-red-300 bg-red-50 text-red-600'
                            : d
                                ? 'border-blue-400 bg-blue-50 text-slate-800 shadow-sm'
                                : 'border-slate-200 bg-white text-slate-800'}
                        focus:border-blue-500 focus:ring-2 focus:ring-blue-500/30 focus:bg-white
                        disabled:opacity-50`}
                    style={d ? { animation: 'otp-cell-in 0.15s ease-out' } : undefined}
                />
            ))}
        </div>
    );
};

// ── 步驟指示器 ──
const Stepper = ({ step }) => {
    const steps = ['寄送', '查信輸碼', '完成'];
    return (
        <div className="flex items-center gap-1.5 mb-4">
            {steps.map((label, i) => {
                const n = i + 1;
                const done = step > n;
                const active = step === n;
                return (
                    <div key={label} className="flex items-center gap-1.5 flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black shrink-0 transition-colors
                                ${done ? 'bg-green-500 text-white' : active ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-400'}`}>
                                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : n}
                            </div>
                            <span className={`text-[11px] font-bold truncate ${active ? 'text-blue-700' : done ? 'text-green-600' : 'text-slate-400'}`}>{label}</span>
                        </div>
                        {i < steps.length - 1 && (
                            <div className={`h-0.5 flex-1 rounded-full ${done ? 'bg-green-400' : 'bg-slate-200'}`} />
                        )}
                    </div>
                );
            })}
        </div>
    );
};

const EmailOtpGate = ({ email, verified, onVerified }) => {
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    const [code, setCode] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState(null);
    const [info, setInfo] = useState(null);
    const [cooldown, setCooldown] = useState(0);
    const lastTried = useRef('');

    // 重寄倒數（Supabase 限每 60 秒一封）
    useEffect(() => {
        if (cooldown <= 0) return undefined;
        const t = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
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
                setCode('');
                lastTried.current = '';
                setInfo(`已寄至 ${email}，請查收信箱（含垃圾郵件匣）並輸入 6 碼。`);
                setCooldown(RESEND_SECONDS);
            }
        } catch (e) {
            setError('驗證碼寄送失敗：' + (e.message || '請稍後再試。'));
        }
        setSending(false);
    };

    const handleVerify = useCallback(async (submitCode) => {
        const c = (submitCode || '').slice(0, 6);
        if (verifying || c.length !== 6 || !email) return;
        lastTried.current = c;
        setVerifying(true);
        setError(null);
        try {
            const { error: verifyErr } = await supabase.auth.verifyOtp({
                email,
                token: c,
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
    }, [verifying, email, onVerified]);

    // ── 已驗證：成就狀態 ──
    if (verified) {
        return (
            <div
                className="mb-6 rounded-2xl p-5 bg-gradient-to-br from-green-50 to-emerald-50 border border-green-200 shadow-sm"
                style={{ animation: 'otp-pop 0.4s cubic-bezier(0.22,1,0.36,1)' }}
            >
                <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-green-500 flex items-center justify-center shadow-lg shadow-green-500/30 shrink-0">
                        <CheckCircle2 className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <p className="text-sm font-black text-green-700">本人身分已驗證</p>
                        <p className="text-xs text-green-600 mt-0.5">已確認為本人操作，可放心進行簽名。</p>
                    </div>
                </div>
            </div>
        );
    }

    const step = !sent ? 1 : 2;

    return (
        <div className="mb-6 rounded-2xl p-5 bg-gradient-to-br from-blue-50 to-indigo-50/60 border border-blue-100 shadow-sm">
            <h4 className="text-sm font-black text-slate-800 mb-1 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-blue-600" /> 本人身分驗證
            </h4>
            <p className="text-xs text-slate-500 mb-4">
                為確認是本人簽署，簽名前需先驗證信箱。系統會寄一組 6 碼到您的登入信箱。
            </p>

            <Stepper step={step} />

            {!sent ? (
                <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || cooldown > 0}
                    className={`w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-3 md:py-2.5 text-sm font-bold rounded-xl transition-all ${
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
                        <><Mail className="w-4 h-4" /> 寄送驗證碼到我的信箱</>
                    )}
                </button>
            ) : (
                <div className="space-y-4">
                    {info && (
                        <p className="text-xs text-blue-700 flex items-start gap-1.5 bg-white/60 rounded-lg px-3 py-2">
                            <MailCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {info}
                        </p>
                    )}

                    <div>
                        <OtpInput
                            value={code}
                            onChange={(v) => { setError(null); setCode(v); }}
                            onComplete={handleVerify}
                            disabled={verifying}
                            invalid={!!error}
                        />
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                        <button
                            type="button"
                            onClick={() => handleVerify(code)}
                            disabled={verifying || code.length !== 6}
                            className={`flex items-center justify-center gap-2 px-6 py-3 md:py-2.5 text-sm font-bold rounded-xl transition-all ${
                                verifying || code.length !== 6
                                    ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                                    : 'bg-green-600 text-white hover:bg-green-700 shadow-lg shadow-green-500/25'
                            }`}
                        >
                            {verifying ? (
                                <><Loader2 className="w-4 h-4 animate-spin" /> 驗證中...</>
                            ) : (
                                <><CheckCircle2 className="w-4 h-4" /> 確認驗證碼</>
                            )}
                        </button>
                        <button
                            type="button"
                            onClick={handleSend}
                            disabled={sending || cooldown > 0}
                            className="text-xs font-bold text-slate-500 hover:text-blue-600 disabled:text-slate-300 disabled:cursor-not-allowed transition-colors px-2 py-3.5 md:py-2 self-start sm:self-auto"
                        >
                            {cooldown > 0 ? `重新寄送（${cooldown}s）` : '沒收到？重新寄送'}
                        </button>
                    </div>
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
