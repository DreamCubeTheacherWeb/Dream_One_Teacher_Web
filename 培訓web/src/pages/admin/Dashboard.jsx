import { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabaseClient';
import { useAuth } from '../../context/AuthContext';
import {
    Plus, Edit2, Trash2, Eye, EyeOff, LayoutGrid, Users,
    ClipboardCheck, UserCog, BarChart3, Megaphone, ChevronRight,
    ContactRound, BookOpen, GraduationCap, Settings, Shield, FileSignature, Wallet, Download, Award, Trophy
} from 'lucide-react';
import { Link2 } from 'lucide-react';
import { Link } from 'react-router-dom';

const CORNER_DECOS = [
    { shape: 'circle', color: 'bg-bauhaus-red' },
    { shape: 'square', color: 'bg-bauhaus-blue' },
    { shape: 'triangle', color: 'bg-bauhaus-yellow' },
];

const STATS_CONFIG = [
    { key: 'teachers', icon: Users, label: '總人數' },
    { key: 'courses', icon: LayoutGrid, label: '上線課程' },
    { key: 'assignments', icon: ClipboardCheck, label: '待審核作業' },
];

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

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold uppercase tracking-wide">載入中...</div>;

    return (
        <div className="p-4 sm:p-8">
            <div className="mb-8">
                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black tracking-tight">後台管理總覽</h1>
                <p className="text-bauhaus-black/60 font-medium mt-1">
                    {isAdmin ? '管理培訓內容、講師名單與系統設定' : '管理培訓內容與作業回饋'}
                </p>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-6 mb-10">
                {STATS_CONFIG.map((s, idx) => {
                    const deco = CORNER_DECOS[idx % 3];
                    const Icon = s.icon;
                    return (
                        <div key={s.key} className="bh-card relative overflow-hidden p-6 flex items-center gap-4">
                            <span
                                aria-hidden="true"
                                className={`absolute -top-2 -right-2 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
                                style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
                            />
                            <div className="w-12 h-12 rounded-lg border-2 border-bauhaus-black bg-bauhaus-black text-white flex items-center justify-center shrink-0">
                                <Icon className="w-6 h-6" />
                            </div>
                            <div>
                                <div className="text-4xl font-black text-bauhaus-black tabular-nums">{stats[s.key]}</div>
                                <div className="text-sm font-bold text-bauhaus-black/50 uppercase tracking-wide">{s.label}</div>
                            </div>
                        </div>
                    );
                })}
            </div>

            {/* ── 培訓管理 ── */}
            <div className="mb-10">
                <div className="flex items-center gap-2 mb-4">
                    <GraduationCap className="w-5 h-5 text-bauhaus-black" />
                    <h2 className="text-lg font-black uppercase tracking-wide text-bauhaus-black">培訓管理</h2>
                    <span className="text-xs text-bauhaus-black/40 font-bold ml-1">課程內容與作業回饋</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <NavCard to="/admin/assignments" icon={ClipboardCheck} title="作業審核中心" desc="查看與回覆講師繳交的作業" color="amber" />
                    <NavCard to="/admin/progress" icon={BarChart3} title="培訓進度總覽" desc="檢視所有講師學習進度與狀態" color="emerald" />
                    <NavCard to="/admin/instructors" icon={ContactRound} title="講師資料總覽" desc="查看所有講師個人資料與文件" color="purple" />
                    <NavCard to="/admin/salary" icon={Wallet} title="薪資登記中心" desc="登記每月薪資、查看異常與付款狀態" color="rose" />
                    <NavCard to="/admin/download-center" icon={Download} title="表單下載中心" desc="批次下載講師匯款申請書與其他自動填表" color="emerald" />
                </div>
            </div>

            {/* ── 系統管理（僅管理員） ── */}
            {isAdmin && (
                <div className="mb-10">
                    <div className="flex items-center gap-2 mb-4">
                        <Shield className="w-5 h-5 text-bauhaus-black" />
                        <h2 className="text-lg font-black uppercase tracking-wide text-bauhaus-black">系統管理</h2>
                        <span className="text-xs text-bauhaus-black/40 font-bold ml-1">僅管理員可見</span>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        <NavCard to="/admin/teachers" icon={UserCog} title="講師名單管理" desc="新增、管理講師與權限設定" color="blue" />
                        <NavCard to="/admin/announcements" icon={Megaphone} title="佈告欄管理" desc="新增、編輯首頁公告內容" color="red" />
                        <NavCard to="/admin/contracts" icon={FileSignature} title="合約文件管理" desc="管理合約文件與查看簽約狀態" color="violet" />
                        <NavCard to="/admin/badges" icon={Award} title="徽章管理" desc="管理徽章清單規則、手動頒發或收回徽章" color="amber" />
                        <NavCard to="/admin/wca" icon={Trophy} title="WCA 資料管理" desc="檢視/清除老師 WCA 資料、停權亂填者" color="rose" />
                        <NavCard to="/admin/salary-links" icon={Link2} title="薪資頁連結" desc="編輯我的薪資頁三顆按鈕的連結" color="emerald" />
                        <NavCard to="/admin/notifications" icon={Megaphone} title="廣播通知" desc="立即或排程發送小鈴鐺通知給講師" color="purple" />
                    </div>
                </div>
            )}

            <div className="bh-card overflow-hidden">
                <div className="p-6 border-b-2 lg:border-b-4 border-bauhaus-black flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-black text-bauhaus-black text-lg uppercase tracking-wide">課程列表</h2>
                    {isAdmin && (
                        <Link to="/admin/cms/new" className="bh-btn bh-btn-blue px-5 py-2.5 text-sm shrink-0">
                            <Plus className="w-4 h-4" /> 建立新課程
                        </Link>
                    )}
                </div>
                <div className="md:hidden divide-y-2 divide-bauhaus-black/20">
                    {courses.map(course => (
                        <div key={course.id} className="p-4">
                            <div className="font-bold text-bauhaus-black">{course.title}</div>
                            <div className="text-xs text-bauhaus-black/50 line-clamp-2 mt-1">{course.description}</div>
                            <div className="flex flex-wrap gap-2 mt-3">
                                <span className={`bh-chip ${
                                    course.visibility === 'intern' ? 'bg-bauhaus-blue text-white' :
                                    course.visibility === 'formal' ? 'bg-bauhaus-black text-white' :
                                    'bg-bauhaus-muted text-bauhaus-black'
                                }`}>
                                    {course.visibility === 'intern' ? '實習培訓' :
                                     course.visibility === 'formal' ? '正式培訓' : '全部'}
                                </span>
                                <span className="bh-chip bg-bauhaus-muted text-bauhaus-black">排序 {course.order}</span>
                                {course.is_published ? (
                                    <span className="bh-chip bg-bauhaus-blue text-white">
                                        <Eye className="w-3 h-3" /> 已發佈
                                    </span>
                                ) : (
                                    <span className="bh-chip bg-bauhaus-muted text-bauhaus-black">
                                        <EyeOff className="w-3 h-3" /> 草稿
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 mt-3">
                                {isAdmin && (
                                    <button
                                        onClick={() => toggleCourseStatus(course)}
                                        className="p-2 text-bauhaus-black/40 hover:text-bauhaus-blue transition-colors"
                                        title={course.is_published ? "下架" : "發佈"}
                                    >
                                        {course.is_published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                )}
                                <Link to={`/admin/cms/${course.id}`} className="p-2 text-bauhaus-black/40 hover:text-bauhaus-blue transition-colors">
                                    <Edit2 className="w-4 h-4" />
                                </Link>
                                {isAdmin && (
                                    <button
                                        onClick={() => deleteCourse(course)}
                                        className="p-2 text-bauhaus-black/40 hover:text-bauhaus-red transition-colors"
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
                        <thead className="bg-bauhaus-black text-white text-xs font-bold uppercase tracking-wider">
                            <tr>
                                <th className="px-6 py-4">名稱</th>
                                <th className="px-6 py-4">可見對象</th>
                                <th className="px-6 py-4">排序</th>
                                <th className="px-6 py-4">狀態</th>
                                <th className="px-6 py-4 text-right">操作</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y-2 divide-bauhaus-black/20">
                            {courses.map(course => (
                                <tr key={course.id} className="hover:bg-bauhaus-cream transition-colors">
                                    <td className="px-6 py-4">
                                        <div className="font-bold text-bauhaus-black">{course.title}</div>
                                        <div className="text-xs text-bauhaus-black/50 line-clamp-1">{course.description}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={`bh-chip ${
                                            course.visibility === 'intern' ? 'bg-bauhaus-blue text-white' :
                                            course.visibility === 'formal' ? 'bg-bauhaus-black text-white' :
                                            'bg-bauhaus-muted text-bauhaus-black'
                                        }`}>
                                            {course.visibility === 'intern' ? '實習培訓' :
                                             course.visibility === 'formal' ? '正式培訓' : '全部'}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-bauhaus-black/60 text-sm font-bold">{course.order}</td>
                                    <td className="px-6 py-4">
                                        {course.is_published ? (
                                            <span className="bh-chip bg-bauhaus-blue text-white">
                                                <Eye className="w-3 h-3" /> 已發佈
                                            </span>
                                        ) : (
                                            <span className="bh-chip bg-bauhaus-muted text-bauhaus-black">
                                                <EyeOff className="w-3 h-3" /> 草稿
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            {isAdmin && (
                                                <button
                                                    onClick={() => toggleCourseStatus(course)}
                                                    className="p-2 text-bauhaus-black/40 hover:text-bauhaus-blue transition-colors"
                                                    title={course.is_published ? "下架" : "發佈"}
                                                >
                                                    {course.is_published ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                </button>
                                            )}
                                            <Link to={`/admin/cms/${course.id}`} className="p-2 text-bauhaus-black/40 hover:text-bauhaus-blue transition-colors">
                                                <Edit2 className="w-4 h-4" />
                                            </Link>
                                            {isAdmin && (
                                                <button
                                                    onClick={() => deleteCourse(course)}
                                                    className="p-2 text-bauhaus-black/40 hover:text-bauhaus-red transition-colors"
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

const NavCard = ({ to, icon, title, desc, color }) => {
    const Icon = icon;
    const colorMap = {
        blue: { bg: 'bg-bauhaus-blue', text: 'text-white' },
        emerald: { bg: 'bg-bauhaus-blue', text: 'text-white' },
        red: { bg: 'bg-bauhaus-red', text: 'text-white' },
        purple: { bg: 'bg-bauhaus-black', text: 'text-white' },
        amber: { bg: 'bg-bauhaus-yellow', text: 'text-bauhaus-black' },
        rose: { bg: 'bg-bauhaus-red', text: 'text-white' },
        violet: { bg: 'bg-bauhaus-black', text: 'text-white' },
    };
    const c = colorMap[color] || colorMap.blue;

    return (
        <Link to={to} className="bh-card bh-card-hover group p-5 flex items-center gap-4">
            <div className={`w-11 h-11 border-2 border-bauhaus-black ${c.bg} ${c.text} flex items-center justify-center shrink-0`}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1">
                <div className="font-bold text-bauhaus-black">{title}</div>
                <div className="text-xs text-bauhaus-black/50">{desc}</div>
            </div>
            <ChevronRight className="w-5 h-5 text-bauhaus-black/30 group-hover:text-bauhaus-black transition-colors" />
        </Link>
    );
};

export default AdminDashboard;
