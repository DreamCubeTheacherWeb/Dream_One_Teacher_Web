import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import SortableList from '../../../components/admin/SortableList';
import { supabase } from '../../../lib/supabaseClient';
import { applyOrder, nextSortOrder } from '../../../lib/salaryReportOptions';
import {
    PINNED_FIELD_LABELS,
    REPORT_LAYOUTS,
    allFieldsOfLayout,
    newCustomFieldKey,
    reportFieldErrorMessage,
} from '../../../lib/salaryReportFields';
import FieldEditor from './FieldEditor';
import FieldRow from './FieldRow';
import { NoticeBar } from './ui';
import { usePanelState } from './usePanelState';

const TABLE = 'salary_report_fields';
const COLUMNS = 'id,layout,field_key,source,label,field_type,options,help_text,is_required,is_visible,sort_order';
const fetchFields = () => supabase
    .from(TABLE)
    .select(COLUMNS)
    .order('layout', { ascending: true })
    .order('sort_order', { ascending: true });
const LOAD_FAILED = '讀取表單欄位失敗，資料庫可能還沒套用 2026-10-20 的更新';

const rowClass = (field, { isDragging }) => {
    if (isDragging) return 'bg-bauhaus-cream';
    return field.is_visible === false ? 'bg-bauhaus-muted/70' : 'bg-white';
};

