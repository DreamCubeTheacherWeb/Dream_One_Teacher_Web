import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabaseClient';
import {
    Trophy, Search, Trash2, Ban, RotateCcw, ShieldAlert, Plus, X, Save, AlertTriangle,
} from 'lucide-react';
import { WCA_SELF_EVENTS, parseTimeToCs, formatWcaResult } from '../../lib/wca';

const WcaManager = () => {
    const [instructors, setInstructors] = useState([]);
    const [countMap, setCountMap] = useState({}); // instructor_id → WCA 成績筆數
    const [instructorsLoaded, setInstructorsLoaded] = useState(false);
    const [filterText, setFilterText] = useState('');
    const [onlyPending, setOnlyPending] = useState(false); // 只看「填了 ID 但尚未登錄成績」
    const [selectedInstructor, setSelectedInstructor] = useState(null);
    const [resultCount, setResultCount] = useState(0);
    const [detailLoading, setDetailLoading] = useState(false);
    const [acting, setActing] = useState(false);
    const [errMsg, setErrMsg] = useState('');
    // 各項目成績（後台代填）：[{ event_id, single, average }]，single/average 為時間字串
    const [wcaRows, setWcaRows] = useState([]);
    const [savingResults, setSavingResults] = useState(false);

    // 一次載入：全部講師 + 每人的 WCA 成績筆數（用來組「有 WCA 資料」清單）
    useEffect(() => {
        (async () => {
            const [{ data: insts, error: iErr }, { data: results, error: rErr }] = await Promise.all([
                supabase
                    .from('instructors')
                    .select('id, full_name, nickname, wca_id, wca_name, hide_from_leaderboard')
                    .order('full_name'),
                supabase.from('wca_results').select('instructor_id'),
            ]);
            if (iErr) console.error('讀取講師清單失敗', iErr);
            if (rErr) console.error('讀取 WCA 成績筆數失敗', rErr);
            const cmap = {};
            (results || []).forEach((r) => { cmap[r.instructor_id] = (cmap[r.instructor_id] || 0) + 1; });
            setInstructors(insts || []);
            setCountMap(cmap);
            setInstructorsLoaded(true);
        })();
    }, []);

    // 「有 WCA 資料」＝填了 WCA ID，或已有任何成績列
    const wcaInstructors = useMemo(
        () => instructors.filter((i) => (i.wca_id && i.wca_id.trim()) || (countMap[i.id] || 0) > 0),
        [instructors, countMap]
    );

    const pendingCount = useMemo(
        () => wcaInstructors.filter((i) => (i.wca_id && i.wca_id.trim()) && (countMap[i.id] || 0) === 0).length,
        [wcaInstructors, countMap]
    );

    const filtered = useMemo(() => {
        const s = filterText.trim().toLowerCase();
        return wcaInstructors.filter((i) => {
            if (onlyPending && !((i.wca_id && i.wca_id.trim()) && (countMap[i.id] || 0) === 0)) return false;
            if (!s) return true;
            return (
                i.full_name?.toLowerCase().includes(s) ||
                i.nickname?.toLowerCase().includes(s) ||
                i.wca_id?.toLowerCase().includes(s)
            );
        });
    }, [wcaInstructors, filterText, onlyPending, countMap]);

    const loadDetail = async (inst) => {
        setDetailLoading(true);
        // 讀出可管理項目的成績，轉回可編輯的時間字串（與 parseTimeToCs 為往返組）。
        // 特殊格式匯入項目（333fm/333mbf）不在白名單、不在此顯示，也不會被覆蓋。
        const allowed = new Set(WCA_SELF_EVENTS.map((e) => e.id));
        const { data: wr } = await supabase
            .from('wca_results')
            .select('event_id, best_single, best_average')
            .eq('instructor_id', inst.id);
        const all = wr || [];
        setResultCount(all.length);
        setCountMap((m) => ({ ...m, [inst.id]: all.length }));
        const rows = all
            .filter((r) => allowed.has(r.event_id))
            .sort((a, b) =>
                WCA_SELF_EVENTS.findIndex((e) => e.id === a.event_id) -
                WCA_SELF_EVENTS.findIndex((e) => e.id === b.event_id))
            .map((r) => ({
                event_id: r.event_id,
                single: r.best_single != null ? formatWcaResult(r.event_id, r.best_single) : '',
                average: r.best_average != null ? formatWcaResult(r.event_id, r.best_average) : '',
            }));
        setWcaRows(rows);
        setDetailLoading(false);
    };

    const selectInstructor = (inst) => {
        setSelectedInstructor(inst);
        setErrMsg('');
        loadDetail(inst);
    };

    const refreshSelected = async (instructorId) => {
        const { data } = await supabase
            .from('instructors')
            .select('id, full_name, nickname, wca_id, wca_name, hide_from_leaderboard')
            .eq('id', instructorId)
            .maybeSingle();
        if (data) {
            setSelectedInstructor(data);
            setInstructors((list) => list.map((i) => (i.id === data.id ? data : i)));
        }
    };

    // 各項目成績列操作
    const addWcaRow = () => setWcaRows((prev) => {
        const used = new Set(prev.map((r) => r.event_id));
        const next = WCA_SELF_EVENTS.find((e) => !used.has(e.id));
        if (!next) return prev;
        return [...prev, { event_id: next.id, single: '', average: '' }];
    });
    const updateWcaRow = (idx, field, value) =>
        setWcaRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
    const removeWcaRow = (idx) => setWcaRows((prev) => prev.filter((_, i) => i !== idx));

    const handleSaveResults = async () => {
        if (!selectedInstructor) return;
        const invalid = [];
        const payload = [];
        for (const row of wcaRows) {
            if (!row.event_id) continue;
            const evName = WCA_SELF_EVENTS.find((e) => e.id === row.event_id)?.name || row.event_id;
            const single = parseTimeToCs(row.single);
            const average = parseTimeToCs(row.average);
            if (Number.isNaN(single)) invalid.push(`${evName}單次`);
            if (Number.isNaN(average)) invalid.push(`${evName}平均`);
            if (single == null && average == null) continue; // 兩格皆空的列略過
            payload.push({ event_id: row.event_id, best_single: single ?? null, best_average: average ?? null });
        }
        if (invalid.length) {
            setErrMsg('以下成績格式不正確（範例：12.34 或 1:23.45）：' + invalid.join('、'));
            return;
        }
        setSavingResults(true);
        setErrMsg('');
        const { error } = await supabase.rpc('admin_upsert_wca_results', {
            p_instructor_id: selectedInstructor.id,
            p_results: payload,
        });
        setSavingResults(false);
        if (error) { setErrMsg('成績儲存失敗：' + error.message); return; }
        await loadDetail(selectedInstructor);
    };

    const handleClear = async () => {
        if (!selectedInstructor) return;
        if (!window.confirm(`確定要清除「${selectedInstructor.full_name}」的 WCA 資料嗎？\n這會刪除他所有的 WCA 成績紀錄，並清空 WCA 選手編號，無法復原。`)) return;
        setActing(true);
        setErrMsg('');
        const { error } = await supabase.rpc('admin_clear_wca', { p_instructor_id: selectedInstructor.id });
        setActing(false);
        if (error) { setErrMsg('清除失敗：' + error.message); return; }
        setCountMap((m) => ({ ...m, [selectedInstructor.id]: 0 }));
        setWcaRows([]);
        setResultCount(0);
        await refreshSelected(selectedInstructor.id);
    };

    const handleSuspend = async () => {
        if (!selectedInstructor) return;
        if (!window.confirm(`確定要停權「${selectedInstructor.full_name}」的 WCA 資格嗎？\n停權後他不會出現在任何排行榜，且個人頁的 WCA 欄位會被鎖住，無法再自行填寫。`)) return;
        setActing(true);
        setErrMsg('');
        const { error } = await supabase.from('instructors').update({ hide_from_leaderboard: true }).eq('id', selectedInstructor.id);
        setActing(false);
        if (error) { setErrMsg('停權失敗：' + error.message); return; }
        await refreshSelected(selectedInstructor.id);
    };

    const handleRestore = async () => {
        if (!selectedInstructor) return;
        if (!window.confirm(`確定要復權「${selectedInstructor.full_name}」嗎？\n復權後他會恢復出現在排行榜，且可再次自行填寫 WCA 欄位。`)) return;
        setActing(true);
        setErrMsg('');
        const { error } = await supabase.from('instructors').update({ hide_from_leaderboard: false }).eq('id', selectedInstructor.id);
        setActing(false);
        if (error) { setErrMsg('復權失敗：' + error.message); return; }
        await refreshSelected(selectedInstructor.id);
    };

    if (!instructorsLoaded) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    const isPending = (i) => (i.wca_id && i.wca_id.trim()) && (countMap[i.id] || 0) === 0;

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight flex items-center gap-2">
                    <Trophy className="w-7 h-7 lg:w-9 lg:h-9" /> WCA 資料管理
                </h1>
                <p className="text-bauhaus-black/60 font-medium mt-1">維護有 WCA 資料的講師：登錄／更新各項目成績，或清除、停權亂填者</p>
            </div>

            {/* 統計列 */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
                <div className="bh-card p-4">
                    <div className="bh-label mb-1">有 WCA 資料</div>
                    <div data-testid="wca-total" className="text-2xl font-black text-bauhaus-black tabular-nums">{wcaInstructors.length}<span className="text-sm font-bold text-bauhaus-black/40"> 位</span></div>
                </div>
                <div className="bh-card p-4">
                    <div className="bh-label mb-1">尚未登錄成績</div>
                    <div data-testid="wca-pending" className={`text-2xl font-black tabular-nums ${pendingCount > 0 ? 'text-bauhaus-red' : 'text-bauhaus-black'}`}>{pendingCount}<span className="text-sm font-bold text-bauhaus-black/40"> 位</span></div>
                </div>
                <div className="bh-card p-4 col-span-2 sm:col-span-1">
                    <div className="bh-label mb-1">篩選中顯示</div>
                    <div className="text-2xl font-black text-bauhaus-black tabular-nums">{filtered.length}<span className="text-sm font-bold text-bauhaus-black/40"> 位</span></div>
                </div>
            </div>

            <div className="lg:grid lg:grid-cols-[340px_1fr] lg:gap-6 lg:items-start">
                {/* ── 左：清單 ── */}
                <div className="bh-card p-4 mb-6 lg:mb-0 lg:sticky lg:top-4">
                    <div className="relative mb-3">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-bauhaus-black/40" />
                        <input
                            type="text"
                            data-testid="wca-instructor-search"
                            placeholder="搜尋姓名／暱稱／WCA ID⋯⋯"
                            value={filterText}
                            onChange={(e) => setFilterText(e.target.value)}
                            className="bh-input pl-10 pr-3 py-2.5 text-sm"
                        />
                    </div>
                    <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                        <input type="checkbox" data-testid="wca-only-pending" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} className="w-4 h-4 accent-bauhaus-red" />
                        <span className="text-sm font-bold text-bauhaus-black">只看尚未登錄成績</span>
                    </label>

                    <div data-testid="wca-instructor-list" className="max-h-[60vh] overflow-y-auto -mx-1 px-1 space-y-1.5">
                        {filtered.length === 0 && (
                            <div className="py-8 text-center text-bauhaus-black/40 font-bold text-sm">
                                {wcaInstructors.length === 0 ? '目前沒有任何講師有 WCA 資料' : '查無符合的講師'}
                            </div>
                        )}
                        {filtered.map((inst) => {
                            const selected = selectedInstructor?.id === inst.id;
                            const cnt = countMap[inst.id] || 0;
                            return (
                                <button
                                    key={inst.id}
                                    data-testid={`wca-instructor-option-${inst.id}`}
                                    onClick={() => selectInstructor(inst)}
                                    className={`w-full text-left px-3 py-2.5 rounded-xl border-2 transition-colors ${selected ? 'border-bauhaus-black bg-bauhaus-black text-white' : 'border-bauhaus-black/15 hover:border-bauhaus-black/40 bg-white'}`}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="font-bold truncate">{inst.full_name}</span>
                                        <span className={`text-[11px] font-bold tabular-nums shrink-0 ${selected ? 'text-white/60' : 'text-bauhaus-black/40'}`}>{cnt} 筆</span>
                                    </div>
                                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                                        <span className={`text-[11px] font-mono ${selected ? 'text-white/70' : 'text-bauhaus-black/50'}`}>{inst.wca_id || '（無 WCA ID）'}</span>
                                        {isPending(inst) && (
                                            <span className="bh-chip bg-bauhaus-red text-white text-[10px] py-0"><AlertTriangle className="w-2.5 h-2.5" />待登錄</span>
                                        )}
                                        {inst.hide_from_leaderboard && (
                                            <span className="bh-chip bg-bauhaus-black/70 text-white text-[10px] py-0">已停權</span>
                                        )}
                                    </div>
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* ── 右：明細／編輯 ── */}
                {!selectedInstructor ? (
                    <div className="py-16 text-center bg-bauhaus-paper border-2 border-dashed border-bauhaus-black/30 rounded-2xl">
                        <Trophy className="w-10 h-10 text-bauhaus-black/20 mx-auto mb-3" />
                        <p className="text-bauhaus-black/40 font-bold">從左側清單點選一位講師開始維護</p>
                    </div>
                ) : (
                    <div data-testid="wca-detail-panel" className="bh-card overflow-hidden">
                        <div className="p-4 border-b-2 lg:border-b-4 border-bauhaus-black bg-bauhaus-black text-white flex items-center gap-2">
                            <span className="font-black">{selectedInstructor.full_name}</span>
                            {selectedInstructor.nickname && <span className="text-xs text-white/50">{selectedInstructor.nickname}</span>}
                        </div>

                        <div className="p-4 sm:p-6 space-y-4">
                            {errMsg && (
                                <div className="bg-bauhaus-red/10 border-2 border-bauhaus-red px-3 py-2 text-sm font-bold text-bauhaus-red">{errMsg}</div>
                            )}

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                <div className="border-2 border-bauhaus-black/20 rounded-xl p-3">
                                    <div className="bh-label mb-1">WCA 選手編號</div>
                                    <div data-testid="wca-detail-id" className="font-bold text-bauhaus-black">{selectedInstructor.wca_id || '未填'}</div>
                                </div>
                                <div className="border-2 border-bauhaus-black/20 rounded-xl p-3">
                                    <div className="bh-label mb-1">WCA 成績筆數</div>
                                    <div data-testid="wca-detail-count" className="font-bold text-bauhaus-black tabular-nums">{detailLoading ? '載入中...' : resultCount}</div>
                                </div>
                                <div className="border-2 border-bauhaus-black/20 rounded-xl p-3">
                                    <div className="bh-label mb-1">目前狀態</div>
                                    <span data-testid="wca-detail-status" className={`bh-chip ${selectedInstructor.hide_from_leaderboard ? 'bg-bauhaus-red text-white' : 'bg-bauhaus-blue text-white'}`}>
                                        <ShieldAlert className="w-3 h-3" />
                                        {selectedInstructor.hide_from_leaderboard ? '已停權' : '上榜中'}
                                    </span>
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-3 pt-2">
                                <button
                                    data-testid="wca-action-clear"
                                    disabled={acting}
                                    onClick={handleClear}
                                    className="bh-btn bh-btn-red px-4 py-2.5 text-sm disabled:opacity-50"
                                >
                                    <Trash2 className="w-4 h-4" /> 清除 WCA 資料
                                </button>

                                {selectedInstructor.hide_from_leaderboard ? (
                                    <button
                                        data-testid="wca-action-restore"
                                        disabled={acting}
                                        onClick={handleRestore}
                                        className="bh-btn bh-btn-blue px-4 py-2.5 text-sm disabled:opacity-50"
                                    >
                                        <RotateCcw className="w-4 h-4" /> 復權
                                    </button>
                                ) : (
                                    <button
                                        data-testid="wca-action-suspend"
                                        disabled={acting}
                                        onClick={handleSuspend}
                                        className="bh-btn bh-btn-outline px-4 py-2.5 text-sm disabled:opacity-50"
                                    >
                                        <Ban className="w-4 h-4" /> 停權
                                    </button>
                                )}
                            </div>

                            <div className="pt-4 mt-2 border-t-2 border-bauhaus-black/15">
                                <div className="bh-label mb-1">各項目成績（後台代填）</div>
                                <p className="text-xs text-bauhaus-black/50 font-medium mb-3 leading-relaxed">
                                    替這位講師登錄各項目最佳成績，「單次」「平均」可擇一或都填。
                                    時間格式：<b>12.34</b>（秒）或 <b>1:23.45</b>（分:秒）。儲存採覆蓋制（以此清單取代其可管理項目的舊成績）。
                                </p>
                                <div className="space-y-3">
                                    {wcaRows.length === 0 && (
                                        <p className="text-sm text-bauhaus-black/40 font-bold">尚無項目，點「新增項目」開始登錄。</p>
                                    )}
                                    {wcaRows.map((row, idx) => {
                                        const used = new Set(wcaRows.map((r) => r.event_id));
                                        return (
                                            <div key={idx} data-testid={`wca-result-row-${idx}`} className="border-2 border-bauhaus-black rounded-lg bg-white p-3 grid grid-cols-2 sm:grid-cols-[1.3fr_1fr_1fr_auto] gap-2 sm:items-end">
                                                <div className="col-span-2 sm:col-span-1">
                                                    <label className="bh-label text-[10px] block mb-1">項目</label>
                                                    <select value={row.event_id} onChange={(e) => updateWcaRow(idx, 'event_id', e.target.value)} className="bh-input bg-white">
                                                        {WCA_SELF_EVENTS.filter((e) => e.id === row.event_id || !used.has(e.id)).map((e) => (
                                                            <option key={e.id} value={e.id}>{e.name}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="bh-label text-[10px] block mb-1">單次</label>
                                                    <input inputMode="decimal" value={row.single} onChange={(e) => updateWcaRow(idx, 'single', e.target.value)} className="bh-input" placeholder="12.34" />
                                                </div>
                                                <div>
                                                    <label className="bh-label text-[10px] block mb-1">平均</label>
                                                    <input inputMode="decimal" value={row.average} onChange={(e) => updateWcaRow(idx, 'average', e.target.value)} className="bh-input" placeholder="13.50" />
                                                </div>
                                                <div className="col-span-2 sm:col-span-1 flex sm:block justify-end">
                                                    <button type="button" onClick={() => removeWcaRow(idx)} className="bh-btn bh-btn-outline p-2.5" aria-label="移除項目" title="移除項目">
                                                        <X className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                                <div className="flex flex-wrap gap-3 mt-3">
                                    {wcaRows.length < WCA_SELF_EVENTS.length && (
                                        <button type="button" onClick={addWcaRow} className="bh-btn bh-btn-outline text-sm">
                                            <Plus className="w-4 h-4" /> 新增項目
                                        </button>
                                    )}
                                    <button type="button" data-testid="wca-save-results" disabled={savingResults} onClick={handleSaveResults} className="bh-btn bh-btn-blue text-sm disabled:opacity-50">
                                        <Save className="w-4 h-4" /> {savingResults ? '儲存中…' : '儲存成績'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default WcaManager;
