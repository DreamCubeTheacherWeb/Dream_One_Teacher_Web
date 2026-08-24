import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

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
async function rawQuery(table, params, accessToken) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${accessToken || SUPABASE_KEY}`,
            Accept: 'application/json',
        },
    });
    if (!res.ok) return null;
    return res.json();
}

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [profile, setProfile] = useState(null);
    const [instructorProfile, setInstructorProfile] = useState(null);
    const [avatarUrl, setAvatarUrl] = useState(null);
    const [claimState, setClaimState] = useState(null);
    const [accessError, setAccessError] = useState(null);
    const [loading, setLoading] = useState(true);
    const fetchingRef = useRef(false);

    const fetchProfile = useCallback(async (authUser) => {
        if (!authUser?.id) { setLoading(false); return; }
        if (fetchingRef.current) return;
        fetchingRef.current = true;

        try {
            const token = (await supabase.auth.getSession()).data?.session?.access_token;

            // 1. 查 public.users（用原生 fetch，不被 Supabase abort）
            const rows = await rawQuery('users', {
                select: '*',
                id: `eq.${authUser.id}`,
            }, token);

            let profileData = rows?.[0] || null;

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
                const refreshed = await rawQuery('users', {
                    select: '*', id: `eq.${authUser.id}`,
                }, token);
                if (refreshed?.[0]) profileData = refreshed[0];
            }

            setProfile(profileData);

            // 2. 查 instructors（顯示名稱、頭貼）
            const instrRows = await rawQuery('instructors', {
                select: 'full_name,nickname,photo_path',
                user_id: `eq.${authUser.id}`,
            }, token);
            const instrData = instrRows?.[0] || null;

            if (instrData) {
                setInstructorProfile(instrData);
                if (instrData.photo_path) {
                    const { data: urlData } = await supabase.storage
                        .from('instructor_uploads')
                        .createSignedUrl(instrData.photo_path, 7200);
                    setAvatarUrl(urlData?.signedUrl || null);
                } else {
                    setAvatarUrl(null);
                }
            } else {
                setInstructorProfile(null);
                setAvatarUrl(null);
            }
        } catch (err) {
            console.error('fetchProfile error:', err);
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
            claimState, accessError,
            signInWithGoogle, signOut,
            refreshProfile: () => { fetchingRef.current = false; return fetchProfile(user); },
            loading,
        }}>
            {children}
        </AuthContext.Provider>
    );
};

// Context 與 hook 必須共用同一個模組；這是既有架構，非 Fast Refresh 邊界。
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = () => useContext(AuthContext);
