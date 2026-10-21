import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BadgeCheck, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { money, taipeiToday } from '../../lib/salary';
import { SALARY_STATS_CHUNK_SIZE, fetchRows } from '../../lib/salaryRegisterQuery';
import { markPaidPeriodChoices, monthNameOf, payoutScheduleFromResponse, shortDateOf } from '../../lib/salaryPayday';

const MIGRATION_FILE = '20261021233000_mark_salary_period_paid.sql';
const rangeOf = (period) => `${shortDateOf(period.periodStart)}～${shortDateOf(period.periodEnd)}`;

// 與資料庫函式 mark_salary_period_paid 相同的條件：session_date 在區間內（含頭尾）、已核准
const approvedInPeriod = (period) => supabase
    .from('class_sessions')
    .select('id, total_salary', { count: 'exact' })
    .eq('status', 'approved')
    .not('pricing_status', 'in', '(needs_review,rejected)')
    .gte('session_date', period.periodStart)
    .lte('session_date', period.periodEnd)
    .order('id');

const loadPeriodSummary = async (period) => {
    const [approved, pending] = await Promise.all([
        fetchRows(() => approvedInPeriod(period), { chunkSize: SALARY_STATS_CHUNK_SIZE }),
        // 待核准（含待定價）；退回的也是 pending，但不算待核准
        supabase.from('class_sessions').select('id', { count: 'exact', head: true })
            .eq('status', 'pending')
            .neq('pricing_status', 'rejected')
            .gte('session_date', period.periodStart)
            .lte('session_date', period.periodEnd),
    ]);
    if (pending.error) throw pending.error;
    return {
        count: approved.rows.length,
        amount: approved.rows.reduce((sum, row) => sum + Number(row.total_salary || 0), 0),
        pendingCount: pending.count ?? 0,
    };
};

const markErrorText = (error) => {
    if (error?.code === '42501') return '只有管理員可以標記匯款完成。';
    if (error?.code === '22023') return error.message;
    if (error?.code === 'PGRST202' || /could not find the function/i.test(error?.message || '')) {
        return `需先套用資料庫更新（${MIGRATION_FILE}）才能使用。`;
    }
    return `標記失敗：${error?.message || '請稍後再試'}`;
};

