import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { supabase } from '../lib/supabaseClient';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

const AuthContext = createContext({});

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

            if (profileData) {
                // 如果 role 還是 pending,先試 teacher_invites,再試以同 email 自動綁 instructors
                if (profileData.role === 'pending') {
                    const invites = await rawQuery('teacher_invites', {
                        select: 'role',
                        email: `eq.${profileData.email}`,
                    }, token);
                    const invite = invites?.[0];
                    if (invite?.role && invite.role !== 'pending') {
                        await supabase.from('users').update({ role: invite.role }).eq('id', authUser.id);
                        await supabase.from('teacher_invites').delete().eq('email', profileData.email);
                        profileData = { ...profileData, role: invite.role };
                    } else {
                        // Fallback:DB trigger 沒接到時,前端再用 RPC 試一次「email 自動 link」
                        // 函式內部會檢查 auth.uid() = my user_id,只綁同 email 且 user_id IS NULL 的列
                        const { data: linkedId } = await supabase.rpc('link_my_instructor_by_email');
                        if (linkedId) {
                            const refreshed = await rawQuery('users', {
                                select: '*', id: `eq.${authUser.id}`,
                            }, token);
                            if (refreshed?.[0]) profileData = refreshed[0];
                        }
                    }
                }
                setProfile(profileData);
            } else {
                // 沒有 profile,先試 teacher_invites
                const email = authUser.email;
                let createdProfile = null;

                if (email) {
                    const invites = await rawQuery('teacher_invites', {
                        select: '*',
                        email: `eq.${email}`,
                    }, token);
                    const invite = invites?.[0];

                    if (invite) {
                        const { error: insertErr } = await supabase.from('users').insert({
                            id: authUser.id,
                            name: invite.name || authUser.user_metadata?.full_name,
                            email,
                            role: invite.role,
                        });
                        if (!insertErr) {
                            await supabase.from('teacher_invites').delete().eq('email', email);
                            createdProfile = { id: authUser.id, name: invite.name, email, role: invite.role };
                        }
                    }
                }

                if (!createdProfile) {
                    // 建立 pending 用戶
                    const { error: createErr } = await supabase.from('users').insert({
                        id: authUser.id,
                        name: authUser.user_metadata?.full_name || null,
                        email: authUser.email,
                        role: 'pending',
                    });
                    if (createErr && !createErr.message?.includes('duplicate')) {
                        console.warn('Failed to create user entry:', createErr.message);
                    }

                    // 建完 users 列後,試以同 email 自動 link instructors
                    // 若成功 link,RPC 會把 role 升為 teacher,refetch 一次拿到正確 role
                    const { data: linkedId } = await supabase.rpc('link_my_instructor_by_email');
                    if (linkedId) {
                        const refreshed = await rawQuery('users', {
                            select: '*', id: `eq.${authUser.id}`,
                        }, token);
                        if (refreshed?.[0]) createdProfile = refreshed[0];
                    }

                    if (!createdProfile) {
                        createdProfile = { id: authUser.id, email: authUser.email, role: 'pending' };
                    }
                }

                setProfile(createdProfile);
            }

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
                setUser(null);
                setProfile(null);
                setInstructorProfile(null);
                setAvatarUrl(null);
                setLoading(false);
                return;
            }

            if (_event === 'TOKEN_REFRESHED' && session?.user) {
                setUser(session.user);
                return;
            }

            // INITIAL_SESSION / SIGNED_IN：只設 user，profile 交給下面的 useEffect
            if (session?.user) {
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
        const { error } = await supabase.auth.signInWithOAuth({
            provider: 'google',
            options: { redirectTo: window.location.origin },
        });
        if (error) throw error;
    };

    const signUpWithEmail = async (email, password, name) => {
        const { data, error } = await supabase.auth.signUp({
            email, password,
            options: { data: { full_name: name } },
        });
        if (error) throw error;
        return data;
    };

    const signInWithEmail = async (email, password) => {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
    };

    const signOut = async () => {
        try {
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
            signInWithGoogle, signUpWithEmail, signInWithEmail, signOut,
            refreshProfile: () => { fetchingRef.current = false; return fetchProfile(user); },
            loading,
        }}>
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
