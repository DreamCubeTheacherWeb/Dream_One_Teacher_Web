import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import { Search, ChevronDown, ChevronUp, ExternalLink, FileImage, MapPin, Plus, Link2, Unlink, X, Check, Eye, FileText, Loader2, Settings, AlertCircle, Pencil, ListChecks, Trash2, Mail } from 'lucide-react';
import { generateFilledForm, loadFormTemplate } from '../../lib/formGenerator';
import { REQUIRED_PROFILE_DOCUMENTS, hasInstructorDocument } from '../../lib/profileCompletion';
import {
    PROGRESS_TODO_FILTER,
    buildProgressRows,
    countProgress,
    getVisibleProgressStages,
    hasConfirmedEmail,
    isProgressFilterKey,
    matchesProgressFilter,
} from '../../lib/instructorProgress';
import { ConfirmInstructorEmailModal, InstructorEmailConfirmation } from '../../components/ConfirmInstructorEmail';
import { fetchAllPages, loadProgressSupport } from '../../lib/instructorProgressLoader';
import {
    MAX_NAME_SLOT_BATCH,
    describeBatchDuplicate,
    describeRosterConflict,
    findNameConflicts,
    isPristineNameSlot,
    normalizePersonName,
    parseNameLines,
} from '../../lib/instructorNameSlots';
import FilledFormPreviewModal from '../../components/FilledFormPreviewModal';
import { INSTRUCTOR_LEVEL_LABELS as ROLE_LABELS, SPEED_QUALIFICATION_LABELS, speedQualificationLabel } from '../../lib/constants';

const STATUS_OPTIONS = [
    { key: 'active',    label: '講師',     color: 'bg-bauhaus-blue text-white' },
    { key: 'staff',     label: '職員',     color: 'bg-bauhaus-black text-white' },
    { key: 'assistant', label: '助教',     color: 'bg-white text-bauhaus-black' },
    { key: 'part_time', label: '工讀生',   color: 'bg-bauhaus-muted text-bauhaus-black' },
    { key: 'frozen',    label: '冷凍',     color: 'bg-bauhaus-yellow text-bauhaus-black' },
    { key: 'cancelled', label: '已離職／停止合作', color: 'bg-bauhaus-red text-white' },
];
const STATUS_MAP = Object.fromEntries(STATUS_OPTIONS.map(s => [s.key, s]));

// 桌機表格：欄數與每格左右留白（lg 較窄、xl 放寬）
const TABLE_COLS = 8;
const CELL_X = 'px-1.5 xl:px-4 py-3';

const DOC_KEYS = [
    { key: 'id_front', label: '身分證正面' },
    { key: 'id_back', label: '身分證反面' },
    { key: 'photo', label: '講師照片' },
    { key: 'bankbook', label: '存摺封面' },
];
// 資料進度標籤的配色（階段定義與判斷在 lib/instructorProgress.js，這裡只管樣式）
const PROGRESS_STYLES = {
    [PROGRESS_TODO_FILTER]: 'bg-bauhaus-red text-white',
    unclaimed: 'bg-bauhaus-muted text-bauhaus-black',
    pending_review: 'bg-bauhaus-yellow text-bauhaus-black',
    awaiting_email_confirm: 'bg-bauhaus-red text-white',
    awaiting_email_verify: 'bg-bauhaus-yellow text-bauhaus-black',
    incomplete: 'bg-bauhaus-red text-white',
    awaiting_contract: 'bg-bauhaus-black text-white',
    complete: 'bg-bauhaus-blue text-white',
    profile_ready: 'bg-bauhaus-blue text-white',
    disabled: 'bg-white text-bauhaus-black/60',
};
const NAME_SLOT_UNLINK_HINT = '若認領錯人：按解除綁定，對方會回到待審核';
const LINK_FILTERS = [
    { key: '', label: '全部', color: 'bg-bauhaus-black text-white' },
    { key: 'linked', label: '已認領', color: 'bg-bauhaus-blue text-white' },
    { key: 'unlinked', label: '未認領', color: 'bg-bauhaus-muted text-bauhaus-black' },
];

