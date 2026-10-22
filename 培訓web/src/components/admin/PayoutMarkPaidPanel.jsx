// 月結匯款頁「匯款完成，標記為已付款」＋這一期的標記批次與「還原這一批」（2026-10-22，admin 限定）。
// 只標「下載的那份轉帳檔」實際納入的課：下載時頁面存下清單（snapshot），按標記時清單必須和畫面現況完全相同（指紋一致），
// 資料庫函式 mark_salary_sessions_paid 再逐筆核對（狀態、期別、講師、金額），任一不符整批不改。
// 計算在 src/lib/payoutMarkPaid.js（有單元測試）；這裡只負責顯示、確認與呼叫。
import { useCallback, useEffect, useRef, useState } from 'react';
import { BadgeCheck, RefreshCw, Undo2 } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { formatMoney } from '../../lib/payoutBankExport';
import {
    MIGRATION_NEEDED_TEXT,
    amountToCents,
    batchStatusText,
    exclusionLines,
    isMissingTableError,
    markPaidErrorText,
    mismatchLines,
} from '../../lib/payoutMarkPaid';

const BATCH_COLUMNS = 'id,period_start,period_end,item_count,total_amount,transfer_total,pay_date,marked_at,marked_by_name,reverted_count,reverted_amount,reverted_at';
const shortDate = (iso) => `${Number(String(iso).slice(5, 7))}/${Number(String(iso).slice(8, 10))}`;
const timeText = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};
const dbMoney = (value) => formatMoney(amountToCents(value));

