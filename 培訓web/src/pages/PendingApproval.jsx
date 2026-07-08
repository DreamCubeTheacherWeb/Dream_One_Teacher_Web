import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { Clock, LogOut, RefreshCw } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';

const PendingApproval = () => {
    const { user, profile, signOut, refreshProfile } = useAuth();
    const navigate = useNavigate();
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        if (!user) return;
        const checkProfile = async () => {
            const { data } = await supabase
                .from('instructors')
                .select('id')
                .eq('user_id', user.id)
                .maybeSingle();
            if (!data) {
                navigate('/profile', { replace: true });
            } else {
                setChecking(false);
            }
        };
        checkProfile();
    }, [user, navigate]);

    if (!user) return <Navigate to="/" />;
    if (profile?.role && profile.role !== 'pending') return <Navigate to="/courses" />;
    if (checking) return <div className="p-12 text-center text-slate-500 text-lg">載入中...</div>;

    const handleRefresh = async () => {
        await refreshProfile(user.id);
    };

    return (
        <div className="min-h-[70vh] flex items-center justify-center p-8">
            <div className="max-w-md w-full text-center">
                <div className="w-20 h-20 bg-amber-50 rounded-full flex items-center justify-center mx-auto mb-6">
                    <Clock className="w-10 h-10 text-amber-500" />
                </div>

                <h1 className="text-2xl font-black text-slate-900 mb-3">帳號審核中</h1>
                <p className="text-slate-500 mb-2">
                    你的帳號已成功註冊並完成資料填寫，目前正在等待管理員審核。
                </p>
                <p className="text-slate-400 text-sm mb-8">
                    審核通過後即可瀏覽所有培訓課程內容。
                </p>

                <div className="bg-slate-50 rounded-2xl p-5 mb-8 text-left">
                    <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">帳號資訊</div>
                    <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                            <span className="text-slate-500">Email</span>
                            <span className="font-medium text-slate-700">{user.email}</span>
                        </div>
                        <div className="flex justify-between">
                            <span className="text-slate-500">狀態</span>
                            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 bg-amber-100 text-amber-700 rounded-full text-xs font-bold">
                                <span className="w-1.5 h-1.5 bg-amber-500 rounded-full animate-pulse" />
                                待審核
                            </span>
                        </div>
                    </div>
                </div>

                <div className="flex flex-wrap gap-3 justify-center">
                    <button
                        onClick={handleRefresh}
                        className="flex items-center gap-2 px-5 py-3 md:py-2.5 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-500/20"
                    >
                        <RefreshCw className="w-4 h-4" />
                        重新檢查狀態
                    </button>
                    <button
                        onClick={() => navigate('/profile')}
                        className="flex items-center gap-2 px-5 py-3 md:py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all"
                    >
                        編輯個人資料
                    </button>
                    <button
                        onClick={signOut}
                        className="flex items-center gap-2 px-5 py-3 md:py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl font-bold hover:bg-slate-50 transition-all"
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
