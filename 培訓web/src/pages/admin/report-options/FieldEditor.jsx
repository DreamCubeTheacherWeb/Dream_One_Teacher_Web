import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { FIELD_TYPES, validateCustomField } from '../../../lib/salaryReportFields';
import { ToggleSwitch } from './ui';

const draftOf = (field) => ({
    label: field?.label || '',
    field_type: field?.field_type || 'text',
    optionsText: (field?.options || []).join('\n'),
    help_text: field?.help_text || '',
    is_required: Boolean(field?.is_required),
});

// 新增／編輯自訂欄位的面板。onSave(value) 回傳 { ok:true } 或 { ok:false, message }。
const FieldEditor = ({ field = null, siblings, busy, onSave, onCancel }) => {
    const [draft, setDraft] = useState(() => draftOf(field));
    const [error, setError] = useState('');
    const isSelect = draft.field_type === 'select';
    const isBoolean = draft.field_type === 'boolean';
    const patch = (next) => setDraft((current) => ({ ...current, ...next }));

    const submit = async (event) => {
        event.preventDefault();
        const checked = validateCustomField(draft, siblings, { ignoreId: field?.id ?? null });
        if (!checked.ok) {
            setError(checked.message);
            return;
        }
        setError('');
        const result = await onSave(checked.value);
        if (result && !result.ok) setError(result.message || '儲存失敗');
    };

    return (
        <form onSubmit={submit} data-field-editor className="flex flex-col gap-3 bg-bauhaus-cream px-3 sm:px-4 py-4">
            <h3 className="text-base font-black">{field ? `編輯欄位「${field.label}」` : '新增欄位'}</h3>
            <label className="block">
                <span className="bh-label block mb-1.5">欄位名稱</span>
                <input type="text" value={draft.label} onChange={(event) => patch({ label: event.target.value })} placeholder="例如：使用的教具" autoFocus className="bh-input min-h-[44px]" />
            </label>
            <label className="block">
                <span className="bh-label block mb-1.5">類型</span>
                <select value={draft.field_type} onChange={(event) => patch({ field_type: event.target.value, ...(event.target.value === 'boolean' ? { is_required: false } : {}) })} className="bh-input min-h-[44px]">
                    {FIELD_TYPES.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
                </select>
            </label>
            {isSelect && (
                <label className="block">
                    <span className="bh-label block mb-1.5">下拉選項（一行一個）</span>
                    <textarea value={draft.optionsText} onChange={(event) => patch({ optionsText: event.target.value })} rows={4} placeholder={'例如：\n方塊\n計時器\n教材包'} className="bh-input min-h-[44px]" />
                </label>
            )}
            <label className="block">
                <span className="bh-label block mb-1.5">說明文字（選填，講師會看到）</span>
                <input type="text" value={draft.help_text} onChange={(event) => patch({ help_text: event.target.value })} placeholder="例如：沒有就留白" className="bh-input min-h-[44px]" />
            </label>
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="bh-label">必填</p>
                    {isBoolean && <p className="text-xs font-medium text-bauhaus-black/60">是／否勾選不能設成必填。</p>}
                </div>
                <ToggleSwitch checked={draft.is_required && !isBoolean} onChange={() => patch({ is_required: !draft.is_required })} disabled={isBoolean} label="必填" />
            </div>
            {error && (
                <p role="alert" data-editor-error className="rounded-xl border-2 border-bauhaus-black bg-bauhaus-red px-3 py-2 text-sm font-bold text-white">{error}</p>
            )}
            <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className="bh-btn bh-btn-blue px-5 min-h-[44px]">
                    <Check className="w-4 h-4" aria-hidden="true" /> 儲存
                </button>
                <button type="button" onClick={onCancel} className="bh-btn bh-btn-outline px-5 min-h-[44px]">
                    <X className="w-4 h-4" aria-hidden="true" /> 取消
                </button>
            </div>
        </form>
    );
};

export default FieldEditor;
