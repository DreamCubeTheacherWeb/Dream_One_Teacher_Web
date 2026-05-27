import { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Mail, Lock, User, LogIn, UserPlus, AlertTriangle } from 'lucide-react';

const DevLogin = () => {
    const { user, signInWithEmail, signUpWithEmail } = useAuth();
    const navigate = useNavigate();
    const [mode, setMode] = useState('signin');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [info, setInfo] = useState('');

    if (user) return <Navigate to="/" replace />;

    const onSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setInfo('');
        setBusy(true);
        try {
            if (mode === 'signin') {
                await signInWithEmail(email.trim(), password);
                navigate('/', { replace: true });
            } else {
                await signUpWithEmail(email.trim(), password, name.trim());
                setInfo('註冊成功!如果信箱需要驗證,請至信箱完成驗證後再回來登入。');
                setMode('signin');
            }
        } catch (err) {
            setError(err?.message || '操作失敗,請再試一次');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950 px-4 py-12">
            <div className="w-full max-w-md">
                <div className="bg-white rounded-3xl shadow-2xl p-8">
                    <div className="flex items-center gap-2 mb-2 text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-xs font-bold">
                        <AlertTriangle className="w-4 h-4" />
                        臨時登入 — Google OAuth 串接前使用
                    </div>

                    <h1 className="text-2xl font-black text-slate-900 mt-5 mb-1">
                        {mode === 'signin' ? '登入' : '註冊帳號'}
                    </h1>
                    <p className="text-sm text-slate-500 mb-6">
                        使用 email 與密碼{mode === 'signin' ? '登入' : '建立帳號'}
                    </p>

                    <form onSubmit={onSubmit} className="space-y-4">
                        {mode === 'signup' && (
                            <div>
                                <label className="text-xs font-bold text-slate-600 mb-1.5 block">姓名</label>
                                <div className="relative">
                                    <User className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                    <input
                                        type="text"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        required
                                        className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm"
                                        placeholder="王小明"
                                    />
                                </div>
                            </div>
                        )}

                        <div>
                            <label className="text-xs font-bold text-slate-600 mb-1.5 block">Email</label>
                            <div className="relative">
                                <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    autoComplete="email"
                                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm"
                                    placeholder="you@example.com"
                                />
                            </div>
                        </div>

                        <div>
                            <label className="text-xs font-bold text-slate-600 mb-1.5 block">密碼</label>
                            <div className="relative">
                                <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                                <input
                                    type="password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                    minLength={6}
                                    autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                                    className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 outline-none text-sm"
                                    placeholder="至少 6 個字元"
                                />
                            </div>
                        </div>

                        {error && (
                            <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                                {error}
                            </div>
                        )}
                        {info && (
                            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                                {info}
                            </div>
                        )}

                        <button
                            type="submit"
                            disabled={busy}
                            className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-blue-600 to-indigo-600 text-white py-3 rounded-xl font-bold hover:shadow-lg transition-all disabled:opacity-50"
                        >
                            {mode === 'signin' ? <LogIn className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
                            {busy ? '處理中…' : mode === 'signin' ? '登入' : '註冊'}
                        </button>
                    </form>

                    <div className="mt-6 text-center text-sm text-slate-500">
                        {mode === 'signin' ? (
                            <>還沒有帳號?
                                <button
                                    type="button"
                                    onClick={() => { setMode('signup'); setError(''); setInfo(''); }}
                                    className="ml-1 text-blue-600 font-bold hover:underline"
                                >
                                    註冊一個
                                </button>
                            </>
                        ) : (
                            <>已經有帳號?
                                <button
                                    type="button"
                                    onClick={() => { setMode('signin'); setError(''); setInfo(''); }}
                                    className="ml-1 text-blue-600 font-bold hover:underline"
                                >
                                    去登入
                                </button>
                            </>
                        )}
                    </div>
                </div>

                <p className="text-center text-xs text-blue-200/60 mt-4">
                    註冊後角色預設為 pending,請至 Supabase 後台或用 admin 帳號將 role 改為 admin / mentor / teacher。
                </p>
            </div>
        </div>
    );
};

export default DevLogin;
