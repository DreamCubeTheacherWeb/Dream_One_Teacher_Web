// 月結匯款頁「匯款完成，標記為已付款」（2026-10-22，admin 限定）：列出這一期每一次下載存下的匯出紀錄，
// 對某一份「標記這份已付款」或「還原」。清單在下載當下就存進資料庫（record_salary_payout_export），
// 標記只送匯出編號＋確認的筆數／金額（mark_salary_payout_export_paid），資料庫逐筆核對（狀態、期別、講師、金額），任一不符整份不改。
// 重新整理、隔天回來都還在，可以直接標；同一期可以有多份匯出（補匯），重疊的課會因為已經付款而整份被擋。
import { useCallback, useEffect, useRef, useState } from 'react';
import { BadgeCheck, RefreshCw, Undo2 } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/payoutBankExport';
import {
    MIGRATION_NEEDED_TEXT,
    amountToCents,
    canRevertExport,
    classifyRpcFailure,
    exportStatusText,
    isMissingTableError,
    mismatchLines,
    negativeAdjustments,
} from '../../lib/payoutMarkPaid';

const EXPORT_COLUMNS = 'id,period_start,period_end,item_count,people_count,total_amount,transfer_total,people,exclusions,pay_date,file_kind,'
    + 'exported_at,exported_by_name,marked_at,marked_by_name,marked_count,marked_amount,reverted_count,reverted_amount,reverted_at';
const PAGE_SIZE = 1000;
const KIND_LABELS = { csv: 'CSV', xlsx: 'Excel' };
const shortDate = (iso) => `${Number(String(iso).slice(5, 7))}/${Number(String(iso).slice(8, 10))}`;
const timeText = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const dbMoney = (value) => formatMoney(amountToCents(value));
const fetchAllRows = async (build) => {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if ((data || []).length < PAGE_SIZE) break;
    }
    return rows;
};

// 確認框要的資料：這份的每一堂（判斷應付 $0 幾筆）、這一期目前已核准但不在這份裡的（其中多少是匯出之後才新增或變動）
const loadDetails = async (row) => {
    const [items, approved] = await Promise.all([
        fetchAllRows(() => supabase.from('salary_payout_export_items').select('session_id,amount').eq('export_id', row.id).order('session_id')),
        fetchAllRows(() => supabase.from('class_sessions').select('id,updated_at').eq('status', 'approved')
            .gte('session_date', row.period_start).lte('session_date', row.period_end).order('id')),
    ]);
    const inExport = new Set(items.map((item) => item.session_id));
    const outside = approved.filter((session) => !inExport.has(session.id));
    const exportedAt = new Date(row.exported_at).getTime();
    return {
        zeroCount: items.filter((item) => amountToCents(item.amount) === 0).length,
        outsideCount: outside.length,
        laterCount: outside.filter((session) => new Date(session.updated_at).getTime() > exportedAt).length,
    };
};

