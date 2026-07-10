import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../lib/supabaseClient';
import {
    Trophy, Search, ChevronDown, Trash2, Ban, RotateCcw, ShieldAlert, Plus, X, Save,
} from 'lucide-react';
import { WCA_SELF_EVENTS, parseTimeToCs, formatWcaResult } from '../../lib/wca';

const WcaManager = () => {
    const [instructors, setInstructors] = useState([]);
    const [instructorsLoaded, setInstructorsLoaded] = useState(false);
    const [instructorSearch, setInstructorSearch] = useState('');
    const [showDropdown, setShowDropdown] = useState(false);
    const [selectedInstructor, setSelectedInstructor] = useState(null);
    const [resultCount, setResultCount] = useState(0);
    const [detailLoading, setDetailLoading] = useState(false);
    const [acting, setActing] = useState(false);
    const [errMsg, setErrMsg] = useState('');
    // 各項目成績（後台代填）：[{ event_id, single, average }]，single/average 為時間字串
    const [wcaRows, setWcaRows] = useState([]);
    const [savingResults, setSavingResults] = useState(false);

    useEffect(() => {
        (async () => {
            const { data, error } = await supabase
                .from('instructors')
                .select('id, full_name, nickname, wca_id, wca_name, hide_from_leaderboard')
                .order('full_name');
            if (error) console.error('讀取講師清單失敗', error);
            setInstructors(data || []);
            setInstructorsLoaded(true);
        })();
    }, []);

    const filteredInstructors = useMemo(() => {
        const s = instructorSearch.trim().toLowerCase();
        if (!s) return instructors.slice(0, 30);
        return instructors.filter((i) =>
            i.full_name?.toLowerCase().includes(s) || i.nickname?.toLowerCase().includes(s)
        ).slice(0, 30);
    }, [instructors, instructorSearch]);

    const loadDetail = async (inst) => {
        setDetailLoading(true);
        const { count } = await supabase
            .from('wca_results')
            .select('*', { count: 'exact', head: true })
            .eq('instructor_id', inst.id);
        setResultCount(count || 0);
        // 讀出可管理項目的成績，轉回可編輯的時間字串（與 parseTimeToCs 為往返組）。
        // 特殊格式匯入項目（333fm/333mbf）不在白名單、不在此顯示，也不會被覆蓋。
        const allowed = new Set(WCA_SELF_EVENTS.map((e) => e.id));
        const { data: wr } = await supabase
            .from('wca_results')
            .select('event_id, best_single, best_average')
            .eq('instructor_id', inst.id);
        const rows = (wr || [])
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

    const selectInstructor = (inst) => {
        setSelectedInstructor(inst);
        setInstructorSearch(inst.full_name);
        setShowDropdown(false);
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

    const handleClear = async () => {
        if (!selectedInstructor) return;
        if (!window.confirm(`確定要清除「${selectedInstructor.full_name}」的 WCA 資料嗎？\n這會刪除他所有的 WCA 成績紀錄，並清空 WCA 選手編號，無法復原。`)) return;
        setActing(true);
        setErrMsg('');
        const { error } = await supabase.rpc('admin_clear_wca', { p_instructor_id: selectedInstructor.id });
        setActing(false);
        if (error) { setErrMsg('清除失敗：' + error.message); return; }
        await refreshSelected(selectedInstructor.id);
        await loadDetail(selectedInstructor);
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

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight flex items-center gap-2">
                    <Trophy className="w-7 h-7 lg:w-9 lg:h-9" /> WCA 資料管理
                </h1>
                <p className="text-bauhaus-black/60 font-medium mt-1">檢視、清除講師 WCA 資料，或停權亂填者的排名與送出資格</p>
            </div>

            <div className="bh-card p-4 sm:p-6 mb-6 relative">
                <label className="bh-label block mb-1">選擇講師</label>
                <div className="relative">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-bauhaus-black/40" />
                    <input
                        type="text"
                        data-testid="wca-instructor-search"
                        placeholder="輸入姓名或暱稱搜尋⋯⋯"
                        value={instructorSearch}
                        onChange={(e) => { setInstructorSearch(e.target.value); setShowDropdown(true); if (selectedInstructor) setSelectedInstructor(null); }}
                        onFocus={() => setShowDropdown(true)}
                        className="bh-input pl-12 pr-10 py-3"
                    />
                    <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-bauhaus-black/30 pointer-events-none" />
                </div>
                {showDropdown && (
                    <div data-testid="wca-instructor-dropdown" className="absolute z-20 left-0 right-0 mt-1 mx-4 sm:mx-6 bg-white border-2 border-bauhaus-black rounded-2xl shadow-hard max-h-72 overflow-y-auto">
                        {filteredInstructors.length === 0 && (
                            <div className="px-4 py-3 text-sm text-bauhaus-black/40 font-bold">查無符合的講師</div>
                        )}
                        {filteredInstructors.map((inst) => (
                            <button
                                key={inst.id}
                                data-testid={`wca-instructor-option-${inst.id}`}
                                onClick={() => selectInstructor(inst)}
                                className="w-full text-left px-4 py-3 hover:bg-bauhaus-cream transition-colors border-b border-bauhaus-black/10 last:border-b-0"
                            >
                                <span className="font-bold text-bauhaus-black">{inst.full_name}</span>
                                {inst.nickname && <span className="ml-2 text-xs text-bauhaus-black/40">{inst.nickname}</span>}
                                {inst.hide_from_leaderboard && (
                                    <span className="ml-2 bh-chip bg-bauhaus-red text-white">已停權</span>
                                )}
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {!selectedInstructor && (
                <div className="py-16 text-center bg-bauhaus-paper border-2 border-dashed border-bauhaus-black/30 rounded-2xl">
                    <Trophy className="w-10 h-10 text-bauhaus-black/20 mx-auto mb-3" />
                    <p className="text-bauhaus-black/40 font-bold">請先搜尋並選擇一位講師</p>
                </div>
            )}

            {selectedInstructor && (
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
    );
};

export default WcaManager;
