import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import {
    ArrowLeft, Send, CalendarClock, AlertTriangle, XCircle, Trash2, Bell,
} from 'lucide-react';

const AUDIENCE_OPTIONS = [
    { value: 'teachers', label: '全體講師（teacher + mentor）' },
    { value: 'all', label: '全站（所有非 pending 使用者）' },
];

const REPEAT_OPTIONS = [
    { value: 'none', label: '不重複' },
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: '每週' },
    { value: 'monthly', label: '每月' },
];

const STATUS_BADGE = {
    pending: { label: '待發送', className: 'bg-bauhaus-yellow text-bauhaus-black' },
    sent: { label: '已發送', className: 'bg-bauhaus-blue text-white' },
    cancelled: { label: '已取消', className: 'bg-bauhaus-muted text-bauhaus-black' },
};

const REPEAT_LABEL = REPEAT_OPTIONS.reduce((acc, o) => ({ ...acc, [o.value]: o.label }), {});
const AUDIENCE_LABEL = {
    teachers: '全體講師',
    all: '全站',
};

// 後端 SQL 尚未套用時的錯誤判斷：RPC 找不到（PGRST202 / Could not find the function）
// 或資料表不存在（42P01 / PGRST205）。
const isBackendMissingRpcError = (error) => {
    if (!error) return false;
    return error.code === 'PGRST202' || /Could not find the function/i.test(error.message || '');
};
const isBackendMissingTableError = (error) => {
    if (!error) return false;
    return error.code === '42P01' || error.code === 'PGRST205' || /does not exist/i.test(error.message || '');
};

const BACKEND_MISSING_MSG = '後端 SQL 尚未套用（2026-07-09_notification_center.sql），請先到 Supabase 執行後再回來使用本頁。';

const emptyForm = () => ({
    title: '',
    body: '',
    link: '',
    audience: 'teachers',
});

