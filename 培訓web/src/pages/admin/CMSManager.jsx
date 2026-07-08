import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabaseClient';
import { Save, ChevronLeft, Plus, Trash2, FileText, Video, Edit3, ClipboardCheck } from 'lucide-react';
import EditorComponent from '../../components/EditorComponent';

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

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    // Render Editor if a lesson is selected
    if (editingLessonId) {
        return <EditorComponent lessonId={editingLessonId} onBack={() => setEditingLessonId(null)} />;
    }


    return (
        <div className="p-8 max-w-5xl mx-auto">
            <div className="flex items-center justify-between mb-8">
                <button onClick={() => navigate('/admin')} className="flex items-center gap-1 text-slate-500 hover:text-blue-600 transition-colors min-h-[44px]">
                    <ChevronLeft className="w-4 h-4" /> 返回管理後台
                </button>
                <button onClick={saveCourse} className="bg-blue-600 text-white px-6 py-2 rounded-xl font-bold flex items-center gap-2 hover:bg-blue-700 shadow-lg shadow-blue-500/20 min-h-[44px]">
                    <Save className="w-4 h-4" /> 儲存變更
                </button>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* Course Info */}
                <div className="lg:col-span-1 space-y-6">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                        <h2 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
                            <FileText className="w-5 h-5 text-blue-600" /> 課程基本資訊
                        </h2>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">課程標題</label>
                                <input
                                    type="text"
                                    value={course.title}
                                    onChange={e => setCourse({ ...course, title: e.target.value })}
                                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">描述</label>
                                <textarea
                                    rows="4"
                                    value={course.description}
                                    onChange={e => setCourse({ ...course, description: e.target.value })}
                                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none"
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">可見對象</label>
                                <select
                                    value={course.visibility || 'all'}
                                    onChange={e => setCourse({ ...course, visibility: e.target.value })}
                                    className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
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
                                    className="w-5 h-5 rounded text-blue-600"
                                />
                                <label htmlFor="pub" className="text-sm font-semibold text-slate-700">發佈此課程</label>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Lesson List */}
                <div className="lg:col-span-2 space-y-6">
                    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="font-bold text-slate-900 flex items-center gap-2">
                                <Video className="w-5 h-5 text-indigo-600" /> 章節管理
                            </h2>
                            <button
                                onClick={addLesson}
                                className="text-xs font-bold text-blue-600 hover:bg-blue-50 px-3 py-1.5 rounded-lg border border-blue-100 transition-colors min-h-[44px]"
                            >
                                + 新增章節
                            </button>
                        </div>

                        <div className="space-y-3">
                            {lessons.map((lesson, idx) => (
                                <div key={lesson.id} className="bg-slate-50 p-4 rounded-xl border border-slate-100 group hover:border-blue-200 transition-all">
                                    <div className="flex items-center gap-4">
                                        <div className="text-sm font-black text-slate-300 w-6 flex-shrink-0">{(idx + 1).toString().padStart(2, '0')}</div>
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
                                            className="flex-1 bg-transparent font-bold text-slate-700 outline-none focus:text-blue-600"
                                            placeholder="輸入章節標題..."
                                        />
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => setEditingLessonId(lesson.id)}
                                                className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 text-xs font-bold rounded-lg hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-all flex items-center gap-1"
                                            >
                                                <Edit3 className="w-3 h-3" /> 編輯內容
                                            </button>
                                            <button
                                                onClick={() => deleteLesson(lesson)}
                                                className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                                                title="刪除章節"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                    {/* Assignment settings */}
                                    <div className="mt-3 pt-3 border-t border-slate-200/60 flex items-center gap-4 pl-10">
                                        <label className="flex items-center gap-2 cursor-pointer">
                                            <input
                                                type="checkbox"
                                                checked={!!lesson.requires_assignment}
                                                onChange={async (e) => {
                                                    const val = e.target.checked;
                                                    setLessons(lessons.map(l => l.id === lesson.id ? { ...l, requires_assignment: val } : l));
                                                    await supabase.from('lessons').update({ requires_assignment: val }).eq('id', lesson.id);
                                                }}
                                                className="w-5 h-5 rounded text-blue-600"
                                            />
                                            <span className="text-xs font-semibold text-slate-500 flex items-center gap-1">
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
                                                className="text-xs px-2 py-1 bg-white border border-slate-200 rounded-md focus:ring-1 focus:ring-blue-400 outline-none text-slate-600"
                                            >
                                                <option value="all">全部講師需繳</option>
                                                <option value="intern">僅實習講師</option>
                                                <option value="formal">僅正式講師</option>
                                            </select>
                                        )}
                                    </div>
                                </div>
                            ))}
                            {lessons.length === 0 && (
                                <div className="py-12 text-center text-slate-400 border-2 border-dashed border-slate-100 rounded-2xl">
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
