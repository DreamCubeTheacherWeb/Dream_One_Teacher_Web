import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { Book, ChevronRight, Clock, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';

const VISIBILITY_LABELS = {
    all: '全部講師',
    intern: '實習培訓',
    formal: '正式培訓',
};

const CourseList = () => {
    const { user, profile } = useAuth();
    const [courses, setCourses] = useState([]);
    const [instructorRole, setInstructorRole] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchCourses = async () => {
            const { data: allCourses } = await supabase
                .from('courses')
                .select('*')
                .eq('is_published', true)
                .order('order', { ascending: true });

            let role = null;
            if (user) {
                const { data: instr } = await supabase
                    .from('instructors')
                    .select('instructor_role')
                    .eq('user_id', user.id)
                    .maybeSingle();
                role = instr?.instructor_role || null;
                setInstructorRole(role);
            }

            const isAdmin = profile?.role === 'admin';
            const filtered = (allCourses || []).filter((c) => {
                if (isAdmin) return true;
                const vis = c.visibility || 'all';
                if (vis === 'all') return true;
                if (vis === 'intern' && role === '實習') return true;
                if (vis === 'formal' && ['B', 'A', 'A+', 'S'].includes(role)) return true;
                return false;
            });

            setCourses(filtered);
            setLoading(false);
        };

        fetchCourses();
    }, [user, profile]);

    if (loading) return <div className="p-12 text-center text-slate-500">課程載入中...</div>;

    return (
        <div className="p-8">
            <div className="mb-8">
                <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">我的課程</h1>
                <p className="mt-2 text-slate-600">開始您的專業教師培訓之旅</p>
            </div>

            {!instructorRole && profile?.role !== 'admin' && (
                <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-5 flex items-center gap-3">
                    <Lock className="w-5 h-5 text-amber-500 shrink-0" />
                    <p className="text-amber-800 text-sm font-medium">
                        您的講師等級尚未設定，目前僅能瀏覽公開課程。請先完成個人資料填寫，並通知管理員審核。
                    </p>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {courses.length > 0 ? (
                    courses.map((course) => (
                        <Link
                            key={course.id}
                            to={`/courses/${course.id}`}
                            className="group bg-white rounded-2xl border border-slate-200 p-6 hover:border-blue-500 hover:shadow-xl hover:shadow-blue-500/10 transition-all duration-300"
                        >
                            <div className="flex items-start justify-between mb-4">
                                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 group-hover:bg-blue-600 group-hover:text-white transition-colors">
                                    <Book className="w-6 h-6" />
                                </div>
                                {course.visibility && course.visibility !== 'all' && (
                                    <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${
                                        course.visibility === 'intern'
                                            ? 'bg-teal-50 text-teal-600'
                                            : 'bg-violet-50 text-violet-600'
                                    }`}>
                                        {VISIBILITY_LABELS[course.visibility]}
                                    </span>
                                )}
                            </div>
                            <h3 className="text-xl font-bold text-slate-900 mb-2 line-clamp-2 group-hover:text-blue-600 transition-colors">
                                {course.title}
                            </h3>
                            <p className="text-slate-500 text-sm line-clamp-2 mb-6">
                                {course.description || '暫無描述'}
                            </p>

                            <div className="flex items-center justify-between mt-auto pt-4 border-t border-slate-50">
                                <div className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
                                    <Clock className="w-4 h-4" />
                                    <span>剛更新</span>
                                </div>
                                <div className="flex items-center gap-1 text-blue-600 font-semibold text-sm">
                                    進入課程
                                    <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                </div>
                            </div>
                        </Link>
                    ))
                ) : (
                    <div className="col-span-full py-20 text-center bg-slate-50 rounded-3xl border-2 border-dashed border-slate-200">
                        <p className="text-slate-400">目前尚無可用的課程。</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CourseList;