const NotificationManager = () => {
    const { user } = useAuth();

    // 立即發送
    const [sendForm, setSendForm] = useState(emptyForm());
    const [sending, setSending] = useState(false);
    const [sendResult, setSendResult] = useState(null); // { type: 'success'|'error'|'backend-missing', msg }

    // 排程
    const [scheduleForm, setScheduleForm] = useState({ ...emptyForm(), sendAt: '', repeatRule: 'none' });
    const [scheduling, setScheduling] = useState(false);
    const [scheduleResult, setScheduleResult] = useState(null);

    // 排程清單
    const [list, setList] = useState([]);
    const [listLoading, setListLoading] = useState(true);
    const [listBackendMissing, setListBackendMissing] = useState(false);
    const [listError, setListError] = useState('');
    const [cancellingId, setCancellingId] = useState(null);

    // 排序規則：pending 依 send_at 升冪排前；sent/cancelled 當歷史紀錄依 send_at 降冪排在後面。
    const sortList = (data) => {
        const pending = (data || [])
            .filter((r) => r.status === 'pending')
            .sort((a, b) => new Date(a.send_at) - new Date(b.send_at));
        const history = (data || [])
            .filter((r) => r.status !== 'pending')
            .sort((a, b) => new Date(b.send_at) - new Date(a.send_at));
        return [...pending, ...history];
    };

    // 給操作完成後（建立排程／取消排程）重新整理清單用；掛載時的初次載入見下方 useEffect
    // （刻意各自獨立呼叫 supabase，不共用同一個函式參照，避免觸發
    // react-hooks/set-state-in-effect：effect 內只能直接 setState，不能呼叫外部具名函式）。
    const fetchList = async () => {
        setListLoading(true);
        setListError('');
        setListBackendMissing(false);

        const { data, error } = await supabase
            .from('scheduled_notifications')
            .select('id, title, body, link, audience, send_at, repeat_rule, status, last_sent_at, created_at')
            .order('status', { ascending: true })
            .order('send_at', { ascending: false })
            .limit(50);

        if (error) {
            if (isBackendMissingTableError(error)) {
                setListBackendMissing(true);
            } else {
                setListError(error.message);
            }
            setListLoading(false);
            return;
        }

        setList(sortList(data));
        setListLoading(false);
    };

    useEffect(() => {
        (async () => {
            setListLoading(true);
            setListError('');
            setListBackendMissing(false);

            const { data, error } = await supabase
                .from('scheduled_notifications')
                .select('id, title, body, link, audience, send_at, repeat_rule, status, last_sent_at, created_at')
                .order('status', { ascending: true })
                .order('send_at', { ascending: false })
                .limit(50);

            if (error) {
                if (isBackendMissingTableError(error)) {
                    setListBackendMissing(true);
                } else {
                    setListError(error.message);
                }
                setListLoading(false);
                return;
            }

            setList(sortList(data));
            setListLoading(false);
        })();
    }, []);

    const handleSend = async (e) => {
        e.preventDefault();
        setSendResult(null);

        if (!sendForm.title.trim()) {
            setSendResult({ type: 'error', msg: '標題為必填' });
            return;
        }

        const audienceLabel = AUDIENCE_OPTIONS.find((o) => o.value === sendForm.audience)?.label || sendForm.audience;
        if (!window.confirm(`確定要立即發送通知給「${audienceLabel}」嗎？\n標題：${sendForm.title.trim()}`)) {
            return;
        }

        setSending(true);
        const { data, error } = await supabase.rpc('admin_broadcast_notification', {
            p_title: sendForm.title.trim(),
            p_body: sendForm.body.trim() || null,
            p_link: sendForm.link.trim() || null,
            p_audience: sendForm.audience,
        });
        setSending(false);

        if (error) {
            if (isBackendMissingRpcError(error)) {
                setSendResult({ type: 'backend-missing', msg: BACKEND_MISSING_MSG });
            } else {
                setSendResult({ type: 'error', msg: '發送失敗：' + error.message });
            }
            return;
        }

        setSendResult({ type: 'success', msg: `已發送給 ${data ?? 0} 位` });
        setSendForm(emptyForm());
    };

    const handleSchedule = async (e) => {
        e.preventDefault();
        setScheduleResult(null);

        if (!scheduleForm.title.trim()) {
            setScheduleResult({ type: 'error', msg: '標題為必填' });
            return;
        }
        if (!scheduleForm.sendAt) {
            setScheduleResult({ type: 'error', msg: '發送時間為必填' });
            return;
        }
        const sendAtDate = new Date(scheduleForm.sendAt);
        if (Number.isNaN(sendAtDate.getTime()) || sendAtDate.getTime() <= Date.now()) {
            setScheduleResult({ type: 'error', msg: '發送時間必須是未來的時間' });
            return;
        }

        setScheduling(true);
        const { error } = await supabase.from('scheduled_notifications').insert({
            title: scheduleForm.title.trim(),
            body: scheduleForm.body.trim() || null,
            link: scheduleForm.link.trim() || null,
            audience: scheduleForm.audience,
            send_at: sendAtDate.toISOString(),
            repeat_rule: scheduleForm.repeatRule,
            created_by: user?.id || null,
        });
        setScheduling(false);

        if (error) {
            if (isBackendMissingTableError(error)) {
                setScheduleResult({ type: 'backend-missing', msg: BACKEND_MISSING_MSG });
            } else {
                setScheduleResult({ type: 'error', msg: '建立排程失敗：' + error.message });
            }
            return;
        }

        setScheduleResult({ type: 'success', msg: '排程已建立' });
        setScheduleForm({ ...emptyForm(), sendAt: '', repeatRule: 'none' });
        fetchList();
    };

    const handleCancel = async (row) => {
        if (!window.confirm(`確定要取消這則排程通知嗎？\n標題：${row.title}`)) return;

        setCancellingId(row.id);
        const { error } = await supabase
            .from('scheduled_notifications')
            .update({ status: 'cancelled' })
            .eq('id', row.id)
            .eq('status', 'pending');
        setCancellingId(null);

        if (error) {
            alert('取消失敗：' + error.message);
            return;
        }
        fetchList();
    };

    return (
        <div className="p-4 sm:p-8 max-w-4xl mx-auto">
            <Link to="/admin" className="inline-flex items-center gap-1 text-sm font-bold text-bauhaus-black/60 hover:text-bauhaus-black mb-4 min-h-[44px]">
                <ArrowLeft className="w-4 h-4" /> 返回後台
            </Link>

            <div className="mb-8">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight flex items-center gap-3">
                    <Bell className="w-7 h-7" /> 廣播通知
                </h1>
                <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">
                    與「公告」的差別：公告發布（佈告欄管理）本來就會自動推播通知；本頁不發公告，只發小鈴鐺通知。
                </p>
            </div>

            {/* 立即發送 */}
            <form onSubmit={handleSend} className="bh-card p-6 mb-8">
                <div className="flex items-center gap-2 mb-4">
                    <Send className="w-4 h-4 text-bauhaus-black/50" />
                    <h2 className="font-black text-bauhaus-black uppercase tracking-wide">立即發送</h2>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="bh-label block mb-1">標題（必填）</label>
                        <input
                            type="text"
                            value={sendForm.title}
                            onChange={(e) => setSendForm((f) => ({ ...f, title: e.target.value }))}
                            className="bh-input"
                            placeholder="例：本週培訓提醒"
                        />
                    </div>
                    <div>
                        <label className="bh-label block mb-1">內文（選填）</label>
                        <textarea
                            value={sendForm.body}
                            onChange={(e) => setSendForm((f) => ({ ...f, body: e.target.value }))}
                            className="bh-input min-h-[88px]"
                            placeholder="通知內容說明"
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="bh-label block mb-1">連結（選填）</label>
                            <input
                                type="text"
                                value={sendForm.link}
                                onChange={(e) => setSendForm((f) => ({ ...f, link: e.target.value }))}
                                className="bh-input"
                                placeholder="站內路徑如 /leaderboard，或完整網址"
                            />
                        </div>
                        <div>
                            <label className="bh-label block mb-1">發送對象</label>
                            <select
                                value={sendForm.audience}
                                onChange={(e) => setSendForm((f) => ({ ...f, audience: e.target.value }))}
                                className="bh-input"
                            >
                                {AUDIENCE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between mt-5 gap-4 flex-wrap">
                    <div className="min-h-[20px] flex-1 min-w-[200px]">
                        {sendResult?.type === 'success' && (
                            <span className="text-sm font-bold text-bauhaus-blue">{sendResult.msg}</span>
                        )}
                        {sendResult?.type === 'error' && (
                            <span className="inline-flex items-center gap-1 text-sm font-bold text-bauhaus-red">
                                <XCircle className="w-4 h-4" /> {sendResult.msg}
                            </span>
                        )}
                        {sendResult?.type === 'backend-missing' && (
                            <span className="inline-flex items-start gap-1 text-sm font-bold text-bauhaus-black bg-bauhaus-yellow px-2 py-1">
                                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {sendResult.msg}
                            </span>
                        )}
                    </div>
                    <button type="submit" disabled={sending} className="bh-btn bh-btn-blue px-6 py-2.5">
                        <Send className="w-4 h-4" /> {sending ? '發送中...' : '立即發送'}
                    </button>
                </div>
            </form>

            {/* 排程通知 */}
            <form onSubmit={handleSchedule} className="bh-card p-6 mb-8">
                <div className="flex items-center gap-2 mb-4">
                    <CalendarClock className="w-4 h-4 text-bauhaus-black/50" />
                    <h2 className="font-black text-bauhaus-black uppercase tracking-wide">排程通知</h2>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="bh-label block mb-1">標題（必填）</label>
                        <input
                            type="text"
                            value={scheduleForm.title}
                            onChange={(e) => setScheduleForm((f) => ({ ...f, title: e.target.value }))}
                            className="bh-input"
                            placeholder="例：每月薪資公告提醒"
                        />
                    </div>
                    <div>
                        <label className="bh-label block mb-1">內文（選填）</label>
                        <textarea
                            value={scheduleForm.body}
                            onChange={(e) => setScheduleForm((f) => ({ ...f, body: e.target.value }))}
                            className="bh-input min-h-[88px]"
                            placeholder="通知內容說明"
                        />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="bh-label block mb-1">連結（選填）</label>
                            <input
                                type="text"
                                value={scheduleForm.link}
                                onChange={(e) => setScheduleForm((f) => ({ ...f, link: e.target.value }))}
                                className="bh-input"
                                placeholder="站內路徑如 /leaderboard，或完整網址"
                            />
                        </div>
                        <div>
                            <label className="bh-label block mb-1">發送對象</label>
                            <select
                                value={scheduleForm.audience}
                                onChange={(e) => setScheduleForm((f) => ({ ...f, audience: e.target.value }))}
                                className="bh-input"
                            >
                                {AUDIENCE_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className="bh-label block mb-1">發送時間（必填）</label>
                            <input
                                type="datetime-local"
                                value={scheduleForm.sendAt}
                                onChange={(e) => setScheduleForm((f) => ({ ...f, sendAt: e.target.value }))}
                                className="bh-input"
                            />
                        </div>
                        <div>
                            <label className="bh-label block mb-1">重複</label>
                            <select
                                value={scheduleForm.repeatRule}
                                onChange={(e) => setScheduleForm((f) => ({ ...f, repeatRule: e.target.value }))}
                                className="bh-input"
                            >
                                {REPEAT_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between mt-5 gap-4 flex-wrap">
                    <div className="min-h-[20px] flex-1 min-w-[200px]">
                        {scheduleResult?.type === 'success' && (
                            <span className="text-sm font-bold text-bauhaus-blue">{scheduleResult.msg}</span>
                        )}
                        {scheduleResult?.type === 'error' && (
                            <span className="inline-flex items-center gap-1 text-sm font-bold text-bauhaus-red">
                                <XCircle className="w-4 h-4" /> {scheduleResult.msg}
                            </span>
                        )}
                        {scheduleResult?.type === 'backend-missing' && (
                            <span className="inline-flex items-start gap-1 text-sm font-bold text-bauhaus-black bg-bauhaus-yellow px-2 py-1">
                                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {scheduleResult.msg}
                            </span>
                        )}
                    </div>
                    <button type="submit" disabled={scheduling} className="bh-btn bh-btn-yellow px-6 py-2.5">
                        <CalendarClock className="w-4 h-4" /> {scheduling ? '建立中...' : '建立排程'}
                    </button>
                </div>
            </form>

            {/* 排程清單 */}
            <div className="bh-card overflow-hidden">
                <div className="p-6 border-b-2 lg:border-b-4 border-bauhaus-black">
                    <h2 className="font-black text-bauhaus-black uppercase tracking-wide">排程清單</h2>
                </div>

                {listLoading && (
                    <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>
                )}

                {!listLoading && listBackendMissing && (
                    <div className="p-6 flex items-start gap-3 bg-bauhaus-yellow">
                        <AlertTriangle className="w-6 h-6 text-bauhaus-black shrink-0 mt-0.5" />
                        <div>
                            <div className="font-black text-bauhaus-black">資料表尚未建立</div>
                            <p className="text-sm font-medium text-bauhaus-black/80 mt-1">{BACKEND_MISSING_MSG}</p>
                        </div>
                    </div>
                )}

                {!listLoading && !listBackendMissing && listError && (
                    <div className="p-6 bg-bauhaus-red text-white">
                        <div className="font-black">讀取失敗</div>
                        <p className="text-sm font-medium mt-1">{listError}</p>
                    </div>
                )}

                {!listLoading && !listBackendMissing && !listError && list.length === 0 && (
                    <div className="p-12 text-center text-bauhaus-black/50 font-bold">目前沒有排程通知</div>
                )}

                {!listLoading && !listBackendMissing && !listError && list.length > 0 && (
                    <div className="divide-y-2 divide-bauhaus-black/20">
                        {list.map((row) => {
                            const badge = STATUS_BADGE[row.status] || STATUS_BADGE.pending;
                            return (
                                <div key={row.id} className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex flex-wrap items-center gap-2 mb-1">
                                            <span className="font-bold text-bauhaus-black break-words">{row.title}</span>
                                            <span className={`bh-chip text-xs font-bold ${badge.className}`}>{badge.label}</span>
                                        </div>
                                        <div className="text-xs text-bauhaus-black/60 font-medium flex flex-wrap gap-x-3">
                                            <span>對象：{AUDIENCE_LABEL[row.audience] || row.audience}</span>
                                            <span>時間：{row.send_at ? new Date(row.send_at).toLocaleString('zh-TW') : '—'}</span>
                                            <span>重複：{REPEAT_LABEL[row.repeat_rule] || row.repeat_rule}</span>
                                        </div>
                                    </div>
                                    {row.status === 'pending' && (
                                        <button
                                            onClick={() => handleCancel(row)}
                                            disabled={cancellingId === row.id}
                                            className="bh-btn bh-btn-outline px-4 py-2.5 text-sm shrink-0 min-h-[44px]"
                                        >
                                            <Trash2 className="w-4 h-4" /> {cancellingId === row.id ? '取消中...' : '取消'}
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

export default NotificationManager;
