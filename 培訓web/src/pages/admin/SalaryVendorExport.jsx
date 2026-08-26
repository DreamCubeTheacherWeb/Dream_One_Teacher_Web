import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    AlertTriangle,
    ArrowLeft,
    Check,
    Download,
    FileSpreadsheet,
    RefreshCw,
    Search,
    Users,
} from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import {
    buildVendorCsv,
    createVendorExportFilename,
    filterVendorInstructors,
    getVendorExportMissingFields,
} from '../../lib/vendorCsvExport';

const PAGE_SIZE = 1000;
const INSTRUCTOR_COLUMNS = [
    'id',
    'full_name',
    'instructor_role',
    'id_number',
    'household_address',
    'address',
    'phone_mobile',
    'bank_code',
    'bank_account_number',
    'email_primary',
].join(',');
const SESSION_COLUMNS = 'id,instructor_id,session_date';
const LEVEL_ORDER = ['實習', 'B', 'A', 'A+', 'S'];

const fetchAllRows = async (table, columns) => {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
            .from(table)
            .select(columns)
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        const page = data || [];
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
    }
    return rows;
};

const getTaipeiToday = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
}).format(new Date());

const SalaryVendorExport = () => {
    const [instructors, setInstructors] = useState([]);
    const [sessions, setSessions] = useState([]);
    const [selectedInstructorIds, setSelectedInstructorIds] = useState([]);
    const [teacherSearch, setTeacherSearch] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [instructorLevel, setInstructorLevel] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [downloaded, setDownloaded] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const [nextInstructors, nextSessions] = await Promise.all([
                fetchAllRows('instructors', INSTRUCTOR_COLUMNS),
                fetchAllRows('class_sessions', SESSION_COLUMNS),
            ]);
            setInstructors(nextInstructors);
            setSessions(nextSessions);
            setSelectedInstructorIds((current) => current.filter((id) => (
                nextInstructors.some((instructor) => instructor.id === id)
            )));
        } catch (loadError) {
            console.error('讀取供應商匯出資料失敗：', loadError);
            setError(`資料讀取失敗：${loadError.message || '請稍後再試'}`);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(load, 0);
        return () => window.clearTimeout(timer);
    }, [load]);

    const levelOptions = useMemo(() => {
        const availableLevels = [...new Set(instructors
            .map((instructor) => instructor.instructor_role)
            .filter(Boolean))];
        return availableLevels.sort((a, b) => {
            const aIndex = LEVEL_ORDER.indexOf(a);
            const bIndex = LEVEL_ORDER.indexOf(b);
            if (aIndex === -1 && bIndex === -1) return a.localeCompare(b, 'zh-Hant');
            if (aIndex === -1) return 1;
            if (bIndex === -1) return -1;
            return aIndex - bIndex;
        });
    }, [instructors]);

    const visibleTeacherOptions = useMemo(() => {
        const keyword = teacherSearch.trim().toLowerCase();
        return instructors
            .filter((instructor) => !keyword || [
                instructor.full_name,
                instructor.email_primary,
                instructor.instructor_role,
            ].filter(Boolean).join(' ').toLowerCase().includes(keyword))
            .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '', 'zh-Hant'));
    }, [instructors, teacherSearch]);

    const dateRangeInvalid = Boolean(startDate && endDate && startDate > endDate);
    const exportInstructors = useMemo(() => {
        if (dateRangeInvalid) return [];
        return filterVendorInstructors({
            instructors,
            sessions,
            selectedInstructorIds,
            startDate,
            endDate,
            instructorLevel,
        });
    }, [dateRangeInvalid, endDate, instructorLevel, instructors, selectedInstructorIds, sessions, startDate]);

    const incompleteRows = useMemo(() => exportInstructors
        .map((instructor) => ({
            instructor,
            missingFields: getVendorExportMissingFields(instructor),
        }))
        .filter((item) => item.missingFields.length > 0), [exportInstructors]);

    const toggleInstructor = (instructorId) => {
        setDownloaded(false);
        setSelectedInstructorIds((current) => current.includes(instructorId)
            ? current.filter((id) => id !== instructorId)
            : [...current, instructorId]);
    };

    const selectVisibleTeachers = () => {
        setDownloaded(false);
        setSelectedInstructorIds((current) => [
            ...new Set([...current, ...visibleTeacherOptions.map((instructor) => instructor.id)]),
        ]);
    };

    const clearTeacherSelection = () => {
        setDownloaded(false);
        setSelectedInstructorIds([]);
    };

    const downloadCsv = () => {
        if (dateRangeInvalid || exportInstructors.length === 0) return;
        const csv = buildVendorCsv(exportInstructors);
        const filename = createVendorExportFilename({ startDate, endDate, today: getTaipeiToday() });
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setDownloaded(true);
    };

    return (
        <main className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5 mb-8">
                <div className="max-w-3xl">
                    <Link to="/admin" className="inline-flex items-center gap-1 min-h-[44px] text-sm font-black text-bauhaus-black/60 hover:text-bauhaus-blue mb-2">
                        <ArrowLeft className="w-4 h-4" /> 回後台管理
                    </Link>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">報酬供應商 CSV 匯出</h1>
                    <p className="mt-2 text-sm sm:text-base font-medium text-bauhaus-black/65 leading-relaxed">
                        依老師、課程日期區間或目前等級挑選對象，每位老師輸出一列，欄位順序與財務部供應商格式一致。
                    </p>
                </div>
                <button type="button" onClick={load} disabled={loading} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px] shrink-0 disabled:opacity-50">
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    {loading ? '讀取中' : '重新整理'}
                </button>
            </div>

            <div className="mb-6 bg-bauhaus-yellow border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 sm:p-5 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="text-sm font-medium leading-relaxed">
                    <p className="font-black">檔案含身分證字號、地址與銀行帳號，只能提供財務作業使用。</p>
                    <p className="mt-1">目前系統沒有「夥伴號碼」欄位，CSV 會保留該欄但留白，不會自行編號。</p>
                </div>
            </div>

            {error && (
                <div role="alert" className="mb-6 bg-bauhaus-red text-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 font-bold">
                    {error}
                </div>
            )}

            <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard overflow-hidden mb-6" aria-labelledby="export-filters-heading">
                <div className="bg-bauhaus-black text-white px-4 sm:px-6 py-4">
                    <h2 id="export-filters-heading" className="text-lg sm:text-xl font-black">設定匯出條件</h2>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 sm:p-6 border-b-2 border-bauhaus-black/20">
                    <label className="block">
                        <span className="bh-label block mb-1.5">課程日期起</span>
                        <input type="date" value={startDate} onChange={(event) => { setStartDate(event.target.value); setDownloaded(false); }} className="bh-input min-h-[44px]" />
                    </label>
                    <label className="block">
                        <span className="bh-label block mb-1.5">課程日期迄</span>
                        <input type="date" value={endDate} onChange={(event) => { setEndDate(event.target.value); setDownloaded(false); }} className="bh-input min-h-[44px]" />
                    </label>
                    <label className="block">
                        <span className="bh-label block mb-1.5">目前講師等級</span>
                        <select value={instructorLevel} onChange={(event) => { setInstructorLevel(event.target.value); setDownloaded(false); }} className="bh-input min-h-[44px]">
                            <option value="">全部等級</option>
                            {levelOptions.map((level) => <option key={level} value={level}>{level}</option>)}
                        </select>
                    </label>
                    <div className="md:col-span-3 text-xs font-bold text-bauhaus-black/55">
                        日期留白時不限制報酬紀錄，可匯出全部講師主檔；填入任一日期後，只保留該區間內有課程報酬紀錄的老師。
                    </div>
                    {dateRangeInvalid && (
                        <div role="alert" className="md:col-span-3 text-sm font-black text-bauhaus-red">
                            結束日期不能早於開始日期，請調整日期區間。
                        </div>
                    )}
                </div>

                <div className="p-4 sm:p-6">
                    <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-3">
                        <div>
                            <h3 className="font-black text-bauhaus-black">選擇老師</h3>
                            <p className="text-xs font-bold text-bauhaus-black/50 mt-1">
                                未勾選代表全部老師；已勾選 {selectedInstructorIds.length} 位。
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={selectVisibleTeachers} disabled={visibleTeacherOptions.length === 0} className="bh-btn bh-btn-outline px-3 py-2 text-xs min-h-[44px] disabled:opacity-40">
                                選取搜尋結果
                            </button>
                            <button type="button" onClick={clearTeacherSelection} disabled={selectedInstructorIds.length === 0} className="bh-btn bh-btn-ghost px-3 py-2 text-xs min-h-[44px] disabled:opacity-40">
                                清除選取
                            </button>
                        </div>
                    </div>

                    <div className="relative mb-3">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-bauhaus-black/40" aria-hidden="true" />
                        <input
                            type="search"
                            value={teacherSearch}
                            onChange={(event) => setTeacherSearch(event.target.value)}
                            placeholder="搜尋老師姓名、Email 或等級"
                            aria-label="搜尋老師"
                            className="bh-input pl-11 min-h-[44px]"
                        />
                    </div>

                    <div className="max-h-64 overflow-y-auto border-2 border-bauhaus-black rounded-xl divide-y-2 divide-bauhaus-black/15" aria-label="老師選擇清單">
                        {loading ? (
                            <div className="p-8 text-center font-bold text-bauhaus-black/50">正在讀取講師資料…</div>
                        ) : visibleTeacherOptions.length === 0 ? (
                            <div className="p-8 text-center font-bold text-bauhaus-black/50">找不到符合的老師</div>
                        ) : visibleTeacherOptions.map((instructor) => {
                            const selected = selectedInstructorIds.includes(instructor.id);
                            return (
                                <label key={instructor.id} className={`flex items-center gap-3 px-4 py-3 min-h-[52px] cursor-pointer ${selected ? 'bg-bauhaus-yellow/30' : 'bg-white hover:bg-bauhaus-cream'}`}>
                                    <input
                                        type="checkbox"
                                        checked={selected}
                                        onChange={() => toggleInstructor(instructor.id)}
                                        className="w-5 h-5 accent-bauhaus-blue shrink-0"
                                    />
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-black text-bauhaus-black truncate">{instructor.full_name || '(未填姓名)'}</span>
                                        <span className="block text-xs font-bold text-bauhaus-black/50 truncate">{instructor.email_primary || '未填 Email'}</span>
                                    </span>
                                    <span className="bh-chip bg-bauhaus-muted text-bauhaus-black shrink-0">{instructor.instructor_role || '未定級'}</span>
                                </label>
                            );
                        })}
                    </div>
                </div>
            </section>

            <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard overflow-hidden" aria-labelledby="export-preview-heading">
                <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 p-4 sm:p-6 border-b-2 border-bauhaus-black">
                    <div>
                        <h2 id="export-preview-heading" className="text-lg sm:text-xl font-black text-bauhaus-black">匯出預覽</h2>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm font-bold text-bauhaus-black/60">
                            <span className="inline-flex items-center gap-1.5"><Users className="w-4 h-4" /> {exportInstructors.length} 位老師</span>
                            <span className="text-bauhaus-blue">{exportInstructors.length - incompleteRows.length} 位資料完整</span>
                            <span className={incompleteRows.length > 0 ? 'text-bauhaus-red' : 'text-bauhaus-blue'}>{incompleteRows.length} 位待補資料</span>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={downloadCsv}
                        disabled={loading || dateRangeInvalid || exportInstructors.length === 0}
                        className="bh-btn bh-btn-blue px-5 py-3 min-h-[44px] disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {downloaded ? <Check className="w-5 h-5" /> : <Download className="w-5 h-5" />}
                        {downloaded ? '已匯出 CSV' : `匯出 ${exportInstructors.length} 位老師`}
                    </button>
                </div>

                {loading ? (
                    <div className="p-12 text-center font-bold text-bauhaus-black/50">正在建立預覽…</div>
                ) : exportInstructors.length === 0 ? (
                    <div className="p-10 sm:p-14 text-center">
                        <FileSpreadsheet className="w-12 h-12 mx-auto text-bauhaus-black/30" aria-hidden="true" />
                        <h3 className="mt-3 text-lg font-black text-bauhaus-black">目前條件沒有可匯出的老師</h3>
                        <p className="mt-1 text-sm font-medium text-bauhaus-black/55">請清除老師選取、放寬日期區間或改選其他等級。</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[760px] text-sm">
                            <thead className="bg-bauhaus-black text-white text-xs uppercase tracking-wider">
                                <tr>
                                    <th className="px-4 py-3 text-left">老師</th>
                                    <th className="px-4 py-3 text-left">等級</th>
                                    <th className="px-4 py-3 text-left">銀行代號</th>
                                    <th className="px-4 py-3 text-left">銀行帳號</th>
                                    <th className="px-4 py-3 text-left">資料狀態</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y-2 divide-bauhaus-black/15">
                                {exportInstructors.slice(0, 12).map((instructor) => {
                                    const missingFields = getVendorExportMissingFields(instructor);
                                    return (
                                        <tr key={instructor.id} className="hover:bg-bauhaus-cream">
                                            <td className="px-4 py-3 font-black text-bauhaus-black">{instructor.full_name || '(未填姓名)'}</td>
                                            <td className="px-4 py-3 text-bauhaus-black/70">{instructor.instructor_role || '未定級'}</td>
                                            <td className="px-4 py-3 font-mono text-bauhaus-black/70">{instructor.bank_code || '—'}</td>
                                            <td className="px-4 py-3 font-mono text-bauhaus-black/70">{instructor.bank_account_number ? '••••' + instructor.bank_account_number.slice(-4) : '—'}</td>
                                            <td className="px-4 py-3">
                                                {missingFields.length === 0 ? (
                                                    <span className="bh-chip bg-bauhaus-blue text-white"><Check className="w-3 h-3" /> 完整</span>
                                                ) : (
                                                    <span className="text-xs font-black text-bauhaus-red">缺：{missingFields.join('、')}</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {exportInstructors.length > 12 && (
                            <div className="px-4 py-3 text-center text-xs font-bold text-bauhaus-black/50 bg-bauhaus-cream border-t-2 border-bauhaus-black">
                                預覽前 12 位；CSV 會完整輸出全部 {exportInstructors.length} 位老師。
                            </div>
                        )}
                    </div>
                )}
            </section>
        </main>
    );
};

export default SalaryVendorExport;
