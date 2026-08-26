import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { ArrowLeft, Clock, LogOut, RefreshCw, ShieldCheck, UserCheck, UserPlus } from 'lucide-react';
import { Navigate, useNavigate } from 'react-router-dom';

const PendingApproval = () => {
    const { user, profile, signOut, refreshProfile, claimState } = useAuth();
    const navigate = useNavigate();
    const [checking, setChecking] = useState(true);
    const [hasInstructorProfile, setHasInstructorProfile] = useState(false);
    const [mode, setMode] = useState('choice');
    const [identityForm, setIdentityForm] = useState({
        fullName: profile?.name || user?.user_metadata?.full_name || '',
        phoneMobile: '',
        idLastFour: '',
    });
    const [claiming, setClaiming] = useState(false);
    const [claimMessage, setClaimMessage] = useState(null);

    useEffect(() => {
        if (!user) return;
        const checkProfile = async () => {
            const { data } = await supabase
                .from('instructors')
                .select('id')
                .eq('user_id', user.id)
                .maybeSingle();
            setHasInstructorProfile(Boolean(data));
            setChecking(false);
        };
        checkProfile();
    }, [user, claimState?.status]);

    if (!user) return <Navigate to="/" />;
    if (profile?.role && profile.role !== 'pending') return <Navigate to="/courses" />;
    if (checking) return <div className="p-12 text-center text-bauhaus-black/50 text-lg font-bold">載入中...</div>;

    const handleRefresh = async () => {
        await refreshProfile();
    };

    const handleExistingClaim = async (event) => {
        event.preventDefault();
        setClaimMessage(null);

        const fullName = identityForm.fullName.trim();
        const phoneMobile = identityForm.phoneMobile.replace(/\D/g, '');
        const idLastFour = identityForm.idLastFour.trim();

        if (!fullName || phoneMobile.length < 8 || !/^\d{4}$/.test(idLastFour)) {
            setClaimMessage({ type: 'error', text: '請輸入完整姓名、完整手機號碼與身分證末四碼。' });
            return;
        }

        setClaiming(true);
        const { data, error } = await supabase.rpc('claim_existing_instructor_by_identity', {
            provided_full_name: fullName,
            provided_phone_mobile: phoneMobile,
            provided_id_last_four: idLastFour,
        });

        if (error) {
            setClaimMessage({ type: 'error', text: '目前無法核對資料，請稍後再試或聯繫管理員。' });
            setClaiming(false);
            return;
        }

        if (data?.status === 'claimed') {
            setClaimMessage({ type: 'success', text: '身分核對完成，正在帶入你的講師資料…' });
            await refreshProfile();
            navigate('/profile', { replace: true });
            return;
        }

        const attemptsNote = Number.isInteger(data?.attempts_remaining)
            ? `（剩餘 ${data.attempts_remaining} 次）`
            : '';
        setClaimMessage({
            type: 'error',
            text: `${data?.reason || '資料核對未通過，請確認三項資料與原講師主檔一致。'}${attemptsNote}`,
        });
        setClaiming(false);
    };

    const showAccountTypeChoice = !hasInstructorProfile && claimState?.status === 'new';

    return (
        <div className="min-h-[70vh] flex items-center justify-center p-6 sm:p-8 relative overflow-hidden">
            <div className="absolute -top-10 -left-10 w-32 h-32 sm:w-48 sm:h-48 rounded-full bg-bauhaus-yellow/20" aria-hidden="true" />
            <div className="absolute bottom-0 right-0 w-40 h-40 sm:w-56 sm:h-56 bg-bauhaus-blue/10 rotate-45" aria-hidden="true" />

            <div className="max-w-lg w-full text-center relative">
                {showAccountTypeChoice ? (
                    <>
                        <div className="w-20 h-20 bg-bauhaus-blue border-2 border-bauhaus-black rounded-xl flex items-center justify-center mx-auto mb-6 shadow-hard">
                            <ShieldCheck className="w-10 h-10 text-white" />
                        </div>

                        <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-3 tracking-tight">
                            {mode === 'existing' ? '核對既有講師資料' : '請選擇你的講師身分'}
                        </h1>

                        {mode === 'choice' ? (
                            <>
                                <p className="text-bauhaus-black/70 mb-6 font-medium">
                                    Gmail 尚未對應到講師主檔，請依加入時間選擇後續流程。
                                </p>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
                                    <button
                                        type="button"
                                        onClick={() => navigate('/profile')}
                                        className="bh-card bg-bauhaus-yellow p-6 text-left hover:-translate-y-1 transition-transform"
                                    >
                                        <UserPlus className="w-8 h-8 mb-4" />
                                        <span className="block text-xl font-black mb-1">新進</span>
                                        <span className="block text-sm font-medium text-bauhaus-black/65">建立新的講師資料並送出審核</span>
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setIdentityForm((current) => ({
                                                ...current,
                                                fullName: current.fullName || profile?.name || user?.user_metadata?.full_name || '',
                                            }));
                                            setMode('existing');
                                        }}
                                        className="bh-card bg-white p-6 text-left hover:-translate-y-1 transition-transform"
                                    >
                                        <UserCheck className="w-8 h-8 mb-4 text-bauhaus-blue" />
                                        <span className="block text-xl font-black mb-1">非新進</span>
                                        <span className="block text-sm font-medium text-bauhaus-black/65">核對後直接帶入既有講師資料</span>
                                    </button>
                                </div>

                                <p className="text-sm font-bold text-bauhaus-black/60 bg-white/80 border border-bauhaus-black/20 rounded-lg px-4 py-3">
                                    8/25 後才加入講師群組的，請選「新進」。
                                </p>
                            </>
                        ) : (
                            <form onSubmit={handleExistingClaim} className="bg-white border-2 border-bauhaus-black rounded-2xl p-5 sm:p-6 text-left shadow-hard">
                                <p className="text-sm font-medium text-bauhaus-black/65 mb-5">
                                    請填寫原講師資料中的姓名、完整手機號碼及身分證末四碼。核對成功後會立即開通，不需等待審核。
                                </p>

                                <label className="bh-label block mb-2" htmlFor="claim-full-name">姓名</label>
                                <input
                                    id="claim-full-name"
                                    type="text"
                                    autoComplete="name"
                                    value={identityForm.fullName}
                                    onChange={(event) => setIdentityForm((current) => ({ ...current, fullName: event.target.value }))}
                                    className="bh-input mb-4"
                                    placeholder="請輸入原講師資料中的姓名"
                                    required
                                />

                                <label className="bh-label block mb-2" htmlFor="claim-phone">完整手機號碼</label>
                                <input
                                    id="claim-phone"
                                    type="tel"
                                    inputMode="tel"
                                    autoComplete="tel"
                                    value={identityForm.phoneMobile}
                                    onChange={(event) => setIdentityForm((current) => ({ ...current, phoneMobile: event.target.value }))}
                                    className="bh-input mb-4"
                                    placeholder="例：0912345678"
                                    required
                                />

                                <label className="bh-label block mb-2" htmlFor="claim-id-last-four">身分證末四碼</label>
                                <input
                                    id="claim-id-last-four"
                                    type="text"
                                    inputMode="numeric"
                                    autoComplete="off"
                                    maxLength={4}
                                    value={identityForm.idLastFour}
                                    onChange={(event) => setIdentityForm((current) => ({
                                        ...current,
                                        idLastFour: event.target.value.replace(/\D/g, '').slice(0, 4),
                                    }))}
                                    className="bh-input mb-2"
                                    placeholder="4 位數字"
                                    required
                                />
                                <p className="text-xs text-bauhaus-black/50 font-medium mb-4">資料僅用於本次身分核對，不會顯示其他講師資訊。</p>

                                {claimMessage && (
                                    <div
                                        role="status"
                                        className={`rounded-lg border-2 px-4 py-3 mb-4 text-sm font-bold ${
                                            claimMessage.type === 'success'
                                                ? 'bg-green-50 border-green-700 text-green-800'
                                                : 'bg-red-50 border-bauhaus-red text-bauhaus-red'
                                        }`}
                                    >
                                        {claimMessage.text}
                                    </div>
                                )}

                                <div className="flex flex-col-reverse sm:flex-row gap-3">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMode('choice');
                                            setClaimMessage(null);
                                        }}
                                        className="bh-btn bh-btn-outline px-5 py-3 text-sm sm:flex-1"
                                        disabled={claiming}
                                    >
                                        <ArrowLeft className="w-4 h-4" />
                                        返回
                                    </button>
                                    <button
                                        type="submit"
                                        className="bh-btn bh-btn-blue px-5 py-3 text-sm sm:flex-[2]"
                                        disabled={claiming}
                                    >
                                        <ShieldCheck className="w-4 h-4" />
                                        {claiming ? '核對中…' : '核對並帶入資料'}
                                    </button>
                                </div>
                            </form>
                        )}
                    </>
                ) : (
                    <>
                        <div className="w-20 h-20 bg-bauhaus-yellow border-2 border-bauhaus-black rounded-xl flex items-center justify-center mx-auto mb-6 shadow-hard">
                            <Clock className="w-10 h-10 text-bauhaus-black" />
                        </div>

                        <h1 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-3 tracking-tight">
                            {claimState?.status === 'conflict' ? '講師資料需要協助確認' : '帳號審核中'}
                        </h1>
                        <p className="text-bauhaus-black/70 mb-2 font-medium">
                            {claimState?.status === 'conflict'
                                ? '系統找到無法自動判定的既有資料，為避免新增重複主檔，請聯繫管理員處理。'
                                : '你的帳號已完成資料填寫，目前正在等待管理員審核。'}
                        </p>
                        <p className="text-bauhaus-black/50 text-sm mb-8 font-medium">
                            {claimState?.status === 'conflict'
                                ? claimState.reason
                                : '審核通過後即可瀏覽所有培訓課程內容。'}
                        </p>

                        <div className="bg-white border-2 border-bauhaus-black rounded-2xl p-5 mb-8 text-left shadow-hard">
                            <div className="bh-label mb-3">帳號資訊</div>
                            <div className="space-y-2 text-sm">
                                <div className="flex justify-between gap-4">
                                    <span className="text-bauhaus-black/50 font-medium">Email</span>
                                    <span className="font-bold text-bauhaus-black break-all text-right">{user.email}</span>
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
                    </>
                )}

                {(mode === 'choice' || !showAccountTypeChoice) && (
                    <div className="flex flex-wrap gap-3 justify-center mt-8">
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
                )}
            </div>
        </div>
    );
};

export default PendingApproval;
