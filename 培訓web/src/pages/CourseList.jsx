import { useEffect, useState } from 'react';
import { Book, ChevronLeft, ChevronRight, Clock, Layers3, Lock } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import {
    trainingVisibilityClass,
    trainingVisibilityLabel,
} from '../lib/courseCategories';
import { supabase } from '../lib/supabaseClient';

const CORNER_DECOS = [
    { shape: 'circle', color: 'bg-bauhaus-red' },
    { shape: 'square', color: 'bg-bauhaus-blue' },
    { shape: 'triangle', color: 'bg-bauhaus-yellow' },
];

const CornerDeco = ({ index }) => {
    const deco = CORNER_DECOS[index % CORNER_DECOS.length];
    return (
        <span
            aria-hidden="true"
            className={`absolute -top-2 -left-2 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
            style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
        />
    );
};

const EmptyState = ({ children }) => (
    <div className="col-span-full py-20 text-center bg-white border-2 border-bauhaus-black rounded-2xl">
        <div className="flex items-center justify-center gap-2 mb-4" aria-hidden="true">
            <span className="w-4 h-4 rounded-full bg-bauhaus-red" />
            <span className="w-4 h-4 bg-bauhaus-blue" />
            <span className="w-4 h-4 bg-bauhaus-yellow" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} />
        </div>
        <p className="font-black text-bauhaus-black">{children}</p>
    </div>
);

export const CourseCatalog = ({ categories, courses, instructorRole, profile, loadError, selectedCategoryId }) => {
    const selectedCategory = categories.find(category => category.id === selectedCategoryId) || null;
    const categoryCourses = selectedCategory
        ? courses.filter(course => course.category_id === selectedCategory.id)
        : [];

    return (
        <div className="p-4 sm:p-8">
            {selectedCategory ? (
                <>
                    <Link
                        to="/courses"
                        className="inline-flex items-center gap-1.5 text-xs font-black text-bauhaus-blue uppercase tracking-widest hover:text-bauhaus-black mb-5 transition-colors min-h-[44px]"
                    >
                        <ChevronLeft className="w-3.5 h-3.5" /> 所有課程大分類
                    </Link>
                    <div className="mb-8 flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
                        <div>
                            <div className="flex flex-wrap items-center gap-2 mb-2">
                                <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black">
                                    <Layers3 className="w-3 h-3" /> 課程大分類
                                </span>
                                {selectedCategory.visibility !== 'all' && (
                                    <span className={`bh-chip ${trainingVisibilityClass(selectedCategory.visibility)}`}>
                                        {trainingVisibilityLabel(selectedCategory.visibility, true)}
                                    </span>
                                )}
                            </div>
                            <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">{selectedCategory.title}</h1>
                            <p className="mt-2 text-bauhaus-black/60 font-medium">
                                {selectedCategory.description || '選擇一門課程開始學習'}
                            </p>
                        </div>
                        <div className="text-sm font-black text-bauhaus-black/45 shrink-0">{categoryCourses.length} 門課程</div>
                    </div>
                </>
            ) : (
                <div className="mb-8">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="w-3 h-3 rounded-full bg-bauhaus-red" aria-hidden="true" />
                        <span className="w-3 h-3 bg-bauhaus-blue" aria-hidden="true" />
                        <span className="w-3 h-3 bg-bauhaus-yellow" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} aria-hidden="true" />
                    </div>
                    <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">我的課程</h1>
                    <p className="mt-2 text-bauhaus-black/60 font-medium">請先選擇培訓大分類</p>
                </div>
            )}

            {!instructorRole && profile?.role !== 'admin' && (
                <div className="mb-6 bg-bauhaus-yellow/20 border-2 border-bauhaus-black rounded-2xl p-5 flex items-center gap-3">
                    <Lock className="w-5 h-5 text-bauhaus-black shrink-0" />
                    <p className="text-bauhaus-black text-sm font-bold">
                        您的講師等級尚未設定，目前僅能瀏覽公開給全部講師的分類。請先完成個人資料填寫，並通知管理員審核。
                    </p>
                </div>
            )}

            {loadError && (
                <div className="mb-6 bg-bauhaus-red/10 border-2 border-bauhaus-red rounded-2xl p-5 text-sm font-bold text-bauhaus-red">
                    課程讀取失敗：{loadError}
                </div>
            )}

            {!selectedCategory ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {categories.length > 0 ? categories.map((category, index) => {
                        const courseCount = courses.filter(course => course.category_id === category.id).length;
                        return (
                            <Link
                                key={category.id}
                                to={`/courses?category=${category.id}`}
                                className="group bh-card bh-card-hover relative p-6 min-h-[260px] flex flex-col"
                            >
                                <CornerDeco index={index} />
                                <div className="flex items-start justify-between gap-3 mb-7">
                                    <div className="w-14 h-14 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl flex items-center justify-center text-bauhaus-black group-hover:bg-bauhaus-black group-hover:text-white transition-colors duration-200">
                                        <Layers3 className="w-7 h-7" />
                                    </div>
                                    {category.visibility !== 'all' && (
                                        <span className={`bh-chip ${trainingVisibilityClass(category.visibility)}`}>
                                            {trainingVisibilityLabel(category.visibility, true)}
                                        </span>
                                    )}
                                </div>
                                <h2 className="text-2xl font-black text-bauhaus-black mb-2 line-clamp-2 group-hover:text-bauhaus-blue transition-colors duration-200">
                                    {category.title}
                                </h2>
                                <p className="text-bauhaus-black/60 text-sm line-clamp-3 font-medium leading-relaxed">
                                    {category.description || '進入查看此分類的培訓課程'}
                                </p>
                                <div className="flex items-center justify-between mt-auto pt-5 border-t-2 border-bauhaus-black/10">
                                    <span className="text-xs font-black text-bauhaus-black/45">{courseCount} 門課程</span>
                                    <span className="flex items-center gap-1 text-bauhaus-blue font-bold text-sm">
                                        查看課程 <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                    </span>
                                </div>
                            </Link>
                        );
                    }) : (
                        <EmptyState>目前尚無可用的課程大分類</EmptyState>
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {categoryCourses.length > 0 ? categoryCourses.map((course, index) => (
                        <Link
                            key={course.id}
                            to={`/courses/${course.id}`}
                            className="group bh-card bh-card-hover relative p-6"
                        >
                            <CornerDeco index={index} />
                            <div className="flex items-start justify-between mb-4">
                                <div className="w-12 h-12 bg-bauhaus-blue/10 border-2 border-bauhaus-black rounded-lg flex items-center justify-center text-bauhaus-blue group-hover:bg-bauhaus-blue group-hover:text-white transition-colors duration-200">
                                    <Book className="w-6 h-6" />
                                </div>
                                {course.visibility && course.visibility !== 'all' && (
                                    <span className={`bh-chip ${trainingVisibilityClass(course.visibility)}`}>
                                        {trainingVisibilityLabel(course.visibility, true)}
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
                    )) : (
                        <EmptyState>此大分類目前尚無可用課程</EmptyState>
                    )}
                </div>
            )}
        </div>
    );
};

const CourseList = () => {
    const { user, profile } = useAuth();
    const [searchParams] = useSearchParams();
    const [categories, setCategories] = useState([]);
    const [courses, setCourses] = useState([]);
    const [instructorRole, setInstructorRole] = useState(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');

    useEffect(() => {
        const fetchCourses = async () => {
            setLoading(true);
            setLoadError('');

            const [{ data: categoryData, error: categoryError }, { data: courseData, error: courseError }] = await Promise.all([
                supabase
                    .from('course_categories')
                    .select('*')
                    .eq('is_published', true)
                    .order('order', { ascending: true }),
                supabase
                    .from('courses')
                    .select('*')
                    .eq('is_published', true)
                    .order('order', { ascending: true }),
            ]);

            let role = null;
            if (user) {
                const { data: instructor } = await supabase
                    .from('instructors')
                    .select('instructor_role')
                    .eq('user_id', user.id)
                    .maybeSingle();
                role = instructor?.instructor_role || null;
            }

            if (categoryError || courseError) {
                setLoadError(categoryError?.message || courseError?.message || '讀取課程失敗');
            }
            setCategories(categoryData || []);
            setCourses(courseData || []);
            setInstructorRole(role);
            setLoading(false);
        };

        fetchCourses();
    }, [user, profile]);

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold">課程載入中...</div>;

    return (
        <CourseCatalog
            categories={categories}
            courses={courses}
            instructorRole={instructorRole}
            profile={profile}
            loadError={loadError}
            selectedCategoryId={searchParams.get('category')}
        />
    );
};

export default CourseList;
