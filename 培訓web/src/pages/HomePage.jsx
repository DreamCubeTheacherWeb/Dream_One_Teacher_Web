import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import {
    BookOpen, Target, Heart, Sparkles, ChevronRight,
    Megaphone, Pin, Calendar, Users, Star, ArrowRight,
    MapPin, History, ExternalLink, Play
} from 'lucide-react';

const VISION_ITEMS = [
    {
        layer: 'WHY',
        accent: 'bg-bauhaus-red',
        accentText: 'text-white',
        textAccent: 'text-bauhaus-red',
        ideal: '讓孩子擁有改變世界的能力',
        real: '成為全球最專業及最大的魔術方塊推廣團隊，並與合作夥伴組成魔術方塊教育產業鏈中，最堅強的競爭團隊',
    },
    {
        layer: 'HOW',
        accent: 'bg-bauhaus-blue',
        accentText: 'text-white',
        textAccent: 'text-bauhaus-blue',
        ideal: '透過有趣的學習方式，培養孩子恆毅力、學習力、創新力',
        real: '透過專業的講師、有架構的課程、完整的教案與教具',
    },
    {
        layer: 'WHAT',
        accent: 'bg-bauhaus-yellow',
        accentText: 'text-bauhaus-black',
        textAccent: 'text-bauhaus-black',
        ideal: '讓每個接觸魔術方塊的人都能感受到學習的樂趣',
        real: '提供教育機構、學生優質的魔術方塊學習方案',
    },
];

const TEAM_PHOTOS = [
    { src: '/images/team-event.png', alt: '2022 夢想一號學員認證賽' },
    { src: '/images/team-outdoor.png', alt: '團隊戶外活動' },
    { src: '/images/team-workshop.png', alt: '魔術方塊工作坊' },
];

// Bauhaus：卡片角落幾何裝飾（紅圓／藍方／黃三角輪替）
const CORNER_DECOS = [
    { shape: 'circle', color: 'bg-bauhaus-red' },
    { shape: 'square', color: 'bg-bauhaus-blue' },
    { shape: 'triangle', color: 'bg-bauhaus-yellow' },
];

// 活動回顧（內容取自官網 Google Sites「關於夢想一號」）
const EVENT_REVIEWS = [
    {
        img: '/images/event-1.jpg',
        title: '第三屆學員賽',
        desc: '學員賽舉辦了三屆了！這屆我們有更酷的主題，希望夢想一號有朝一日能飛向宇宙！',
    },
    {
        img: '/images/event-2.jpg',
        title: '夢想一號首部形象廣告',
        desc: '由專業影像團隊編劇、優秀的學員擔任小演員，一同展現六大指標能力。',
        video: 'https://www.youtube.com/watch?v=J9SAYtSQiZk',
    },
    {
        img: '/images/event-3.jpg',
        title: '進駐科教館實體教室',
        desc: '2022 年的暑假我們入駐科教館，成為全台灣第一個魔術方塊實體教室！',
        video: 'https://www.youtube.com/watch?v=KxuKryrr9Ak',
    },
    {
        img: '/images/event-4.jpg',
        title: '規模最大的學員賽 × 認證考試',
        desc: '一同舉辦全台規模最大的學員競賽！首創認證制度，讓魔術方塊不再只有一種進步方向。',
        video: 'https://www.youtube.com/watch?v=Gu9B3hjm9FE',
    },
];

