#!/usr/bin/env node
/*
 * 回歸驗證：講師名單管理（/admin/teachers）切換講師等級。
 * 修的 bug：切換後 optimistic 更新寫錯 map key（少 user: 前綴）→ 下拉立刻彈回舊值。
 * 斷言：
 *  A1 切換後 PATCH 請求 body 含 {"instructor_role":"S"}
 *  A2 切換後 800ms，下拉仍顯示新值（不彈回）
 * 手法：假 admin session + mock Supabase（借 verify-profile-draft.mjs），真瀏覽器。
 * 用法：node scripts/verify-level-switch.mjs
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4217;
const BASE = `http://localhost:${PORT}`;
const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));

const envMap = Object.fromEntries(readFileSync(path.join(APP_DIR, '.env'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const PROJECT_REF = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const ADMIN_ID = '00000000-0000-4000-8000-00000000000a';
const TEACHER_ID = '00000000-0000-4000-8000-00000000000b';
const NOW = new Date().toISOString();
const FAKE_AUTH_USER = {
    id: ADMIN_ID, aud: 'authenticated', role: 'authenticated', email: 'admin@test.local',
    email_confirmed_at: NOW, confirmed_at: NOW, last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '測試管理員', avatar_url: '' }, identities: [], created_at: NOW, updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.a', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.r', user: FAKE_AUTH_USER,
};
const USERS = [
    { id: ADMIN_ID, name: '測試管理員', email: 'admin@test.local', role: 'admin', created_at: NOW, updated_at: NOW, mentor_name: null },
    { id: TEACHER_ID, name: '測試老師', email: 'teacher@test.local', role: 'teacher', created_at: NOW, updated_at: NOW, mentor_name: null },
];
// 老師的 instructors 列：已綁定、目前等級 B
const INSTRUCTORS = [{
    id: 'inst-0001', user_id: TEACHER_ID, full_name: '測試老師', nickname: '小測', gender: '男',
    birth_date: '1990-01-01', id_number: 'A123456789', phone_mobile: '0912345678', line_id: 't',
    address: 'x', household_address: 'x', email_primary: 'teacher@test.local', instructor_role: 'B',
    teaching_freq_semester: 'x', teaching_freq_vacation: 'x', teaching_regions: ['臺北市'], bio_notes: 'x',
    bank_account_name: 'x', bank_name: 'x', bank_branch: 'x', bank_account_number: 'x', bank_code: 'x',
    photo_path: 'u/p.jpg', id_front_path: 'u/f.jpg', id_back_path: 'u/b.jpg', bankbook_path: 'u/k.jpg',
    employment_status: 'active', created_at: NOW, hide_from_leaderboard: false,
}];

const patches = []; // 記錄送出的 PATCH body

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
        if (method === 'PATCH' && table === 'instructors') {
            patches.push(req.postData() || '');
            return route.fulfill({ status: 204, headers: { 'content-type': 'application/json' }, body: '' });
        }
        if (method !== 'GET') return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: '[]' });
        const accept = (await req.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');
        let data;
        switch (table) {
            case 'users': {
                // AuthContext 會帶 id=eq. 查自己;列表查全部
                const idq = url.searchParams.get('id');
                const rows = idq ? USERS.filter(u => `eq.${u.id}` === idq) : USERS;
                data = wantsObject ? (rows[0] || null) : rows; break;
            }
            case 'instructors': {
                const uq = url.searchParams.get('user_id');
                const rows = uq ? INSTRUCTORS.filter(i => `eq.${i.user_id}` === uq) : INSTRUCTORS;
                data = wantsObject ? (rows[0] || null) : rows; break;
            }
            case 'teacher_invites': data = []; break;
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

async function main() {
    console.log('── npm run build ──');
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser;
    try {
        await waitForServer(BASE, 15000);
        browser = await chromium.launch();
        const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await ctx.addInitScript(({ key, session }) => { window.localStorage.setItem(key, JSON.stringify(session)); }, { key: STORAGE_KEY, session: FAKE_SESSION });
        await ctx.route('**/*', handleRoute);
        const page = await ctx.newPage();
        await page.goto(`${BASE}/admin/teachers`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(800);

        // debug: 頁面文字與可見分頁
        console.log('BODYTEXT:', (await page.evaluate(() => document.body.innerText.replace(/\s+/g,' ').slice(0,400))));
        // 切到「講師名冊」以外、含使用者列的分頁：直接找含「已登入」或「講師 (」字樣的 tab
        for (const t of ['已登入講師','講師名冊','全部']) {
            const tab = page.getByText(new RegExp(t)).first();
            if (await tab.count()) { await tab.click().catch(()=>{}); await page.waitForTimeout(300); }
            const hit = await page.locator('text=測試老師').count();
            console.log('TAB', t, 'hit 測試老師:', hit, 'selects:', await page.locator('select').count());
            if (hit) break;
        }
        const row = page.locator('div,tr').filter({ hasText: '測試老師' }).filter({ has: page.locator('select') }).last();
        // 等級下拉＝有 value="S" 選項的那個（身份/輔導員下拉沒有）
        const levelSelect = row.locator('select').filter({ has: page.locator('option[value="S"]') }).first();
        await levelSelect.waitFor({ timeout: 8000 });
        const before = await levelSelect.inputValue();

        await levelSelect.selectOption('S');
        await page.waitForTimeout(800); // 等 optimistic 更新與 re-render

        const after = await levelSelect.inputValue();
        const patchOk = patches.some(b => b.includes('"instructor_role":"S"'));
        assert('A1 PATCH body 含 instructor_role:S', patchOk, `patches=${patches.length}`);
        assert('A2 下拉維持新值不彈回', after === 'S', `before=${before} after=${after}`);

        await page.close(); await ctx.close();
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    process.exit(passed === results.length ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
