import { ArrowLeft, CalendarDays, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';

const LegalDocumentPage = ({ title, summary, effectiveDate, sections }) => (
    <div className="bg-bauhaus-paper text-bauhaus-black">
        <section className="relative overflow-hidden bg-bauhaus-blue text-white border-b-4 border-bauhaus-black">
            <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
                <span className="absolute -top-16 -right-10 w-40 h-40 sm:w-56 sm:h-56 rounded-full bg-bauhaus-yellow border-4 border-bauhaus-black" />
                <span className="absolute -bottom-12 -left-8 w-28 h-28 sm:w-40 sm:h-40 rotate-12 bg-bauhaus-red border-4 border-bauhaus-black" />
            </div>

            <div className="relative max-w-6xl mx-auto px-4 sm:px-6 py-12 sm:py-16 lg:py-20">
                <Link
                    to="/"
                    className="inline-flex items-center gap-2 min-h-[44px] mb-8 font-black text-sm text-white underline decoration-2 underline-offset-4 focus:outline-none focus:ring-4 focus:ring-bauhaus-yellow"
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                    返回講師資源站
                </Link>

                <div className="max-w-3xl">
                    <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tight leading-[0.95] text-balance">
                        {title}
                    </h1>
                    <p className="mt-6 max-w-[70ch] text-base sm:text-lg leading-relaxed text-white/90 font-medium">
                        {summary}
                    </p>
                    <p className="mt-6 inline-flex items-center gap-2 bg-bauhaus-yellow text-bauhaus-black border-2 border-bauhaus-black rounded-lg px-3 py-2 text-sm font-black">
                        <CalendarDays className="w-4 h-4" aria-hidden="true" />
                        生效日期：{effectiveDate}
                    </p>
                </div>
            </div>
        </section>

        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14 lg:py-16">
            <div className="grid lg:grid-cols-[15rem_minmax(0,1fr)] gap-8 lg:gap-12 items-start">
                <aside className="lg:sticky lg:top-24">
                    <nav aria-label={`${title}章節`} className="border-2 lg:border-4 border-bauhaus-black rounded-2xl overflow-hidden bg-white shadow-hard">
                        <h2 className="bg-bauhaus-black text-white px-5 py-4 text-sm font-black tracking-wide">
                            頁面導覽
                        </h2>
                        <ol className="divide-y-2 divide-bauhaus-black/20">
                            {sections.map((section, index) => (
                                <li key={section.id}>
                                    <a
                                        href={`#${section.id}`}
                                        className="flex gap-3 min-h-[44px] px-5 py-3 text-sm font-bold hover:bg-bauhaus-yellow focus:outline-none focus:ring-4 focus:ring-inset focus:ring-bauhaus-blue"
                                    >
                                        <span className="tabular-nums text-bauhaus-blue" aria-hidden="true">
                                            {String(index + 1).padStart(2, '0')}
                                        </span>
                                        <span>{section.title}</span>
                                    </a>
                                </li>
                            ))}
                        </ol>
                    </nav>
                </aside>

                <article className="bg-white border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard-md overflow-hidden">
                    <div className="h-3 flex" aria-hidden="true">
                        <span className="flex-1 bg-bauhaus-red" />
                        <span className="flex-1 bg-bauhaus-blue" />
                        <span className="flex-1 bg-bauhaus-yellow" />
                    </div>

                    <div className="px-5 py-7 sm:px-8 sm:py-10 lg:px-12 lg:py-12">
                        {sections.map((section) => (
                            <section
                                id={section.id}
                                key={section.id}
                                className="scroll-mt-24 border-b-2 border-bauhaus-black/15 pb-9 mb-9 last:border-b-0 last:pb-0 last:mb-0"
                            >
                                <h2 className="text-2xl sm:text-3xl font-black tracking-tight mb-4 text-balance">
                                    {section.title}
                                </h2>
                                <div className="max-w-[72ch] space-y-4 text-[15px] sm:text-base leading-8 font-medium text-bauhaus-black/80 [&_a]:font-black [&_a]:text-bauhaus-blue [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-black [&_strong]:text-bauhaus-black [&_ul]:space-y-2 [&_ul]:pl-6 [&_ul]:list-disc [&_ol]:space-y-2 [&_ol]:pl-6 [&_ol]:list-decimal">
                                    {section.content}
                                </div>
                            </section>
                        ))}
                    </div>
                </article>
            </div>

            <section className="mt-10 bg-bauhaus-yellow border-2 lg:border-4 border-bauhaus-black rounded-2xl shadow-hard p-6 sm:p-8">
                <h2 className="text-xl sm:text-2xl font-black tracking-tight">對政策內容有疑問？</h2>
                <p className="mt-2 max-w-[70ch] font-medium leading-relaxed">
                    請來信說明你的姓名、聯絡方式與問題，我們會在合理範圍內協助確認與處理。
                </p>
                <a
                    href="mailto:hi@dreamcube.tw"
                    className="bh-btn bh-btn-outline mt-5 bg-white"
                >
                    <Mail className="w-5 h-5" aria-hidden="true" />
                    hi@dreamcube.tw
                </a>
            </section>
        </div>
    </div>
);

export default LegalDocumentPage;
