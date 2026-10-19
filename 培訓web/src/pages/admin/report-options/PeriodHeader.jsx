import { useState } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { OPTION_LABEL_MAX } from '../../../lib/salaryReportOptions';
import { ToggleSwitch } from './ui';

// 選中期間的標頭：名稱、改名、啟用／停用。
const PeriodHeader = ({ period, busy, onRename, onToggle }) => {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState('');
    const active = period.is_active !== false;

    const start = () => {
        setDraft(period.label);
        setEditing(true);
    };
    const save = async () => {
        const ok = await onRename(period, draft);
        if (ok) setEditing(false);
    };

    return (
        <div className="mt-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {editing ? (
                    <div className="flex flex-1 min-w-0 items-center gap-2">
                        <input
                            type="text"
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') { event.preventDefault(); save(); }
                                if (event.key === 'Escape') setEditing(false);
                            }}
                            aria-label={`編輯期間「${period.label}」的名稱`}
                            maxLength={OPTION_LABEL_MAX + 50}
                            autoFocus
                            className="bh-input min-h-[44px] flex-1 min-w-0"
                        />
                        <button type="button" onClick={save} disabled={busy} aria-label="儲存期間名稱" className="bh-btn bh-btn-blue min-h-[44px] min-w-[44px] px-0">
                            <Check className="w-5 h-5" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => setEditing(false)} aria-label="取消改名" className="bh-btn bh-btn-outline min-h-[44px] min-w-[44px] px-0">
                            <X className="w-5 h-5" aria-hidden="true" />
                        </button>
                    </div>
                ) : (
                    <>
                        <h2 className={`min-w-0 break-words text-xl sm:text-2xl font-black tracking-tight ${active ? 'text-bauhaus-black' : 'text-bauhaus-black/50 line-through'}`}>
                            {period.label}
                        </h2>
                        <button
                            type="button"
                            onClick={start}
                            disabled={busy}
                            aria-label={`改名期間「${period.label}」`}
                            className="bh-btn-ghost min-h-[44px] min-w-[44px] disabled:opacity-40"
                        >
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                        </button>
                        <div className="ml-auto flex items-center gap-1">
                            <span className="text-xs font-black text-bauhaus-black/70">{active ? '啟用中' : '已停用'}</span>
                            <ToggleSwitch
                                checked={active}
                                onChange={() => onToggle(period)}
                                disabled={busy}
                                label={`啟用期間「${period.label}」`}
                            />
                        </div>
                    </>
                )}
            </div>
            <p className="mt-1 text-xs font-medium leading-relaxed text-bauhaus-black/60">
                換新學期請按「新增期間」，不要直接改名——改名後，這個期間的舊回報也會顯示新名字。
            </p>
            {!active && (
                <p data-period-disabled-note className="mt-2 inline-block rounded-lg border-2 border-bauhaus-black bg-bauhaus-yellow px-3 py-1 text-xs font-black text-bauhaus-black">
                    講師看不到這個期間，也看不到它底下的單位與梯次。
                </p>
            )}
        </div>
    );
};

export default PeriodHeader;
