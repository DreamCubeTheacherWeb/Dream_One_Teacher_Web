import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { ArrowLeft, Check, X, Inbox, ChevronDown, ChevronUp, Mail, Phone, MessageSquare, Clock, ShieldCheck, Ban } from 'lucide-react';

const TABS = [
    { key: 'pending',  label: '待審核', color: 'text-amber-600',  bg: 'bg-amber-50' },
    { key: 'approved', label: '已通過', color: 'text-green-600',  bg: 'bg-green-50' },
    { key: 'rejected', label: '已拒絕', color: 'text-slate-500',  bg: 'bg-slate-100' },
];

const ClaimRequests = () => {
    const [tab, setTab] = useState('pending');
    const [claims, setClaims] = useState([]);
    const [loading, setLoading] = useState(true);
    const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 });
    const [expandedId, setExpandedId] = useState(null);
    const [rejectingId, setRejectingId] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);

        const { data, error } = await supabase
            .from('instructor_claim_requests')
            .select(`
                id, status, requester_email, proposed_phone, message,
                review_notes, reviewed_at, created_at,
                requester:requester_user_id ( id, name, email, role ),
                instructor:instructor_id (
                    id, full_name, email_primary, phone_mobile,
                    employment_status, instructor_role, user_id
                )
            `)
            .order('created_at', { ascending: false })
            .limit(200);

        if (error) {
            console.error(error);
            setClaims([]);
        } else {
            setClaims(data || []);
        }

        // counts
        const { data: countData } = await supabase
            .from('instructor_claim_requests')
            .select('status');
        const c = { pending: 0, approved: 0, rejected: 0 };
        (countData || []).forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
        setCounts(c);

        setLoading(false);
    }, []);

    useEffect(() => { load(); }, [load]);

    const filtered = claims.filter(c => c.status === tab);

    const approve = async (claim) => {
        if (!confirm(`通過認領?\n申請人 ${claim.requester?.name || claim.requester_email} 將取得 ${claim.instructor?.full_name} 的講師資料,並升級為 teacher 角色。`)) return;
        const { error } = await supabase.rpc('approve_claim_request', { claim_id_input: claim.id });
        if (error) {
            alert('通過失敗:' + error.message);
            return;
        }
        await load();
    };

    return (
        <div className="p-4 sm:p-8">
            <Link to="/admin" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-blue-600 mb-4">
                <ArrowLeft className="w-4 h-4" /> 返回後台
            </Link>

            <div className="mb-6">
                <h1 className="text-2xl sm:text-3xl font-black text-slate-900">講師資料認領申請</h1>
                <p className="text-slate-500 mt-1 text-sm">
                    當使用者的 Email 與歷史講師資料不一致時,會在此提出認領申請。請核對後決定通過或拒絕。
                </p>
            </div>

            <div className="flex gap-2 mb-6 border-b border-slate-100">
                {TABS.map(t => (
                    <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        className={`px-4 py-3 -mb-px font-bold text-sm border-b-2 transition-colors ${
                            tab === t.key
                                ? `border-blue-500 ${t.color}`
                                : 'border-transparent text-slate-400 hover:text-slate-600'
                        }`}
                    >
                        {t.label}
                        <span className={`ml-2 text-xs px-2 py-0.5 rounded-full ${tab === t.key ? t.bg : 'bg-slate-100 text-slate-500'}`}>
                            {counts[t.key] || 0}
                        </span>
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="text-center text-slate-400 py-16">載入中⋯</div>
            ) : filtered.length === 0 ? (
                <div className="text-center text-slate-400 py-16">
                    <Inbox className="w-12 h-12 mx-auto mb-3 text-slate-200" />
                    <p>目前沒有{TABS.find(t => t.key === tab)?.label}的申請</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {filtered.map(claim => (
                        <ClaimCard
                            key={claim.id}
                            claim={claim}
                            expanded={expandedId === claim.id}
                            onToggle={() => setExpandedId(expandedId === claim.id ? null : claim.id)}
                            onApprove={() => approve(claim)}
                            onReject={() => setRejectingId(claim.id)}
                        />
                    ))}
                </div>
            )}

            {rejectingId && (
                <RejectModal
                    claimId={rejectingId}
                    onClose={() => setRejectingId(null)}
                    onDone={() => { setRejectingId(null); load(); }}
                />
            )}
        </div>
    );
};

