import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { ChevronLeft, ChevronRight, CheckCircle, Circle, FileText, Play } from 'lucide-react';

// Strip HTML tags and return plain text preview
const stripHtml = (html) => {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
};

const LessonView = () => {
    const { courseId } = useParams();
    const [course, setCourse] = useState(null);
    const [lessons, setLessons] = useState([]);
    const [contentPreviews, setContentPreviews] = useState({}); // lessonId → preview text
    const [contentCounts, setContentCounts] = useState({});     // lessonId → { video, text }
    const [progress, setProgress] = useState({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            // Fetch course info
            const { data: courseData } = await supabase
                .from('courses')
                .select('*')
                .eq('id', courseId)
                .single();
            setCourse(courseData);

            // Fetch lessons
            const { data: lessonsData } = await supabase
                .from('lessons')
                .select('*')
                .eq('course_id', courseId)
                .order('order', { ascending: true });

            if (!lessonsData || lessonsData.length === 0) {
                setLessons([]);
                setLoading(false);
                return;
            }
            setLessons(lessonsData);

            // Fetch all contents for these lessons in one query
            const lessonIds = lessonsData.map(l => l.id);
            const { data: contentsData } = await supabase
                .from('contents')
                .select('lesson_id, type, title, body')
                .in('lesson_id', lessonIds)
                .order('order', { ascending: true });

            // Build preview map: first text content preview per lesson
            const previews = {};
            const counts = {};
            contentsData?.forEach(c => {
                if (!counts[c.lesson_id]) counts[c.lesson_id] = { video: 0, text: 0 };
                if (c.type === 'video') counts[c.lesson_id].video++;
                else counts[c.lesson_id].text++;

                // Use first text content as preview
                if (!previews[c.lesson_id] && c.type !== 'video') {
                    const plain = stripHtml(c.body);
                    previews[c.lesson_id] = plain.length > 100 ? plain.slice(0, 100) + '...' : plain;
                }
                // Fallback: if only video, show title
                if (!previews[c.lesson_id] && c.type === 'video') {
                    previews[c.lesson_id] = `影片：${c.title}`;
                }
            });
            setContentPreviews(previews);
            setContentCounts(counts);

            // Fetch progress
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                const { data: progressData } = await supabase
                    .from('progress')
                    .select('lesson_id, completed')
                    .eq('user_id', user.id)
                    .in('lesson_id', lessonIds);
                const progMap = {};
                progressData?.forEach(p => { progMap[p.lesson_id] = p.completed; });
                setProgress(progMap);
            }

            setLoading(false);
        };

        fetchData();
    }, [courseId]);

    if (loading) return (
        <div className="p-12 text-center text-slate-500 text-lg font-bold">課程內容載入中...</div>
    );
    if (!course) return (
        <div className="p-12 text-center text-red-500">找不到該課程。</div>
    );

    const completedCount = lessons.filter(l => progress[l.id]).length;

    return (
        <div className="max-w-3xl mx-auto px-6 py-10">
            {/* Back link */}
            <Link
                to="/courses"
                className="inline-flex items-center gap-1.5 text-xs font-black text-blue-600 uppercase tracking-widest hover:text-blue-700 mb-6 transition-colors min-h-[44px]"
            >
                <ChevronLeft className="w-3.5 h-3.5" /> 返回課程列表
            </Link>

            {/* Course header */}
            <div className="mb-2">
                <h1 className="text-3xl font-black text-slate-900 tracking-tight">{course.title}</h1>
            </div>
            {course.description && (
                <p className="text-slate-500 mb-6">{course.description}</p>
            )}

            {/* Progress bar */}
            {lessons.length > 0 && (
                <div className="mb-8 bg-white rounded-2xl border border-slate-100 p-4 flex items-center gap-4 shadow-sm">
                    <div className="flex-1">
                        <div className="flex justify-between text-xs font-bold text-slate-500 mb-1.5">
                            <span>學習進度</span>
                            <span>{completedCount} / {lessons.length} 章節</span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-blue-500 rounded-full transition-all duration-500"
                                style={{ width: `${lessons.length ? (completedCount / lessons.length) * 100 : 0}%` }}
                            />
                        </div>
                    </div>
                </div>
            )}

            {/* Lesson list */}
            <div className="space-y-3">
                {lessons.length > 0 ? (
                    lessons.map((lesson, idx) => {
                        const isCompleted = !!progress[lesson.id];
                        const preview = contentPreviews[lesson.id];
                        const count = contentCounts[lesson.id] || { video: 0, text: 0 };

                        return (
                            <Link
                                key={lesson.id}
                                to={`/courses/${courseId}/lessons/${lesson.id}`}
                                className="group flex items-start gap-4 bg-white rounded-2xl border border-slate-100 px-6 py-5 hover:border-blue-300 hover:shadow-md hover:shadow-blue-50 transition-all duration-200"
                            >
                                {/* Chapter number & completion icon */}
                                <div className="shrink-0 flex flex-col items-center gap-1 pt-0.5">
                                    {isCompleted ? (
                                        <CheckCircle className="w-6 h-6 text-green-500 fill-green-50" />
                                    ) : (
                                        <Circle className="w-6 h-6 text-slate-200 group-hover:text-blue-200 transition-colors" />
                                    )}
                                </div>

                                {/* Text content */}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-1">
                                        章節 {idx + 1}
                                    </div>
                                    <div className={`text-base font-bold mb-1.5 line-clamp-2 transition-colors ${isCompleted ? 'text-slate-400' : 'text-slate-800 group-hover:text-blue-600'}`}>
                                        {lesson.title}
                                    </div>
                                    {preview && (
                                        <p className="text-sm text-slate-400 leading-relaxed line-clamp-2">
                                            {preview}
                                        </p>
                                    )}
                                    {/* Content type badges */}
                                    {(count.video > 0 || count.text > 0) && (
                                        <div className="flex items-center gap-2 mt-2.5">
                                            {count.video > 0 && (
                                                <span className="inline-flex items-center gap-1 text-[10px] font-black text-blue-500 bg-blue-50 px-2 py-0.5 rounded-full">
                                                    <Play className="w-2.5 h-2.5" /> {count.video} 影片
                                                </span>
                                            )}
                                            {count.text > 0 && (
                                                <span className="inline-flex items-center gap-1 text-[10px] font-black text-orange-500 bg-orange-50 px-2 py-0.5 rounded-full">
                                                    <FileText className="w-2.5 h-2.5" /> {count.text} 文章
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Arrow */}
                                <ChevronRight className="w-5 h-5 text-slate-200 group-hover:text-blue-400 group-hover:translate-x-0.5 transition-all shrink-0 mt-1" />
                            </Link>
                        );
                    })
                ) : (
                    <div className="py-20 text-center bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
                        <p className="text-slate-400">此課程目前尚無章節。</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default LessonView;
