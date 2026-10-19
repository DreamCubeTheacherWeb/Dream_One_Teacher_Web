import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import PeriodOptionsPanel from './report-options/PeriodOptionsPanel';
import ReportFieldsPanel from './report-options/ReportFieldsPanel';

// 後台「回報選項管理」：講師登記課程回報時，下拉選單有哪些選項、表單有哪些欄位。
// 兩個分頁各自讀寫資料；切走再切回來不會丟掉選中的期間或版面（分頁只是藏起來）。
const MAIN_TABS = [
    { key: 'options', label: '下拉選單內容' },
    { key: 'fields', label: '回報表單欄位' },
];

const SalaryReportOptionsManager = () => {
    const [activeTab, setActiveTab] = useState('options');
    const [visited, setVisited] = useState({ options: true, fields: false });
    const [refreshKey, setRefreshKey] = useState(0);

    const openTab = (key) => {
        setActiveTab(key);
        setVisited((current) => (current[key] ? current : { ...current, [key]: true }));
    };

    return (
        <main className="p-4 sm:p-8 max-w-4xl mx-auto">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-5">
                <div className="min-w-0">
                    <Link to="/admin/salary" className="inline-flex items-center gap-1 min-h-[44px] text-sm font-black text-bauhaus-black/60 hover:text-bauhaus-blue mb-1">
                        <ArrowLeft className="w-4 h-4" /> 回報酬登記中心
                    </Link>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">回報選項管理</h1>
                    <p className="mt-2 text-sm sm:text-base font-medium text-bauhaus-black/65 leading-relaxed">
                        設定講師「登記課程回報」時，每個教學期間有哪些上課單位與營隊梯次可選，以及表單上有哪些欄位。
                    </p>
                </div>
                <button type="button" onClick={() => setRefreshKey((key) => key + 1)} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px] shrink-0">
                    <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    重新整理
                </button>
            </div>

            <div role="tablist" aria-label="設定項目" className="grid grid-cols-2 mb-5 overflow-hidden rounded-xl border-2 border-bauhaus-black divide-x-2 divide-bauhaus-black">
                {MAIN_TABS.map((tab) => {
                    const selected = tab.key === activeTab;
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            role="tab"
                            id={`report-options-tab-${tab.key}`}
                            aria-selected={selected}
                            aria-controls={`report-options-panel-${tab.key}`}
                            onClick={() => openTab(tab.key)}
                            className={`min-h-[48px] px-3 text-sm sm:text-base font-black transition-colors duration-200 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-bauhaus-blue ${selected ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-cream'}`}
                        >
                            {tab.label}
                        </button>
                    );
                })}
            </div>

            <div role="tabpanel" id="report-options-panel-options" aria-labelledby="report-options-tab-options" hidden={activeTab !== 'options'}>
                {visited.options && <PeriodOptionsPanel refreshKey={refreshKey} />}
            </div>
            <div role="tabpanel" id="report-options-panel-fields" aria-labelledby="report-options-tab-fields" hidden={activeTab !== 'fields'}>
                {visited.fields && <ReportFieldsPanel refreshKey={refreshKey} />}
            </div>
        </main>
    );
};

export default SalaryReportOptionsManager;
