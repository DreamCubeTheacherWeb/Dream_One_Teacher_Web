import { Plus } from 'lucide-react';
import SortableList from '../../../components/admin/SortableList';

// 期間列：一排可拖曳的 chip，最後一顆是「＋新增期間」。選中＝黑底白字；停用＝灰底刪除線。
const chipClass = (period, selected, isDragging) => {
    const base = 'inline-flex items-center rounded-xl border-2 border-bauhaus-black transition-colors duration-200 ease-out max-w-full';
    if (selected) return `${base} bg-bauhaus-black text-white ${isDragging ? 'shadow-hard-white' : ''}`;
    if (period.is_active === false) return `${base} bg-bauhaus-muted text-bauhaus-black/55`;
    return `${base} bg-white text-bauhaus-black hover:bg-bauhaus-cream`;
};

const PeriodChips = ({ periods, selectedId, creating, busy, onSelect, onReorder, onToggleCreate }) => (
    <SortableList
        items={periods}
        onReorder={onReorder}
        disabled={busy}
        strategy="rect"
        listAs="div"
        itemAs="div"
        listLabel="教學期間（可拖曳調整順序）"
        className="flex flex-wrap items-center gap-2"
        itemClassName={(period, { isDragging }) => chipClass(period, period.id === selectedId, isDragging)}
        renderItem={(period, { handle }) => {
            const selected = period.id === selectedId;
            const inactive = period.is_active === false;
            return (
                <>
                    {handle}
                    <button
                        type="button"
                        data-period-chip={period.id}
                        aria-pressed={selected}
                        onClick={() => onSelect(period.id)}
                        title={period.label}
                        className="min-h-[44px] min-w-[44px] pr-3 text-left font-black text-sm sm:text-base rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-bauhaus-blue"
                    >
                        <span className={`block truncate max-w-[10rem] sm:max-w-[18rem] ${inactive ? 'line-through' : ''}`}>{period.label}</span>
                        {inactive && <span className="sr-only">（已停用）</span>}
                    </button>
                </>
            );
        }}
        trailing={(
            <button
                type="button"
                data-new-period-toggle
                aria-expanded={creating}
                onClick={onToggleCreate}
                disabled={busy}
                className={`bh-btn px-4 min-h-[44px] ${creating ? 'bh-btn-yellow' : 'bh-btn-outline'}`}
            >
                <Plus className="w-4 h-4" aria-hidden="true" /> 新增期間
            </button>
        )}
    />
);

export default PeriodChips;
