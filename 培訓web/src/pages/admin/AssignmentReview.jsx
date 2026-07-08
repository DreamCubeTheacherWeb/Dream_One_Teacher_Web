import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import { MessageSquare, User, Calendar, Play, Search, Filter, ChevronDown, Star, GraduationCap, Send, Clock, Trash2 } from 'lucide-react';

const toEmbedUrl = (url) => {
    if (!url) return '';
    try {
        const u = new URL(url);
        if (u.pathname.startsWith('/embed/')) return url;
        if ((u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.searchParams.get('v')) {
            return `https://www.youtube.com/embed/${u.searchParams.get('v')}`;
        }
        if (u.hostname === 'youtu.be' && u.pathname.length > 1) {
            return `https://www.youtube.com/embed${u.pathname}`;
        }
        if (u.pathname.startsWith('/shorts/')) {
            return `https://www.youtube.com/embed/${u.pathname.replace('/shorts/', '')}`;
        }
    } catch { /* ignore */ }
    return url;
};

const ROLE_LABELS = { S: 'S 級', 'A+': 'A+ 級', A: 'A 級', B: 'B 級', '實習': '實習', '職員': '職員', '工讀生': '工讀生' };

const AssignmentReview = () => {
    const { user, profile } = useAuth();
    const [assignments, setAssignments] = useState([]);
    const [users, setUsers] = useState({});
    const [instructors, setInstructors] = useState({});
    const [loading, setLoading] = useState(true);

    const [mentorFilter, setMentorFilter] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedUserId, setSelectedUserId] = useState(null);
    const [selectedAssignment, setSelectedAssignment] = useState(null);
    const [feedbackText, setFeedbackText] = useState('');
    const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
    const [mentorList, setMentorList] = useState([]);

    const [feedbacksMap, setFeedbacksMap] = useState({});
    const [feedbackAuthors, setFeedbackAuthors] = useState({});

    const isAdmin = profile?.role === 'admin';

    useEffect(() => {
        fetchAll();
    }, []);

    const fetchAll = async () => {
        const [assignRes, allMentorsRes] = await Promise.all([
            supabase
                .from('assignments')
                .select('*, lessons(title, course_id, courses(title))')
                .order('created_at', { ascending: false }),
            supabase
                .from('users')
                .select('mentor_name')
                .not('mentor_name', 'is', null),
        ]);

        const allAssignments = assignRes.data || [];
        setAssignments(allAssignments);

        const allMentorNames = [...new Set((allMentorsRes.data || []).map(u => u.mentor_name).filter(Boolean))].sort();
        setMentorList(allMentorNames);

        const uids = [...new Set(allAssignments.map((a) => a.user_id))];
        if (uids.length > 0) {
            const { data: userData } = await supabase
                .from('users')
                .select('id, name, email, role, mentor_name')
                .in('id', uids);
            const uMap = {};
            userData?.forEach((u) => { uMap[u.id] = u; });
            setUsers(uMap);

            const { data: instrData } = await supabase
                .from('instructors')
                .select('user_id, full_name, nickname, instructor_role')
                .in('user_id', uids);
            const iMap = {};
            instrData?.forEach((i) => { iMap[i.user_id] = i; });
            setInstructors(iMap);
        }

        const assignIds = allAssignments.map(a => a.id);
        if (assignIds.length > 0) {
            const { data: fbData } = await supabase
                .from('assignment_feedbacks')
                .select('*')
                .in('assignment_id', assignIds)
                .order('created_at', { ascending: true });

            const fbMap = {};
            const authorUids = new Set();
            (fbData || []).forEach(fb => {
                if (!fbMap[fb.assignment_id]) fbMap[fb.assignment_id] = [];
                fbMap[fb.assignment_id].push(fb);
                authorUids.add(fb.user_id);
            });
            setFeedbacksMap(fbMap);

            if (authorUids.size > 0) {
                const authorIds = [...authorUids];
                const [{ data: authorInstr }, { data: authorUsers }] = await Promise.all([
                    supabase.from('instructors').select('user_id, full_name, nickname').in('user_id', authorIds),
                    supabase.from('users').select('id, name, role').in('id', authorIds),
                ]);
                const aMap = {};
                authorUsers?.forEach(u => { aMap[u.id] = { name: u.name, role: u.role }; });
                authorInstr?.forEach(i => {
                    if (!aMap[i.user_id]) aMap[i.user_id] = {};
                    aMap[i.user_id].full_name = i.full_name;
                    aMap[i.user_id].nickname = i.nickname;
                });
                setFeedbackAuthors(aMap);
            }
        }

        setLoading(false);
    };

    const getFeedbackAuthorDisplay = (uid) => {
        const a = feedbackAuthors[uid];
        if (!a) return '未知';
        const roleBadge = a.role === 'admin' ? '管理員' : a.role === 'mentor' ? '輔導員' : '';
        const displayName = a.nickname || a.full_name || a.name || '';
        if (roleBadge && displayName) return `${roleBadge} ${displayName}`;
        if (displayName) return displayName;
        return roleBadge || '未知';
    };

    const submitFeedback = async () => {
        if (!selectedAssignment || !feedbackText.trim()) return;
        setFeedbackSubmitting(true);

        const { data: newFb, error } = await supabase
            .from('assignment_feedbacks')
            .insert({
                assignment_id: selectedAssignment.id,
                user_id: user.id,
                body: feedbackText.trim(),
            })
            .select()
            .single();

        if (error) {
            alert('回饋送出失敗：' + error.message);
            setFeedbackSubmitting(false);
            return;
        }

        setFeedbacksMap(prev => ({
            ...prev,
            [selectedAssignment.id]: [...(prev[selectedAssignment.id] || []), newFb],
        }));

        const { data: myInstr } = await supabase
            .from('instructors')
            .select('full_name, nickname')
            .eq('user_id', user.id)
            .maybeSingle();
        setFeedbackAuthors(prev => ({
            ...prev,
            [user.id]: {
                ...prev[user.id],
                full_name: myInstr?.full_name,
                nickname: myInstr?.nickname,
                role: profile?.role,
                name: profile?.name,
            },
        }));

        await supabase.from('notifications').insert({
            user_id: selectedAssignment.user_id,
            type: 'feedback',
            title: '你的作業收到了新回饋',
            body: `「${selectedAssignment.lessons?.title || '課程作業'}」的作業收到新回饋`,
            link: selectedAssignment.lessons?.course_id
                ? `/courses/${selectedAssignment.lessons.course_id}/lessons/${selectedAssignment.lesson_id}`
                : null,
        });

        setFeedbackText('');
        setFeedbackSubmitting(false);
    };

    const deleteFeedback = async (fbId, assignmentId) => {
        if (!confirm('確定要刪除此回饋嗎？')) return;
        const { error } = await supabase
            .from('assignment_feedbacks')
            .delete()
            .eq('id', fbId);
        if (error) {
            alert('刪除失敗：' + error.message);
            return;
        }
        setFeedbacksMap(prev => ({
            ...prev,
            [assignmentId]: (prev[assignmentId] || []).filter(f => f.id !== fbId),
        }));
    };

    const getTeacherName = (uid) => {
        const instr = instructors[uid];
        if (instr?.nickname && instr?.full_name) return `${instr.nickname}（${instr.full_name}）`;
        if (instr?.full_name) return instr.full_name;
        const u = users[uid];
        return u?.name || u?.email?.split('@')[0] || uid.substring(0, 8);
    };

    const getTeacherRole = (uid) => instructors[uid]?.instructor_role || null;
    const getTeacherMentor = (uid) => users[uid]?.mentor_name || null;

    const teacherGroups = {};
    assignments.forEach((a) => {
        if (!teacherGroups[a.user_id]) teacherGroups[a.user_id] = [];
        teacherGroups[a.user_id].push(a);
    });

    const filteredTeacherIds = Object.keys(teacherGroups).filter((uid) => {
        if (mentorFilter !== 'all' && getTeacherMentor(uid) !== mentorFilter) return false;
        if (searchQuery) {
            const name = getTeacherName(uid).toLowerCase();
            const email = (users[uid]?.email || '').toLowerCase();
            const q = searchQuery.toLowerCase();
            if (!name.includes(q) && !email.includes(q)) return false;
        }
        if (statusFilter !== 'all') {
            const group = teacherGroups[uid];
            if (statusFilter === 'pending' && !group.some(a => !(feedbacksMap[a.id]?.length > 0))) return false;
            if (statusFilter === 'reviewed' && !group.some(a => feedbacksMap[a.id]?.length > 0)) return false;
        }
        return true;
    });

    const selectedTeacherAssignments = selectedUserId
        ? (teacherGroups[selectedUserId] || [])
        : [];

    const formatTime = (ts) => {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
            + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    };

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    return (
        <div className="p-4 sm:p-8 max-w-7xl mx-auto">
            <h1 className="text-2xl sm:text-3xl font-black text-slate-900 mb-2">作業審核中心</h1>
            <p className="text-slate-500 mb-8">依輔導員或講師查看並給予作業回饋</p>

            {/* Filter bar */}
            <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-6 shadow-sm flex flex-col sm:flex-row items-stretch sm:items-center gap-4">
                <div className="flex items-center gap-2">
                    <Filter className="w-4 h-4 text-slate-400" />
                    <select
                        value={mentorFilter}
                        onChange={(e) => setMentorFilter(e.target.value)}
                        className="text-sm px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-300 outline-none bg-white"
                    >
                        <option value="all">全部輔導員</option>
                        {mentorList.map((m) => (
                            <option key={m} value={m}>{m}</option>
                        ))}
                    </select>
                </div>
                <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="text-sm px-3 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-300 outline-none bg-white"
                >
                    <option value="all">全部狀態</option>
                    <option value="pending">待審核</option>
                    <option value="reviewed">已回饋</option>
                </select>
                <div className="flex-1 min-w-0 sm:min-w-[200px] relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜尋講師姓名或 Email..."
                        className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-300 outline-none"
                    />
                </div>
            </div>

            <div className="flex flex-col lg:flex-row gap-6">
                <div className="w-full lg:w-80 lg:shrink-0 space-y-2 max-h-none lg:max-h-[calc(100vh-240px)] overflow-y-auto pr-1">
                    {filteredTeacherIds.length === 0 ? (
                        <div className="text-center py-12 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                            <User className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                            <p className="text-slate-400 text-sm">沒有符合條件的講師</p>
                        </div>
                    ) : (
                        filteredTeacherIds.map((uid) => {
                            const group = teacherGroups[uid];
                            const pendingCount = group.filter(a => !(feedbacksMap[a.id]?.length > 0)).length;
                            const role = getTeacherRole(uid);
                            const mentor = getTeacherMentor(uid);
                            const isSelected = selectedUserId === uid;

                            return (
                                <button
                                    key={uid}
                                    onClick={() => {
                                        setSelectedUserId(uid);
                                        setSelectedAssignment(null);
                                        setFeedbackText('');
                                    }}
                                    className={`w-full text-left p-4 rounded-xl border transition-all ${
                                        isSelected
                                            ? 'bg-blue-50 border-blue-200 shadow-md'
                                            : 'bg-white border-slate-100 hover:border-slate-300'
                                    }`}
                                >
                                    <div className="flex items-start justify-between mb-1">
                                        <span className="font-bold text-slate-800 text-sm leading-tight">
                                            {getTeacherName(uid)}
                                        </span>
                                        {pendingCount > 0 && (
                                            <span className="bg-red-500 text-white text-[10px] font-black px-1.5 py-0.5 rounded-full shrink-0 ml-2">
                                                {pendingCount}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                        {role && (
                                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-violet-50 text-violet-600">
                                                {ROLE_LABELS[role] || role}
                                            </span>
                                        )}
                                        {mentor && (
                                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-teal-50 text-teal-600">
                                                {mentor}
                                            </span>
                                        )}
                                        <span className="text-[10px] text-slate-400">
                                            {group.length} 份作業
                                        </span>
                                    </div>
                                </button>
                            );
                        })
                    )}
                </div>

                {/* Right: Assignment details */}
                <div className="flex-1 min-w-0 w-full">
                    {!selectedUserId ? (
                        <div className="h-full flex items-center justify-center text-slate-400 bg-slate-50 rounded-2xl border border-dashed border-slate-200 min-h-[400px]">
                            <div className="text-center">
                                <GraduationCap className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                                <p className="font-medium"><span className="lg:hidden">請從上方選擇一位講師</span><span className="hidden lg:inline">請從左側選擇一位講師</span></p>
                                <p className="text-sm mt-1">查看其繳交的作業並給予回饋</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-4 max-h-[calc(100vh-240px)] overflow-y-auto pr-1">
                            {/* Teacher header */}
                            <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm sticky top-0 z-10">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h2 className="text-lg font-black text-slate-800">{getTeacherName(selectedUserId)}</h2>
                                        <p className="text-xs text-slate-400 mt-0.5">{users[selectedUserId]?.email}</p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {getTeacherRole(selectedUserId) && (
                                            <span className="text-xs font-bold px-2 py-1 rounded-full bg-violet-50 text-violet-600">
                                                {ROLE_LABELS[getTeacherRole(selectedUserId)] || getTeacherRole(selectedUserId)}
                                            </span>
                                        )}
                                        {getTeacherMentor(selectedUserId) && (
                                            <span className="text-xs font-bold px-2 py-1 rounded-full bg-teal-50 text-teal-600">
                                                輔導員：{getTeacherMentor(selectedUserId)}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Assignment cards */}
                            {selectedTeacherAssignments.map((a) => {
                                const isActive = selectedAssignment?.id === a.id;
                                const lessonTitle = a.lessons?.title || '未知章節';
                                const courseTitle = a.lessons?.courses?.title || '';
                                const isYouTube = a.type === 'youtube' || (a.video_url && a.video_url.includes('youtu'));
                                const fbs = feedbacksMap[a.id] || [];
                                const hasFeedback = fbs.length > 0;

                                return (
                                    <div
                                        key={a.id}
                                        className={`bg-white rounded-2xl border overflow-hidden transition-all ${
                                            isActive ? 'border-blue-200 shadow-lg' : 'border-slate-200 shadow-sm'
                                        }`}
                                    >
                                        {/* Card header */}
                                        <button
                                            onClick={() => {
                                                setSelectedAssignment(isActive ? null : a);
                                                setFeedbackText('');
                                            }}
                                            className="w-full text-left px-6 py-4 flex items-center justify-between hover:bg-slate-50 transition-colors"
                                        >
                                            <div>
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-0.5 rounded">
                                                        {isYouTube ? 'YouTube 影片' : a.type === 'video' ? '影片檔案' : '文字心得'}
                                                    </span>
                                                    {hasFeedback ? (
                                                        <span className="text-[10px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                                                            {fbs.length} 則回饋
                                                        </span>
                                                    ) : (
                                                        <span className="text-[10px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">待審核</span>
                                                    )}
                                                </div>
                                                <p className="font-bold text-slate-800 text-sm">{lessonTitle}</p>
                                                {courseTitle && <p className="text-[11px] text-slate-400">{courseTitle}</p>}
                                            </div>
                                            <div className="flex items-center gap-3">
                                                <span className="text-[11px] text-slate-400 flex items-center gap-1">
                                                    <Calendar className="w-3 h-3" />
                                                    {new Date(a.created_at).toLocaleDateString('zh-TW')}
                                                </span>
                                                <ChevronDown className={`w-4 h-4 text-slate-300 transition-transform ${isActive ? 'rotate-180' : ''}`} />
                                            </div>
                                        </button>

                                        {/* Expanded content */}
                                        {isActive && (
                                            <div className="border-t border-slate-100">
                                                {/* Assignment content */}
                                                <div className="px-6 py-5">
                                                    {a.video_url ? (
                                                        <div className="aspect-video rounded-xl overflow-hidden bg-black">
                                                            <iframe
                                                                src={toEmbedUrl(a.video_url)}
                                                                title="作業影片"
                                                                className="w-full h-full"
                                                                allowFullScreen
                                                            />
                                                        </div>
                                                    ) : a.file_url ? (
                                                        <a
                                                            href={a.file_url}
                                                            target="_blank"
                                                            rel="noreferrer"
                                                            className="flex items-center gap-2 text-blue-600 font-bold hover:underline"
                                                        >
                                                            <Play className="w-4 h-4" /> 點此觀看影片作業
                                                        </a>
                                                    ) : (
                                                        <div className="bg-slate-50 p-5 rounded-xl border border-slate-100 text-slate-700 leading-relaxed whitespace-pre-wrap">
                                                            {a.content || '（無文字內容）'}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* Feedback thread */}
                                                <div className="px-6 pb-4">
                                                    <h4 className="text-sm font-black text-slate-700 flex items-center gap-2 mb-3">
                                                        <MessageSquare className="w-4 h-4 text-amber-500" />
                                                        回饋紀錄 {fbs.length > 0 && <span className="text-xs font-medium text-slate-400">（{fbs.length} 則）</span>}
                                                    </h4>

                                                    {fbs.length === 0 ? (
                                                        <div className="bg-slate-50 border border-dashed border-slate-200 rounded-xl px-5 py-4 text-center">
                                                            <p className="text-slate-400 text-sm">尚未有任何回饋</p>
                                                        </div>
                                                    ) : (
                                                        <div className="space-y-3">
                                                            {fbs.map((fb) => (
                                                                <div key={fb.id} className="bg-amber-50/60 border border-amber-200/60 rounded-xl px-5 py-4">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-sm font-black text-amber-700">
                                                                                {getFeedbackAuthorDisplay(fb.user_id)}
                                                                            </span>
                                                                        </div>
                                                                        <div className="flex items-center gap-2">
                                                                            <span className="text-xs text-amber-500 flex items-center gap-1">
                                                                                <Clock className="w-3 h-3" />
                                                                                {formatTime(fb.created_at)}
                                                                            </span>
                                                                            {(isAdmin || fb.user_id === user.id) && (
                                                                                <button
                                                                                    onClick={() => deleteFeedback(fb.id, a.id)}
                                                                                    className="relative text-amber-400 hover:text-red-500 transition-colors before:absolute before:-inset-2 before:content-['']"
                                                                                    title="刪除此回饋"
                                                                                >
                                                                                    <Trash2 className="w-3.5 h-3.5" />
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                    <p className="text-amber-900 text-sm leading-relaxed whitespace-pre-wrap">{fb.body}</p>
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>

                                                {/* New feedback input */}
                                                <div className="px-6 py-5 bg-slate-50 border-t border-slate-100">
                                                    <label className="flex items-center gap-2 font-bold text-slate-800 text-sm mb-3">
                                                        <Send className="w-4 h-4 text-blue-600" />
                                                        新增回饋
                                                    </label>
                                                    <textarea
                                                        rows="3"
                                                        value={feedbackText}
                                                        onChange={(e) => setFeedbackText(e.target.value)}
                                                        className="w-full px-4 py-3 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-300 outline-none resize-none text-slate-700 text-sm"
                                                        placeholder="在此輸入您的評語或建議..."
                                                    />
                                                    <button
                                                        onClick={submitFeedback}
                                                        disabled={!feedbackText.trim() || feedbackSubmitting}
                                                        className="mt-3 w-full py-2.5 bg-blue-600 text-white font-bold rounded-xl hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed text-sm flex items-center justify-center gap-2"
                                                    >
                                                        <Send className="w-4 h-4" />
                                                        {feedbackSubmitting ? '送出中...' : '送出回饋'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default AssignmentReview;
