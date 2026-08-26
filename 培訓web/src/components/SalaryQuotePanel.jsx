import { AlertTriangle, Calculator, CheckCircle2, Loader2 } from 'lucide-react';
import { money, pricingModeLabel } from '../lib/salary';

const SalaryQuotePanel = ({ quote, loading = false, error = '' }) => {
    if (loading) {
        return (
            <div className="sm:col-span-2 rounded-xl border-2 border-bauhaus-black/20 bg-bauhaus-muted p-4 flex items-center gap-2 text-sm font-bold text-bauhaus-black/60">
                <Loader2 className="w-4 h-4 animate-spin" /> 正在依報酬表試算…
            </div>
        );
    }

    if (error) {
        return (
            <div className="sm:col-span-2 rounded-xl border-2 border-bauhaus-red bg-bauhaus-red/10 p-4 flex items-start gap-2 text-sm text-bauhaus-red">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div><div className="font-black">暫時無法試算</div><div className="text-xs mt-1">{error}</div></div>
            </div>
        );
    }

    if (!quote) return null;

    const needsReview = quote.needs_review || !quote.matched;
    const Icon = needsReview ? AlertTriangle : CheckCircle2;

    return (
        <div className={`sm:col-span-2 rounded-xl border-2 p-4 ${needsReview ? 'border-bauhaus-yellow bg-bauhaus-yellow/20' : 'border-bauhaus-blue bg-bauhaus-blue/10'}`}>
            <div className="flex items-start gap-3">
                <Icon className={`w-5 h-5 shrink-0 mt-0.5 ${needsReview ? 'text-bauhaus-black' : 'text-bauhaus-blue'}`} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-black text-bauhaus-black">
                            {needsReview ? '待管理員核薪' : '報酬表試算完成'}
                        </div>
                        <div className={`text-xl font-black ${needsReview ? 'text-bauhaus-black' : 'text-bauhaus-blue'}`}>
                            {money(quote.base_salary)}
                        </div>
                    </div>
                    <div className="text-xs text-bauhaus-black/70 mt-1">{quote.message}</div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs text-bauhaus-black/60">
                        <span className="inline-flex items-center gap-1"><Calculator className="w-3.5 h-3.5" />依據：{quote.pricing_label || '尚未符合資格／規則'}</span>
                        {quote.pricing_mode && <span>方式：{pricingModeLabel(quote.pricing_mode)}</span>}
                        {quote.applied_rate !== null && quote.applied_rate !== undefined && <span>單價：{money(quote.applied_rate)}</span>}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SalaryQuotePanel;
