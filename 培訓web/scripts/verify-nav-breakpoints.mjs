#!/usr/bin/env node
// 頂端導覽列斷點：以 mock Supabase 實際開頁（管理員＋講師，768～1440 各寬度），
// 量測 1280px 以下改用漢堡選單、1280px 以上桌機選單每個項目都只佔一行、不超出版心、不壓到 Logo。
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
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-nav-breakpoints');
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
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'nav-check@test.local',
    user_metadata: { full_name: '導覽列測試帳號' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.nav.breakpoints', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};
// 講師主檔填齊，「教材資源」才會是可點的連結（項目最多的情況）
const instructorRow = {
    id: '20000000-0000-4000-8000-000000000081', user_id: userId, full_name: '導覽列測試講師名字很長',
    email_primary: authUser.email, employment_status: 'active', instructor_role: 'A',
    id_front_url: 'x', id_back_url: 'x', bankbook_url: 'x', created_at: now, updated_at: now,
};

const json = (route, data, status = 200) => route.fulfill({
    status,
    headers: { 'content-type': 'application/json', ...(Array.isArray(data) ? { 'content-range': data.length ? `0-${data.length - 1}/${data.length}` : '*/0' } : {}) },
    body: JSON.stringify(data),
});

const routeFor = (role) => async (route) => {
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
        if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
        if (table === 'users') {
            const row = { id: userId, name: '導覽列測試講師名字很長', email: authUser.email, role, created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructors') return json(route, acceptsObject ? instructorRow : [instructorRow]);
        return json(route, acceptsObject ? null : []);
    }
    if (url.pathname.startsWith('/storage/v1/')) return json(route, []);
    return json(route, {}, 404);
};

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

const measure = (page) => page.evaluate(() => {
    // 文字的垂直跨度 ÷ 單行高度 ＝ 行數（圖示不算）
    const lineCount = (el) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const rects = [];
        while (walker.nextNode()) {
            if (!walker.currentNode.textContent.trim()) continue;
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            rects.push(...[...range.getClientRects()].filter(r => r.width > 0 && r.height > 0));
        }
        if (!rects.length) return 0;
        const lineHeight = Math.min(...rects.map(r => r.height));
        const span = Math.max(...rects.map(r => r.bottom)) - Math.min(...rects.map(r => r.top));
        return Math.round(span / lineHeight);
    };
    const header = document.querySelector('header');
    const container = header.firstElementChild;
    const containerRect = container.getBoundingClientRect();
    const contentRight = containerRect.right - parseFloat(getComputedStyle(container).paddingRight);
    const logo = header.querySelector('a[href="/"]');
    const nav = header.querySelector('nav');
    const navVisible = Boolean(nav) && getComputedStyle(nav).display !== 'none';
    const burger = header.querySelector('button[aria-label$="選單"]');
    const burgerVisible = Boolean(burger) && burger.getClientRects().length > 0;
    const items = navVisible
        ? [...nav.querySelectorAll(':scope > a, :scope > button')].map(el => ({ text: el.innerText.trim(), lines: lineCount(el) }))
        : [];
    const roleChip = navVisible ? [...nav.querySelectorAll('a[href="/profile"] span')].pop() : null;
    const navRect = navVisible ? nav.getBoundingClientRect() : null;
    const bell = [...header.querySelectorAll('button[aria-label="通知"]')].find(el => el.getClientRects().length > 0);
    const bellRect = bell?.getBoundingClientRect();
    const burgerRect = burgerVisible ? burger.getBoundingClientRect() : null;
    return {
        bellSize: bellRect ? [Math.round(bellRect.width), Math.round(bellRect.height)] : null,
        burgerSize: burgerRect ? [Math.round(burgerRect.width), Math.round(burgerRect.height)] : null,
        navVisible, burgerVisible, items,
        roleChipLines: roleChip ? lineCount(roleChip) : null,
        navOverflow: navRect ? Math.round(navRect.right - contentRight) : null,
        logoGap: navRect ? Math.round(navRect.left - logo.getBoundingClientRect().right) : null,
        headerHeight: Math.round(header.getBoundingClientRect().height),
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

        for (const role of ['admin', 'teacher']) {
            const expectedItems = role === 'admin' ? 7 : 6;
            for (const width of [768, 820, 1024, 1100, 1279, 1280, 1366, 1440]) {
                const tag = `${role} ${width}px`;
                const context = await browser.newContext({ viewport: { width, height: 800 } });
                await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
                await context.route('**/*', routeFor(role));
                const page = await context.newPage();
                await page.goto(`${base}/profile`, { waitUntil: 'networkidle' });
                await page.locator('header').waitFor();
                // 等角色載入（個人資料連結一定在，管理員還要等「後台管理」）
                await page.waitForFunction(() => document.querySelector('header')?.innerText.includes('個人資料') || document.querySelector('header button[aria-label$="選單"]'));
                await page.waitForTimeout(400);
                const m = await measure(page);
                if (width < 1280) {
                    check(`${tag} 改用漢堡選單、桌機選單隱藏`, m.burgerVisible && !m.navVisible);
                    check(`${tag} 整頁沒有橫向捲軸`, m.docOverflow <= 0, `超出 ${m.docOverflow}px`);
                    check(`${tag} 通知鈴鐺可點範圍至少 44px（與手機版同大，不是桌機的縮小版）`,
                        m.bellSize && m.bellSize[0] >= 44 && m.bellSize[1] >= 44,
                        `鈴鐺 ${m.bellSize?.join('×')}／漢堡 ${m.burgerSize?.join('×')}`);
                    await page.getByRole('button', { name: '開啟選單' }).click();
                    const menuText = await page.locator('header').innerText();
                    const wanted = role === 'admin' ? ['我的課程', '個人資料', '我的報酬', '後台管理'] : ['我的課程', '個人資料', '我的報酬'];
                    check(`${tag} 漢堡選單展開後看得到 ${wanted.join('／')}`, wanted.every(w => menuText.includes(w)));
                    check(`${tag} 展開後按鈕改為「關閉選單」`, await page.getByRole('button', { name: '關閉選單' }).isVisible());
                    if (width === 820 || width === 1100) await page.screenshot({ path: path.join(shotDir, `${role}-${width}-menu-open.png`) });
                } else {
                    check(`${tag} 顯示桌機選單、漢堡隱藏`, m.navVisible && !m.burgerVisible);
                    check(`${tag} 選單有 ${expectedItems} 個項目`, m.items.length === expectedItems, m.items.map(i => i.text).join('／'));
                    check(`${tag} 每個選單項目都只佔一行`, m.items.length > 0 && m.items.every(i => i.lines === 1), m.items.filter(i => i.lines !== 1).map(i => `${i.text}=${i.lines}行`).join('、'));
                    check(`${tag} 角色徽章只佔一行`, m.roleChipLines === 1, `${m.roleChipLines} 行`);
                    check(`${tag} 選單沒有超出版心右緣`, m.navOverflow !== null && m.navOverflow <= 0, `超出 ${m.navOverflow}px`);
                    check(`${tag} 選單沒有壓到 Logo`, m.logoGap !== null && m.logoGap >= 8, `間距 ${m.logoGap}px`);
                    check(`${tag} 頂端列高度維持 68px（64＋底線 4）`, m.headerHeight === 68, `${m.headerHeight}px`);
                    check(`${tag} 整頁沒有橫向捲軸`, m.docOverflow <= 0, `超出 ${m.docOverflow}px`);
                    if (width === 1280 || width === 1440) await page.screenshot({ path: path.join(shotDir, `${role}-${width}.png`) });
                }
                await context.close();
            }
        }
    } finally {
        if (browser) await browser.close();
        vite.kill('SIGTERM');
    }
    const passed = results.filter(Boolean).length;
    console.log(`\n${passed}/${results.length} ${passed === results.length ? 'PASS' : 'FAIL'}  screenshots: docs/verification/2026-10-20-nav-breakpoints`);
    process.exit(passed === results.length ? 0 : 1);
}

run().catch(error => { console.error(error); process.exit(1); });
