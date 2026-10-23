// 後台「月結匯款」（2026-10-22 第一版，admin 限定）：把某一期已核准、未付款的講師報酬匯出成財務部的銀行批次轉帳檔。
// 計算與檢查全部在 src/lib/payoutBankExport.js（有單元測試）；這頁只負責讀資料、收集調整、顯示與下載。
// 寫入：admin 匯入／修改講師的夥伴號碼；按下載時先存一筆「匯出紀錄」（record_salary_payout_export，存下這份檔案納入的課、
// 講師與金額，拿到編號才產生檔案）；匯款完成後對某一份匯出「標記為已付款」（見 components/admin/PayoutMarkPaidPanel.jsx）。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    AlertTriangle,
    ArrowLeft,
    ChevronDown,
    ChevronRight,
    Download,
    FileSpreadsheet,
    RefreshCw,
    Upload,
} from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { taipeiToday } from '../../lib/salary';
import { payoutScheduleFromResponse, MISSING_TABLE_CODES } from '../../lib/salaryPayday';
import { COURSE_LABELS } from '../../lib/constants';
import { XLSX_MIME } from '../../lib/simpleXlsx';
import {
    COST_CENTERS,
    DEFAULT_FEE_BEARER,
    DEFAULT_MEMO_TEMPLATE,
    DEFAULT_NOTICE_METHOD,
    PARTNER_NO_PATTERN,
    buildPayoutWorkbook,
    buildTransferCsv,
    computePayoutPeople,
    decodeCsvBytes,
    dedupeById,
    defaultPaydayForPeriod,
    defaultPayoutPlan,
    formatMoney,
    isMissingPartnerNoError,
    markUnactivatedInstructors,
    maskAccount,
    maskIdNumber,
    memoLength,
    payoutFilename,
    periodRange,
    planPartnerImport,
    recentPeriods,
    renderMemo,
    sessionPayableCents,
    validatePayoutExport,
} from '../../lib/payoutBankExport';
import { MIGRATION_NEEDED_TEXT, amountToCents, buildExportPayload, classifyRpcFailure, duplicateExportWarning, formatTaipeiTime, mismatchLines } from '../../lib/payoutMarkPaid';
import PayoutMarkPaidPanel from '../../components/admin/PayoutMarkPaidPanel';

const PAGE_SIZE = 1000;
const BASE_INSTRUCTOR_COLUMNS = 'id,user_id,full_name,bank_code,bank_account_number,bank_account_name,id_number,email_primary,household_address,address,phone_mobile';
const SESSION_COLUMNS = 'id,instructor_id,instructor_name,session_date,course_type,course_name,base_salary,bonus,total_salary,paid_amount,status,pricing_status,is_anomaly,anomaly_reasons';
const STORAGE_KEYS = { payerAccount: 'dreamone.payout.payerAccount', payerBranch: 'dreamone.payout.payerBranch' };
const PRICING_LABELS = { needs_review: '待確認報價', rejected: '已退回', manual_override: '手動改價', quoted: '已報價', legacy: '舊資料' };
const IMPORT_STATUS_LABELS = { change: '會變更', same: '不變', unmatched: '對不到', conflict: '衝突', invalid: '格式不符' };
const EMPTY_EDITS = { excludedSessionIds: new Set(), includedAnomalySessionIds: new Set(), excludedInstructorIds: new Set(), adjustments: {}, memoOverrides: {}, costCenters: {} };
// 某一期讀回來的資料；ready=false 代表還在讀（或讀的不是目前選的期別）
const EMPTY_PERIOD = { periodMonth: '', sessions: [], stats: null, approvedCount: null, ready: false };
const DATA_CHANGED_MESSAGE = '讀取期間資料有變動，請重新整理';

const readStored = (key) => {
    try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
};
const writeStored = (key, value) => {
    try { window.localStorage.setItem(key, value); } catch { /* 無痕模式等情況存不了就算了 */ }
};

// 分頁抓滿、依 id 去重（分頁期間有人新增／修改，同一列可能出現在兩頁）；build(query) 加篩選條件
const fetchAll = async (table, columns, build = (q) => q) => {
    const rows = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await build(supabase.from(table).select(columns))
            .order('id', { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if ((data || []).length < PAGE_SIZE) break;
    }
    return dedupeById(rows);
};
const countRows = async (build) => {
    const { count, error } = await build(supabase.from('class_sessions').select('id', { count: 'exact', head: true }));
    if (error) throw error;
    return count ?? 0;
};
// 綁定帳號還沒完成 Email 驗證啟用的講師不能匯款（2026-10-23 第二輪資安審查建議 2）。
// admin 讀得到 users（"Admins can manage profiles"）與 instructor_account_activations（"Own or admin can read activations"）；
// 啟用紀錄表還沒建（電子簽約 migration 未套）時只看角色。任一查詢失敗就整頁讀取失敗（寧可不匯，也不要匯錯人）。
const fetchActivationGate = async () => {
    const pendingUsers = await fetchAll('users', 'id', (q) => q.eq('role', 'pending'));
    let pendingActivations = [];
    try {
        pendingActivations = await fetchAll('instructor_account_activations', 'id,user_id,instructor_id', (q) => q.eq('status', 'pending'));
    } catch (error) {
        if (!MISSING_TABLE_CODES.has(error?.code)) throw error;
    }
    return { pendingRoleUserIds: pendingUsers.map((row) => row.id), pendingActivations };
};
// partner_no 還沒建（migration 未套）時改用不含它的查詢
const fetchInstructors = async () => {
    const gate = await fetchActivationGate();
    try {
        const rows = await fetchAll('instructors', `${BASE_INSTRUCTOR_COLUMNS},partner_no`);
        return { rows: markUnactivatedInstructors(rows, gate), partnerNoMissing: false };
    } catch (error) {
        if (!isMissingPartnerNoError(error)) throw error;
        const rows = await fetchAll('instructors', BASE_INSTRUCTOR_COLUMNS);
        return { rows: markUnactivatedInstructors(rows, gate), partnerNoMissing: true };
    }
};

const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const periodLabel = (periodMonth) => {
    const range = periodRange(periodMonth);
    if (!range) return periodMonth;
    const short = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
    return `${range.year} 年 ${range.month} 月期（${short(range.periodStart)}～${short(range.periodEnd)}）`;
};

const Chip = ({ tone, children }) => {
    const tones = {
        block: 'bg-bauhaus-red text-white',
        warn: 'bg-bauhaus-yellow text-bauhaus-black',
        info: 'bg-bauhaus-muted text-bauhaus-black',
        ok: 'bg-bauhaus-blue text-white',
    };
    return <span className={`inline-block text-[11px] font-black px-2 py-0.5 rounded-full border border-bauhaus-black mr-1 mb-1 ${tones[tone]}`}>{children}</span>;
};

// 匯款通知方式／手續費負擔方式：預設財務範本值，選「其他代碼…」才能輸入；不寫代碼的中文意義（我們不知道）
const CodeSelect = ({ label, templateValue, value, onChange }) => {
    const isOther = value !== templateValue;
    return (
        <div className="block">
            <span className="bh-label block mb-1.5">{label}</span>
            <select aria-label={label} value={isOther ? '__other' : templateValue} onChange={(event) => onChange(event.target.value === '__other' ? '' : templateValue)} className="bh-input min-h-[44px]">
                <option value={templateValue}>{templateValue}（財務範本值）</option>
                <option value="__other">其他代碼…</option>
            </select>
            {isOther && (
                <>
                    <input aria-label={`${label}（其他代碼）`} type="text" inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} placeholder="輸入代碼（數字）" className="bh-input min-h-[44px] font-mono mt-2" />
                    <span role="status" className="block mt-1 text-xs font-black text-bauhaus-black bg-bauhaus-yellow border border-bauhaus-black rounded-lg px-2 py-1">與財務範本不同，請先向財務確認代碼意義</span>
                </>
            )}
        </div>
    );
};

