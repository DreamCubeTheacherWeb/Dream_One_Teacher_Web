import { useEffect, useRef, useState } from 'react';
import { BookOpen, ChevronLeft, ChevronRight, LayoutGrid, LibraryBig, Sparkles, Wallet, X } from 'lucide-react';

// 新手導覽 5 格（業主 2026-10-21：「彈出式視窗引導大家，3～5 格，引導老師學習這個頁面」）。
// 文案業主 2026-10-22 同意照此版上線；改內容後若要大家再看一次，把 lib/onboarding.js 的 TOUR_VERSION 加一。
const TOUR_STEPS = [
    {
        icon: Sparkles,
        band: 'bg-bauhaus-yellow text-bauhaus-black',
        title: '歡迎來到講師資源站',
        body: '這裡是夢想一號講師的培訓與行政小幫手。花 30 秒，帶你認識最常用的幾個地方。',
    },
    {
        icon: LayoutGrid,
        band: 'bg-bauhaus-blue text-white',
        title: '關於我：你的個人總覽',
        body: '登入後先看這一頁：這一期累計報酬、下次匯款日、培訓課程和你的教學排名都整理在一起。想看完整排行榜或玩方塊競速，也從這裡進去。',
    },
    {
        icon: Wallet,
        band: 'bg-bauhaus-yellow text-bauhaus-black',
        title: '我的報酬：上完課記得回報',
        body: '每上完一堂課，到「我的報酬」按「登記課程回報」填一次就好。送出後就會算進當期累計（管理員核准前會標「待核准」），黃色卡片也會寫下次匯款日。',
    },
    {
        icon: BookOpen,
        band: 'bg-bauhaus-red text-white',
        title: '我的課程：完成培訓',
        body: '依你的講師等級開放的培訓課程都在「我的課程」。先選大分類，再進入課程逐章學習，看完的章節會打勾。',
    },
    {
        icon: LibraryBig,
        band: 'bg-bauhaus-blue text-white',
        title: '教材與個人資料',
        body: '上課用的教材在「教材資源」（會開新分頁）。銀行帳戶、聯絡方式有變動，記得到「個人資料」更新。有問題請在講師群組提出。',
    },
];

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

const OnboardingTour = ({ onClose }) => {
    const [step, setStep] = useState(0);
    const dialogRef = useRef(null);
    const primaryRef = useRef(null);
    const total = TOUR_STEPS.length;
    const current = TOUR_STEPS[step];
    const Icon = current.icon;
    const isLast = step === total - 1;

    // onClose 換新函式時不要重跑下面的掛載效果（會把焦點跳回背景）
    const onCloseRef = useRef(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    // 開著時鎖住背景捲動；Esc＝跳過；Tab 只在彈窗內循環
    useEffect(() => {
        const previousOverflow = document.body.style.overflow;
        const previousFocus = document.activeElement;
        document.body.style.overflow = 'hidden';
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            // 點到遮罩後焦點會掉到頁面上，按 Tab 一律拉回彈窗
            if (!dialogRef.current.contains(document.activeElement)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            document.removeEventListener('keydown', onKeyDown);
            if (previousFocus instanceof HTMLElement) previousFocus.focus();
        };
    }, []);

    // 每換一格把焦點放在主要按鈕，鍵盤一路按 Enter 就能看完
    useEffect(() => { primaryRef.current?.focus(); }, [step]);

    return (
        <div
            className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-bauhaus-black/60 p-4"
            data-testid="onboarding-tour"
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="onboarding-tour-title"
                aria-describedby="onboarding-tour-body"
                className="bh-card shadow-hard-lg overflow-hidden w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto"
            >
                <div className={`${current.band} relative border-b-2 lg:border-b-4 border-bauhaus-black px-6 pt-6 pb-5`}>
                    <div className="flex items-start justify-between gap-3">
                        <span className="text-xs font-black uppercase tracking-widest opacity-80 tabular-nums">
                            新手導覽 {step + 1} / {total}
                        </span>
                        <button
                            type="button"
                            onClick={onClose}
                            className="-mt-2 -mr-2 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-xl hover:bg-bauhaus-black/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-bauhaus-black/30"
                            aria-label="跳過導覽"
                        >
                            <X className="w-5 h-5" aria-hidden="true" />
                        </button>
                    </div>
                    <div className="mt-2 w-14 h-14 bg-white text-bauhaus-black border-2 border-bauhaus-black rounded-lg flex items-center justify-center shadow-hard-sm">
                        <Icon className="w-7 h-7" aria-hidden="true" />
                    </div>
                </div>

                <div className="px-6 py-5">
                    {/* 換格時讀螢幕軟體會念出新的標題與說明（焦點一直停在「下一步」，不會自動重念） */}
                    <div aria-live="polite" aria-atomic="true">
                        <h2 id="onboarding-tour-title" className="text-xl sm:text-2xl font-black text-bauhaus-black">{current.title}</h2>
                        <p id="onboarding-tour-body" className="mt-2 text-bauhaus-black/75 font-medium leading-relaxed text-balance">{current.body}</p>
                    </div>

                    <div className="mt-5 flex items-center justify-center gap-2" aria-hidden="true">
                        {TOUR_STEPS.map((item, index) => (
                            <span
                                key={item.title}
                                className={`h-2.5 border-2 border-bauhaus-black rounded-full transition-all duration-200 ${index === step ? 'w-7 bg-bauhaus-black' : 'w-2.5 bg-white'}`}
                            />
                        ))}
                    </div>

                    <div className="mt-5 flex items-center gap-3">
                        {step > 0 ? (
                            <button type="button" onClick={() => setStep(step - 1)} className="bh-btn bh-btn-outline px-4 py-3 min-h-[48px]">
                                <ChevronLeft className="w-4 h-4" aria-hidden="true" />上一步
                            </button>
                        ) : (
                            <button type="button" onClick={onClose} className="bh-btn bh-btn-ghost px-4 py-3 min-h-[48px]">
                                先跳過
                            </button>
                        )}
                        <button
                            ref={primaryRef}
                            type="button"
                            onClick={() => (isLast ? onClose() : setStep(step + 1))}
                            className="bh-btn bh-btn-blue flex-1 px-4 py-3 min-h-[48px]"
                        >
                            {isLast ? '開始使用' : '下一步'}
                            {!isLast && <ChevronRight className="w-4 h-4" aria-hidden="true" />}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default OnboardingTour;
