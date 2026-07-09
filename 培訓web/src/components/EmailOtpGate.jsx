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
                    className={`w-11 h-14 sm:w-12 sm:h-14 text-center text-2xl font-black border-2 rounded-xl outline-none transition-all tabular-nums
                        ${invalid
                            ? 'border-bauhaus-red bg-bauhaus-red/10 text-bauhaus-red'
                            : d
                                ? 'border-bauhaus-blue bg-bauhaus-cream text-bauhaus-black shadow-hard-sm'
                                : 'border-bauhaus-black bg-white text-bauhaus-black'}
                        focus:border-bauhaus-blue focus:ring-2 focus:ring-bauhaus-blue/30 focus:bg-white
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
                            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black shrink-0 transition-colors border-2 border-bauhaus-black
                                ${done ? 'bg-bauhaus-blue text-white' : active ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black/40'}`}>
                                {done ? <CheckCircle2 className="w-3.5 h-3.5" /> : n}
                            </div>
                            <span className={`text-[11px] font-bold truncate ${active ? 'text-bauhaus-black' : done ? 'text-bauhaus-blue' : 'text-bauhaus-black/40'}`}>{label}</span>
                        </div>
                        {i < steps.length - 1 && (
                            <div className={`h-0.5 flex-1 ${done ? 'bg-bauhaus-blue' : 'bg-bauhaus-black/20'}`} />
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
                className="mb-6 p-5 bg-bauhaus-blue border-2 border-bauhaus-black rounded-2xl shadow-hard"
                style={{ animation: 'otp-pop 0.4s cubic-bezier(0.22,1,0.36,1)' }}
            >
                <div className="flex items-center gap-3">
                    <div className="w-11 h-11 rounded-full bg-white border-2 border-bauhaus-black flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-6 h-6 text-bauhaus-blue" />
                    </div>
                    <div>
                        <p className="text-sm font-black text-white">本人身分已驗證</p>
                        <p className="text-xs text-white/80 mt-0.5">已確認為本人操作，可放心進行簽名。</p>
                    </div>
                </div>
            </div>
        );
    }

    const step = !sent ? 1 : 2;

    return (
        <div className="mb-6 p-5 bg-white border-2 border-bauhaus-black rounded-2xl shadow-hard">
            <h4 className="text-sm font-black text-bauhaus-black mb-1 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-bauhaus-blue" /> 本人身分驗證
            </h4>
            <p className="text-xs text-bauhaus-black/60 mb-4">
                為確認是本人簽署，簽名前需先驗證信箱。系統會寄一組 6 碼到您的登入信箱。
            </p>

            <Stepper step={step} />

            {!sent ? (
                <button
                    type="button"
                    onClick={handleSend}
                    disabled={sending || cooldown > 0}
                    className="bh-btn bh-btn-blue w-full sm:w-auto px-5 py-3 md:py-2.5 text-sm"
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
                        <p className="text-xs text-bauhaus-black flex items-start gap-1.5 bg-bauhaus-cream border-2 border-bauhaus-black/10 rounded-xl px-3 py-2">
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
                            className="bh-btn bh-btn-blue px-6 py-3 md:py-2.5 text-sm"
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
                            className="text-xs font-bold text-bauhaus-black/60 hover:text-bauhaus-blue disabled:text-bauhaus-black/30 disabled:cursor-not-allowed transition-colors px-2 py-3.5 md:py-2 self-start sm:self-auto"
                        >
                            {cooldown > 0 ? `重新寄送（${cooldown}s）` : '沒收到？重新寄送'}
                        </button>
                    </div>
                </div>
            )}

            {error && (
                <p className="mt-3 text-xs text-bauhaus-red font-bold flex items-start gap-1.5">
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
                </p>
            )}
        </div>
    );
};

export default EmailOtpGate;