// 後台報酬登記中心（admin）：一期匯完，一鍵把該期已核准的紀錄標成已付款
const SalaryPeriodPaidAction = ({ onMarked }) => {
    const [status, setStatus] = useState('loading'); // loading | ready
    const [scheduleFailed, setScheduleFailed] = useState(false);
    const [choices, setChoices] = useState([]);
    const [selectedMonth, setSelectedMonth] = useState('');
    // 都帶 periodMonth：換期別時舊期別的數字不會配上新期別的日期顯示
    const [summary, setSummary] = useState(null);     // { periodMonth, count, amount, pendingCount }
    const [summaryError, setSummaryError] = useState(null); // { periodMonth, text }
    const [confirming, setConfirming] = useState(null); // 按下後重新數過的 { count, amount }
    const [checking, setChecking] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState(null);
    const busy = useRef(false);       // 送出中：連點第二下直接忽略（state 還沒更新前也擋得住）
    const summaryRequest = useRef(0);
    const today = taipeiToday();

    const period = useMemo(() => choices.find(choice => choice.periodMonth === selectedMonth) || null, [choices, selectedMonth]);

    useEffect(() => {
        let active = true;
        (async () => {
            const response = await supabase.from('salary_payout_schedule').select('next_payday, regular_day').maybeSingle();
            if (!active) return;
            const schedule = payoutScheduleFromResponse(response);
            const result = markPaidPeriodChoices(schedule, taipeiToday());
            setScheduleFailed(schedule.failed);
            setChoices(result.choices);
            setSelectedMonth(result.defaultMonth);
            setStatus('ready');
        })();
        return () => { active = false; };
    }, []);

    const loadSummary = useCallback(async (target) => {
        const requestId = ++summaryRequest.current;
        setSummary(null);
        setSummaryError(null);
        try {
            const result = await loadPeriodSummary(target);
            if (requestId !== summaryRequest.current) return null;
            setSummary({ ...result, periodMonth: target.periodMonth });
            return result;
        } catch (error) {
            if (requestId !== summaryRequest.current) return null;
            setSummaryError({ periodMonth: target.periodMonth, text: `這一期的筆數讀不到：${error?.message || '請稍後再試'}` });
            return null;
        }
    }, []);

    useEffect(() => {
        if (!period) return undefined;
        const timer = window.setTimeout(() => loadSummary(period), 0);
        return () => window.clearTimeout(timer);
    }, [period, loadSummary]);

    const changePeriod = (value) => {
        setSelectedMonth(value);
        setConfirming(null);
        setMessage(null);
    };

    // 第一步：重新數一次（避免畫面上的數字已經過時），再顯示確認
    const startConfirm = async () => {
        if (!period?.ended || busy.current || checking) return;
        setMessage(null);
        setChecking(true);
        const fresh = await loadSummary(period);
        setChecking(false);
        if (!fresh) return;
        if (fresh.count === 0) {
            setMessage({ tone: 'error', text: '這一期已經沒有要標記的紀錄。' });
            return;
        }
        setConfirming({ count: fresh.count, amount: fresh.amount });
    };

    const submit = async () => {
        if (!period || !confirming || busy.current) return;
        busy.current = true;
        setSubmitting(true);
        setMessage(null);
        const target = period;
        const expected = confirming;
        const { data, error } = await supabase.rpc('mark_salary_period_paid', {
            p_period_start: target.periodStart,
            p_period_end: target.periodEnd,
        });
        busy.current = false;
        setSubmitting(false);
        setConfirming(null);
        if (error) {
            setMessage({ tone: 'error', text: markErrorText(error) });
            return;
        }
        const count = Number(data?.marked_count ?? 0);
        const amount = Number(data?.marked_amount ?? 0);
        const drift = count !== expected.count || Math.round(amount * 100) !== Math.round(expected.amount * 100)
            ? `（確認後到送出前資料有異動，原本是 ${expected.count} 筆、${money(expected.amount)}，以這次實際標記的為準）`
            : '';
        setMessage({
            tone: 'ok',
            text: `已把 ${count} 筆、共 ${money(amount)} 標記為已付款（${monthNameOf(target.periodMonth)}，${rangeOf(target)}）。${drift}`,
        });
        loadSummary(target);
        onMarked?.();
    };

    const shown = summary && summary.periodMonth === period?.periodMonth ? summary : null;
    const shownError = summaryError && summaryError.periodMonth === period?.periodMonth ? summaryError.text : '';
    const beforePayday = period?.payday && today < period.payday;
    const canStart = Boolean(period?.ended) && Boolean(shown) && shown.count > 0 && !checking && !submitting && !confirming;

    return (
        <section aria-labelledby="salary-period-paid-title" className="bh-card p-4 sm:p-5 mb-6">
            <h2 id="salary-period-paid-title" className="font-black text-bauhaus-black flex items-center gap-2">
                <BadgeCheck className="w-5 h-5" aria-hidden="true" /> 本期匯款完成
            </h2>
            <p className="text-xs text-bauhaus-black/60 font-medium mt-1">
                每期匯完款按一次：這一期（上月 26 日～本月 25 日）「已核准」的紀錄會一起改成「已付款」，講師「我的報酬」的「已匯款」跟著更新。
                待核准的不會標記，之後核准了再按一次就好；已付款的不會重複計算。
            </p>

            {status === 'loading' && <p className="text-sm text-bauhaus-black/50 font-bold mt-4">載入中…</p>}

            {status === 'ready' && (
                <div className="mt-4 flex items-end gap-3 flex-wrap">
                    <label className="flex flex-col gap-1 text-xs font-bold text-bauhaus-black/70 min-w-0">
                        期別
                        <select
                            value={selectedMonth}
                            onChange={e => changePeriod(e.target.value)}
                            disabled={submitting}
                            className="min-h-[44px] max-w-full px-3 border-2 border-bauhaus-black rounded-xl bg-white text-sm font-bold text-bauhaus-black outline-none focus:ring-2 focus:ring-bauhaus-blue"
                        >
                            {choices.map(choice => (
                                <option key={choice.periodMonth} value={choice.periodMonth} disabled={!choice.ended}>
                                    {monthNameOf(choice.periodMonth)}（{rangeOf(choice)}）{choice.ended ? '' : `・${shortDateOf(choice.periodEnd)} 結束後才能標`}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button type="button" onClick={startConfirm} disabled={!canStart} className="bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px]">
                        <BadgeCheck className="w-4 h-4" aria-hidden="true" /> {checking ? '確認筆數中…' : '本期匯款完成'}
                    </button>

                    <div className="w-full text-sm font-bold text-bauhaus-black" data-testid="period-paid-preview" aria-live="polite">
                        {shownError ? (
                            <span className="flex items-center gap-3 flex-wrap text-bauhaus-red">
                                {shownError}
                                <button type="button" onClick={() => loadSummary(period)} className="bh-btn bh-btn-outline px-3 py-2 min-h-[44px]">
                                    <RefreshCw className="w-4 h-4" aria-hidden="true" /> 重新計算筆數
                                </button>
                            </span>
                        ) : !shown ? (
                            <span className="text-bauhaus-black/50">計算這一期的筆數…</span>
                        ) : shown.count > 0 ? (
                            <>將標記 {shown.count} 筆、共 {money(shown.amount)}（期間 {rangeOf(period)}）</>
                        ) : (
                            <>這一期沒有要標記的紀錄（期間 {rangeOf(period)} 已核准、還沒標已付款的 0 筆）</>
                        )}
                    </div>
                    {shown?.pendingCount > 0 && (
                        <p className="w-full text-xs font-bold text-bauhaus-black/70">
                            另有 {shown.pendingCount} 筆待核准，這次不會標記；核准後可再按一次。
                        </p>
                    )}
                    {beforePayday && shown?.count > 0 && (
                        <p className="w-full text-xs font-bold text-bauhaus-black/70">
                            這一期的匯款日是 {shortDateOf(period.payday)}，請確認已實際匯款再標記。
                        </p>
                    )}
                    {scheduleFailed && (
                        <p className="w-full text-xs font-bold text-bauhaus-black/60">（匯款日設定暫時讀不到，期別先以每月 10 號推算。）</p>
                    )}

                    {confirming && (
                        <div role="group" aria-labelledby="period-paid-confirm-text"
                            className="w-full border-2 border-bauhaus-black rounded-xl bg-bauhaus-yellow/30 p-3 flex flex-col gap-3">
                            <p id="period-paid-confirm-text" className="text-sm font-bold text-bauhaus-black">
                                確定要把 {monthNameOf(period.periodMonth)}這 {confirming.count} 筆、共 {money(confirming.amount)}（期間 {rangeOf(period)}）標記為已付款嗎？
                                標記後講師會看到「已付款」；要改回只能到下方紀錄逐筆修改。
                            </p>
                            <div className="flex gap-2 flex-wrap">
                                <button type="button" onClick={submit} disabled={submitting} className="bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px]">
                                    {submitting ? '標記中…' : `確認標記 ${confirming.count} 筆`}
                                </button>
                                <button type="button" onClick={() => setConfirming(null)} disabled={submitting} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px]">
                                    取消
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {message && (
                <p role={message.tone === 'error' ? 'alert' : 'status'}
                    className={`mt-3 text-sm font-bold ${message.tone === 'error' ? 'text-bauhaus-red' : 'text-bauhaus-blue'}`}>
                    {message.text}
                </p>
            )}
        </section>
    );
};

export default SalaryPeriodPaidAction;
