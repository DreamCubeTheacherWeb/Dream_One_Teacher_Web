import { useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import {
  describeConfirmEmailError,
  describeConfirmedEmailMethod,
  validateEmailConfirmation,
} from '../lib/accountActivation';
import { hasConfirmedEmail } from '../lib/instructorProgress';
import { formatTaipeiTime } from '../lib/esign';
import { Loader2, Mail, X } from 'lucide-react';

/**
 * 後台「確認 Email」：管理員透過可信管道（LINE、電話、當面…）與老師本人確認 Email 後登錄。
 * 老師之後收帳號啟用與簽約的驗證碼，只會寄到這裡登錄的 Email（不是 Google 登入信箱）。
 * 呼叫 admin_confirm_instructor_email(p_instructor_id, p_email, p_note)。
 */
export const ConfirmInstructorEmailModal = ({ inst, onClose, onConfirmed }) => {
  const [email, setEmail] = useState(inst.confirmed_email || inst.email_primary || '');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    const checked = validateEmailConfirmation({ email, note });
    setErrors(checked.errors);
    setSubmitError('');
    if (!checked.ok) return;

    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('admin_confirm_instructor_email', {
        p_instructor_id: inst.id,
        p_email: checked.email,
        p_note: checked.note,
      });
      if (error) throw error;
      if (data?.status !== 'confirmed') throw new Error('伺服器沒有回覆「已確認」');
      onConfirmed(checked.email);
    } catch (error) {
      setSubmitError(describeConfirmEmailError(error));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-bauhaus-black/60 sm:p-4" data-testid="confirm-email-modal">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-email-title"
        className="bh-card shadow-hard-lg w-full sm:max-w-lg max-h-[92dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b-2 border-bauhaus-black bg-bauhaus-black text-white">
          <div className="min-w-0">
            <h2 id="confirm-email-title" className="font-black uppercase tracking-wide">確認 Email</h2>
            <p className="text-xs text-white/70 mt-0.5 truncate">講師：<strong>{inst.full_name}</strong></p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="關閉" className="w-11 h-11 -mr-2 flex items-center justify-center text-white/70 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 sm:px-6 py-4 space-y-4">
          <p className="text-sm text-bauhaus-black/70 font-medium">
            請先透過可信管道（LINE、電話、當面）和老師本人確認這個 Email 是他的。登錄後，老師啟用帳號與簽約的驗證碼只會寄到這個 Email。
          </p>

          <div>
            <label htmlFor="confirm-email-input" className="bh-label block mb-1.5">要確認的 Email</label>
            <input
              id="confirm-email-input"
              type="email"
              inputMode="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="bh-input"
              placeholder="teacher@example.com"
              autoFocus
            />
            {errors.email && <p role="alert" className="text-xs font-bold text-bauhaus-red mt-1">{errors.email}</p>}
          </div>

          <div>
            <label htmlFor="confirm-email-note" className="bh-label block mb-1.5">確認管道註記（必填）</label>
            <textarea
              id="confirm-email-note"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="bh-input"
              placeholder="例：10/20 透過 LINE 與老師本人確認"
            />
            {errors.note && <p role="alert" className="text-xs font-bold text-bauhaus-red mt-1">{errors.note}</p>}
          </div>

          {submitError && (
            <p role="alert" data-testid="confirm-email-error" className="text-sm font-bold text-bauhaus-red break-words">{submitError}</p>
          )}
        </div>

        <div className="px-5 sm:px-6 py-3 border-t-2 border-bauhaus-black flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="bh-btn bh-btn-outline min-h-[44px] px-4 py-2 text-sm justify-center">
            取消
          </button>
          <button type="submit" disabled={saving} data-testid="confirm-email-submit" className="bh-btn bh-btn-blue min-h-[44px] px-5 py-2 text-sm justify-center">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> 登錄中⋯</> : '確認並登錄'}
          </button>
        </div>
      </form>
    </div>
  );
};

/** 展開列裡的「已確認 Email」說明；管理員另有按鈕可登錄或更改。 */
export const InstructorEmailConfirmation = ({ inst, isAdmin, onConfirmEmail }) => {
  const confirmed = hasConfirmedEmail(inst);
  return (
    <div data-testid="email-confirmation" className="space-y-1 text-sm">
      {confirmed ? (
        <>
          <p className="break-all">
            <span className="text-bauhaus-black/50">已確認 Email：</span>
            <strong data-testid="confirmed-email-value">{inst.confirmed_email}</strong>
          </p>
          <p className="text-xs text-bauhaus-black/60 break-words">
            {[formatTaipeiTime(inst.confirmed_email_at), describeConfirmedEmailMethod(inst.confirmed_email_method)].filter(Boolean).join('・') || '—'}
          </p>
          {inst.confirmed_email_note && (
            <p className="text-xs text-bauhaus-black/60 break-words">註記：{inst.confirmed_email_note}</p>
          )}
        </>
      ) : (
        <p className="text-xs font-bold text-bauhaus-red">尚未確認 Email（老師要先有已確認的 Email 才能收驗證碼啟用帳號）</p>
      )}
      {isAdmin && (
        <button
          type="button"
          onClick={onConfirmEmail}
          className="bh-btn bh-btn-outline min-h-[44px] px-3 py-2 text-xs mt-1"
        >
          <Mail className="w-3.5 h-3.5" /> {confirmed ? '更改已確認的 Email' : '確認 Email'}
        </button>
      )}
    </div>
  );
};