const PayoutMarkPaidPanel = ({ periodMonth, range, today, plan, snapshot, blockReason, onMarked, onReverted }) => {
    const [batches, setBatches] = useState({ status: 'loading', rows: [], error: '' }); // loading | ready | missing | error
    const [confirming, setConfirming] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState(null);       // { tone: 'ok'|'error', text, lines?, batchId? }
    const [revertTarget, setRevertTarget] = useState(null); // 要還原的批次（顯示確認）
    const [reverting, setReverting] = useState(false);
    const busy = useRef(false);
    const batchRequest = useRef(0);
    const periodStart = range?.periodStart || '';
    const periodEnd = range?.periodEnd || '';

    const loadBatches = useCallback(async () => {
        if (!periodStart || !periodEnd) return;
        const requestId = ++batchRequest.current;
        setBatches((current) => ({ ...current, status: current.status === 'missing' ? 'missing' : 'loading' }));
        const { data, error } = await supabase
            .from('salary_payout_batches')
            .select(BATCH_COLUMNS)
            .eq('period_start', periodStart)
            .eq('period_end', periodEnd)
            .order('id', { ascending: false })
            .limit(20);
        if (requestId !== batchRequest.current) return;
        if (error) {
            setBatches({ status: isMissingTableError(error) ? 'missing' : 'error', rows: [], error: error.message || '' });
            return;
        }
        setBatches({ status: 'ready', rows: data || [], error: '' });
    }, [periodStart, periodEnd]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setConfirming(false);
            setRevertTarget(null);
            setMessage(null);
            loadBatches();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [loadBatches]);

    const ended = Boolean(periodEnd) && periodEnd < today;
    const snapshotMatches = Boolean(snapshot) && snapshot.periodMonth === periodMonth && snapshot.fingerprint === plan.fingerprint;
    let disabledReason = '';
    if (batches.status === 'missing') disabledReason = MIGRATION_NEEDED_TEXT;
    else if (batches.status === 'loading') disabledReason = '讀取這一期的標記紀錄中…';
    else if (blockReason) disabledReason = blockReason;
    else if (!ended) disabledReason = `這一期到 ${shortDate(periodEnd)} 才結束，結束後才能標記已付款。`;
    else if (!snapshot || snapshot.periodMonth !== periodMonth) disabledReason = '請先下載這一期的轉帳檔（CSV 或 Excel）。銀行匯款完成後再回來按，標記的就是你下載的那一份。';
    else if (!snapshotMatches) disabledReason = '下載後名單或金額有變動（調整、排除、重新整理或講師資料），請重新下載轉帳檔，確認交給銀行的是同一份再標記。';
    else if (plan.itemCount === 0) disabledReason = '這份轉帳檔沒有可標記的課。';
    const canStart = !disabledReason && !submitting && !confirming;
    const target = snapshotMatches ? snapshot.plan : plan;
    const exclusions = exclusionLines(target);

    const startConfirm = () => {
        if (!canStart) return;
        setMessage(null);
        setRevertTarget(null);
        setConfirming(true);
    };

    const submit = async () => {
        if (busy.current || !snapshotMatches || disabledReason) return;
        busy.current = true;
        setSubmitting(true);
        setMessage(null);
        const sent = snapshot.plan;
        const { data, error } = await supabase.rpc('mark_salary_sessions_paid', {
            p_period_start: periodStart,
            p_period_end: periodEnd,
            p_items: sent.items,
            p_expected_total: sent.sessionCents / 100,
            p_pay_date: snapshot.payDate || null,
            p_transfer_total: sent.transferCents / 100,
            p_adjustments: sent.adjustments,
        });
        busy.current = false;
        setSubmitting(false);
        setConfirming(false);
        if (error) {
            const text = markPaidErrorText(error);
            if (text === MIGRATION_NEEDED_TEXT) setBatches({ status: 'missing', rows: [], error: '' });
            setMessage({ tone: 'error', text });
            return;
        }
        if (!data?.ok) {
            setMessage({
                tone: 'error',
                text: `這份清單有 ${Number(data?.mismatch_count || 0)} 筆和資料庫目前不符，這次沒有標記任何紀錄。請按上方「重新整理」，確認後重新下載轉帳檔再標記：`,
                lines: mismatchLines(data?.mismatches),
            });
            return;
        }
        setMessage({
            tone: 'ok',
            text: `已標記為已付款：批次 #${data.batch_id}，${Number(data.marked_count)} 筆、課程應付 ${dbMoney(data.marked_amount)}（期間 ${shortDate(periodStart)}～${shortDate(periodEnd)}）。標錯了可以按「還原這一批」。`,
            batchId: data.batch_id,
        });
        await loadBatches();
        onMarked?.();
    };

    const askRevert = (batch) => {
        setConfirming(false);
        setMessage((current) => (current?.tone === 'ok' ? current : null));
        setRevertTarget(batch);
    };
    const askRevertById = (batchId) => {
        const batch = batches.rows.find((row) => Number(row.id) === Number(batchId));
        if (batch) askRevert(batch);
    };

    const revert = async () => {
        if (busy.current || !revertTarget) return;
        busy.current = true;
        setReverting(true);
        const batchId = revertTarget.id;
        const { data, error } = await supabase.rpc('revert_salary_payout_batch', { p_batch_id: batchId });
        busy.current = false;
        setReverting(false);
        setRevertTarget(null);
        if (error) {
            setMessage({ tone: 'error', text: markPaidErrorText(error) });
            return;
        }
        const skipped = Number(data?.skipped_count || 0);
        setMessage({
            tone: skipped > 0 ? 'error' : 'ok',
            text: `批次 #${batchId} 已還原 ${Number(data?.reverted_count || 0)} 筆、${dbMoney(data?.reverted_amount || 0)}，這些紀錄回到標記前的狀態，下次匯款會再出現。`
                + (skipped > 0 ? `另有 ${skipped} 筆沒有還原：` : ''),
            lines: skipped > 0 ? mismatchLines(data?.skipped) : undefined,
        });
        await loadBatches();
        onReverted?.();
    };

    const openBatches = batches.rows.filter((row) => Number(row.reverted_count || 0) < Number(row.item_count || 0));

    return (
        <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 sm:p-6 mb-6" aria-labelledby="payout-mark-paid-heading" data-testid="payout-mark-paid">
            <h2 id="payout-mark-paid-heading" className="text-lg sm:text-xl font-black text-bauhaus-black mb-1 flex items-center gap-2">
                <BadgeCheck className="w-5 h-5" aria-hidden="true" /> 匯款完成，標記為已付款
            </h2>
            <p className="text-sm font-medium text-bauhaus-black/70 mb-4 leading-relaxed">
                銀行實際匯款完成後再按。只會標記<span className="font-black text-bauhaus-black">你下載的那份轉帳檔</span>裡的課；
                被排除、被擋下、對不到講師的紀錄維持「已核准」，下次匯款會再出現。講師的「我的報酬」會跟著顯示已付款。
            </p>

            {disabledReason ? (
                <p data-testid="payout-mark-paid-reason" className={`text-sm font-black mb-3 ${batches.status === 'missing' ? 'text-bauhaus-red' : 'text-bauhaus-black/70'}`}>{disabledReason}</p>
            ) : (
                <p data-testid="payout-mark-paid-summary" className="text-sm font-bold text-bauhaus-black mb-3">
                    這份轉帳檔（{snapshot.kind}，{timeText(snapshot.at)} 下載）：{target.peopleCount} 位講師、{target.itemCount} 筆課，課程應付 {formatMoney(target.sessionCents)}。
                </p>
            )}

            <button type="button" onClick={startConfirm} disabled={!canStart} className="bh-btn bh-btn-blue px-5 py-3 min-h-[44px] disabled:opacity-50">
                <BadgeCheck className="w-5 h-5" aria-hidden="true" /> 匯款完成，標記為已付款
            </button>

            {confirming && snapshotMatches && (
                <div role="group" aria-labelledby="payout-mark-paid-confirm-text" data-testid="payout-mark-paid-confirm"
                    className="mt-4 border-2 border-bauhaus-black rounded-xl bg-bauhaus-yellow/30 p-4 flex flex-col gap-3">
                    <div id="payout-mark-paid-confirm-text" className="text-sm font-bold text-bauhaus-black space-y-2">
                        <p data-testid="payout-mark-paid-confirm-main">
                            確定把這份轉帳檔納入的 {target.peopleCount} 位講師、{target.itemCount} 筆課標記為已付款嗎？課程應付合計 {formatMoney(target.sessionCents)}。
                        </p>
                        <p data-testid="payout-mark-paid-confirm-transfer">
                            轉帳檔總額 {formatMoney(target.transferCents)}
                            {target.adjustmentCents !== 0 && `（含人工調整 ${formatMoney(target.adjustmentCents)}；人工調整不會寫進任何一堂課的已領金額，只記在這一批的紀錄裡）`}。
                        </p>
                        {(target.zeroCount > 0 || target.overpaidCount > 0) && (
                            <p data-testid="payout-mark-paid-confirm-zero">
                                其中 {target.zeroCount} 筆本次應付 $0（之前已記錄付清{target.overpaidCount > 0 ? `，${target.overpaidCount} 筆已領超過總額` : ''}），標記後已領金額不會改小。
                            </p>
                        )}
                        <div data-testid="payout-mark-paid-confirm-excluded">
                            {exclusions.length > 0 ? (
                                <>
                                    <p>這次不會標記（維持已核准，下次匯款會再出現），共 {target.excludedCount} 筆：</p>
                                    <ul className="list-disc pl-5 font-medium">
                                        {exclusions.map((line) => <li key={line}>{line}</li>)}
                                    </ul>
                                </>
                            ) : (
                                <p>這一期已核准的課都在這份轉帳檔裡，沒有被排除的紀錄。</p>
                            )}
                        </div>
                        <p className="text-xs text-bauhaus-black/70">匯出之後才核准的紀錄不在這份檔案裡，也不會被標記。標錯了可以用下方「還原這一批」改回來。</p>
                    </div>
                    <div className="flex gap-2 flex-wrap">
                        <button type="button" onClick={submit} disabled={submitting} className="bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px]">
                            {submitting ? '標記中…' : `確認標記 ${target.itemCount} 筆`}
                        </button>
                        <button type="button" onClick={() => setConfirming(false)} disabled={submitting} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px]">
                            取消
                        </button>
                    </div>
                </div>
            )}

            {message && (
                <div role={message.tone === 'error' ? 'alert' : 'status'} data-testid="payout-mark-paid-message"
                    className={`mt-4 text-sm font-black ${message.tone === 'error' ? 'text-bauhaus-red' : 'text-bauhaus-blue'}`}>
                    <p>{message.text}</p>
                    {message.lines?.length > 0 && (
                        <ul className="mt-1 list-disc pl-5 font-bold text-bauhaus-black/80">
                            {message.lines.map((line) => <li key={line}>{line}</li>)}
                        </ul>
                    )}
                    {message.batchId && openBatches.some((row) => Number(row.id) === Number(message.batchId)) && !revertTarget && (
                        <button type="button" onClick={() => askRevertById(message.batchId)} className="mt-2 bh-btn bh-btn-outline px-3 py-2 min-h-[44px]">
                            <Undo2 className="w-4 h-4" aria-hidden="true" /> 還原這一批（#{message.batchId}）
                        </button>
                    )}
                </div>
            )}

            {revertTarget && (
                <div role="group" aria-labelledby="payout-revert-confirm-text" data-testid="payout-revert-confirm"
                    className="mt-4 border-2 border-bauhaus-black rounded-xl bg-bauhaus-red/10 p-4 flex flex-col gap-3">
                    <p id="payout-revert-confirm-text" className="text-sm font-bold text-bauhaus-black">
                        確定還原批次 #{revertTarget.id} 嗎？這批還沒還原的 {Number(revertTarget.item_count) - Number(revertTarget.reverted_count || 0)} 筆會改回標記前的狀態（多半是「已核准」），下次匯款會再出現。
                        標記之後被改過的紀錄不會還原，會另外列出來。
                    </p>
                    <div className="flex gap-2 flex-wrap">
                        <button type="button" onClick={revert} disabled={reverting} className="bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px]">
                            {reverting ? '還原中…' : `確認還原批次 #${revertTarget.id}`}
                        </button>
                        <button type="button" onClick={() => setRevertTarget(null)} disabled={reverting} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px]">
                            取消
                        </button>
                    </div>
                </div>
            )}

            <div className="mt-6">
                <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                    <h3 className="text-sm font-black text-bauhaus-black">這一期的標記紀錄</h3>
                    {batches.status !== 'missing' && (
                        <button type="button" onClick={loadBatches} className="bh-btn bh-btn-outline px-3 py-1.5 text-xs min-h-[40px]">
                            <RefreshCw className="w-4 h-4" aria-hidden="true" /> 重新讀取
                        </button>
                    )}
                </div>
                {batches.status === 'missing' ? (
                    <p data-testid="payout-batches-missing" className="text-xs font-bold text-bauhaus-red">{MIGRATION_NEEDED_TEXT}</p>
                ) : batches.status === 'error' ? (
                    <p role="alert" className="text-xs font-bold text-bauhaus-red">標記紀錄讀取失敗：{batches.error || '請稍後再試'}</p>
                ) : batches.status === 'loading' && batches.rows.length === 0 ? (
                    <p className="text-xs font-bold text-bauhaus-black/50">讀取中…</p>
                ) : batches.rows.length === 0 ? (
                    <p data-testid="payout-batches-empty" className="text-xs font-bold text-bauhaus-black/60">這一期還沒有標記過。</p>
                ) : (
                    <div className="overflow-x-auto">
                        <table data-testid="payout-batches" className="w-full min-w-[640px] text-xs border-2 border-bauhaus-black">
                            <thead className="bg-bauhaus-muted">
                                <tr>
                                    <th className="px-2 py-2 text-left">批次</th>
                                    <th className="px-2 py-2 text-left">標記時間</th>
                                    <th className="px-2 py-2 text-left">標記人</th>
                                    <th className="px-2 py-2 text-right">筆數</th>
                                    <th className="px-2 py-2 text-right">課程應付</th>
                                    <th className="px-2 py-2 text-left">狀態</th>
                                    <th className="px-2 py-2 text-left">操作</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-bauhaus-black/15">
                                {batches.rows.map((row) => (
                                    <tr key={row.id} data-testid={`payout-batch-${row.id}`}>
                                        <td className="px-2 py-1.5 font-mono font-black">#{row.id}</td>
                                        <td className="px-2 py-1.5 font-mono">{timeText(row.marked_at)}</td>
                                        <td className="px-2 py-1.5">{row.marked_by_name || '—'}</td>
                                        <td className="px-2 py-1.5 text-right font-mono">{row.item_count}</td>
                                        <td className="px-2 py-1.5 text-right font-mono">{dbMoney(row.total_amount)}</td>
                                        <td className="px-2 py-1.5">{batchStatusText(row)}</td>
                                        <td className="px-2 py-1.5">
                                            {Number(row.reverted_count || 0) < Number(row.item_count || 0) && (
                                                <button type="button" onClick={() => askRevert(row)} disabled={reverting || submitting}
                                                    aria-label={`還原批次 #${row.id}`} className="bh-btn bh-btn-outline px-3 py-1.5 text-xs min-h-[40px]">
                                                    <Undo2 className="w-4 h-4" aria-hidden="true" /> 還原這一批
                                                </button>
                                            )}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </section>
    );
};

export default PayoutMarkPaidPanel;