const ClaimCard = ({ claim, expanded, onToggle, onApprove, onReject }) => {
    const instructorLinked = !!claim.instructor?.user_id;
    return (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="p-4 flex items-start gap-3 cursor-pointer hover:bg-slate-50 transition-colors" onClick={onToggle}>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-slate-900">
                            {claim.requester?.name || '(無姓名)'}
                        </span>
                        <span className="text-xs text-slate-500">→ 認領</span>
                        <span className="font-bold text-blue-700">
                            {claim.instructor?.full_name || '(資料已刪除)'}
                        </span>
                        {instructorLinked && claim.status === 'pending' && (
                            <span className="text-xs bg-rose-50 text-rose-600 px-2 py-0.5 rounded-full font-bold">
                                ⚠️ 目標已被綁定
                            </span>
                        )}
                    </div>
                    <div className="text-xs text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" /> {claim.requester_email}</span>
                        {claim.proposed_phone && (
                            <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> 提供手機: {claim.proposed_phone}</span>
                        )}
                        <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(claim.created_at).toLocaleString('zh-TW')}</span>
                    </div>
                </div>
                <button className="shrink-0 text-slate-400 hover:text-blue-600 transition-colors p-1">
                    {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                </button>
            </div>

            {expanded && (
                <div className="px-4 pb-4 pt-0 bg-slate-50/50 border-t border-slate-100">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                        <Block title="申請人(登入帳號)" tone="blue">
                            <Row label="姓名" value={claim.requester?.name} />
                            <Row label="登入 Email" value={claim.requester?.email} />
                            <Row label="目前角色" value={claim.requester?.role} />
                        </Block>
                        <Block title="目標講師資料" tone="purple">
                            <Row label="姓名" value={claim.instructor?.full_name} />
                            <Row label="檔案 Email" value={claim.instructor?.email_primary} />
                            <Row label="檔案手機" value={claim.instructor?.phone_mobile} />
                            <Row label="業務狀態" value={claim.instructor?.employment_status} />
                            <Row label="講師等級" value={claim.instructor?.instructor_role} />
                        </Block>
                    </div>

                    {claim.message && (
                        <div className="mt-3 bg-amber-50 border border-amber-200 rounded-xl p-3">
                            <div className="text-xs font-bold text-amber-700 flex items-center gap-1 mb-1">
                                <MessageSquare className="w-3 h-3" /> 申請說明
                            </div>
                            <p className="text-sm text-amber-900 whitespace-pre-wrap">{claim.message}</p>
                        </div>
                    )}

                    {claim.status !== 'pending' && (
                        <div className="mt-3 text-xs text-slate-500 flex items-center gap-1">
                            {claim.status === 'approved' ? (
                                <>
                                    <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
                                    <span>於 {new Date(claim.reviewed_at).toLocaleString('zh-TW')} 通過</span>
                                </>
                            ) : (
                                <>
                                    <Ban className="w-3.5 h-3.5 text-rose-500" />
                                    <span>於 {new Date(claim.reviewed_at).toLocaleString('zh-TW')} 拒絕</span>
                                </>
                            )}
                            {claim.review_notes && (
                                <span className="ml-2">— {claim.review_notes}</span>
                            )}
                        </div>
                    )}

                    {claim.status === 'pending' && (
                        <div className="flex justify-end gap-2 mt-4">
                            <button onClick={onReject}
                                className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-white border border-rose-200 text-rose-600 hover:bg-rose-50 font-bold text-sm">
                                <X className="w-4 h-4" /> 拒絕
                            </button>
                            <button onClick={onApprove} disabled={instructorLinked}
                                className="inline-flex items-center gap-1 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed">
                                <Check className="w-4 h-4" /> 通過認領
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const Block = ({ title, tone, children }) => {
    const toneCls = {
        blue: 'bg-blue-50 border-blue-100',
        purple: 'bg-purple-50 border-purple-100',
    }[tone] || 'bg-slate-50 border-slate-100';
    return (
        <div className={`${toneCls} border rounded-xl p-3`}>
            <div className="text-xs font-bold text-slate-700 mb-2">{title}</div>
            <div className="space-y-1">{children}</div>
        </div>
    );
};

const Row = ({ label, value }) => (
    <div className="flex items-start gap-2 text-sm">
        <span className="text-slate-400 whitespace-nowrap min-w-[80px]">{label}:</span>
        <span className="text-slate-700 break-all">{value || <span className="text-slate-300">—</span>}</span>
    </div>
);

const RejectModal = ({ claimId, onClose, onDone }) => {
    const [notes, setNotes] = useState('');
    const [saving, setSaving] = useState(false);

    const submit = async () => {
        setSaving(true);
        const { error } = await supabase.rpc('reject_claim_request', {
            claim_id_input: claimId,
            notes: notes.trim() || null,
        });
        setSaving(false);
        if (error) {
            alert('拒絕失敗:' + error.message);
            return;
        }
        onDone();
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6">
                <h2 className="font-bold text-lg text-slate-900 mb-2">拒絕認領申請</h2>
                <p className="text-sm text-slate-500 mb-4">可選填理由,會記錄在審核紀錄裡(申請人目前不會看到)。</p>
                <textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    rows={3}
                    placeholder="例:該講師資料另有歸屬"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 focus:border-rose-300 outline-none text-sm resize-none"
                />
                <div className="flex justify-end gap-2 mt-4">
                    <button onClick={onClose}
                        className="px-4 py-2 rounded-lg text-slate-600 hover:bg-slate-100 font-bold text-sm">
                        取消
                    </button>
                    <button onClick={submit} disabled={saving}
                        className="px-5 py-2 rounded-lg bg-rose-500 hover:bg-rose-600 text-white font-bold text-sm disabled:opacity-50">
                        {saving ? '送出⋯' : '確認拒絕'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ClaimRequests;
