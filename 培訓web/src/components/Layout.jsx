import { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { LogIn, LogOut, BookOpen, LayoutDashboard, UserCircle, Bell, Check, CheckCheck, Megaphone, Star, ThumbsUp, Menu, X, FileSignature, Wallet } from 'lucide-react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import ProfileCompleteGate from './ProfileCompleteGate';

const ROLE_LABELS = { admin: '管理員', mentor: '輔導員', teacher: '講師', pending: '待審核' };

const PenguinAvatar = () => (
    <svg viewBox="0 0 64 64" className="w-full h-full" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="32" fill="#e2e8f0" />
        <ellipse cx="32" cy="38" rx="16" ry="18" fill="#334155" />
        <ellipse cx="32" cy="40" rx="10" ry="14" fill="#f1f5f9" />
        <circle cx="26" cy="30" r="3" fill="white" />
        <circle cx="38" cy="30" r="3" fill="white" />
        <circle cx="27" cy="30" r="1.5" fill="#1e293b" />
        <circle cx="39" cy="30" r="1.5" fill="#1e293b" />
        <ellipse cx="32" cy="35" rx="3" ry="2" fill="#f59e0b" />
    </svg>
);

const Layout = ({ children }) => {
    const { user, profile, instructorProfile, avatarUrl, loading, signOut } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    useEffect(() => {
        if (loading || !user || !profile) return;
        const isPrivileged = profile.role === 'admin' || profile.role === 'mentor';
        if (!isPrivileged && profile.role === 'pending') {
            const path = location.pathname;
            if (path !== '/profile' && path !== '/pending' && !path.startsWith('/announcements')) {
                navigate('/pending', { replace: true });
            }
        }
    }, [loading, user, profile, navigate, location.pathname]);

    // 每次登入檢查是否尚未簽約，未簽約則發送提醒通知
    useEffect(() => {
        if (loading || !user || !profile || profile.role === 'pending') return;
        const key = `contract_reminder_${user.id}`;
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');

        (async () => {
            try {
                const { data } = await supabase
                    .from('instructor_contracts')
                    .select('id')
                    .eq('user_id', user.id)
                    .eq('status', 'signed')
                    .limit(1);
                if (data && data.length > 0) return;

                await supabase.from('notifications').insert({
                    user_id: user.id,
                    type: 'contract',
                    title: '尚未完成合約簽署',
                    body: '請盡快前往簽署合約，完成後才算正式生效。',
                    link: '/contract',
                });
            } catch (err) {
                console.error('Contract reminder check failed:', err);
            }
        })();
    }, [loading, user, profile]);

    // 路由切換時關閉手機選單
    useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

    const displayName = instructorProfile?.nickname || instructorProfile?.full_name || profile?.name || user?.email?.split('@')[0] || '';

    return (
        <div className="min-h-screen flex flex-col overflow-x-hidden">
            <header className="bg-white border-b border-slate-200 relative z-50">
                <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
                    <Link to="/" className="flex items-center gap-2 font-bold text-xl text-blue-600 shrink-0">
                        <img src="/logo.png" alt="夢想一號 Logo" className="w-9 h-9 object-contain" />
                        <span className="hidden sm:inline">講師資源站</span>
                    </Link>

                    {/* 桌面版導航 */}
                    <nav className="hidden md:flex items-center gap-5">
                        {user ? (
                            <>
                                {profile && profile.role !== 'pending' ? (
                                    <Link to="/courses" className="flex items-center gap-1 text-slate-600 hover:text-blue-600 font-medium text-sm">
                                        <BookOpen className="w-4 h-4" />
                                        我的課程
                                    </Link>
                                ) : (
                                    <button
                                        onClick={() => alert('權限尚未開啟，如資料已填寫完，請通知夢想一號管理員協助開啟權限')}
                                        className="flex items-center gap-1 text-slate-400 hover:text-slate-500 font-medium cursor-pointer text-sm"
                                    >
                                        <BookOpen className="w-4 h-4" />
                                        我的課程
                                    </button>
                                )}
                                <Link to="/profile" className="flex items-center gap-1 text-slate-600 hover:text-blue-600 font-medium text-sm">
                                    <UserCircle className="w-4 h-4" />
                                    個人資料
                                </Link>
                                {profile && profile.role !== 'pending' && (
                                    <Link to="/my/salary" className="flex items-center gap-1 text-slate-600 hover:text-blue-600 font-medium text-sm">
                                        <Wallet className="w-4 h-4" />
                                        我的薪資
                                    </Link>
                                )}
                                {(profile?.role === 'admin' || profile?.role === 'mentor') && (
                                    <Link to="/admin" className="flex items-center gap-1 text-slate-600 hover:text-blue-600 font-medium text-sm">
                                        <LayoutDashboard className="w-4 h-4" />
                                        後台管理
                                    </Link>
                                )}

                                {profile && profile.role !== 'pending' && (
                                    <NotificationBell userId={user.id} />
                                )}

                                <div className="flex items-center gap-3 pl-4 border-l border-slate-200">
                                    <Link to="/profile" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                                        <div className="w-9 h-9 rounded-full overflow-hidden border-2 border-slate-200 shrink-0">
                                            {avatarUrl ? (
                                                <img src={avatarUrl} alt="大頭貼" className="w-full h-full object-cover" />
                                            ) : (
                                                <PenguinAvatar />
                                            )}
                                        </div>
                                        <div className="flex flex-col items-start">
                                            <span className="text-sm font-bold text-slate-800 leading-tight max-w-[120px] truncate">
                                                {displayName}
                                            </span>
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none mt-0.5 ${
                                                profile?.role === 'admin' ? 'bg-indigo-50 text-indigo-600' :
                                                profile?.role === 'mentor' ? 'bg-teal-50 text-teal-600' :
                                                profile?.role === 'pending' ? 'bg-amber-50 text-amber-600' :
                                                'bg-blue-50 text-blue-600'
                                            }`}>
                                                {ROLE_LABELS[profile?.role] || profile?.role}
                                            </span>
                                        </div>
                                    </Link>
                                    <button
                                        onClick={signOut}
                                        className="p-2 text-slate-400 hover:text-red-500 transition-colors"
                                        title="登出"
                                    >
                                        <LogOut className="w-5 h-5" />
                                    </button>
                                </div>
                            </>
                        ) : (
                            <LoginForm />
                        )}
                    </nav>

                    {/* 手機版：通知 + 漢堡按鈕 */}
                    <div className="flex md:hidden items-center gap-2">
                        {user && profile && profile.role !== 'pending' && (
                            <NotificationBell userId={user.id} />
                        )}
                        <button
                            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                            className="p-2 text-slate-600 hover:text-blue-600"
                        >
                            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                        </button>
                    </div>
                </div>

                {/* 手機版展開選單 */}
                {mobileMenuOpen && (
                    <div className="md:hidden bg-white border-t border-slate-100 shadow-lg">
                        <div className="px-4 py-4 space-y-1">
                            {user ? (
                                <>
                                    {/* 使用者資訊 */}
                                    <Link to="/profile" className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 mb-3">
                                        <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-slate-200 shrink-0">
                                            {avatarUrl ? (
                                                <img src={avatarUrl} alt="大頭貼" className="w-full h-full object-cover" />
                                            ) : (
                                                <PenguinAvatar />
                                            )}
                                        </div>
                                        <div>
                                            <div className="font-bold text-slate-800 text-sm">{displayName}</div>
                                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                                profile?.role === 'admin' ? 'bg-indigo-50 text-indigo-600' :
                                                profile?.role === 'mentor' ? 'bg-teal-50 text-teal-600' :
                                                profile?.role === 'pending' ? 'bg-amber-50 text-amber-600' :
                                                'bg-blue-50 text-blue-600'
                                            }`}>
                                                {ROLE_LABELS[profile?.role] || profile?.role}
                                            </span>
                                        </div>
                                    </Link>

                                    {/* 導航連結 */}
                                    {profile && profile.role !== 'pending' ? (
                                        <Link to="/courses" className="flex items-center gap-3 px-3 py-3 text-slate-700 hover:bg-blue-50 hover:text-blue-600 rounded-xl font-medium text-sm">
                                            <BookOpen className="w-5 h-5" />
                                            我的課程
                                        </Link>
                                    ) : (
                                        <button
                                            onClick={() => { alert('權限尚未開啟，如資料已填寫完，請通知夢想一號管理員協助開啟權限'); setMobileMenuOpen(false); }}
                                            className="flex items-center gap-3 px-3 py-3 text-slate-400 rounded-xl font-medium text-sm w-full text-left"
                                        >
                                            <BookOpen className="w-5 h-5" />
                                            我的課程
                                        </button>
                                    )}
                                    <Link to="/profile" className="flex items-center gap-3 px-3 py-3 text-slate-700 hover:bg-blue-50 hover:text-blue-600 rounded-xl font-medium text-sm">
                                        <UserCircle className="w-5 h-5" />
                                        個人資料
                                    </Link>
                                    {profile && profile.role !== 'pending' && (
                                        <Link to="/my/salary" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-3 px-3 py-3 text-slate-700 hover:bg-blue-50 hover:text-blue-600 rounded-xl font-medium text-sm">
                                            <Wallet className="w-5 h-5" />
                                            我的薪資
                                        </Link>
                                    )}
                                    {(profile?.role === 'admin' || profile?.role === 'mentor') && (
                                        <Link to="/admin" onClick={() => setMobileMenuOpen(false)} className="flex items-center gap-3 px-3 py-3 text-slate-700 hover:bg-blue-50 hover:text-blue-600 rounded-xl font-medium text-sm">
                                            <LayoutDashboard className="w-5 h-5" />
                                            後台管理
                                        </Link>
                                    )}

                                    <div className="border-t border-slate-100 pt-2 mt-2">
                                        <button
                                            onClick={() => { signOut(); setMobileMenuOpen(false); }}
                                            className="flex items-center gap-3 px-3 py-3 text-red-500 hover:bg-red-50 rounded-xl font-medium text-sm w-full"
                                        >
                                            <LogOut className="w-5 h-5" />
                                            登出
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <MobileLoginForm />
                            )}
                        </div>
                    </div>
                )}
            </header>

            <ProfileCompleteGate />

            <main className="flex-1 max-w-7xl mx-auto w-full">
                {children}
            </main>

            <footer className="bg-white border-t border-slate-200 py-8">
                <div className="max-w-7xl mx-auto px-4 text-center text-slate-500 text-sm">
                    Copyright 2026 夢想一號文化教育股份有限公司, all rights reserved.
                </div>
            </footer>
        </div>
    );
};

