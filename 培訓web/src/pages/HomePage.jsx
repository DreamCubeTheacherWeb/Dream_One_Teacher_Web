import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import {
    BookOpen, Target, Heart, Sparkles, ChevronRight,
    Megaphone, Pin, Calendar, Users, Star, ArrowRight
} from 'lucide-react';

const VISION_ITEMS = [
    {
        layer: 'WHY',
        color: 'from-yellow-400 to-amber-500',
        textColor: 'text-amber-600',
        bgColor: 'bg-amber-50',
        borderColor: 'border-amber-200',
        ideal: '讓孩子擁有改變世界的能力',
        real: '成為全球最專業及最大的魔術方塊推廣團隊，並與合作夥伴組成魔術方塊教育產業鏈中，最堅強的競爭團隊',
    },
    {
        layer: 'HOW',
        color: 'from-blue-400 to-indigo-500',
        textColor: 'text-blue-600',
        bgColor: 'bg-blue-50',
        borderColor: 'border-blue-200',
        ideal: '透過有趣的學習方式，培養孩子恆毅力、學習力、創新力',
        real: '透過專業的講師、有架構的課程、完整的教案與教具',
    },
    {
        layer: 'WHAT',
        color: 'from-emerald-400 to-teal-500',
        textColor: 'text-emerald-600',
        bgColor: 'bg-emerald-50',
        borderColor: 'border-emerald-200',
        ideal: '讓每個接觸魔術方塊的人都能感受到學習的樂趣',
        real: '提供教育機構、學生優質的魔術方塊學習方案',
    },
];

const TEAM_PHOTOS = [
    { src: '/images/team-event.png', alt: '2022 夢想一號學員認證賽' },
    { src: '/images/team-outdoor.png', alt: '團隊戶外活動' },
    { src: '/images/team-workshop.png', alt: '魔術方塊工作坊' },
];

