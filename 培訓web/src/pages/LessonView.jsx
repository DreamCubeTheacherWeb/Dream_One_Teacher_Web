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
                .select('lesson_id, type, title, body, position_data')
                .in('lesson_id', lessonIds)
                .order('order', { ascending: true });

            // Build preview map: 取第一段「有意義的內文」當預覽
            const previews = {};
            const counts = {};
            contentsData?.forEach(c => {
                if (!counts[c.lesson_id]) counts[c.lesson_id] = { video: 0, text: 0, canvas: false };
                const pd = c.position_data;
                if (pd) counts[c.lesson_id].canvas = true;
                if (c.type === 'video') counts[c.lesson_id].video++;
                else counts[c.lesson_id].text++;

                // 只看真正的內文：跳過影片、圖片（body 是 caption JSON）、圖形/按鈕、空區塊
                const isShape = pd?.shapeType != null;
                if (c.type !== 'video' && c.type !== 'image_text' && !isShape && c.body && c.body[0] !== '{') {
                    const plain = stripHtml(c.body);
                    // 預覽：第一段夠長的內文（跳過大標題、按鈕字樣等短字串）
                    if (!previews[c.lesson_id] && plain.length >= 20) {
                        previews[c.lesson_id] = plain.length > 100 ? plain.slice(0, 100) + '...' : plain;
                    }
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
        <div className="p-12 text-center text-bauhaus-black/50 text-lg font-bold">課程內容載入中...</div>
    );
    if (!course) return (
        <div className="p-12 text-center text-bauhaus-red font-bold">找不到該課程。</div>
    );

    const completedCount = lessons.filter(l => progress[l.id]).length;

    return (
        <div className="max-w-3xl mx-auto px-6 py-10">
            {/* Back link */}
            <Link
                to="/courses"
                className="inline-flex items-center gap-1.5 text-xs font-black text-bauhaus-blue uppercase tracking-widest hover:text-bauhaus-black mb-6 transition-colors duration-200 min-h-[44px]"
            >
                <ChevronLeft className="w-3.5 h-3.5" /> 返回課程列表
            </Link>

            {/* Course header */}
            <div className="mb-2">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">{course.title}</h1>
            </div>
            {course.description && (
                <p className="text-bauhaus-black/60 mb-6 font-medium">{course.description}</p>
            )}

            {/* Progress bar */}
            {lessons.length > 0 && (
                <div className="mb-8 bg-white border-2 border-bauhaus-black rounded-2xl p-4 flex items-center gap-4 shadow-hard">
                    <div className="flex-1">
                        <div className="flex justify-between text-xs font-bold text-bauhaus-black/60 mb-1.5">
                            <span>學習進度</span>
                            <span>{completedCount} / {lessons.length} 章節</span>
                        </div>
                        <div className="h-2 lg:h-3 rounded-full bg-bauhaus-muted border-2 border-bauhaus-black overflow-hidden">
                            <div
                                className="h-full bg-bauhaus-blue rounded-full transition-all duration-500"
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
                        const tags = lesson.tags || [];

                        return (
                            <Link
                                key={lesson.id}
                                to={`/courses/${courseId}/lessons/${lesson.id}`}
                                className="group flex items-start gap-4 bh-card bh-card-hover px-6 py-5"
                            >
                                {/* Chapter number & completion icon */}
                                <div className="shrink-0 flex flex-col items-center gap-1 pt-0.5">
                                    {isCompleted ? (
                                        <CheckCircle className="w-6 h-6 text-bauhaus-blue fill-bauhaus-blue/10" />
                                    ) : (
                                        <Circle className="w-6 h-6 text-bauhaus-black/20 group-hover:text-bauhaus-blue/40 transition-colors duration-200" />
                                    )}
                                </div>

                                {/* Text content */}
                                <div className="flex-1 min-w-0">
                                    <div className="text-[10px] font-black text-bauhaus-black/40 uppercase tracking-[0.2em] mb-1">
                                        章節 {idx + 1}
                                    </div>
                                    <div className={`text-base font-bold mb-1.5 line-clamp-2 transition-colors duration-200 ${isCompleted ? 'text-bauhaus-black/40' : 'text-bauhaus-black group-hover:text-bauhaus-blue'}`}>
                                        {lesson.title}
                                    </div>
                                    {preview && (
                                        <p className="text-sm text-bauhaus-black/50 leading-relaxed line-clamp-2">
                                            {preview}
                                        </p>
                                    )}
                                    {/* Hashtag 標籤（後台自訂）＋影片數；傳統文章式課程仍顯示文章數 */}
                                    {(count.video > 0 || tags.length > 0 || (!count.canvas && count.text > 0)) && (
                                        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                                            {tags.map(t => (
                                                <span key={t} className="inline-flex items-center gap-0.5 text-[10px] font-black text-bauhaus-black bg-bauhaus-yellow px-2 py-0.5 border-2 border-bauhaus-black rounded-lg">
                                                    #{t}
                                                </span>
                                            ))}
                                            {count.video > 0 && (
                                                <span className="inline-flex items-center gap-1 text-[10px] font-black text-white bg-bauhaus-blue px-2 py-0.5 border-2 border-bauhaus-black rounded-lg">
                                                    <Play className="w-2.5 h-2.5" /> {count.video} 影片
                                                </span>
                                            )}
                                            {!count.canvas && count.text > 0 && (
                                                <span className="inline-flex items-center gap-1 text-[10px] font-black text-bauhaus-black bg-bauhaus-yellow px-2 py-0.5 border-2 border-bauhaus-black rounded-lg">
                                                    <FileText className="w-2.5 h-2.5" /> {count.text} 文章
                                                </span>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Arrow */}
                                <ChevronRight className="w-5 h-5 text-bauhaus-black/20 group-hover:text-bauhaus-blue group-hover:translate-x-0.5 transition-all duration-200 shrink-0 mt-1" />
                            </Link>
                        );
                    })
                ) : (
                    <div className="py-20 text-center bg-white border-2 border-bauhaus-black rounded-2xl">
                        <div className="flex items-center justify-center gap-2 mb-4" aria-hidden="true">
                            <span className="w-4 h-4 rounded-full bg-bauhaus-red" />
                            <span className="w-4 h-4 bg-bauhaus-blue" />
                            <span className="w-4 h-4 bg-bauhaus-yellow" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} />
                        </div>
                        <p className="font-black text-bauhaus-black">此課程目前尚無章節</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default LessonView;
