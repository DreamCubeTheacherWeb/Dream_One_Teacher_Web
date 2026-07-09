#!/usr/bin/env node
/*
 * 手機版全站稽核 —— 建 dist 快照 → vite preview 靜態伺服 → Playwright 以手機
 * viewport（375×667 與 390×844，hasTouch+isMobile）走訪所有登入後主要路由。
 * 對每頁每寬度檢查：① 無橫向溢出（body.scrollWidth ≤ innerWidth+1）② 無 pageerror
 * （白屏 crash）③ 觸控熱區 <44px 的可見互動元素清單。並在 390 寬全頁截圖。
 * 手法（假 session + mock Supabase）借自 cube-verify.mjs。
 * 用法：node scripts/mobile-audit.mjs   輸出：JSON 摘要 + scratchpad 截圖
 */
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4207;
const BASE = `http://localhost:${PORT}`;
const SHOTS = '/private/tmp/claude-501/-Users-lazylazy-Desktop------Dream-One-Teacher-Web/4e45b87d-cf83-4040-9114-e8af4d526b9b/scratchpad/mobile-audit-shots';
mkdirSync(SHOTS, { recursive: true });

const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));

// ── 假登入 session ───────────────────────────────────────────────────
const envMap = Object.fromEntries(readFileSync(path.join(APP_DIR, '.env'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const PROJECT_REF = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const UID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date().toISOString();
const FAKE_AUTH_USER = {
    id: UID, aud: 'authenticated', role: 'authenticated', email: 'audit@test.local',
    email_confirmed_at: NOW, confirmed_at: NOW, last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '稽核測試員', avatar_url: '' }, identities: [], created_at: NOW, updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.a', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.r', user: FAKE_AUTH_USER,
};
const SELF = { id: UID, name: '稽核測試員', email: 'audit@test.local', role: 'admin', level: '正式講師', created_at: NOW, updated_at: NOW };

// ── mock 內容資料（讓截圖有料，非全空）──────────────────────────────
const ANNOUNCEMENTS = Array.from({ length: 4 }, (_, i) => ({
    id: i + 1, title: `公告標題範例 ${i + 1}：師資培訓最新消息與注意事項`,
    content: '<p>這是一段公告內文，用來測試手機版排版是否正常，內容長度足以換行顯示多行文字。</p>',
    published: true, pinned: i === 0, created_at: NOW, updated_at: NOW,
}));
const COURSES = Array.from({ length: 5 }, (_, i) => ({
    id: i + 1, title: `魔術方塊教學課程 ${i + 1}`, description: '課程簡介文字，說明本課程的學習目標與內容大綱。',
    is_published: true, order: i, cover_image: '', cover_image_url: '', slug: `course-${i + 1}`,
    visibility: 'all', instructor_role: null, created_at: NOW, updated_at: NOW,
}));
const LEADERBOARD = Array.from({ length: 12 }, (_, i) => ({
    user_id: `u-${i}`, name: `講師姓名${i + 1}`, total_hours: 200 - i * 12,
    total_sessions: 40 - i, points: 2000 - i * 120, rank: i + 1, avatar_url: '',
}));
const TEACHER_STATS = {
    completed_chapters: 12, likes_received: 34, assignments_submitted: 8, completed_courses: 2,
    total_hours: 88, total_sessions: 20, points: 880,
};

function jsonRes(route, data, extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (Array.isArray(data)) headers['content-range'] = data.length ? `0-${data.length - 1}/${data.length}` : '*/0';
    return route.fulfill({ status: 200, headers, body: JSON.stringify(data) });
}

async function handleRoute(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    // Google Fonts（index.html 載入 Outfit＋Noto Sans TC）放行，否則每頁誤報 ERR_FAILED
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    const p = url.pathname;

    if (p.startsWith('/auth/v1/')) {
        if (p === '/auth/v1/user') return jsonRes(route, FAKE_AUTH_USER);
        if (p.startsWith('/auth/v1/token')) return jsonRes(route, FAKE_SESSION);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }

    if (p.startsWith('/rest/v1/rpc/')) {
        const fn = p.replace('/rest/v1/rpc/', '');
        if (fn === 'get_teaching_leaderboard') return jsonRes(route, LEADERBOARD);
        if (fn === 'get_teacher_stats') return jsonRes(route, TEACHER_STATS);
        if (fn === 'get_cube_leaderboard') return jsonRes(route, LEADERBOARD.slice(0, 8).map((r, i) => ({ ...r, best_ms: 15000 + i * 2000, mode: 'keyboard' })));
        if (fn === 'get_teaching_years') return jsonRes(route, [2026, 2025, 2024]);
        if (fn === 'search_unlinked_instructors') return jsonRes(route, []);
        return jsonRes(route, []);
    }

    if (p.startsWith('/rest/v1/')) {
        const table = p.replace('/rest/v1/', '').split('/')[0];
        const method = req.method();
        const accept = (await req.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');
        if (method !== 'GET') return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });
        let data;
        switch (table) {
            case 'users': data = wantsObject ? SELF : [SELF]; break;
            case 'announcements': data = ANNOUNCEMENTS; break;
            case 'courses': data = wantsObject ? COURSES[0] : COURSES; break;
            case 'instructors': data = wantsObject ? null : []; break;
            default: data = wantsObject ? null : [];
        }
        return jsonRes(route, data);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

// 以 admin 身分能看到的主要路由（:id 頁另用 mock course）
const ROUTES = [
    ['home', '/'], ['profile', '/profile'], ['courses', '/courses'],
    ['course-detail', '/courses/1'], ['lesson-detail', '/courses/1/lessons/1'],
    ['leaderboard', '/leaderboard'], ['cube', '/cube'], ['pending', '/pending'],
    ['contract', '/contract'], ['my-salary', '/my/salary'], ['my-salary-new', '/my/salary/new'],
    ['admin', '/admin'], ['admin-teachers', '/admin/teachers'], ['admin-instructors', '/admin/instructors'],
    ['admin-claims', '/admin/claims'], ['admin-contracts', '/admin/contracts'], ['admin-salary', '/admin/salary'],
    ['admin-assignments', '/admin/assignments'], ['admin-progress', '/admin/progress'],
    ['admin-announcements', '/admin/announcements'], ['admin-download', '/admin/download-center'],
    ['admin-cms', '/admin/cms/1'],
];
const WIDTHS = [{ w: 375, h: 667 }, { w: 390, h: 844 }];

async function waitForServer(url, timeoutMs) {
    const start = Date.now();
    for (;;) {
        try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch { /* not up */ }
        if (Date.now() - start > timeoutMs) throw new Error(`server timeout ${url}`);
        await new Promise((r) => setTimeout(r, 300));
    }
}

async function auditPage(context, name, route, width, height, screenshot) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push('console:' + m.text().slice(0, 120)); });
    try {
        await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
    } catch (e) { errors.push('goto:' + e.message.slice(0, 80)); }
    await page.waitForTimeout(700);

    const metrics = await page.evaluate(() => {
        const sw = document.body.scrollWidth;
        const iw = window.innerWidth;
        // 找出真正造成溢出的元素
        const offenders = [];
        if (sw > iw + 1) {
            for (const el of document.querySelectorAll('*')) {
                const r = el.getBoundingClientRect();
                if (r.right > iw + 1 && r.width > 0 && r.left >= 0) {
                    offenders.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').slice(0, 2).join('.')} right=${Math.round(r.right)}`);
                    if (offenders.length >= 4) break;
                }
            }
        }
        // 觸控熱區 <44 的可見互動元素
        const small = [];
        for (const el of document.querySelectorAll('button, a[href], [role="button"], input[type="checkbox"], input[type="radio"]')) {
            const r = el.getBoundingClientRect();
            const st = getComputedStyle(el);
            if (r.width === 0 || r.height === 0 || st.visibility === 'hidden' || st.display === 'none') continue;
            if (r.top > window.innerHeight || r.bottom < 0) continue; // 只看首屏可見
            if ((r.width < 44 || r.height < 44)) {
                const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24);
                small.push(`${Math.round(r.width)}x${Math.round(r.height)} "${label}"`);
            }
        }
        const bodyEmpty = document.body.innerText.trim().length < 5;
        return { sw, iw, overflow: sw > iw + 1, offenders, small: small.slice(0, 8), smallCount: small.length, bodyEmpty };
    });

    if (screenshot) {
        try { await page.screenshot({ path: `${SHOTS}/${name}-${width}.png`, fullPage: true }); } catch { /* ignore */ }
    }
    await page.close();
    return { name, route, width, ...metrics, errors: errors.slice(0, 5), errorCount: errors.length };
}

