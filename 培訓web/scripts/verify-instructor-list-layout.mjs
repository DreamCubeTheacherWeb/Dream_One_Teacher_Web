#!/usr/bin/env node
// 後台「講師資料總覽」表格版面：以 mock Supabase 實際開頁（1024／1280／1440 桌機＋900 平板），
// 量測表頭與標籤都只佔一行、表格不超出外框（最右邊按鈕沒被切掉）、Email 截斷時滑過看得到全文。
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
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-instructor-list-layout');
mkdirSync(shotDir, { recursive: true });

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.includes('='))
    .map(line => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000071';
const now = new Date().toISOString();

const authUser = {
    id: userId, aud: 'authenticated', role: 'authenticated', email: 'layout-admin@test.local',
    user_metadata: { full_name: '版面測試管理員' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
};
const session = {
    access_token: 'mock.instructor.layout', refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(Date.now() / 1000) + 31536000, user: authUser,
};

const LONG_EMAIL = 'easonchiang123456789@gmail.com';
const VERY_LONG_EMAIL = 'a.really.long.instructor.address.for.layout@example-school.edu.tw';
const docs = { id_front_url: 'x', id_back_url: 'x', bankbook_url: 'x' };
const instructorsSeed = [
    { full_name: '楊宙學', email_primary: 'miemieyang0622@gmail.com', employment_status: 'active', instructor_role: '實習', teaching_regions: ['臺北市'], ...docs },
    { full_name: '羅青昊', email_primary: 'hanklovanda06@gmail.com', employment_status: 'active', instructor_role: '實習', teaching_regions: ['新北市'], ...docs },
    { full_name: '方羿淳', email_primary: 'fangyichun422@gmail.com', employment_status: 'active', instructor_role: 'A+', speed_qualification: 'speed_master', teaching_regions: ['臺中市', '彰化縣'], ...docs },
    { full_name: '江鎧任', email_primary: LONG_EMAIL, employment_status: 'active', instructor_role: '實習', teaching_regions: ['高雄市'], ...docs },
    { full_name: '歐陽長名字', email_primary: VERY_LONG_EMAIL, employment_status: 'cancelled', instructor_role: null, speed_qualification: 'speed_teacher', teaching_regions_raw: '臺北市、新北市、桃園市、新竹縣（週末可）' },
    { full_name: '林已認領', email_primary: 'linked@example.com', employment_status: 'frozen', instructor_role: 'S', user_id: userId, teaching_regions: [] },
    { full_name: '無信箱', email_primary: null, employment_status: 'part_time', instructor_role: 'B', teaching_regions: ['臺南市'], id_front_url: 'x' },
].map((row, i) => ({
    id: `20000000-0000-4000-8000-0000000000${String(i + 10)}`,
    user_id: null, speed_qualification: null, teaching_regions: null, teaching_regions_raw: null,
    created_at: new Date(Date.now() - i * 60000).toISOString(),
    ...row,
}));

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
        if (request.method() !== 'GET') return json(route, acceptsObject ? {} : [], 201);
        if (table === 'users') {
            const row = { id: userId, name: '版面測試管理員', email: authUser.email, role: 'admin', created_at: now };
            return json(route, acceptsObject ? row : [row]);
        }
        if (table === 'instructors') {
            return acceptsObject ? json(route, instructorsSeed[5]) : json(route, instructorsSeed);
        }
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

// 在頁面裡量測：每個表頭／標籤／按鈕的文字佔幾行、表格是否超出外框
const measure = (page) => page.evaluate(() => {
    // 只看文字本身（圖示高度不同不算），文字的垂直跨度 ÷ 單行高度 ＝ 行數
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
    const table = document.querySelector('table');
    const wrapper = table?.parentElement;
    const visible = (el) => el && el.offsetParent !== null;
    if (!visible(table)) return { tableVisible: false };
    const wrapRect = wrapper.getBoundingClientRect();
    const headers = [...table.querySelectorAll('thead th')].map(th => ({ text: th.innerText.trim(), lines: lineCount(th) }));
    const chips = [...table.querySelectorAll('tbody span.bh-chip')].map(el => ({ text: el.innerText.trim(), lines: lineCount(el) }));
    const selects = [...table.querySelectorAll('tbody select')].map(el => Math.round(el.getBoundingClientRect().height));
    const buttons = [...table.querySelectorAll('tbody .bh-btn')].map(el => {
        const r = el.getBoundingClientRect();
        return { text: el.innerText.trim(), lines: lineCount(el), right: r.right, clipped: r.right > wrapRect.right - 2 };
    });
    const names = [...table.querySelectorAll('tbody tr td:first-child span.font-bold')].map(el => ({ text: el.innerText.trim(), lines: lineCount(el) }));
    const rows = [...table.querySelectorAll('tbody > tr')].map(tr => Math.round(tr.getBoundingClientRect().height));
    const emailCells = [...table.querySelectorAll('tbody tr td:first-child div[title]')].map(el => ({
        title: el.getAttribute('title'), truncated: el.scrollWidth > el.clientWidth, lines: lineCount(el),
    }));
    // 「操作」表頭文字的左緣 vs 第一顆按鈕的左緣
    const ths = [...table.querySelectorAll('thead th')];
    const thText = (th) => { const r = document.createRange(); r.selectNodeContents(th); return r.getBoundingClientRect(); };
    const firstBtn = table.querySelector('tbody tr td:last-child .bh-btn');
    const actionHeaderOffset = firstBtn ? Math.round(Math.abs(thText(ths[6]).left - firstBtn.getBoundingClientRect().left)) : null;
    // 精簡欄（第 2～7 欄）：欄寬扣掉左右留白後，和該欄最寬內容的差距（越小代表沒有多餘空白）
    const slack = ths.slice(1).map((th, idx) => {
        const col = idx + 1;
        const cs = getComputedStyle(th);
        const inner = th.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const contentWidths = [...table.querySelectorAll(`tbody > tr > td:nth-child(${col + 1})`)].filter(td => td.colSpan === 1).map(td => {
            const kids = [...td.children];
            return kids.length ? Math.max(...kids.map(k => k.getBoundingClientRect().width)) : 0;
        });
        const headerWidth = thText(th).width;
        return { text: th.innerText.trim(), slack: Math.round(inner - Math.max(headerWidth, ...contentWidths)) };
    });
    return {
        tableVisible: true, actionHeaderOffset, slack,
        wrapperOverflow: wrapper.scrollWidth - wrapper.clientWidth,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        headers, chips, selects, buttons, names, rows, emailCells,
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

        for (const width of [1024, 1280, 1440]) {
            const context = await browser.newContext({ viewport: { width, height: 1000 } });
            await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
            await context.route('**/*', handleRoute);
            const page = await context.newPage();
            await page.goto(`${base}/admin/instructors`, { waitUntil: 'networkidle' });
            await page.getByRole('heading', { name: '講師資料總覽' }).waitFor();
            await page.locator('table tbody tr').first().waitFor();
            const m = await measure(page);
            const tag = `${width}px`;
            check(`${tag} 桌機表格顯示`, m.tableVisible);
            check(`${tag} 表頭 7 欄且每欄只佔一行`, m.headers.length === 7 && m.headers.every(h => h.lines === 1),
                m.headers.filter(h => h.lines !== 1).map(h => `${h.text}=${h.lines}行`).join('、'));
            check(`${tag} 所有標籤（任職／綁定／速解／文件）都只佔一行`, m.chips.length > 0 && m.chips.every(c => c.lines === 1),
                m.chips.filter(c => c.lines !== 1).map(c => `${c.text}=${c.lines}行`).join('、') || `${m.chips.length} 個`);
            check(`${tag} 姓名不換行`, m.names.every(n => n.lines === 1));
            check(`${tag} 等級下拉選單高度一致（單行）`, m.selects.length === instructorsSeed.length && Math.max(...m.selects) <= 26, m.selects.join('/'));
            check(`${tag} 操作按鈕都只佔一行且沒被外框切掉`, m.buttons.length > 0 && m.buttons.every(b => b.lines === 1 && !b.clipped),
                m.buttons.filter(b => b.lines !== 1 || b.clipped).map(b => b.text).join('、') || `${m.buttons.length} 顆`);
            check(`${tag} 表格寬度不超出外框（不需橫向捲動）`, m.wrapperOverflow <= 0, `超出 ${m.wrapperOverflow}px`);
            check(`${tag} 整頁沒有橫向捲軸`, m.docOverflow <= 0, `超出 ${m.docOverflow}px`);
            check(`${tag} 每列高度一致且不超過 80px`, Math.max(...m.rows) <= 80 && Math.max(...m.rows) - Math.min(...m.rows) <= 4, m.rows.join('/'));
            check(`${tag} 「操作」標題對準第一顆按鈕（左緣差 ≤ 2px）`, m.actionHeaderOffset !== null && m.actionHeaderOffset <= 2, `差 ${m.actionHeaderOffset}px`);
            check(`${tag} 綁定～操作各欄沒有多餘空白（欄寬貼齊內容，差 ≤ 2px）`, m.slack.every(c => c.slack <= 2),
                m.slack.map(c => `${c.text}+${c.slack}`).join(' '));
            const commonCell = m.emailCells.find(e => e.title === LONG_EMAIL);
            check(`${tag} 一般長度 Email（${LONG_EMAIL}）完整顯示不截斷`, commonCell && !commonCell.truncated);
            const longCell = m.emailCells.find(e => e.title === VERY_LONG_EMAIL);
            check(`${tag} 超長 Email 只佔一行、被截斷但滑過看得到全文`, longCell && longCell.lines === 1 && longCell.truncated);
            if (width === 1280) {
                const editNames = await page.getByRole('link', { name: '編輯資料' }).count();
                const previewNames = await page.getByRole('button', { name: '預覽表單' }).count();
                check('1280px 按鈕完整文字「編輯資料／預覽表單」可見', m.buttons.some(b => b.text === '編輯資料') && m.buttons.some(b => b.text === '預覽表單'));
                check('1280px 既有驗證腳本用的按鈕名稱仍找得到（每列一顆）', editNames === instructorsSeed.length && previewNames === instructorsSeed.length, `${editNames}/${previewNames}`);
            }
            if (width === 1024) {
                const editNames = await page.getByRole('link', { name: '編輯資料' }).count();
                check('1024px 按鈕縮成「編輯／預覽」但無障礙名稱仍是完整名稱', m.buttons.some(b => b.text === '編輯') && editNames === instructorsSeed.length);
            }
            await page.screenshot({ path: path.join(shotDir, `table-${width}.png`), fullPage: true });
            // 展開一列確認展開區跨滿 7 欄
            await page.locator('table tbody tr').first().locator('td').first().click();
            const expandedSpan = await page.evaluate(() => document.querySelector('table tbody tr:nth-child(2) td')?.colSpan);
            check(`${tag} 展開列跨滿 7 欄`, expandedSpan === 7, `colSpan=${expandedSpan}`);
            await context.close();
        }

        // 平板寬度：改用卡片版，不出現被擠爆的表格
        const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
        await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
        await context.route('**/*', handleRoute);
        const page = await context.newPage();
        await page.goto(`${base}/admin/instructors`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '講師資料總覽' }).waitFor();
        await page.getByText('江鎧任').first().waitFor();
        const tablet = await measure(page);
        check('900px 改顯示卡片、表格隱藏', !tablet.tableVisible);
        check('900px 整頁沒有橫向捲軸', await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0);
        const cardInfo = await page.evaluate(() => {
            const cards = [...document.querySelectorAll('.lg\\:hidden > .bh-card')];
            return cards.map(card => {
                const edit = [...card.querySelectorAll('a.bh-btn')].find(a => a.innerText.includes('編輯資料'));
                return { text: card.innerText, editLeft: edit ? Math.round(edit.getBoundingClientRect().left) : null };
            });
        });
        const lefts = cardInfo.map(c => c.editLeft);
        check('900px 每張卡片的「編輯資料」按鈕左右位置一致', cardInfo.length === instructorsSeed.length && lefts.every(l => l !== null && l === lefts[0]), lefts.join('/'));
        check('900px 卡片地區顯示「N 個縣市」而非單一數字', cardInfo.filter(c => c.text.includes('個縣市')).length === instructorsSeed.filter(r => r.teaching_regions?.length).length);
        await page.screenshot({ path: path.join(shotDir, 'cards-900.png'), fullPage: true });
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