const InstructorList = () => {
    const { user, profile } = useAuth();
    const isAdmin = profile?.role === 'admin';
    const [searchParams, setSearchParams] = useSearchParams();
    const requestedLinkFilter = searchParams.get('claim');
    const linkFilter = requestedLinkFilter === 'linked' || requestedLinkFilter === 'unlinked'
        ? requestedLinkFilter
        : '';
    const requestedProgress = searchParams.get('progress');
    const progressFilterParam = isProgressFilterKey(requestedProgress) ? requestedProgress : '';
    const [instructors, setInstructors] = useState([]);
    // 資料進度需要的輔助資料：登入帳號（role、Google Email）與已簽約的 user_id。
    // null＝讀不到（例如輔導員看不到簽約紀錄），畫面會誠實標示「簽約狀態未知」而不是亂猜。
    const [usersById, setUsersById] = useState(null);
    const [signedUserIds, setSignedUserIds] = useState(null);
    const [activationsByUserId, setActivationsByUserId] = useState(null);
    const [confirmingInst, setConfirmingInst] = useState(null);
    const [supportError, setSupportError] = useState(false);
    const [notice, setNotice] = useState('');
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [roleFilter, setRoleFilter] = useState('');
    const [speedFilter, setSpeedFilter] = useState('');
    const [expandedId, setExpandedId] = useState(null);
    const [signedUrls, setSignedUrls] = useState({});
    const [showAddModal, setShowAddModal] = useState(false);
    const [linkingInst, setLinkingInst] = useState(null);
    const [formTemplates, setFormTemplates] = useState([]);
    const [selectedFormType, setSelectedFormType] = useState('');
    const [generatingFor, setGeneratingFor] = useState(null);
    const [formError, setFormError] = useState('');
    const [formPreview, setFormPreview] = useState(null);
    const formPreviewUrl = formPreview?.url;

    const loadInstructors = useCallback(async () => {
        const [instructorResult, formResult, support] = await Promise.all([
            fetchAllPages(() => supabase
                .from('instructors')
                .select('*')
                .order('created_at', { ascending: false })
                .order('id')),
            supabase
                .from('contract_documents')
                .select('doc_type, display_name, version, sort_order')
                .eq('doc_category', 'form')
                .eq('is_active', true)
                .order('sort_order')
                .order('version', { ascending: false }),
            loadProgressSupport({ includeContracts: isAdmin }),
        ]);

        setInstructors(instructorResult.data || []);
        setUsersById(support.usersById);
        setSignedUserIds(support.signedUserIds);
        setActivationsByUserId(support.activationsByUserId);
        setSupportError(support.supportError);

        const activeByType = new Map();
        (formResult.data || []).forEach((form) => {
            if (!activeByType.has(form.doc_type)) activeByType.set(form.doc_type, form);
        });
        const nextTemplates = [...activeByType.values()];
        setFormTemplates(nextTemplates);
        setSelectedFormType((current) => (
            nextTemplates.some((form) => form.doc_type === current)
                ? current
                : nextTemplates[0]?.doc_type || ''
        ));

        if (instructorResult.error) {
            console.error('讀取講師資料失敗：', instructorResult.error.message);
        }
        if (formResult.error) {
            console.error('讀取自動填表模板失敗：', formResult.error.message);
        }
        setLoading(false);
    }, [isAdmin]);

    useEffect(() => {
        const timer = window.setTimeout(loadInstructors, 0);
        return () => window.clearTimeout(timer);
    }, [loadInstructors]);

    useEffect(() => {
        return () => {
            if (formPreviewUrl) URL.revokeObjectURL(formPreviewUrl);
        };
    }, [formPreviewUrl]);

    const closeFormPreview = useCallback(() => setFormPreview(null), []);
    const applyLinkFilter = (nextFilter) => {
        const nextParams = new URLSearchParams(searchParams);
        if (nextFilter) nextParams.set('claim', nextFilter);
        else nextParams.delete('claim');
        setSearchParams(nextParams, { replace: true });
    };
    const applyProgressFilter = (nextFilter) => {
        const nextParams = new URLSearchParams(searchParams);
        if (nextFilter) nextParams.set('progress', nextFilter);
        else nextParams.delete('progress');
        setSearchParams(nextParams, { replace: true });
    };
    const toggleExpand = async (inst) => {
        if (expandedId === inst.id) {
            setExpandedId(null);
            return;
        }
        setExpandedId(inst.id);

        if (signedUrls[inst.id]) return;

        const urls = {};
        for (const { key } of DOC_KEYS) {
            if (inst[`${key}_path`]) {
                const { data } = await supabase.storage
                    .from('instructor_uploads')
                    .createSignedUrl(inst[`${key}_path`], 3600);
                if (data?.signedUrl) urls[key] = data.signedUrl;
            }
        }
        setSignedUrls(prev => ({ ...prev, [inst.id]: urls }));
    };

    const progressRows = useMemo(
        () => buildProgressRows(instructors, { usersById, signedUserIds, activationsByUserId }),
        [instructors, usersById, signedUserIds, activationsByUserId],
    );
    const progressById = useMemo(
        () => new Map(progressRows.map(({ instructor, progress }) => [instructor.id, progress])),
        [progressRows],
    );
    const progressCounts = useMemo(() => countProgress(progressRows), [progressRows]);
    // 讀不到簽約紀錄時，用「資料已完整」取代「待簽約／已完成」兩顆，避免誤導。
    const contractKnown = signedUserIds !== null;
    // 啟用紀錄（待確認 Email／待信箱驗證的判斷依據）同樣只有管理員讀得到，讀不到就不顯示「待確認 Email」。
    const activationKnown = activationsByUserId !== null;
    const progressChips = [
        { key: '', label: '全部', count: instructors.length },
        { key: PROGRESS_TODO_FILTER, label: '還沒完成', count: progressCounts.todo },
        ...getVisibleProgressStages({ contractKnown, activationKnown })
            .map(stage => ({ key: stage.key, label: stage.label, count: progressCounts.byKey[stage.key] || 0 })),
    ];
    const progressFilter = progressChips.some(chip => chip.key === progressFilterParam) ? progressFilterParam : '';
    const loginEmailOf = (inst) => (inst.user_id ? usersById?.get(inst.user_id)?.email || null : null);

    const filtered = instructors.filter(i => {
        if (progressFilter && !matchesProgressFilter(progressById.get(i.id), progressFilter)) return false;
        if (statusFilter && i.employment_status !== statusFilter) return false;
        if (roleFilter && i.instructor_role !== roleFilter) return false;
        if (speedFilter === 'none' && i.speed_qualification) return false;
        if (speedFilter && speedFilter !== 'none' && i.speed_qualification !== speedFilter) return false;
        if (linkFilter === 'linked' && !i.user_id) return false;
        if (linkFilter === 'unlinked' && i.user_id) return false;
        if (search) {
            const s = search.toLowerCase();
            return i.full_name?.toLowerCase().includes(s)
                || i.email_primary?.toLowerCase().includes(s)
                || loginEmailOf(i)?.toLowerCase().includes(s)
                || i.phone_mobile?.includes(search);
        }
        return true;
    });

    const statusCounts = STATUS_OPTIONS.reduce((acc, s) => {
        acc[s.key] = instructors.filter(i => i.employment_status === s.key).length;
        return acc;
    }, {});
    const linkedCount = instructors.filter(i => i.user_id).length;
    const unlinkedCount = instructors.length - linkedCount;

    const docCount = (inst) => REQUIRED_PROFILE_DOCUMENTS.filter(({ key }) => (
        hasInstructorDocument(inst, key)
    )).length;

    const handleRoleChange = async (inst, newRole) => {
        const { error } = await supabase
            .from('instructors')
            .update({ instructor_role: newRole || null })
            .eq('id', inst.id);
        if (error) {
            alert('講師等級變更失敗:' + error.message);
            return;
        }
        setInstructors(prev => prev.map(i =>
            i.id === inst.id ? { ...i, instructor_role: newRole || null } : i
        ));
    };

    const handleUnlink = async (inst) => {
        const confirmText = inst.name_slot
            ? `確定要解除 ${inst.full_name} 的帳號認領嗎?\n${NAME_SLOT_UNLINK_HINT}。\n（這個空位若已被填入個資，之後就不能只靠姓名認領，要改用姓名＋手機＋身分證末四碼核對。）`
            : `確定要解除 ${inst.full_name} 的帳號認領嗎?\n解綁後，同一 Email 的 Google 帳號下次登入會再次自動認領這筆主檔。`;
        if (!confirm(confirmText)) return;
        const { error } = await supabase.rpc('admin_unlink_instructor', { target_instructor_id: inst.id });
        if (error) {
            alert('解綁失敗:' + error.message);
            return;
        }
        await loadInstructors();
    };

    const handleEmailConfirmed = async (confirmedEmail) => {
        const name = confirmingInst?.full_name || '';
        setConfirmingInst(null);
        setNotice(`已登錄 ${name} 的已確認 Email：${confirmedEmail}。`);
        await loadInstructors();
    };

    // 刪除「只填姓名、還沒人認領、沒有任何資料」的空位（打錯字或誤建時用）。
    // 查詢條件本身再鎖一次 name_slot／未認領，即使畫面狀態過期也刪不到已被認領或有資料的主檔。
    const handleDeleteSlot = async (inst) => {
        if (!isPristineNameSlot(inst)) return;
        if (!confirm(`確定要刪除空位「${inst.full_name}」嗎?\n這個空位還沒有人認領，也沒有任何資料；刪除後無法復原。`)) return;
        const { data, error } = await supabase
            .from('instructors')
            .delete()
            .eq('id', inst.id)
            .eq('name_slot', true)
            .is('user_id', null)
            .select('id');
        if (error) {
            alert('刪除空位失敗:' + error.message);
            return;
        }
        if (!data?.length) {
            alert('沒有刪除任何資料：這個空位可能剛被認領或已被刪除，請重新整理確認。');
        } else {
            setNotice(`已刪除空位「${inst.full_name}」。`);
        }
        await loadInstructors();
    };

    const handlePreviewForm = async (inst) => {
        if (!selectedFormType) {
            setFormError('尚未設定可預覽的表單模板，請先至表單預覽與下載完成設定。');
            return;
        }

        setGeneratingFor(inst.id);
        setFormError('');
        try {
            const { data: latestInstructor, error: latestError } = await supabase
                .from('instructors')
                .select('*')
                .eq('id', inst.id)
                .single();
            if (latestError) throw latestError;

            const { docMeta, positions } = await loadFormTemplate(selectedFormType);
            const bytes = await generateFilledForm({ docMeta, positions, instructor: latestInstructor });
            const safeName = (latestInstructor.full_name || 'unknown').replace(/[/\\?%*:|"<>]/g, '_');
            const filename = `${safeName}-${docMeta.display_name || selectedFormType}.pdf`;
            const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
            setFormPreview({
                url,
                bytes,
                filename,
                audit: {
                    targetUserId: latestInstructor.user_id || null,
                    targetInstructorId: latestInstructor.id,
                    docType: docMeta.doc_type,
                    docVersion: docMeta.version,
                },
            });
        } catch (error) {
            setFormError(`${inst.full_name || '此講師'}的表單預覽產生失敗：${error.message}`);
        } finally {
            setGeneratingFor(null);
        }
    };

    const handleDownloadPreview = async () => {
        if (!formPreview) return;

        const anchor = document.createElement('a');
        anchor.href = formPreview.url;
        anchor.download = formPreview.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();

        const { error: auditError } = await supabase.from('instructor_form_downloads').insert({
            downloaded_by: user.id,
            target_user_id: formPreview.audit.targetUserId,
            target_instructor_id: formPreview.audit.targetInstructorId,
            doc_type: formPreview.audit.docType,
            doc_version: formPreview.audit.docVersion,
        });
        if (auditError) {
            console.error('寫入表單下載紀錄失敗：', auditError.message);
        }
    };

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold">載入中...</div>;

    return (
        <div className="p-4 sm:p-8">
            <div className="flex items-start sm:items-center justify-between mb-8 gap-3 flex-col sm:flex-row">
                <div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">講師資料總覽</h1>
                    <p className="text-bauhaus-black/60 mt-1 font-medium">
                        共 {instructors.length} 位 ・ <span className="text-bauhaus-blue font-bold">{linkedCount}</span> 位已認領 ・ <span className="text-bauhaus-black/60 font-bold">{unlinkedCount}</span> 位未認領
                    </p>
                </div>
                {isAdmin && (
                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            onClick={() => setShowAddModal(true)}
                            className="bh-btn bh-btn-blue px-4 py-2.5"
                        >
                            <Plus className="w-4 h-4" /> 新增講師
                        </button>
                    </div>
                )}
            </div>

            <div className="mb-6 border-2 lg:border-4 border-bauhaus-black rounded-2xl bg-white p-4 shadow-hard flex flex-col lg:flex-row lg:items-center gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-lg border-2 border-bauhaus-black bg-bauhaus-blue text-white flex items-center justify-center shrink-0">
                        <FileText className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="font-black text-bauhaus-black">講師資料自動填表</h2>
                        <p className="text-sm text-bauhaus-black/60 font-medium mt-0.5">
                            選擇表單後，可先預覽即時帶入的最新資料與文件，確認後再下載 PDF。
                        </p>
                    </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto">
                    <select
                        value={selectedFormType}
                        onChange={(event) => setSelectedFormType(event.target.value)}
                        disabled={formTemplates.length === 0}
                        className="bh-input min-h-[44px] text-sm sm:min-w-52 disabled:bg-bauhaus-muted disabled:text-bauhaus-black/50"
                        aria-label="選擇自動填表模板"
                    >
                        {formTemplates.length === 0 ? (
                            <option value="">尚無可用表單</option>
                        ) : (
                            formTemplates.map((form) => (
                                <option key={form.doc_type} value={form.doc_type}>
                                    {form.display_name || form.doc_type}
                                </option>
                            ))
                        )}
                    </select>
                    <Link to="/admin/download-center" className="bh-btn bh-btn-outline px-4 py-2.5 text-sm whitespace-nowrap">
                        <Settings className="w-4 h-4" /> 管理表單
                    </Link>
                </div>
            </div>

            {formError && (
                <div role="alert" className="mb-6 bg-bauhaus-red text-white border-2 border-bauhaus-black rounded-xl px-4 py-3 text-sm font-bold flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>{formError}</span>
                </div>
            )}

            {notice && (
                <div role="status" className="mb-6 bg-bauhaus-blue/10 text-bauhaus-black border-2 border-bauhaus-blue rounded-xl px-4 py-3 text-sm font-bold flex items-start gap-2">
                    <Check className="w-4 h-4 mt-0.5 shrink-0 text-bauhaus-blue" />
                    <span className="flex-1">{notice}</span>
                    <button type="button" onClick={() => setNotice('')} className="text-bauhaus-black/50 hover:text-bauhaus-black" aria-label="關閉通知">
                        <X className="w-4 h-4" />
                    </button>
                </div>
            )}

            {supportError && (
                <div role="alert" className="mb-6 bg-bauhaus-yellow text-bauhaus-black border-2 border-bauhaus-black rounded-xl px-4 py-3 text-sm font-bold flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>部分進度資訊暫時讀不到（登入帳號或簽約紀錄），資料進度標籤可能不完整，請稍後重新整理。</span>
                </div>
            )}

            <div className="relative mb-3">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-bauhaus-black/40" />
                <input
                    type="text"
                    placeholder="搜尋姓名、Email 或手機號碼⋯⋯"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="bh-input pl-12 py-3"
                />
            </div>

            <div role="group" aria-label="資料進度篩選" className="flex flex-wrap items-center gap-2 mb-3">
                <span className="inline-flex items-center gap-1 text-xs font-black text-bauhaus-black/60 mr-1">
                    <ListChecks className="w-4 h-4" /> 資料進度
                </span>
                {progressChips.map(chip => {
                    const active = progressFilter === chip.key;
                    return (
                        <button
                            key={chip.key || 'all'}
                            type="button"
                            onClick={() => applyProgressFilter(chip.key)}
                            aria-pressed={active}
                            data-progress-filter={chip.key || 'all'}
                            className={`bh-chip transition-colors min-h-[44px] ${
                                active
                                    ? (PROGRESS_STYLES[chip.key] || 'bg-bauhaus-black text-white')
                                    : 'bg-white text-bauhaus-black/60 hover:bg-bauhaus-muted'
                            }`}
                        >
                            {chip.label} {chip.count}
                        </button>
                    );
                })}
            </div>
            {!contractKnown && (
                <p className="text-xs font-medium text-bauhaus-black/50 mb-3">
                    {isAdmin
                        ? '簽約紀錄暫時讀不到，所以「待簽約」「已完成」先合併顯示為「資料已完整」。'
                        : '簽約狀態只有管理員看得到，所以資料完整的老師顯示為「資料已完整」。'}
                </p>
            )}

            <div role="group" aria-label="帳號綁定篩選" className="flex flex-wrap items-center gap-2 mb-3">
                <span className="inline-flex items-center gap-1 text-xs font-black text-bauhaus-black/60 mr-1">
                    <Link2 className="w-4 h-4" /> 帳號綁定
                </span>
                {LINK_FILTERS.map(f => {
                    const count = f.key === '' ? instructors.length : f.key === 'linked' ? linkedCount : unlinkedCount;
                    const active = linkFilter === f.key;
                    return (
                        <button
                            key={f.key || 'all'}
                            onClick={() => applyLinkFilter(f.key)}
                            aria-pressed={active}
                            className={`bh-chip transition-colors min-h-[44px] ${
                                active ? f.color : 'bg-white text-bauhaus-black/60 hover:bg-bauhaus-muted'
                            }`}
                        >
                            {f.label} {count}
                        </button>
                    );
                })}
            </div>

            <div className="flex flex-wrap gap-2 mb-6">
                <button
                    onClick={() => setStatusFilter('')}
                    className={`bh-chip transition-colors min-h-[44px] ${
                        !statusFilter ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black/60 hover:bg-bauhaus-muted'
                    }`}
                >
                    全部狀態
                </button>
                {STATUS_OPTIONS.map(s => (
                    <button
                        key={s.key}
                        onClick={() => setStatusFilter(statusFilter === s.key ? '' : s.key)}
                        className={`bh-chip transition-colors min-h-[44px] ${
                            statusFilter === s.key
                                ? `${s.color}`
                                : 'bg-white text-bauhaus-black/60 hover:bg-bauhaus-muted'
                        }`}
                    >
                        {s.label} {statusCounts[s.key] || 0}
                    </button>
                ))}
                <div className="border-l-2 border-bauhaus-black/20 mx-2"></div>
                <select
                    value={roleFilter}
                    onChange={e => setRoleFilter(e.target.value)}
                    className="bh-chip bg-white text-bauhaus-black cursor-pointer hover:bg-bauhaus-muted outline-none"
                >
                    <option value="">全部等級</option>
                    {Object.entries(ROLE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                    ))}
                </select>
                <select
                    value={speedFilter}
                    onChange={e => setSpeedFilter(e.target.value)}
                    className="bh-chip bg-white text-bauhaus-black cursor-pointer hover:bg-bauhaus-muted outline-none"
                >
                    <option value="">全部速解資格</option>
                    <option value="none">未取得</option>
                    {Object.entries(SPEED_QUALIFICATION_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                    ))}
                </select>
            </div>

            <div className="block lg:hidden space-y-3">
                {filtered.length === 0 ? (
                    <div className="bh-card p-8 text-center text-bauhaus-black/50">
                        {search ? '找不到符合的講師' : '尚無講師資料'}
                    </div>
                ) : (
                    filtered.map(inst => (
                        <InstructorCard
                            key={inst.id}
                            inst={inst}
                            expanded={expandedId === inst.id}
                            onToggle={() => toggleExpand(inst)}
                            urls={signedUrls[inst.id] || {}}
                            docCount={docCount(inst)}
                            progress={progressById.get(inst.id)}
                            loginEmail={loginEmailOf(inst)}
                            isAdmin={isAdmin}
                            onRoleChange={(newRole) => handleRoleChange(inst, newRole)}
                            onUnlink={() => handleUnlink(inst)}
                            onLink={() => setLinkingInst(inst)}
                            onConfirmEmail={() => setConfirmingInst(inst)}
                            onDeleteSlot={() => handleDeleteSlot(inst)}
                            onPreview={() => handlePreviewForm(inst)}
                            previewDisabled={!selectedFormType || generatingFor !== null}
                            previewing={generatingFor === inst.id}
                        />
                    ))
                )}
            </div>

            {/* 欄位多（8 欄），1024px 以下塞不下（標籤會被擠成直排），所以表格從 lg 起才顯示，以下用卡片；
                外框用 overflow-x-auto，萬一還是太擠也只會出現橫向捲軸，不會把最右邊的按鈕切掉 */}
            <div className="hidden lg:block bh-card overflow-x-auto">
                <table className="w-full text-left">
                    <thead className="bg-bauhaus-black text-white text-xs font-bold uppercase tracking-wider whitespace-nowrap">
                        <tr>
                            {/* 「講師」以外的欄寬度剛好包住內容（w-px），螢幕多出來的寬度都給「講師」欄，欄距才不會忽寬忽窄 */}
                            <th className={CELL_X}>講師</th>
                            <th className={`${CELL_X} w-px`}>綁定</th>
                            <th className={`${CELL_X} w-px`}>資料進度</th>
                            <th className={`${CELL_X} w-px`}>等級</th>
                            <th className={`${CELL_X} w-px`}>速解資格</th>
                            <th className={`${CELL_X} w-px`}>地區</th>
                            <th className={`${CELL_X} w-px`}>文件</th>
                            <th className={`${CELL_X} w-px`}>操作</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y-2 divide-bauhaus-black/20">
                        {filtered.map(inst => (
                            <InstructorRow
                                key={inst.id}
                                inst={inst}
                                expanded={expandedId === inst.id}
                                onToggle={() => toggleExpand(inst)}
                                urls={signedUrls[inst.id] || {}}
                                docCount={docCount(inst)}
                                progress={progressById.get(inst.id)}
                                loginEmail={loginEmailOf(inst)}
                                isAdmin={isAdmin}
                                onRoleChange={(newRole) => handleRoleChange(inst, newRole)}
                                onUnlink={() => handleUnlink(inst)}
                                onLink={() => setLinkingInst(inst)}
                                onConfirmEmail={() => setConfirmingInst(inst)}
                                onDeleteSlot={() => handleDeleteSlot(inst)}
                                onPreview={() => handlePreviewForm(inst)}
                                previewDisabled={!selectedFormType || generatingFor !== null}
                                previewing={generatingFor === inst.id}
                            />
                        ))}
                        {filtered.length === 0 && (
                            <tr>
                                <td colSpan={TABLE_COLS} className="px-6 py-12 text-center text-bauhaus-black/50">
                                    {search ? '找不到符合的講師' : '尚無講師資料'}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {showAddModal && (
                <AddInstructorModal
                    instructors={instructors}
                    onClose={() => setShowAddModal(false)}
                    onCreated={(message) => {
                        setShowAddModal(false);
                        if (message) setNotice(message);
                        loadInstructors();
                    }}
                />
            )}

            {confirmingInst && (
                <ConfirmInstructorEmailModal
                    inst={confirmingInst}
                    onClose={() => setConfirmingInst(null)}
                    onConfirmed={handleEmailConfirmed}
                />
            )}

            {linkingInst && (
                <LinkInstructorModal
                    inst={linkingInst}
                    onClose={() => setLinkingInst(null)}
                    onLinked={() => { setLinkingInst(null); loadInstructors(); }}
                />
            )}

            {formPreview && (
                <FilledFormPreviewModal
                    preview={formPreview}
                    onClose={closeFormPreview}
                    onDownload={handleDownloadPreview}
                />
            )}
        </div>
    );
};

// ───────────────────────────────────────────────────────────────
// 綁定狀態徽章
// ───────────────────────────────────────────────────────────────
const LinkBadge = ({ userId }) => (
    userId ? (
        <span className="bh-chip bg-bauhaus-blue text-white whitespace-nowrap">
            <Check className="w-3 h-3" /> 已認領
        </span>
    ) : (
        <span className="bh-chip bg-bauhaus-muted text-bauhaus-black whitespace-nowrap">
            未認領
        </span>
    )
);

// 「姓名認領」：管理員只填姓名建立的空位，被老師輸入姓名認領後綁定
const isClaimedNameSlot = (inst) => Boolean(inst.name_slot && inst.user_id);

const NameSlotBadge = ({ inst }) => (
    isClaimedNameSlot(inst) ? (
        <span className="bh-chip bg-white text-bauhaus-black whitespace-nowrap" title="管理員只填姓名建立的空位，由老師輸入姓名認領">
            姓名認領
        </span>
    ) : null
);

const NameSlotUnlinkHint = ({ inst, isAdmin }) => (
    isAdmin && isClaimedNameSlot(inst) ? (
        <p className="text-[11px] leading-snug font-medium text-bauhaus-black/60" data-testid="name-slot-unlink-hint">{NAME_SLOT_UNLINK_HINT}</p>
    ) : null
);

// 已綁定的列顯示對方實際登入的 Google Email（與主檔 Email 相同時不重複顯示）。
// truncate＝表格版：和主檔 Email 同樣單行截斷、滑過去看全文，列高才不會被撐開；卡片版完整換行顯示。
const LoginEmailLine = ({ loginEmail, primaryEmail, truncate = false }) => (
    loginEmail && loginEmail.toLowerCase() !== (primaryEmail || '').toLowerCase() ? (
        <div
            className={`text-xs text-bauhaus-black/60 mt-0.5 ${truncate ? 'truncate w-0 min-w-full' : 'break-all'}`}
            title={truncate ? `Google 登入：${loginEmail}` : undefined}
            data-testid="login-email"
        >
            Google 登入：{loginEmail}
        </div>
    ) : null
);

const ProgressBadge = ({ progress }) => {
    if (!progress) return null;
    const showMissing = ['incomplete', 'pending_review', 'awaiting_email_confirm', 'awaiting_email_verify'].includes(progress.key)
        && progress.missingCount > 0;
    const title = progress.missingItems.length && progress.key !== 'disabled'
        ? `${progress.description}\n還缺：${progress.missingItems.join('、')}`
        : progress.description;
    return (
        <span className="inline-flex flex-col items-start gap-1" title={title} data-progress={progress.key}>
            <span className={`bh-chip whitespace-nowrap ${PROGRESS_STYLES[progress.key] || 'bg-white text-bauhaus-black'}`}>
                {progress.label}
            </span>
            {showMissing && (
                <span className="text-[11px] font-bold text-bauhaus-red whitespace-nowrap">缺 {progress.missingCount} 項</span>
            )}
        </span>
    );
};

// ───────────────────────────────────────────────────────────────
// 展開內容
// ───────────────────────────────────────────────────────────────
const InstructorExpandedContent = ({ inst, urls, progress, isAdmin, onConfirmEmail }) => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-3">
            <h3 className="bh-label">Email 確認</h3>
            <InstructorEmailConfirmation inst={inst} isAdmin={isAdmin} onConfirmEmail={onConfirmEmail} />
            <div className="pt-1" />
            {progress && (
                <>
                    <h3 className="bh-label">資料進度</h3>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <ProgressBadge progress={progress} />
                        <span className="text-bauhaus-black/60">{progress.description}</span>
                    </div>
                    {progress.key !== 'disabled' && progress.missingItems.length > 0 && (
                        <p className="text-xs font-bold text-bauhaus-red leading-relaxed">
                            還缺 {progress.missingCount} 項：{progress.missingItems.join('、')}
                        </p>
                    )}
                    <div className="pt-1" />
                </>
            )}
            <h3 className="bh-label">基本資料</h3>
            <InfoRow label="出生年月日" value={inst.birth_date} />
            <InfoRow label="身分證字號" value={inst.id_number ? '••••••' + inst.id_number.slice(-4) : null} />
            <InfoRow label="手機" value={inst.phone_mobile} />
            <InfoRow label="家電" value={inst.phone_home} />
            <InfoRow label="Line ID" value={inst.line_id} />
            <InfoRow label="Line 名字" value={inst.line_name} />
            <InfoRow label="地址" value={inst.address} />
            <InfoRow label="備用 Email" value={inst.email_secondary} />
            <InfoRow label="衣服尺寸" value={inst.shirt_size} />
            <InfoRow label="就讀學校" value={inst.school_info} />
            {inst.facebook_url && (
                <InfoRow
                    label="Facebook"
                    value={<a href={inst.facebook_url} target="_blank" rel="noopener noreferrer" className="text-bauhaus-blue hover:underline inline-flex items-center gap-1">連結 <ExternalLink className="w-3 h-3" /></a>}
                />
            )}

            <h3 className="bh-label pt-3">教學資訊</h3>
            <InfoRow label="接課頻率(學期)" value={inst.teaching_freq_semester} />
            <InfoRow label="接課頻率(寒暑假)" value={inst.teaching_freq_vacation} />
            <div>
                <span className="text-xs text-bauhaus-black/40">接課地區:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                    {inst.teaching_regions?.length ? (
                        inst.teaching_regions.map(r => (
                            <span key={r} className="bh-chip bg-white text-bauhaus-black">{r}</span>
                        ))
                    ) : inst.teaching_regions_raw ? (
                        <span className="text-xs text-bauhaus-black/50 italic">{inst.teaching_regions_raw}(未對應到縣市)</span>
                    ) : (
                        <span className="text-xs text-bauhaus-black/30">—</span>
                    )}
                </div>
            </div>

            {(inst.bio_personal_experience || inst.bio_teaching_experience || inst.teaching_philosophy || inst.bio_notes) && (
                <>
                    <h3 className="bh-label pt-3">經歷 / 理念</h3>
                    {inst.bio_personal_experience && <BioBlock label="個人經歷" text={inst.bio_personal_experience} />}
                    {inst.bio_teaching_experience && <BioBlock label="授課經驗" text={inst.bio_teaching_experience} />}
                    {inst.teaching_philosophy && <BioBlock label="教學理念" text={inst.teaching_philosophy} />}
                    {inst.bio_notes && <BioBlock label="備註" text={inst.bio_notes} />}
                </>
            )}

            {(inst.bank_info_raw || inst.note_to_team || inst.note_internal) && (
                <>
                    <h3 className="bh-label pt-3">其他</h3>
                    <InfoRow label="匯款帳戶" value={inst.bank_info_raw} />
                    <InfoRow label="想對團隊說" value={inst.note_to_team} />
                    {inst.note_internal && (
                        <div className="bg-bauhaus-red/10 border-2 border-bauhaus-red rounded-xl px-3 py-2 mt-2">
                            <div className="text-xs font-bold text-bauhaus-red mb-0.5">內部備註</div>
                            <div className="text-xs text-bauhaus-black whitespace-pre-wrap">{inst.note_internal}</div>
                        </div>
                    )}
                </>
            )}
        </div>

        <div>
            <h3 className="bh-label mb-3">上傳文件</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {DOC_KEYS.map(({ key, label }) => {
                    const externalUrl = inst[`${key}_external_url`];
                    const storageUrl = urls[key];
                    return (
                        <div key={key} className="border-2 border-bauhaus-black rounded-xl p-3">
                            <div className="text-xs font-bold text-bauhaus-black/60 mb-2">{label}</div>
                            {storageUrl ? (
                                <a href={storageUrl} target="_blank" rel="noopener noreferrer" className="block group">
                                    <img src={storageUrl} alt={label} className="w-full h-24 object-cover border-2 border-bauhaus-black" />
                                    <div className="flex items-center gap-1 text-xs text-bauhaus-blue mt-1 group-hover:underline">
                                        <ExternalLink className="w-3 h-3" /> 開啟原圖
                                    </div>
                                </a>
                            ) : externalUrl ? (
                                <a href={externalUrl} target="_blank" rel="noopener noreferrer"
                                    className="block group w-full h-24 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl flex flex-col items-center justify-center gap-1 hover:bg-bauhaus-yellow/80 transition-colors">
                                    <ExternalLink className="w-5 h-5 text-bauhaus-black" />
                                    <span className="text-xs font-bold text-bauhaus-black">Google Drive</span>
                                    <span className="text-[10px] text-bauhaus-black/70 group-hover:underline">點擊開啟</span>
                                </a>
                            ) : (
                                <div className="w-full h-24 bg-bauhaus-muted border-2 border-bauhaus-black/20 rounded-xl flex items-center justify-center text-xs text-bauhaus-black/40">
                                    未上傳
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    </div>
);

const StatusBadge = ({ status }) => {
    if (!status) return <span className="text-xs text-bauhaus-black/30">—</span>;
    const s = STATUS_MAP[status];
    if (!s) return <span className="text-xs text-bauhaus-black/40">{status}</span>;
    return (
        <span className={`bh-chip whitespace-nowrap ${s.color}`}>
            {s.label}
        </span>
    );
};

const BioBlock = ({ label, text }) => (
    <div className="mt-2">
        <div className="text-xs text-bauhaus-black/40 mb-0.5">{label}</div>
        <p className="text-sm text-bauhaus-black/80 whitespace-pre-wrap leading-relaxed">{text}</p>
    </div>
);

const InstructorCard = ({ inst, expanded, onToggle, urls, docCount, progress, loginEmail, isAdmin, onRoleChange, onUnlink, onLink, onConfirmEmail, onDeleteSlot, onPreview, previewDisabled, previewing }) => (
    <div className="bh-card overflow-hidden">
        <div
            className="p-4 flex items-start gap-3 cursor-pointer hover:bg-bauhaus-cream transition-colors"
            onClick={onToggle}
        >
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-bauhaus-black truncate">{inst.full_name}</span>
                    {inst.gender && (
                        <span className="bh-chip bg-bauhaus-muted text-bauhaus-black shrink-0">{inst.gender}</span>
                    )}
                </div>
                <div className="text-sm text-bauhaus-black/60 mt-0.5 truncate">{inst.email_primary}</div>
                <LoginEmailLine loginEmail={loginEmail} primaryEmail={inst.email_primary} />
                <div className="flex flex-wrap items-center gap-1.5 mt-2" onClick={e => e.stopPropagation()}>
                    <ProgressBadge progress={progress} />
                    <StatusBadge status={inst.employment_status} />
                    <LinkBadge userId={inst.user_id} />
                    <NameSlotBadge inst={inst} />
                    {isAdmin && (
                        inst.user_id ? (
                            <button onClick={onUnlink} title={inst.name_slot ? NAME_SLOT_UNLINK_HINT : '解除綁定'} className="text-xs font-bold text-bauhaus-red hover:underline">解綁</button>
                        ) : (
                            <button onClick={onLink} className="text-xs font-bold text-bauhaus-blue hover:underline">綁定</button>
                        )
                    )}
                    {isAdmin ? (
                        <select
                            value={inst.instructor_role || ''}
                            onChange={e => onRoleChange(e.target.value)}
                            className={`bh-chip border-0 outline-none cursor-pointer ${
                                inst.instructor_role ? 'bg-bauhaus-black text-white' : 'bg-bauhaus-muted text-bauhaus-black'
                            }`}
                        >
                            <option value="">未設定</option>
                            {Object.entries(ROLE_LABELS).map(([k, v]) => (
                                <option key={k} value={k}>{v}</option>
                            ))}
                        </select>
                    ) : inst.instructor_role ? (
                        <span className="bh-chip bg-bauhaus-black text-white">
                            {ROLE_LABELS[inst.instructor_role] || inst.instructor_role}
                        </span>
                    ) : (
                        <span className="text-xs text-bauhaus-black/40">未設定</span>
                    )}
                    <SpeedQualificationBadge value={inst.speed_qualification} />
                    <RegionSummary inst={inst} />
                    <span className={`bh-chip whitespace-nowrap ${docCount === REQUIRED_PROFILE_DOCUMENTS.length ? 'bg-bauhaus-blue text-white' : docCount > 0 ? 'bg-bauhaus-yellow text-bauhaus-black' : 'bg-bauhaus-muted text-bauhaus-black/50'}`}>
                        <FileImage className="w-3 h-3" />
                        {docCount}/{REQUIRED_PROFILE_DOCUMENTS.length}
                    </span>
                </div>
                {/* 按鈕獨立一行，每張卡片的按鈕位置才會對齊 */}
                <div className="flex flex-wrap items-center gap-2 mt-3" onClick={e => e.stopPropagation()}>
                    {isAdmin && (
                        <Link
                            to={`/admin/instructors/${inst.id}/edit`}
                            className="bh-btn bh-btn-blue px-3 py-2 text-xs"
                        >
                            <Pencil className="w-3.5 h-3.5" /> 編輯資料
                        </Link>
                    )}
                    <button
                        type="button"
                        onClick={onPreview}
                        disabled={previewDisabled}
                        className="bh-btn bh-btn-outline px-3 py-2 text-xs disabled:opacity-40"
                    >
                        {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                        {previewing ? '產生預覽' : '預覽表單'}
                    </button>
                    {isAdmin && (
                        <button
                            type="button"
                            onClick={onConfirmEmail}
                            data-testid="confirm-email-button"
                            className="bh-btn bh-btn-outline min-h-[44px] px-3 py-2 text-xs"
                        >
                            <Mail className="w-3.5 h-3.5" /> {hasConfirmedEmail(inst) ? '已確認 Email' : '確認 Email'}
                        </button>
                    )}
                    {isAdmin && isPristineNameSlot(inst) && (
                        <button type="button" onClick={onDeleteSlot} className="text-xs font-bold text-bauhaus-red hover:underline">刪除空位</button>
                    )}
                </div>
                <div className="mt-1.5" onClick={e => e.stopPropagation()}>
                    <NameSlotUnlinkHint inst={inst} isAdmin={isAdmin} />
                </div>
            </div>
            <button className="shrink-0 text-bauhaus-black/40 hover:text-bauhaus-black transition-colors p-1">
                {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
        </div>
        {expanded && (
            <div className="px-4 pb-4 pt-0 bg-bauhaus-cream border-t-2 border-bauhaus-black">
                <InstructorExpandedContent inst={inst} urls={urls} progress={progress} isAdmin={isAdmin} onConfirmEmail={onConfirmEmail} />
            </div>
        )}
    </div>
);

const InstructorRow = ({ inst, expanded, onToggle, urls, docCount, progress, loginEmail, isAdmin, onRoleChange, onUnlink, onLink, onConfirmEmail, onDeleteSlot, onPreview, previewDisabled, previewing }) => (
    <>
        <tr className="hover:bg-bauhaus-cream transition-colors cursor-pointer" onClick={onToggle}>
            {/* 姓名＋任職狀態一行、Email 在下面一行（Email 太長就截斷，滑過去看全文），省下一整欄；
                已綁定且登入的 Google Email 和主檔 Email 不同時，再多一行顯示登入用的 Google Email。
                Email 行用 w-0 min-w-full：不撐開欄寬，欄寬由「講師」欄吃剩下的空間決定，空間不夠就多截一點 */}
            <td className={CELL_X}>
                <div className="flex items-center gap-2">
                    <span className="font-bold text-bauhaus-black whitespace-nowrap">{inst.full_name}</span>
                    <StatusBadge status={inst.employment_status} />
                </div>
                <div
                    className="mt-1 text-xs text-bauhaus-black/60 truncate w-0 min-w-full"
                    title={inst.email_primary || undefined}
                >
                    {inst.email_primary || <span className="text-bauhaus-black/30">—</span>}
                </div>
                <LoginEmailLine loginEmail={loginEmail} primaryEmail={inst.email_primary} truncate />
            </td>
            <td className={CELL_X} onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2">
                    <LinkBadge userId={inst.user_id} />
                    {isAdmin && (
                        inst.user_id ? (
                            <button onClick={onUnlink} title={inst.name_slot ? NAME_SLOT_UNLINK_HINT : '解除綁定'} aria-label="解除綁定" className="text-bauhaus-red/70 hover:text-bauhaus-red transition-colors">
                                <Unlink className="w-3.5 h-3.5" />
                            </button>
                        ) : (
                            <button onClick={onLink} title="手動綁定" aria-label="手動綁定" className="text-bauhaus-blue/70 hover:text-bauhaus-blue transition-colors">
                                <Link2 className="w-3.5 h-3.5" />
                            </button>
                        )
                    )}
                    {isAdmin && (
                        <button
                            type="button"
                            onClick={onConfirmEmail}
                            data-testid="confirm-email-button"
                            title={hasConfirmedEmail(inst) ? `已確認 Email：${inst.confirmed_email}（點擊更改）` : '確認 Email（老師要先有已確認的 Email 才能啟用帳號）'}
                            aria-label="確認 Email"
                            className={`transition-colors ${hasConfirmedEmail(inst) ? 'text-bauhaus-black/40 hover:text-bauhaus-black' : 'text-bauhaus-red/70 hover:text-bauhaus-red'}`}
                        >
                            <Mail className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
                {/* 「姓名認領」標籤、刪除空位、解除綁定說明都疊在下面，不跟「已認領」併排，才不會把剛好包住內容的綁定欄撐寬；
                    說明文字 w-0 min-w-full：跟著欄寬換行，不影響欄寬 */}
                {isClaimedNameSlot(inst) && (
                    <div className="mt-1"><NameSlotBadge inst={inst} /></div>
                )}
                {isAdmin && isPristineNameSlot(inst) && (
                    <button
                        type="button"
                        onClick={onDeleteSlot}
                        className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-bauhaus-red hover:underline whitespace-nowrap"
                    >
                        <Trash2 className="w-3.5 h-3.5" /> 刪除空位
                    </button>
                )}
                {isAdmin && isClaimedNameSlot(inst) && (
                    <div className="mt-1 w-0 min-w-full"><NameSlotUnlinkHint inst={inst} isAdmin={isAdmin} /></div>
                )}
            </td>
            <td className={CELL_X} onClick={e => e.stopPropagation()}>
                <ProgressBadge progress={progress} />
            </td>
            <td className={CELL_X} onClick={e => e.stopPropagation()}>
                {isAdmin ? (
                    <select
                        value={inst.instructor_role || ''}
                        onChange={e => onRoleChange(e.target.value)}
                        aria-label={`${inst.full_name} 的等級`}
                        className={`bh-chip border-0 outline-none cursor-pointer ${
                            inst.instructor_role ? 'bg-bauhaus-black text-white' : 'bg-bauhaus-muted text-bauhaus-black'
                        }`}
                    >
                        <option value="">未設定</option>
                        {Object.entries(ROLE_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                        ))}
                    </select>
                ) : inst.instructor_role ? (
                    <span className="bh-chip bg-bauhaus-black text-white whitespace-nowrap">
                        {ROLE_LABELS[inst.instructor_role] || inst.instructor_role}
                    </span>
                ) : (
                    <span className="text-xs text-bauhaus-black/40 whitespace-nowrap">未設定</span>
                )}
            </td>
            <td className={CELL_X} onClick={e => e.stopPropagation()}>
                <SpeedQualificationBadge value={inst.speed_qualification} />
            </td>
            <td className={CELL_X}>
                <RegionSummary inst={inst} compact />
            </td>
            <td className={CELL_X}>
                <span className={`bh-chip whitespace-nowrap ${docCount === REQUIRED_PROFILE_DOCUMENTS.length ? 'bg-bauhaus-blue text-white' : docCount > 0 ? 'bg-bauhaus-yellow text-bauhaus-black' : 'bg-bauhaus-muted text-bauhaus-black/50'}`}>
                    <FileImage className="w-3 h-3" />
                    {docCount}/{REQUIRED_PROFILE_DOCUMENTS.length}
                </span>
            </td>
            {/* 1024–1279px 按鈕只寫「編輯／預覽」，1280px 以上才顯示完整文字；aria-label 固定是完整名稱 */}
            <td className={CELL_X}>
                <div className="flex items-center gap-1.5 xl:gap-2" onClick={e => e.stopPropagation()}>
                    {isAdmin && (
                        <Link
                            to={`/admin/instructors/${inst.id}/edit`}
                            aria-label="編輯資料"
                            className="bh-btn bh-btn-blue px-2.5 xl:px-3 py-2 text-xs whitespace-nowrap"
                        >
                            <Pencil className="w-3.5 h-3.5" /><span>編輯<span className="hidden xl:inline">資料</span></span>
                        </Link>
                    )}
                    <button
                        type="button"
                        onClick={onPreview}
                        disabled={previewDisabled}
                        aria-label={previewing ? '產生預覽' : '預覽表單'}
                        className="bh-btn bh-btn-outline px-2.5 xl:px-3 py-2 text-xs whitespace-nowrap disabled:opacity-40"
                    >
                        {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                        <span>{previewing ? '產生' : '預覽'}<span className="hidden xl:inline">{previewing ? '預覽' : '表單'}</span></span>
                    </button>
                    <button type="button" onClick={onToggle} className="p-1.5 xl:p-2 text-bauhaus-black/40 hover:text-bauhaus-black transition-colors" aria-label={expanded ? '收合講師資料' : '展開講師資料'}>
                        {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                    </button>
                </div>
            </td>
        </tr>

        {expanded && (
            <tr>
                <td colSpan={TABLE_COLS} className="px-6 py-6 bg-bauhaus-cream">
                    <InstructorExpandedContent inst={inst} urls={urls} progress={progress} isAdmin={isAdmin} onConfirmEmail={onConfirmEmail} />
                </td>
            </tr>
        )}
    </>
);

// 地區：有勾選縣市顯示「N 個縣市」；只有匯入的原始文字就截斷顯示（滑過看全文）。
// compact＝表格版：1024–1279px 欄位多、寬度吃緊，原始文字少留一點，1280px 以上才放寬。
const RegionSummary = ({ inst, compact = false }) => (
    <div className="inline-flex items-center gap-1 text-xs text-bauhaus-black/60 whitespace-nowrap">
        <MapPin className="w-3 h-3 shrink-0" />
        {inst.teaching_regions?.length
            ? `${inst.teaching_regions.length} 個縣市`
            : inst.teaching_regions_raw
                ? <span className={`text-bauhaus-black/40 truncate inline-block ${compact ? 'max-w-[4rem] xl:max-w-[5rem]' : 'max-w-[5rem]'}`} title={inst.teaching_regions_raw}>{inst.teaching_regions_raw}</span>
                : <span className="text-bauhaus-black/30">—</span>}
    </div>
);

const SpeedQualificationBadge = ({ value }) => (
    <span className={`bh-chip whitespace-nowrap ${value ? 'bg-bauhaus-yellow text-bauhaus-black' : 'bg-bauhaus-muted text-bauhaus-black/60'}`}>
        {speedQualificationLabel(value)}
    </span>
);

const InfoRow = ({ label, value }) => {
    if (!value) return null;
    return (
        <div className="flex items-start gap-2 text-sm">
            <span className="text-bauhaus-black/40 whitespace-nowrap min-w-[100px]">{label}:</span>
            <span className="text-bauhaus-black/80">{value}</span>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════
// 新增講師 Modal
//   模式一（預設）「只填姓名」：一行一個姓名，建立 name_slot 空位；老師用 Google 登入後，
//   在待審核頁選「認領帳號」輸入同一個姓名就直接綁定並開通（資料庫函式 claim_instructor_name_slot）。
//   模式二「填完整資料」：原本的做法，用 Email 登入自動對應。
// ═══════════════════════════════════════════════════════════════
const AddInstructorModal = ({ instructors, onClose, onCreated }) => {
    const [mode, setMode] = useState('names');

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bauhaus-black/60 p-4">
            <div className="bh-card shadow-hard-lg max-w-md w-full max-h-[85dvh] overflow-y-auto" role="dialog" aria-modal="true" aria-label="新增講師">
                <div className="flex items-center justify-between px-6 py-4 border-b-2 border-bauhaus-black bg-bauhaus-black text-white">
                    <h2 className="font-black uppercase tracking-wide">新增講師</h2>
                    <button onClick={onClose} className="text-white/70 hover:text-white" aria-label="關閉">
                        <X className="w-5 h-5" />
                    </button>
                </div>
                <div className="px-6 pt-5">
                    <div role="tablist" aria-label="新增方式" className="grid grid-cols-2 gap-2">
                        {[
                            { key: 'names', label: '只填姓名', hint: '老師登入後輸入姓名認領' },
                            { key: 'full', label: '填完整資料', hint: '含 Email，登入自動對應' },
                        ].map(tab => (
                            <button
                                key={tab.key}
                                type="button"
                                role="tab"
                                aria-selected={mode === tab.key}
                                onClick={() => setMode(tab.key)}
                                className={`rounded-xl border-2 border-bauhaus-black px-3 py-2 text-left transition-colors ${
                                    mode === tab.key ? 'bg-bauhaus-blue text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                                }`}
                            >
                                <span className="block text-sm font-black">{tab.label}</span>
                                <span className={`block text-[11px] font-medium ${mode === tab.key ? 'text-white/80' : 'text-bauhaus-black/60'}`}>{tab.hint}</span>
                            </button>
                        ))}
                    </div>
                </div>
                {mode === 'names'
                    ? <NameOnlyForm instructors={instructors} onClose={onClose} onCreated={onCreated} />
                    : <FullInstructorForm onClose={onClose} onCreated={onCreated} />}
            </div>
        </div>
    );
};

const NameOnlyForm = ({ instructors, onClose, onCreated }) => {
    const [text, setText] = useState('');
    // 合約要有講師等級才能簽；新建帳號一律是「實習」，空位預設同樣，管理員可改。
    const [instructorRole, setInstructorRole] = useState('實習');
    const [confirmedDuplicate, setConfirmedDuplicate] = useState(false);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');

    const parsed = useMemo(() => parseNameLines(text), [text]);
    const conflicts = useMemo(
        () => findNameConflicts(parsed.names, instructors),
        [parsed.names, instructors],
    );
    const blockedByDuplicate = conflicts.hasConflict && !confirmedDuplicate;
    const hasInvalid = parsed.tooLong.length > 0 || parsed.overLimit;
    const canSubmit = parsed.names.length > 0 && !hasInvalid && !blockedByDuplicate && !saving;

    const submit = async (e) => {
        e.preventDefault();
        setErr('');
        if (parsed.names.length === 0) return setErr('請至少輸入一個姓名');
        if (hasInvalid) return setErr('請先修正標示的姓名');
        if (blockedByDuplicate) return setErr('有同名的姓名，請先勾選確認');

        setSaving(true);
        const rows = parsed.names.map(name => ({
            full_name: name,
            employment_status: 'active',
            instructor_role: instructorRole || null,
            name_slot: true,
        }));
        const { error } = await supabase.from('instructors').insert(rows);
        setSaving(false);
        if (error) {
            setErr('新增失敗:' + error.message);
            return;
        }
        onCreated(`已新增 ${rows.length} 位空位：${parsed.names.join('、')}。請通知老師用 Google 登入，選「認領帳號」並輸入相同姓名，就會直接綁定。`);
    };

    return (
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
            <Field
                label="姓名（一行一個）"
                required
                hint="建好後，老師用 Google 登入、選「認領帳號」輸入同一個姓名就會直接綁定並開通。同名同姓可建立多個空位，各自被認領。"
            >
                <textarea
                    value={text}
                    onChange={e => { setText(e.target.value); setConfirmedDuplicate(false); }}
                    className="bh-input text-sm min-h-[8rem]"
                    rows={6}
                    placeholder={'王小明\n李小華'}
                    aria-label="老師姓名，一行一個"
                    autoFocus
                />
            </Field>

            <Field label="講師等級（套用到這批）" hint="合約要有等級才能簽。之後可在列表上逐一調整。">
                <select
                    value={instructorRole}
                    onChange={e => setInstructorRole(e.target.value)}
                    className="bh-input text-sm"
                    aria-label="講師等級"
                >
                    <option value="">未設定（簽約前要補）</option>
                    {Object.entries(ROLE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                    ))}
                </select>
            </Field>

            {parsed.names.length > 0 && (
                <p className="text-sm font-bold text-bauhaus-black" data-testid="name-slot-count">
                    將新增 {parsed.names.length} 位空位
                </p>
            )}

            {parsed.tooLong.length > 0 && (
                <div role="alert" className="text-sm text-white bg-bauhaus-red border-2 border-bauhaus-black px-3 py-2 font-bold">
                    姓名太長（上限 50 字）：{parsed.tooLong.join('、')}
                </div>
            )}
            {parsed.overLimit && (
                <div role="alert" className="text-sm text-white bg-bauhaus-red border-2 border-bauhaus-black px-3 py-2 font-bold">
                    一次最多新增 {MAX_NAME_SLOT_BATCH} 位，請分批輸入。
                </div>
            )}

            {conflicts.hasConflict && (
                <div role="alert" className="bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl px-3 py-3 space-y-2" data-testid="name-slot-conflicts">
                    <div className="flex items-start gap-2 text-sm font-black text-bauhaus-black">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <span>發現同名，請確認不是重複建立：</span>
                    </div>
                    <ul className="list-disc pl-9 text-sm font-bold text-bauhaus-black space-y-0.5">
                        {conflicts.rosterConflicts.map(item => (
                            <li key={`roster-${normalizePersonName(item.name)}`}>{describeRosterConflict(item)}</li>
                        ))}
                        {conflicts.batchDuplicates.map(item => (
                            <li key={`batch-${normalizePersonName(item.name)}`}>{describeBatchDuplicate(item)}</li>
                        ))}
                    </ul>
                    <label className="flex items-start gap-2 text-sm font-bold text-bauhaus-black cursor-pointer">
                        <input
                            type="checkbox"
                            checked={confirmedDuplicate}
                            onChange={e => setConfirmedDuplicate(e.target.checked)}
                            className="mt-1 w-4 h-4 accent-bauhaus-blue"
                        />
                        <span>我確定要再新增同名空位（同名同姓不同人）</span>
                    </label>
                </div>
            )}

            {err && (
                <div className="text-sm text-white bg-bauhaus-red border-2 border-bauhaus-black px-3 py-2 font-bold">
                    {err}
                </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={onClose}
                    className="bh-btn bh-btn-outline px-4 py-2 text-sm">
                    取消
                </button>
                <button type="submit" disabled={!canSubmit}
                    className="bh-btn bh-btn-blue px-5 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed">
                    {saving ? '新增中⋯' : parsed.names.length > 1 ? `新增 ${parsed.names.length} 位` : '新增'}
                </button>
            </div>
        </form>
    );
};

const FullInstructorForm = ({ onClose, onCreated }) => {
    const [form, setForm] = useState({
        full_name: '',
        email_primary: '',
        phone_mobile: '',
        employment_status: 'active',
        instructor_role: '',
        speed_qualification: '',
    });
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');

    const submit = async (e) => {
        e.preventDefault();
        setErr('');
        if (!form.full_name.trim()) return setErr('姓名為必填');
        if (!form.email_primary.trim()) return setErr('Email 為必填(用於登入後自動綁定)');

        setSaving(true);
        const payload = {
            full_name: form.full_name.trim(),
            email_primary: form.email_primary.trim().toLowerCase(),
            phone_mobile: form.phone_mobile.trim() || null,
            employment_status: form.employment_status || null,
            instructor_role: form.instructor_role || null,
            speed_qualification: form.speed_qualification || null,
        };
        const { error } = await supabase.from('instructors').insert(payload);
        setSaving(false);
        if (error) {
            setErr('新增失敗:' + error.message);
            return;
        }
        onCreated(`已新增 ${payload.full_name}。對方用 ${payload.email_primary} 的 Google 帳號登入時會自動綁定。`);
    };

    const inputCls = 'bh-input text-sm';

    return (
        <form onSubmit={submit} className="px-6 py-5 space-y-4">
            <Field label="姓名" required>
                <input
                    type="text" value={form.full_name}
                    onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))}
                    className={inputCls} autoFocus
                />
            </Field>
            <Field label="Email(登入用)" required hint="講師用此 Email 的 Google 帳號登入時會自動綁定">
                <input
                    type="email" value={form.email_primary}
                    onChange={e => setForm(p => ({ ...p, email_primary: e.target.value }))}
                    className={inputCls} placeholder="example@gmail.com"
                />
            </Field>
            <Field label="手機(選填)" hint="供日後人工認領核對使用">
                <input
                    type="tel" value={form.phone_mobile}
                    onChange={e => setForm(p => ({ ...p, phone_mobile: e.target.value }))}
                    className={inputCls} placeholder="0912345678"
                />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="業務狀態">
                    <select
                        value={form.employment_status}
                        onChange={e => setForm(p => ({ ...p, employment_status: e.target.value }))}
                        className={inputCls}
                    >
                        {STATUS_OPTIONS.map(s => (
                            <option key={s.key} value={s.key}>{s.label}</option>
                        ))}
                    </select>
                </Field>
                <Field label="講師等級">
                    <select
                        value={form.instructor_role}
                        onChange={e => setForm(p => ({ ...p, instructor_role: e.target.value }))}
                        className={inputCls}
                    >
                        <option value="">未設定</option>
                        {Object.entries(ROLE_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                        ))}
                    </select>
                </Field>
                <Field label="速解專業資格">
                    <select
                        value={form.speed_qualification}
                        onChange={e => setForm(p => ({ ...p, speed_qualification: e.target.value }))}
                        className={inputCls}
                    >
                        <option value="">未取得</option>
                        {Object.entries(SPEED_QUALIFICATION_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                        ))}
                    </select>
                </Field>
            </div>

            {err && (
                <div className="text-sm text-white bg-bauhaus-red border-2 border-bauhaus-black px-3 py-2 font-bold">
                    {err}
                </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={onClose}
                    className="bh-btn bh-btn-outline px-4 py-2 text-sm">
                    取消
                </button>
                <button type="submit" disabled={saving}
                    className="bh-btn bh-btn-blue px-5 py-2 text-sm">
                    {saving ? '新增中⋯' : '新增'}
                </button>
            </div>
        </form>
    );
};

const Field = ({ label, required, hint, children }) => (
    <div>
        <label className="bh-label block mb-1">
            {label} {required && <span className="text-bauhaus-red">*</span>}
        </label>
        {children}
        {hint && <p className="text-xs text-bauhaus-black/50 mt-1 font-medium normal-case tracking-normal">{hint}</p>}
    </div>
);

// ═══════════════════════════════════════════════════════════════
// 手動綁定 Modal
// ═══════════════════════════════════════════════════════════════
const LinkInstructorModal = ({ inst, onClose, onLinked }) => {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [selectedUserId, setSelectedUserId] = useState(null);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');

    useEffect(() => {
        (async () => {
            // 撈尚未認領其他 instructor 的 users（避免一個帳號認領兩筆主檔）
            const { data: allUsers } = await supabase
                .from('users')
                .select('id,name,email,role')
                .order('created_at', { ascending: false })
                .limit(500);
            const { data: linkedInst } = await supabase
                .from('instructors')
                .select('user_id')
                .not('user_id', 'is', null);
            const lockedIds = new Set(linkedInst?.map(r => r.user_id) || []);
            setUsers((allUsers || []).filter(u => !lockedIds.has(u.id)));
            setLoading(false);
        })();
    }, []);

    const filtered = search
        ? users.filter(u =>
            u.email?.toLowerCase().includes(search.toLowerCase()) ||
            u.name?.toLowerCase().includes(search.toLowerCase())
        )
        : users;

    const doLink = async () => {
        if (!selectedUserId) return setErr('請先選擇要綁定的使用者');
        setErr('');
        setSaving(true);
        const { error } = await supabase.rpc('admin_link_instructor', {
            target_instructor_id: inst.id,
            target_user_id: selectedUserId,
        });
        setSaving(false);
        if (error) {
            setErr('綁定失敗:' + error.message);
            return;
        }
        onLinked();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bauhaus-black/60 p-4">
            <div className="bh-card shadow-hard-lg max-w-lg w-full max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between px-6 py-4 border-b-2 border-bauhaus-black bg-bauhaus-black text-white">
                    <div>
                        <h2 className="font-black uppercase tracking-wide">手動綁定</h2>
                        <p className="text-xs text-white/70 mt-0.5">
                            講師:<strong>{inst.full_name}</strong>({inst.email_primary || '無 Email'})
                        </p>
                    </div>
                    <button onClick={onClose} className="text-white/70 hover:text-white">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="px-6 py-3 border-b-2 border-bauhaus-black">
                    <input
                        type="text" value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="搜尋使用者(姓名或 Email)⋯⋯"
                        className="bh-input text-sm"
                        autoFocus
                    />
                    <p className="text-xs text-bauhaus-black/50 mt-1 font-medium">僅列出尚未認領其他講師主檔的使用者</p>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-2">
                    {loading ? (
                        <div className="text-center text-bauhaus-black/50 py-8 text-sm font-bold">載入中⋯</div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center text-bauhaus-black/50 py-8 text-sm font-bold">沒有符合的使用者</div>
                    ) : (
                        <div className="space-y-1">
                            {filtered.slice(0, 50).map(u => (
                                <label key={u.id}
                                    className={`flex items-center gap-3 px-3 py-2 rounded-xl border-2 cursor-pointer hover:bg-bauhaus-cream ${selectedUserId === u.id ? 'bg-bauhaus-cream border-bauhaus-black' : 'border-transparent'}`}>
                                    <input
                                        type="radio" name="user"
                                        checked={selectedUserId === u.id}
                                        onChange={() => setSelectedUserId(u.id)}
                                        className="accent-bauhaus-blue"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-bauhaus-black truncate">{u.name || '(無姓名)'}</div>
                                        <div className="text-xs text-bauhaus-black/60 truncate">{u.email}</div>
                                    </div>
                                    <span className="bh-chip bg-bauhaus-muted text-bauhaus-black">{u.role}</span>
                                </label>
                            ))}
                            {filtered.length > 50 && (
                                <div className="text-xs text-bauhaus-black/50 text-center pt-2">已顯示前 50 筆,請以搜尋縮小範圍</div>
                            )}
                        </div>
                    )}
                </div>

                {err && (
                    <div className="px-6 pt-2 text-sm text-bauhaus-red font-bold">{err}</div>
                )}

                <div className="px-6 py-3 border-t-2 border-bauhaus-black flex justify-end gap-2">
                    <button onClick={onClose}
                        className="bh-btn bh-btn-outline px-4 py-2 text-sm">
                        取消
                    </button>
                    <button onClick={doLink} disabled={saving || !selectedUserId}
                        className="bh-btn bh-btn-blue px-5 py-2 text-sm">
                        {saving ? '綁定中⋯' : '確認綁定'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default InstructorList;
