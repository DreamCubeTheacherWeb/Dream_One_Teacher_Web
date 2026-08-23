import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { LogIn, LogOut, BookOpen, LayoutDashboard, UserCircle, Bell, Check, CheckCheck, Megaphone, Star, ThumbsUp, Menu, X, FileSignature, Trophy, Timer, LibraryBig } from 'lucide-react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import ProfileCompleteGate from './ProfileCompleteGate';
import { INSTRUCTOR_CONTRACTS_ENABLED } from '../lib/featureFlags';
import { resolveHttpUrl, TEACHING_MATERIALS_LINK } from '../lib/siteLinks';

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
    const [teachingMaterialsUrl, setTeachingMaterialsUrl] = useState(TEACHING_MATERIALS_LINK.url);
    const [profileComplete, setProfileComplete] = useState(null);

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
        if (loading || !user || !profile || !INSTRUCTOR_CONTRACTS_ENABLED || profile.role === 'pending') return;
        const key = `contract_reminder_${user.id}`;
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');

        (async () => {
            try {
                const { error } = await supabase.rpc('ensure_my_contract_reminder');
                if (error) throw error;
            } catch (err) {
                console.error('Contract reminder check failed:', err);
            }
        })();
    }, [loading, user, profile]);

    useEffect(() => {
        if (loading || !user || !profile || profile.role === 'pending') return undefined;

        let active = true;
        (async () => {
            const { data, error } = await supabase
                .from('site_links')
                .select('url')
                .eq('key', TEACHING_MATERIALS_LINK.key)
                .maybeSingle();

            if (!active) return;
            if (error) {
                console.error('讀取教材資源連結失敗，使用預設值：', error.message);
                return;
            }

            setTeachingMaterialsUrl(resolveHttpUrl(data?.url, TEACHING_MATERIALS_LINK.url));
        })();

        return () => { active = false; };
    }, [loading, user, profile]);

    // 路由切換時關閉手機選單
    useEffect(() => { setMobileMenuOpen(false); }, [location.pathname]);

    const displayName = instructorProfile?.nickname || instructorProfile?.full_name || profile?.name || user?.email?.split('@')[0] || '';

    // Bauhaus：目前頁面色塊指示（選中＝黑底白字，未選＝hover 變灰底）
    const isActivePath = (path) => location.pathname === path || location.pathname.startsWith(`${path}/`);
    const navLinkClass = (path) =>
        `flex items-center gap-1.5 px-3 py-2 text-sm font-bold uppercase tracking-wide rounded-lg transition-colors duration-200 ${
            isActivePath(path) ? 'bg-bauhaus-black text-white' : 'text-bauhaus-black hover:bg-bauhaus-muted'
        }`;
    const mobileNavLinkClass = (path) =>
        `flex items-center gap-3 px-3 py-3.5 font-bold uppercase tracking-wide text-sm rounded-lg transition-colors duration-200 ${
            isActivePath(path) ? 'bg-bauhaus-black text-white' : 'text-bauhaus-black hover:bg-bauhaus-muted'
        }`;
    const roleChipClass = (role) => {
        if (role === 'admin') return 'bh-chip bg-bauhaus-black text-white';
        if (role === 'mentor') return 'bh-chip bg-bauhaus-blue text-white';
        if (role === 'pending') return 'bh-chip bg-bauhaus-yellow text-bauhaus-black';
        return 'bh-chip bg-bauhaus-muted text-bauhaus-black';
    };

    return (
        <div className="min-h-screen flex flex-col overflow-x-hidden">
            <header className="bg-white border-b-4 border-bauhaus-black relative z-50">
                <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
                    <Link to="/" className="flex items-center gap-2 font-black text-xl text-bauhaus-black tracking-tight shrink-0 p-1 -m-1 min-h-[44px]">
                        <span className="hidden sm:flex items-center gap-1" aria-hidden="true">
                            <span className="w-4 h-4 rounded-full bg-bauhaus-red" />
                            <span className="w-4 h-4 bg-bauhaus-blue" />
                            <span className="w-4 h-4 bg-bauhaus-yellow" style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }} />
                        </span>
                        <img src="/logo.png" alt="夢想一號 Logo" className="w-9 h-9 object-contain" />
                        <span className="hidden sm:inline">講師資源站</span>
                    </Link>

                    {/* 桌面版導航 */}
                    <nav className="hidden md:flex items-center gap-1">
                        {user ? (
                            <>
                                {profile && profile.role !== 'pending' ? (
                                    <Link to="/courses" className={navLinkClass('/courses')}>
                                        <BookOpen className="w-4 h-4" />
                                        我的課程
                                    </Link>
                                ) : (
                                    <button
                                        onClick={() => alert('權限尚未開啟，如資料已填寫完，請通知夢想一號管理員協助開啟權限')}
                                        className="flex items-center gap-1.5 px-3 py-2 text-sm text-bauhaus-black/40 hover:text-bauhaus-black font-bold uppercase tracking-wide cursor-pointer"
                                    >
                                        <BookOpen className="w-4 h-4" />
                                        我的課程
                                    </button>
                                )}
                                {profile && profile.role !== 'pending' && (
                                    profileComplete === true ? (
                                        <a
                                            href={teachingMaterialsUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={navLinkClass('__teaching-materials__')}
                                            aria-label="教材資源（在新分頁開啟）"
                                        >
                                            <LibraryBig className="w-4 h-4" />
                                            教材資源
                                        </a>
                                    ) : (
                                        <button
                                            type="button"
                                            disabled
                                            aria-disabled="true"
                                            aria-label="教材資源（請先完成個人資料）"
                                            title="請先完成個人資料後才能開啟教材資源"
                                            className="flex items-center gap-1.5 px-3 py-2 text-sm text-bauhaus-black/40 font-bold uppercase tracking-wide cursor-not-allowed"
                                        >
                                            <LibraryBig className="w-4 h-4" />
                                            教材資源
                                        </button>
                                    )
                                )}
                                {profile && profile.role !== 'pending' && (
                                    <Link to="/leaderboard" className={navLinkClass('/leaderboard')}>
                                        <Trophy className="w-4 h-4" />
                                        排行榜
                                    </Link>
                                )}
                                {profile && profile.role !== 'pending' && (
                                    <Link to="/cube" className={navLinkClass('/cube')}>
                                        <Timer className="w-4 h-4" />
                                        方塊競速
                                    </Link>
                                )}
                                <Link to="/profile" className={navLinkClass('/profile')}>
                                    <UserCircle className="w-4 h-4" />
                                    個人資料
                                </Link>
                                {(profile?.role === 'admin' || profile?.role === 'mentor') && (
                                    <Link to="/admin" className={navLinkClass('/admin')}>
                                        <LayoutDashboard className="w-4 h-4" />
                                        後台管理
                                    </Link>
                                )}

                                {profile && profile.role !== 'pending' && (
                                    <NotificationBell userId={user.id} />
                                )}

                                <div className="flex items-center gap-3 pl-4 border-l-2 border-bauhaus-black">
                                    <Link to="/profile" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
                                        <div className="w-9 h-9 rounded-full overflow-hidden border-2 border-bauhaus-black shrink-0">
                                            {avatarUrl ? (
                                                <img src={avatarUrl} alt="大頭貼" className="w-full h-full object-cover" />
                                            ) : (
                                                <PenguinAvatar />
                                            )}
                                        </div>
                                        <div className="flex flex-col items-start gap-0.5">
                                            <span className="text-sm font-bold text-bauhaus-black leading-tight max-w-[120px] truncate">
                                                {displayName}
                                            </span>
                                            <span className={`${roleChipClass(profile?.role)} !px-1.5 !py-0 text-[9px] leading-none`}>
                                                {ROLE_LABELS[profile?.role] || profile?.role}
                                            </span>
                                        </div>
                                    </Link>
                                    <button
                                        onClick={signOut}
                                        className="p-2 rounded-xl border-2 border-bauhaus-black text-bauhaus-black hover:bg-bauhaus-red hover:text-white transition-colors duration-200"
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
                            className="p-3 rounded-xl border-2 border-bauhaus-black text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200"
                        >
                            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
                        </button>
                    </div>
                </div>

                {/* 手機版展開選單 */}
                {mobileMenuOpen && (
                    <div className="md:hidden bg-white border-t-4 border-bauhaus-black rounded-b-2xl overflow-hidden">
                        <div className="px-4 py-4 space-y-1">
                            {user ? (
                                <>
                                    {/* 使用者資訊 */}
                                    <Link to="/profile" className="flex items-center gap-3 p-3 rounded-xl border-2 border-bauhaus-black bg-bauhaus-muted mb-3">
                                        <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-bauhaus-black shrink-0">
                                            {avatarUrl ? (
                                                <img src={avatarUrl} alt="大頭貼" className="w-full h-full object-cover" />
                                            ) : (
                                                <PenguinAvatar />
                                            )}
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <div className="font-bold text-bauhaus-black text-sm">{displayName}</div>
                                            <span className={`${roleChipClass(profile?.role)} !px-1.5 !py-0 text-[9px] leading-none self-start`}>
                                                {ROLE_LABELS[profile?.role] || profile?.role}
                                            </span>
                                        </div>
                                    </Link>

                                    {/* 導航連結 */}
                                    {profile && profile.role !== 'pending' ? (
                                        <Link to="/courses" className={mobileNavLinkClass('/courses')}>
                                            <BookOpen className="w-5 h-5" />
                                            我的課程
                                        </Link>
                                    ) : (
                                        <button
                                            onClick={() => { alert('權限尚未開啟，如資料已填寫完，請通知夢想一號管理員協助開啟權限'); setMobileMenuOpen(false); }}
                                            className="flex items-center gap-3 px-3 py-3.5 text-bauhaus-black/40 font-bold uppercase tracking-wide text-sm w-full text-left"
                                        >
                                            <BookOpen className="w-5 h-5" />
                                            我的課程
                                        </button>
                                    )}
                                    {profile && profile.role !== 'pending' && (
                                        profileComplete === true ? (
                                            <a
                                                href={teachingMaterialsUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                onClick={() => setMobileMenuOpen(false)}
                                                className={mobileNavLinkClass('__teaching-materials__')}
                                                aria-label="教材資源（在新分頁開啟）"
                                            >
                                                <LibraryBig className="w-5 h-5" />
                                                教材資源
                                            </a>
                                        ) : (
                                            <button
                                                type="button"
                                                disabled
                                                aria-disabled="true"
                                                aria-label="教材資源（請先完成個人資料）"
                                                title="請先完成個人資料後才能開啟教材資源"
                                                className="flex items-center gap-3 px-3 py-3.5 text-bauhaus-black/40 font-bold uppercase tracking-wide text-sm w-full text-left rounded-lg cursor-not-allowed"
                                            >
                                                <LibraryBig className="w-5 h-5" />
                                                教材資源
                                            </button>
                                        )
                                    )}
                                    {profile && profile.role !== 'pending' && (
                                        <Link to="/leaderboard" onClick={() => setMobileMenuOpen(false)} className={mobileNavLinkClass('/leaderboard')}>
                                            <Trophy className="w-5 h-5" />
                                            排行榜
                                        </Link>
                                    )}
                                    {profile && profile.role !== 'pending' && (
                                        <Link to="/cube" onClick={() => setMobileMenuOpen(false)} className={mobileNavLinkClass('/cube')}>
                                            <Timer className="w-5 h-5" />
                                            方塊競速
                                        </Link>
                                    )}
                                    <Link to="/profile" className={mobileNavLinkClass('/profile')}>
                                        <UserCircle className="w-5 h-5" />
                                        個人資料
                                    </Link>
                                    {(profile?.role === 'admin' || profile?.role === 'mentor') && (
                                        <Link to="/admin" onClick={() => setMobileMenuOpen(false)} className={mobileNavLinkClass('/admin')}>
                                            <LayoutDashboard className="w-5 h-5" />
                                            後台管理
                                        </Link>
                                    )}

                                    <div className="border-t-2 border-bauhaus-black pt-2 mt-2">
                                        <button
                                            onClick={() => { signOut(); setMobileMenuOpen(false); }}
                                            className="flex items-center gap-3 px-3 py-3.5 rounded-lg text-white bg-bauhaus-red hover:bg-bauhaus-red/90 font-bold uppercase tracking-wide text-sm w-full transition-colors duration-200"
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

            <ProfileCompleteGate onCompletionChange={setProfileComplete} />

            <main className="flex-1 max-w-7xl mx-auto w-full">
                {children}
            </main>

            <footer className="bg-bauhaus-black text-white">
                <div className="flex h-1.5 sm:h-2" aria-hidden="true">
                    <div className="flex-1 bg-bauhaus-red" />
                    <div className="flex-1 bg-bauhaus-blue" />
                    <div className="flex-1 bg-bauhaus-yellow" />
                </div>
                <div className="py-8">
                    <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-white/60 text-sm font-medium">
                        <p className="text-center sm:text-left">
                            Copyright 2026 夢想一號文化教育股份有限公司, all rights reserved.
                        </p>
                        <nav aria-label="法律資訊" className="flex items-center gap-1">
                            <Link
                                to="/privacy"
                                className="inline-flex items-center min-h-[44px] px-3 py-2 rounded-lg font-bold text-white/80 hover:text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-bauhaus-yellow"
                            >
                                隱私權政策
                            </Link>
                            <span aria-hidden="true" className="text-white/30">/</span>
                            <Link
                                to="/terms"
                                className="inline-flex items-center min-h-[44px] px-3 py-2 rounded-lg font-bold text-white/80 hover:text-white hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-bauhaus-yellow"
                            >
                                服務條款
                            </Link>
                        </nav>
                    </div>
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
    announcement: 'text-white bg-bauhaus-red',
    feedback: 'text-bauhaus-black bg-bauhaus-yellow',
    like: 'text-white bg-bauhaus-blue',
    contract: 'text-bauhaus-black bg-bauhaus-yellow',
};

const NotificationBell = ({ userId }) => {
    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [clockNow, setClockNow] = useState(0);
    const panelRef = useRef(null);
    const navigate = useNavigate();

    const fetchNotifications = useCallback(async () => {
        const { data } = await supabase
            .from('notifications')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .limit(30);
        const visibleNotifications = (data || []).filter(
            n => INSTRUCTOR_CONTRACTS_ENABLED || n.type !== 'contract'
        );
        setNotifications(visibleNotifications);
        setUnreadCount(visibleNotifications.filter(n => !n.is_read).length);
        setClockNow(Date.now());
    }, [userId]);

    useEffect(() => {
        const initialFrame = window.requestAnimationFrame(fetchNotifications);
        const interval = setInterval(fetchNotifications, 30000);
        return () => {
            window.cancelAnimationFrame(initialFrame);
            clearInterval(interval);
        };
    }, [fetchNotifications]);

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (panelRef.current && !panelRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        if (open) document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [open]);

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
        const diff = clockNow - new Date(ts).getTime();
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
                className="relative p-3 md:p-2 rounded-xl border-2 border-bauhaus-black text-bauhaus-black hover:bg-bauhaus-muted transition-colors duration-200"
            >
                <Bell className="w-5 h-5" />
                {unreadCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-bauhaus-red text-white text-[10px] font-black min-w-[18px] h-[18px] flex items-center justify-center px-1 rounded-full border-2 border-white">
                        {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div className="fixed left-3 right-3 top-[4.5rem] md:absolute md:left-auto md:right-0 md:top-full md:mt-2 md:w-96 md:max-w-[calc(100vw-2rem)] bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard-lg z-50 overflow-hidden">
                    <div className="px-5 py-4 bg-bauhaus-black text-white flex items-center justify-between">
                        <h3 className="font-black uppercase tracking-wide text-sm">通知</h3>
                        {unreadCount > 0 && (
                            <button
                                onClick={markAllRead}
                                className="text-xs text-white/80 hover:text-white font-bold flex items-center gap-1 uppercase tracking-wide"
                            >
                                <CheckCheck className="w-3.5 h-3.5" />
                                全部已讀
                            </button>
                        )}
                    </div>
                    <div className="max-h-[400px] overflow-y-auto">
                        {notifications.length === 0 ? (
                            <div className="py-12 text-center text-bauhaus-black/40">
                                <Bell className="w-8 h-8 mx-auto mb-2 text-bauhaus-black/20" />
                                <p className="text-sm font-medium">目前沒有通知</p>
                            </div>
                        ) : (
                            notifications.map(n => {
                                const Icon = NOTIF_ICONS[n.type] || Bell;
                                const colorCls = NOTIF_COLORS[n.type] || 'text-bauhaus-black bg-bauhaus-muted';
                                return (
                                    <button
                                        key={n.id}
                                        onClick={() => markAsRead(n)}
                                        className={`w-full text-left px-5 py-3.5 flex items-start gap-3 hover:bg-bauhaus-muted transition-colors duration-200 border-b-2 border-bauhaus-black/10 last:border-0 ${!n.is_read ? 'bg-bauhaus-cream' : ''}`}
                                    >
                                        <div className={`w-8 h-8 flex items-center justify-center shrink-0 mt-0.5 rounded-lg border-2 border-bauhaus-black ${colorCls}`}>
                                            <Icon className="w-4 h-4" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className={`text-sm font-bold ${!n.is_read ? 'text-bauhaus-black' : 'text-bauhaus-black/60'}`}>
                                                    {n.title}
                                                </span>
                                                {!n.is_read && (
                                                    <span className="w-2 h-2 bg-bauhaus-red rounded-full shrink-0" />
                                                )}
                                            </div>
                                            {n.body && (
                                                <p className="text-xs text-bauhaus-black/60 mt-0.5 line-clamp-1">{n.body}</p>
                                            )}
                                            <span className="text-[11px] text-bauhaus-black/40 mt-1 block">{timeAgo(n.created_at)}</span>
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
        <div className="flex items-center">
            <button
                onClick={signInWithGoogle}
                className="bh-btn bh-btn-outline px-5 py-2 text-sm"
            >
                <GoogleIcon />
                使用 Google 登入
            </button>
        </div>
    );
};

const MobileLoginForm = () => {
    const { signInWithGoogle } = useAuth();

    return (
        <div className="space-y-3">
            <div className="bh-label mb-1">登入帳號</div>
            <button
                type="button"
                onClick={signInWithGoogle}
                className="bh-btn bh-btn-outline w-full px-4 py-3 text-sm"
            >
                <GoogleIcon />
                使用 Google 帳號登入
            </button>
            <p className="text-center text-xs text-bauhaus-black/40">請使用後台建檔的相同 Email 登入</p>
        </div>
    );
};

export default Layout;