const HomePage = () => {
    const { user } = useAuth();
    const [activeTab, setActiveTab] = useState('real');
    const [announcements, setAnnouncements] = useState([]);

    useEffect(() => {
        const fetchAnnouncements = async () => {
            const { data } = await supabase
                .from('announcements')
                .select('*')
                .eq('published', true)
                .order('pinned', { ascending: false })
                .order('created_at', { ascending: false })
                .limit(6);
            setAnnouncements(data || []);
        };
        fetchAnnouncements();
    }, []);

    return (
        <div className="min-h-screen overflow-x-hidden">
            {/* ══════════ HERO ══════════ */}
            <section className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950 text-white">
                <div className="absolute inset-0">
                    <div className="absolute top-20 left-10 w-72 h-72 bg-blue-500/10 rounded-full blur-3xl" />
                    <div className="absolute bottom-10 right-10 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl" />
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-amber-500/5 rounded-full blur-3xl" />
                </div>

                <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24 lg:py-32">
                    <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-12">
                        <div className="flex-1 text-center lg:text-left">
                            <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1.5 mb-6 text-xs sm:text-sm font-bold tracking-wide text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-full">
                                <Sparkles className="w-4 h-4" />
                                夢想一號魔術方塊學院
                            </div>
                            <h1 className="text-3xl sm:text-4xl lg:text-6xl font-black leading-tight mb-6">
                                提升教學專業
                                <br />
                                <span className="bg-gradient-to-r from-amber-300 to-yellow-400 bg-clip-text text-transparent">
                                    啟發無限潛力
                                </span>
                            </h1>
                            <p className="text-base sm:text-lg text-blue-100/80 mb-4 leading-relaxed max-w-xl">
                                不是為了教而教，而是我們透過魔術方塊也對教育有所貢獻。
                            </p>
                            <p className="text-base text-blue-200/60 mb-10 max-w-xl font-medium">
                                提供完整的線上培訓資源、進度追蹤與專家回饋，助您在教學領域更上一層樓。
                            </p>
                            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                                {user ? (
                                    <Link
                                        to="/courses"
                                        className="group inline-flex items-center gap-2 bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-900 px-8 py-4 rounded-2xl font-black text-lg hover:shadow-xl hover:shadow-amber-500/25 transition-all active:scale-[0.98]"
                                    >
                                        <BookOpen className="w-5 h-5" />
                                        開始學習
                                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                    </Link>
                                ) : (
                                    <div className="text-blue-200/60 text-sm font-medium bg-white/5 border border-white/10 px-6 py-4 rounded-2xl">
                                        請先登入以開始您的培訓課程
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex-1 max-w-md lg:max-w-lg">
                            <div className="relative">
                                <div className="absolute -inset-4 bg-gradient-to-r from-amber-400/20 to-blue-400/20 rounded-3xl blur-2xl" />
                                <img
                                    src="/images/team-event.png"
                                    alt="夢想一號團隊"
                                    className="relative w-full rounded-3xl shadow-2xl ring-1 ring-white/10"
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-20 pt-12 border-t border-white/10">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
                            <div>
                                <div className="text-3xl font-black text-amber-400 mb-1">100+</div>
                                <div className="text-sm text-blue-200/60 font-medium">培訓教師人數</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-amber-400 mb-1">300+</div>
                                <div className="text-sm text-blue-200/60 font-medium">合作過的單位</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-amber-400 mb-1">30,000+</div>
                                <div className="text-sm text-blue-200/60 font-medium">受惠學生人數</div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ══════════ BULLETIN BOARD ══════════ */}
            <section className="py-20 bg-gradient-to-b from-slate-50 to-white">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="flex items-center gap-3 mb-10">
                        <div className="p-3 bg-red-50 rounded-2xl">
                            <Megaphone className="w-7 h-7 text-red-500" />
                        </div>
                        <div>
                            <h2 className="text-2xl font-black text-slate-900">佈告欄</h2>
                            <p className="text-sm text-slate-400 font-medium">最新公告與重要通知</p>
                        </div>
                    </div>

                    {announcements.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {announcements.map((a) => (
                                <Link
                                    to={`/announcements/${a.id}`}
                                    key={a.id}
                                    className={`relative bg-white rounded-2xl border p-6 transition-all hover:shadow-lg hover:-translate-y-1 cursor-pointer block ${
                                        a.pinned
                                            ? 'border-red-200 shadow-md shadow-red-50 ring-1 ring-red-100'
                                            : 'border-slate-150 shadow-sm'
                                    }`}
                                >
                                    {a.pinned && (
                                        <div className="absolute -top-3 -right-2">
                                            <div className="bg-red-500 text-white p-1.5 rounded-full shadow-lg shadow-red-200">
                                                <Pin className="w-3.5 h-3.5" />
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2 mb-3">
                                        <span className={`text-[10px] font-black px-2.5 py-1 rounded-full uppercase tracking-wider ${
                                            a.tag === '重要公告' ? 'bg-red-50 text-red-600'
                                                : a.tag === '課程更新' ? 'bg-blue-50 text-blue-600'
                                                    : a.tag === '提醒' ? 'bg-amber-50 text-amber-600'
                                                        : 'bg-slate-100 text-slate-500'
                                        }`}>
                                            {a.tag}
                                        </span>
                                        <span className="flex items-center gap-1 text-[11px] text-slate-400 font-medium">
                                            <Calendar className="w-3 h-3" />
                                            {new Date(a.created_at).toLocaleDateString()}
                                        </span>
                                    </div>

                                    <h3 className="font-bold text-slate-900 mb-2 leading-snug line-clamp-2 md:line-clamp-none">{a.title}</h3>
                                    <div className="text-sm text-slate-500 leading-relaxed line-clamp-3 [&_img]:hidden [&_p]:m-0" dangerouslySetInnerHTML={{ __html: a.content }} />
                                    <span className="inline-block mt-3 text-xs font-bold text-blue-500">閱讀更多 →</span>
                                </Link>
                            ))}
                        </div>
                    ) : (
                        <div className="py-12 text-center bg-white rounded-2xl border border-slate-100">
                            <p className="text-slate-400">目前沒有公告</p>
                        </div>
                    )}
                </div>
            </section>

            {/* ══════════ VISION & MISSION ══════════ */}
            <section className="py-20 bg-white">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 text-sm font-bold text-indigo-600 bg-indigo-50 rounded-full">
                            <Target className="w-4 h-4" />
                            願景與使命
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-slate-900 mb-4">
                            你辦不到你相信不了的事情
                        </h2>
                        <p className="text-slate-500 max-w-2xl mx-auto">
                            大方向任務是魔術方塊教學普及，不是把所有人都變成選手。
                            我們透過魔術方塊對教育有所貢獻。
                        </p>
                    </div>

                    <div className="flex justify-center gap-4 mb-10">
                        <button
                            onClick={() => setActiveTab('ideal')}
                            className={`px-6 py-3 md:py-2.5 rounded-xl text-sm font-bold transition-all ${
                                activeTab === 'ideal'
                                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                            }`}
                        >
                            <Heart className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                            理想層面
                        </button>
                        <button
                            onClick={() => setActiveTab('real')}
                            className={`px-6 py-3 md:py-2.5 rounded-xl text-sm font-bold transition-all ${
                                activeTab === 'real'
                                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200'
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                            }`}
                        >
                            <Target className="w-4 h-4 inline mr-1.5 -mt-0.5" />
                            現實層面
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {VISION_ITEMS.map((item) => (
                            <div
                                key={item.layer}
                                className={`relative rounded-2xl border ${item.borderColor} ${item.bgColor} p-8 transition-all hover:shadow-lg hover:-translate-y-1`}
                            >
                                <div className={`inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br ${item.color} text-white font-black text-lg mb-5 shadow-lg`}>
                                    {item.layer}
                                </div>
                                <h3 className={`font-black text-lg mb-3 ${item.textColor}`}>
                                    {item.layer === 'WHY' ? '願景' : item.layer === 'HOW' ? '使命' : '行動'}
                                </h3>
                                <p className="text-slate-700 leading-relaxed font-medium">
                                    {activeTab === 'ideal' ? item.ideal : item.real}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ══════════ TEAM GALLERY ══════════ */}
            <section className="py-20 bg-gradient-to-b from-slate-50 to-white">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 text-sm font-bold text-emerald-600 bg-emerald-50 rounded-full">
                            <Users className="w-4 h-4" />
                            我們的團隊
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-slate-900 mb-4">
                            玩的不只是魔術方塊，更是五顏六色的夢想
                        </h2>
                        <p className="text-slate-500 max-w-2xl mx-auto">
                            Solving Challenging Cubes, Sparking Infinite Dreams
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {TEAM_PHOTOS.map((photo, idx) => (
                            <div
                                key={idx}
                                className="group relative rounded-2xl overflow-hidden shadow-lg hover:shadow-2xl transition-all hover:-translate-y-1"
                            >
                                <div className="aspect-[4/3]">
                                    <img
                                        src={photo.src}
                                        alt={photo.alt}
                                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                    />
                                </div>
                                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300" />
                                <div className="absolute bottom-0 left-0 right-0 p-5 translate-y-0 opacity-100 md:translate-y-4 md:opacity-0 md:group-hover:translate-y-0 md:group-hover:opacity-100 transition-all duration-300">
                                    <p className="text-white font-bold text-sm">{photo.alt}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ══════════ CTA ══════════ */}
            <section className="py-20 bg-white">
                <div className="max-w-4xl mx-auto px-6">
                    <div className="relative bg-gradient-to-br from-slate-900 via-blue-950 to-indigo-950 rounded-3xl p-8 sm:p-12 lg:p-16 text-center overflow-hidden">
                        <div className="absolute top-0 left-0 w-64 h-64 bg-amber-400/10 rounded-full -translate-x-1/2 -translate-y-1/2 blur-3xl" />
                        <div className="absolute bottom-0 right-0 w-48 h-48 bg-blue-400/10 rounded-full translate-x-1/2 translate-y-1/2 blur-3xl" />

                        <div className="relative">
                            <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-6 text-sm font-bold text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-full">
                                <Star className="w-4 h-4" />
                                準備好了嗎？
                            </div>
                            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black text-white mb-4">
                                開始你的教師培訓之旅
                            </h2>
                            <p className="text-blue-200/70 mb-10 max-w-lg mx-auto">
                                加入我們的培訓計劃，成為一位能夠啟發學生、傳遞魔術方塊魅力的專業教師。
                            </p>
                            {user ? (
                                <Link
                                    to="/courses"
                                    className="group inline-flex items-center gap-2 bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-900 px-8 py-4 rounded-2xl font-black text-lg hover:shadow-xl hover:shadow-amber-500/25 transition-all"
                                >
                                    前往課程列表
                                    <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                </Link>
                            ) : (
                                <p className="text-blue-200/50 font-medium">
                                    請先登入後即可開始學習
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};

export default HomePage;
