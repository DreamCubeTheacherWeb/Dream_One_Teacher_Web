import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { Clock, LogOut, RefreshCw } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';

const PendingApproval = () => {
    const { user, profile, signOut, refreshProfile, claimState } = useAuth();
    const navigate = useNavigate();
    const [checking, setChecking] = useState(true);
    const [hasInstructorProfile, setHasInstructorProfile] = useState(false);

    useEffect(() => {
        if (!user) return;
        const checkProfile = async () => {
            const { data } = await supabase
                .from('instructors')
                .select('id')
                .eq('user_id', user.id)
                .maybeSingle();
            setHasInstructorProfile(Boolean(data));
            if (!data && claimState?.status === 'new') {
                navigate('/profile', { replace: true });
            } else {
                setChecking(false);
            }
        };
        checkProfile();
    }, [user, navigate, claimState?.status]);

    if (!user) return <Navigate to="/" />;
    if (profile?.role && profile.role !== 'pending') return <Navigate to="/courses" />;
    if (checking) return <div className="p-12 text-center text-bauhaus-black/50 text-lg font-bold">載入中...</div>;

    const handleRefresh = async () => {
        await refreshProfile(user.id);
    };

    return (
        <div className="min-h-[70vh] flex items-center justify-center p-8 relative overflow-hidden">
            <div className="absolute -top-10 -left-10 w-32 h-32 sm:w-48 sm:h-48 rounded-full bg-bauhaus-yellow/20" aria-hidden="true" />
            <div className="absolute bottom-0 right-0 w-40 h-40 sm:w-56 sm:h-56 bg-bauhaus-blue/10 rotate-45" aria-hidden="true" />

            <div className="max-w-md w-full text-center relative">
                <div className="w-20 h-20 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl flex items-center justify-center mx-auto mb-6 shadow-hard">
                    <Clock className="w-10 h-10 text-bauhaus-black" />
                </div>

                <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-3 tracking-tight">
                    {claimState?.status === 'conflict' ? '講師資料需要協助確認' : '帳號審核中'}
                </h1>
                <p className="text-bauhaus-black/70 mb-2 font-medium">
                    {claimState?.status === 'conflict'
                        ? '系統找到無法自動判定的既有資料，為避免新增重複主檔，請聯繫管理員處理。'
                        : '你的帳號已成功註冊並完成資料填寫，目前正在等待管理員審核。'}
                </p>
                <p className="text-bauhaus-black/50 text-sm mb-8 font-medium">
                    {claimState?.status === 'conflict'
                        ? claimState.reason
                        : '審核通過後即可瀏覽所有培訓課程內容。'}
                </p>

                <div className="bg-white border-2 border-bauhaus-black rounded-2xl p-5 mb-8 text-left shadow-hard">
                    <div className="bh-label mb-3">帳號資訊</div>
                    <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                            <span className="text-bauhaus-black/50 font-medium">Email</span>
                            <span className="font-bold text-bauhaus-black">{user.email}</span>
                        </div>
                        <div className="flex justify-between items-center">
                            <span className="text-bauhaus-black/50 font-medium">狀態</span>
                            <span className="bh-chip bg-bauhaus-yellow text-bauhaus-black">
                                <span className="w-1.5 h-1.5 bg-bauhaus-black rounded-full animate-pulse" />
                                {claimState?.status === 'conflict' ? '資料衝突' : '待審核'}
                            </span>
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap gap-3 justify-center">
                    <button
                        onClick={handleRefresh}
                        className="bh-btn bh-btn-blue px-5 py-3 md:py-2.5 text-sm"
                    >
                        <RefreshCw className="w-4 h-4" />
                        重新檢查狀態
                    </button>
                    {hasInstructorProfile && claimState?.status !== 'conflict' && (
                        <button
                            onClick={() => navigate('/profile')}
                            className="bh-btn bh-btn-outline px-5 py-3 md:py-2.5 text-sm"
                        >
                            編輯個人資料
                        </button>
                    )}
                    <button
                        onClick={signOut}
                        className="bh-btn bh-btn-outline px-5 py-3 md:py-2.5 text-sm"
                    >
                        <LogOut className="w-4 h-4" />
                        登出
                    </button>
                </div>
            </div>
        </div>
    );
};

export default PendingApproval;
