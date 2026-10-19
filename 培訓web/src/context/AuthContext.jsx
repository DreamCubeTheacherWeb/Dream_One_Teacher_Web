import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';
import { toFetchableExternalImageUrl } from '../lib/profileCompletion';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const AuthContext = createContext({});

const clearLegacyProfileDrafts = () => {
    try {
        Object.keys(localStorage).forEach((key) => {
            if (key.startsWith('profile_draft_')) {
                localStorage.removeItem(key);
            }
        });
    } catch { /* localStorage 可能被瀏覽器停用 */ }
};

// 用原生 fetch 查 PostgREST，完全繞開 Supabase SDK 的 AbortController
// strict：非 2xx（5xx、逾時閘道等）改丟錯而不是回 null，讓呼叫端分得出「查無此列」與「查詢失敗」
async function rawQuery(table, params, accessToken, { strict = false } = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${accessToken || SUPABASE_KEY}`,
            Accept: 'application/json',
        },
    });
    if (!res.ok) {
        if (strict) throw new Error(`${table} 查詢失敗（HTTP ${res.status}）`);
        return null;
    }
    return res.json();
}

const PROFILE_LOAD_RETRIES = 2;
const PROFILE_RETRY_DELAY_MS = 1000;
const PROFILE_LOAD_ERROR = '帳號資料載入失敗，請重新整理';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 查 public.users 自己的那一列。只有 2xx 才算有答案：空陣列＝確定查無此列（才可走新使用者流程）；
// 5xx、逾時、斷線一律重試 PROFILE_LOAD_RETRIES 次（間隔約 1 秒），仍失敗就丟錯，
// 絕不能把「查不到答案」當成「沒有這個帳號」而捏造 pending（會把已存在的老師／管理員導去 /pending）。
async function queryUserRows(userId) {
    let lastError;
    for (let attempt = 0; attempt <= PROFILE_LOAD_RETRIES; attempt += 1) {
        if (attempt > 0) await sleep(PROFILE_RETRY_DELAY_MS);
        try {
            const token = (await supabase.auth.getSession()).data?.session?.access_token;
            // 沒有登入憑證時 rawQuery 會改用匿名金鑰查，必然回空陣列，不能當成「查無此帳號」
            if (!token) throw new Error('登入憑證暫時無法取得');
            const rows = await rawQuery('users', { select: '*', id: `eq.${userId}` }, token, { strict: true });
            if (!Array.isArray(rows)) throw new Error('users 查詢回應格式不符');
            return rows;
        } catch (err) {
            lastError = err;
            console.warn(`users 查詢失敗（第 ${attempt + 1} 次）：`, err.message);
        }
    }
    throw lastError;
}

const ProfileLoadError = ({ message, onRetry, onSignOut }) => (
    <div className="min-h-screen flex items-center justify-center p-6 bg-bauhaus-cream">
        <div role="alert" className="bh-card max-w-md w-full p-6 sm:p-8 text-center">
            <h1 className="text-xl font-black text-bauhaus-black mb-2">{message}</h1>
            <p className="text-sm font-medium text-bauhaus-black/60 mb-6">
                可能是網路或伺服器暫時忙碌，您的帳號資料沒有任何變動。請按「重試」，若持續失敗再稍後回來。
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <button type="button" onClick={onRetry} className="bh-btn bh-btn-blue px-5 py-3 text-sm">重試</button>
                <button type="button" onClick={onSignOut} className="bh-btn bh-btn-outline px-5 py-3 text-sm">登出</button>
            </div>
        </div>
    </div>
);

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [profile, setProfile] = useState(null);
    const [instructorProfile, setInstructorProfile] = useState(null);
    const [avatarUrl, setAvatarUrl] = useState(null);
    const [claimState, setClaimState] = useState(null);
    const [accessError, setAccessError] = useState(null);
    const [profileError, setProfileError] = useState(null);
    const [loading, setLoading] = useState(true);
    const fetchingRef = useRef(false);

    const fetchProfile = useCallback(async (authUser) => {
        if (!authUser?.id) { setLoading(false); return; }
        if (fetchingRef.current) return;
        fetchingRef.current = true;
        let profileLoaded = false;

        try {
            const token = (await supabase.auth.getSession()).data?.session?.access_token;

            // 1. 查 public.users（用原生 fetch，不被 Supabase abort）。
            // 查詢失敗時 queryUserRows 會重試後丟錯，這裡不捏造 pending，直接進 catch 顯示可重試的錯誤。
            setProfileError(null);
            const rows = await queryUserRows(authUser.id);

            let profileData = rows[0] || null;

            if (!profileData) {
                const { error: createErr } = await supabase.from('users').insert({
                    id: authUser.id,
                    name: authUser.user_metadata?.full_name || null,
                    email: authUser.email,
                    role: 'pending',
                });
                if (createErr && !createErr.message?.includes('duplicate')) {
                    console.warn('Failed to create user entry:', createErr.message);
                }
                profileData = {
                    id: authUser.id,
                    name: authUser.user_metadata?.full_name || null,
                    email: authUser.email,
                    role: 'pending',
                };
            }

            // 唯一決策點：既有主檔第一次登入時認領；之後呼叫只回傳既有認領結果。
            const { data: claimResult, error: claimError } = await supabase.rpc('claim_my_precreated_instructor');
            if (claimError) {
                console.warn('Instructor profile claim failed:', claimError.message);
                setClaimState({ status: 'error', reason: claimError.message });
            } else {
                setClaimState(claimResult || { status: 'new' });
            }

            if (claimResult?.status === 'blocked') {
                setAccessError(claimResult.reason || '此講師帳號已停止使用，如有疑問請聯繫管理員。');
                await supabase.auth.signOut();
                return;
            }

            if (claimResult?.status === 'claimed') {
                const refreshed = await queryUserRows(authUser.id);
                if (refreshed[0]) profileData = refreshed[0];
            }

            setProfile(profileData);
            profileLoaded = true;

            // 2. 查 instructors（顯示名稱、頭貼）
            const instrRows = await rawQuery('instructors', {
                select: 'full_name,nickname,photo_path,photo_external_url',
                user_id: `eq.${authUser.id}`,
            }, token);
            const instrData = instrRows?.[0] || null;

            if (instrData) {
                setInstructorProfile(instrData);
                let nextAvatarUrl = toFetchableExternalImageUrl(instrData.photo_external_url);
                if (instrData.photo_path) {
                    const { data: urlData } = await supabase.storage
                        .from('instructor_uploads')
                        .createSignedUrl(instrData.photo_path, 7200);
                    nextAvatarUrl = urlData?.signedUrl || nextAvatarUrl;
                }
                setAvatarUrl(nextAvatarUrl);
            } else {
                setInstructorProfile(null);
                setAvatarUrl(null);
            }
        } catch (err) {
            console.error('fetchProfile error:', err);
            if (!profileLoaded) setProfileError(PROFILE_LOAD_ERROR);
        } finally {
            fetchingRef.current = false;
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        let isMounted = true;

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            if (!isMounted) return;

            if (_event === 'SIGNED_OUT') {
                clearLegacyProfileDrafts();
                setUser(null);
                setProfile(null);
                setInstructorProfile(null);
                setAvatarUrl(null);
                setClaimState(null);
                setProfileError(null);
                setLoading(false);
                return;
            }

            if (_event === 'TOKEN_REFRESHED' && session?.user) {
                setUser(session.user);
                return;
            }

            // INITIAL_SESSION / SIGNED_IN：只設 user，profile 交給下面的 useEffect
            if (session?.user) {
                clearLegacyProfileDrafts();
                setAccessError(null);
                setUser(session.user);
            } else if (_event === 'INITIAL_SESSION') {
                setLoading(false);
            }
        });

        return () => { isMounted = false; subscription.unsubscribe(); };
    }, []);

    // 獨立的 useEffect：user 有值時才去查 profile（脫離 onAuthStateChange 的生命週期）
    useEffect(() => {
        if (user && !profile && !fetchingRef.current) {
            fetchProfile(user);
        }
    }, [user, profile, fetchProfile]);

    const retryProfile = useCallback(() => {
        if (!user) return Promise.resolve();
        setProfileError(null);
        setLoading(true);
        fetchingRef.current = false;
        return fetchProfile(user);
    }, [user, fetchProfile]);

    const signInWithGoogle = async () => {
        setAccessError(null);
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin },
        });
        if (error) throw error;
    };

    const signOut = async () => {
        try {
            clearLegacyProfileDrafts();
            await supabase.auth.signOut();
            window.location.href = '/';
        } catch (err) {
            console.error('Logout error:', err);
            window.location.href = '/';
        }
    };

    return (
        <AuthContext.Provider value={{
            user, profile, instructorProfile, avatarUrl,
            claimState, accessError, profileError,
            signInWithGoogle, signOut,
            refreshProfile: () => { fetchingRef.current = false; return fetchProfile(user); },
            loading,
        }}>
            {user && !profile && profileError && !loading
                ? <ProfileLoadError message={profileError} onRetry={retryProfile} onSignOut={signOut} />
                : children}
        </AuthContext.Provider>
    );
};

// Context 與 hook 必須共用同一個模組；這是既有架構，非 Fast Refresh 邊界。
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
