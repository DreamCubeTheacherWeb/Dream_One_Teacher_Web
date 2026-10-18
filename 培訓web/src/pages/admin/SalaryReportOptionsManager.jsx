import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowLeft, ArrowUp, Check, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import {
    OPTION_KINDS,
    OPTION_LABEL_MAX,
    canMove,
    kindConfig,
    nextSortOrder,
    optionErrorMessage,
    optionsOfKind,
    planMove,
    validateOptionLabel,
} from '../../lib/salaryReportOptions';

const COLUMNS = 'id,kind,value,label,sort_order,is_active';

const SalaryReportOptionsManager = () => {
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [activeKind, setActiveKind] = useState(OPTION_KINDS[0].kind);
    const [newLabel, setNewLabel] = useState('');
    const [editingId, setEditingId] = useState(null);
    const [editLabel, setEditLabel] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null); // { type: 'error' | 'success', text }
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        setLoadError('');
        const { data, error } = await supabase
            .from('salary_report_options')
            .select(COLUMNS)
            .order('kind', { ascending: true })
            .order('sort_order', { ascending: true });
        if (!mounted.current) return;
        if (error) {
            setLoadError(optionErrorMessage(error, '讀取選項失敗'));
        } else {
            setRows(data || []);
        }
        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const config = kindConfig(activeKind);
    const kindRows = useMemo(() => optionsOfKind(rows, activeKind), [rows, activeKind]);
    const activeCount = kindRows.filter((row) => row.is_active).length;

    const switchKind = (kind) => {
        setActiveKind(kind);
        setNewLabel('');
        setEditingId(null);
        setNotice(null);
    };

    // 單筆更新：.select() 讓 RLS 擋下（0 筆）也能被發現，而不是靜默成功
    const updateRow = async (id, patch) => {
        const { data, error } = await supabase
            .from('salary_report_options')
            .update(patch)
            .eq('id', id)
            .select(COLUMNS);
        if (error) return { error };
        if (!data || data.length === 0) {
            return { error: { message: '沒有更新到任何資料（可能沒有權限或選項已被刪除）' } };
        }
        return { row: data[0] };
    };

    const applyRows = (updated) => {
        setRows((current) => current.map((row) => {
            const next = updated.find((item) => item.id === row.id);
            return next ? { ...row, ...next } : row;
        }));
    };

    const runAction = async (task) => {
        if (busy) return;
        setBusy(true);
        setNotice(null);
        try {
            await task();
        } catch (error) {
            if (mounted.current) setNotice({ type: 'error', text: optionErrorMessage(error) });
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    const handleAdd = (event) => {
        event.preventDefault();
        if (!config?.canAdd) return;
        const checked = validateOptionLabel(newLabel, kindRows);
        if (!checked.ok) {
            setNotice({ type: 'error', text: checked.message });
            return;
        }
        runAction(async () => {
            const payload = {
                kind: activeKind,
                value: checked.label,
                label: checked.label,
                sort_order: nextSortOrder(kindRows),
            };
            const { data, error } = await supabase
                .from('salary_report_options')
                .insert(payload)
                .select(COLUMNS);
            if (error) {
                setNotice({ type: 'error', text: optionErrorMessage(error, '新增失敗') });
                return;
            }
            setRows((current) => [...current, ...(data?.length ? data : [{ id: `local-${payload.value}`, is_active: true, ...payload }])]);
            setNewLabel('');
            setNotice({ type: 'success', text: `已新增「${checked.label}」。` });
        });
    };

    const startEdit = (row) => {
        setEditingId(row.id);
        setEditLabel(row.label);
        setNotice(null);
    };

    const handleSaveLabel = (row) => {
        const checked = validateOptionLabel(editLabel, kindRows, { ignoreId: row.id });
        if (!checked.ok) {
            setNotice({ type: 'error', text: checked.message });
            return;
        }
        if (checked.label === row.label) {
            setEditingId(null);
            return;
        }
        runAction(async () => {
            // 合作單位／營隊梯次：講師回報存的是 value，所以改名時 value 一起改，才不會舊名繼續寫進新回報
            // 教學課程期間的 value 是固定代碼，只改 label
            const patch = row.kind === 'term_period'
                ? { label: checked.label }
                : { label: checked.label, value: checked.label };
            const { row: saved, error } = await updateRow(row.id, patch);
            if (error) {
                setNotice({ type: 'error', text: optionErrorMessage(error, '儲存失敗') });
                return;
            }
            applyRows([saved]);
            setEditingId(null);
            setNotice({ type: 'success', text: `已改名為「${checked.label}」。` });
        });
    };

    const handleToggle = (row) => {
        runAction(async () => {
            const { row: saved, error } = await updateRow(row.id, { is_active: !row.is_active });
            if (error) {
                setNotice({ type: 'error', text: optionErrorMessage(error, '更新啟用狀態失敗') });
                return;
            }
            applyRows([saved]);
            setNotice({ type: 'success', text: `已${saved.is_active ? '啟用' : '停用'}「${row.label}」。` });
        });
    };

    const handleMove = (row, direction) => {
        const updates = planMove(kindRows, row.id, direction);
        if (updates.length === 0) return;
        runAction(async () => {
            const results = await Promise.all(updates.map((update) => updateRow(update.id, { sort_order: update.sort_order })));
            const failed = results.find((result) => result.error);
            if (failed) {
                setNotice({ type: 'error', text: optionErrorMessage(failed.error, '調整排序失敗') });
                await load(); // 部分成功時以資料庫現況為準
                return;
            }
            applyRows(results.map((result) => result.row));
        });
    };

    return (
        <main className="p-4 sm:p-8 max-w-4xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
                <div className="min-w-0">
                    <Link to="/admin/salary" className="inline-flex items-center gap-1 min-h-[44px] text-sm font-black text-bauhaus-black/60 hover:text-bauhaus-blue mb-1">
                        <ArrowLeft className="w-4 h-4" /> 回薪資登記中心
                    </Link>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">回報選項管理</h1>
                    <p className="mt-2 text-sm sm:text-base font-medium text-bauhaus-black/65 leading-relaxed">
                        設定講師「登記課程回報」時，教學課程期間、合作單位、營隊梯次三個下拉選單有哪些選項可選。
                    </p>
                </div>
                <button type="button" onClick={load} disabled={loading || busy} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px] shrink-0 disabled:opacity-50">
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    {loading ? '讀取中' : '重新整理'}
                </button>
            </div>

            <div role="tablist" aria-label="選項種類" className="flex gap-2 mb-4 overflow-x-auto pb-1">
                {OPTION_KINDS.map((item) => {
                    const selected = item.kind === activeKind;
                    return (
                        <button
                            key={item.kind}
                            type="button"
                            role="tab"
                            aria-selected={selected}
                            onClick={() => switchKind(item.kind)}
                            className={`bh-btn px-4 py-2.5 min-h-[44px] whitespace-nowrap ${selected ? 'bh-btn-yellow' : 'bh-btn-outline'}`}
                        >
                            {item.title}
                        </button>
                    );
                })}
            </div>

            {loadError && (
                <div role="alert" className="mb-4 bg-bauhaus-red text-white border-2 lg:border-4 border-bauhaus-black rounded-2xl p-4 font-bold">
                    {loadError}
                </div>
            )}
            {notice && (
                <div
                    role={notice.type === 'error' ? 'alert' : 'status'}
                    className={`mb-4 border-2 border-bauhaus-black rounded-2xl p-3 text-sm font-bold ${notice.type === 'error' ? 'bg-bauhaus-red text-white' : 'bg-bauhaus-yellow text-bauhaus-black'}`}
                >
                    {notice.text}
                </div>
            )}

            <section className="bh-card overflow-hidden" role="tabpanel" aria-label={config.title}>
                <div className="bg-bauhaus-black text-white px-4 sm:px-6 py-4">
                    <h2 className="text-lg sm:text-xl font-black">{config.title}</h2>
                    <p className="mt-1 text-xs sm:text-sm font-medium text-white/75 leading-relaxed">
                        {config.hint}共 {kindRows.length} 項，啟用中 {activeCount} 項。
                    </p>
                </div>
                <p className="px-4 sm:px-6 py-3 text-xs sm:text-sm font-bold text-bauhaus-black/70 bg-bauhaus-cream border-b-2 border-bauhaus-black/20 leading-relaxed">
                    停用後講師看不到，舊紀錄不受影響。因此這裡不提供刪除。
                </p>

                {config.canAdd && (
                    <form onSubmit={handleAdd} className="p-4 sm:p-6 border-b-2 border-bauhaus-black/20 flex flex-col sm:flex-row gap-3 sm:items-end">
                        <label className="block flex-1 min-w-0">
                            <span className="bh-label block mb-1.5">新增{config.title}選項</span>
                            <input
                                type="text"
                                value={newLabel}
                                onChange={(event) => setNewLabel(event.target.value)}
                                maxLength={OPTION_LABEL_MAX + 50}
                                placeholder={activeKind === 'partner_unit' ? '例如：【新竹】新生國小 G3-6' : '例如：【臺北A】中山 | 7/1~7/3 三日營'}
                                className="bh-input min-h-[44px]"
                            />
                        </label>
                        <button type="submit" disabled={busy || loading} className="bh-btn bh-btn-blue px-5 py-2.5 min-h-[44px] shrink-0 disabled:opacity-50">
                            <Plus className="w-4 h-4" /> 新增
                        </button>
                    </form>
                )}

                {loading ? (
                    <div className="p-10 text-center font-bold text-bauhaus-black/50">正在讀取選項…</div>
                ) : kindRows.length === 0 ? (
                    <div className="p-10 text-center font-bold text-bauhaus-black/50">
                        {loadError ? '無法顯示選項。' : '這個分頁還沒有任何選項。'}
                    </div>
                ) : (
                    <ul className="divide-y-2 divide-bauhaus-black/15">
                        {kindRows.map((row) => {
                            const editing = editingId === row.id;
                            return (
                                <li key={row.id} data-option-row className={`p-4 sm:px-6 flex flex-col gap-3 ${row.is_active ? 'bg-white' : 'bg-bauhaus-muted/60'}`}>
                                    <div className="flex items-start gap-3 min-w-0">
                                        <span className="shrink-0 mt-0.5 min-w-[2.5rem] text-center text-xs font-black bg-bauhaus-muted text-bauhaus-black/70 rounded-lg px-2 py-1" title="排序值">
                                            {row.sort_order}
                                        </span>
                                        {editing ? (
                                            <input
                                                type="text"
                                                value={editLabel}
                                                onChange={(event) => setEditLabel(event.target.value)}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter') { event.preventDefault(); handleSaveLabel(row); }
                                                    if (event.key === 'Escape') setEditingId(null);
                                                }}
                                                aria-label={`編輯「${row.label}」的顯示文字`}
                                                maxLength={OPTION_LABEL_MAX + 50}
                                                autoFocus
                                                className="bh-input min-h-[44px] flex-1 min-w-0"
                                            />
                                        ) : (
                                            <div className="min-w-0 flex-1">
                                                <p className={`font-black break-words leading-snug ${row.is_active ? 'text-bauhaus-black' : 'text-bauhaus-black/45 line-through'}`}>
                                                    {row.label}
                                                </p>
                                                {!row.is_active && <span className="inline-block mt-1 text-xs font-black text-bauhaus-black/55">已停用，講師看不到</span>}
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex flex-wrap items-center gap-2">
                                        {editing ? (
                                            <>
                                                <button type="button" onClick={() => handleSaveLabel(row)} disabled={busy} className="bh-btn bh-btn-blue px-4 py-2 min-h-[44px] disabled:opacity-50">
                                                    <Check className="w-4 h-4" /> 儲存
                                                </button>
                                                <button type="button" onClick={() => setEditingId(null)} disabled={busy} className="bh-btn bh-btn-outline px-4 py-2 min-h-[44px]">
                                                    <X className="w-4 h-4" /> 取消
                                                </button>
                                            </>
                                        ) : (
                                            <>
                                                <button
                                                    type="button"
                                                    onClick={() => handleMove(row, 'up')}
                                                    disabled={busy || !canMove(kindRows, row.id, 'up')}
                                                    aria-label={`上移「${row.label}」`}
                                                    className="bh-btn bh-btn-outline min-h-[44px] min-w-[44px] px-3 disabled:opacity-40"
                                                >
                                                    <ArrowUp className="w-4 h-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => handleMove(row, 'down')}
                                                    disabled={busy || !canMove(kindRows, row.id, 'down')}
                                                    aria-label={`下移「${row.label}」`}
                                                    className="bh-btn bh-btn-outline min-h-[44px] min-w-[44px] px-3 disabled:opacity-40"
                                                >
                                                    <ArrowDown className="w-4 h-4" />
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => startEdit(row)}
                                                    disabled={busy}
                                                    aria-label={`改名「${row.label}」`}
                                                    className="bh-btn bh-btn-outline px-3 min-h-[44px] disabled:opacity-40"
                                                >
                                                    <Pencil className="w-4 h-4" /> 改名
                                                </button>
                                                <button
                                                    type="button"
                                                    role="switch"
                                                    aria-checked={row.is_active}
                                                    aria-label={`啟用「${row.label}」`}
                                                    onClick={() => handleToggle(row)}
                                                    disabled={busy}
                                                    className={`bh-btn px-3 min-h-[44px] disabled:opacity-40 ${row.is_active ? 'bh-btn-yellow' : 'bh-btn-outline'}`}
                                                >
                                                    {row.is_active ? '啟用中' : '已停用'}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </section>
        </main>
    );
};

export default SalaryReportOptionsManager;