// 分頁二「回報表單欄位」：四個回報版面各一份欄位清單，可拖曳排序、顯示／隱藏、新增與刪除自訂欄位。
const ReportFieldsPanel = ({ refreshKey }) => {
    const { busy, notice, setNotice, showError, showSuccess, savedText, flashSaved, run } = usePanelState();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [layout, setLayout] = useState(REPORT_LAYOUTS[0].key);
    const [editingId, setEditingId] = useState(null); // 'new' | 欄位 id | null
    const [deletingId, setDeletingId] = useState(null);
    const [reloadTick, setReloadTick] = useState(0);
    const reload = () => setReloadTick((tick) => tick + 1);

    // 第一次讀取前 loading 預設為 true；之後重新整理／失敗後重讀都是靜默更新（清單不閃成「讀取中」）
    // 讀取在 effect 內非同步完成；handler 想重讀（例如排序失敗後）就呼叫 reload()。
    useEffect(() => {
        let cancelled = false;
        fetchFields().then(({ data, error }) => {
            if (cancelled) return;
            if (error) {
                setLoadError(error.message ? `${LOAD_FAILED}（${error.message}）` : LOAD_FAILED);
            } else {
                setLoadError('');
                setRows(data || []);
            }
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [refreshKey, reloadTick]);

    const fields = useMemo(() => allFieldsOfLayout(rows, layout), [rows, layout]);
    const layoutInfo = REPORT_LAYOUTS.find((item) => item.key === layout);
    const toMessage = (fallback) => (error) => reportFieldErrorMessage(error, fallback);

    const switchLayout = (key) => {
        setLayout(key);
        setEditingId(null);
        setDeletingId(null);
    };

    const updateField = async (id, patch) => {
        const { data, error } = await supabase.from(TABLE).update(patch).eq('id', id).select(COLUMNS);
        if (error) return { error };
        if (!data || data.length === 0) return { error: { message: '沒有更新到任何資料（可能沒有權限或欄位已被刪除）' } };
        return { row: data[0] };
    };
    const applyRow = (saved) => setRows((current) => current.map((row) => (row.id === saved.id ? { ...row, ...saved } : row)));

    const saveOrder = (ids) => run(async () => {
        const previous = rows;
        setRows((current) => applyOrder(current, ids));
        const { error } = await supabase.rpc('reorder_salary_report_fields', { p_ids: ids });
        if (error) {
            setRows(previous);
            showError(reportFieldErrorMessage(error, '儲存順序失敗，已還原'));
            reload();
            return false;
        }
        flashSaved('已儲存順序');
        return true;
    }, toMessage('儲存順序失敗'));

    const toggleVisible = (field) => run(async () => {
        const { row, error } = await updateField(field.id, { is_visible: !field.is_visible });
        if (error) {
            showError(reportFieldErrorMessage(error, '更新顯示狀態失敗'));
            return false;
        }
        applyRow(row);
        showSuccess(`已${row.is_visible ? '顯示' : '隱藏'}「${field.label}」。`);
        return true;
    }, toMessage('更新顯示狀態失敗'));

    const toggleRequired = (field) => run(async () => {
        const { row, error } = await updateField(field.id, { is_required: !field.is_required });
        if (error) {
            showError(reportFieldErrorMessage(error, '更新必填設定失敗'));
            return false;
        }
        applyRow(row);
        showSuccess(`「${field.label}」${row.is_required ? '改為必填' : '改為選填'}。`);
        return true;
    }, toMessage('更新必填設定失敗'));

    // 新增或編輯自訂欄位；回傳 { ok, message } 給編輯面板顯示
    const saveField = (value) => run(async () => {
        if (editingId === 'new') {
            const payload = {
                layout,
                field_key: newCustomFieldKey(),
                source: 'custom',
                ...value,
                is_visible: true,
                sort_order: nextSortOrder(fields),
            };
            const { data, error } = await supabase.from(TABLE).insert(payload).select(COLUMNS);
            if (error) return { ok: false, message: reportFieldErrorMessage(error, '新增失敗') };
            if (!data || data.length === 0) {
                reload();
                return { ok: false, message: '新增後沒有取得資料，請按「重新整理」確認是否已新增。' };
            }
            setRows((current) => [...current, ...data]);
            setEditingId(null);
            showSuccess(`已新增欄位「${value.label}」。`);
            return { ok: true };
        }
        const { row, error } = await updateField(editingId, value);
        if (error) return { ok: false, message: reportFieldErrorMessage(error, '儲存失敗') };
        applyRow(row);
        setEditingId(null);
        showSuccess(`已儲存欄位「${value.label}」。`);
        return { ok: true };
    }, (error) => reportFieldErrorMessage(error, '儲存失敗'));

    const deleteField = (field) => run(async () => {
        const { data, error } = await supabase.from(TABLE).delete().eq('id', field.id).select('id');
        if (error) {
            showError(reportFieldErrorMessage(error, '刪除失敗'));
            return false;
        }
        if (!data || data.length === 0) {
            showError('沒有刪除到任何資料（可能沒有權限或欄位已被刪除）');
            reload();
            return false;
        }
        setRows((current) => current.filter((row) => row.id !== field.id));
        setDeletingId(null);
        showSuccess(`已刪除欄位「${field.label}」。`);
        return true;
    }, toMessage('刪除失敗'));

    return (
        <div data-panel="fields">
            <NoticeBar notice={notice} savedText={savedText} onDismiss={() => setNotice(null)} />
            {loadError && (
                <div role="alert" data-fields-load-error className="mb-4 rounded-2xl border-2 lg:border-4 border-bauhaus-black bg-bauhaus-red p-4 font-bold text-white">
                    {loadError}
                </div>
            )}

            {loading ? (
                <div className="p-10 text-center font-bold text-bauhaus-black/50">正在讀取表單欄位…</div>
            ) : !loadError && (
                <>
                    <div role="tablist" aria-label="回報版面" className="flex flex-wrap gap-2">
                        {REPORT_LAYOUTS.map((item) => {
                            const selected = item.key === layout;
                            return (
                                <button
                                    key={item.key}
                                    type="button"
                                    role="tab"
                                    aria-selected={selected}
                                    data-layout-tab={item.key}
                                    onClick={() => switchLayout(item.key)}
                                    className={`min-h-[44px] rounded-xl border-2 border-bauhaus-black px-4 text-sm sm:text-base font-black transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-bauhaus-blue focus-visible:ring-offset-2 ${selected ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-cream'}`}
                                >
                                    {item.label}
                                </button>
                            );
                        })}
                    </div>
                    <p className="mt-2 text-xs font-medium text-bauhaus-black/60">{layoutInfo?.hint}</p>

                    <p data-pinned-line className="mt-4 rounded-xl border-2 border-bauhaus-black/30 bg-white px-3 py-2 text-xs sm:text-sm font-bold leading-relaxed text-bauhaus-black/70">
                        固定在最上面、不能調整：{PINNED_FIELD_LABELS.join('、')}
                    </p>

                    <section data-fields-card className="mt-4 bh-card overflow-hidden" aria-label={`${layoutInfo?.label}的欄位`}>
                        <div className="flex flex-wrap items-center justify-between gap-2 bg-bauhaus-black px-4 sm:px-5 py-3 text-white">
                            <h2 className="text-lg font-black">表單欄位<span className="ml-2 text-xs font-black text-bauhaus-yellow">共 {fields.length} 個</span></h2>
                            <button
                                type="button"
                                data-add-field
                                onClick={() => { setEditingId('new'); setDeletingId(null); }}
                                disabled={busy || editingId === 'new'}
                                className="bh-btn bh-btn-yellow px-4 min-h-[44px] shadow-hard-white"
                            >
                                <Plus className="w-4 h-4" aria-hidden="true" /> 新增欄位
                            </button>
                        </div>
                        {editingId === 'new' && (
                            <div className="border-b-2 border-bauhaus-black/20">
                                <FieldEditor key="new" siblings={fields} busy={busy} onSave={saveField} onCancel={() => setEditingId(null)} />
                            </div>
                        )}
                        {fields.length === 0 ? (
                            <p className="px-4 py-8 text-center text-sm font-bold text-bauhaus-black/50">這個版面還沒有欄位設定。</p>
                        ) : (
                            <SortableList
                                items={fields}
                                onReorder={saveOrder}
                                disabled={busy || editingId !== null || deletingId !== null}
                                listLabel={`${layoutInfo?.label}的欄位（可拖曳調整順序）`}
                                className="divide-y-2 divide-bauhaus-black/15"
                                itemClassName={(field, state) => (editingId === field.id ? 'bg-bauhaus-cream' : rowClass(field, state))}
                                renderItem={(field, { handle }) => (
                                    editingId === field.id ? (
                                        <FieldEditor key={field.id} field={field} siblings={fields} busy={busy} onSave={saveField} onCancel={() => setEditingId(null)} />
                                    ) : (
                                        <FieldRow
                                            field={field}
                                            handle={handle}
                                            busy={busy}
                                            confirmingDelete={deletingId === field.id}
                                            onToggleVisible={toggleVisible}
                                            onToggleRequired={toggleRequired}
                                            onEdit={(target) => { setEditingId(target.id); setDeletingId(null); }}
                                            onAskDelete={(target) => { setDeletingId(target.id); setEditingId(null); }}
                                            onCancelDelete={() => setDeletingId(null)}
                                            onDelete={deleteField}
                                        />
                                    )
                                )}
                            />
                        )}
                    </section>
                    <p className="mt-6 text-xs font-medium leading-relaxed text-bauhaus-black/55">
                        「算報酬用」的欄位會影響報酬計算，只能調整順序；內建欄位可以隱藏；自訂欄位可以改名或刪除（刪除後講師之前填的內容仍保留在舊紀錄）。
                    </p>
                </>
            )}
        </div>
    );
};

export default ReportFieldsPanel;
