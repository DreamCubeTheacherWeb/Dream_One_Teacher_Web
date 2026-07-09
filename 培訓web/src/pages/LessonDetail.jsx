import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { ChevronLeft, ChevronRight, Play, FileText, CheckCircle, Circle, Image as ImageIcon, MessageSquare, Send, Clock, Star, ThumbsUp, Trash2, ZoomIn, ZoomOut } from 'lucide-react';

const CANVAS_WIDTH = 960;

// YouTube URL → embed URL 轉換
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

const LessonDetail = () => {
    const { courseId, lessonId } = useParams();
    const { profile } = useAuth();
    const [course, setCourse] = useState(null);
    const [lesson, setLesson] = useState(null);
    const [lessons, setLessons] = useState([]);
    const [contents, setContents] = useState([]);
    const [progress, setProgress] = useState({});
    const [loading, setLoading] = useState(true);
    const [assignment, setAssignment] = useState({ content: '', type: 'text', video_url: '' });
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [currentUser, setCurrentUser] = useState(null);
    const [instructorRole, setInstructorRole] = useState(null);
    const [myAssignments, setMyAssignments] = useState([]);
    const [comments, setComments] = useState([]);
    const [newComment, setNewComment] = useState('');
    const [commentSubmitting, setCommentSubmitting] = useState(false);
    const [commentLikes, setCommentLikes] = useState({});
    const [myLikes, setMyLikes] = useState(new Set());
    const isAdmin = profile?.role === 'admin';

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);

            // Get current user
            const { data: { user } } = await supabase.auth.getUser();
            setCurrentUser(user);

            // Fetch course
            const { data: courseData } = await supabase
                .from('courses')
                .select('*')
                .eq('id', courseId)
                .single();
            setCourse(courseData);

            // Fetch all lessons (for prev/next nav)
            const { data: allLessons } = await supabase
                .from('lessons')
                .select('id, title, order')
                .eq('course_id', courseId)
                .order('order', { ascending: true });
            setLessons(allLessons || []);

            // Fetch this lesson
            const { data: lessonData } = await supabase
                .from('lessons')
                .select('*')
                .eq('id', lessonId)
                .single();
            setLesson(lessonData);

            // Fetch contents
            const { data: contentsData } = await supabase
                .from('contents')
                .select('*')
                .eq('lesson_id', lessonId)
                .order('order', { ascending: true });
            setContents(contentsData || []);

            // Fetch progress & instructor role
            if (user) {
                const { data: instrData } = await supabase
                    .from('instructors')
                    .select('instructor_role')
                    .eq('user_id', user.id)
                    .maybeSingle();
                setInstructorRole(instrData?.instructor_role || null);

                const { data: progressData } = await supabase
                    .from('progress')
                    .select('lesson_id, completed')
                    .eq('user_id', user.id)
                    .eq('lesson_id', lessonId);
                const progMap = {};
                progressData?.forEach(p => { progMap[p.lesson_id] = p.completed; });
                setProgress(progMap);

                // Fetch my assignments for this lesson
                const { data: assignData } = await supabase
                    .from('assignments')
                    .select('*')
                    .eq('user_id', user.id)
                    .eq('lesson_id', lessonId)
                    .order('created_at', { ascending: false });

                if (assignData && assignData.length > 0) {
                    const assignIds = assignData.map(a => a.id);
                    const { data: fbData } = await supabase
                        .from('assignment_feedbacks')
                        .select('*')
                        .in('assignment_id', assignIds)
                        .order('created_at', { ascending: true });

                    const fbMap = {};
                    const fbAuthorUids = new Set();
                    (fbData || []).forEach(fb => {
                        if (!fbMap[fb.assignment_id]) fbMap[fb.assignment_id] = [];
                        fbMap[fb.assignment_id].push(fb);
                        fbAuthorUids.add(fb.user_id);
                    });

                    let fbAuthorMap = {};
                    if (fbAuthorUids.size > 0) {
                        const authorIds = [...fbAuthorUids];
                        const [{ data: aInstr }, { data: aUsers }] = await Promise.all([
                            supabase.from('instructors').select('user_id, full_name, nickname').in('user_id', authorIds),
                            supabase.from('users').select('id, name, role').in('id', authorIds),
                        ]);
                        aUsers?.forEach(u => { fbAuthorMap[u.id] = { name: u.name, role: u.role }; });
                        aInstr?.forEach(i => {
                            if (!fbAuthorMap[i.user_id]) fbAuthorMap[i.user_id] = {};
                            fbAuthorMap[i.user_id].full_name = i.full_name;
                            fbAuthorMap[i.user_id].nickname = i.nickname;
                        });
                    }

                    setMyAssignments(assignData.map(a => ({
                        ...a,
                        feedbacks: (fbMap[a.id] || []).map(fb => ({
                            ...fb,
                            authorDisplay: (() => {
                                const au = fbAuthorMap[fb.user_id];
                                if (!au) return '輔導員';
                                const roleBadge = au.role === 'admin' ? '管理員' : au.role === 'mentor' ? '輔導員' : '';
                                const dn = au.nickname || au.full_name || au.name || '';
                                if (roleBadge && dn) return `${roleBadge} ${dn}`;
                                return dn || roleBadge || '輔導員';
                            })(),
                        })),
                    })));
                } else {
                    setMyAssignments([]);
                }
            }

            // Fetch lesson comments (public)
            const { data: commentData } = await supabase
                .from('lesson_comments')
                .select('*')
                .eq('lesson_id', lessonId)
                .order('created_at', { ascending: true });
            if (commentData && commentData.length > 0) {
                const uids = [...new Set(commentData.map((c) => c.user_id))];
                const { data: instrData } = await supabase
                    .from('instructors')
                    .select('user_id, full_name, nickname')
                    .in('user_id', uids);
                const nameMap = {};
                instrData?.forEach((i) => { nameMap[i.user_id] = { full_name: i.full_name, nickname: i.nickname }; });
                setComments(commentData.map((c) => ({
                    ...c,
                    authorName: nameMap[c.user_id]?.full_name || null,
                    authorNickname: nameMap[c.user_id]?.nickname || null,
                })));

                // Fetch likes for these comments
                const commentIds = commentData.map((c) => c.id);
                const { data: likesData } = await supabase
                    .from('lesson_comment_likes')
                    .select('comment_id, user_id')
                    .in('comment_id', commentIds);
                const likeCounts = {};
                const myLikeSet = new Set();
                likesData?.forEach((l) => {
                    likeCounts[l.comment_id] = (likeCounts[l.comment_id] || 0) + 1;
                    if (user && l.user_id === user.id) myLikeSet.add(l.comment_id);
                });
                setCommentLikes(likeCounts);
                setMyLikes(myLikeSet);
            } else {
                setComments([]);
                setCommentLikes({});
                setMyLikes(new Set());
            }

            setLoading(false);
        };
        fetchData();
    }, [courseId, lessonId]);

    const toggleComplete = async () => {
        if (!currentUser) return;
        const isCompleted = !!progress[lessonId];
        const newStatus = !isCompleted;
        const { error } = await supabase
            .from('progress')
            .upsert({
                user_id: currentUser.id,
                lesson_id: lessonId,
                completed: newStatus,
                updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,lesson_id' });

        if (error) {
            console.error('進度更新失敗:', error);
            alert('進度更新失敗：' + error.message);
            return;
        }
        setProgress({ ...progress, [lessonId]: newStatus });
    };

    const submitAssignment = async () => {
        if (!currentUser || !lesson) return;
        if (assignment.type === 'text' && !assignment.content.trim()) {
            alert('請輸入作業內容');
            return;
        }
        if (assignment.type === 'youtube' && !assignment.video_url.trim()) {
            alert('請貼上 YouTube 連結');
            return;
        }
        setIsSubmitting(true);
        const payload = {
            user_id: currentUser.id,
            lesson_id: lesson.id,
            type: assignment.type,
            content: assignment.type === 'text' ? assignment.content : null,
            video_url: assignment.type === 'youtube' ? assignment.video_url : null,
        };
        const { data: newRow, error } = await supabase
            .from('assignments')
            .insert(payload)
            .select()
            .single();

        if (error) {
            console.error('作業繳交失敗:', error);
            alert('作業繳交失敗：' + error.message);
        } else {
            setMyAssignments((prev) => [newRow, ...prev]);
            setAssignment({ content: '', type: 'text', video_url: '' });
        }
        setIsSubmitting(false);
    };

    const submitComment = async () => {
        if (!currentUser || !newComment.trim()) return;
        setCommentSubmitting(true);
        const { data: row, error } = await supabase
            .from('lesson_comments')
            .insert({ lesson_id: lessonId, user_id: currentUser.id, body: newComment.trim() })
            .select()
            .single();
        if (error) {
            console.error('留言失敗:', error);
            alert('留言失敗：' + error.message);
        } else {
            // Fetch current user's instructor name
            const { data: instr } = await supabase
                .from('instructors')
                .select('full_name, nickname')
                .eq('user_id', currentUser.id)
                .maybeSingle();
            setComments((prev) => [...prev, {
                ...row,
                authorName: instr?.full_name || null,
                authorNickname: instr?.nickname || null,
            }]);
            setNewComment('');
        }
        setCommentSubmitting(false);
    };

    const toggleLike = async (commentId) => {
        if (!currentUser) return;
        const liked = myLikes.has(commentId);
        if (liked) {
            await supabase
                .from('lesson_comment_likes')
                .delete()
                .eq('comment_id', commentId)
                .eq('user_id', currentUser.id);
            setMyLikes((prev) => { const next = new Set(prev); next.delete(commentId); return next; });
            setCommentLikes((prev) => ({ ...prev, [commentId]: Math.max(0, (prev[commentId] || 1) - 1) }));
        } else {
            await supabase
                .from('lesson_comment_likes')
                .insert({ comment_id: commentId, user_id: currentUser.id });
            setMyLikes((prev) => new Set(prev).add(commentId));
            setCommentLikes((prev) => ({ ...prev, [commentId]: (prev[commentId] || 0) + 1 }));

            const comment = comments.find(c => c.id === commentId);
            if (comment && comment.user_id !== currentUser.id) {
                await supabase.from('notifications').insert({
                    user_id: comment.user_id,
                    type: 'like',
                    title: '你的留言被按讚了',
                    body: comment.body?.substring(0, 50) || '你的留言',
                    link: `/courses/${courseId}/lessons/${lessonId}`,
                });
            }
        }
    };

    const deleteComment = async (commentId) => {
        if (!confirm('確定要刪除此留言嗎？')) return;
        const { error } = await supabase
            .from('lesson_comments')
            .delete()
            .eq('id', commentId);
        if (error) {
            alert('刪除失敗：' + error.message);
        } else {
            setComments((prev) => prev.filter((c) => c.id !== commentId));
        }
    };

    const formatTime = (ts) => {
        if (!ts) return '';
        const d = new Date(ts);
        return d.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' })
            + ' ' + d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    };

    const displayName = (c) => {
        if (c.authorNickname && c.authorName) return `${c.authorNickname}（${c.authorName}）`;
        if (c.authorName) return c.authorName;
        if (c.authorNickname) return c.authorNickname;
        return '匿名';
    };

    if (loading) return (
        <div className="p-12 text-center text-bauhaus-black/50 text-lg font-bold">章節內容載入中...</div>
    );
    if (!lesson) return (
        <div className="p-12 text-center text-bauhaus-red font-bold">找不到此章節。</div>
    );

    const currentIdx = lessons.findIndex(l => l.id === lessonId);
    const prevLesson = currentIdx > 0 ? lessons[currentIdx - 1] : null;
    const nextLesson = currentIdx < lessons.length - 1 ? lessons[currentIdx + 1] : null;
    const isCompleted = !!progress[lessonId];
    const hasCanvasContent = contents.some(c => c.position_data != null);

    const showAssignment = (() => {
        if (!lesson.requires_assignment) return false;
        const af = lesson.assignment_for || 'all';
        if (af === 'all') return true;
        if (af === 'intern' && instructorRole === '實習') return true;
        if (af === 'formal' && ['B', 'A', 'A+', 'S'].includes(instructorRole)) return true;
        if (isAdmin) return true;
        return false;
    })();

    return (
        <div className="max-w-4xl mx-auto px-6 py-10">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-xs font-bold text-bauhaus-black/50 mb-8">
                <Link to="/courses" className="hover:text-bauhaus-blue transition-colors duration-200">我的課程</Link>
                <ChevronRight className="w-3 h-3" />
                <Link to={`/courses/${courseId}`} className="hover:text-bauhaus-blue transition-colors duration-200">
                    {course?.title}
                </Link>
                <ChevronRight className="w-3 h-3" />
                <span className="text-bauhaus-black truncate max-w-[200px]">{lesson.title}</span>
            </div>

            {/* Lesson header */}
            <div className="flex items-start justify-between gap-4 mb-10 pb-8 border-b-2 lg:border-b-4 border-bauhaus-black">
                <div>
                    <div className="text-[10px] font-black text-bauhaus-black/40 uppercase tracking-[0.2em] mb-2">
                        章節 {currentIdx + 1}
                    </div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight leading-[0.95]">{lesson.title}</h1>
                </div>
                <button
                    onClick={toggleComplete}
                    className={`shrink-0 flex items-center gap-2.5 px-5 py-2.5 border-2 border-bauhaus-black text-sm font-black uppercase tracking-wide shadow-hard transition-all duration-200 min-h-[44px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none ${isCompleted
                        ? 'bg-bauhaus-blue text-white hover:bg-bauhaus-blue/90'
                        : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                        }`}
                >
                    {isCompleted ? <CheckCircle className="w-4 h-4" /> : <Circle className="w-4 h-4" />}
                    {isCompleted ? '已完成學習' : '標記完成'}
                </button>
            </div>

            {/* Contents */}
            {hasCanvasContent ? (
                <CanvasViewer contents={contents} />
            ) : (
                <div className="space-y-8">
                    {contents.map((item) => (
                        <div
                            key={item.id}
                            className="bh-card overflow-hidden"
                        >
                            <div className="px-6 py-4 bg-bauhaus-paper border-b-2 border-bauhaus-black flex items-center gap-3">
                                <div className={`p-2 border-2 border-bauhaus-black ${
                                    item.type === 'video' ? 'bg-bauhaus-blue text-white' :
                                    item.type === 'image_text' ? 'bg-bauhaus-yellow text-bauhaus-black' :
                                    'bg-bauhaus-black text-white'
                                }`}>
                                    {item.type === 'video' ? <Play className="w-4 h-4" /> :
                                     item.type === 'image_text' ? <ImageIcon className="w-4 h-4" /> :
                                     <FileText className="w-4 h-4" />}
                                </div>
                                <span className="text-sm font-black text-bauhaus-black uppercase tracking-wide">{item.title}</span>
                            </div>
                            <div className="p-8">
                                {item.type === 'image_text' ? (
                                    <ImageTextContent item={item} />
                                ) : item.type === 'video' ? (
                                    <div className="aspect-video bg-bauhaus-black overflow-hidden border-2 border-bauhaus-black">
                                        <iframe
                                            src={toEmbedUrl(item.video_url)}
                                            title={item.title}
                                            className="w-full h-full"
                                            allowFullScreen
                                        />
                                    </div>
                                ) : (
                                    <div
                                        className="prose prose-slate prose-lg max-w-none prose-headings:font-black prose-p:leading-relaxed prose-a:text-bauhaus-blue font-medium text-bauhaus-black ql-editor lesson-content"
                                        dangerouslySetInnerHTML={{ __html: item.body }}
                                    />
                                )}
                            </div>
                        </div>
                    ))}

                    {contents.length === 0 && (
                        <div className="py-24 text-center bg-white border-2 border-bauhaus-black">
                            <p className="text-bauhaus-black/50 font-medium">本章節暫無學習內容。</p>
                        </div>
                    )}
                </div>
            )}

            {/* Assignment section */}
            {showAssignment && (
            <div className="mt-16 pt-12 border-t-2 lg:border-t-4 border-bauhaus-black">
                {/* Previously submitted assignments */}
                {myAssignments.length > 0 && (
                    <div className="mb-10 space-y-5">
                        <h3 className="text-xl font-black text-bauhaus-black flex items-center gap-2">
                            <CheckCircle className="w-5 h-5 text-bauhaus-blue" /> 我的作業紀錄
                        </h3>
                        {myAssignments.map((a) => (
                            <div key={a.id} className="bh-card overflow-hidden">
                                <div className="px-6 py-4 bg-bauhaus-paper border-b-2 border-bauhaus-black flex items-center justify-between">
                                    <span className="text-xs font-bold text-bauhaus-black/50 flex items-center gap-1.5">
                                        <Clock className="w-3.5 h-3.5" /> {formatTime(a.created_at)}
                                    </span>
                                    <span className="text-[10px] font-bold text-bauhaus-black/40 uppercase tracking-wider">
                                        {a.type === 'youtube' ? 'YouTube 影片' : a.type === 'video' ? '影片作業' : '文字作業'}
                                    </span>
                                </div>
                                <div className="px-6 py-5">
                                    {a.video_url ? (
                                        <div className="aspect-video overflow-hidden bg-bauhaus-black border-2 border-bauhaus-black">
                                            <iframe src={toEmbedUrl(a.video_url)} title="作業影片" className="w-full h-full" allowFullScreen />
                                        </div>
                                    ) : (
                                        <p className="text-bauhaus-black whitespace-pre-wrap leading-relaxed">{a.content}</p>
                                    )}
                                </div>
                                <div className="px-6 py-4 border-t-2 border-bauhaus-black">
                                    {a.feedbacks && a.feedbacks.length > 0 ? (
                                        <div className="space-y-3">
                                            <h4 className="text-sm font-black text-bauhaus-black flex items-center gap-2">
                                                <MessageSquare className="w-4 h-4 text-bauhaus-black" />
                                                回饋紀錄（{a.feedbacks.length} 則）
                                            </h4>
                                            {a.feedbacks.map((fb) => (
                                                <div key={fb.id} className="bg-bauhaus-cream border-2 border-bauhaus-black px-5 py-4">
                                                    <div className="flex items-center justify-between mb-2">
                                                        <div className="flex items-center gap-2">
                                                            <Star className="w-4 h-4 text-bauhaus-black" />
                                                            <span className="text-sm font-black text-bauhaus-black">
                                                                {fb.authorDisplay}
                                                            </span>
                                                        </div>
                                                        <span className="text-xs text-bauhaus-black/50 flex items-center gap-1">
                                                            <Clock className="w-3 h-3" />
                                                            {formatTime(fb.created_at)}
                                                        </span>
                                                    </div>
                                                    <p className="text-bauhaus-black text-sm leading-relaxed whitespace-pre-wrap">{fb.body}</p>
                                                </div>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="bg-bauhaus-paper border-2 border-bauhaus-black px-5 py-4 text-center">
                                            <p className="text-bauhaus-black/50 text-sm font-medium">
                                                請通知輔導員給予回饋，若已通知則耐心等候
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Submit new assignment */}
                <div className="bg-bauhaus-black text-white border-2 lg:border-4 border-bauhaus-black p-10 shadow-hard-lg relative overflow-hidden">
                    <h3 className="text-2xl font-black mb-2 flex items-center gap-3">
                        <FileText className="w-7 h-7 text-bauhaus-yellow" />
                        {myAssignments.length > 0 ? '再次繳交作業' : '章節作業繳交'}
                    </h3>
                    <p className="text-white/70 mb-8 font-medium">請根據本章節內容，撰寫您的學習心得或繳交指定作業。</p>
                    <div className="space-y-6 relative z-10">
                        {/* Type selector */}
                        <div className="flex gap-3">
                            <button
                                onClick={() => setAssignment({ ...assignment, type: 'text' })}
                                className={`px-5 py-2.5 border-2 border-white text-sm font-bold uppercase tracking-wide transition-colors duration-200 min-h-[44px] ${
                                    assignment.type === 'text'
                                        ? 'bg-bauhaus-yellow text-bauhaus-black'
                                        : 'bg-transparent text-white/70 hover:bg-white/10'
                                }`}
                            >
                                文字心得
                            </button>
                            <button
                                onClick={() => setAssignment({ ...assignment, type: 'youtube' })}
                                className={`px-5 py-2.5 border-2 border-white text-sm font-bold uppercase tracking-wide transition-colors duration-200 flex items-center gap-2 min-h-[44px] ${
                                    assignment.type === 'youtube'
                                        ? 'bg-bauhaus-yellow text-bauhaus-black'
                                        : 'bg-transparent text-white/70 hover:bg-white/10'
                                }`}
                            >
                                <Play className="w-4 h-4" /> YouTube 連結
                            </button>
                        </div>

                        {assignment.type === 'text' ? (
                            <textarea
                                rows="6"
                                value={assignment.content}
                                onChange={(e) => setAssignment({ ...assignment, content: e.target.value })}
                                className="w-full px-6 py-5 bg-white/10 border-2 border-white focus:ring-2 focus:ring-bauhaus-yellow outline-none resize-none text-white placeholder:text-white/40 font-medium transition-colors duration-200"
                                placeholder="在此輸入您的心得或作業內容..."
                            />
                        ) : (
                            <div className="space-y-4">
                                <input
                                    type="url"
                                    value={assignment.video_url}
                                    onChange={(e) => setAssignment({ ...assignment, video_url: e.target.value })}
                                    className="w-full px-6 py-4 bg-white/10 border-2 border-white focus:ring-2 focus:ring-bauhaus-yellow outline-none text-white placeholder:text-white/40 font-medium transition-colors duration-200"
                                    placeholder="貼上 YouTube 影片連結，例如 https://youtu.be/..."
                                />
                                {assignment.video_url && toEmbedUrl(assignment.video_url) !== assignment.video_url && (
                                    <div className="aspect-video overflow-hidden bg-black border-2 border-white">
                                        <iframe src={toEmbedUrl(assignment.video_url)} title="預覽" className="w-full h-full" allowFullScreen />
                                    </div>
                                )}
                            </div>
                        )}

                        <button
                            onClick={submitAssignment}
                            disabled={isSubmitting || (assignment.type === 'text' ? !assignment.content : !assignment.video_url)}
                            className="w-full py-4 bg-bauhaus-yellow text-bauhaus-black font-black uppercase tracking-wide border-2 border-white shadow-hard-white hover:bg-bauhaus-yellow/90 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:translate-x-[2px] active:translate-y-[2px] active:shadow-none min-h-[44px]"
                        >
                            {isSubmitting ? '繳交中...' : '確認繳交作業'}
                        </button>
                    </div>
                </div>
            </div>
            )}

            {/* Comment / Discussion section */}
            <div className="mt-16 pt-12 border-t-2 lg:border-t-4 border-bauhaus-black">
                <h3 className="text-xl font-black text-bauhaus-black flex items-center gap-2 mb-6">
                    <MessageSquare className="w-5 h-5 text-bauhaus-blue" /> 留言討論區
                </h3>

                {comments.length === 0 ? (
                    <div className="text-center py-12 bg-white border-2 border-bauhaus-black">
                        <MessageSquare className="w-10 h-10 text-bauhaus-black/20 mx-auto mb-3" />
                        <p className="text-bauhaus-black/50 font-medium">目前還沒有留言，成為第一個留言的人吧！</p>
                    </div>
                ) : (
                    <div className="space-y-4 mb-8">
                        {comments.map((c) => {
                            const likeCount = commentLikes[c.id] || 0;
                            const liked = myLikes.has(c.id);
                            return (
                                <div key={c.id} className="bh-card px-5 py-4">
                                    <div className="flex items-center justify-between mb-2">
                                        <span className="text-sm font-bold text-bauhaus-black">
                                            {displayName(c)}
                                        </span>
                                        <div className="flex items-center gap-3">
                                            <span className="text-[11px] text-bauhaus-black/40 font-medium">{formatTime(c.created_at)}</span>
                                            {isAdmin && (
                                                <button
                                                    onClick={() => deleteComment(c.id)}
                                                    className="text-bauhaus-black/30 hover:text-bauhaus-red transition-colors duration-200"
                                                    title="刪除留言"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <p className="text-bauhaus-black/70 text-sm leading-relaxed whitespace-pre-wrap">{c.body}</p>
                                    <div className="flex items-center mt-3 pt-2 border-t-2 border-bauhaus-black/10">
                                        <button
                                            onClick={() => toggleLike(c.id)}
                                            disabled={!currentUser}
                                            className={`flex items-center gap-1.5 text-xs font-medium transition-colors duration-200 px-2.5 py-1.5 border-2 ${
                                                liked
                                                    ? 'text-white bg-bauhaus-blue border-bauhaus-blue'
                                                    : 'text-bauhaus-black/50 border-transparent hover:text-bauhaus-blue hover:border-bauhaus-black/20'
                                            } disabled:opacity-40 disabled:cursor-not-allowed`}
                                        >
                                            <ThumbsUp className={`w-3.5 h-3.5 ${liked ? 'fill-white' : ''}`} />
                                            {likeCount > 0 && <span>{likeCount}</span>}
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {currentUser && (
                    <div className="mt-6 bh-card p-5">
                        <textarea
                            rows="3"
                            value={newComment}
                            onChange={(e) => setNewComment(e.target.value)}
                            className="w-full px-4 py-3 bg-bauhaus-paper border-2 border-bauhaus-black focus:ring-2 focus:ring-bauhaus-blue outline-none resize-none text-bauhaus-black placeholder:text-bauhaus-black/40 text-sm font-medium transition-colors duration-200"
                            placeholder="輸入您的留言..."
                        />
                        <div className="flex justify-end mt-3">
                            <button
                                onClick={submitComment}
                                disabled={commentSubmitting || !newComment.trim()}
                                className="flex items-center gap-2 px-5 py-2.5 bg-bauhaus-blue text-white border-2 border-bauhaus-black text-sm font-bold uppercase tracking-wide shadow-hard hover:bg-bauhaus-blue/90 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed active:translate-x-[2px] active:translate-y-[2px] active:shadow-none min-h-[44px]"
                            >
                                <Send className="w-4 h-4" />
                                {commentSubmitting ? '送出中...' : '送出留言'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <style dangerouslySetInnerHTML={{ __html: `
                .lesson-content img {
                    max-width: 100%;
                    border-radius: 12px;
                    display: inline-block;
                    vertical-align: top;
                }
                .lesson-content iframe {
                    max-width: 100%;
                    border-radius: 12px;
                    margin: 8px 0;
                }
                .lesson-content::after {
                    content: '';
                    display: block;
                    clear: both;
                }
            `}} />

            {/* Prev / Next navigation */}
            <div className="flex items-center justify-between mt-12 gap-4">
                {prevLesson ? (
                    <Link
                        to={`/courses/${courseId}/lessons/${prevLesson.id}`}
                        className="flex items-center gap-2 px-5 py-3 bg-white border-2 border-bauhaus-black text-sm font-bold text-bauhaus-black hover:bg-bauhaus-muted shadow-hard transition-all duration-200 min-h-[44px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        上一章節
                    </Link>
                ) : <div />}
                <Link
                    to={`/courses/${courseId}`}
                    className="text-xs font-black text-bauhaus-black/50 hover:text-bauhaus-blue transition-colors duration-200 uppercase tracking-widest"
                >
                    返回章節清單
                </Link>
                {nextLesson ? (
                    <Link
                        to={`/courses/${courseId}/lessons/${nextLesson.id}`}
                        className="flex items-center gap-2 px-5 py-3 bg-bauhaus-blue text-white border-2 border-bauhaus-black text-sm font-bold hover:bg-bauhaus-blue/90 shadow-hard transition-all duration-200 min-h-[44px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none"
                    >
                        下一章節
                        <ChevronRight className="w-4 h-4" />
                    </Link>
                ) : <div />}
            </div>
        </div>
    );
};

const ViewerShapeSVG = ({ shapeType, fill, stroke, strokeWidth, borderRadius }) => {
    const sw = strokeWidth ?? 2;
    const pad = sw / 2;
    const iw = 100 - sw;
    const ih = 100 - sw;
    return (
        <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="none">
            {shapeType === 'rect' && <rect x={pad} y={pad} width={iw} height={ih} fill={fill} stroke={stroke} strokeWidth={sw} />}
            {shapeType === 'rounded_rect' && <rect x={pad} y={pad} width={iw} height={ih} rx={borderRadius || 12} ry={borderRadius || 12} fill={fill} stroke={stroke} strokeWidth={sw} />}
            {shapeType === 'circle' && <ellipse cx="50" cy="50" rx={50 - pad} ry={50 - pad} fill={fill} stroke={stroke} strokeWidth={sw} />}
            {shapeType === 'triangle' && <polygon points={`50,${pad} ${100 - pad},${100 - pad} ${pad},${100 - pad}`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
            {shapeType === 'diamond' && <polygon points={`50,${pad} ${100 - pad},50 50,${100 - pad} ${pad},50`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
            {shapeType === 'star' && <polygon points="50,2 61,35 97,35 68,57 79,91 50,70 21,91 32,57 3,35 39,35" fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
            {shapeType === 'hexagon' && <polygon points={`50,${pad} ${100 - pad},25 ${100 - pad},75 50,${100 - pad} ${pad},75 ${pad},25`} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinejoin="round" />}
            {shapeType === 'line' && <line x1={pad} y1="50" x2={100 - pad} y2="50" stroke={stroke} strokeWidth={Math.max(sw, 3)} strokeLinecap="round" />}
            {shapeType === 'arrow' && (<><line x1={pad} y1="50" x2={80} y2="50" stroke={stroke} strokeWidth={Math.max(sw, 3)} strokeLinecap="round" /><polygon points={`${100 - pad},50 72,30 72,70`} fill={stroke} stroke={stroke} strokeWidth={1} /></>)}
        </svg>
    );
};

const CanvasViewer = ({ contents }) => {
    const containerRef = useRef(null);
    const [fitScale, setFitScale] = useState(1);
    const [zoomed, setZoomed] = useState(false);

    const updateScale = useCallback(() => {
        if (!containerRef.current) return;
        const availableWidth = containerRef.current.clientWidth || CANVAS_WIDTH;
        setFitScale(Math.min(1, availableWidth / CANVAS_WIDTH));
    }, []);

    useEffect(() => {
        updateScale();
        window.addEventListener('resize', updateScale);
        return () => window.removeEventListener('resize', updateScale);
    }, [updateScale]);

    let canvasHeight = 600;
    for (const c of contents) {
        if (c.position_data) {
            const bottom = (c.position_data.y || 0) + (c.position_data.height || 100) + 20;
            if (bottom > canvasHeight) canvasHeight = bottom;
        }
    }

    // 手機窄螢幕「適合寬度」會把畫布縮太小（scale<0.6 時文字幾乎不可讀）。
    // 提供只在手機出現的「放大檢視」切換：固定 0.85 倍 + 可捲動容器瀏覽。
    // 桌面（scale >= 0.6）canZoom 恆為 false，行為與外觀完全不變。
    const ZOOM_SCALE = 0.85;
    const canZoom = fitScale < 0.6;
    const scale = canZoom && zoomed ? ZOOM_SCALE : fitScale;

    const canvasBox = (
            <div
                className="relative bg-white rounded-2xl shadow-lg"
                style={{
                    width: CANVAS_WIDTH,
                    height: canvasHeight,
                    transform: `scale(${scale})`,
                    transformOrigin: 'top left',
                }}
            >
                {contents.map((item) => {
                    if (!item.position_data) return null;
                    const pd = item.position_data;
                    const { x, y, width, height } = pd;
                    const isShape = pd.shapeType != null;
                    const displayType = isShape ? 'shape' : (item.type === 'article' ? 'text_box' : item.type === 'image_text' ? 'image' : item.type);
                    const opacity = pd.opacity ?? 1;
                    const linkUrl = pd.linkUrl || '';
                    const isButton = pd.shapeType === 'button';

                    const wrapLink = (children) => linkUrl ? (
                        <a href={linkUrl} target="_blank" rel="noopener noreferrer" className="block w-full h-full">{children}</a>
                    ) : children;

                    return (
                        <div key={item.id} className="absolute"
                            style={{ left: x, top: y, width, height, opacity }}>
                            {displayType === 'text_box' && (
                                <div className="w-full h-full overflow-auto canvas-text-view"
                                    style={{ fontSize: 16, lineHeight: 1.6, wordBreak: 'break-word', padding: 12 }}
                                    dangerouslySetInnerHTML={{ __html: item.body }} />
                            )}
                            {displayType === 'image' && (() => {
                                const imgUrl = item.video_url
                                    ? supabase.storage.from('content-images').getPublicUrl(item.video_url).data?.publicUrl
                                    : null;
                                return imgUrl ? <img src={imgUrl} alt={item.title || ''} className="w-full h-full object-contain rounded-lg" /> : null;
                            })()}
                            {displayType === 'video' && item.video_url && (
                                <iframe src={toEmbedUrl(item.video_url)} title={item.title} className="w-full h-full rounded-lg" allowFullScreen />
                            )}
                            {displayType === 'shape' && isButton && wrapLink(
                                <div className="w-full h-full flex items-center justify-center rounded-lg"
                                    style={{
                                        background: pd.fillColor || '#3b82f6',
                                        border: `${pd.borderWidth ?? 0}px solid ${pd.borderColor || '#1e40af'}`,
                                        borderRadius: pd.borderRadius || 8,
                                        cursor: linkUrl ? 'pointer' : 'default',
                                    }}>
                                    <span className="font-bold text-center px-2"
                                        style={{ color: pd.textColor || '#ffffff', fontSize: 16 }}>
                                        {item.body || '按鈕'}
                                    </span>
                                </div>
                            )}
                            {displayType === 'shape' && !isButton && wrapLink(
                                <ViewerShapeSVG shapeType={pd.shapeType}
                                    fill={pd.fillColor || 'transparent'} stroke={pd.borderColor || '#000'}
                                    strokeWidth={pd.borderWidth ?? 2} borderRadius={pd.borderRadius ?? 0} />
                            )}
                        </div>
                    );
                })}
            </div>
    );

    return (
        <div ref={containerRef} className="w-full overflow-hidden">
            {canZoom && (
                <div className="md:hidden mb-2">
                    <div className="flex items-center justify-end">
                        <button
                            type="button"
                            onClick={() => setZoomed((z) => !z)}
                            className="min-h-[44px] inline-flex items-center gap-1.5 px-4 border-2 border-bauhaus-black bg-white text-bauhaus-black text-xs font-bold uppercase tracking-wide active:bg-bauhaus-muted transition-colors duration-200"
                        >
                            {zoomed ? (
                                <>
                                    <ZoomOut className="w-3.5 h-3.5" /> 適合寬度
                                </>
                            ) : (
                                <>
                                    <ZoomIn className="w-3.5 h-3.5" /> 放大檢視
                                </>
                            )}
                        </button>
                    </div>
                    {zoomed && (
                        <p className="text-[10px] text-bauhaus-black/40 text-right mt-1">可上下左右滑動查看完整內容</p>
                    )}
                </div>
            )}
            {canZoom && zoomed ? (
                <div className="overflow-auto max-h-[70dvh] rounded-2xl border border-slate-200/80 bg-slate-50/60">
                    <div style={{ width: CANVAS_WIDTH * scale, height: canvasHeight * scale }}>
                        {canvasBox}
                    </div>
                </div>
            ) : (
                <div style={{
                    width: CANVAS_WIDTH * scale,
                    height: canvasHeight * scale,
                    margin: '0 auto',
                }}>
                    {canvasBox}
                </div>
            )}
            <style dangerouslySetInnerHTML={{ __html: `
                .canvas-text-view h1 { font-size: 2em; font-weight: 800; margin: 0.3em 0; }
                .canvas-text-view h2 { font-size: 1.5em; font-weight: 700; margin: 0.3em 0; }
                .canvas-text-view h3 { font-size: 1.25em; font-weight: 700; margin: 0.2em 0; }
                .canvas-text-view p { margin: 0.3em 0; }

                .canvas-text-view ul,
                .canvas-text-view ol { padding-left: 1.5em !important; margin: 0.3em 0; }
                .canvas-text-view li { margin: 0.15em 0; }

                .canvas-text-view ol                { list-style-type: decimal !important; }
                .canvas-text-view ol ol             { list-style-type: lower-alpha !important; }
                .canvas-text-view ol ol ol          { list-style-type: lower-roman !important; }
                .canvas-text-view ol ol ol ol       { list-style-type: disc !important; }
                .canvas-text-view ol ol ol ol ol    { list-style-type: circle !important; }

                .canvas-text-view ul                { list-style-type: disc !important; }
                .canvas-text-view ul ul             { list-style-type: circle !important; }
                .canvas-text-view ul ul ul          { list-style-type: square !important; }
                .canvas-text-view ul ul ul ul       { list-style-type: '– ' !important; }
                .canvas-text-view ul ul ul ul ul    { list-style-type: disc !important; }

                .canvas-text-view img { max-width: 100%; border-radius: 8px; }
                .canvas-text-view a { color: #2563eb; text-decoration: underline; text-underline-offset: 2px; }
                .canvas-text-view a:hover { color: #1d4ed8; }
            `}} />
        </div>
    );
};

const ImageTextContent = ({ item }) => {
    let caption = '', captionLink = '';
    try {
        const parsed = JSON.parse(item.body || '{}');
        caption = parsed.caption || '';
        captionLink = parsed.captionLink || '';
    } catch { /* body is not JSON, ignore */ }

    const imgUrl = item.video_url
        ? supabase.storage.from('content-images').getPublicUrl(item.video_url).data?.publicUrl
        : null;

    return (
        <div className="flex flex-col items-center">
            {imgUrl && (
                <img
                    src={imgUrl}
                    alt={caption || item.title}
                    className="max-w-full border-2 border-bauhaus-black"
                />
            )}
            {caption && (
                <div className="mt-4 text-center">
                    {captionLink ? (
                        <a
                            href={captionLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-bauhaus-blue hover:text-bauhaus-black font-medium underline underline-offset-2 transition-colors duration-200"
                        >
                            {caption}
                        </a>
                    ) : (
                        <p className="text-bauhaus-black font-medium">{caption}</p>
                    )}
                </div>
            )}
            {!imgUrl && !caption && (
                <p className="text-bauhaus-black/40 text-sm">此區塊尚無內容</p>
            )}
        </div>
    );
};

export default LessonDetail;
