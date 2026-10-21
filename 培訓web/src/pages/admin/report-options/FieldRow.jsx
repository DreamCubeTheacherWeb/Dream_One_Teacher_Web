import { Lock, Pencil, Trash2 } from 'lucide-react';
import { REQUIRABLE_BUILTINS, FIELD_SOURCES, fieldTypeLabel } from '../../../lib/salaryReportFields';
import { ToggleSwitch } from './ui';

const Tag = ({ children, tone = 'plain' }) => (
    <span
        className={`inline-flex items-center gap-1 rounded-lg border-2 border-bauhaus-black px-1.5 py-0.5 text-xs font-black leading-none ${
            tone === 'dark' ? 'bg-bauhaus-black text-white' : tone === 'yellow' ? 'bg-bauhaus-yellow text-bauhaus-black' : 'bg-white text-bauhaus-black'
        }`}
    >
        {children}
    </span>
);

// 欄位清單的一列：把手、名稱＋小標籤、動作（依來源不同）。
const FieldRow = ({ field, handle, busy, confirmingDelete, onToggleVisible, onToggleRequired, onEdit, onAskDelete, onCancelDelete, onDelete }) => {
    const hidden = field.is_visible === false;
    const { source } = field;

    if (confirmingDelete) {
        return (
            <div data-field-row data-confirm-delete className="flex flex-wrap items-center gap-2 px-3 py-2 min-h-[52px]">
                <p className="flex-1 min-w-[12rem] text-sm font-black text-bauhaus-black">
                    確定刪除「{field.label}」？講師之前填的內容會保留在舊紀錄。
                </p>
                <div className="flex gap-2">
                    <button type="button" onClick={() => onDelete(field)} disabled={busy} className="bh-btn bh-btn-red px-4 min-h-[44px]">刪除</button>
                    <button type="button" onClick={onCancelDelete} className="bh-btn bh-btn-outline px-4 min-h-[44px]">取消</button>
                </div>
            </div>
        );
    }

    return (
        <div data-field-row data-field-source={source} className="flex flex-wrap items-center gap-x-1 gap-y-0 pr-2 min-h-[52px]">
            {handle}
            <div className="flex-1 basis-40 min-w-0 px-1 py-1">
                <p data-field-label className={`break-words text-sm sm:text-[15px] font-bold leading-snug ${hidden ? 'text-bauhaus-black/45 line-through' : 'text-bauhaus-black'}`}>
                    {field.label}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                    {source === 'system' && (
                        <Tag tone="dark"><Lock className="w-3 h-3" aria-hidden="true" />{FIELD_SOURCES.system.label}</Tag>
                    )}
                    {source === 'builtin' && <Tag>{FIELD_SOURCES.builtin.label}</Tag>}
                    {source === 'custom' && <Tag tone="yellow">{FIELD_SOURCES.custom.label}・{fieldTypeLabel(field.field_type)}</Tag>}
                    {field.is_required && <Tag tone="yellow">必填</Tag>}
                    {hidden && <Tag tone="dark">已隱藏</Tag>}
                </div>
            </div>

            <div className="flex items-center gap-1 ml-auto">
                {source === 'builtin' && (
                    <>
                        {REQUIRABLE_BUILTINS.has(field.field_key) && (
                            <ToggleSwitch
                                checked={Boolean(field.is_required)}
                                onChange={() => onToggleRequired(field)}
                                disabled={busy}
                                text="必填"
                                label={`必填「${field.label}」`}
                            />
                        )}
                        <ToggleSwitch
                            checked={!hidden}
                            onChange={() => onToggleVisible(field)}
                            disabled={busy}
                            text="顯示"
                            label={`顯示「${field.label}」`}
                        />
                    </>
                )}
                {source === 'custom' && (
                    <>
                        <ToggleSwitch
                            checked={!hidden}
                            onChange={() => onToggleVisible(field)}
                            disabled={busy}
                            text="顯示"
                            label={`顯示「${field.label}」`}
                        />
                        <button type="button" onClick={() => onEdit(field)} disabled={busy} aria-label={`編輯「${field.label}」`} className="bh-btn-ghost min-h-[44px] min-w-[44px] disabled:opacity-40">
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                        </button>
                        <button type="button" onClick={() => onAskDelete(field)} disabled={busy} aria-label={`刪除「${field.label}」`} className="bh-btn-ghost min-h-[44px] min-w-[44px] text-bauhaus-red disabled:opacity-40">
                            <Trash2 className="w-4 h-4" aria-hidden="true" />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
};

export default FieldRow;
