import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { ArrowLeft, Calendar, Pin } from 'lucide-react';

const TAG_COLORS = {
    '重要公告': 'bg-red-50 text-red-600',
    '課程更新': 'bg-blue-50 text-blue-600',
    '提醒': 'bg-amber-50 text-amber-600',
    '活動': 'bg-purple-50 text-purple-600',
};

const AnnouncementDetail = () => {
    const { id } = useParams();
    const [announcement, setAnnouncement] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetch = async () => {
            const { data } = await supabase
                .from('announcements')
                .select('*')
                .eq('id', id)
                .eq('published', true)
                .maybeSingle();
            setAnnouncement(data);
            setLoading(false);
        };
        fetch();
    }, [id]);

    if (loading) return <div className="p-12 text-center text-slate-500">載入中...</div>;

    if (!announcement) {
        return (
            <div className="min-h-[60vh] flex flex-col items-center justify-center p-8">
                <h2 className="text-xl font-bold text-slate-900 mb-2">找不到這則公告</h2>
                <p className="text-slate-500 mb-6">公告可能已被移除或尚未發佈。</p>
                <Link to="/" className="relative text-blue-600 hover:text-blue-800 font-bold flex items-center gap-2 before:content-[''] before:absolute before:-inset-3">
                    <ArrowLeft className="w-4 h-4" /> 返回首頁
                </Link>
            </div>
        );
    }

    const tagColor = TAG_COLORS[announcement.tag] || 'bg-slate-100 text-slate-500';

    return (
        <div className="max-w-3xl mx-auto px-6 py-12">
            <Link to="/" className="relative inline-flex items-center gap-2 text-sm font-medium text-slate-400 hover:text-blue-600 transition-colors mb-8 before:content-[''] before:absolute before:-inset-3">
                <ArrowLeft className="w-4 h-4" /> 返回首頁
            </Link>

            <article>
                <div className="flex flex-wrap items-center gap-3 mb-4">
                    <span className={`text-xs font-black px-3 py-1 rounded-full uppercase tracking-wider ${tagColor}`}>
                        {announcement.tag}
                    </span>
                    {announcement.pinned && (
                        <span className="text-xs font-black text-red-500 bg-red-50 px-3 py-1 rounded-full flex items-center gap-1">
                            <Pin className="w-3 h-3" /> 置頂
                        </span>
                    )}
                    <span className="flex items-center gap-1.5 text-sm text-slate-400">
                        <Calendar className="w-3.5 h-3.5" />
                        {new Date(announcement.created_at).toLocaleDateString('zh-TW', {
                            year: 'numeric', month: 'long', day: 'numeric'
                        })}
                    </span>
                </div>

                <h1 className="text-3xl font-black text-slate-900 mb-8 leading-tight">
                    {announcement.title}
                </h1>

                <div
                    className="prose prose-slate max-w-none prose-img:rounded-xl prose-img:shadow-md prose-a:text-blue-600 prose-headings:font-bold prose-p:leading-relaxed [&_img]:max-w-full [&_img]:h-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
                    dangerouslySetInnerHTML={{ __html: announcement.content }}
                />
            </article>

            <div className="mt-12 pt-8 border-t border-slate-200">
                <Link to="/" className="relative inline-flex items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-800 transition-colors before:content-[''] before:absolute before:-inset-3">
                    <ArrowLeft className="w-4 h-4" /> 返回首頁
                </Link>
            </div>
        </div>
    );
};

export default AnnouncementDetail;
