import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, RefreshCw, Search, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { supabase } from '../../lib/supabaseClient';
import { getInstructorProfileCompletion } from '../../lib/profileCompletion';

const DEFAULT_MENTORS = ['懶懶', '叮叮', '樹懶'];
const ROLE_CONFIG = {
    pending: { label: '待審核', className: 'bg-bauhaus-yellow text-bauhaus-black' },
    teacher: { label: '講師', className: 'bg-bauhaus-blue text-white' },
    mentor: { label: '輔導員', className: 'bg-bauhaus-muted text-bauhaus-black' },
    admin: { label: '管理員', className: 'bg-bauhaus-black text-white' },
};
const BLOCKED_STATUSES = new Set(['frozen', 'cancelled']);

const TeacherManager = () => {
    const [users, setUsers] = useState([]);
    const [instructors, setInstructors] = useState([]);
    const [loading, setLoading] = useState(true);
    const [busyId, setBusyId] = useState(null);
    const [tab, setTab] = useState('pending');
    const [search, setSearch] = useState('');
    const [mentorOptions, setMentorOptions] = useState(DEFAULT_MENTORS);

    const fetchData = useCallback(async () => {
        setLoading(true);
        const [usersResult, instructorsResult] = await Promise.all([
            supabase.from('users').select('*').order('created_at', { ascending: false }),
            supabase.from('instructors').select('*').order('full_name'),
        ]);
        if (usersResult.error) console.error('讀取帳號失敗：', usersResult.error.message);
        if (instructorsResult.error) console.error('讀取講師主檔失敗：', instructorsResult.error.message);
        const nextUsers = usersResult.data || [];
        setUsers(nextUsers);
        setInstructors(instructorsResult.data || []);
        const storedMentors = nextUsers.map((item) => item.mentor_name).filter(Boolean);
        setMentorOptions([...new Set([...DEFAULT_MENTORS, ...storedMentors])]);
        setLoading(false);
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(fetchData, 0);
        return () => window.clearTimeout(timer);
    }, [fetchData]);

    const instructorByUserId = useMemo(
        () => new Map(instructors.filter((item) => item.user_id).map((item) => [item.user_id, item])),
        [instructors],
    );

    const roleCounts = useMemo(() => Object.keys(ROLE_CONFIG).reduce((counts, role) => {
        counts[role] = users.filter((item) => item.role === role).length;
        return counts;
    }, {}), [users]);

    const filteredUsers = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return users.filter((account) => {
            if (account.role !== tab) return false;
            if (!keyword) return true;
            const instructor = instructorByUserId.get(account.id);
            return [account.name, account.email, instructor?.full_name, instructor?.phone_mobile]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(keyword);
        });
    }, [instructorByUserId, search, tab, users]);

    const claimedCount = instructors.filter((item) => item.user_id).length;
    const unclaimedCount = instructors.length - claimedCount;

    const approvePending = async (account) => {
        const instructor = instructorByUserId.get(account.id);
        if (!instructor) {
            alert('此帳號尚未建立講師主檔，請對方先完成個人資料。');
            return;
        }
        const completion = getInstructorProfileCompletion(instructor);
        if (!completion.complete) {
            alert('資料尚未完成：\n' + completion.missingItems.map((item) => `• ${item}`).join('\n'));
            return;
        }
        if (BLOCKED_STATUSES.has(instructor.employment_status)) {
            alert('已凍結或停止合作的講師不能開啟帳號。');
            return;
        }
        if (!window.confirm(`確認核准 ${instructor.full_name || account.email} 的新講師帳號？`)) return;

        setBusyId(account.id);
        const { error } = await supabase.rpc('approve_new_instructor_account', {
            target_user_id: account.id,
        });
        setBusyId(null);
        if (error) {
            alert('核准失敗：' + error.message);
            return;
        }
        await fetchData();
    };

    const changeRole = async (account, role) => {
        if (role === account.role) return;
        if (role === 'teacher' && account.role === 'pending') {
            await approvePending(account);
            return;
        }
        const label = ROLE_CONFIG[role]?.label || role;
        if (!window.confirm(`確定將 ${account.name || account.email} 的角色改為「${label}」？`)) return;
        setBusyId(account.id);
        const { error } = await supabase.from('users').update({ role }).eq('id', account.id);
        setBusyId(null);
        if (error) {
            alert('角色更新失敗：' + error.message);
            return;
        }
        await fetchData();
    };

    const changeMentor = async (account, rawValue) => {
        let value = rawValue;
        if (value === '__new__') {
            value = window.prompt('請輸入新的輔導員名稱：')?.trim() || '';
            if (!value) return;
            setMentorOptions((current) => [...new Set([...current, value])]);
        }
        setBusyId(account.id);
        const { error } = await supabase
            .from('users')
            .update({ mentor_name: value || null })
            .eq('id', account.id);
        setBusyId(null);
        if (error) {
            alert('輔導員設定失敗：' + error.message);
            return;
        }
        setUsers((current) => current.map((item) => (
            item.id === account.id ? { ...item, mentor_name: value || null } : item
        )));
    };

    if (loading) {
        return <div className="p-12 text-center text-bauhaus-black/50 font-bold">載入中...</div>;
    }

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
                <div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">帳號審核與權限</h1>
                    <p className="text-bauhaus-black/60 mt-1 text-sm font-medium">
                        只有完全未預先建檔的新註冊講師需要審核；講師主檔與認領狀態請到講師資料總覽管理。
                    </p>
                </div>
                <div className="flex gap-2">
                    <button type="button" onClick={fetchData} className="bh-btn bh-btn-outline px-4 py-2.5 text-sm">
                        <RefreshCw className="w-4 h-4" /> 重新整理
                    </button>
                    <Link to="/admin/instructors" className="bh-btn bh-btn-blue px-4 py-2.5 text-sm">
                        <Users className="w-4 h-4" /> 講師主檔
                    </Link>
                </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
                <StatCard icon={Clock} label="新註冊待審核" value={roleCounts.pending || 0} color="bg-bauhaus-yellow text-bauhaus-black" />
                <StatCard icon={UserCheck} label="主檔已認領" value={claimedCount} color="bg-bauhaus-blue text-white" />
                <StatCard icon={Users} label="主檔未認領" value={unclaimedCount} color="bg-bauhaus-muted text-bauhaus-black" />
                <StatCard icon={ShieldCheck} label="後台人員" value={(roleCounts.mentor || 0) + (roleCounts.admin || 0)} color="bg-bauhaus-black text-white" />
            </div>

            <div className="flex flex-wrap gap-2 mb-5">
                {Object.entries(ROLE_CONFIG).map(([role, config]) => (
                    <button
                        key={role}
                        type="button"
                        onClick={() => setTab(role)}
                        className={`px-4 py-2.5 min-h-[44px] rounded-xl border-2 border-bauhaus-black text-sm font-black transition-colors ${
                            tab === role ? config.className : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                        }`}
                    >
                        {config.label} {roleCounts[role] || 0}
                    </button>
                ))}
            </div>

            <div className="relative mb-5">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-bauhaus-black/40" />
                <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    className="bh-input pl-12"
                    placeholder="搜尋姓名、Email 或手機"
                />
            </div>

            <div className="space-y-3">
                {filteredUsers.length === 0 ? (
                    <div className="bh-card py-14 text-center text-bauhaus-black/45 font-bold">此分類目前沒有帳號</div>
                ) : filteredUsers.map((account) => {
                    const instructor = instructorByUserId.get(account.id);
                    const completion = getInstructorProfileCompletion(instructor);
                    const blocked = BLOCKED_STATUSES.has(instructor?.employment_status);
                    const canApprove = account.role === 'pending' && instructor && completion.complete && !blocked;
                    return (
                        <div key={account.id} className="bh-card p-4 sm:p-5">
                            <div className="flex flex-col lg:flex-row lg:items-center gap-4">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-black text-bauhaus-black">{instructor?.full_name || account.name || '(未填姓名)'}</span>
                                        <span className={`bh-chip ${ROLE_CONFIG[account.role]?.className || 'bg-white'}`}>
                                            {ROLE_CONFIG[account.role]?.label || account.role}
                                        </span>
                                        <span className={`bh-chip ${instructor ? 'bg-bauhaus-blue/10 text-bauhaus-blue' : 'bg-bauhaus-yellow text-bauhaus-black'}`}>
                                            {instructor ? '已有講師主檔' : '尚未填寫主檔'}
                                        </span>
                                        {blocked && <span className="bh-chip bg-bauhaus-red text-white">已停止登入</span>}
                                    </div>
                                    <div className="text-sm text-bauhaus-black/60 mt-1">{account.email}</div>
                                    {account.role === 'pending' && instructor && !completion.complete && (
                                        <div className="text-xs text-bauhaus-red font-bold mt-2">
                                            尚缺 {completion.missingItems.length} 項：{completion.missingItems.slice(0, 5).join('、')}
                                            {completion.missingItems.length > 5 ? '…' : ''}
                                        </div>
                                    )}
                                    {account.role === 'pending' && completion.complete && !blocked && (
                                        <div className="text-xs text-bauhaus-blue font-bold mt-2 flex items-center gap-1">
                                            <CheckCircle2 className="w-4 h-4" /> 資料已完成，可核准
                                        </div>
                                    )}
                                </div>

                                <div className="flex flex-col sm:flex-row gap-2 lg:items-center">
                                    {account.role === 'pending' ? (
                                        <button
                                            type="button"
                                            disabled={!canApprove || busyId === account.id}
                                            onClick={() => approvePending(account)}
                                            className="bh-btn bh-btn-blue px-4 py-2.5 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            <UserCheck className="w-4 h-4" /> 核准新講師
                                        </button>
                                    ) : (
                                        <select
                                            value={account.role}
                                            disabled={busyId === account.id}
                                            onChange={(event) => changeRole(account, event.target.value)}
                                            className="bh-input min-w-32 text-sm"
                                            aria-label={`變更 ${account.name || account.email} 的角色`}
                                        >
                                            <option value="teacher">講師</option>
                                            <option value="mentor">輔導員</option>
                                            <option value="admin">管理員</option>
                                            <option value="pending">停用帳號權限</option>
                                        </select>
                                    )}
                                    {(account.role === 'teacher' || account.role === 'pending') && (
                                        <select
                                            value={account.mentor_name || ''}
                                            disabled={busyId === account.id}
                                            onChange={(event) => changeMentor(account, event.target.value)}
                                            className="bh-input min-w-36 text-sm"
                                            aria-label={`設定 ${account.name || account.email} 的輔導員`}
                                        >
                                            <option value="">未指派輔導員</option>
                                            {mentorOptions.map((mentor) => <option key={mentor} value={mentor}>{mentor}</option>)}
                                            <option value="__new__">＋ 新增名稱</option>
                                        </select>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const StatCard = ({ icon, label, value, color }) => {
    const CardIcon = icon;
    return (
    <div className="bh-card p-4 flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg border-2 border-bauhaus-black flex items-center justify-center shrink-0 ${color}`}>
            <CardIcon className="w-5 h-5" />
        </div>
        <div>
            <div className="text-2xl font-black text-bauhaus-black tabular-nums">{value}</div>
            <div className="text-xs font-bold text-bauhaus-black/50">{label}</div>
        </div>
    </div>
    );
};

export default TeacherManager;
