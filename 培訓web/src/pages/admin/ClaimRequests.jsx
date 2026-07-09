import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { ArrowLeft, Check, X, Inbox, ChevronDown, ChevronUp, Mail, Phone, MessageSquare, Clock, ShieldCheck, Ban } from 'lucide-react';

const TABS = [
    { key: 'pending',  label: '待審核', color: 'text-bauhaus-black', bg: 'bg-bauhaus-yellow text-bauhaus-black' },
    { key: 'approved', label: '已通過', color: 'text-bauhaus-black', bg: 'bg-bauhaus-blue text-white' },
    { key: 'rejected', label: '已拒絕', color: 'text-bauhaus-black', bg: 'bg-bauhaus-muted text-bauhaus-black' },
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
            <Link to="/admin" className="inline-flex items-center gap-1 text-sm font-bold text-bauhaus-black/60 hover:text-bauhaus-black mb-4 min-h-[44px]">
                <ArrowLeft className="w-4 h-4" /> 返回後台
            </Link>

            <div className="mb-6">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">講師資料認領申請</h1>
                <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">
                    當使用者的 Email 與歷史講師資料不一致時,會在此提出認領申請。請核對後決定通過或拒絕。
                </p>
            </div>

            <div className="inline-flex border-2 lg:border-4 border-bauhaus-black divide-x-2 divide-bauhaus-black mb-6">
                {TABS.map(t => (
                    <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        className={`px-4 py-3 text-sm font-bold uppercase tracking-wide transition-colors duration-200 ${
                            tab === t.key ? 'bg-bauhaus-black text-white' : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                        }`}
                    >
                        {t.label}
                        <span className={`ml-2 bh-chip ${tab === t.key ? t.bg : 'bg-bauhaus-muted text-bauhaus-black'} !border-0 !px-1.5`}>
                            {counts[t.key] || 0}
                        </span>
                    </button>
                ))}
            </div>

            {loading ? (
                <div className="text-center text-bauhaus-black/50 py-16 font-bold">載入中⋯</div>
            ) : filtered.length === 0 ? (
                <div className="text-center text-bauhaus-black/50 py-16">
                    <Inbox className="w-12 h-12 mx-auto mb-3 text-bauhaus-black/20" />
                    <p className="font-medium">目前沒有{TABS.find(t => t.key === tab)?.label}的申請</p>
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
        <div className="bh-card overflow-hidden">
            <div className="p-4 flex items-start gap-3 cursor-pointer hover:bg-bauhaus-cream transition-colors" onClick={onToggle}>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-bauhaus-black">
                            {claim.requester?.name || '(無姓名)'}
                        </span>
                        <span className="text-xs text-bauhaus-black/50">→ 認領</span>
                        <span className="font-bold text-bauhaus-blue">
                            {claim.instructor?.full_name || '(資料已刪除)'}
                        </span>
                        {instructorLinked && claim.status === 'pending' && (
                            <span className="bh-chip bg-bauhaus-red text-white">
                                ⚠️ 目標已被綁定
                            </span>
                        )}
                    </div>
                    <div className="text-xs text-bauhaus-black/50 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" /> {claim.requester_email}</span>
                        {claim.proposed_phone && (
                            <span className="inline-flex items-center gap-1"><Phone className="w-3 h-3" /> 提供手機: {claim.proposed_phone}</span>
                        )}
                        <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> {new Date(claim.created_at).toLocaleString('zh-TW')}</span>
                    </div>
                </div>
                <button className="relative shrink-0 text-bauhaus-black/40 hover:text-bauhaus-black transition-colors p-1 before:absolute before:-inset-2 before:content-['']">
                    {expanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                </button>
            </div>

            {expanded && (
                <div className="px-4 pb-4 pt-0 bg-bauhaus-cream border-t-2 border-bauhaus-black">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                        <Block title="申請人(登入帳號)" tone="blue">
                            <Row label="姓名" value={claim.requester?.name} />
                            <Row label="登入 Email" value={claim.requester?.email} />
                            <Row label="目前角色" value={claim.requester?.role} />
                        </Block>
                        <Block title="目標講師資料" tone="black">
                            <Row label="姓名" value={claim.instructor?.full_name} />
                            <Row label="檔案 Email" value={claim.instructor?.email_primary} />
                            <Row label="檔案手機" value={claim.instructor?.phone_mobile} />
                            <Row label="業務狀態" value={claim.instructor?.employment_status} />
                            <Row label="講師等級" value={claim.instructor?.instructor_role} />
                        </Block>
                    </div>

                    {claim.message && (
                        <div className="mt-3 bg-bauhaus-yellow border-2 border-bauhaus-black p-3">
                            <div className="text-xs font-bold text-bauhaus-black flex items-center gap-1 mb-1">
                                <MessageSquare className="w-3 h-3" /> 申請說明
                            </div>
                            <p className="text-sm text-bauhaus-black whitespace-pre-wrap">{claim.message}</p>
                        </div>
                    )}

                    {claim.status !== 'pending' && (
                        <div className="mt-3 text-xs text-bauhaus-black/60 flex items-center gap-1 font-medium">
                            {claim.status === 'approved' ? (
                                <>
                                    <ShieldCheck className="w-3.5 h-3.5 text-bauhaus-blue" />
                                    <span>於 {new Date(claim.reviewed_at).toLocaleString('zh-TW')} 通過</span>
                                </>
                            ) : (
                                <>
                                    <Ban className="w-3.5 h-3.5 text-bauhaus-red" />
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
                                className="bh-btn bh-btn-red px-4 py-2 text-sm">
                                <X className="w-4 h-4" /> 拒絕
                            </button>
                            <button onClick={onApprove} disabled={instructorLinked}
                                className="bh-btn bh-btn-blue px-4 py-2 text-sm">
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
        blue: 'bg-white border-bauhaus-black',
        black: 'bg-bauhaus-muted border-bauhaus-black',
    }[tone] || 'bg-white border-bauhaus-black';
    return (
        <div className={`${toneCls} border-2 p-3`}>
            <div className="bh-label mb-2">{title}</div>
            <div className="space-y-1">{children}</div>
        </div>
    );
};

const Row = ({ label, value }) => (
    <div className="flex items-start gap-2 text-sm">
        <span className="text-bauhaus-black/40 whitespace-nowrap min-w-[80px]">{label}:</span>
        <span className="text-bauhaus-black/80 break-all">{value || <span className="text-bauhaus-black/30">—</span>}</span>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-bauhaus-black/60 p-4">
            <div className="bh-card shadow-hard-lg max-w-md w-full p-6 max-h-[85dvh] overflow-y-auto">
                <h2 className="font-black text-bauhaus-black mb-2 uppercase tracking-wide">拒絕認領申請</h2>
                <p className="text-sm text-bauhaus-black/60 mb-4 font-medium">可選填理由,會記錄在審核紀錄裡(申請人目前不會看到)。</p>
                <textarea
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    rows={3}
                    placeholder="例:該講師資料另有歸屬"
                    className="bh-input text-sm resize-none"
                />
                <div className="flex justify-end gap-2 mt-4">
                    <button onClick={onClose}
                        className="bh-btn bh-btn-outline px-4 py-2 text-sm">
                        取消
                    </button>
                    <button onClick={submit} disabled={saving}
                        className="bh-btn bh-btn-red px-5 py-2 text-sm">
                        {saving ? '送出⋯' : '確認拒絕'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default ClaimRequests;
