import { X } from 'lucide-react';

// 回報選項管理頁共用的小元件：提示條、開關。

// 提示訊息：固定在畫面下方（桌機靠右、手機滿版），不推擠清單，捲到哪裡都看得到；可手動關閉。
// 成功訊息 4 秒後自己消失，錯誤訊息留到關掉或下一次操作。
// 「已儲存順序」是 aria-live 區塊（一直存在，螢幕閱讀器才會念）。
export const NoticeBar = ({ notice, savedText, onDismiss }) => (
    <div className="fixed inset-x-3 bottom-3 sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[26rem] z-40 pointer-events-none flex flex-col items-stretch sm:items-end gap-2">
        {notice && (
            <div
                data-notice={notice.type}
                role={notice.type === 'error' ? 'alert' : 'status'}
                className={`pointer-events-auto flex items-start gap-1 w-full rounded-2xl border-2 border-bauhaus-black pl-4 pr-1 shadow-hard-sm text-sm font-bold ${notice.type === 'error' ? 'bg-bauhaus-red text-white' : 'bg-bauhaus-yellow text-bauhaus-black'}`}
            >
                <p className="flex-1 min-w-0 break-words py-3 leading-snug">{notice.text}</p>
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="關閉訊息"
                    className="shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-current"
                >
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            </div>
        )}
        <p
            data-saved-line
            aria-live="polite"
            className={savedText ? 'pointer-events-auto rounded-lg border-2 border-bauhaus-black bg-bauhaus-yellow px-3 py-1 text-xs font-black text-bauhaus-black shadow-hard-sm' : 'sr-only'}
        >
            {savedText}
        </p>
    </div>
);

// 開關：熱區 ≥44×44px；text 是旁邊的小字（例如「顯示」「必填」）
export const ToggleSwitch = ({ checked, onChange, label, text, disabled = false }) => (
    <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onChange}
        className="inline-flex items-center justify-center gap-1.5 min-h-[44px] min-w-[44px] px-1 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-bauhaus-black disabled:opacity-50 disabled:pointer-events-none"
    >
        {text && <span aria-hidden="true" className="text-xs font-black text-bauhaus-black/70">{text}</span>}
        <span
            aria-hidden="true"
            className={`relative inline-block w-12 h-7 shrink-0 rounded-full border-2 border-bauhaus-black transition-colors duration-200 ease-out ${checked ? 'bg-bauhaus-blue' : 'bg-bauhaus-muted'}`}
        >
            <span
                className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full border-2 border-bauhaus-black bg-white transition-transform duration-200 ease-out ${checked ? 'translate-x-5' : 'translate-x-0'}`}
            />
        </span>
    </button>
);
