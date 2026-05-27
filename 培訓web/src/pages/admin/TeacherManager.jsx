import React, { useState, useEffect } from 'react';
import { supabase, createIsolatedClient } from '../../lib/supabaseClient';
import {
    Users, UserPlus, ShieldCheck, Trash2, Search,
    Clock, CheckCircle, AlertCircle, Loader2,
    ChevronDown, ChevronUp, Eye, MapPin
} from 'lucide-react';

const DEFAULT_MENTORS = ['懶懶', '叮叮', '樹懶'];

const ROLE_CONFIG = {
    pending: { label: '待審核' },
    teacher: { label: '講師' },
    mentor: { label: '輔導員' },
    admin: { label: '管理員' },
};

const INSTRUCTOR_ROLE_LABELS = { S: 'S 級', 'A+': 'A+ 級', A: 'A 級', B: 'B 級', '實習': '實習', '職員': '職員', '工讀生': '工讀生' };

const TeacherManager = () => {
    const [users, setUsers] = useState([]);
    const [invites, setInvites] = useState([]);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState('pending');
    const [search, setSearch] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [form, setForm] = useState({ name: '', email: '', password: '', role: 'teacher' });
    const [creating, setCreating] = useState(false);
    const [mentorOptions, setMentorOptions] = useState(DEFAULT_MENTORS);
    const [showDetail, setShowDetail] = useState(false);
    const [instructorMap, setInstructorMap] = useState({});
    const [expandedId, setExpandedId] = useState(null);

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        setLoading(true);
        const [usersRes, invitesRes, instructorsRes] = await Promise.all([
            supabase.from('users').select('*').order('created_at', { ascending: false }),
            supabase.from('teacher_invites').select('*').order('created_at', { ascending: false }),
            supabase.from('instructors').select('*'),
        ]);
        const fetchedUsers = usersRes.data || [];
        setUsers(fetchedUsers);
        setInvites(invitesRes.data || []);

        const iMap = {};
        (instructorsRes.data || []).forEach(inst => {
            iMap[inst.id] = inst;  // by instructor.id 確保都進來
            if (inst.user_id) iMap[`user:${inst.user_id}`] = inst;  // 兼容舊查法(user_id → instructor)
        });
        setInstructorMap(iMap);

        const dbMentors = fetchedUsers.map(u => u.mentor_name).filter(Boolean);
        setMentorOptions([...new Set([...DEFAULT_MENTORS, ...dbMentors])]);
        setLoading(false);
    };

    const handleMentorChange = async (userId, value) => {
        if (value === '__add_new__') {
            const name = window.prompt('請輸入新的輔導員名稱：');
            if (!name?.trim()) return;
            const trimmed = name.trim();
            if (!mentorOptions.includes(trimmed)) {
                setMentorOptions(prev => [...prev, trimmed]);
            }
            value = trimmed;
        }
        const { error } = await supabase.from('users').update({ mentor_name: value || null }).eq('id', userId);
        if (error) {
            alert('輔導員設定失敗：' + error.message);
            return;
        }
        setUsers(users.map(u => u.id === userId ? { ...u, mentor_name: value || null } : u));
    };

    const handleDirectCreate = async () => {
        if (!form.name || !form.email || !form.password) {
            alert('請填寫姓名、Email 與密碼');
            return;
        }
        if (form.password.length < 6) {
            alert('密碼至少需要 6 個字元');
            return;
        }

        setCreating(true);
        try {
            const { data: existingUser } = await supabase
                .from('users')
                .select('id')
                .eq('email', form.email)
                .maybeSingle();

            if (existingUser) {
                await supabase.from('users').update({ role: form.role, name: form.name }).eq('id', existingUser.id);
                setForm({ name: '', email: '', password: '', role: 'teacher' });
                setShowForm(false);
                alert('此帳號已存在，已更新角色設定。');
                fetchData();
                return;
            }

            await supabase.from('teacher_invites').delete().eq('email', form.email);
            const { error: inviteErr } = await supabase.from('teacher_invites').insert({
                name: form.name,
                email: form.email,
                role: form.role,
            });
            if (inviteErr) {
                alert('建檔失敗：' + inviteErr.message);
                return;
            }

            const isolated = createIsolatedClient();
            const signUpPromise = isolated.auth.signUp({
                email: form.email,
                password: form.password,
                options: { data: { full_name: form.name } },
            });
            const timeout = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('操作逾時（超過 20 秒），請確認 Supabase Auth 設定或稍後再試')), 20000)
            );
            const { data: signUpData, error: signUpErr } = await Promise.race([signUpPromise, timeout]);

            if (signUpErr) {
                if (signUpErr.message.includes('rate limit')) {
                    alert(
                        '建立失敗：驗證信發送頻率超過限制。\n\n' +
                        '請到 Supabase Dashboard → Authentication\n' +
                        '→ 左側選「Sign In / Providers」\n' +
                        '→ 展開 Email 區塊\n' +
                        '→ 關閉「Confirm email」\n\n' +
                        '關閉後再試一次即可。'
                    );
                } else if (signUpErr.message.includes('already registered')) {
                    alert('帳號已重新建檔完成！對方用原本的密碼登入即可獲得新角色。\n（如需重設密碼，請對方使用忘記密碼功能）');
                } else {
                    await supabase.from('teacher_invites').delete().eq('email', form.email);
                    alert('帳號建立失敗：' + signUpErr.message);
                    return;
                }
                setForm({ name: '', email: '', password: '', role: 'teacher' });
                setShowForm(false);
                fetchData();
                return;
            }

            if (signUpData?.user?.identities?.length === 0) {
                alert('帳號已重新建檔完成！對方登入後即可獲得新角色。');
                setForm({ name: '', email: '', password: '', role: 'teacher' });
                setShowForm(false);
                fetchData();
                return;
            }

            setForm({ name: '', email: '', password: '', role: 'teacher' });
            setShowForm(false);
            alert('帳號建立成功！對方可以直接使用 Email 與密碼登入。');
            fetchData();
        } finally {
            setCreating(false);
        }
    };

    const handleDeleteInvite = async (id) => {
        if (!window.confirm('確定要移除這筆建檔資料？')) return;
        const { error } = await supabase.from('teacher_invites').delete().eq('id', id);
        if (error) {
            alert('刪除失敗：' + error.message);
            return;
        }
        setInvites(invites.filter(i => i.id !== id));
    };

    const handleInviteRoleChange = async (inviteId, newRole) => {
        const invite = invites.find(i => i.id === inviteId);
        const oldLabel = ROLE_CONFIG[invite?.role]?.label || invite?.role;
        const newLabel = ROLE_CONFIG[newRole]?.label || newRole;
        if (!window.confirm(`確定要將「${invite?.name}」從「${oldLabel}」改為「${newLabel}」嗎？`)) return;

        const { error } = await supabase.from('teacher_invites').update({ role: newRole }).eq('id', inviteId);
        if (error) {
            alert('角色變更失敗：' + error.message);
            return;
        }
        setInvites(invites.map(i => i.id === inviteId ? { ...i, role: newRole } : i));
    };

    const handleRoleChange = async (userId, newRole) => {
        const user = users.find(u => u.id === userId);
        const oldLabel = ROLE_CONFIG[user?.role]?.label || user?.role;
        const newLabel = ROLE_CONFIG[newRole]?.label || newRole;

        if (!window.confirm(`確定要將「${user?.name || user?.email}」從「${oldLabel}」改為「${newLabel}」嗎？`)) return;

        const { error } = await supabase.from('users').update({ role: newRole }).eq('id', userId);
        if (error) {
            alert('狀態變更失敗：' + error.message);
            return;
        }
        setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
    };

    const handleBatchApprove = async () => {
        const pendingUsers = users.filter(u => u.role === 'pending');
        if (pendingUsers.length === 0) return;
        if (!window.confirm(`確定要將所有 ${pendingUsers.length} 位待審核的使用者全部核准為講師嗎？`)) return;

        const ids = pendingUsers.map(u => u.id);
        const { error } = await supabase.from('users').update({ role: 'teacher' }).in('id', ids);
        if (error) {
            alert('批次核准失敗：' + error.message);
            return;
        }
        setUsers(users.map(u => ids.includes(u.id) ? { ...u, role: 'teacher' } : u));
    };

    const handleDeleteUser = async (user) => {
        if (!window.confirm(`確定要徹底刪除「${user.name || user.email}」嗎？\n此操作將同時刪除登入帳號與所有相關資料，無法復原。`)) return;
        const { error } = await supabase.rpc('delete_user_completely', { target_user_id: user.id });
        if (error) {
            alert('刪除失敗：' + error.message);
            return;
        }
        if (user.email) {
            await supabase.from('teacher_invites').delete().eq('email', user.email);
        }
        setUsers(users.filter(u => u.id !== user.id));
        setInvites(prev => prev.filter(i => i.email !== user.email));
    };

    const pendingUsers = users.filter(u => u.role === 'pending');
    const teacherUsers = users.filter(u => u.role === 'teacher');
    const mentorUsers = users.filter(u => u.role === 'mentor');
    const adminUsers = users.filter(u => u.role === 'admin');
    const teacherInvites = invites.filter(i => i.role === 'teacher');
    const mentorInvites = invites.filter(i => i.role === 'mentor');
    const adminInvites = invites.filter(i => i.role === 'admin');

    // 把 instructors 沒對應 user 的當「未登入講師」加進列表
    const orphanInstructors = Object.values(instructorMap || {}).filter(i => !i.user_id);
    const allInstructors = Object.values(instructorMap || {});
    const orphanActive = orphanInstructors.filter(i => i.employment_status === 'active');
    const inactiveInstructors = allInstructors.filter(i => i.employment_status === 'cancelled');

    const getFilteredList = () => {
        let userList = [], inviteList = [], instructorList = [];
        if (tab === 'pending') { userList = pendingUsers; }
        else if (tab === 'teacher') { userList = teacherUsers; inviteList = teacherInvites; instructorList = orphanActive; }
        else if (tab === 'mentor') { userList = mentorUsers; inviteList = mentorInvites; }
        else if (tab === 'admin') { userList = adminUsers; inviteList = adminInvites; }
        else if (tab === 'inactive') { instructorList = inactiveInstructors; }

        const combined = [
            ...userList.map(u => ({ ...u, _type: 'user' })),
            ...inviteList.map(i => ({ ...i, _type: 'invite' })),
            ...instructorList.map(i => ({
                ...i,
                _type: 'instructor',
                name: i.full_name,
                email: i.email_primary,
            })),
        ];

        if (!search) return combined;
        const q = search.toLowerCase();
        return combined.filter(item =>
            item.name?.toLowerCase().includes(q) || item.email?.toLowerCase().includes(q)
        );
    };

    const filteredList = getFilteredList();
    const showMentorCol = tab === 'teacher' || tab === 'pending';

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
                <div>
                    <h1 className="text-2xl sm:text-3xl font-black text-slate-900">講師名單管理</h1>
                    <p className="text-slate-500 mt-1 text-sm">審核新註冊使用者與管理講師名單</p>
                </div>
                <button
                    onClick={() => setShowForm(!showForm)}
                    className="bg-blue-600 text-white px-5 py-2.5 sm:px-6 sm:py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 text-sm sm:text-base"
                >
                    <UserPlus className="w-5 h-5" /> 新增講師
                </button>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-8">
                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-10 h-10 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center"><Clock className="w-5 h-5" /></div>
                    <div>
                        <div className="text-2xl font-black text-slate-900">{pendingUsers.length}</div>
                        <div className="text-xs font-medium text-slate-400">待審核</div>
                    </div>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-10 h-10 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center"><Users className="w-5 h-5" /></div>
                    <div>
                        <div className="text-2xl font-black text-slate-900">{teacherUsers.length + teacherInvites.length}</div>
                        <div className="text-xs font-medium text-slate-400">講師</div>
                    </div>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-10 h-10 bg-teal-50 text-teal-600 rounded-xl flex items-center justify-center"><ShieldCheck className="w-5 h-5" /></div>
                    <div>
                        <div className="text-2xl font-black text-slate-900">{mentorUsers.length + mentorInvites.length}</div>
                        <div className="text-xs font-medium text-slate-400">輔導員</div>
                    </div>
                </div>
                <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-3">
                    <div className="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center"><ShieldCheck className="w-5 h-5" /></div>
                    <div>
                        <div className="text-2xl font-black text-slate-900">{adminUsers.length + adminInvites.length}</div>
                        <div className="text-xs font-medium text-slate-400">管理員</div>
                    </div>
                </div>
            </div>

            {/* Add form */}
            {showForm && (
                <div className="bg-white rounded-2xl border border-blue-200 shadow-lg p-6 mb-8">
                    <h3 className="font-bold text-slate-900 mb-2 flex items-center gap-2">
                        <UserPlus className="w-5 h-5 text-blue-600" /> 直接建立帳號
                    </h3>
                    <p className="text-sm text-slate-400 mb-4">
                        建立完成後，對方可以直接用 Email 和密碼登入，不需要自己註冊。
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-5 gap-4">
                        <input type="text" placeholder="姓名" value={form.name}
                            onChange={e => setForm({ ...form, name: e.target.value })}
                            className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500" />
                        <input type="email" placeholder="Email" value={form.email}
                            onChange={e => setForm({ ...form, email: e.target.value })}
                            className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500" />
                        <input type="text" placeholder="登入密碼（至少 6 碼）" value={form.password}
                            onChange={e => setForm({ ...form, password: e.target.value })}
                            className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500" />
                        <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}
                            className="px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-blue-500">
                            <option value="teacher">講師</option>
                            <option value="mentor">輔導員</option>
                            <option value="admin">管理員</option>
                        </select>
                        <button onClick={handleDirectCreate} disabled={creating}
                            className="bg-blue-600 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-blue-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                            {creating ? <><Loader2 className="w-4 h-4 animate-spin" /> 建立中...</> : '確認建立'}
                        </button>
                    </div>
                </div>
            )}

            {/* Tabs + Search + Toggle */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6">
                <div className="flex gap-2 flex-wrap">
                    {[
                        { key: 'pending', label: '待審核', count: pendingUsers.length, activeColor: 'bg-amber-500' },
                        { key: 'teacher', label: '講師', count: teacherUsers.length + teacherInvites.length + orphanActive.length, activeColor: 'bg-blue-600' },
                        { key: 'mentor', label: '輔導員', count: mentorUsers.length + mentorInvites.length, activeColor: 'bg-teal-600' },
                        { key: 'admin', label: '管理員', count: adminUsers.length + adminInvites.length, activeColor: 'bg-indigo-600' },
                        { key: 'inactive', label: '未啟用講師', count: inactiveInstructors.length, activeColor: 'bg-slate-500' },
                    ].map(t => (
                        <button key={t.key} onClick={() => { setTab(t.key); setExpandedId(null); }}
                            className={`px-4 py-2 rounded-xl text-sm font-bold transition-all ${
                                tab === t.key ? `${t.activeColor} text-white shadow-md` : 'bg-white border border-slate-200 text-slate-500 hover:border-slate-300'
                            }`}>
                            {t.label} ({t.count})
                        </button>
                    ))}
                </div>

                <label className="flex items-center gap-2 cursor-pointer select-none shrink-0"
                    onClick={() => { setShowDetail(v => !v); setExpandedId(null); }}>
                    <div className={`relative w-9 h-5 rounded-full transition-colors ${showDetail ? 'bg-blue-600' : 'bg-slate-300'}`}>
                        <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${showDetail ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                    </div>
                    <span className="text-sm text-slate-600 flex items-center gap-1">
                        <Eye className="w-3.5 h-3.5" /> 詳細資料
                    </span>
                </label>

                <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input type="text" placeholder="搜尋姓名或 Email..." value={search}
                        onChange={e => setSearch(e.target.value)}
                        className="w-full pl-10 pr-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
            </div>

            {/* Batch approve banner */}
            {tab === 'pending' && pendingUsers.length > 0 && (
                <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6">
                    <div className="flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 text-amber-600" />
                        <span className="text-sm font-medium text-amber-800">有 {pendingUsers.length} 位使用者正在等待審核</span>
                    </div>
                    <button onClick={handleBatchApprove}
                        className="px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-bold hover:bg-amber-700 transition-all">
                        全部核准為講師
                    </button>
                </div>
            )}

            {/* ===== 手機版：卡片列表 ===== */}
            <div className="md:hidden space-y-3">
                {filteredList.length === 0 && (
                    <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-400">
                        {tab === 'pending' ? '目前沒有待審核的使用者' :
                         tab === 'teacher' ? '目前沒有講師' :
                         tab === 'mentor' ? '目前沒有輔導員' :
                         tab === 'admin' ? '目前沒有管理員' :
                         '目前沒有未啟用講師'}
                    </div>
                )}
                {filteredList.map(item => {
                    const inst = item._type === 'user' ? instructorMap[`user:${item.id}`] : null;
                    const isExpanded = showDetail && expandedId === `${item._type}-${item.id}`;
                    return (
                        <div key={`m-${item._type}-${item.id}`} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                            <div className="p-4 space-y-3"
                                onClick={() => showDetail && setExpandedId(isExpanded ? null : `${item._type}-${item.id}`)}>
                                {/* 姓名 + 操作按鈕 */}
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="font-bold text-slate-900">{item.name || '—'}</span>
                                        {item._type === 'invite' && <span className="text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full font-bold">尚未註冊</span>}
                                    </div>
                                    <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                                        {showDetail && (
                                            <button className="p-1.5 text-slate-400 hover:text-blue-600"
                                                onClick={() => setExpandedId(isExpanded ? null : `${item._type}-${item.id}`)}>
                                                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                            </button>
                                        )}
                                        {item._type === 'user' && item.role === 'pending' && (
                                            <button onClick={() => handleRoleChange(item.id, 'teacher')}
                                                className="p-1.5 text-emerald-500 hover:text-emerald-700" title="核准為講師">
                                                <CheckCircle className="w-4 h-4" />
                                            </button>
                                        )}
                                        {item._type === 'instructor' && (
                                            <button
                                                onClick={async () => {
                                                    const newStatus = item.employment_status === 'cancelled' ? 'active' : 'cancelled';
                                                    const action = newStatus === 'cancelled' ? '停用' : '啟用';
                                                    if (!window.confirm(`確定要${action}「${item.name}」嗎？`)) return;
                                                    const { error } = await supabase.from('instructors').update({ employment_status: newStatus }).eq('id', item.id);
                                                    if (error) { alert('操作失敗：' + error.message); return; }
                                                    fetchData();
                                                }}
                                                className={`p-1.5 ${item.employment_status === 'cancelled' ? 'text-emerald-500 hover:text-emerald-700' : 'text-slate-400 hover:text-rose-500'}`}
                                                title={item.employment_status === 'cancelled' ? '啟用' : '停用'}
                                            >
                                                {item.employment_status === 'cancelled' ? <CheckCircle className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                                            </button>
                                        )}
                                        {item._type !== 'instructor' && (
                                            <button onClick={() => item._type === 'user' ? handleDeleteUser(item) : handleDeleteInvite(item.id)}
                                                className="p-1.5 text-slate-400 hover:text-red-500" title="移除">
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                {/* Email */}
                                <div className="text-sm text-slate-500 truncate">{item.email}</div>
                                {/* 下拉選單列 */}
                                <div className="flex flex-wrap gap-2" onClick={e => e.stopPropagation()}>
                                    {/* 身份 */}
                                    {item._type === 'user' ? (
                                        <select value={item.role} onChange={e => handleRoleChange(item.id, e.target.value)}
                                            className={`text-xs font-bold px-3 py-1.5 rounded-full border-0 outline-none ${
                                                item.role === 'admin' ? 'bg-indigo-50 text-indigo-600' :
                                                item.role === 'mentor' ? 'bg-teal-50 text-teal-600' :
                                                item.role === 'pending' ? 'bg-amber-50 text-amber-600' :
                                                'bg-blue-50 text-blue-600'
                                            }`}>
                                            {tab === 'pending' && <option value="pending">待審核</option>}
                                            <option value="teacher">講師</option>
                                            <option value="mentor">輔導員</option>
                                            <option value="admin">管理員</option>
                                        </select>
                                    ) : item._type === 'invite' ? (
                                        <select value={item.role} onChange={e => handleInviteRoleChange(item.id, e.target.value)}
                                            className={`text-xs font-bold px-3 py-1.5 rounded-full border-0 outline-none ${
                                                item.role === 'admin' ? 'bg-indigo-50 text-indigo-600' :
                                                item.role === 'mentor' ? 'bg-teal-50 text-teal-600' :
                                                'bg-blue-50 text-blue-600'
                                            }`}>
                                            <option value="teacher">講師</option>
                                            <option value="mentor">輔導員</option>
                                            <option value="admin">管理員</option>
                                        </select>
                                    ) : (
                                        <span className={`text-xs font-bold px-3 py-1.5 rounded-full ${item.employment_status === 'cancelled' ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-500'}`}>
                                            {item.employment_status === 'cancelled' ? '已停用' : '未登入講師'}
                                        </span>
                                    )}
                                    {/* 講師等級 */}
                                    {item._type === 'user' && (
                                        <select
                                            value={inst?.instructor_role || ''}
                                            onChange={async (e) => {
                                                const newRole = e.target.value || null;
                                                let error;
                                                if (inst) {
                                                    ({ error } = await supabase.from('instructors').update({ instructor_role: newRole }).eq('user_id', item.id));
                                                } else {
                                                    ({ error } = await supabase.from('instructors').upsert({
                                                        user_id: item.id, full_name: item.name || '', email_primary: item.email || '',
                                                        instructor_role: newRole, teaching_regions: [],
                                                    }, { onConflict: 'user_id' }));
                                                }
                                                if (error) { alert('講師等級變更失敗：' + error.message); return; }
                                                setInstructorMap(prev => ({ ...prev, [item.id]: { ...(prev[item.id] || {}), user_id: item.id, instructor_role: newRole } }));
                                            }}
                                            className={`text-xs font-bold px-2.5 py-1.5 rounded-full border-0 outline-none ${
                                                inst?.instructor_role ? 'bg-purple-50 text-purple-600' : 'bg-slate-50 text-slate-400'
                                            }`}
                                        >
                                            <option value="">等級未設定</option>
                                            {Object.entries(INSTRUCTOR_ROLE_LABELS).map(([k, v]) => (
                                                <option key={k} value={k}>{v}</option>
                                            ))}
                                        </select>
                                    )}
                                    {/* 輔導員 */}
                                    {showMentorCol && item._type === 'user' && (
                                        <select
                                            value={item.mentor_name || ''}
                                            onChange={e => handleMentorChange(item.id, e.target.value)}
                                            className={`text-xs px-2.5 py-1.5 rounded-full outline-none ${
                                                item.mentor_name ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-50 text-slate-400 border border-slate-200'
                                            }`}
                                        >
                                            <option value="">輔導員未指派</option>
                                            {mentorOptions.map(m => (<option key={m} value={m}>{m}</option>))}
                                            <option value="__add_new__">＋ 新增輔導員</option>
                                        </select>
                                    )}
                                </div>
                                {/* 日期 */}
                                <div className="text-[11px] text-slate-400">{new Date(item.created_at).toLocaleDateString()}</div>
                            </div>
                            {/* 展開詳細 */}
                            {isExpanded && inst && (
                                <div className="border-t border-slate-100 p-4 bg-slate-50/70 space-y-4">
                                    <div className="space-y-1.5 text-sm">
                                        <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wider">基本資料</h4>
                                        <DetailRow label="性別" value={inst.gender} />
                                        <DetailRow label="生日" value={inst.birth_date} />
                                        <DetailRow label="手機" value={inst.phone_mobile} />
                                        <DetailRow label="家電" value={inst.phone_home} />
                                        <DetailRow label="Line" value={inst.line_id} />
                                    </div>
                                    <div className="space-y-1.5 text-sm">
                                        <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wider">聯絡與教學</h4>
                                        <DetailRow label="備用 Email" value={inst.email_secondary} />
                                        <DetailRow label="地址" value={inst.address} />
                                        <DetailRow label="學期接課" value={inst.teaching_freq_semester} />
                                        <DetailRow label="寒暑接課" value={inst.teaching_freq_vacation} />
                                    </div>
                                    <div className="space-y-1.5 text-sm">
                                        <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wider">接課地區</h4>
                                        {inst.teaching_regions?.length > 0 ? (
                                            <div className="flex flex-wrap gap-1">
                                                {inst.teaching_regions.map(r => (
                                                    <span key={r} className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">{r}</span>
                                                ))}
                                            </div>
                                        ) : <span className="text-xs text-slate-400">未設定</span>}
                                    </div>
                                </div>
                            )}
                            {isExpanded && !inst && (
                                <div className="border-t border-slate-100 p-4 bg-slate-50/70 text-center text-sm text-slate-400">
                                    此講師尚未填寫個人資料
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>

            {/* ===== 桌面版：表格 ===== */}
            <div className="hidden md:block bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                <table className="w-full text-left">
                    <thead className="bg-slate-50 text-slate-400 text-xs font-bold uppercase tracking-wider">
                        <tr>
                            <th className="px-6 py-4">姓名</th>
                            <th className="px-6 py-4">Email</th>
                            <th className="px-6 py-4">身份</th>
                            <th className="px-6 py-4">講師等級</th>
                            {showMentorCol && <th className="px-6 py-4">輔導員</th>}
                            <th className="px-6 py-4">日期</th>
                            <th className="px-6 py-4 text-right">操作</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {filteredList.map(item => {
                            const inst = item._type === 'user' ? instructorMap[`user:${item.id}`] : null;
                            const isExpanded = showDetail && expandedId === `${item._type}-${item.id}`;
                            const totalCols = 5 + (showMentorCol ? 1 : 0) + 1;
                            return (
                                <React.Fragment key={`${item._type}-${item.id}`}>
                                    <tr className={`hover:bg-slate-50 transition-colors ${showDetail ? 'cursor-pointer' : ''}`}
                                        onClick={() => showDetail && setExpandedId(isExpanded ? null : `${item._type}-${item.id}`)}>
                                        <td className="px-6 py-4">
                                            <span className="font-semibold text-slate-900">{item.name || '—'}</span>
                                            {item._type === 'invite' && <span className="ml-2 text-[10px] bg-orange-100 text-orange-600 px-1.5 py-0.5 rounded-full font-bold">尚未註冊</span>}
                                        </td>
                                        <td className="px-6 py-4 text-sm text-slate-500">{item.email}</td>
                                        <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                                            {item._type === 'user' ? (
                                                <select value={item.role} onChange={e => handleRoleChange(item.id, e.target.value)}
                                                    className={`text-xs font-bold px-3 py-1.5 rounded-full border-0 outline-none cursor-pointer ${
                                                        item.role === 'admin' ? 'bg-indigo-50 text-indigo-600' :
                                                        item.role === 'mentor' ? 'bg-teal-50 text-teal-600' :
                                                        item.role === 'pending' ? 'bg-amber-50 text-amber-600' :
                                                        'bg-blue-50 text-blue-600'
                                                    }`}>
                                                    {tab === 'pending' && <option value="pending">待審核</option>}
                                                    <option value="teacher">講師</option>
                                                    <option value="mentor">輔導員</option>
                                                    <option value="admin">管理員</option>
                                                </select>
                                            ) : item._type === 'invite' ? (
                                                <select value={item.role} onChange={e => handleInviteRoleChange(item.id, e.target.value)}
                                                    className={`text-xs font-bold px-3 py-1.5 rounded-full border-0 outline-none cursor-pointer ${
                                                        item.role === 'admin' ? 'bg-indigo-50 text-indigo-600' :
                                                        item.role === 'mentor' ? 'bg-teal-50 text-teal-600' :
                                                        'bg-blue-50 text-blue-600'
                                                    }`}>
                                                    <option value="teacher">講師</option>
                                                    <option value="mentor">輔導員</option>
                                                    <option value="admin">管理員</option>
                                                </select>
                                            ) : (
                                                <span className={`text-xs font-bold px-3 py-1.5 rounded-full ${item.employment_status === 'cancelled' ? 'bg-rose-50 text-rose-600' : 'bg-slate-50 text-slate-500'}`}>
                                                    {item.employment_status === 'cancelled' ? '已停用' : '未登入講師'}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                                            {item._type === 'user' ? (
                                                <select
                                                    value={inst?.instructor_role || ''}
                                                    onChange={async (e) => {
                                                        const newRole = e.target.value || null;
                                                        let error;
                                                        if (inst) {
                                                            ({ error } = await supabase.from('instructors').update({ instructor_role: newRole }).eq('user_id', item.id));
                                                        } else {
                                                            ({ error } = await supabase.from('instructors').upsert({
                                                                user_id: item.id, full_name: item.name || '', email_primary: item.email || '',
                                                                instructor_role: newRole, teaching_regions: [],
                                                            }, { onConflict: 'user_id' }));
                                                        }
                                                        if (error) { alert('講師等級變更失敗：' + error.message); return; }
                                                        setInstructorMap(prev => ({ ...prev, [item.id]: { ...(prev[item.id] || {}), user_id: item.id, instructor_role: newRole } }));
                                                    }}
                                                    className={`text-xs font-bold px-2.5 py-1.5 rounded-full border-0 outline-none cursor-pointer ${
                                                        inst?.instructor_role ? 'bg-purple-50 text-purple-600' : 'bg-slate-50 text-slate-400'
                                                    }`}
                                                >
                                                    <option value="">未設定</option>
                                                    {Object.entries(INSTRUCTOR_ROLE_LABELS).map(([k, v]) => (
                                                        <option key={k} value={k}>{v}</option>
                                                    ))}
                                                </select>
                                            ) : (
                                                <span className="text-xs text-slate-300">—</span>
                                            )}
                                        </td>
                                        {showMentorCol && (
                                            <td className="px-6 py-4" onClick={e => e.stopPropagation()}>
                                                {item._type === 'user' ? (
                                                    <select
                                                        value={item.mentor_name || ''}
                                                        onChange={e => handleMentorChange(item.id, e.target.value)}
                                                        className={`text-sm w-32 px-3 py-2 rounded-lg outline-none cursor-pointer transition-colors ${
                                                            item.mentor_name
                                                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                                                : 'bg-slate-50 text-slate-400 border border-slate-200'
                                                        }`}
                                                    >
                                                        <option value="">未指派</option>
                                                        {mentorOptions.map(m => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                        <option value="__add_new__">＋ 新增輔導員</option>
                                                    </select>
                                                ) : (
                                                    <span className="text-xs text-slate-300">—</span>
                                                )}
                                            </td>
                                        )}
                                        <td className="px-6 py-4 text-xs text-slate-400">
                                            {new Date(item.created_at).toLocaleDateString()}
                                        </td>
                                        <td className="px-6 py-4 text-right" onClick={e => e.stopPropagation()}>
                                            <div className="flex items-center justify-end gap-1">
                                                {showDetail && (
                                                    <button className="p-2 text-slate-400 hover:text-blue-600 transition-colors"
                                                        onClick={() => setExpandedId(isExpanded ? null : `${item._type}-${item.id}`)}>
                                                        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                    </button>
                                                )}
                                                {item._type === 'user' && item.role === 'pending' && (
                                                    <button onClick={() => handleRoleChange(item.id, 'teacher')}
                                                        className="p-2 text-emerald-500 hover:text-emerald-700 transition-colors" title="核准為講師">
                                                        <CheckCircle className="w-4 h-4" />
                                                    </button>
                                                )}
                                                {item._type === 'instructor' && (
                                                    <button
                                                        onClick={async () => {
                                                            const newStatus = item.employment_status === 'cancelled' ? 'active' : 'cancelled';
                                                            const action = newStatus === 'cancelled' ? '停用' : '啟用';
                                                            if (!window.confirm(`確定要${action}「${item.name}」嗎？`)) return;
                                                            const { error } = await supabase.from('instructors').update({ employment_status: newStatus }).eq('id', item.id);
                                                            if (error) { alert('操作失敗：' + error.message); return; }
                                                            fetchData();
                                                        }}
                                                        className={`p-2 transition-colors ${item.employment_status === 'cancelled' ? 'text-emerald-500 hover:text-emerald-700' : 'text-slate-400 hover:text-rose-500'}`}
                                                        title={item.employment_status === 'cancelled' ? '啟用' : '停用'}
                                                    >
                                                        {item.employment_status === 'cancelled' ? <CheckCircle className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                                                    </button>
                                                )}
                                                {item._type !== 'instructor' && (
                                                    <button onClick={() => item._type === 'user' ? handleDeleteUser(item) : handleDeleteInvite(item.id)}
                                                        className="p-2 text-slate-400 hover:text-red-500 transition-colors" title="移除">
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                    {isExpanded && inst && (
                                        <tr>
                                            <td colSpan={totalCols} className="px-6 py-5 bg-slate-50/70">
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm">
                                                    <div className="space-y-2">
                                                        <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wider mb-2">基本資料</h4>
                                                        <DetailRow label="性別" value={inst.gender} />
                                                        <DetailRow label="出生年月日" value={inst.birth_date} />
                                                        <DetailRow label="手機" value={inst.phone_mobile} />
                                                        <DetailRow label="家電" value={inst.phone_home} />
                                                        <DetailRow label="Line ID" value={inst.line_id} />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wider mb-2">聯絡與教學</h4>
                                                        <DetailRow label="備用 Email" value={inst.email_secondary} />
                                                        <DetailRow label="地址" value={inst.address} />
                                                        <DetailRow label="學期接課" value={inst.teaching_freq_semester} />
                                                        <DetailRow label="寒暑接課" value={inst.teaching_freq_vacation} />
                                                    </div>
                                                    <div className="space-y-2">
                                                        <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wider mb-2">接課地區</h4>
                                                        {inst.teaching_regions?.length > 0 ? (
                                                            <div className="flex flex-wrap gap-1">
                                                                {inst.teaching_regions.map(r => (
                                                                    <span key={r} className="text-xs bg-blue-50 text-blue-600 px-2 py-0.5 rounded-full">{r}</span>
                                                                ))}
                                                            </div>
                                                        ) : <span className="text-xs text-slate-400">未設定</span>}
                                                        {inst.bio_notes && (
                                                            <>
                                                                <h4 className="font-bold text-slate-700 text-xs uppercase tracking-wider mt-3 mb-1">自我介紹</h4>
                                                                <p className="text-slate-600 text-xs whitespace-pre-wrap line-clamp-4">{inst.bio_notes}</p>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                    {isExpanded && !inst && (
                                        <tr>
                                            <td colSpan={totalCols} className="px-6 py-5 bg-slate-50/70 text-center text-sm text-slate-400">
                                                此講師尚未填寫個人資料
                                            </td>
                                        </tr>
                                    )}
                                </React.Fragment>
                            );
                        })}
                        {filteredList.length === 0 && (
                            <tr><td colSpan={showMentorCol ? 7 : 6} className="px-6 py-12 text-center text-slate-400">
                                {tab === 'pending' ? '目前沒有待審核的使用者' :
                                 tab === 'teacher' ? '目前沒有講師' :
                                 tab === 'mentor' ? '目前沒有輔導員' : '目前沒有管理員'}
                            </td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
};

const DetailRow = ({ label, value }) => {
    if (!value) return null;
    return (
        <div className="flex items-start gap-2">
            <span className="text-slate-400 whitespace-nowrap min-w-[72px]">{label}：</span>
            <span className="text-slate-700">{value}</span>
        </div>
    );
};

export default TeacherManager;
