import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabaseClient';
import {
    PERIOD_SECTIONS,
    applyOrder,
    itemsOfPeriod,
    newPeriodValue,
    nextSortOrder,
    optionErrorMessage,
    optionsLoadErrorMessage,
    periodsOf,
    pickPeriodId,
    planCopyItems,
    sectionConfig,
    validateOptionLabel,
} from '../../../lib/salaryReportOptions';
import NewPeriodPanel from './NewPeriodPanel';
import OptionSection from './OptionSection';
import PeriodChips from './PeriodChips';
import PeriodHeader from './PeriodHeader';
import { NoticeBar } from './ui';
import { usePanelState } from './usePanelState';

const TABLE = 'salary_report_options';
const COLUMNS = 'id,kind,value,label,sort_order,is_active,period_id';

const fetchOptions = () => supabase
    .from(TABLE)
    .select(COLUMNS)
    .order('kind', { ascending: true })
    .order('sort_order', { ascending: true });

// 分頁一「下拉選單內容」：上面是期間 chip，下面是選中期間的上課單位與營隊梯次。
const PeriodOptionsPanel = ({ refreshKey }) => {
    const { busy, notice, setNotice, showError, showSuccess, savedText, flashSaved, run } = usePanelState();
    const [rows, setRows] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [selectedId, setSelectedId] = useState(null);
    const [creating, setCreating] = useState(false);
    const [reloadTick, setReloadTick] = useState(0);
    const reload = () => setReloadTick((tick) => tick + 1);

    // 讀取在 effect 內非同步完成；handler 想重讀（例如排序失敗後）就呼叫 reload()。
    // 第一次讀取前 loading 預設為 true；之後重新整理／重讀是靜默更新（清單不閃成「讀取中」）。
    useEffect(() => {
        let cancelled = false;
        fetchOptions().then(({ data, error }) => {
            if (cancelled) return;
            if (error) {
                setLoadError(optionsLoadErrorMessage(error));
            } else {
                setLoadError('');
                setRows(data || []);
            }
            setLoading(false);
        });
        return () => { cancelled = true; };
    }, [refreshKey, reloadTick]);

    const periods = useMemo(() => periodsOf(rows), [rows]);
    const activeId = pickPeriodId(periods, selectedId);
    const activePeriod = periods.find((period) => period.id === activeId) || null;
    const toMessage = (fallback) => (error) => optionErrorMessage(error, fallback);

    // 單筆更新：.select() 讓 RLS 擋下（0 筆、不報錯）也能被發現
    const updateRow = async (id, patch) => {
        const { data, error } = await supabase.from(TABLE).update(patch).eq('id', id).select(COLUMNS);
        if (error) return { error };
        if (!data || data.length === 0) return { error: { message: '沒有更新到任何資料（可能沒有權限或選項已被刪除）' } };
        return { row: data[0] };
    };
    const applyRow = (saved) => setRows((current) => current.map((row) => (row.id === saved.id ? { ...row, ...saved } : row)));

    // 拖曳放開：先改畫面，再一次寫回；失敗就還原並重新讀取
    const saveOrder = (ids) => run(async () => {
        const previous = rows;
        setRows((current) => applyOrder(current, ids));
        const { error } = await supabase.rpc('reorder_salary_report_options', { p_ids: ids });
        if (error) {
            setRows(previous);
            showError(optionErrorMessage(error, '儲存順序失敗，已還原'));
            reload();
            return false;
        }
        flashSaved('已儲存順序');
        return true;
    }, toMessage('儲存順序失敗'));

    const toggleActive = (row, noun) => run(async () => {
        const { row: saved, error } = await updateRow(row.id, { is_active: !(row.is_active !== false) });
        if (error) {
            showError(optionErrorMessage(error, '更新啟用狀態失敗'));
            return false;
        }
        applyRow(saved);
        showSuccess(`已${saved.is_active ? '啟用' : '停用'}${noun}「${row.label}」。`);
        return true;
    }, toMessage('更新啟用狀態失敗'));

    // 改名：期間只改 label（value 是固定代碼）；單位／梯次的 value 一起改（講師回報存的是 value 文字）
    const rename = (row, rawLabel) => {
        const isPeriod = row.kind === 'term_period';
        const siblings = isPeriod ? periods : itemsOfPeriod(rows, row.period_id, row.kind);
        const noun = isPeriod ? '期間' : sectionConfig(row.kind)?.noun || '選項';
        const checked = validateOptionLabel(rawLabel, siblings, { ignoreId: row.id, noun });
        if (!checked.ok) {
            showError(checked.message);
            return Promise.resolve(false);
        }
        if (checked.label === row.label) return Promise.resolve(true);
        return run(async () => {
            const patch = isPeriod ? { label: checked.label } : { label: checked.label, value: checked.label };
            const { row: saved, error } = await updateRow(row.id, patch);
            if (error) {
                showError(optionErrorMessage(error, '儲存失敗'));
                return false;
            }
            applyRow(saved);
            showSuccess(`已改名為「${checked.label}」。`);
            return true;
        }, toMessage('儲存失敗'));
    };

    const addItem = (kind, rawLabel) => {
        if (!activePeriod) return Promise.resolve(false);
        const section = sectionConfig(kind);
        const siblings = itemsOfPeriod(rows, activePeriod.id, kind);
        const checked = validateOptionLabel(rawLabel, siblings, { noun: section.noun });
        if (!checked.ok) {
            showError(checked.message);
            return Promise.resolve(false);
        }
        return run(async () => {
            const payload = {
                kind,
                value: checked.label,
                label: checked.label,
                sort_order: nextSortOrder(siblings),
                is_active: true,
                period_id: activePeriod.id,
            };
            const { data, error } = await supabase.from(TABLE).insert(payload).select(COLUMNS);
            if (error) {
                showError(optionErrorMessage(error, '新增失敗'));
                return false;
            }
            if (!data || data.length === 0) {
                showError('新增後沒有取得資料，請按「重新整理」確認是否已新增。');
                reload();
                return false;
            }
            setRows((current) => [...current, ...data]);
            showSuccess(`已新增「${checked.label}」。`);
            return true;
        }, toMessage('新增失敗'));
    };

    const createPeriod = ({ name, copyFromId }) => {
        const checked = validateOptionLabel(name, periods, { noun: '期間' });
        if (!checked.ok) {
            showError(checked.message);
            return Promise.resolve(false);
        }
        return run(async () => {
            const { data: created, error } = await supabase
                .from(TABLE)
                .insert({
                    kind: 'term_period',
                    value: newPeriodValue(),
                    label: checked.label,
                    sort_order: nextSortOrder(periods),
                    is_active: true,
                })
                .select(COLUMNS)
                .single();
            if (error || !created) {
                showError(optionErrorMessage(error, '新增期間失敗'));
                return false;
            }
            setRows((current) => [...current, created]);
            setSelectedId(created.id);
            setCreating(false);

            const plan = copyFromId ? planCopyItems(rows, copyFromId, created.id) : [];
            if (plan.length === 0) {
                showSuccess(`已新增期間「${checked.label}」。`);
                return true;
            }
            const { data: copied, error: copyError } = await supabase.from(TABLE).insert(plan).select(COLUMNS);
            if (copyError) {
                showError(`期間已建立，但清單複製失敗。${optionErrorMessage(copyError, '')}`.trim());
                reload();
                return true;
            }
            setRows((current) => [...current, ...(copied || [])]);
            showSuccess(`已新增期間「${checked.label}」，並複製了 ${plan.length} 項清單。`);
            return true;
        }, toMessage('新增期間失敗'));
    };

    const itemsFor = (kind) => (activePeriod ? itemsOfPeriod(rows, activePeriod.id, kind) : []);

    return (
        <div data-panel="options">
            <NoticeBar notice={notice} savedText={savedText} onDismiss={() => setNotice(null)} />
            {loadError && (
                <div role="alert" className="mb-4 rounded-2xl border-2 lg:border-4 border-bauhaus-black bg-bauhaus-red p-4 font-bold text-white">
                    {loadError}
                </div>
            )}

            {loading ? (
                <div className="p-10 text-center font-bold text-bauhaus-black/50">正在讀取選項…</div>
            ) : !loadError && (
                <>
                    <PeriodChips
                        periods={periods}
                        selectedId={activeId}
                        creating={creating}
                        busy={busy}
                        onSelect={setSelectedId}
                        onReorder={saveOrder}
                        onToggleCreate={() => setCreating((open) => !open)}
                    />

                    {creating && (
                        <NewPeriodPanel
                            periods={periods}
                            options={rows}
                            defaultSourceId={activeId}
                            busy={busy}
                            onCreate={createPeriod}
                            onCancel={() => setCreating(false)}
                        />
                    )}

                    {activePeriod ? (
                        <>
                            <PeriodHeader
                                key={activePeriod.id}
                                period={activePeriod}
                                busy={busy}
                                onRename={rename}
                                onToggle={(period) => toggleActive(period, '期間')}
                            />
                            <div className="mt-4 flex flex-col gap-5">
                                {PERIOD_SECTIONS.map((section) => (
                                    <OptionSection
                                        key={`${activePeriod.id}:${section.kind}`}
                                        section={section}
                                        items={itemsFor(section.kind)}
                                        busy={busy}
                                        onAdd={addItem}
                                        onRename={rename}
                                        onToggle={(item) => toggleActive(item, section.noun)}
                                        onReorder={saveOrder}
                                    />
                                ))}
                            </div>
                        </>
                    ) : (
                        <p className="mt-6 rounded-2xl border-2 border-bauhaus-black bg-white p-8 text-center font-bold text-bauhaus-black/60">
                            還沒有任何期間。按「新增期間」建立第一個。
                        </p>
                    )}
                    <p className="mt-6 text-xs font-medium leading-relaxed text-bauhaus-black/55">
                        停用後講師看不到，舊紀錄不受影響，因此不提供刪除。
                    </p>
                </>
            )}
        </div>
    );
};

export default PeriodOptionsPanel;
