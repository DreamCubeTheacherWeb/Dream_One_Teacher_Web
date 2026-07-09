import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { BarChart3, Filter, CheckCircle, Circle, MinusCircle } from 'lucide-react';

const STATUS_OPTIONS = [
    { value: 'training', label: '培訓中', color: 'bg-bauhaus-blue text-white' },
    { value: 'completed', label: '培訓完畢', color: 'bg-bauhaus-black text-white' },
    { value: 'exempt', label: '無需培訓', color: 'bg-bauhaus-muted text-bauhaus-black' },
];

const CORNER_DECOS = [
    { shape: 'circle', color: 'bg-bauhaus-red' },
    { shape: 'square', color: 'bg-bauhaus-blue' },
    { shape: 'triangle', color: 'bg-bauhaus-yellow' },
];

const ProgressOverview = () => {
    const [courses, setCourses] = useState([]);
    const [selectedCourseId, setSelectedCourseId] = useState('');
    const [teachers, setTeachers] = useState([]);
    const [lessons, setLessons] = useState([]);
    const [progressMap, setProgressMap] = useState({});
    const [statusMap, setStatusMap] = useState({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchCourses = async () => {
            const { data } = await supabase.from('courses').select('id, title').order('order', { ascending: true });
            setCourses(data || []);
            if (data?.length > 0) setSelectedCourseId(data[0].id);
            setLoading(false);
        };
        fetchCourses();
    }, []);

    useEffect(() => {
        if (!selectedCourseId) return;
        fetchCourseData(selectedCourseId);
    }, [selectedCourseId]);

    const fetchCourseData = async (courseId) => {
        setLoading(true);

        const [teachersRes, lessonsRes, statusRes] = await Promise.all([
            supabase.from('users').select('id, name, email, mentor_name').eq('role', 'teacher'),
            supabase.from('lessons').select('id').eq('course_id', courseId),
            supabase.from('course_training_status').select('*').eq('course_id', courseId),
        ]);

        const teacherList = teachersRes.data || [];
        const lessonList = lessonsRes.data || [];
        setTeachers(teacherList);
        setLessons(lessonList);

        const sMap = {};
        (statusRes.data || []).forEach(s => { sMap[s.user_id] = s.status; });
        setStatusMap(sMap);

        if (lessonList.length > 0 && teacherList.length > 0) {
            const lessonIds = lessonList.map(l => l.id);
            const { data: progressData } = await supabase
                .from('progress')
                .select('user_id, lesson_id, completed')
                .in('lesson_id', lessonIds);

            const pMap = {};
            (progressData || []).forEach(p => {
                if (!pMap[p.user_id]) pMap[p.user_id] = 0;
                if (p.completed) pMap[p.user_id]++;
            });
            setProgressMap(pMap);
        } else {
            setProgressMap({});
        }

        setLoading(false);
    };

    const handleStatusChange = async (userId, newStatus) => {
        const { error } = await supabase
            .from('course_training_status')
            .upsert({
                user_id: userId,
                course_id: selectedCourseId,
                status: newStatus,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id,course_id' });

        if (error) {
            alert('狀態更新失敗：' + error.message);
            return;
        }
        setStatusMap({ ...statusMap, [userId]: newStatus });
    };

    if (loading && courses.length === 0) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    const totalLessons = lessons.length;

    return (
        <div className="p-4 sm:p-8 max-w-6xl mx-auto">
            <div className="flex items-center justify-between mb-6 sm:mb-8">
                <div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">培訓進度總覽</h1>
                    <p className="text-bauhaus-black/60 font-medium mt-1 text-sm sm:text-base">檢視所有講師的課程學習進度與培訓狀態</p>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 mb-6 sm:mb-8">
                <div className="flex items-center gap-2 text-sm font-bold text-bauhaus-black/60">
                    <Filter className="w-4 h-4 shrink-0" /> 選擇課程：
                </div>
                <select
                    value={selectedCourseId}
                    onChange={e => setSelectedCourseId(e.target.value)}
                    className="bh-input text-sm font-bold min-w-0 sm:min-w-[240px] w-full sm:w-auto"
                >
                    {courses.map(c => (
                        <option key={c.id} value={c.id}>{c.title}</option>
                    ))}
                </select>
                {totalLessons > 0 && (
                    <span className="bh-chip bg-bauhaus-muted text-bauhaus-black">
                        共 {totalLessons} 個章節
                    </span>
                )}
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
                {STATUS_OPTIONS.map((opt, idx) => {
                    const count = teachers.filter(t => (statusMap[t.id] || 'training') === opt.value).length;
                    const deco = CORNER_DECOS[idx % 3];
                    return (
                        <div key={opt.value} className="bh-card relative overflow-hidden p-4 flex items-center gap-3">
                            <span
                                aria-hidden="true"
                                className={`absolute -top-2 -right-2 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
                                style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
                            />
                            {opt.value === 'training' && <Circle className="w-5 h-5 text-bauhaus-blue" />}
                            {opt.value === 'completed' && <CheckCircle className="w-5 h-5 text-bauhaus-black" />}
                            {opt.value === 'exempt' && <MinusCircle className="w-5 h-5 text-bauhaus-black/40" />}
                            <div>
                                <div className="text-xl font-black text-bauhaus-black tabular-nums">{count}</div>
                                <div className="text-xs font-bold text-bauhaus-black/50 uppercase tracking-wide">{opt.label}</div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* Teacher progress table */}
            <div className="bh-card overflow-hidden">
                <div className="p-6 border-b-2 lg:border-b-4 border-bauhaus-black flex items-center gap-2">
                    <BarChart3 className="w-5 h-5 text-bauhaus-black" />
                    <h2 className="font-black text-bauhaus-black text-lg uppercase tracking-wide">講師進度列表</h2>
                </div>

                {loading ? (
                    <div className="p-12 text-center text-bauhaus-black/40 font-bold">載入資料中...</div>
                ) : (
                    <>
                        <div className="hidden md:block">
                            <table className="w-full text-left">
                                <thead className="bg-bauhaus-black text-white text-xs font-bold uppercase tracking-wider">
                                    <tr>
                                        <th className="px-6 py-4">姓名</th>
                                        <th className="px-6 py-4">Email</th>
                                        <th className="px-6 py-4">輔導員</th>
                                        <th className="px-6 py-4">章節進度</th>
                                        <th className="px-6 py-4">培訓狀態</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y-2 divide-bauhaus-black/20">
                                    {teachers.map(teacher => {
                                        const completed = progressMap[teacher.id] || 0;
                                        const pct = totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0;
                                        const currentStatus = statusMap[teacher.id] || 'training';

                                        return (
                                            <tr key={teacher.id} className="hover:bg-bauhaus-cream transition-colors">
                                                <td className="px-6 py-4 font-bold text-bauhaus-black">{teacher.name || '—'}</td>
                                                <td className="px-6 py-4 text-sm text-bauhaus-black/60">{teacher.email}</td>
                                                <td className="px-6 py-4 text-sm text-bauhaus-black/60">{teacher.mentor_name || '—'}</td>
                                                <td className="px-6 py-4">
                                                    <div className="flex items-center gap-3 min-w-[180px]">
                                                        <div className="flex-1 h-2 bg-bauhaus-muted border border-bauhaus-black/20 overflow-hidden">
                                                            <div
                                                                className="h-full bg-bauhaus-blue transition-all duration-500"
                                                                style={{ width: `${pct}%` }}
                                                            />
                                                        </div>
                                                        <span className="text-xs font-bold text-bauhaus-black/60 whitespace-nowrap">
                                                            {completed}/{totalLessons}
                                                        </span>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4">
                                                    <select
                                                        value={currentStatus}
                                                        onChange={e => handleStatusChange(teacher.id, e.target.value)}
                                                        className={`text-xs font-bold px-3 py-1.5 border-2 border-bauhaus-black rounded-none outline-none cursor-pointer ${STATUS_OPTIONS.find(o => o.value === currentStatus)?.color || ''}`}
                                                    >
                                                        {STATUS_OPTIONS.map(opt => (
                                                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                        ))}
                                                    </select>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    {teachers.length === 0 && (
                                        <tr><td colSpan="5" className="px-6 py-12 text-center text-bauhaus-black/40 font-bold">沒有講師資料</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <div className="md:hidden divide-y-2 divide-bauhaus-black/20">
                            {teachers.length === 0 ? (
                                <div className="px-4 py-12 text-center text-bauhaus-black/40 font-bold">沒有講師資料</div>
                            ) : (
                                teachers.map(teacher => {
                                    const completed = progressMap[teacher.id] || 0;
                                    const pct = totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0;
                                    const currentStatus = statusMap[teacher.id] || 'training';

                                    return (
                                        <div key={teacher.id} className="p-4">
                                            <div className="font-bold text-bauhaus-black">{teacher.name || '—'}</div>
                                            <div className="text-sm text-bauhaus-black/60 mt-0.5">{teacher.email}</div>
                                            {teacher.mentor_name && (
                                                <span className="bh-chip bg-bauhaus-muted text-bauhaus-black mt-2 inline-flex">
                                                    {teacher.mentor_name}
                                                </span>
                                            )}
                                            <div className="flex items-center gap-3 mt-3">
                                                <div className="flex-1 h-2 bg-bauhaus-muted border border-bauhaus-black/20 overflow-hidden min-w-0">
                                                    <div
                                                        className="h-full bg-bauhaus-blue transition-all duration-500"
                                                        style={{ width: `${pct}%` }}
                                                    />
                                                </div>
                                                <span className="text-xs font-bold text-bauhaus-black/60 shrink-0">
                                                    {completed}/{totalLessons}
                                                </span>
                                            </div>
                                            <div className="mt-3">
                                                <select
                                                    value={currentStatus}
                                                    onChange={e => handleStatusChange(teacher.id, e.target.value)}
                                                    className={`text-xs font-bold px-3 py-1.5 border-2 border-bauhaus-black rounded-none outline-none cursor-pointer w-full sm:w-auto ${STATUS_OPTIONS.find(o => o.value === currentStatus)?.color || ''}`}
                                                >
                                                    {STATUS_OPTIONS.map(opt => (
                                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                                    ))}
                                                </select>
                                            </div>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default ProgressOverview;