// 實體據點（地圖連結去 Google Maps 查證後放上）
const LOCATIONS = [
    {
        img: '/images/location-scieduc.jpg',
        name: '國立臺灣科學教育館',
        address: '台北市士林區士商路 189 號',
        map: 'https://www.google.com/maps/search/?api=1&query=%E5%9C%8B%E7%AB%8B%E8%87%BA%E7%81%A3%E7%A7%91%E5%AD%B8%E6%95%99%E8%82%B2%E9%A4%A8',
    },
    {
        img: '/images/location-nmns.jpg',
        name: '國立自然科學博物館',
        address: '台中市北區館前路 1 號',
        map: 'https://www.google.com/maps/search/?api=1&query=%E5%9C%8B%E7%AB%8B%E8%87%AA%E7%84%B6%E7%A7%91%E5%AD%B8%E5%8D%9A%E7%89%A9%E9%A4%A8',
    },
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
            <section className="relative overflow-hidden bg-bauhaus-blue text-white border-b-4 border-bauhaus-black">
                <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
                    <div className="absolute -top-10 -left-10 w-40 h-40 sm:w-64 sm:h-64 rounded-full bg-white/10" />
                    <div className="absolute bottom-0 right-0 w-48 h-48 sm:w-80 sm:h-80 bg-bauhaus-yellow/15 rotate-45" />
                    <div
                        className="absolute top-1/3 right-8 w-24 h-24 sm:w-40 sm:h-40 bg-bauhaus-red/20"
                        style={{ clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' }}
                    />
                </div>

                <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-24 lg:py-32">
                    <div className="flex flex-col lg:flex-row items-center gap-8 lg:gap-12">
                        <div className="flex-1 text-center lg:text-left">
                            <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1.5 mb-6 text-xs sm:text-sm font-bold uppercase tracking-widest text-bauhaus-black bg-bauhaus-yellow border-2 border-bauhaus-black">
                                <Sparkles className="w-4 h-4" />
                                夢想一號魔術方塊學院
                            </div>
                            <h1 className="text-4xl sm:text-5xl lg:text-7xl font-black leading-[0.95] tracking-tight mb-6">
                                提升教學專業
                                <br />
                                <span className="text-bauhaus-yellow">啟發無限潛力</span>
                            </h1>
                            <p className="text-base sm:text-lg text-white/85 mb-4 leading-relaxed max-w-xl mx-auto lg:mx-0">
                                不是為了教而教，而是我們透過魔術方塊也對教育有所貢獻。
                            </p>
                            <p className="text-base text-white/60 mb-10 max-w-xl mx-auto lg:mx-0 font-medium">
                                提供完整的線上培訓資源、進度追蹤與專家回饋，助您在教學領域更上一層樓。
                            </p>
                            <div className="flex flex-col sm:flex-row gap-4 justify-center lg:justify-start">
                                {user ? (
                                    <Link
                                        to="/courses"
                                        className="bh-btn bh-btn-yellow group px-8 py-4 text-lg"
                                    >
                                        <BookOpen className="w-5 h-5" />
                                        開始學習
                                        <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                    </Link>
                                ) : (
                                    <div className="text-white/70 text-sm font-bold bg-white/10 border-2 border-white/30 rounded-xl px-6 py-4">
                                        請先登入以開始您的培訓課程
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="flex-1 max-w-md lg:max-w-lg">
                            <div className="relative">
                                <div className="absolute -top-4 -left-4 w-12 h-12 sm:w-16 sm:h-16 bg-bauhaus-yellow border-2 border-bauhaus-black hidden sm:block" aria-hidden="true" />
                                <div className="absolute -bottom-4 -right-4 w-12 h-12 sm:w-16 sm:h-16 rounded-full bg-bauhaus-red border-2 border-bauhaus-black hidden sm:block" aria-hidden="true" />
                                <img
                                    src="/images/team-event.png"
                                    alt="夢想一號團隊"
                                    className="relative w-full rounded-xl border-4 border-bauhaus-black shadow-hard-white"
                                />
                            </div>
                        </div>
                    </div>

                    <div className="mt-20 pt-12 border-t-2 border-white/20">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8 text-center">
                            <div>
                                <div className="text-3xl font-black text-bauhaus-yellow mb-1 tabular-nums">100+</div>
                                <div className="text-sm text-white/60 font-bold uppercase tracking-wide">培訓教師人數</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-bauhaus-yellow mb-1 tabular-nums">300+</div>
                                <div className="text-sm text-white/60 font-bold uppercase tracking-wide">合作過的單位</div>
                            </div>
                            <div>
                                <div className="text-3xl font-black text-bauhaus-yellow mb-1 tabular-nums">30,000+</div>
                                <div className="text-sm text-white/60 font-bold uppercase tracking-wide">受惠學生人數</div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ══════════ VISION & MISSION ══════════ */}
            <section className="py-20 bg-bauhaus-paper border-y-4 border-bauhaus-black">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 text-xs sm:text-sm font-bold uppercase tracking-widest text-white bg-bauhaus-blue border-2 border-bauhaus-black rounded-lg">
                            <Target className="w-4 h-4" />
                            願景與使命
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-4 tracking-tight">
                            你辦不到你相信不了的事情
                        </h2>
                        <p className="text-bauhaus-black/60 max-w-2xl mx-auto font-medium">
                            大方向任務是魔術方塊教學普及，不是把所有人都變成選手。
                            我們透過魔術方塊對教育有所貢獻。
                        </p>
                    </div>

                    <div className="flex justify-center mb-10">
                        <div className="inline-flex border-2 lg:border-4 border-bauhaus-black rounded-xl overflow-hidden divide-x-2 lg:divide-x-4 divide-bauhaus-black">
                            <button
                                onClick={() => setActiveTab('ideal')}
                                className={`flex items-center gap-1.5 px-6 py-3 md:py-2.5 text-sm font-bold uppercase tracking-wide transition-colors duration-200 ${
                                    activeTab === 'ideal'
                                        ? 'bg-bauhaus-black text-white'
                                        : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                                }`}
                            >
                                <Heart className="w-4 h-4" />
                                理想層面
                            </button>
                            <button
                                onClick={() => setActiveTab('real')}
                                className={`flex items-center gap-1.5 px-6 py-3 md:py-2.5 text-sm font-bold uppercase tracking-wide transition-colors duration-200 ${
                                    activeTab === 'real'
                                        ? 'bg-bauhaus-black text-white'
                                        : 'bg-white text-bauhaus-black hover:bg-bauhaus-muted'
                                }`}
                            >
                                <Target className="w-4 h-4" />
                                現實層面
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {VISION_ITEMS.map((item) => (
                            <div
                                key={item.layer}
                                className="bh-card bh-card-hover p-8"
                            >
                                <div className={`inline-flex items-center justify-center w-14 h-14 rounded-lg border-2 border-bauhaus-black ${item.accent} ${item.accentText} font-black text-lg mb-5`}>
                                    {item.layer}
                                </div>
                                <h3 className={`font-black text-lg mb-3 ${item.textAccent}`}>
                                    {item.layer === 'WHY' ? '願景' : item.layer === 'HOW' ? '使命' : '行動'}
                                </h3>
                                <p className="text-bauhaus-black/80 leading-relaxed font-medium">
                                    {activeTab === 'ideal' ? item.ideal : item.real}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ══════════ BULLETIN BOARD（最新消息，接在願景使命之後） ══════════ */}
            <section className="py-20 bg-white border-b-4 border-bauhaus-black">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 text-xs sm:text-sm font-bold uppercase tracking-widest text-white bg-bauhaus-red border-2 border-bauhaus-black rounded-lg">
                            <Megaphone className="w-4 h-4" />
                            最新消息
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-4 tracking-tight">
                            佈告欄
                        </h2>
                        <p className="text-bauhaus-black/60 max-w-2xl mx-auto font-medium">
                            課程更新、活動與重要通知都會公告在這裡。
                        </p>
                    </div>

                    {announcements.length > 0 ? (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            {announcements.map((a, idx) => {
                                const deco = CORNER_DECOS[idx % 3];
                                return (
                                    <Link
                                        to={`/announcements/${a.id}`}
                                        key={a.id}
                                        className="bh-card bh-card-hover relative p-6 block"
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={`absolute top-2 left-2 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
                                            style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
                                        />
                                        {a.pinned && (
                                            <div className="absolute -top-3 -right-3">
                                                <div className="bg-bauhaus-red text-white p-1.5 rounded-lg border-2 border-bauhaus-black">
                                                    <Pin className="w-3.5 h-3.5" />
                                                </div>
                                            </div>
                                        )}

                                        <div className="flex items-center gap-2 mb-3">
                                            <span className={`text-[10px] font-black px-2.5 py-1 uppercase tracking-wider rounded-lg border-2 border-bauhaus-black ${
                                                a.tag === '重要公告' ? 'bg-bauhaus-red text-white'
                                                    : a.tag === '課程更新' ? 'bg-bauhaus-blue text-white'
                                                        : a.tag === '提醒' ? 'bg-bauhaus-yellow text-bauhaus-black'
                                                            : 'bg-bauhaus-muted text-bauhaus-black'
                                            }`}>
                                                {a.tag}
                                            </span>
                                            <span className="flex items-center gap-1 text-[11px] text-bauhaus-black/50 font-bold">
                                                <Calendar className="w-3 h-3" />
                                                {new Date(a.created_at).toLocaleDateString()}
                                            </span>
                                        </div>

                                        <h3 className="font-black text-bauhaus-black mb-2 leading-snug line-clamp-2 md:line-clamp-none">{a.title}</h3>
                                        <div className="text-sm text-bauhaus-black/60 leading-relaxed line-clamp-3 [&_img]:hidden [&_p]:m-0" dangerouslySetInnerHTML={{ __html: a.content }} />
                                        <span className="inline-block mt-3 text-xs font-bold text-bauhaus-blue">閱讀更多 →</span>
                                    </Link>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="bh-card py-12 text-center">
                            <p className="text-bauhaus-black/50 font-bold">目前沒有公告</p>
                        </div>
                    )}
                </div>
            </section>

            {/* ══════════ TEAM GALLERY ══════════ */}
            <section className="py-20 bg-white">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 text-xs sm:text-sm font-bold uppercase tracking-widest text-white bg-bauhaus-red border-2 border-bauhaus-black rounded-lg">
                            <Users className="w-4 h-4" />
                            我們的團隊
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-4 tracking-tight">
                            玩的不只是魔術方塊，更是五顏六色的夢想
                        </h2>
                        <p className="text-bauhaus-black/60 max-w-2xl mx-auto font-medium">
                            Solving Challenging Cubes, Sparking Infinite Dreams
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        {TEAM_PHOTOS.map((photo, idx) => {
                            const deco = CORNER_DECOS[idx % 3];
                            return (
                                <div
                                    key={idx}
                                    className="group relative border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard lg:shadow-hard-lg overflow-hidden hover:-translate-y-1 transition-transform duration-200"
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`absolute top-2 left-2 z-10 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
                                        style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
                                    />
                                    <div className="aspect-[4/3]">
                                        <img
                                            src={photo.src}
                                            alt={photo.alt}
                                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                        />
                                    </div>
                                    <div className="absolute inset-x-0 bottom-0 bg-bauhaus-black/85 p-4 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-300">
                                        <p className="text-white font-bold text-sm">{photo.alt}</p>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </section>

            {/* ══════════ EVENT REVIEWS ══════════ */}
            <section className="py-20 bg-bauhaus-paper border-y-4 border-bauhaus-black">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 text-xs sm:text-sm font-bold uppercase tracking-widest text-bauhaus-black bg-bauhaus-yellow border-2 border-bauhaus-black rounded-lg">
                            <History className="w-4 h-4" />
                            活動回顧
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-4 tracking-tight">
                            我們一起走過的精彩時刻
                        </h2>
                        <p className="text-bauhaus-black/60 max-w-2xl mx-auto font-medium">
                            從學員賽、形象廣告，到全台第一間魔術方塊實體教室——每一步都是夢想的延伸。
                        </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                        {EVENT_REVIEWS.map((ev, idx) => {
                            const deco = CORNER_DECOS[idx % 3];
                            const inner = (
                                <>
                                    <span
                                        aria-hidden="true"
                                        className={`absolute top-2 left-2 z-10 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
                                        style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
                                    />
                                    <div className="relative aspect-video border-b-2 border-bauhaus-black overflow-hidden bg-bauhaus-muted">
                                        <img
                                            src={ev.img}
                                            alt={ev.title}
                                            loading="lazy"
                                            className="w-full h-full object-cover"
                                        />
                                        {ev.video && (
                                            <div className="absolute inset-0 flex items-center justify-center bg-bauhaus-black/15 group-hover:bg-bauhaus-black/5 transition-colors">
                                                <span className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-bauhaus-red border-2 border-bauhaus-black shadow-hard group-hover:scale-110 transition-transform">
                                                    <Play className="w-6 h-6 text-white fill-white ml-0.5" />
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                    <div className="p-5 flex-1 flex flex-col">
                                        <h3 className="font-black text-bauhaus-black mb-2 leading-snug">{ev.title}</h3>
                                        <p className="text-sm text-bauhaus-black/60 leading-relaxed font-medium">{ev.desc}</p>
                                        {ev.video && (
                                            <span className="inline-flex items-center gap-1 mt-3 text-xs font-bold text-bauhaus-red">
                                                觀看影片
                                                <ExternalLink className="w-3 h-3" />
                                            </span>
                                        )}
                                    </div>
                                </>
                            );
                            return ev.video ? (
                                <a
                                    key={idx}
                                    href={ev.video}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="group bh-card bh-card-hover relative overflow-hidden flex flex-col"
                                >
                                    {inner}
                                </a>
                            ) : (
                                <article
                                    key={idx}
                                    className="group bh-card bh-card-hover relative overflow-hidden flex flex-col"
                                >
                                    {inner}
                                </article>
                            );
                        })}
                    </div>
                </div>
            </section>

            {/* ══════════ PHYSICAL LOCATIONS ══════════ */}
            <section className="py-20 bg-white">
                <div className="max-w-6xl mx-auto px-6">
                    <div className="text-center mb-12">
                        <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-4 text-xs sm:text-sm font-bold uppercase tracking-widest text-white bg-bauhaus-blue border-2 border-bauhaus-black rounded-lg">
                            <MapPin className="w-4 h-4" />
                            實體據點
                        </div>
                        <h2 className="text-2xl sm:text-3xl font-black text-bauhaus-black mb-4 tracking-tight">
                            我們還有實體據點喔！
                        </h2>
                        <p className="text-bauhaus-black/60 max-w-2xl mx-auto font-medium">
                            歡迎親自來玩，近距離感受魔術方塊的魅力。
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                        {LOCATIONS.map((loc, idx) => {
                            const deco = CORNER_DECOS[idx % 3];
                            return (
                                <article
                                    key={idx}
                                    className="bh-card bh-card-hover relative overflow-hidden flex flex-col"
                                >
                                    <span
                                        aria-hidden="true"
                                        className={`absolute top-2 left-2 z-10 w-4 h-4 ${deco.color} ${deco.shape === 'circle' ? 'rounded-full' : ''}`}
                                        style={deco.shape === 'triangle' ? { clipPath: 'polygon(50% 0%, 0% 100%, 100% 100%)' } : undefined}
                                    />
                                    <div className="aspect-[16/10] border-b-2 border-bauhaus-black overflow-hidden bg-bauhaus-muted">
                                        <img
                                            src={loc.img}
                                            alt={loc.name}
                                            loading="lazy"
                                            className="w-full h-full object-cover"
                                        />
                                    </div>
                                    <div className="p-6 flex-1 flex flex-col items-center text-center">
                                        <h3 className="text-xl font-black text-bauhaus-black mb-1">{loc.name}</h3>
                                        <p className="text-sm font-bold text-bauhaus-blue mb-2">（開放參觀，歡迎來玩）</p>
                                        <p className="text-xs text-bauhaus-black/50 font-medium mb-5 flex items-center gap-1">
                                            <MapPin className="w-3 h-3 shrink-0" />
                                            {loc.address}
                                        </p>
                                        <a
                                            href={loc.map}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="bh-btn bg-bauhaus-black text-white hover:bg-bauhaus-black/90 w-full mt-auto px-5 py-3 text-sm"
                                        >
                                            <MapPin className="w-4 h-4" />
                                            地圖位置
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                </div>
            </section>

            {/* ══════════ CTA ══════════ */}
            <section className="py-20 bg-white border-t-4 border-bauhaus-black">
                <div className="max-w-4xl mx-auto px-6">
                    <div className="relative bg-bauhaus-black border-4 border-bauhaus-black rounded-2xl p-8 sm:p-12 lg:p-16 text-center overflow-hidden">
                        <div className="absolute top-0 left-0 w-32 h-32 sm:w-48 sm:h-48 bg-bauhaus-yellow/90 rounded-full -translate-x-1/2 -translate-y-1/2" aria-hidden="true" />
                        <div className="absolute bottom-0 right-0 w-28 h-28 sm:w-40 sm:h-40 bg-bauhaus-blue/90 translate-x-1/3 translate-y-1/3 rotate-45" aria-hidden="true" />

                        <div className="relative">
                            <div className="inline-flex items-center gap-2 px-4 py-1.5 mb-6 text-xs sm:text-sm font-bold uppercase tracking-widest text-bauhaus-black bg-bauhaus-yellow border-2 border-white rounded-lg">
                                <Star className="w-4 h-4" />
                                準備好了嗎？
                            </div>
                            <h2 className="text-2xl sm:text-3xl lg:text-4xl font-black text-white mb-4 tracking-tight">
                                開始你的教師培訓之旅
                            </h2>
                            <p className="text-white/70 mb-10 max-w-lg mx-auto font-medium">
                                加入我們的培訓計劃，成為一位能夠啟發學生、傳遞魔術方塊魅力的專業教師。
                            </p>
                            {user ? (
                                <Link
                                    to="/courses"
                                    className="bh-btn bh-btn-yellow group border-white shadow-hard-white px-8 py-4 text-lg"
                                >
                                    前往課程列表
                                    <ChevronRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                                </Link>
                            ) : (
                                <p className="text-white/50 font-bold">
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