const NOTIF_ICONS = {
    announcement: Megaphone,
    feedback: Star,
    like: ThumbsUp,
    contract: FileSignature,
};
const NOTIF_COLORS = {
    announcement: 'text-red-500 bg-red-50',
    feedback: 'text-amber-500 bg-amber-50',
    like: 'text-blue-500 bg-blue-50',
    contract: 'text-emerald-600 bg-emerald-50',
};

const NotificationBell = ({ userId }) => {
    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const panelRef = useRef(null);
    const navigate = useNavigate();

    useEffect(() => {
        fetchNotifications();
        const interval = setInterval(fetchNotifications, 30000);
        return () => clearInterval(interval);
    }, [userId]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        if (open) document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open]);

    const fetchNotifications = async () => {
        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(30);
        setNotifications(data || []);
        setUnreadCount((data || []).filter(n => !n.is_read).length);
    };

    const markAsRead = async (notif) => {
        if (!notif.is_read) {
            await supabase.from('notifications').update({ is_read: true }).eq('id', notif.id);
            setNotifications(prev => prev.map(n => n.id === notif.id ? { ...n, is_read: true } : n));
            setUnreadCount(prev => Math.max(0, prev - 1));
        }
        if (notif.link) {
            navigate(notif.link);
            setOpen(false);
        }
    };

    const markAllRead = async () => {
        const unreadIds = notifications.filter(n => !n.is_read).map(n => n.id);
        if (unreadIds.length === 0) return;
        await supabase.from('notifications').update({ is_read: true }).in('id', unreadIds);
        setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
        setUnreadCount(0);
    };

    const timeAgo = (ts) => {
        const diff = Date.now() - new Date(ts).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return '剛剛';
        if (mins < 60) return `${mins} 分鐘前`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs} 小時前`;
        const days = Math.floor(hrs / 24);
        if (days < 7) return `${days} 天前`;
        return new Date(ts).toLocaleDateString('zh-TW');
    };

    return (
        <div className="relative" ref={panelRef}>
            <button
                onClick={() => setOpen(!open)}
                className="relative p-2 text-slate-500 hover:text-blue-600 transition-colors"
            >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-black min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1">
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="absolute right-0 top-full mt-2 w-80 sm:w-96 bg-white rounded-2xl border border-slate-200 shadow-2xl z-50 overflow-hidden max-w-[calc(100vw-2rem)]">
                    <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
                        <h3 className="font-bold text-slate-900">通知</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={markAllRead}
                                className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
                            >
                                <CheckCheck className="w-3.5 h-3.5" />
                                全部已讀
                            </button>
                        )}
                    </div>
                    <div className="max-h-[400px] overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="py-12 text-center text-slate-400">
                                <Bell className="w-8 h-8 mx-auto mb-2 text-slate-200" />
                                <p className="text-sm">目前沒有通知</p>
                            </div>
                        ) : (
                            notifications.map(n => {
                                const Icon = NOTIF_ICONS[n.type] || Bell;
                                const colorCls = NOTIF_COLORS[n.type] || 'text-slate-500 bg-slate-50';
                                return (
                                    <button
                                        key={n.id}
                                        onClick={() => markAsRead(n)}
                                        className={`w-full text-left px-5 py-3.5 flex items-start gap-3 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 ${!n.is_read ? 'bg-blue-50/30' : ''}`}
                                    >
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${colorCls}`}>
                                            <Icon className="w-4 h-4" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className={`text-sm font-semibold ${!n.is_read ? 'text-slate-900' : 'text-slate-600'}`}>
                                                    {n.title}
                                                </span>
                                                {!n.is_read && (
                                                    <span className="w-2 h-2 bg-blue-500 rounded-full shrink-0" />
                                                )}
                                            </div>
                                            {n.body && (
                                                <p className="text-xs text-slate-500 mt-0.5 line-clamp-1">{n.body}</p>
                                            )}
                                            <span className="text-[11px] text-slate-400 mt-1 block">{timeAgo(n.created_at)}</span>
                                        </div>
                                    </button>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

