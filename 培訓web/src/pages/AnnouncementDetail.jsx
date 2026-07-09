import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { ArrowLeft, Calendar, Pin } from 'lucide-react';

const TAG_COLORS = {
    '重要公告': 'bg-bauhaus-red text-white',
    '課程更新': 'bg-bauhaus-blue text-white',
    '提醒': 'bg-bauhaus-yellow text-bauhaus-black',
    '活動': 'bg-bauhaus-black text-white',
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

    if (loading) return <div className="p-12 text-center text-bauhaus-black/50 font-bold">載入中...</div>;

    if (!announcement) {
        return (
            <div className="min-h-[60vh] flex flex-col items-center justify-center p-8">
                <h2 className="text-xl font-black text-bauhaus-black mb-2">找不到這則公告</h2>
                <p className="text-bauhaus-black/60 mb-6 font-medium">公告可能已被移除或尚未發佈。</p>
                <Link to="/" className="relative text-bauhaus-blue hover:text-bauhaus-black font-bold flex items-center gap-2 before:content-[''] before:absolute before:-inset-3">
                    <ArrowLeft className="w-4 h-4" /> 返回首頁
                </Link>
            </div>
        );
    }

    const tagColor = TAG_COLORS[announcement.tag] || 'bg-bauhaus-muted text-bauhaus-black';

    return (
        <div className="max-w-3xl mx-auto px-6 py-12">
            <Link to="/" className="relative inline-flex items-center gap-2 text-sm font-bold text-bauhaus-black/50 hover:text-bauhaus-blue transition-colors duration-200 mb-8 before:content-[''] before:absolute before:-inset-3">
                <ArrowLeft className="w-4 h-4" /> 返回首頁
            </Link>

            <article>
                <div className="flex flex-wrap items-center gap-3 mb-4">
                    <span className={`text-xs font-black px-3 py-1 uppercase tracking-wider border-2 border-bauhaus-black rounded-lg ${tagColor}`}>
                        {announcement.tag}
                    </span>
                    {announcement.pinned && (
                        <span className="text-xs font-black text-white bg-bauhaus-red px-3 py-1 border-2 border-bauhaus-black rounded-lg flex items-center gap-1">
                            <Pin className="w-3 h-3" /> 置頂
                        </span>
                    )}
                    <span className="flex items-center gap-1.5 text-sm text-bauhaus-black/50 font-medium">
                        <Calendar className="w-3.5 h-3.5" />
                        {new Date(announcement.created_at).toLocaleDateString('zh-TW', {
                            year: 'numeric', month: 'long', day: 'numeric'
                        })}
                    </span>
                </div>

                <h1 className="text-2xl lg:text-4xl font-black text-bauhaus-black mb-8 leading-tight">
                    {announcement.title}
                </h1>

                <div
                    className="prose prose-slate max-w-none prose-img:rounded-xl prose-img:border-2 prose-img:border-bauhaus-black prose-a:text-bauhaus-blue prose-headings:font-black prose-p:leading-relaxed [&_img]:max-w-full [&_img]:h-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
                    dangerouslySetInnerHTML={{ __html: announcement.content }}
                />
            </article>

            <div className="mt-12 pt-8 border-t-2 border-bauhaus-black">
                <Link to="/" className="relative inline-flex items-center gap-2 text-sm font-bold text-bauhaus-blue hover:text-bauhaus-black transition-colors duration-200 before:content-[''] before:absolute before:-inset-3">
                    <ArrowLeft className="w-4 h-4" /> 返回首頁
                </Link>
            </div>
        </div>
    );
};

export default AnnouncementDetail;