const PayoutMarkPaidPanel = ({ range, today, refreshKey, onChanged }) => {
    const [exportsState, setExportsState] = useState({ status: 'loading', rows: [], error: '' }); // loading | ready | missing | error
    const [target, setTarget] = useState(null);         // 要標記的那份（確認框）
    const [details, setDetails] = useState(null);       // { status: loading|ready|error, …loadDetails }
    const [ackNegative, setAckNegative] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState(null);       // { tone: 'ok'|'error'|'warn', text, lines? }
    const [revertTarget, setRevertTarget] = useState(null);
    const [reverting, setReverting] = useState(false);
    const busy = useRef(false);
    const loadRequest = useRef(0);
    const periodStart = range?.periodStart || '';
    const periodEnd = range?.periodEnd || '';

    const loadExports = useCallback(async () => {
        if (!periodStart || !periodEnd) return null;
        const requestId = ++loadRequest.current;
        setExportsState((current) => ({ ...current, status: current.status === 'missing' ? 'missing' : 'loading' }));
        const { data, error } = await supabase
            .from('salary_payout_exports')
            .select(EXPORT_COLUMNS)
            .eq('period_start', periodStart)
            .eq('period_end', periodEnd)
            .order('id', { ascending: false })
            .limit(30);
        if (requestId !== loadRequest.current) return null;
        if (error) {
            setExportsState({ status: isMissingTableError(error) ? 'missing' : 'error', rows: [], error: error.message || '' });
            return null;
        }
        setExportsState({ status: 'ready', rows: data || [], error: '' });
        return data || [];
    }, [periodStart, periodEnd]);

    // 換期別：清掉確認框與訊息、重讀；下載新的一份（refreshKey 變）：只重讀
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setTarget(null);
            setRevertTarget(null);
            setMessage(null);
            loadExports();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [loadExports]);
    useEffect(() => {
        if (!refreshKey) return undefined;
        const timer = window.setTimeout(() => loadExports(), 0);
        return () => window.clearTimeout(timer);
    }, [refreshKey, loadExports]);

    const ended = Boolean(periodEnd) && periodEnd < today;
    const negatives = target ? negativeAdjustments(target.people) : [];

    const openMark = async (row) => {
        if (busy.current) return;
        setMessage(null);
        setRevertTarget(null);
        setAckNegative(false);
        setTarget(row);
        setDetails({ status: 'loading' });
        try {
            const result = await loadDetails(row);
            setDetails({ status: 'ready', ...result });
        } catch (error) {
            setDetails({ status: 'error', error: error?.message || '請稍後再試' });
        }
    };

    // 不確定有沒有寫進去：自動重讀這一期的匯出紀錄與報酬，讓畫面顯示資料庫的真實狀態
    const refreshAfterUncertain = async () => {
        await loadExports();
        onChanged?.();
    };

    const submitMark = async () => {
        if (busy.current || !target || !ended || details?.status !== 'ready' || (negatives.length > 0 && !ackNegative)) return;
        busy.current = true;
        setSubmitting(true);
        setMessage(null);
        const row = target;
        const { data, error, status } = await supabase.rpc('mark_salary_payout_export_paid', {
            p_export_id: row.id,
            p_expected_count: row.item_count,
            p_expected_amount: Number(row.total_amount),
        });
        busy.current = false;
        setSubmitting(false);
        setTarget(null);
        if (!error && data?.ok === true) {
            setMessage({ tone: 'ok', text: `已把匯出 #${row.id} 標記為已付款：${Number(data.marked_count)} 筆、課程應付 ${dbMoney(data.marked_amount)}（期間 ${shortDate(periodStart)}～${shortDate(periodEnd)}）。標錯了可以按這一份的「還原」。` });
            await loadExports();
            onChanged?.();
            return;
        }
        if (!error && data?.ok === false) {
            setMessage({
                tone: 'error',
                text: `匯出 #${row.id} 有 ${Number(data.mismatch_count || 0)} 筆和資料庫目前不符，這次沒有標記任何紀錄（資料庫已確認沒有改）。請重新整理、重新下載一份轉帳檔確認後再處理：`,
                lines: mismatchLines(data.mismatches),
            });
            return;
        }
        const failure = classifyRpcFailure({ error, status });
        if (failure.kind === 'missing') setExportsState({ status: 'missing', rows: [], error: '' });
        setMessage({ tone: failure.kind === 'uncertain' ? 'warn' : 'error', text: failure.text });
        if (failure.kind === 'uncertain') await refreshAfterUncertain();
    };

    const askRevert = (row) => {
        setTarget(null);
        setMessage(null);
        setRevertTarget(row);
    };

    const submitRevert = async () => {
        if (busy.current || !revertTarget) return;
        busy.current = true;
        setReverting(true);
        const row = revertTarget;
        const { data, error, status } = await supabase.rpc('revert_salary_payout_export', { p_export_id: row.id });
        busy.current = false;
        setReverting(false);
        setRevertTarget(null);
        if (!error && data && Number.isInteger(data.reverted_count)) {
            const skipped = Number(data.skipped_count || 0);
            setMessage({
                tone: skipped > 0 ? 'error' : 'ok',
                text: `匯出 #${row.id} 已還原 ${data.reverted_count} 筆、${dbMoney(data.reverted_amount || 0)}，這些紀錄回到標記前的狀態，下次匯款會再出現。`
                    + (skipped > 0 ? `另有 ${skipped} 筆沒有還原：` : ''),
                lines: skipped > 0 ? mismatchLines(data.skipped) : undefined,
            });
            await loadExports();
            onChanged?.();
            return;
        }
        const failure = classifyRpcFailure({ error, status });
        if (failure.kind === 'missing') setExportsState({ status: 'missing', rows: [], error: '' });
        setMessage({ tone: failure.kind === 'uncertain' ? 'warn' : 'error', text: failure.text });
        if (failure.kind === 'uncertain') await refreshAfterUncertain();
    };

    const canSubmit = Boolean(target) && ended && details?.status === 'ready' && (negatives.length === 0 || ackNegative) && !submitting;
    const messageTone = { ok: 'text-bauhaus-blue', error: 'text-bauhaus-red', warn: 'text-bauhaus-black bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl p-3' };

    return (
        <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 sm:p-6 mb-6" aria-labelledby="payout-mark-paid-heading" data-testid="payout-mark-paid">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
                <h2 id="payout-mark-paid-heading" className="text-lg sm:text-xl font-black text-bauhaus-black flex items-center gap-2">
                    <BadgeCheck className="w-5 h-5" aria-hidden="true" /> 匯款完成，標記為已付款
                </h2>
                {exportsState.status !== 'missing' && (
                    <button type="button" onClick={loadExports} className="bh-btn bh-btn-outline px-3 py-1.5 text-xs min-h-[40px]">
                        <RefreshCw className="w-4 h-4" aria-hidden="true" /> 重新讀取
                    </button>
                )}
            </div>
            <p className="text-sm font-medium text-bauhaus-black/70 mb-4 leading-relaxed">
                每次下載轉帳檔，系統都會存一份「匯出紀錄」（檔名後面的「匯出N」就是編號）。銀行實際匯款完成後，對<span className="font-black text-bauhaus-black">交給銀行的那一份</span>按「標記這份已付款」：
                只會標記那份檔案裡的課；被排除、被擋下、之後才新增或變動的紀錄維持「已核准」，下次匯款會再出現。重新整理、隔天回來都可以直接標。
            </p>

            {exportsState.status === 'missing' ? (
                <p data-testid="payout-exports-missing" className="text-sm font-black text-bauhaus-red">{MIGRATION_NEEDED_TEXT}</p>
            ) : exportsState.status === 'error' ? (
                <p role="alert" className="text-sm font-bold text-bauhaus-red">匯出紀錄讀取失敗：{exportsState.error || '請稍後再試'}</p>
            ) : exportsState.status === 'loading' && exportsState.rows.length === 0 ? (
                <p className="text-sm font-bold text-bauhaus-black/50">讀取這一期的匯出紀錄中…</p>
            ) : exportsState.rows.length === 0 ? (
                <p data-testid="payout-exports-empty" className="text-sm font-bold text-bauhaus-black/60">這一期還沒有匯出紀錄。按上方「轉帳檔 CSV」或「完整 Excel」下載時會自動建立。</p>
            ) : (
                <div className="overflow-x-auto">
                    <table data-testid="payout-exports" className="w-full min-w-[820px] text-xs border-2 border-bauhaus-black">
                        <thead className="bg-bauhaus-muted">
                            <tr>
                                <th className="px-2 py-2 text-left">匯出</th>
                                <th className="px-2 py-2 text-left">下載時間</th>
                                <th className="px-2 py-2 text-left">下載人</th>
                                <th className="px-2 py-2 text-left">檔案</th>
                                <th className="px-2 py-2 text-right">人數</th>
                                <th className="px-2 py-2 text-right">筆數</th>
                                <th className="px-2 py-2 text-right">轉帳檔總額</th>
                                <th className="px-2 py-2 text-left">狀態</th>
                                <th className="px-2 py-2 text-left">操作</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-bauhaus-black/15">
                            {exportsState.rows.map((row) => (
                                <tr key={row.id} data-testid={`payout-export-${row.id}`}>
                                    <td className="px-2 py-1.5 font-mono font-black">#{row.id}</td>
                                    <td className="px-2 py-1.5 font-mono">{timeText(row.exported_at)}</td>
                                    <td className="px-2 py-1.5">{row.exported_by_name || '—'}</td>
                                    <td className="px-2 py-1.5">{KIND_LABELS[row.file_kind] || '—'}</td>
                                    <td className="px-2 py-1.5 text-right font-mono">{row.people_count}</td>
                                    <td className="px-2 py-1.5 text-right font-mono">{row.item_count}</td>
                                    <td className="px-2 py-1.5 text-right font-mono">{dbMoney(row.transfer_total)}</td>
                                    <td className="px-2 py-1.5">
                                        {exportStatusText(row)}
                                        {row.marked_at && <span className="block text-[11px] text-bauhaus-black/55">{timeText(row.marked_at)} {row.marked_by_name || ''}</span>}
                                    </td>
                                    <td className="px-2 py-1.5">
                                        {!row.marked_at && (
                                            <button type="button" onClick={() => openMark(row)} disabled={submitting || reverting}
                                                aria-label={`標記匯出 #${row.id} 已付款`} className="bh-btn bh-btn-blue px-3 py-1.5 text-xs min-h-[40px]">
                                                <BadgeCheck className="w-4 h-4" aria-hidden="true" /> 標記這份已付款
                                            </button>
                                        )}
                                        {canRevertExport(row) && (
                                            <button type="button" onClick={() => askRevert(row)} disabled={submitting || reverting}
                                                aria-label={`還原匯出 #${row.id}`} className="bh-btn bh-btn-outline px-3 py-1.5 text-xs min-h-[40px]">
                                                <Undo2 className="w-4 h-4" aria-hidden="true" /> 還原
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}

            {target && (
                <div role="group" aria-labelledby="payout-mark-paid-confirm-text" data-testid="payout-mark-paid-confirm"
                    className="mt-4 border-2 border-bauhaus-black rounded-xl bg-bauhaus-yellow/30 p-4 flex flex-col gap-3">
                    <div id="payout-mark-paid-confirm-text" className="text-sm font-bold text-bauhaus-black space-y-2">
                        <p data-testid="payout-mark-paid-confirm-main">
                            確定把匯出 #{target.id}（{timeText(target.exported_at)} {target.exported_by_name || ''} 下載的 {KIND_LABELS[target.file_kind] || '檔案'}）標記為已付款嗎？
                            {target.people_count} 位講師、{target.item_count} 筆課，課程應付 {dbMoney(target.total_amount)}；轉帳檔總額 {dbMoney(target.transfer_total)}。
                        </p>
                        <div className="overflow-x-auto">
                            <table data-testid="payout-mark-paid-people" className="w-full min-w-[320px] text-xs bg-white border-2 border-bauhaus-black">
                                <thead className="bg-bauhaus-muted">
                                    <tr>
                                        <th className="px-2 py-1.5 text-left">講師</th>
                                        <th className="px-2 py-1.5 text-right">實付（對銀行）</th>
                                        <th className="px-2 py-1.5 text-right">其中人工調整</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-bauhaus-black/15">
                                    {(target.people || []).map((person) => (
                                        <tr key={person.instructor_id}>
                                            <td className="px-2 py-1.5">{person.name || '（未填姓名）'}</td>
                                            <td className="px-2 py-1.5 text-right font-mono">{dbMoney(person.amount)}</td>
                                            <td className="px-2 py-1.5 text-right font-mono">{amountToCents(person.adjustment) !== 0 ? dbMoney(person.adjustment) : '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        {details?.status === 'loading' && <p className="text-bauhaus-black/60">計算這一期其他紀錄中…</p>}
                        {details?.status === 'error' && (
                            <p role="alert" className="text-bauhaus-red">讀不到這一期的其他紀錄（{details.error}），請按「重新讀取」後再試。</p>
                        )}
                        {details?.status === 'ready' && (
                            <>
                                {details.zeroCount > 0 && (
                                    <p data-testid="payout-mark-paid-confirm-zero">其中 {details.zeroCount} 筆本次應付 $0（之前已記錄付清或超付），標記後已領金額不會改小。</p>
                                )}
                                <p data-testid="payout-mark-paid-confirm-later">
                                    這份匯出之後才新增或變動的紀錄不會被標記：{details.laterCount} 筆。
                                    （這一期目前共有 {details.outsideCount} 筆已核准不在這份檔案裡，都維持已核准，下次匯款會再出現。）
                                </p>
                            </>
                        )}
                        {Array.isArray(target.exclusions) && target.exclusions.length > 0 && (
                            <div data-testid="payout-mark-paid-confirm-excluded">
                                <p>下載當時沒有納入（不會標記）：</p>
                                <ul className="list-disc pl-5 font-medium">
                                    {target.exclusions.map((line) => <li key={line}>{line}</li>)}
                                </ul>
                            </div>
                        )}
                        {negatives.length > 0 && (
                            <div data-testid="payout-mark-paid-negative" className="border-2 border-bauhaus-red rounded-lg bg-white p-3">
                                <p className="text-bauhaus-red">這份有負數人工調整（扣款）：</p>
                                <ul className="list-disc pl-5 font-medium">
                                    {negatives.map((item) => <li key={`${item.name}-${item.cents}`}>{item.name} {formatMoney(item.cents)}{item.reason ? `（${item.reason}）` : ''}</li>)}
                                </ul>
                                <label className="mt-2 flex items-start gap-2 min-h-[44px] cursor-pointer">
                                    <input type="checkbox" checked={ackNegative} onChange={(event) => setAckNegative(event.target.checked)} className="w-5 h-5 mt-0.5 accent-bauhaus-red shrink-0" />
                                    <span>我確認這些負數是扣款，不需要之後補發</span>
                                </label>
                            </div>
                        )}
                        {!ended && <p data-testid="payout-mark-paid-not-ended" className="text-bauhaus-red">這一期到 {shortDate(periodEnd)} 才結束，結束後才能標記已付款。</p>}
                    </div>
                    <div className="flex gap-2 flex-wrap">
                        <button type="button" onClick={submitMark} disabled={!canSubmit} className="bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px] disabled:opacity-50">
                            {submitting ? '標記中…' : `確認標記匯出 #${target.id}（${target.item_count} 筆）`}
                        </button>
                        <button type="button" onClick={() => setTarget(null)} disabled={submitting} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px]">
                            取消
                        </button>
                    </div>
                </div>
            )}

            {revertTarget && (
                <div role="group" aria-labelledby="payout-revert-confirm-text" data-testid="payout-revert-confirm"
                    className="mt-4 border-2 border-bauhaus-black rounded-xl bg-bauhaus-red/10 p-4 flex flex-col gap-3">
                    <p id="payout-revert-confirm-text" className="text-sm font-bold text-bauhaus-black">
                        確定還原匯出 #{revertTarget.id} 的已付款標記嗎？這份還沒還原的 {Number(revertTarget.marked_count ?? revertTarget.item_count) - Number(revertTarget.reverted_count || 0)} 筆會改回標記前的狀態（多半是「已核准」），下次匯款會再出現。
                        標記之後被改過的紀錄不會還原，會另外列出來。
                    </p>
                    <div className="flex gap-2 flex-wrap">
                        <button type="button" onClick={submitRevert} disabled={reverting} className="bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px]">
                            {reverting ? '還原中…' : `確認還原匯出 #${revertTarget.id}`}
                        </button>
                        <button type="button" onClick={() => setRevertTarget(null)} disabled={reverting} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px]">
                            取消
                        </button>
                    </div>
                </div>
            )}

            {message && (
                <div role={message.tone === 'ok' ? 'status' : 'alert'} data-testid="payout-mark-paid-message"
                    className={`mt-4 text-sm font-black ${messageTone[message.tone]}`}>
                    <p>{message.text}</p>
                    {message.lines?.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 font-bold text-bauhaus-black/80">
                            {message.lines.map((line) => <li key={line}>{line}</li>)}
                        </ul>
                    )}
                </div>
            )}
        </section>
    );
};

export default PayoutMarkPaidPanel;
