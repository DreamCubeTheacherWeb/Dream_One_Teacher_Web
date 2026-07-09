import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { Save, ChevronLeft, Plus, Trash2, FileText, Video, Edit3, ClipboardCheck, Hash } from 'lucide-react';
import EditorComponent from '../../components/EditorComponent';

// 章節 hashtag 編輯列：chips + 輸入框（Enter 或按鈕加入；點 × 移除）
const LessonTagEditor = ({ lesson, onSave }) => {
    const [draft, setDraft] = useState('');
    const tags = lesson.tags || [];

    const addTag = () => {
        const t = draft.trim().replace(/^#+/, '').trim();
        if (!t) return;
        if (!tags.includes(t)) onSave([...tags, t]);
        setDraft('');
    };

    return (
        <div className="mt-3 pt-3 border-t-2 border-bauhaus-black/10 pl-10 flex items-center gap-2 flex-wrap">
            <Hash className="w-3.5 h-3.5 text-bauhaus-black/40 shrink-0" />
            {tags.map(t => (
                <span key={t} className="inline-flex items-center gap-1 text-xs font-black text-bauhaus-black bg-bauhaus-yellow px-2 py-0.5 border-2 border-bauhaus-black">
                    #{t}
                    <button
                        onClick={() => onSave(tags.filter(x => x !== t))}
                        className="hover:text-bauhaus-red font-black leading-none px-0.5 min-h-[24px]"
                        title={`移除 #${t}`}
                    >×</button>
                </span>
            ))}
            <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
                placeholder="新增 hashtag，按 Enter"
                className="text-xs px-2 py-1 bg-white border-2 border-bauhaus-black/30 focus:border-bauhaus-black outline-none text-bauhaus-black font-bold w-40 min-h-[32px]"
            />
            {draft.trim() && (
                <button onClick={addTag} className="text-xs font-black text-bauhaus-blue hover:text-bauhaus-black min-h-[32px] px-1">加入</button>
            )}
        </div>
    );
};

const CMSManager = () => {
    const { courseId } = useParams();
    const navigate = useNavigate();
    const [course, setCourse] = useState({ title: '', description: '', is_published: false });
    const [lessons, setLessons] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingLessonId, setEditingLessonId] = useState(null);

    useEffect(() => {
        const fetchCourseData = async () => {
            if (courseId === 'new') {
                setLoading(false);
                return;
            }

            const { data: courseData } = await supabase
                .from('courses')
                .select('*')
                .eq('id', courseId)
                .single();

            if (courseData) {
                setCourse(courseData);
                const { data: lessonsData } = await supabase
                    .from('lessons')
                    .select('*')
                    .eq('course_id', courseId)
                    .order('order', { ascending: true });
                setLessons(lessonsData || []);
            }
            setLoading(false);
        };

        fetchCourseData();
    }, [courseId]);

    const saveCourse = async () => {
        try {
            if (courseId === 'new') {
                const { data, error } = await supabase
                    .from('courses')
                    .insert([course])
                    .select()
                    .single();

                if (error) throw error;

                alert('課程建立成功！');
                navigate(`/admin/cms/${data.id}`);
            } else {
                const { error } = await supabase
                    .from('courses')
                    .update(course)
                    .eq('id', courseId);

                if (error) throw error;
                alert('課程更新成功');
            }
        } catch (error) {
            console.error('Error saving course:', error.message);
            alert('儲存失敗：' + error.message);
        }
    };

    const addLesson = async () => {
        if (courseId === 'new') {
            alert('請先儲存課程基本資訊再新增章節');
            return;
        }
        const newOrder = lessons.length > 0 ? Math.max(...lessons.map(l => l.order)) + 1 : 0;

        const { error } = await supabase
            .from('lessons')
            .insert({ course_id: courseId, title: '新章節', order: newOrder });

        if (error) {
            alert('新增章節失敗：' + error.message);
            return;
        }

        const { data: refreshed } = await supabase
            .from('lessons')
            .select('*')
            .eq('course_id', courseId)
            .order('order', { ascending: true });

        setLessons(refreshed || []);
    };

    const deleteLesson = async (lesson) => {
        if (!window.confirm(`確定要刪除章節「${lesson.title}」嗎？\n此操作將同時刪除該章節下的所有內容，無法復原。`)) return;

        const { error } = await supabase
            .from('lessons')
            .delete()
            .eq('id', lesson.id);

        if (error) {
            alert('刪除失敗：' + error.message);
            return;
        }
        setLessons(lessons.filter(l => l.id !== lesson.id));
    };

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    // Render Editor if a lesson is selected
    if (editingLessonId) {
        return <EditorComponent lessonId={editingLessonId} onBack={() => setEditingLessonId(null)} />;
    }


    return (
        <div className="p-4 sm:p-8 max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <button onClick={() => navigate('/admin')} className="flex items-center gap-1 font-bold text-bauhaus-black/60 hover:text-bauhaus-blue transition-colors min-h-[44px]">
                    <ChevronLeft className="w-4 h-4" /> 返回管理後台
                </button>
                <button onClick={saveCourse} className="bh-btn bh-btn-blue px-6 py-2 min-h-[44px]">
                    <Save className="w-4 h-4" /> 儲存變更
                </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Course Info */}
                <div className="lg:col-span-1 space-y-6">
                    <div className="bh-card p-6">
                        <h2 className="font-black text-bauhaus-black mb-4 flex items-center gap-2 uppercase tracking-wide text-sm">
                            <FileText className="w-5 h-5 text-bauhaus-black" /> 課程基本資訊
                        </h2>
                        <div className="space-y-4">
                            <div>
                                <label className="bh-label block mb-1">課程標題</label>
                                <input
                                    type="text"
                                    value={course.title}
                                    onChange={e => setCourse({ ...course, title: e.target.value })}
                                    className="bh-input"
                                />
                            </div>
                            <div>
                                <label className="bh-label block mb-1">描述</label>
                                <textarea
                                    rows="4"
                                    value={course.description}
                                    onChange={e => setCourse({ ...course, description: e.target.value })}
                                    className="bh-input resize-none"
                                />
                            </div>
                            <div>
                                <label className="bh-label block mb-1">可見對象</label>
                                <select
                                    value={course.visibility || 'all'}
                                    onChange={e => setCourse({ ...course, visibility: e.target.value })}
                                    className="bh-input"
                                >
                                    <option value="all">全部講師</option>
                                    <option value="intern">實習培訓專用</option>
                                    <option value="formal">正式培訓專用</option>
                                </select>
                            </div>
                            <div className="flex items-center gap-2 pt-2">
                                <input
                                    type="checkbox"
                                    id="pub"
                                    checked={course.is_published}
                                    onChange={e => setCourse({ ...course, is_published: e.target.checked })}
                                    className="w-5 h-5 border-2 border-bauhaus-black rounded-none text-bauhaus-blue"
                                />
                                <label htmlFor="pub" className="text-sm font-bold text-bauhaus-black">發佈此課程</label>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Lesson List */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="bh-card p-6">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="font-black text-bauhaus-black flex items-center gap-2 uppercase tracking-wide text-sm">
                                <Video className="w-5 h-5 text-bauhaus-black" /> 章節管理
                            </h2>
                            <button
                                onClick={addLesson}
                                className="bh-btn bh-btn-outline text-xs px-3 py-1.5 min-h-[44px]"
                            >
                                <Plus className="w-3.5 h-3.5" /> 新增章節
                            </button>
                        </div>

                        <div className="space-y-3">
                            {lessons.map((lesson, idx) => (
                                <div key={lesson.id} className="bg-bauhaus-paper p-4 border-2 border-bauhaus-black/20 rounded-xl group hover:border-bauhaus-black transition-all">
                                    <div className="flex items-center gap-4">
                                        <div className="text-sm font-black text-bauhaus-black/30 w-6 flex-shrink-0">{(idx + 1).toString().padStart(2, '0')}</div>
                                        <input
                                            type="text"
                                            value={lesson.title}
                                            onChange={async (e) => {
                                                const newTitle = e.target.value;
                                                setLessons(lessons.map(l => l.id === lesson.id ? { ...l, title: newTitle } : l));
                                            }}
                                            onBlur={async () => {
                                                await supabase.from('lessons').update({ title: lesson.title }).eq('id', lesson.id);
                                            }}
                                            className="flex-1 bg-transparent font-bold text-bauhaus-black outline-none focus:text-bauhaus-blue"
                                            placeholder="輸入章節標題..."
                                        />
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => setEditingLessonId(lesson.id)}
                                                className="bh-btn bh-btn-outline text-xs px-3 py-1.5"
                                            >
                                                <Edit3 className="w-3 h-3" /> 編輯內容
                                            </button>
                                            <button
                                                onClick={() => deleteLesson(lesson)}
                                                className="p-2 text-bauhaus-black/40 hover:text-bauhaus-red hover:bg-bauhaus-red/10 transition-colors"
                                                title="刪除章節"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                    {/* Assignment settings */}
                                    <div className="mt-3 pt-3 border-t-2 border-bauhaus-black/10 flex items-center gap-4 pl-10">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!lesson.requires_assignment}
                                                onChange={async (e) => {
                                                    const val = e.target.checked;
                                                    setLessons(lessons.map(l => l.id === lesson.id ? { ...l, requires_assignment: val } : l));
                                                    await supabase.from('lessons').update({ requires_assignment: val }).eq('id', lesson.id);
                                                }}
                                                className="w-5 h-5 border-2 border-bauhaus-black rounded-none text-bauhaus-blue"
                                            />
                                            <span className="text-xs font-bold text-bauhaus-black/60 flex items-center gap-1">
                                                <ClipboardCheck className="w-3 h-3" /> 需繳交作業
                                            </span>
                                        </label>
                                        {lesson.requires_assignment && (
                                            <select
                                                value={lesson.assignment_for || 'all'}
                                                onChange={async (e) => {
                                                    const val = e.target.value;
                                                    setLessons(lessons.map(l => l.id === lesson.id ? { ...l, assignment_for: val } : l));
                                                    await supabase.from('lessons').update({ assignment_for: val }).eq('id', lesson.id);
                                                }}
                                                className="text-xs px-2 py-1 bg-white border-2 border-bauhaus-black rounded-xl outline-none text-bauhaus-black font-bold"
                                            >
                                                <option value="all">全部講師需繳</option>
                                                <option value="intern">僅實習講師</option>
                                                <option value="formal">僅正式講師</option>
                                            </select>
                                        )}
                                    </div>
                                    {/* Hashtag 標籤（前台章節卡片顯示 #標籤） */}
                                    <LessonTagEditor
                                        lesson={lesson}
                                        onSave={async (tags) => {
                                            setLessons(prev => prev.map(l => l.id === lesson.id ? { ...l, tags } : l));
                                            const { error } = await supabase.from('lessons').update({ tags }).eq('id', lesson.id);
                                            if (error) alert('hashtag 儲存失敗：' + error.message +
                                                (String(error.message).includes('tags') ? '\n（tags 欄位可能還沒建立，請先到 Supabase 執行 2026-07-09_lesson_tags.sql）' : ''));
                                        }}
                                    />
                                </div>
                            ))}
                            {lessons.length === 0 && (
                                <div className="py-12 text-center text-bauhaus-black/40 font-bold border-2 border-dashed border-bauhaus-black/20 rounded-xl">
                                    尚未有任何章節，點擊右上方按鈕新增。
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default CMSManager;
