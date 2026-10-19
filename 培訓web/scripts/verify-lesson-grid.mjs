#!/usr/bin/env node
// 課程頁（/courses/:courseId）章節卡片改網格：以 mock Supabase 實際開頁，
// 量測桌機一列 4 個、平板 3 個、手機 2 個；同列卡片等高、標題最多兩行、整頁無橫向捲軸；無章節時顯示空狀態。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-lesson-grid');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000081';
const now = new Date().toISOString();

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'lesson-grid@test.local',
    user_metadata: { full_name: '網格測試講師' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.lesson.grid', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};

const COURSE_ID = '30000000-0000-4000-8000-000000000001';
const EMPTY_COURSE_ID = '30000000-0000-4000-8000-000000000002';
const course = {
    id: COURSE_ID, category_id: null, title: '教你怎麼教 - 各種教學項目',
    description: '本章節內容為實際教學現場的教學技巧分享，每個環將會有 1-3 種的不同教法，讓我們可以面對教學現場不同程度的孩子，也讓你可以清楚掌握講義的使用技巧。部分影片有「教你怎麼學」的系列，此系列為提供給對於該顆方塊復原還不熟悉的講師學習，如有疑問可於講師群組提出，也歡迎大家於留言處踴躍討論。',
};
// 與正式站截圖同一門課的 9 個章節；其中一個標題刻意很長，測兩行截斷
const lessonTitles = ['恐龍魔術方塊', '2x3x3 魔術方塊', '1x3x3 魔術方塊', '金字塔', '斜轉', '五魔方', '鏡面方塊與其他異形方塊的完整教學示範（長標題測試）', '3x3 魔術方塊', '2x2 魔術方塊'];
const videoCounts = [4, 3, 2, 3, 2, 5, 1, 6, 3];
const lessons = lessonTitles.map((title, i) => ({
    id: `40000000-0000-4000-8000-00000000000${i}`, course_id: COURSE_ID, title, order: i,
    tags: i === 3 ? ['新版'] : [],
}));
const contents = lessons.flatMap((lesson, i) => Array.from({ length: videoCounts[i] }, (_, k) => ({
    lesson_id: lesson.id, type: 'video', title: k === 0 ? (i === 2 ? '1x3x3 魔術方塊' : '教你怎麼教1') : `影片 ${k + 1}`,
    body: null, position_data: { x: 0, y: k * 400 },
})));
const progress = [{ lesson_id: lessons[0].id, completed: true }, { lesson_id: lessons[1].id, completed: true }];

const json = (route, data, status = 200) => route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}) },
    body: JSON.stringify(data),
});

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser);
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, session);
        return json(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) return json(route, null);
    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const acceptsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
        const q = url.searchParams;
        if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
        if (table === 'users') {
            const row = { id: userId, name: '網格測試講師', email: authUser.email, role: 'admin', created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'courses') {
            const id = (q.get('id') || '').replace('eq.', '');
            const row = id === EMPTY_COURSE_ID ? { ...course, id, title: '空課程', description: null } : course;
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'lessons') {
            const id = (q.get('course_id') || '').replace('eq.', '');
            return json(route, id === COURSE_ID ? lessons : []);
        }
        if (table === 'contents') return json(route, contents);
        if (table === 'progress') return json(route, progress);
        return json(route, acceptsObject ? null : []);
    }
    if (url.pathname.startsWith('/storage/v1/')) return json(route, []);
    return json(route, {}, 404);
}

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

