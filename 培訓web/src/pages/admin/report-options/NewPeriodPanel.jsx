import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { OPTION_LABEL_MAX, periodCounts } from '../../../lib/salaryReportOptions';

const NONE = '';

// 新增期間面板：名稱＋「複製哪一期的清單」。
const NewPeriodPanel = ({ periods, options, defaultSourceId, busy, onCreate, onCancel }) => {
    const [name, setName] = useState('');
    const [source, setSource] = useState(defaultSourceId || NONE);

    const submit = async (event) => {
        event.preventDefault();
        await onCreate({ name, copyFromId: source || null });
    };

    return (
        <form onSubmit={submit} data-new-period-panel className="mt-3 bh-card p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <h3 className="text-base sm:text-lg font-black">新增期間</h3>
                <button type="button" onClick={onCancel} aria-label="關閉新增期間" className="bh-btn-ghost min-h-[44px] min-w-[44px]">
                    <X className="w-5 h-5" aria-hidden="true" />
                </button>
            </div>
            <label className="block">
                <span className="bh-label block mb-1.5">期間名稱</span>
                <input
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={OPTION_LABEL_MAX + 50}
                    placeholder="例如：2026年暑假、115學年度下學期"
                    autoFocus
                    className="bh-input min-h-[44px]"
                />
            </label>
            <label className="block">
                <span className="bh-label block mb-1.5">複製哪一期的清單</span>
                <select value={source} onChange={(event) => setSource(event.target.value)} className="bh-input min-h-[44px]">
                    {periods.map((period) => {
                        const counts = periodCounts(options, period.id);
                        return (
                            <option key={period.id} value={period.id}>
                                {period.label}（單位 {counts.partner_unit.total}・梯次 {counts.camp_batch.total}）
                            </option>
                        );
                    })}
                    <option value={NONE}>不複製，從空白開始</option>
                </select>
            </label>
            <p className="text-xs font-medium leading-relaxed text-bauhaus-black/60">
                複製會把那一期的上課單位與營隊梯次（含啟用狀態與順序）原樣帶到新期間，之後各改各的，互不影響。
            </p>
            <div className="flex flex-wrap gap-2">
                <button type="submit" disabled={busy} className="bh-btn bh-btn-blue px-5 min-h-[44px]">
                    <Plus className="w-4 h-4" aria-hidden="true" /> 建立期間
                </button>
                <button type="button" onClick={onCancel} className="bh-btn bh-btn-outline px-5 min-h-[44px]">取消</button>
            </div>
        </form>
    );
};

export default NewPeriodPanel;
