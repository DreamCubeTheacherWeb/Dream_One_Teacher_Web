import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Save, RefreshCw } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { taipeiToday } from '../../lib/salary';
import {
    DEFAULT_PAYDAY_DAY,
    MISSING_TABLE_CODES,
    PAYDAY_DAY_MAX,
    PAYDAY_DAY_MIN,
    monthNameOf,
    normalizePaydayDay,
    parseIsoDate,
    resolvePayout,
    shortDateOf,
} from '../../lib/salaryPayday';
const DAY_OPTIONS = Array.from({ length: PAYDAY_DAY_MAX - PAYDAY_DAY_MIN + 1 }, (_, i) => PAYDAY_DAY_MIN + i);

const teacherSees = (schedule, today) => {
    const { payday, periodMonth, periodStart, periodEnd } = resolvePayout(schedule, today);
    return `${monthNameOf(periodMonth)}累計報酬（${shortDateOf(periodStart)}～${shortDateOf(periodEnd)}）・${shortDateOf(payday)} 匯款`;
};
const effectivePayday = (schedule, today) => resolvePayout(schedule, today).payday;

// 後台報酬登記中心（admin）：講師「我的報酬」黃卡顯示的下次匯款日
const SalaryPaydaySetting = () => {
    const [status, setStatus] = useState('loading'); // loading | ready | missing | error
    const [saved, setSaved] = useState(null);
    const [form, setForm] = useState({ nextPayday: '', regularDay: DEFAULT_PAYDAY_DAY });
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);
    const today = taipeiToday();

    const load = useCallback(async () => {
        setStatus('loading');
        setMessage(null);
        const { data, error } = await supabase
            .from('salary_payout_schedule')
            .select('next_payday, regular_day')
            .maybeSingle();
        if (error) {
            setStatus(MISSING_TABLE_CODES.has(error.code) ? 'missing' : 'error');
            return;
        }
        if (!data) {
            setStatus('missing');
            return;
        }
        const schedule = { nextPayday: data.next_payday, regularDay: normalizePaydayDay(data.regular_day) };
        setSaved(schedule);
        // 已經過了的日期不放進輸入框（min 是今天），改放講師端實際看到的那一天
        setForm({ nextPayday: effectivePayday(schedule, taipeiToday()), regularDay: schedule.regularDay });
        setStatus('ready');
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(load, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    const formValid = Boolean(parseIsoDate(form.nextPayday)) && form.nextPayday >= today;
    const changed = Boolean(saved) && (
        form.nextPayday !== effectivePayday(saved, today) || Number(form.regularDay) !== saved.regularDay
    );

    const save = async (event) => {
        event.preventDefault();
        if (saving) return;
        if (!formValid) {
            setMessage({ tone: 'error', text: '請選今天或之後的日期。' });
            return;
        }
        setSaving(true);
        setMessage(null);
        const regularDay = normalizePaydayDay(form.regularDay);
        const { data, error } = await supabase
            .from('salary_payout_schedule')
            .update({ next_payday: form.nextPayday, regular_day: regularDay })
            .eq('id', true)
            .select('next_payday, regular_day')
            .maybeSingle();
        setSaving(false);
        if (error || !data) {
            setMessage({ tone: 'error', text: `儲存失敗：${error?.message || '沒有修改權限或設定不存在'}` });
            return;
        }
        const schedule = { nextPayday: data.next_payday, regularDay: normalizePaydayDay(data.regular_day) };
        setSaved(schedule);
        setForm({ nextPayday: effectivePayday(schedule, today), regularDay: schedule.regularDay });
        setMessage({ tone: 'ok', text: `已儲存。講師現在看到「${teacherSees(schedule, today)}」。` });
    };

    return (
        <section aria-labelledby="salary-payday-title" className="bh-card p-4 sm:p-5 mb-6">
            <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                    <h2 id="salary-payday-title" className="font-black text-bauhaus-black flex items-center gap-2">
                        <CalendarClock className="w-5 h-5" aria-hidden="true" /> 講師端匯款日
                    </h2>
                    <p className="text-xs text-bauhaus-black/60 font-medium mt-1">
                        講師「我的報酬」黃卡顯示上一期（上月 26 日～本月 25 日）的累計報酬與這個日期。日期過了會自動跳到下個月的固定日；遇到假日要提前或延後，改「下次匯款日」就好。
                    </p>
                </div>
                {status === 'ready' && saved && (
                    <div className="text-sm font-bold text-bauhaus-black bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl px-3 py-1.5" data-testid="payday-current">
                        講師目前看到：{teacherSees(saved, today)}
                    </div>
                )}
            </div>

            {status === 'loading' && <p className="text-sm text-bauhaus-black/50 font-bold mt-4">載入中…</p>}

            {status === 'missing' && (
                <p role="status" className="text-sm font-bold text-bauhaus-black mt-4 bg-bauhaus-yellow/30 border-2 border-bauhaus-black rounded-xl p-3">
                    需先套用資料庫更新（20261020160000_salary_payout_schedule.sql）才能修改；目前講師端以每月 {DEFAULT_PAYDAY_DAY} 號計算。
                </p>
            )}

            {status === 'error' && (
                <div role="alert" className="mt-4 flex items-center gap-3 flex-wrap">
                    <span className="text-sm font-bold text-bauhaus-red">匯款日設定暫時讀不到。</span>
                    <button type="button" onClick={load} className="bh-btn bh-btn-outline px-3 py-2 min-h-[44px]">
                        <RefreshCw className="w-4 h-4" aria-hidden="true" /> 重新載入
                    </button>
                </div>
            )}

            {status === 'ready' && (
                <form onSubmit={save} className="mt-4 flex items-end gap-3 flex-wrap">
                    <label className="flex flex-col gap-1 text-xs font-bold text-bauhaus-black/70">
                        下次匯款日
                        <input
                            type="date"
                            required
                            min={today}
                            value={form.nextPayday}
                            onChange={e => { setForm({ ...form, nextPayday: e.target.value }); setMessage(null); }}
                            className="min-h-[44px] px-3 border-2 border-bauhaus-black rounded-xl bg-white text-sm font-bold text-bauhaus-black outline-none focus:ring-2 focus:ring-bauhaus-blue"
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-bold text-bauhaus-black/70">
                        之後每月固定
                        <span className="flex items-center gap-2">
                            <select
                                value={form.regularDay}
                                onChange={e => { setForm({ ...form, regularDay: Number(e.target.value) }); setMessage(null); }}
                                className="min-h-[44px] px-3 border-2 border-bauhaus-black rounded-xl bg-white text-sm font-bold text-bauhaus-black outline-none focus:ring-2 focus:ring-bauhaus-blue"
                            >
                                {DAY_OPTIONS.map(day => <option key={day} value={day}>{day}</option>)}
                            </select>
                            <span className="text-sm text-bauhaus-black">號</span>
                        </span>
                    </label>
                    <button type="submit" disabled={saving || !changed} className="bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px]">
                        <Save className="w-4 h-4" aria-hidden="true" /> {saving ? '儲存中…' : '儲存'}
                    </button>
                    {changed && formValid && (
                        <p className="w-full text-xs font-bold text-bauhaus-black/70">
                            儲存後講師會看到「{teacherSees({ nextPayday: form.nextPayday, regularDay: form.regularDay }, today)}」。
                        </p>
                    )}
                </form>
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

export default SalaryPaydaySetting;
