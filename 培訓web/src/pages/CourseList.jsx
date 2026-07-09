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

// Bauhaus：卡片角落幾何裝飾（紅圓／藍方／黃三角輪替）
const CORNER_DECOS = [
    { shape: 'circle', color: 'bg-bauhaus-red' },
    { shape: 'square', color: 'bg-bauhaus-blue' },
    { shape: 'triangle', color: 'bg-bauhaus-yellow' },
];

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

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold">課程載入中...</div>;

    return (
        <div className="p-8">
            <div className="mb-8">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">我的課程</h1>
                <p className="mt-2 text-bauhaus-black/60 font-medium">開始您的專業教師培訓之旅</p>
            </div>

            {!instructorRole && profile?.role !== 'admin' && (
                <div className="mb-6 bg-bauhaus-yellow/20 border-2 border-bauhaus-black p-5 flex items-center gap-3">
                    <Lock className="w-5 h-5 text-bauhaus-black shrink-0" />
                    <p className="text-bauhaus-black text-sm font-bold">
                        您的講師等級尚未設定，目前僅能瀏覽公開課程。請先完成個人資料填寫，並通知管理員審核。
                    </p>
                </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {courses.length > 0 ? (
                    courses.map((course, idx) => {
                        const deco = CORNER_DECOS[idx % 3];
                        return (
                        <Link
                            key={course.id}
                            to={`/courses/${course.id}`}
                            className="group bh-card bh-card-hover relative p-6"
                        >
                            <span
                                aria-hidden="true"
                                className={`absolute -top-2 -left-2 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
                                style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
                            />
                            <div className="flex items-start justify-between mb-4">
                                <div className="w-12 h-12 bg-bauhaus-blue/10 border-2 border-bauhaus-black flex items-center justify-center text-bauhaus-blue group-hover:bg-bauhaus-blue group-hover:text-white transition-colors duration-200">
                                    <Book className="w-6 h-6" />
                                </div>
                                {course.visibility && course.visibility !== 'all' && (
                                    <span className={`bh-chip ${
                                        course.visibility === 'intern'
                                            ? 'bg-bauhaus-blue text-white'
                                            : 'bg-bauhaus-black text-white'
                                    }`}>
                                        {VISIBILITY_LABELS[course.visibility]}
                                    </span>
                                )}
                            </div>
                            <h3 className="text-xl font-black text-bauhaus-black mb-2 line-clamp-2 group-hover:text-bauhaus-blue transition-colors duration-200">
                                {course.title}
                            </h3>
                            <p className="text-bauhaus-black/60 text-sm line-clamp-2 mb-6 font-medium">
                                {course.description || '暫無描述'}
                            </p>

                            <div className="flex items-center justify-between mt-auto pt-4 border-t-2 border-bauhaus-black/10">
                                <div className="flex items-center gap-1.5 text-xs font-bold text-bauhaus-black/40">
                                    <Clock className="w-4 h-4" />
                                    <span>剛更新</span>
                                </div>
                                <div className="flex items-center gap-1 text-bauhaus-blue font-bold text-sm uppercase tracking-wide">
                                    進入課程
                                    <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                </div>
                            </div>
                        </Link>
                        );
                    })
                ) : (
                    <div className="col-span-full py-20 text-center bg-white border-2 border-bauhaus-black">
                        <div className="flex items-center justify-center gap-2 mb-4" aria-hidden="true">
                            <span className="w-4 h-4 rounded-full bg-bauhaus-red" />
                            <span className="w-4 h-4 bg-bauhaus-blue" />
                            <span className="w-4 h-4 bg-bauhaus-yellow" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} />
                        </div>
                        <p className="font-black text-bauhaus-black">目前尚無可用的課程</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CourseList;