const results = [];
const check = (name, condition, detail = '') => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// 量測：每張卡片的位置、標題行數；依 top 分列算每列幾張
const measure = (page) => page.evaluate(() => {
    const grid = document.querySelector('[data-testid="lesson-grid"]');
    if (!grid) return { gridVisible: false };
    const cards = [...grid.children].map(card => {
        const r = card.getBoundingClientRect();
        const title = card.querySelector('div.font-bold');
        const lh = parseFloat(getComputedStyle(title).lineHeight);
        return {
            top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
            width: Math.round(r.width), height: Math.round(r.height),
            titleLines: Math.round(title.getBoundingClientRect().height / lh),
            href: card.getAttribute('href'),
        };
    });
    const rows = {};
    cards.forEach(c => { (rows[c.top] ||= []).push(c); });
    const gridRect = grid.getBoundingClientRect();
    return {
        gridVisible: true,
        cards,
        rowSizes: Object.values(rows).map(r => r.length),
        rowHeightSpread: Object.values(rows).map(r => Math.max(...r.map(c => c.height)) - Math.min(...r.map(c => c.height))),
        gridHeight: Math.round(gridRect.height),
        gridRight: Math.round(gridRect.right),
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
});

async function run() {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const viteBin = path.join(appDir, 'node_modules', '.bin', 'vite');
    const vite = spawn(viteBin, ['--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite dev pid=${vite.pid} port=${port}`);
    let viteLog = '';
    vite.stdout.on('data', chunk => { viteLog += chunk; });
    vite.stderr.on('data', chunk => { viteLog += chunk; });
    let browser;
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* dev server starting */ }
            if (Date.now() > deadline) throw new Error(`vite dev did not start\n${viteLog}`);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});

        const newPage = async (width, height = 1000) => {
            const context = await browser.newContext({ viewport: { width, height } });
            await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
            await context.route('**/*', handleRoute);
            return { context, page: await context.newPage() };
        };

        const cases = [
            { width: 1440, cols: 4, label: '桌機' },
            { width: 1280, cols: 4, label: '桌機' },
            { width: 1024, cols: 4, label: '小筆電' },
            { width: 820, cols: 3, label: '平板' },
            { width: 375, cols: 2, label: '手機', height: 812 },
        ];
        for (const { width, cols, label, height } of cases) {
            const { context, page } = await newPage(width, height);
            await page.goto(`${base}/courses/${COURSE_ID}`, { waitUntil: 'networkidle' });
            await page.getByRole('heading', { name: course.title }).waitFor({ timeout: 15000 }).catch(async (err) => {
                console.log(`頁面未出現課程標題：url=${page.url()}\n${(await page.locator('body').innerText()).slice(0, 600)}`);
                throw err;
            });
            await page.locator('[data-testid="lesson-grid"] > a').first().waitFor();
            const m = await measure(page);
            const tag = `${width}px ${label}`;
            const expectedRows = [];
            for (let left = lessons.length; left > 0; left -= cols) expectedRows.push(Math.min(cols, left));
            check(`${tag} 9 個章節都顯示且連結正確`, m.cards.length === lessons.length
                && m.cards.every((c, i) => c.href === `/courses/${COURSE_ID}/lessons/${lessons[i].id}`));
            check(`${tag} 一列 ${cols} 個`, JSON.stringify(m.rowSizes) === JSON.stringify(expectedRows), `實際每列 ${m.rowSizes.join('/')}`);
            check(`${tag} 同一列卡片等高`, m.rowHeightSpread.every(d => d <= 1), `高度差 ${m.rowHeightSpread.join('/')}px`);
            check(`${tag} 標題最多兩行`, m.cards.every(c => c.titleLines <= 2), m.cards.map(c => c.titleLines).join('/'));
            check(`${tag} 整頁沒有橫向捲軸`, m.docOverflow <= 0, `超出 ${m.docOverflow}px`);
            check(`${tag} 每張卡片寬度至少 140px`, Math.min(...m.cards.map(c => c.width)) >= 140, `最窄 ${Math.min(...m.cards.map(c => c.width))}px`);
            console.log(`      章節區總高度 ${m.gridHeight}px（卡片高 ${m.cards[0].height}px、寬 ${m.cards[0].width}px）`);
            if (width === 1280) {
                const doneIcons = await page.locator('[data-testid="lesson-grid"] > a').nth(0).locator('svg.lucide-circle-check-big, svg.lucide-check-circle').count();
                check('1280px 已完成章節顯示勾勾、進度 2 / 9', doneIcons === 1 && await page.getByText('2 / 9 章節').isVisible());
                check('1280px 影片數標籤正確（第 1 章 4 影片）', await page.locator('[data-testid="lesson-grid"] > a').nth(0).getByText('4 影片').isVisible());
                await page.locator('[data-testid="lesson-grid"] > a').nth(2).click();
                await page.waitForURL(`**/courses/${COURSE_ID}/lessons/${lessons[2].id}`);
                check('1280px 點卡片會進入該章節', page.url().endsWith(`/lessons/${lessons[2].id}`));
                await page.goto(`${base}/courses/${COURSE_ID}`, { waitUntil: 'networkidle' });
                await page.locator('[data-testid="lesson-grid"] > a').first().waitFor();
            }
            await page.screenshot({ path: path.join(shotDir, `lesson-grid-${width}.png`), fullPage: true });
            await context.close();
        }

        // 無章節：顯示空狀態、不渲染網格
        const { context, page } = await newPage(1280);
        await page.goto(`${base}/courses/${EMPTY_COURSE_ID}`, { waitUntil: 'networkidle' });
        await page.getByText('此課程目前尚無章節').waitFor();
        check('無章節時顯示空狀態且沒有網格', await page.locator('[data-testid="lesson-grid"]').count() === 0);
        await page.screenshot({ path: path.join(shotDir, 'lesson-grid-empty-1280.png'), fullPage: true });
        await context.close();
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} PASS  screenshots: ${path.relative(appDir, shotDir)}`);
    if (failed) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