async function main() {
    console.log('── npm run build ──');
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    console.log(`── vite preview :${PORT} ──`);
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    preview.stdout.on('data', () => {});
    preview.stderr.on('data', () => {});

    let browser;
    const all = [];
    try {
        await waitForServer(BASE, 15000);
        browser = await chromium.launch();
        const context = await browser.newContext({
            viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
            hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
        });
        await context.addInitScript(({ key, session }) => { window.localStorage.setItem(key, JSON.stringify(session)); }, { key: STORAGE_KEY, session: FAKE_SESSION });
        await context.route('**/*', handleRoute);

        for (const [name, route] of ROUTES) {
            for (const { w, h } of WIDTHS) {
                const r = await auditPage(context, name, route, w, h, w === 390);
                all.push(r);
                const flags = [];
                if (r.overflow) flags.push(`OVERFLOW(${r.sw}>${r.iw}) ${r.offenders.join(' | ')}`);
                if (r.errorCount) flags.push(`ERR:${r.errors.join(' ; ')}`);
                if (r.bodyEmpty) flags.push('EMPTY-BODY');
                if (r.smallCount) flags.push(`SMALL-TAP x${r.smallCount}: ${r.small.join(', ')}`);
                console.log(`${flags.length ? 'FLAG' : ' ok '} ${name} @${w}  ${flags.join('  ||  ')}`);
            }
        }
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }

    writeFileSync(`${SHOTS}/audit-summary.json`, JSON.stringify(all, null, 2));
    const flagged = all.filter((r) => r.overflow || r.errorCount || r.bodyEmpty || r.smallCount);
    console.log(`\n=== 摘要：${all.length} 檢查，${flagged.length} 有旗標 ===`);
    console.log(`overflow: ${all.filter((r) => r.overflow).length}  |  pageerror: ${all.filter((r) => r.errorCount).length}  |  empty-body: ${all.filter((r) => r.bodyEmpty).length}  |  small-tap 頁數: ${new Set(all.filter((r) => r.smallCount).map((r) => r.name)).size}`);
    console.log(`截圖目錄：${SHOTS}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
