import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { AlertTriangle } from 'lucide-react';
import LeaderboardView from '../components/LeaderboardView';

const Leaderboard = () => {
    const { user } = useAuth();
    const [year, setYear] = useState(null); // null＝歷屆總榜
    const [years, setYears] = useState([]);
    const [rows, setRows] = useState([]);
    const [avatarMap, setAvatarMap] = useState({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);

    // 有接課資料的年份（一次載入，給年份切換器）
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const { data } = await supabase.rpc('get_teaching_years');
            if (!cancelled && Array.isArray(data)) setYears(data.map((d) => d.yr));
        })();
        return () => { cancelled = true; };
    }, []);

    // 依年份載入排行榜
    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            setError(false);
            try {
                const { data, error: rpcErr } = await supabase.rpc('get_teaching_leaderboard', { p_year: year });
                if (rpcErr) throw rpcErr;
                if (cancelled) return;
                const list = data || [];
                setRows(list);

                // 頭像簽名 URL（沿用 instructor_uploads bucket，以 instructor_id 為鍵）
                const withPhoto = list.filter((r) => r.photo_path);
                const entries = await Promise.all(
                    withPhoto.map(async (r) => {
                        const { data: urlData } = await supabase.storage
                            .from('instructor_uploads')
                            .createSignedUrl(r.photo_path, 7200);
                        return [r.instructor_id, urlData?.signedUrl || null];
                    })
                );
                if (cancelled) return;
                setAvatarMap(Object.fromEntries(entries));
            } catch (err) {
                console.error('Leaderboard load failed:', err);
                if (!cancelled) setError(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [year]);

    if (loading) {
        return (
            <div className="p-4 sm:p-8 max-w-4xl mx-auto">
                <div className="h-40 rounded-3xl bg-slate-100 animate-pulse mb-6" />
                <div className="space-y-3">
                    {[...Array(5)].map((_, i) => (
                        <div key={i} className="h-16 rounded-2xl bg-slate-100 animate-pulse" />
                    ))}
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 sm:p-8 max-w-4xl mx-auto">
                <div className="bg-white rounded-3xl border border-slate-200 shadow-sm py-16 text-center">
                    <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <AlertTriangle className="w-8 h-8 text-red-400" />
                    </div>
                    <h2 className="text-xl font-black text-slate-900">排行榜載入失敗</h2>
                    <p className="text-slate-500 mt-2 text-sm">請稍後再試，或重新整理頁面。</p>
                </div>
            </div>
        );
    }

    return (
        <LeaderboardView
            rows={rows}
            avatarMap={avatarMap}
            currentUserId={user?.id}
            years={years}
            selectedYear={year}
            onYearChange={setYear}
        />
    );
};

export default Leaderboard;