const SalaryPayoutExport = () => {
    const [today] = useState(() => taipeiToday());
    const [loadError, setLoadError] = useState('');
    const [scheduleNote, setScheduleNote] = useState('');
    const [plan, setPlan] = useState(null);
    const [regularDay, setRegularDay] = useState(null);
    const [periodMonth, setPeriodMonth] = useState('');
    const [periodData, setPeriodData] = useState(EMPTY_PERIOD);
    const latestRequest = useRef(0);  // 只採用最後一次期別讀取的回應
    const [instructors, setInstructors] = useState([]);
    const [partnerNoMissing, setPartnerNoMissing] = useState(false);
    const [settings, setSettings] = useState(() => ({
        payDate: '',
        payerAccount: readStored(STORAGE_KEYS.payerAccount),
        payerBranch: readStored(STORAGE_KEYS.payerBranch),
        noticeMethod: DEFAULT_NOTICE_METHOD,
        feeBearer: DEFAULT_FEE_BEARER,
        memoTemplate: DEFAULT_MEMO_TEMPLATE,
    }));
    const [edits, setEdits] = useState(EMPTY_EDITS);
    const [editsVersion, setEditsVersion] = useState(0);
    const [exportedVersion, setExportedVersion] = useState(0);
    const [expanded, setExpanded] = useState(() => new Set());
    const [downloadErrors, setDownloadErrors] = useState({ csv: [], xlsx: [] });
    const [downloadMessage, setDownloadMessage] = useState('');
    const [importState, setImportState] = useState({ fileName: '', plan: null, applying: false, result: null, error: '' });
    const [partnerDrafts, setPartnerDrafts] = useState({});
    const [partnerSaving, setPartnerSaving] = useState({});
    const [partnerMessages, setPartnerMessages] = useState({});
    const [downloading, setDownloading] = useState('');       // '' | 'csv' | 'xlsx'：建立匯出紀錄與產生檔案中
    const downloadBusy = useRef(false);                       // 連點第二下直接忽略（state 還沒更新前也擋得住）
    const [exportNotice, setExportNotice] = useState('');     // 資料庫還沒更新：這次下載沒有建立匯出紀錄
    const [exportsRefresh, setExportsRefresh] = useState(0);  // 匯出紀錄有變動 → 通知下方「匯款完成」區重讀
    const [duplicateConfirm, setDuplicateConfirm] = useState(null);  // { kind, exports }：這一期已有還沒標記的匯出，先確認再下載

    const loadInstructors = useCallback(async () => {
        const result = await fetchInstructors();
        setInstructors(result.rows);
        setPartnerNoMissing(result.partnerNoMissing);
    }, []);

    // 第一次載入：講師主檔 → 匯款日設定 → 預設期別與付款日（期別一設定就會去抓本期報酬）。
    // 講師主檔一定要先到：本期報酬若比主檔早到，所有人會暫時被判成「找不到講師主檔」而不納入。
    useEffect(() => {
        const timer = window.setTimeout(async () => {
            try {
                await loadInstructors();
                const scheduleRes = await supabase.from('salary_payout_schedule').select('next_payday, regular_day').maybeSingle();
                const schedule = payoutScheduleFromResponse(scheduleRes);
                const nextPlan = defaultPayoutPlan(schedule, today);
                if (schedule.failed) setScheduleNote('匯款日設定讀取失敗，期別先以今天所在的期、付款日以每月 10 號預估，請確認。');
                else if (scheduleRes.error && MISSING_TABLE_CODES.has(scheduleRes.error.code)) setScheduleNote('尚未套用匯款日設定，付款日以每月 10 號推算。');
                setPlan(nextPlan);
                setRegularDay(schedule.regularDay);
                setPeriodMonth(nextPlan.periodMonth);
                setSettings((current) => ({ ...current, payDate: nextPlan.payday || '' }));
            } catch (error) {
                console.error('讀取月結匯款資料失敗：', error);
                setLoadError(`資料讀取失敗：${error.message || '請稍後再試'}`);
            }
        }, 0);
        return () => window.clearTimeout(timer);
    }, [loadInstructors, today]);

    // 期別切換很快時，舊期別的回應可能比新的晚到：每次讀取編號，只有最後一次的回應會被採用，其餘直接丟掉。
    // reloadInstructors：「重新整理」時連講師主檔一起重抓（銀行資料改過才看得到）。
    const loadPeriod = useCallback(async (targetPeriod, { reloadInstructors = false } = {}) => {
        const range = periodRange(targetPeriod);
        if (!range) return;
        latestRequest.current += 1;
        const requestId = latestRequest.current;
        const isLatest = () => requestId === latestRequest.current;
        setLoadError('');
        setPeriodData((current) => (current.periodMonth === targetPeriod ? { ...current, ready: false } : { ...EMPTY_PERIOD, periodMonth: targetPeriod }));
        try {
            if (reloadInstructors) {
                const result = await fetchInstructors();
                if (!isLatest()) return;
                setInstructors(result.rows);
                setPartnerNoMissing(result.partnerNoMissing);
            }
            const inPeriod = (q) => q.gte('session_date', range.periodStart).lte('session_date', range.periodEnd);
            const [approved, approvedCount, pendingCount, paidCount, earlier] = await Promise.all([
                fetchAll('class_sessions', SESSION_COLUMNS, (q) => inPeriod(q).eq('status', 'approved')),
                countRows((q) => inPeriod(q).eq('status', 'approved')),
                countRows((q) => inPeriod(q).eq('status', 'pending')),
                countRows((q) => inPeriod(q).eq('status', 'paid')),
                fetchAll('class_sessions', 'id,total_salary,paid_amount', (q) => q.eq('status', 'approved').lt('session_date', range.periodStart)),
            ]);
            if (!isLatest()) return;  // 過期的回應：使用者已經改選別期或按了重新整理
            setPeriodData({
                periodMonth: targetPeriod,
                sessions: approved,
                approvedCount,
                stats: {
                    pendingCount,
                    paidCount,
                    earlierCount: earlier.length,
                    earlierCents: earlier.reduce((sum, row) => sum + sessionPayableCents(row), 0),
                },
                ready: true,
            });
        } catch (error) {
            if (!isLatest()) return;
            console.error('讀取本期報酬失敗：', error);
            setLoadError(`本期報酬讀取失敗：${error.message || '請稍後再試'}`);
            setPeriodData({ ...EMPTY_PERIOD, periodMonth: targetPeriod, ready: true });
        }
    }, []);

    useEffect(() => {
        if (!periodMonth) return undefined;
        const timer = window.setTimeout(() => loadPeriod(periodMonth), 0);
        return () => window.clearTimeout(timer);
    }, [loadPeriod, periodMonth]);

    // 畫面只用「已讀完、且就是目前選的期別」的資料；附言、檔名、課程一律同一期
    const loading = !periodData.ready || periodData.periodMonth !== periodMonth;
    const sessions = loading ? EMPTY_PERIOD.sessions : periodData.sessions;
    const stats = loading ? null : periodData.stats;
    const dataChanged = !loading && !loadError && periodData.approvedCount !== periodData.sessions.length;
    const computed = useMemo(() => computePayoutPeople({
        sessions, instructors, periodMonth, memoTemplate: settings.memoTemplate, edits,
    }), [edits, instructors, periodMonth, sessions, settings.memoTemplate]);
    const exportPayload = useMemo(() => buildExportPayload(computed), [computed]);

    const hasEdits = edits.excludedSessionIds.size > 0
        || edits.includedAnomalySessionIds.size > 0
        || edits.excludedInstructorIds.size > 0
        || Object.values(edits.adjustments).some((a) => String(a?.amount ?? '').trim() || String(a?.reason ?? '').trim() || a?.costCenter)
        || Object.values(edits.memoOverrides).some((m) => String(m ?? '').trim())
        || Object.keys(edits.costCenters).length > 0;
    const dirty = hasEdits && editsVersion !== exportedVersion;

    useEffect(() => {
        if (!dirty) return undefined;
        const onBeforeUnload = (event) => {
            event.preventDefault();
            event.returnValue = '';
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => window.removeEventListener('beforeunload', onBeforeUnload);
    }, [dirty]);

    const updateEdits = (updater) => {
        setEdits((current) => updater(current));
        setEditsVersion((v) => v + 1);
        setDownloadMessage('');
    };
    const updateSetting = (key, value) => {
        setSettings((current) => ({ ...current, [key]: value }));
        if (STORAGE_KEYS[key]) writeStored(STORAGE_KEYS[key], value);
        setDownloadMessage('');
    };
    const toggleSet = (key, id) => updateEdits((current) => {
        const next = new Set(current[key]);
        if (next.has(id)) next.delete(id); else next.add(id);
        return { ...current, [key]: next };
    });
    const setAdjustment = (instructorId, field, value) => updateEdits((current) => ({
        ...current,
        adjustments: { ...current.adjustments, [instructorId]: { ...current.adjustments[instructorId], [field]: value } },
    }));
    const setMemoOverride = (instructorId, value) => updateEdits((current) => ({
        ...current, memoOverrides: { ...current.memoOverrides, [instructorId]: value },
    }));
    const setCostCenter = (sessionId, value) => updateEdits((current) => {
        const costCenters = { ...current.costCenters };
        if (value) costCenters[sessionId] = value; else delete costCenters[sessionId];
        return { ...current, costCenters };
    });
    const setPersonCostCenter = (person, value) => updateEdits((current) => {
        const costCenters = { ...current.costCenters };
        for (const row of person.sessions) {
            if (value) costCenters[row.session.id] = value; else delete costCenters[row.session.id];
        }
        return {
            ...current,
            costCenters,
            adjustments: { ...current.adjustments, [person.instructorId]: { ...current.adjustments[person.instructorId], costCenter: value } },
        };
    });
    const toggleExpanded = (instructorId) => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(instructorId)) next.delete(instructorId); else next.add(instructorId);
        return next;
    });

    const changePeriod = (nextPeriod) => {
        if (nextPeriod === periodMonth) return;
        if (hasEdits && !window.confirm('切換期別會清除目前的調整、排除與成本中心設定，確定要切換嗎？')) return;
        setEdits(EMPTY_EDITS);
        setEditsVersion(0);
        setExportedVersion(0);
        setExpanded(new Set());
        setDownloadErrors({ csv: [], xlsx: [] });
        setDownloadMessage('');
        setPeriodMonth(nextPeriod);
        setSettings((current) => ({ ...current, payDate: defaultPaydayForPeriod(nextPeriod, plan, regularDay) || '' }));
    };

    const exportErrors = () => {
        if (loading) return ['資料還在讀取中，請稍候'];
        if (loadError) return ['資料讀取失敗，請先重新整理'];
        if (dataChanged) return [`${DATA_CHANGED_MESSAGE}後再匯出`];
        return validatePayoutExport({ settings, people: computed.people });
    };
    // 下載前先在資料庫存一筆匯出紀錄（逐筆核對已核准、期別、講師、金額），拿到編號才下載；
    // 資料庫還沒套這次的更新 → 照舊下載（檔名沒有編號），並提示這份無法在系統標記已付款
    const recordExport = async (kind) => {
        const range = periodRange(periodMonth);
        const { data, error, status } = await supabase.rpc('record_salary_payout_export', {
            p_period_start: range.periodStart,
            p_period_end: range.periodEnd,
            p_items: exportPayload.items,
            p_people: exportPayload.people,
            p_expected_total: exportPayload.transferCents / 100,
            p_pay_date: settings.payDate || null,
            p_file_kind: kind,
            p_exclusions: exportPayload.exclusionLines,
        });
        if (!error && data?.ok === true && Number.isInteger(data.export_id)) return { exportId: data.export_id };
        if (!error && data?.ok === false) {
            return {
                errors: [`這份檔案有 ${Number(data.mismatch_count || 0)} 筆和資料庫目前不符，沒有建立匯出紀錄，也沒有下載。請按「重新整理」後再下載：`, ...mismatchLines(data.mismatches)],
            };
        }
        const failure = classifyRpcFailure({ error, status });
        if (failure.kind === 'missing') return { exportId: null, degraded: true };
        if (failure.kind === 'uncertain') {
            return { uncertain: true, errors: ['建立匯出紀錄的結果不確定（網路或伺服器沒有正常回應），這次沒有下載。請看下方「匯款完成」區重新讀取匯出紀錄，確認後再下載一次（多出來、沒標記的匯出紀錄不影響任何報酬資料）。'] };
        }
        return { errors: [`沒有建立匯出紀錄，也沒有下載：${failure.text}`] };
    };
    // 這一期還沒標記的匯出紀錄；讀不到（資料庫還沒更新、網路錯誤）就回空陣列 → 不擋下載，照原本流程（含降級）
    const findUnmarkedExports = async () => {
        const range = periodRange(periodMonth);
        try {
            const { data, error } = await supabase
                .from('salary_payout_exports')
                .select('id,exported_at,exported_by_name,item_count,people_count,transfer_total')
                .eq('period_start', range.periodStart)
                .eq('period_end', range.periodEnd)
                .is('marked_at', null)
                .order('id', { ascending: false })
                .limit(20);
            return !error && Array.isArray(data) ? data : [];
        } catch {
            return [];
        }
    };
    const runDownload = async (kind, { skipDuplicateCheck = false } = {}) => {
        if (downloadBusy.current) return;
        const errors = exportErrors();
        setDownloadErrors({ csv: [], xlsx: [], [kind]: errors });
        if (errors.length) return;
        downloadBusy.current = true;
        setDownloading(kind);
        setDownloadMessage('');
        setExportNotice('');
        try {
            // 這一期已有還沒標記的匯出：先跳確認（若那份已交給銀行，應該回去標記它；再下載一份兩份都上傳會重複匯款）
            if (!skipDuplicateCheck) {
                const unmarked = await findUnmarkedExports();
                if (unmarked.length) {
                    setDuplicateConfirm({ kind, exports: unmarked });
                    return;
                }
            }
            // 先產生檔案內容（欄位有問題會在這裡擋下，不會留下沒用的匯出紀錄），再存匯出紀錄，成功才下載
            const blob = kind === 'csv'
                ? new Blob([buildTransferCsv({ people: computed.people, settings })], { type: 'text/csv;charset=utf-8' })
                : new Blob([await buildPayoutWorkbook({ people: computed.people, settings })], { type: XLSX_MIME });
            const record = await recordExport(kind);
            if (record.errors) {
                setDownloadErrors({ csv: [], xlsx: [], [kind]: record.errors });
                if (record.uncertain) setExportsRefresh((v) => v + 1);
                return;
            }
            downloadBlob(blob, payoutFilename({ periodMonth, payDate: settings.payDate, ext: kind, exportId: record.exportId }));
            setExportedVersion(editsVersion);
            const label = kind === 'csv' ? '轉帳檔 CSV' : '完整 Excel';
            setDownloadMessage(`已下載${label}${record.exportId ? `（匯出 #${record.exportId}）` : ''}：${computed.includedPeople.length} 人，共 ${formatMoney(computed.totalCents)}`);
            if (record.degraded) setExportNotice(`${MIGRATION_NEEDED_TEXT}這次下載沒有建立匯出紀錄，之後無法在系統對這份標記已付款；套用更新後請重新下載。`);
            else setExportsRefresh((v) => v + 1);
        } catch (error) {
            setDownloadErrors({ csv: [], xlsx: [], [kind]: [error.message] });
        } finally {
            downloadBusy.current = false;
            setDownloading('');
        }
    };
    const onDownloadCsv = () => runDownload('csv');
    const onDownloadXlsx = () => runDownload('xlsx');
    const CANCELLED_DOWNLOAD_MESSAGE = '已取消：沒有建立匯出紀錄，也沒有下載。';
    const confirmDuplicateDownload = () => {
        const kind = duplicateConfirm?.kind;
        setDuplicateConfirm(null);
        if (kind) runDownload(kind, { skipDuplicateCheck: true });
    };
    const cancelDuplicateDownload = () => {
        setDuplicateConfirm(null);
        setDownloadMessage(CANCELLED_DOWNLOAD_MESSAGE);
    };
    useEffect(() => {
        if (!duplicateConfirm) return undefined;
        const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            setDuplicateConfirm(null);
            setDownloadMessage('已取消：沒有建立匯出紀錄，也沒有下載。');
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [duplicateConfirm]);

    // ── 夥伴號碼匯入
    const onImportFile = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        try {
            const { text } = decodeCsvBytes(new Uint8Array(await file.arrayBuffer()));
            const nextPlan = planPartnerImport({ csvText: text, instructors });
            setImportState({ fileName: file.name, plan: nextPlan, applying: false, result: null, error: nextPlan.error });
        } catch (error) {
            setImportState({ fileName: file.name, plan: null, applying: false, result: null, error: `讀檔失敗：${error.message}` });
        }
    };
    const applyImport = async () => {
        const changes = (importState.plan?.entries || []).filter((entry) => entry.status === 'change');
        if (!changes.length) return;
        setImportState((current) => ({ ...current, applying: true }));
        const failures = [];
        let success = 0;
        for (const entry of changes) {
            const { data, error } = await supabase.from('instructors')
                .update({ partner_no: entry.partnerNo })
                .eq('id', entry.instructorId)
                .select('id, partner_no');
            if (error || (data || []).length !== 1) failures.push(`${entry.name || entry.maskedId}：${error?.message || '沒有更新到（權限或資料已變動）'}`);
            else success += 1;
        }
        try { await loadInstructors(); } catch (error) { failures.push(`重新讀取講師資料失敗：${error.message}`); }
        setImportState((current) => ({ ...current, applying: false, result: { success, failures } }));
    };

    const savePartnerNo = async (person) => {
        const value = String(partnerDrafts[person.instructorId] ?? '').replace(/\s/g, '').toUpperCase();
        if (value && !PARTNER_NO_PATTERN.test(value)) {
            setPartnerMessages((current) => ({ ...current, [person.instructorId]: '只能是英數 1～20 碼' }));
            return;
        }
        setPartnerSaving((current) => ({ ...current, [person.instructorId]: true }));
        const { data, error } = await supabase.from('instructors')
            .update({ partner_no: value || null })
            .eq('id', person.instructorId)
            .select('id, partner_no');
        let message = '';
        if (error) message = isMissingPartnerNoError(error) ? '需先套資料庫更新' : `儲存失敗：${error.message}`;
        else if ((data || []).length !== 1) message = '沒有更新到（權限或資料已變動）';
        else {
            message = '已儲存';
            try { await loadInstructors(); } catch (loadErr) { message = `已儲存，但重新讀取失敗：${loadErr.message}`; }
            setPartnerDrafts((current) => {
                const next = { ...current };
                delete next[person.instructorId];
                return next;
            });
        }
        setPartnerSaving((current) => ({ ...current, [person.instructorId]: false }));
        setPartnerMessages((current) => ({ ...current, [person.instructorId]: message }));
    };

    const periodOptions = plan ? recentPeriods(plan.periodMonth, 12) : [];
    const memoPreview = renderMemo(settings.memoTemplate, periodMonth);
    const importCounts = importState.plan?.counts;

    return (
        <main className="p-4 sm:p-8 max-w-7xl mx-auto">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-5 mb-6">
                <div className="max-w-3xl min-w-0">
                    <Link
                        to="/admin"
                        onClick={(event) => { if (dirty && !window.confirm('有調整或排除尚未匯出，確定要離開嗎？')) event.preventDefault(); }}
                        className="inline-flex items-center gap-1 min-h-[44px] text-sm font-black text-bauhaus-black/60 hover:text-bauhaus-blue mb-2"
                    >
                        <ArrowLeft className="w-4 h-4" /> 回後台管理
                    </Link>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">月結匯款</h1>
                    <p className="mt-2 text-sm sm:text-base font-medium text-bauhaus-black/65 leading-relaxed">
                        把某一期「已核准、未付款」的講師報酬，匯出成財務部的銀行批次轉帳檔。付款日期、金額調整與附言都可以在這裡改。
                    </p>
                </div>
                <button type="button" onClick={() => loadPeriod(periodMonth, { reloadInstructors: true })} disabled={loading || !periodMonth} className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px] shrink-0 self-start disabled:opacity-50">
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    {loading ? '讀取中' : '重新整理'}
                </button>
            </div>

            <div role="note" data-testid="payout-first-version-warning" className="mb-6 bg-bauhaus-red text-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 sm:p-5 flex items-start gap-3">
                <AlertTriangle className="w-6 h-6 shrink-0 mt-0.5" aria-hidden="true" />
                <div className="text-sm sm:text-base font-medium leading-relaxed min-w-0">
                    <p className="font-black text-base sm:text-lg">第一版：格式待財務確認。正式匯款前，請財務先用小額或試算核對。</p>
                    <p className="mt-1">檔案含身分證字號與銀行帳號，只能提供財務作業使用。每次下載都會存一份匯出紀錄（檔名的「匯出N」）。銀行匯款完成後，請在本頁下方「匯款完成，標記為已付款」對交給銀行的那一份標記：只會標記那份檔案裡的課。</p>
                </div>
            </div>

            {loadError && (
                <div role="alert" className="mb-6 bg-bauhaus-red text-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 font-bold">{loadError}</div>
            )}

            {/* ── 期別與整批設定 */}
            <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard overflow-hidden mb-6" aria-labelledby="payout-settings-heading">
                <div className="bg-bauhaus-black text-white px-4 sm:px-6 py-4">
                    <h2 id="payout-settings-heading" className="text-lg sm:text-xl font-black">期別與整批設定</h2>
                </div>
                <div className="p-4 sm:p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    <label className="block md:col-span-2 xl:col-span-1">
                        <span className="bh-label block mb-1.5">期別</span>
                        <select aria-label="期別" value={periodMonth} onChange={(event) => changePeriod(event.target.value)} className="bh-input min-h-[44px]" disabled={!plan || loading}>
                            {periodOptions.map((option) => (
                                <option key={option} value={option}>{periodLabel(option)}{option === plan?.periodMonth ? '・下次匯款' : ''}</option>
                            ))}
                        </select>
                        {scheduleNote && <span className="block mt-1 text-xs font-bold text-bauhaus-red">{scheduleNote}</span>}
                    </label>
                    <label className="block">
                        <span className="bh-label block mb-1.5">付款日期</span>
                        <input aria-label="付款日期" type="date" value={settings.payDate} onChange={(event) => updateSetting('payDate', event.target.value)} className="bh-input min-h-[44px]" />
                    </label>
                    <label className="block">
                        <span className="bh-label block mb-1.5">付款帳號（公司帳號）</span>
                        <input aria-label="付款帳號" type="text" inputMode="numeric" autoComplete="off" value={settings.payerAccount} onChange={(event) => updateSetting('payerAccount', event.target.value)} placeholder="必填，只能數字" className="bh-input min-h-[44px] font-mono" />
                    </label>
                    <label className="block">
                        <span className="bh-label block mb-1.5">付款分行（4 碼）</span>
                        <input aria-label="付款分行" type="text" inputMode="numeric" autoComplete="off" value={settings.payerBranch} onChange={(event) => updateSetting('payerBranch', event.target.value)} placeholder="必填，例：0123" className="bh-input min-h-[44px] font-mono" />
                    </label>
                    <CodeSelect label="匯款通知方式" templateValue={DEFAULT_NOTICE_METHOD} value={settings.noticeMethod} onChange={(value) => updateSetting('noticeMethod', value)} />
                    <CodeSelect label="手續費負擔方式" templateValue={DEFAULT_FEE_BEARER} value={settings.feeBearer} onChange={(value) => updateSetting('feeBearer', value)} />
                    <label className="block md:col-span-2 xl:col-span-3">
                        <span className="bh-label block mb-1.5">付款相關附言範本（{'{YYYY}'} 年、{'{YY}'} 年末兩碼、{'{MM}'} 月）</span>
                        <input aria-label="附言範本" type="text" value={settings.memoTemplate} onChange={(event) => updateSetting('memoTemplate', event.target.value)} className="bh-input min-h-[44px]" />
                        <span className="block mt-1 text-xs font-bold text-bauhaus-black/60">
                            預覽：<span data-testid="payout-memo-preview" className="font-black text-bauhaus-black">{memoPreview}</span>
                            <span data-testid="payout-memo-length" className="ml-2">（{memoLength(memoPreview)} 字）</span>
                        </span>
                    </label>
                    <p className="md:col-span-2 xl:col-span-3 text-xs font-bold text-bauhaus-black/55">付款帳號與分行只存在這台電腦的瀏覽器裡（不寫進程式、不上傳），換電腦要重填。</p>
                </div>
            </section>

            {/* ── 本期概況 */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6" aria-label="本期概況">
                <div className="bh-card p-4">
                    <div className="text-xs font-black text-bauhaus-black/55">納入人數</div>
                    <div data-testid="payout-included-count" className="text-2xl font-black text-bauhaus-black">{computed.includedPeople.length}</div>
                    <div className="text-[11px] font-bold text-bauhaus-black/50">共 {computed.people.length} 人，阻擋 {computed.blockedCount} 人</div>
                </div>
                <div className="bh-card p-4">
                    <div className="text-xs font-black text-bauhaus-black/55">匯款總額</div>
                    <div data-testid="payout-total" className="text-2xl font-black text-bauhaus-blue">{formatMoney(computed.totalCents)}</div>
                    <div className="text-[11px] font-bold text-bauhaus-black/50">有警告 {computed.warningCount} 人</div>
                </div>
                <div className="bh-card p-4">
                    <div className="text-xs font-black text-bauhaus-black/55">本期不會匯</div>
                    <div data-testid="payout-stats-period" className="text-sm font-black text-bauhaus-black">待核准 {stats?.pendingCount ?? '—'} 筆・已付 {stats?.paidCount ?? '—'} 筆</div>
                </div>
                <div className="bh-card p-4">
                    <div className="text-xs font-black text-bauhaus-black/55">本期以前仍未付（已核准）</div>
                    <div data-testid="payout-stats-earlier" className={`text-sm font-black ${stats?.earlierCount ? 'text-bauhaus-red' : 'text-bauhaus-black'}`}>
                        {stats ? `${stats.earlierCount} 筆・${formatMoney(stats.earlierCents)}` : '—'}
                    </div>
                    <div className="text-[11px] font-bold text-bauhaus-black/50">不在本期。切換到那些課所在的期別即可匯出，或到報酬登記中心處理</div>
                </div>
            </section>

            {(dataChanged || stats?.paidCount > 0 || computed.anomalyExcludedCount > 0 || computed.anomalyIncludedCount > 0) && (
                <div className="mb-6 space-y-2">
                    {dataChanged && (
                        <div role="alert" data-testid="payout-data-changed" className="bg-bauhaus-red text-white border-2 border-bauhaus-black rounded-xl p-3 text-sm font-black">
                            {DATA_CHANGED_MESSAGE}（本期已核准共 {periodData.approvedCount} 筆，讀到 {periodData.sessions.length} 筆），匯出前請先按「重新整理」。
                        </div>
                    )}
                    {stats?.paidCount > 0 && (
                        <div role="status" data-testid="payout-paid-warning" className="bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl p-3 text-sm font-black text-bauhaus-black">
                            本期已有 {stats.paidCount} 筆標為已付款，請確認不會重複匯款
                        </div>
                    )}
                    {(computed.anomalyExcludedCount > 0 || computed.anomalyIncludedCount > 0) && (
                        <div role="status" data-testid="payout-anomaly-note" className="bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl p-3 text-sm font-black text-bauhaus-black">
                            已預設排除 {computed.anomalyExcludedCount} 筆異常標記的課，確認無誤可勾回{computed.anomalyIncludedCount > 0 ? `（目前已勾回 ${computed.anomalyIncludedCount} 筆）` : ''}。展開該講師可看到異常原因；要勾回就把那堂課的「排除」取消勾選。
                        </div>
                    )}
                </div>
            )}

            {/* ── 每人一列 */}
            <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard overflow-hidden mb-6" aria-labelledby="payout-people-heading">
                <div className="px-4 sm:px-6 py-4 border-b-2 border-bauhaus-black">
                    <h2 id="payout-people-heading" className="text-lg sm:text-xl font-black text-bauhaus-black">每位講師</h2>
                    <p className="text-xs font-bold text-bauhaus-black/55 mt-1">
                        紅色標籤＝阻擋（不能匯，要先修講師資料）；黃色＝警告（可以匯，請核對）。預覽只顯示帳號末 4 碼、身分證遮罩，檔案內是完整資料。
                    </p>
                </div>
                {loading ? (
                    <div className="p-12 text-center font-bold text-bauhaus-black/50">正在讀取本期報酬…</div>
                ) : computed.people.length === 0 ? (
                    <div className="p-10 text-center">
                        <FileSpreadsheet className="w-12 h-12 mx-auto text-bauhaus-black/30" aria-hidden="true" />
                        <p className="mt-3 font-black text-bauhaus-black">這一期沒有已核准、未付款的報酬</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto" data-testid="payout-people-scroll">
                        <table className="w-full min-w-[1120px] text-sm">
                            <thead className="bg-bauhaus-black text-white text-xs">
                                <tr>
                                    <th className="px-3 py-3 text-left w-14">納入</th>
                                    <th className="px-3 py-3 text-left">姓名</th>
                                    <th className="px-3 py-3 text-right">筆數</th>
                                    <th className="px-3 py-3 text-right">系統金額</th>
                                    <th className="px-3 py-3 text-left">調整金額＋原因</th>
                                    <th className="px-3 py-3 text-right">實付</th>
                                    <th className="px-3 py-3 text-left">附言（可覆寫）</th>
                                    <th className="px-3 py-3 text-left">狀態</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y-2 divide-bauhaus-black/15">
                                {computed.people.map((person) => {
                                    const isOpen = expanded.has(person.instructorId);
                                    const adjustment = edits.adjustments[person.instructorId] || {};
                                    return (
                                        <Fragment key={person.instructorId}>
                                        <tr data-testid={`payout-row-${person.instructorId}`} className={person.blocked ? 'bg-bauhaus-red/5' : person.included ? 'bg-white' : 'bg-bauhaus-muted/60'}>
                                            <td className="px-3 py-3 align-top">
                                                <input
                                                    type="checkbox"
                                                    aria-label={`${person.name} 納入匯款`}
                                                    checked={person.included}
                                                    disabled={person.blocked}
                                                    onChange={() => toggleSet('excludedInstructorIds', person.instructorId)}
                                                    className="w-5 h-5 accent-bauhaus-blue"
                                                />
                                            </td>
                                            <td className="px-3 py-3 align-top">
                                                <button type="button" onClick={() => toggleExpanded(person.instructorId)} aria-expanded={isOpen} aria-label={`${person.name} 展開明細`} className="inline-flex items-center gap-1 font-black text-bauhaus-black hover:text-bauhaus-blue min-h-[32px] text-left">
                                                    {isOpen ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                                                    {person.name || '（未填姓名）'}
                                                </button>
                                                <div className="text-[11px] font-bold text-bauhaus-black/50 font-mono pl-5">{person.partnerLabel || '—'}</div>
                                                {/* 窄螢幕看不到右邊的狀態欄：姓名格內直接放簡短標籤 */}
                                                {person.blocked ? (
                                                    <span data-testid={`payout-tag-${person.instructorId}`} className="xl:hidden inline-block mt-1 ml-5 text-[11px] font-black px-2 py-0.5 rounded-full border border-bauhaus-black bg-bauhaus-red text-white whitespace-normal">
                                                        不匯：{person.blockerTags[0]}{person.blockerTags.length > 1 ? ` 等 ${person.blockerTags.length} 項` : ''}
                                                    </span>
                                                ) : person.warnings.length > 0 ? (
                                                    <span data-testid={`payout-tag-${person.instructorId}`} className="xl:hidden inline-block mt-1 ml-5 text-[11px] font-black px-2 py-0.5 rounded-full border border-bauhaus-black bg-bauhaus-yellow text-bauhaus-black whitespace-normal">
                                                        注意 {person.warnings.length} 項
                                                    </span>
                                                ) : null}
                                            </td>
                                            <td className="px-3 py-3 text-right align-top font-mono">{person.sessionCount}{person.excludedSessionCount ? <span className="block text-[11px] text-bauhaus-black/50">排除 {person.excludedSessionCount}</span> : null}</td>
                                            <td className="px-3 py-3 text-right align-top font-mono">{formatMoney(person.systemCents)}</td>
                                            <td className="px-3 py-3 align-top">
                                                <div className="flex gap-2">
                                                    <input type="text" aria-label={`${person.name} 調整金額`} value={adjustment.amount ?? ''} onChange={(event) => setAdjustment(person.instructorId, 'amount', event.target.value)} placeholder="例：-500" className={`bh-input w-24 py-1.5 font-mono ${person.adjustmentValid ? '' : 'border-bauhaus-red'}`} />
                                                    <input type="text" aria-label={`${person.name} 調整原因`} value={adjustment.reason ?? ''} onChange={(event) => setAdjustment(person.instructorId, 'reason', event.target.value)} placeholder={person.hasAdjustment ? '必填：原因' : '原因'} className={`bh-input w-40 py-1.5 ${person.adjustmentCents !== 0 && !person.adjustmentReason ? 'border-bauhaus-red' : ''}`} />
                                                </div>
                                            </td>
                                            <td data-testid={`payout-pay-${person.instructorId}`} className="px-3 py-3 text-right align-top font-mono font-black">{formatMoney(person.payCents)}</td>
                                            <td className="px-3 py-3 align-top">
                                                <input type="text" aria-label={`${person.name} 附言`} value={edits.memoOverrides[person.instructorId] ?? ''} onChange={(event) => setMemoOverride(person.instructorId, event.target.value)} placeholder="留空＝用範本附言" className="bh-input w-56 py-1.5 text-xs" />
                                            </td>
                                            <td className="px-3 py-3 align-top max-w-[260px]">
                                                {person.blockers.map((text) => <Chip key={text} tone="block">{text}</Chip>)}
                                                {person.warnings.map((text) => <Chip key={text} tone="warn">{text}</Chip>)}
                                                {person.adjustmentCents !== 0 && <Chip tone="info">有人工調整</Chip>}
                                                {!person.blocked && !person.included && <Chip tone="info">未勾選</Chip>}
                                                {!person.blockers.length && !person.warnings.length && person.included && <Chip tone="ok">可匯</Chip>}
                                            </td>
                                        </tr>
                                        {isOpen && (
                                            <tr className="bg-bauhaus-cream">
                                                <td colSpan={8} className="px-3 sm:px-6 py-4">
                                                    <div className="grid grid-cols-2 lg:grid-cols-6 gap-3 text-xs font-bold text-bauhaus-black/70 mb-3">
                                                        <div>解款行<div className="font-mono text-sm text-bauhaus-black">{person.bankCode || '—'}</div></div>
                                                        <div>收款帳號<div className="font-mono text-sm text-bauhaus-black">{maskAccount(person.accountNumber) || '—'}</div></div>
                                                        <div>戶名<div className="text-sm text-bauhaus-black">{person.accountName || '—'}</div></div>
                                                        <div>身分證<div className="font-mono text-sm text-bauhaus-black">{maskIdNumber(person.idNumber) || '—'}</div></div>
                                                        <div className="col-span-2">Email<div className="text-sm text-bauhaus-black break-all">{person.email || '—'}</div></div>
                                                    </div>
                                                    <div className="flex flex-wrap items-end gap-3 mb-3">
                                                        <label className="block">
                                                            <span className="bh-label block mb-1">這位全部設為…</span>
                                                            <select aria-label={`${person.name} 全部成本中心`} value="" onChange={(event) => setPersonCostCenter(person, event.target.value === '__blank' ? '' : event.target.value)} className="bh-input py-1.5 min-h-[40px]">
                                                                <option value="">選擇成本中心</option>
                                                                <option value="__blank">（空白）</option>
                                                                {COST_CENTERS.map((code) => <option key={code} value={code}>{code}</option>)}
                                                            </select>
                                                        </label>
                                                        {person.adjustmentCents !== 0 && (
                                                            <label className="block">
                                                                <span className="bh-label block mb-1">調整的成本中心</span>
                                                                <select aria-label={`${person.name} 調整成本中心`} value={adjustment.costCenter || ''} onChange={(event) => setAdjustment(person.instructorId, 'costCenter', event.target.value)} className="bh-input py-1.5 min-h-[40px]">
                                                                    <option value="">（空白）</option>
                                                                    {COST_CENTERS.map((code) => <option key={code} value={code}>{code}</option>)}
                                                                </select>
                                                            </label>
                                                        )}
                                                        <div className="block">
                                                            <span className="bh-label block mb-1">夥伴號碼</span>
                                                            {partnerNoMissing ? (
                                                                <span className="text-xs font-black text-bauhaus-red">需先套資料庫更新</span>
                                                            ) : (
                                                                <span className="flex items-center gap-2">
                                                                    <input type="text" aria-label={`${person.name} 夥伴號碼`} value={partnerDrafts[person.instructorId] ?? person.partnerNo} onChange={(event) => setPartnerDrafts((current) => ({ ...current, [person.instructorId]: event.target.value }))} placeholder="例：A036872" className="bh-input w-32 py-1.5 font-mono" disabled={!person.instructor} />
                                                                    <button type="button" aria-label={`${person.name} 儲存夥伴號碼`} onClick={() => savePartnerNo(person)} disabled={!person.instructor || partnerSaving[person.instructorId] || partnerDrafts[person.instructorId] === undefined} className="bh-btn bh-btn-outline px-3 py-1.5 text-xs min-h-[40px] disabled:opacity-40">
                                                                        {partnerSaving[person.instructorId] ? '儲存中' : '儲存號碼'}
                                                                    </button>
                                                                    {partnerMessages[person.instructorId] && <span role="status" className="text-xs font-black">{partnerMessages[person.instructorId]}</span>}
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="overflow-x-auto">
                                                        <table className="w-full min-w-[760px] text-xs bg-white border-2 border-bauhaus-black">
                                                            <thead className="bg-bauhaus-muted">
                                                                <tr>
                                                                    <th className="px-2 py-2 text-left">排除</th>
                                                                    <th className="px-2 py-2 text-left">日期</th>
                                                                    <th className="px-2 py-2 text-left">課程種類</th>
                                                                    <th className="px-2 py-2 text-left">課程名稱</th>
                                                                    <th className="px-2 py-2 text-right">本次應付</th>
                                                                    <th className="px-2 py-2 text-right">已付</th>
                                                                    <th className="px-2 py-2 text-left">報價</th>
                                                                    <th className="px-2 py-2 text-left">成本中心</th>
                                                                </tr>
                                                            </thead>
                                                            <tbody className="divide-y divide-bauhaus-black/15">
                                                                {person.sessions.map((row) => {
                                                                    const label = `${row.session.session_date} ${row.session.course_name || COURSE_LABELS[row.session.course_type] || ''}`;
                                                                    return (
                                                                        <tr key={row.session.id} className={row.excluded ? 'opacity-50 line-through' : ''}>
                                                                            <td className="px-2 py-1.5"><input type="checkbox" aria-label={`${label} 排除`} checked={row.excluded} onChange={() => toggleSet(row.anomaly ? 'includedAnomalySessionIds' : 'excludedSessionIds', row.session.id)} className="w-4 h-4 accent-bauhaus-red" /></td>
                                                                            <td className="px-2 py-1.5 font-mono">{row.session.session_date}</td>
                                                                            <td className="px-2 py-1.5">{COURSE_LABELS[row.session.course_type] || row.session.course_type}</td>
                                                                            <td className="px-2 py-1.5">
                                                                                {row.session.course_name || '—'}
                                                                                {row.anomaly && (
                                                                                    <span data-testid={`payout-anomaly-${row.session.id}`} className="block no-underline text-[11px] font-black text-bauhaus-red">
                                                                                        異常標記{row.excluded ? '（預設排除）' : '（已勾回）'}：{row.anomalyReasons.join('、') || '未註明原因'}
                                                                                    </span>
                                                                                )}
                                                                            </td>
                                                                            <td className="px-2 py-1.5 text-right font-mono">{formatMoney(row.payableCents)}</td>
                                                                            <td className="px-2 py-1.5 text-right font-mono">{Number(row.session.paid_amount || 0) ? formatMoney(Math.round(Number(row.session.paid_amount) * 100)) : '—'}</td>
                                                                            <td className="px-2 py-1.5">{PRICING_LABELS[row.session.pricing_status] || row.session.pricing_status || '—'}</td>
                                                                            <td className="px-2 py-1.5">
                                                                                <select aria-label={`${label} 成本中心`} value={row.costCenter} onChange={(event) => setCostCenter(row.session.id, event.target.value)} className="border-2 border-bauhaus-black rounded-lg px-2 py-1 bg-white">
                                                                                    <option value="">（空白）</option>
                                                                                    {COST_CENTERS.map((code) => <option key={code} value={code}>{code}</option>)}
                                                                                </select>
                                                                            </td>
                                                                        </tr>
                                                                    );
                                                                })}
                                                            </tbody>
                                                        </table>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                        </Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
                {computed.unmatchedSessions.length > 0 && (
                    <div data-testid="payout-unmatched" className="px-4 sm:px-6 py-4 border-t-2 border-bauhaus-black bg-bauhaus-yellow/30 text-sm">
                        <p className="font-black text-bauhaus-black">對不到講師 {computed.unmatchedSessions.length} 筆（沒有連到講師主檔，不會匯，請到報酬登記中心處理）：</p>
                        <ul className="mt-1 text-xs font-bold text-bauhaus-black/70 list-disc pl-5">
                            {computed.unmatchedSessions.slice(0, 20).map((session) => (
                                <li key={session.id}>{session.instructor_name || '（無姓名）'}・{session.session_date}・{session.course_name || COURSE_LABELS[session.course_type] || ''}・{formatMoney(session.payableCents)}</li>
                            ))}
                        </ul>
                    </div>
                )}
            </section>

            {/* ── 下載 */}
            <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 sm:p-6 mb-6" aria-labelledby="payout-download-heading">
                <h2 id="payout-download-heading" className="text-lg sm:text-xl font-black text-bauhaus-black mb-1">下載</h2>
                <p className="text-sm font-bold text-bauhaus-black/70 mb-4">
                    本次納入 <span className="font-black text-bauhaus-black">{computed.includedPeople.length}</span> 人，匯款總額 <span className="font-black text-bauhaus-blue">{formatMoney(computed.totalCents)}</span>。
                    Excel 的二代健保欄第一版<span className="font-black text-bauhaus-red">未計算（填 0）</span>，行政薪資填 0、成本中心沒選的在總計顯示「未填」。
                </p>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="border-2 border-bauhaus-black rounded-xl p-4">
                        <button type="button" onClick={onDownloadCsv} disabled={Boolean(downloading)} className="bh-btn bh-btn-blue px-5 py-3 min-h-[44px] w-full sm:w-auto disabled:opacity-60">
                            <Download className="w-5 h-5" /> {downloading === 'csv' ? '建立匯出紀錄中…' : '轉帳檔 CSV'}
                        </button>
                        <p className="mt-3 text-xs font-bold text-bauhaus-black/70 leading-relaxed">
                            CSV 請直接上傳網銀；若要用 Excel 看，請用『資料→從文字/CSV』匯入並把帳號欄設為文字，不要直接雙擊開啟，否則開頭的 0 會不見。要用 Excel 看請下載 Excel 版。
                        </p>
                        {downloadErrors.csv.length > 0 && (
                            <ul role="alert" data-testid="payout-csv-errors" className="mt-3 text-sm font-black text-bauhaus-red list-disc pl-5">
                                {downloadErrors.csv.map((text) => <li key={text}>{text}</li>)}
                            </ul>
                        )}
                    </div>
                    <div className="border-2 border-bauhaus-black rounded-xl p-4">
                        <button type="button" onClick={onDownloadXlsx} disabled={Boolean(downloading)} className="bh-btn bh-btn-outline px-5 py-3 min-h-[44px] w-full sm:w-auto disabled:opacity-60">
                            <FileSpreadsheet className="w-5 h-5" /> {downloading === 'xlsx' ? '建立匯出紀錄中…' : '完整 Excel（四分頁）'}
                        </button>
                        <p className="mt-3 text-xs font-bold text-bauhaus-black/70 leading-relaxed">
                            分頁：轉帳檔案、薪資明細、薪資總計、供應商。代碼與帳號都存成文字，開頭的 0 不會不見。
                        </p>
                        {downloadErrors.xlsx.length > 0 && (
                            <ul role="alert" data-testid="payout-xlsx-errors" className="mt-3 text-sm font-black text-bauhaus-red list-disc pl-5">
                                {downloadErrors.xlsx.map((text) => <li key={text}>{text}</li>)}
                            </ul>
                        )}
                    </div>
                </div>
                {downloadMessage && <p role="status" data-testid="payout-download-message" className="mt-4 text-sm font-black text-bauhaus-blue">{downloadMessage}</p>}
                {exportNotice && <p role="status" data-testid="payout-export-degraded" className="mt-2 text-sm font-black text-bauhaus-black bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl p-3">{exportNotice}</p>}
                {dirty && <p className="mt-2 text-xs font-bold text-bauhaus-red">有調整或排除尚未匯出；離開頁面前會提醒。</p>}
            </section>

            {/* ── 匯款完成，標記為已付款（對某一份匯出紀錄） */}
            <PayoutMarkPaidPanel
                range={periodRange(periodMonth)}
                today={today}
                refreshKey={exportsRefresh}
                onChanged={() => loadPeriod(periodMonth)}
            />

            {/* ── 夥伴號碼匯入 */}
            <section className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-4 sm:p-6" aria-labelledby="payout-partner-heading">
                <h2 id="payout-partner-heading" className="text-lg sm:text-xl font-black text-bauhaus-black mb-1">夥伴號碼匯入</h2>
                <p className="text-sm font-medium text-bauhaus-black/70 mb-4">
                    上傳財務「供應商」分頁匯出的 CSV，用身分證比對講師，把夥伴號碼存進講師主檔。空白與「需新增…」會略過；先預覽，按確認才會寫入。
                </p>
                {partnerNoMissing ? (
                    <p role="status" data-testid="payout-partner-missing" className="text-sm font-black text-bauhaus-red">
                        需先套資料庫更新（20261022093700_instructor_partner_no.sql）才能匯入夥伴號碼；目前轉帳檔的夥伴號碼一律寫「需新增」。
                    </p>
                ) : (
                    <>
                        <label className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px] cursor-pointer inline-flex">
                            <Upload className="w-4 h-4" /> 選擇 CSV
                            <input type="file" accept=".csv,text/csv" aria-label="上傳夥伴號碼 CSV" onChange={onImportFile} className="sr-only" />
                        </label>
                        {importState.fileName && <span className="ml-3 text-xs font-bold text-bauhaus-black/60 break-all">{importState.fileName}</span>}
                        {importState.error && <p role="alert" className="mt-3 text-sm font-black text-bauhaus-red">{importState.error}</p>}
                        {importState.plan && !importState.plan.error && (
                            <div className="mt-4">
                                <p data-testid="payout-import-counts" className="text-sm font-black text-bauhaus-black">
                                    符合 {importCounts.matched}（會變更 {importCounts.change}、不變 {importCounts.same}）・對不到 {importCounts.unmatched}・衝突 {importCounts.conflict}・格式不符 {importCounts.invalid}・略過 {importCounts.skipped}
                                </p>
                                <div className="mt-3 max-h-72 overflow-auto border-2 border-bauhaus-black rounded-xl">
                                    <table className="w-full min-w-[640px] text-xs">
                                        <thead className="bg-bauhaus-muted sticky top-0">
                                            <tr>
                                                <th className="px-2 py-2 text-left">結果</th>
                                                <th className="px-2 py-2 text-left">CSV 列</th>
                                                <th className="px-2 py-2 text-left">身分證</th>
                                                <th className="px-2 py-2 text-left">講師</th>
                                                <th className="px-2 py-2 text-left">原號碼 → 新號碼</th>
                                                <th className="px-2 py-2 text-left">說明</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-bauhaus-black/15">
                                            {importState.plan.entries.map((entry) => (
                                                <tr key={`${entry.line}-${entry.partnerNo}`} data-testid={`payout-import-${entry.status}`}>
                                                    <td className="px-2 py-1.5 font-black">{IMPORT_STATUS_LABELS[entry.status]}</td>
                                                    <td className="px-2 py-1.5 font-mono">{entry.line}</td>
                                                    <td className="px-2 py-1.5 font-mono">{entry.maskedId}</td>
                                                    <td className="px-2 py-1.5">{entry.name || '—'}</td>
                                                    <td className="px-2 py-1.5 font-mono">{entry.status === 'change' || entry.status === 'same' ? `${entry.oldPartnerNo || '（空白）'} → ${entry.partnerNo}` : entry.partnerNo}</td>
                                                    <td className="px-2 py-1.5">{[entry.reason, entry.warning].filter(Boolean).join('；') || '—'}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                                <button type="button" onClick={applyImport} disabled={importState.applying || importCounts.change === 0 || Boolean(importState.result)} className="mt-3 bh-btn bh-btn-blue px-4 py-2.5 min-h-[44px] disabled:opacity-40">
                                    {importState.applying ? '更新中…' : `確認更新 ${importCounts.change} 位講師的夥伴號碼`}
                                </button>
                                {importState.result && (
                                    <div role="status" data-testid="payout-import-result" className="mt-3 text-sm font-black">
                                        <p className="text-bauhaus-blue">已更新 {importState.result.success} 位</p>
                                        {importState.result.failures.length > 0 && (
                                            <ul className="text-bauhaus-red list-disc pl-5">
                                                {importState.result.failures.map((text) => <li key={text}>{text}</li>)}
                                            </ul>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </>
                )}
            </section>
            {duplicateConfirm && (
                <div className="fixed inset-0 bg-bauhaus-black/60 flex items-center justify-center p-4 z-50" onClick={cancelDuplicateDownload}>
                    <div role="dialog" aria-modal="true" aria-labelledby="payout-duplicate-title" data-testid="payout-duplicate-confirm"
                        className="bh-card shadow-hard-lg max-w-lg w-full max-h-[90vh] overflow-y-auto p-5 sm:p-6" onClick={(event) => event.stopPropagation()}>
                        <h2 id="payout-duplicate-title" className="text-lg sm:text-xl font-black text-bauhaus-black flex items-center gap-2">
                            <AlertTriangle className="w-5 h-5 text-bauhaus-red shrink-0" aria-hidden="true" /> 這一期還有沒標記的匯出
                        </h2>
                        <p data-testid="payout-duplicate-text" className="mt-3 text-sm font-bold text-bauhaus-black leading-relaxed">{duplicateExportWarning(duplicateConfirm.exports)}</p>
                        <ul data-testid="payout-duplicate-list" className="mt-3 space-y-1.5 text-sm font-medium text-bauhaus-black">
                            {duplicateConfirm.exports.map((row) => (
                                <li key={row.id} className="border-2 border-bauhaus-black rounded-lg px-3 py-2 bg-bauhaus-yellow/30">
                                    <span className="font-mono font-black">#{row.id}</span>・{formatTaipeiTime(row.exported_at)}・{row.exported_by_name || '—'}下載・{row.people_count} 人・{row.item_count} 筆・{formatMoney(amountToCents(row.transfer_total))}
                                </li>
                            ))}
                        </ul>
                        <div className="mt-5 flex gap-2 flex-wrap">
                            <button type="button" onClick={cancelDuplicateDownload} autoFocus className="bh-btn bh-btn-outline px-4 py-2.5 min-h-[44px]">
                                取消，不下載
                            </button>
                            <button type="button" onClick={confirmDuplicateDownload} className="bh-btn bh-btn-red px-4 py-2.5 min-h-[44px]">
                                確定再下載一份
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </main>
    );
};

export default SalaryPayoutExport;
