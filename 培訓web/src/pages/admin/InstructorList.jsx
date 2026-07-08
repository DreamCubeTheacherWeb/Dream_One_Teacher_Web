import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import { Search, ChevronDown, ChevronUp, ExternalLink, FileImage, MapPin, Plus, Link2, Unlink, X, Check, Inbox } from 'lucide-react';

const ROLE_LABELS = { S: 'S 級', 'A+': 'A+ 級', A: 'A 級', B: 'B 級', '實習': '實習' };

const STATUS_OPTIONS = [
    { key: 'active',    label: '講師',     color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    { key: 'staff',     label: '職員',     color: 'bg-blue-50 text-blue-700 border-blue-200' },
    { key: 'assistant', label: '助教',     color: 'bg-purple-50 text-purple-700 border-purple-200' },
    { key: 'part_time', label: '工讀生',   color: 'bg-slate-100 text-slate-600 border-slate-200' },
    { key: 'frozen',    label: '冷凍',     color: 'bg-amber-50 text-amber-700 border-amber-200' },
    { key: 'cancelled', label: '停止合作', color: 'bg-rose-50 text-rose-700 border-rose-200' },
];
const STATUS_MAP = Object.fromEntries(STATUS_OPTIONS.map(s => [s.key, s]));

const DOC_KEYS = [
    { key: 'id_front', label: '身分證正面' },
    { key: 'id_back', label: '身分證反面' },
    { key: 'photo', label: '講師照片' },
    { key: 'bankbook', label: '存摺封面' },
];

const LINK_FILTERS = [
    { key: '', label: '全部', color: 'bg-slate-900 text-white border-slate-900' },
    { key: 'linked', label: '已綁帳號', color: 'bg-green-50 text-green-700 border-green-200' },
    { key: 'unlinked', label: '未綁帳號', color: 'bg-slate-50 text-slate-600 border-slate-200' },
];

const InstructorList = () => {
    const { profile } = useAuth();
    const isAdmin = profile?.role === 'admin';
    const [instructors, setInstructors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('');
    const [roleFilter, setRoleFilter] = useState('');
    const [linkFilter, setLinkFilter] = useState('');
    const [expandedId, setExpandedId] = useState(null);
    const [signedUrls, setSignedUrls] = useState({});
    const [showAddModal, setShowAddModal] = useState(false);
    const [linkingInst, setLinkingInst] = useState(null);
    const [pendingClaimCount, setPendingClaimCount] = useState(0);

    useEffect(() => { loadInstructors(); }, []);
    useEffect(() => {
        if (!isAdmin) return;
        (async () => {
            const { count } = await supabase
                .from('instructor_claim_requests')
                .select('id', { count: 'exact', head: true })
                .eq('status', 'pending');
            setPendingClaimCount(count || 0);
        })();
    }, [isAdmin]);

    const loadInstructors = async () => {
        const { data } = await supabase
            .from('instructors')
            .select('*')
            .order('created_at', { ascending: false });
        setInstructors(data || []);
        setLoading(false);
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

    const filtered = instructors.filter(i => {
        if (statusFilter && i.employment_status !== statusFilter) return false;
        if (roleFilter && i.instructor_role !== roleFilter) return false;
        if (linkFilter === 'linked' && !i.user_id) return false;
        if (linkFilter === 'unlinked' && i.user_id) return false;
        if (search) {
            const s = search.toLowerCase();
            return i.full_name?.toLowerCase().includes(s)
                || i.email_primary?.toLowerCase().includes(s)
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

    const docCount = (inst) => DOC_KEYS.filter(d =>
        inst[`${d.key}_path`] || inst[`${d.key}_external_url`]
    ).length;

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
        if (!confirm(`確定要解除 ${inst.full_name} 的帳號綁定嗎?\n解綁後使用者下次登入會被當作新使用者,需要重新認領這筆資料。`)) return;
        const { error } = await supabase.rpc('admin_unlink_instructor', { target_instructor_id: inst.id });
        if (error) {
            alert('解綁失敗:' + error.message);
            return;
        }
        await loadInstructors();
    };

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    return (
        <div className="p-4 sm:p-8">
            <div className="flex items-start sm:items-center justify-between mb-8 gap-3 flex-col sm:flex-row">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-slate-900">講師資料總覽</h1>
                    <p className="text-slate-500 mt-1">
                        共 {instructors.length} 位 ・ <span className="text-green-600 font-bold">{linkedCount}</span> 位已綁帳號 ・ <span className="text-slate-500 font-bold">{unlinkedCount}</span> 位待登入
                    </p>
                </div>
                {isAdmin && (
                    <div className="flex items-center gap-2 flex-wrap">
                        <Link
                            to="/admin/claims"
                            className={`inline-flex items-center gap-2 font-bold px-3 py-2.5 rounded-xl transition-colors text-sm ${
                                pendingClaimCount > 0
                                    ? 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100'
                                    : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-50'
                            }`}
                        >
                            <Inbox className="w-4 h-4" />
                            認領申請
                            {pendingClaimCount > 0 && (
                                <span className="bg-amber-500 text-white text-xs px-1.5 rounded-full min-w-[20px] text-center">
                                    {pendingClaimCount}
                                </span>
                            )}
                        </Link>
                        <button
                            onClick={() => setShowAddModal(true)}
                            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-bold px-4 py-2.5 rounded-xl shadow-md shadow-blue-500/20 transition-colors"
                        >
                            <Plus className="w-4 h-4" /> 新增講師
                        </button>
                    </div>
                )}
            </div>

            <div className="relative mb-3">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                    type="text"
                    placeholder="搜尋姓名、Email 或手機號碼⋯⋯"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    className="w-full pl-12 pr-4 py-3 rounded-xl border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none"
                />
            </div>

            <div className="flex flex-wrap gap-2 mb-3">
                {LINK_FILTERS.map(f => {
                    const count = f.key === '' ? instructors.length : f.key === 'linked' ? linkedCount : unlinkedCount;
                    const active = linkFilter === f.key;
                    return (
                        <button
                            key={f.key || 'all'}
                            onClick={() => setLinkFilter(f.key)}
                            className={`text-xs font-bold px-3 py-1.5 rounded-full border transition-colors ${
                                active ? f.color + ' ring-2 ring-offset-1 ring-slate-300' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
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
                    className={`text-xs font-bold px-3 py-1.5 rounded-full border transition-colors ${
                        !statusFilter ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'
                    }`}
                >
                    全部狀態
                </button>
                {STATUS_OPTIONS.map(s => (
                    <button
                        key={s.key}
                        onClick={() => setStatusFilter(statusFilter === s.key ? '' : s.key)}
                        className={`text-xs font-bold px-3 py-1.5 rounded-full border transition-colors ${
                            statusFilter === s.key
                                ? `${s.color} ring-2 ring-offset-1 ring-slate-300`
                                : `${s.color} opacity-60 hover:opacity-100`
                        }`}
                    >
                        {s.label} {statusCounts[s.key] || 0}
                    </button>
                ))}
                <div className="border-l border-slate-200 mx-2"></div>
                <select
                    value={roleFilter}
                    onChange={e => setRoleFilter(e.target.value)}
                    className="text-xs font-bold px-3 py-1.5 rounded-full border border-slate-200 bg-white text-slate-600 cursor-pointer hover:border-slate-400 outline-none"
                >
                    <option value="">全部等級</option>
                    {Object.entries(ROLE_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                    ))}
                </select>
            </div>

            <div className="block md:hidden space-y-3">
                {filtered.length === 0 ? (
                    <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
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
                            isAdmin={isAdmin}
                            onRoleChange={(newRole) => handleRoleChange(inst, newRole)}
                            onUnlink={() => handleUnlink(inst)}
                            onLink={() => setLinkingInst(inst)}
                        />
                    ))
                )}
            </div>

            <div className="hidden md:block bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                <table className="w-full text-left">
                    <thead className="bg-slate-50 text-slate-400 text-xs font-bold uppercase tracking-wider">
                        <tr>
                            <th className="px-6 py-4">姓名</th>
                            <th className="px-6 py-4">Email</th>
                            <th className="px-6 py-4">綁定</th>
                            <th className="px-6 py-4">等級</th>
                            <th className="px-6 py-4">地區</th>
                            <th className="px-6 py-4">文件</th>
                            <th className="px-6 py-4 text-right">操作</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {filtered.map(inst => (
                            <InstructorRow
                                key={inst.id}
                                inst={inst}
                                expanded={expandedId === inst.id}
                                onToggle={() => toggleExpand(inst)}
                                urls={signedUrls[inst.id] || {}}
                                docCount={docCount(inst)}
                                isAdmin={isAdmin}
                                onRoleChange={(newRole) => handleRoleChange(inst, newRole)}
                                onUnlink={() => handleUnlink(inst)}
                                onLink={() => setLinkingInst(inst)}
                            />
                        ))}
                        {filtered.length === 0 && (
                            <tr>
                                <td colSpan={7} className="px-6 py-12 text-center text-slate-400">
                                    {search ? '找不到符合的講師' : '尚無講師資料'}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {showAddModal && (
                <AddInstructorModal
                    onClose={() => setShowAddModal(false)}
                    onCreated={() => { setShowAddModal(false); loadInstructors(); }}
                />
            )}

            {linkingInst && (
                <LinkInstructorModal
                    inst={linkingInst}
                    onClose={() => setLinkingInst(null)}
                    onLinked={() => { setLinkingInst(null); loadInstructors(); }}
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
        <span className="inline-flex items-center gap-1 text-xs font-bold bg-green-50 text-green-700 px-2 py-0.5 rounded-full">
            <Check className="w-3 h-3" /> 已綁
        </span>
    ) : (
        <span className="inline-flex items-center gap-1 text-xs font-bold bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full">
            未綁
        </span>
    )
);

// ───────────────────────────────────────────────────────────────
// 展開內容
// ───────────────────────────────────────────────────────────────
const InstructorExpandedContent = ({ inst, urls }) => (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-3">
            <h3 className="font-bold text-slate-900 text-sm">基本資料</h3>
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
                    value={<a href={inst.facebook_url} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline inline-flex items-center gap-1">連結 <ExternalLink className="w-3 h-3" /></a>}
                />
            )}

            <h3 className="font-bold text-slate-900 text-sm pt-3">教學資訊</h3>
            <InfoRow label="接課頻率(學期)" value={inst.teaching_freq_semester} />
            <InfoRow label="接課頻率(寒暑假)" value={inst.teaching_freq_vacation} />
            <div>
                <span className="text-xs text-slate-400">接課地區:</span>
                <div className="flex flex-wrap gap-1 mt-1">
                    {inst.teaching_regions?.length ? (
                        inst.teaching_regions.map(r => (
                            <span key={r} className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">{r}</span>
                        ))
                    ) : inst.teaching_regions_raw ? (
                        <span className="text-xs text-slate-500 italic">{inst.teaching_regions_raw}(未對應到縣市)</span>
                    ) : (
                        <span className="text-xs text-slate-300">—</span>
                    )}
                </div>
            </div>

            {(inst.bio_personal_experience || inst.bio_teaching_experience || inst.teaching_philosophy || inst.bio_notes) && (
                <>
                    <h3 className="font-bold text-slate-900 text-sm pt-3">經歷 / 理念</h3>
                    {inst.bio_personal_experience && <BioBlock label="個人經歷" text={inst.bio_personal_experience} />}
                    {inst.bio_teaching_experience && <BioBlock label="授課經驗" text={inst.bio_teaching_experience} />}
                    {inst.teaching_philosophy && <BioBlock label="教學理念" text={inst.teaching_philosophy} />}
                    {inst.bio_notes && <BioBlock label="備註" text={inst.bio_notes} />}
                </>
            )}

            {(inst.bank_info_raw || inst.note_to_team || inst.note_internal) && (
                <>
                    <h3 className="font-bold text-slate-900 text-sm pt-3">其他</h3>
                    <InfoRow label="匯款帳戶" value={inst.bank_info_raw} />
                    <InfoRow label="想對團隊說" value={inst.note_to_team} />
                    {inst.note_internal && (
                        <div className="bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 mt-2">
                            <div className="text-xs font-bold text-rose-700 mb-0.5">內部備註</div>
                            <div className="text-xs text-rose-900 whitespace-pre-wrap">{inst.note_internal}</div>
                        </div>
                    )}
                </>
            )}
        </div>

        <div>
            <h3 className="font-bold text-slate-900 text-sm mb-3">上傳文件</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {DOC_KEYS.map(({ key, label }) => {
                    const externalUrl = inst[`${key}_external_url`];
                    const storageUrl = urls[key];
                    return (
                        <div key={key} className="border border-slate-200 rounded-xl p-3">
                            <div className="text-xs font-medium text-slate-500 mb-2">{label}</div>
                            {storageUrl ? (
                                <a href={storageUrl} target="_blank" rel="noopener noreferrer" className="block group">
                                    <img src={storageUrl} alt={label} className="w-full h-24 object-cover rounded-lg" />
                                    <div className="flex items-center gap-1 text-xs text-blue-500 mt-1 group-hover:underline">
                                        <ExternalLink className="w-3 h-3" /> 開啟原圖
                                    </div>
                                </a>
                            ) : externalUrl ? (
                                <a href={externalUrl} target="_blank" rel="noopener noreferrer"
                                    className="block group w-full h-24 bg-amber-50 border border-amber-200 rounded-lg flex flex-col items-center justify-center gap-1 hover:bg-amber-100 transition-colors">
                                    <ExternalLink className="w-5 h-5 text-amber-600" />
                                    <span className="text-xs font-medium text-amber-700">Google Drive</span>
                                    <span className="text-[10px] text-amber-600 group-hover:underline">點擊開啟</span>
                                </a>
                            ) : (
                                <div className="w-full h-24 bg-slate-100 rounded-lg flex items-center justify-center text-xs text-slate-400">
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
    if (!status) return <span className="text-xs text-slate-300">—</span>;
    const s = STATUS_MAP[status];
    if (!s) return <span className="text-xs text-slate-400">{status}</span>;
    return (
        <span className={`inline-flex items-center text-xs font-bold px-2.5 py-0.5 rounded-full border ${s.color}`}>
            {s.label}
        </span>
    );
};

const BioBlock = ({ label, text }) => (
    <div className="mt-2">
        <div className="text-xs text-slate-400 mb-0.5">{label}</div>
        <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{text}</p>
    </div>
);

const InstructorCard = ({ inst, expanded, onToggle, urls, docCount, isAdmin, onRoleChange, onUnlink, onLink }) => (
    <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        <div
            className="p-4 flex items-start gap-3 cursor-pointer hover:bg-slate-50 transition-colors"
            onClick={onToggle}
        >
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-slate-900 truncate">{inst.full_name}</span>
                    {inst.gender && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 shrink-0">{inst.gender}</span>
                    )}
                </div>
                <div className="text-sm text-slate-500 mt-0.5 truncate">{inst.email_primary}</div>
                <div className="flex flex-wrap items-center gap-1.5 mt-2" onClick={e => e.stopPropagation()}>
                    <StatusBadge status={inst.employment_status} />
                    <LinkBadge userId={inst.user_id} />
                    {isAdmin ? (
                        <select
                            value={inst.instructor_role || ''}
                            onChange={e => onRoleChange(e.target.value)}
                            className={`text-xs font-bold px-2.5 py-1 rounded-full border-0 outline-none cursor-pointer ${
                                inst.instructor_role ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'
                            }`}
                        >
                            <option value="">未設定</option>
                            {Object.entries(ROLE_LABELS).map(([k, v]) => (
                                <option key={k} value={k}>{v}</option>
                            ))}
                        </select>
                    ) : inst.instructor_role ? (
                        <span className="inline-flex items-center text-xs font-bold bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full">
                            {ROLE_LABELS[inst.instructor_role] || inst.instructor_role}
                        </span>
                    ) : (
                        <span className="text-xs text-slate-400">未設定</span>
                    )}
                    <span className="inline-flex items-center gap-1 text-xs text-slate-500">
                        <MapPin className="w-3 h-3" />
                        {inst.teaching_regions?.length || inst.teaching_regions_raw ? (inst.teaching_regions?.length || '–') : 0}
                    </span>
                    <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${docCount === 4 ? 'bg-green-50 text-green-600' : docCount > 0 ? 'bg-yellow-50 text-yellow-600' : 'bg-slate-100 text-slate-400'}`}>
                        <FileImage className="w-3 h-3" />
                        {docCount}/4
                    </span>
                    {isAdmin && (
                        inst.user_id ? (
                            <button onClick={onUnlink} className="text-xs text-rose-500 hover:text-rose-700 hover:underline">解綁</button>
                        ) : (
                            <button onClick={onLink} className="text-xs text-blue-500 hover:text-blue-700 hover:underline">綁定</button>
                        )
                    )}
                </div>
            </div>
            <button className="shrink-0 text-slate-400 hover:text-blue-600 transition-colors p-1">
                {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
            </button>
        </div>
        {expanded && (
            <div className="px-4 pb-4 pt-0 bg-slate-50/50">
                <InstructorExpandedContent inst={inst} urls={urls} />
            </div>
        )}
    </div>
);

const InstructorRow = ({ inst, expanded, onToggle, urls, docCount, isAdmin, onRoleChange, onUnlink, onLink }) => (
    <>
        <tr className="hover:bg-slate-50 transition-colors cursor-pointer" onClick={onToggle}>
            <td className="px-6 py-4">
                <div className="font-semibold text-slate-900">{inst.full_name}</div>
                <div className="mt-1"><StatusBadge status={inst.employment_status} /></div>
            </td>
            <td className="px-6 py-4 text-sm text-slate-600">{inst.email_primary || <span className="text-slate-300">—</span>}</td>
            <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2">
                    <LinkBadge userId={inst.user_id} />
                    {isAdmin && (
                        inst.user_id ? (
                            <button onClick={onUnlink} title="解除綁定" className="text-rose-400 hover:text-rose-600 transition-colors">
                                <Unlink className="w-3.5 h-3.5" />
                            </button>
                        ) : (
                            <button onClick={onLink} title="手動綁定" className="text-blue-400 hover:text-blue-600 transition-colors">
                                <Link2 className="w-3.5 h-3.5" />
                            </button>
                        )
                    )}
                </div>
            </td>
            <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                {isAdmin ? (
                    <select
                        value={inst.instructor_role || ''}
                        onChange={e => onRoleChange(e.target.value)}
                        className={`text-xs font-bold px-2.5 py-1.5 rounded-full border-0 outline-none cursor-pointer ${
                            inst.instructor_role ? 'bg-indigo-50 text-indigo-600' : 'bg-slate-50 text-slate-400'
                        }`}
                    >
                        <option value="">未設定</option>
                        {Object.entries(ROLE_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                        ))}
                    </select>
                ) : inst.instructor_role ? (
                    <span className="inline-flex items-center text-xs font-bold bg-indigo-50 text-indigo-600 px-2.5 py-1 rounded-full">
                        {ROLE_LABELS[inst.instructor_role] || inst.instructor_role}
                    </span>
                ) : (
                    <span className="text-xs text-slate-400">未設定</span>
                )}
            </td>
            <td className="px-6 py-4">
                <div className="flex items-center gap-1 text-xs text-slate-500">
                    <MapPin className="w-3 h-3" />
                    {inst.teaching_regions?.length
                        ? `${inst.teaching_regions.length} 個縣市`
                        : inst.teaching_regions_raw
                            ? <span className="text-slate-400 truncate max-w-[120px] inline-block">{inst.teaching_regions_raw}</span>
                            : <span className="text-slate-300">—</span>}
                </div>
            </td>
            <td className="px-6 py-4">
                <span className={`inline-flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full ${docCount === 4 ? 'bg-green-50 text-green-600' : docCount > 0 ? 'bg-yellow-50 text-yellow-600' : 'bg-slate-100 text-slate-400'}`}>
                    <FileImage className="w-3 h-3" />
                    {docCount}/4
                </span>
            </td>
            <td className="px-6 py-4 text-right">
                <button className="text-slate-400 hover:text-blue-600 transition-colors">
                    {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                </button>
            </td>
        </tr>

        {expanded && (
            <tr>
                <td colSpan={7} className="px-6 py-6 bg-slate-50/50">
                    <InstructorExpandedContent inst={inst} urls={urls} />
                </td>
            </tr>
        )}
    </>
);

const InfoRow = ({ label, value }) => {
    if (!value) return null;
    return (
        <div className="flex items-start gap-2 text-sm">
            <span className="text-slate-400 whitespace-nowrap min-w-[100px]">{label}:</span>
            <span className="text-slate-700">{value}</span>
        </div>
    );
};

// ═══════════════════════════════════════════════════════════════
// 新增講師 Modal
// ═══════════════════════════════════════════════════════════════
const AddInstructorModal = ({ onClose, onCreated }) => {
    const [form, setForm] = useState({
        full_name: '',
        email_primary: '',
        phone_mobile: '',
        employment_status: 'active',
        instructor_role: '',
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
        };
        const { error } = await supabase.from('instructors').insert(payload);
        setSaving(false);
        if (error) {
            setErr('新增失敗:' + error.message);
            return;
        }
        onCreated();
    };

    const inputCls = 'w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm';

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full max-h-[85dvh] overflow-y-auto">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                    <h2 className="font-bold text-lg text-slate-900">新增講師</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
                        <X className="w-5 h-5" />
                    </button>
                </div>
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
                    </div>

                    {err && (
                        <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
                            {err}
                        </div>
                    )}

                    <div className="flex justify-end gap-2 pt-2">
                        <button type="button" onClick={onClose}
                            className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-bold text-sm">
                            取消
                        </button>
                        <button type="submit" disabled={saving}
                            className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm disabled:opacity-50">
                            {saving ? '新增中⋯' : '新增'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

const Field = ({ label, required, hint, children }) => (
    <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">
            {label} {required && <span className="text-red-500">*</span>}
        </label>
        {children}
        {hint && <p className="text-xs text-slate-400 mt-1">{hint}</p>}
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
            // 撈未綁任何 instructor 的 users(避免綁到已綁的人)
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[80vh] flex flex-col">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
                    <div>
                        <h2 className="font-bold text-lg text-slate-900">手動綁定</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                            講師:<strong>{inst.full_name}</strong>({inst.email_primary || '無 Email'})
                        </p>
                    </div>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                <div className="px-6 py-3 border-b border-slate-100">
                    <input
                        type="text" value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="搜尋使用者(姓名或 Email)⋯⋯"
                        className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-blue-400 outline-none text-sm"
                        autoFocus
                    />
                    <p className="text-xs text-slate-400 mt-1">僅列出尚未綁定其他講師的使用者</p>
                </div>

                <div className="flex-1 overflow-y-auto px-6 py-2">
                    {loading ? (
                        <div className="text-center text-slate-400 py-8 text-sm">載入中⋯</div>
                    ) : filtered.length === 0 ? (
                        <div className="text-center text-slate-400 py-8 text-sm">沒有符合的使用者</div>
                    ) : (
                        <div className="space-y-1">
                            {filtered.slice(0, 50).map(u => (
                                <label key={u.id}
                                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer hover:bg-slate-50 ${selectedUserId === u.id ? 'bg-blue-50 ring-1 ring-blue-200' : ''}`}>
                                    <input
                                        type="radio" name="user"
                                        checked={selectedUserId === u.id}
                                        onChange={() => setSelectedUserId(u.id)}
                                        className="accent-blue-600"
                                    />
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-medium text-slate-800 truncate">{u.name || '(無姓名)'}</div>
                                        <div className="text-xs text-slate-500 truncate">{u.email}</div>
                                    </div>
                                    <span className="text-xs text-slate-400 px-2 py-0.5 bg-slate-100 rounded-full">{u.role}</span>
                                </label>
                            ))}
                            {filtered.length > 50 && (
                                <div className="text-xs text-slate-400 text-center pt-2">已顯示前 50 筆,請以搜尋縮小範圍</div>
                            )}
                        </div>
                    )}
                </div>

                {err && (
                    <div className="px-6 pt-2 text-sm text-rose-600">{err}</div>
                )}

                <div className="px-6 py-3 border-t border-slate-100 flex justify-end gap-2">
                    <button onClick={onClose}
                        className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-bold text-sm">
                        取消
                    </button>
                    <button onClick={doLink} disabled={saving || !selectedUserId}
                        className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm disabled:opacity-50">
                        {saving ? '綁定中⋯' : '確認綁定'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default InstructorList;
