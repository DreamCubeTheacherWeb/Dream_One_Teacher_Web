import { useState } from 'react';
import { Check, Pencil, Plus, X } from 'lucide-react';
import SortableList from '../../../components/admin/SortableList';
import { OPTION_LABEL_MAX } from '../../../lib/salaryReportOptions';
import { ToggleSwitch } from './ui';

// 一個期間底下的一份清單（上課單位或營隊梯次）：標頭、新增列、可拖曳的薄列。
const rowClass = (item, { isDragging }) => {
    if (isDragging) return 'bg-bauhaus-cream';
    return item.is_active === false ? 'bg-bauhaus-muted/70' : 'bg-white';
};

const OptionSection = ({ section, items, busy, onAdd, onRename, onToggle, onReorder }) => {
    const [newLabel, setNewLabel] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editLabel, setEditLabel] = useState('');
    const activeCount = items.filter((item) => item.is_active !== false).length;

    const submitAdd = async (event) => {
        event.preventDefault();
        const ok = await onAdd(section.kind, newLabel);
        if (ok) setNewLabel('');
    };

    const startEdit = (item) => {
        setEditingId(item.id);
        setEditLabel(item.label);
    };

    const saveEdit = async (item) => {
        const ok = await onRename(item, editLabel);
        if (ok) setEditingId(null);
    };

    return (
        <section data-option-section={section.kind} aria-label={section.title} className="bh-card overflow-hidden">
            <div className="bg-bauhaus-black text-white px-4 sm:px-5 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                    <h3 className="text-lg font-black">{section.title}</h3>
                    <p data-section-count className="text-xs font-black text-bauhaus-yellow">共 {items.length} 項，啟用 {activeCount} 項</p>
                </div>
                <p className="mt-1 text-xs font-medium leading-relaxed text-white/75">{section.hint}</p>
            </div>

            <form onSubmit={submitAdd} className="px-3 sm:px-4 py-3 flex gap-2 border-b-2 border-bauhaus-black/20">
                <input
                    type="text"
                    value={newLabel}
                    onChange={(event) => setNewLabel(event.target.value)}
                    maxLength={OPTION_LABEL_MAX + 50}
                    aria-label={`新增${section.noun}`}
                    placeholder={section.placeholder}
                    className="bh-input min-h-[44px] flex-1 min-w-0"
                />
                <button type="submit" disabled={busy} className="bh-btn bh-btn-blue px-4 min-h-[44px] shrink-0">
                    <Plus className="w-4 h-4" aria-hidden="true" /> 新增
                </button>
            </form>

            {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm font-bold text-bauhaus-black/50">
                    這個期間還沒有{section.noun}。在上面輸入名稱按「新增」。
                </p>
            ) : (
                <SortableList
                    items={items}
                    onReorder={onReorder}
                    disabled={busy || editingId !== null}
                    listLabel={`${section.title}清單（可拖曳調整順序）`}
                    className="divide-y-2 divide-bauhaus-black/15"
                    itemClassName={(item, state) => (editingId === item.id ? 'bg-bauhaus-cream' : rowClass(item, state))}
                    renderItem={(item, { handle }) => {
                        const inactive = item.is_active === false;
                        if (editingId === item.id) {
                            return (
                                <div data-option-row className="flex items-center gap-2 px-2 sm:px-3 py-1 min-h-[52px]">
                                    <input
                                        type="text"
                                        value={editLabel}
                                        onChange={(event) => setEditLabel(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === 'Enter') { event.preventDefault(); saveEdit(item); }
                                            if (event.key === 'Escape') setEditingId(null);
                                        }}
                                        aria-label={`編輯「${item.label}」的名稱`}
                                        maxLength={OPTION_LABEL_MAX + 50}
                                        autoFocus
                                        className="bh-input min-h-[44px] flex-1 min-w-0"
                                    />
                                    <button type="button" onClick={() => saveEdit(item)} disabled={busy} aria-label="儲存名稱" className="bh-btn bh-btn-blue min-h-[44px] min-w-[44px] px-0 shrink-0">
                                        <Check className="w-5 h-5" aria-hidden="true" />
                                    </button>
                                    <button type="button" onClick={() => setEditingId(null)} aria-label="取消改名" className="bh-btn bh-btn-outline min-h-[44px] min-w-[44px] px-0 shrink-0">
                                        <X className="w-5 h-5" aria-hidden="true" />
                                    </button>
                                </div>
                            );
                        }
                        return (
                            <div data-option-row className="flex items-center gap-1 pr-1 sm:pr-2 min-h-[52px]">
                                {handle}
                                <p
                                    data-option-label
                                    title={item.label}
                                    className={`min-w-0 flex-1 px-1 text-sm sm:text-[15px] font-bold leading-snug break-words line-clamp-2 sm:line-clamp-1 ${inactive ? 'text-bauhaus-black/45 line-through' : 'text-bauhaus-black'}`}
                                >
                                    {item.label}
                                    {inactive && <span className="sr-only">（已停用）</span>}
                                </p>
                                {inactive && (
                                    <span aria-hidden="true" className="hidden sm:inline-block shrink-0 rounded-lg bg-bauhaus-black px-2 py-0.5 text-[11px] font-black text-white">已停用</span>
                                )}
                                <button
                                    type="button"
                                    onClick={() => startEdit(item)}
                                    disabled={busy}
                                    aria-label={`改名「${item.label}」`}
                                    className="bh-btn-ghost shrink-0 min-h-[44px] min-w-[44px] disabled:opacity-40"
                                >
                                    <Pencil className="w-4 h-4" aria-hidden="true" />
                                </button>
                                <ToggleSwitch
                                    checked={!inactive}
                                    onChange={() => onToggle(item)}
                                    disabled={busy}
                                    label={`啟用「${item.label}」`}
                                />
                            </div>
                        );
                    }}
                />
            )}
        </section>
    );
};

export default OptionSection;
