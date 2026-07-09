#!/usr/bin/env node
/*
 * 復現／驗證「填完資料才能瀏覽」關卡（components/ProfileCompleteGate.jsx）。
 * 假 session + mock Supabase（手法借 verify-profile-draft.mjs），真瀏覽器。
 * 情境（開 /courses 看最終落點）：
 *  R1 teacher + 無 instructors 列          → 應導回 /profile
 *  R2 teacher + 文字欄齊但缺照片(似認領列) → 應導回 /profile
 *  R3 teacher + 全齊(含4張照片路徑)        → 應留在 /courses
 * 用法：node scripts/verify-complete-gate.mjs
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4215;
const BASE = `http://localhost:${PORT}`;
const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));

const envMap = Object.fromEntries(readFileSync(path.join(APP_DIR, '.env'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const PROJECT_REF = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const UID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date().toISOString();
const FAKE_AUTH_USER = {
    id: UID, aud: 'authenticated', role: 'authenticated', email: 'gate@test.local',
    email_confirmed_at: NOW, confirmed_at: NOW, last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '關卡復現員', avatar_url: '' }, identities: [], created_at: NOW, updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.a', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.r', user: FAKE_AUTH_USER,
};
const SELF = { id: UID, name: '關卡復現員', email: 'gate@test.local', role: 'teacher', created_at: NOW, updated_at: NOW };

// Gate 的必填清單（與 ProfileCompleteGate.jsx 對齊；instructor_role 已移除）
const TEXT_KEYS = ['full_name','nickname','gender','birth_date','id_number','phone_mobile','line_id',
    'address','email_primary','teaching_freq_semester','teaching_freq_vacation','bio_notes',
    'bank_account_name','bank_name','bank_branch','bank_account_number','bank_code'];

let instructorRow = null; // 每情境切換

const textFilled = { id: 'inst-1', user_id: UID, teaching_regions: ['臺北市'], instructor_role: null,
    photo_path: null, id_front_path: null, id_back_path: null, bankbook_path: null, hide_from_leaderboard: false };
for (const k of TEXT_KEYS) textFilled[k] = '有值';
const allComplete = { ...textFilled, photo_path: 'u/p.jpg', id_front_path: 'u/f.jpg', id_back_path: 'u/b.jpg', bankbook_path: 'u/k.jpg' };

function jsonRes(route, data, extra = {}) {
    const headers = { 'content-type': 'application/json', ...extra };
    if (Array.isArray(data)) headers['content-range'] = data.length ? `0-${data.length - 1}/${data.length}` : '*/0';
    return route.fulfill({ status: 200, headers, body: JSON.stringify(data) });
}
async function handleRoute(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    const p = url.pathname;
    if (p.startsWith('/auth/v1/')) {
        if (p === '/auth/v1/user') return jsonRes(route, FAKE_AUTH_USER);
        if (p.startsWith('/auth/v1/token')) return jsonRes(route, FAKE_SESSION);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    if (p.startsWith('/rest/v1/rpc/')) return jsonRes(route, []);
    if (p.startsWith('/rest/v1/')) {
        const table = p.replace('/rest/v1/', '').split('/')[0];
        const method = req.method();
        const accept = (await req.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');
        if (method !== 'GET') return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });
        let data;
        switch (table) {
            case 'users': data = wantsObject ? SELF : [SELF]; break;
            case 'instructors': data = wantsObject ? instructorRow : (instructorRow ? [instructorRow] : []); break;
            default: data = wantsObject ? null : [];
        }
        return jsonRes(route, data);
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}
async function waitForServer(url, timeoutMs) {
    const start = Date.now();
    for (;;) {
        try { const r = await fetch(url); if (r.ok || r.status === 404) return; } catch { /* not up */ }
        if (Date.now() - start > timeoutMs) throw new Error(`server timeout ${url}`);
        await new Promise((r) => setTimeout(r, 300));
    }
}
const results = [];
const assert = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

async function landing(browser) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(({ key, session }) => { window.localStorage.setItem(key, JSON.stringify(session)); }, { key: STORAGE_KEY, session: FAKE_SESSION });
    await ctx.route('**/*', handleRoute);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 100)));
    await page.goto(`${BASE}/courses`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(1500); // 等 gate 的 fetch + navigate
    const url = page.url();
    if (errs.length) console.log('   pageerrors:', errs.slice(0, 3).join(' | '));
    await page.close(); await ctx.close();
    if (url.includes('/profile')) return 'profile';
    if (url.includes('/courses')) return 'courses';
    return url;
}

async function main() {
    console.log('── npm run build ──');
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser;
    try {
        await waitForServer(BASE, 15000);
        browser = await chromium.launch();
        let L;
        instructorRow = null; L = await landing(browser);
        assert('R1 無 instructors 列 → 導回 /profile', L === 'profile', `landed=${L}`);
        instructorRow = textFilled; L = await landing(browser);
        assert('R2 文字齊但缺 4 照片(似認領列) → 導回 /profile', L === 'profile', `landed=${L}`);
        instructorRow = allComplete; L = await landing(browser);
        assert('R3 全齊 → 留在 /courses', L === 'courses', `landed=${L}`);
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
