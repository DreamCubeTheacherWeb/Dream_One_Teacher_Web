import { useMemo } from 'react';
import {
    DndContext,
    KeyboardSensor,
    PointerSensor,
    TouchSensor,
    closestCenter,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import {
    SortableContext,
    rectSortingStrategy,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { reorderIds } from '../../lib/salaryReportOptions';

// 後台共用的「拖曳排序清單」。
// - 只有把手（⋮⋮）能拖，列上的其他按鈕照常點；把手 ≥44×44px，touch-action:none。
// - 滑鼠／觸控／鍵盤（Space 拿起、方向鍵移動、Space 放下、Esc 取消）都能排。
// - 放開後只回報「新的 id 順序」；儲存與還原交給呼叫端。
// items：每項至少有 id；renderItem(item, { handle, isDragging }) 回傳列內容，handle 是現成的把手按鈕。

const instructions = '按空白鍵拿起，用方向鍵移動，再按空白鍵放下，按 Esc 取消。';

// 會換行的 chip 列：dnd-kit 預設的「找最近的方向鄰居」在換行時會跳到很遠的一格，
// 所以改成固定「下一個／上一個」：→ ↓ 往後一格，← ↑ 往前一格，並把被拖的項目對準那一格的中心。
const stepKeyboardCoordinates = (ids) => (event, { context: { active, collisionRect, droppableRects, over } }) => {
    const forward = event.code === 'ArrowRight' || event.code === 'ArrowDown';
    const backward = event.code === 'ArrowLeft' || event.code === 'ArrowUp';
    if (!forward && !backward) return undefined;
    event.preventDefault();
    if (!active || !collisionRect) return undefined;
    const from = ids.indexOf(over?.id ?? active.id);
    const targetId = ids[from + (forward ? 1 : -1)];
    const rect = targetId === undefined ? null : droppableRects.get(targetId);
    if (!rect) return undefined;
    return {
        x: rect.left + rect.width / 2 - collisionRect.width / 2,
        y: rect.top + rect.height / 2 - collisionRect.height / 2,
    };
};

const SortableRow = ({ item, label, as, className, renderItem, disabled }) => {
    const Tag = as;
    const {
        attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging,
    } = useSortable({ id: item.id, disabled });

    const handle = (
        <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            {...listeners}
            data-drag-handle
            aria-label={`拖曳排序「${label}」`}
            title="按住拖曳調整順序"
            className="shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] rounded-xl touch-none cursor-grab active:cursor-grabbing opacity-60 hover:opacity-100 hover:bg-bauhaus-black/10 focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-bauhaus-black"
        >
            <GripVertical className="w-5 h-5" aria-hidden="true" />
        </button>
    );

    const resolved = typeof className === 'function' ? className(item, { isDragging }) : className;
    return (
        <Tag
            ref={setNodeRef}
            style={{ transform: CSS.Translate.toString(transform), transition }}
            data-sortable-item
            data-dragging={isDragging ? 'true' : undefined}
            className={`${resolved || ''} ${isDragging ? 'relative z-20 shadow-hard-sm' : ''}`}
        >
            {renderItem(item, { handle, isDragging })}
        </Tag>
    );
};

const SortableList = ({
    items,
    onReorder,
    renderItem,
    getLabel = (item) => item.label,
    strategy = 'vertical',
    listAs = 'ul',
    itemAs = 'li',
    className,
    itemClassName,
    trailing = null,
    disabled = false,
    listLabel,
}) => {
    const List = listAs;
    const ids = useMemo(() => items.map((item) => item.id), [items]);
    const keyboardOptions = useMemo(
        () => ({ coordinateGetter: strategy === 'rect' ? stepKeyboardCoordinates(ids) : sortableKeyboardCoordinates }),
        [strategy, ids],
    );
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
        useSensor(KeyboardSensor, keyboardOptions),
    );

    const labels = useMemo(
        () => new Map(items.map((item) => [item.id, getLabel(item)])),
        [items, getLabel],
    );
    const nameOf = (id) => labels.get(id) ?? '';

    const announcements = {
        onDragStart: ({ active }) => `已拿起「${nameOf(active.id)}」。`,
        onDragOver: ({ active, over }) => (over ? `「${nameOf(active.id)}」移到「${nameOf(over.id)}」的位置。` : undefined),
        onDragEnd: ({ active, over }) => (over ? `「${nameOf(active.id)}」已放到「${nameOf(over.id)}」的位置。` : `「${nameOf(active.id)}」已放回原位。`),
        onDragCancel: ({ active }) => `已取消移動「${nameOf(active.id)}」。`,
    };

    const handleDragEnd = ({ active, over }) => {
        if (!over) return;
        const next = reorderIds(items, active.id, over.id);
        if (next) onReorder(next);
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            accessibility={{ announcements, screenReaderInstructions: { draggable: instructions } }}
        >
            <SortableContext items={ids} strategy={strategy === 'rect' ? rectSortingStrategy : verticalListSortingStrategy}>
                <List className={className} aria-label={listLabel}>
                    {items.map((item) => (
                        <SortableRow
                            key={item.id}
                            item={item}
                            label={nameOf(item.id)}
                            as={itemAs}
                            className={itemClassName}
                            renderItem={renderItem}
                            disabled={disabled}
                        />
                    ))}
                    {trailing}
                </List>
            </SortableContext>
        </DndContext>
    );
};

export default SortableList;
