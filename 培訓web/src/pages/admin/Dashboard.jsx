import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import {
    Plus, Edit2, Trash2, Eye, EyeOff, LayoutGrid, Users,
    ClipboardCheck, UserCog, BarChart3, Megaphone, ChevronRight,
    ContactRound, BookOpen, GraduationCap, Settings, Shield, FileSignature, Wallet
} from 'lucide-react';
import { Link } from 'react-router-dom';

const AdminDashboard = () => {
    const { profile } = useAuth();
    const isAdmin = profile?.role === 'admin';
    const [courses, setCourses] = useState([]);
    const [stats, setStats] = useState({ teachers: 0, courses: 0, assignments: 0 });
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchData = async () => {
            const { data: coursesData } = await supabase
                .from('courses')
                .select('*')
                .order('order', { ascending: true });
            setCourses(coursesData || []);

            const { count: userCount } = await supabase.from('users').select('*', { count: 'exact', head: true });
            const { count: assignCount } = await supabase.from('assignments').select('*', { count: 'exact', head: true }).is('feedback', null);

            setStats({
                teachers: userCount || 0,
                courses: coursesData?.length || 0,
                assignments: assignCount || 0
            });
            setLoading(false);
        };

        fetchData();
    }, []);

    const toggleCourseStatus = async (course) => {
        const { error } = await supabase
            .from('courses')
            .update({ is_published: !course.is_published })
            .eq('id', course.id);

        if (!error) {
            setCourses(courses.map(c => c.id === course.id ? { ...c, is_published: !c.is_published } : c));
        }
    };

    const deleteCourse = async (course) => {
        if (!window.confirm(`確定要刪除課程「${course.title}」嗎？\n此操作將同時刪除所有相關章節與內容，無法復原。`)) return;

        const { error } = await supabase
            .from('courses')
            .delete()
            .eq('id', course.id);

        if (error) {
            alert('刪除失敗：' + error.message);
            return;
        }
        setCourses(courses.filter(c => c.id !== course.id));
        setStats(prev => ({ ...prev, courses: prev.courses - 1 }));
    };

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    return (
        <div className="p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl sm:text-3xl font-black text-slate-900">後台管理總覽</h1>
                <p className="text-slate-500 mt-1">
                    {isAdmin ? '管理培訓內容、講師名單與系統設定' : '管理培訓內容與作業回饋'}
                </p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-10">
                <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 bg-indigo-50 text-indigo-600 rounded-xl flex items-center justify-center">
                        <Users className="w-6 h-6" />
                    </div>
                    <div>
                        <div className="text-2xl font-black text-slate-900">{stats.teachers}</div>
                        <div className="text-sm font-medium text-slate-400">總人數</div>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center">
                        <LayoutGrid className="w-6 h-6" />
                    </div>
                    <div>
                        <div className="text-2xl font-black text-slate-900">{stats.courses}</div>
                        <div className="text-sm font-medium text-slate-400">上線課程</div>
                    </div>
                </div>
                <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-4">
                    <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center">
                        <ClipboardCheck className="w-6 h-6" />
                    </div>
                    <div>
                        <div className="text-2xl font-black text-slate-900">{stats.assignments}</div>
                        <div className="text-sm font-medium text-slate-400">待審核作業</div>
                    </div>
                </div>
            </div>

            {/* ── 培訓管理 ── */}
            <div className="mb-10">
                <div className="flex items-center gap-2 mb-4">
                    <GraduationCap className="w-5 h-5 text-blue-600" />
                    <h2 className="text-lg font-bold text-slate-900">培訓管理</h2>
                    <span className="text-xs text-slate-400 ml-1">課程內容與作業回饋</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <NavCard to="/admin/assignments" icon={ClipboardCheck} title="作業審核中心" desc="查看與回覆講師繳交的作業" color="amber" />
                    <NavCard to="/admin/progress" icon={BarChart3} title="培訓進度總覽" desc="檢視所有講師學習進度與狀態" color="emerald" />
                    <NavCard to="/admin/instructors" icon={ContactRound} title="講師資料總覽" desc="查看所有講師個人資料與文件" color="purple" />
                    <NavCard to="/admin/salary" icon={Wallet} title="薪資登記中心" desc="登記每月薪資、查看異常與付款狀態" color="rose" />
                </div>
            </div>

            {/* ── 系統管理（僅管理員） ── */}
            {isAdmin && (
                <div className="mb-10">
                    <div className="flex items-center gap-2 mb-4">
                        <Shield className="w-5 h-5 text-indigo-600" />
                        <h2 className="text-lg font-bold text-slate-900">系統管理</h2>
                        <span className="text-xs text-slate-400 ml-1">僅管理員可見</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <NavCard to="/admin/teachers" icon={UserCog} title="講師名單管理" desc="新增、管理講師與權限設定" color="blue" />
                        <NavCard to="/admin/announcements" icon={Megaphone} title="佈告欄管理" desc="新增、編輯首頁公告內容" color="red" />
                        <NavCard to="/admin/contracts" icon={FileSignature} title="合約文件管理" desc="管理合約文件與查看簽約狀態" color="violet" />
                    </div>
                </div>
            )}

            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                <div className="p-6 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-bold text-slate-900 text-lg">課程列表</h2>
                    {isAdmin && (
                        <Link to="/admin/cms/new" className="bg-blue-600 text-white px-5 py-2.5 rounded-xl font-bold flex items-center gap-2 hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20 text-sm shrink-0">
                            <Plus className="w-4 h-4" /> 建立新課程
                        </Link>
                    )}
                </div>
                <div className="md:hidden divide-y divide-slate-100">
                    {courses.map(course => (
                        <div key={course.id} className="p-4">
                            <div className="font-bold text-slate-900">{course.title}</div>
                            <div className="text-xs text-slate-400 line-clamp-2 mt-1">{course.description}</div>
                            <div className="flex flex-wrap gap-2 mt-3">
                                <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                                    course.visibility === 'intern' ? 'bg-teal-50 text-teal-600' :
                                    course.visibility === 'formal' ? 'bg-violet-50 text-violet-600' :
                                    'bg-slate-50 text-slate-400'
                                }`}>
                                    {course.visibility === 'intern' ? '實習培訓' :
                                     course.visibility === 'formal' ? '正式培訓' : '全部'}
                                </span>
                                <span className="text-xs text-slate-500 bg-slate-50 px-2 py-1 rounded-full">排序 {course.order}</span>
                                {course.is_published ? (
                                    <span className="inline-flex items-center gap-1 text-xs font-bold text-green-600 bg-green-50 px-2.5 py-1 rounded-full">
                                        <Eye className="w-3 h-3" /> 已發佈
                                    </span>
                                ) : (
                                    <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">
                                        <EyeOff className="w-3 h-3" /> 草稿
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 mt-3">
                                {isAdmin && (
                                    <button
                                        onClick={() => toggleCourseStatus(course)}
                                        className="p-2 text-slate-400 hover:text-blue-600 transition-colors"
                                        title={course.is_published ? "下架" : "發佈"}
                                    >
                                        {course.is_published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                )}
                                <Link to={`/admin/cms/${course.id}`} className="p-2 text-slate-400 hover:text-blue-600 transition-colors">
                                    <Edit2 className="w-4 h-4" />
                                </Link>
                                {isAdmin && (
                                    <button
                                        onClick={() => deleteCourse(course)}
                                        className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                                        title="刪除課程"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
                <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left">
                        <thead className="bg-slate-50 text-slate-400 text-xs font-bold uppercase tracking-wider">
                            <tr>
                                <th className="px-6 py-4">名稱</th>
                                <th className="px-6 py-4">可見對象</th>
                                <th className="px-6 py-4">排序</th>
                                <th className="px-6 py-4">狀態</th>
                                <th className="px-6 py-4 text-right">操作</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                            {courses.map(course => (
                                <tr key={course.id} className="hover:bg-slate-50 transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="font-semibold text-slate-900">{course.title}</div>
                                        <div className="text-xs text-slate-400 line-clamp-1">{course.description}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                                            course.visibility === 'intern' ? 'bg-teal-50 text-teal-600' :
                                            course.visibility === 'formal' ? 'bg-violet-50 text-violet-600' :
                                            'bg-slate-50 text-slate-400'
                                        }`}>
                                            {course.visibility === 'intern' ? '實習培訓' :
                                             course.visibility === 'formal' ? '正式培訓' : '全部'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-slate-500 text-sm">{course.order}</td>
                                    <td className="px-6 py-4">
                                        {course.is_published ? (
                                            <span className="inline-flex items-center gap-1 text-xs font-bold text-green-600 bg-green-50 px-2.5 py-1 rounded-full">
                                                <Eye className="w-3 h-3" /> 已發佈
                                            </span>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-400 bg-slate-100 px-2.5 py-1 rounded-full">
                                                <EyeOff className="w-3 h-3" /> 草稿
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            {isAdmin && (
                                                <button
                                                    onClick={() => toggleCourseStatus(course)}
                                                    className="p-2 text-slate-400 hover:text-blue-600 transition-colors"
                                                    title={course.is_published ? "下架" : "發佈"}
                                                >
                                                    {course.is_published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                </button>
                                            )}
                                            <Link to={`/admin/cms/${course.id}`} className="p-2 text-slate-400 hover:text-blue-600 transition-colors">
                                                <Edit2 className="w-4 h-4" />
                                            </Link>
                                            {isAdmin && (
                                                <button
                                                    onClick={() => deleteCourse(course)}
                                                    className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                                                    title="刪除課程"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
};

const NavCard = ({ to, icon: Icon, title, desc, color }) => {
    const colorMap = {
        blue: { bg: 'bg-blue-50', text: 'text-blue-600', hoverBg: 'group-hover:bg-blue-600', hoverBorder: 'hover:border-blue-300', hoverArrow: 'group-hover:text-blue-400' },
        emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600', hoverBg: 'group-hover:bg-emerald-600', hoverBorder: 'hover:border-emerald-300', hoverArrow: 'group-hover:text-emerald-400' },
        red: { bg: 'bg-red-50', text: 'text-red-500', hoverBg: 'group-hover:bg-red-500', hoverBorder: 'hover:border-red-300', hoverArrow: 'group-hover:text-red-400' },
        purple: { bg: 'bg-purple-50', text: 'text-purple-600', hoverBg: 'group-hover:bg-purple-600', hoverBorder: 'hover:border-purple-300', hoverArrow: 'group-hover:text-purple-400' },
        amber: { bg: 'bg-amber-50', text: 'text-amber-600', hoverBg: 'group-hover:bg-amber-600', hoverBorder: 'hover:border-amber-300', hoverArrow: 'group-hover:text-amber-400' },
        rose: { bg: 'bg-rose-50', text: 'text-rose-600', hoverBg: 'group-hover:bg-rose-600', hoverBorder: 'hover:border-rose-300', hoverArrow: 'group-hover:text-rose-400' },
        violet: { bg: 'bg-violet-50', text: 'text-violet-600', hoverBg: 'group-hover:bg-violet-600', hoverBorder: 'hover:border-violet-300', hoverArrow: 'group-hover:text-violet-400' },
    };
    const c = colorMap[color] || colorMap.blue;

    return (
        <Link to={to} className={`group bg-white p-5 rounded-2xl border border-slate-100 shadow-sm ${c.hoverBorder} hover:shadow-md transition-all flex items-center gap-4`}>
            <div className={`w-11 h-11 ${c.bg} ${c.text} rounded-xl flex items-center justify-center ${c.hoverBg} group-hover:text-white transition-colors`}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
                <div className="font-bold text-slate-900">{title}</div>
                <div className="text-xs text-slate-400">{desc}</div>
            </div>
            <ChevronRight className={`w-5 h-5 text-slate-300 ${c.hoverArrow} transition-colors`} />
        </Link>
    );
};

export default AdminDashboard;