const GoogleIcon = () => (
    <svg viewBox="0 0 24 24" className="w-4 h-4" xmlns="http://www.w3.org/2000/svg">
        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
);

const LoginForm = () => {
    const { signInWithGoogle } = useAuth();

    return (
        <div className="flex items-center gap-3">
            <button
                onClick={signInWithGoogle}
                className="flex items-center gap-2 px-5 py-2 border border-slate-300 rounded-lg hover:bg-slate-50 hover:shadow-sm transition-all text-sm font-medium text-slate-700"
            >
                <GoogleIcon />
                使用 Google 登入
            </button>
            <Link
                to="/dev-login"
                className="text-xs text-slate-400 hover:text-amber-600 underline decoration-dotted underline-offset-4"
                title="Google OAuth 串接前的臨時 email 登入"
            >
                臨時登入
            </Link>
        </div>
    );
};

const MobileLoginForm = () => {
    const { signInWithGoogle } = useAuth();

    return (
        <div className="space-y-3">
            <div className="text-sm font-bold text-slate-700 mb-1">登入帳號</div>
            <button
                type="button"
                onClick={signInWithGoogle}
                className="w-full flex items-center justify-center gap-2.5 px-4 py-3 border border-slate-300 rounded-xl hover:bg-slate-50 transition-colors text-sm font-medium text-slate-700 bg-white"
            >
                <GoogleIcon />
                使用 Google 帳號登入
            </button>
            <p className="text-center text-xs text-slate-400">首次登入即自動完成註冊</p>
            <Link
                to="/dev-login"
                className="block text-center text-xs text-slate-400 hover:text-amber-600 underline decoration-dotted underline-offset-4 pt-1"
            >
                臨時 email 登入(Google OAuth 串接前)
            </Link>
        </div>
    );
};

export default Layout;
