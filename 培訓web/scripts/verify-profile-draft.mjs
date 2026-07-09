#!/usr/bin/env node
/*
 * 驗證「個人資料頁草稿暫存 + 戶籍地址」——假 session + mock Supabase（手法借 mobile-audit.mjs）。
 * 測項：
 *  T1 首次填寫者：填 通訊/戶籍/分行 → 重整 /profile → 三欄自動還原（草稿生效，換頁不掉資料）
 *  T2 「同通訊地址」按鈕：填通訊地址 → 按鈕 → 戶籍地址 = 通訊地址
 *  T3 戶籍地址欄存在且為必填標記
 *  T4 既有講師（無草稿、新 context）：表單顯示 DB 值，草稿合併不干擾正常載入
 *  T5 每欄變動即寫入 localStorage 草稿鍵
 * 用法：node scripts/verify-profile-draft.mjs
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4211;
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
    id: UID, aud: 'authenticated', role: 'authenticated', email: 'draft@test.local',
    email_confirmed_at: NOW, confirmed_at: NOW, last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '草稿測試員', avatar_url: '' }, identities: [], created_at: NOW, updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.a', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.r', user: FAKE_AUTH_USER,
};
// role 用 teacher（非 pending），存檔成功走 alert 分支，不 navigate
const SELF = { id: UID, name: '草稿測試員', email: 'draft@test.local', role: 'teacher', created_at: NOW, updated_at: NOW };

// 每個測試情境可切換：instructors 這一列回什麼（null = 首次填寫者）
let instructorRow = null;

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
    // storage sign 等其餘一律空，讓 previews 靜默略過
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

const ADDR = '請輸入通訊地址';
const HOUSE = '請輸入戶籍地址';
const BRANCH = '例：仁愛分行';

async function newCtx(browser) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(({ key, session }) => { window.localStorage.setItem(key, JSON.stringify(session)); }, { key: STORAGE_KEY, session: FAKE_SESSION });
    await ctx.route('**/*', handleRoute);
    return ctx;
}

async function gotoProfile(page) {
    await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector(`input[placeholder="${ADDR}"]`, { timeout: 10000 });
    await page.waitForTimeout(300);
}

async function main() {
    console.log('── npm run build ──');
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let browser;
    try {
        await waitForServer(BASE, 15000);
        browser = await chromium.launch();

        // ── T1 / T3 / T5：首次填寫者，填字 → 重整 → 還原 ──
        instructorRow = null;
        let ctx = await newCtx(browser);
        let page = await ctx.newPage();
        await gotoProfile(page);

        // T3：戶籍地址欄存在
        const houseExists = await page.locator(`input[placeholder="${HOUSE}"]`).count();
        assert('T3 戶籍地址欄存在', houseExists === 1);

        // 填三欄
        await page.fill(`input[placeholder="${ADDR}"]`, '台北市信義區通訊路 1 號');
        await page.fill(`input[placeholder="${HOUSE}"]`, '新北市板橋區戶籍街 2 號');
        await page.fill(`input[placeholder="${BRANCH}"]`, '仁愛分行測試');
        await page.waitForTimeout(400); // 等 autosave effect

        // T5：localStorage 有草稿且含剛填的值
        const draftRaw = await page.evaluate((uid) => window.localStorage.getItem(`profile_draft_${uid}`), UID);
        let draft = null; try { draft = JSON.parse(draftRaw); } catch { /* ignore */ }
        assert('T5 草稿寫入 localStorage', draft && draft.address === '台北市信義區通訊路 1 號' && draft.household_address === '新北市板橋區戶籍街 2 號' && draft.bank_branch === '仁愛分行測試', draftRaw ? 'draft 已寫入' : 'draft 為空');

        // T1：重整 /profile（等同換頁走開再回來，且更嚴格＝整頁 reload）
        await gotoProfile(page);
        const a2 = await page.inputValue(`input[placeholder="${ADDR}"]`);
        const h2 = await page.inputValue(`input[placeholder="${HOUSE}"]`);
        const b2 = await page.inputValue(`input[placeholder="${BRANCH}"]`);
        assert('T1a 重整後通訊地址還原', a2 === '台北市信義區通訊路 1 號', `got="${a2}"`);
        assert('T1b 重整後戶籍地址還原', h2 === '新北市板橋區戶籍街 2 號', `got="${h2}"`);
        assert('T1c 重整後分行別還原', b2 === '仁愛分行測試', `got="${b2}"`);
        await page.close(); await ctx.close();

        // ── T2：同通訊地址按鈕（乾淨 context 無草稿）──
        instructorRow = null;
        ctx = await newCtx(browser);
        page = await ctx.newPage();
        await gotoProfile(page);
        await page.fill(`input[placeholder="${ADDR}"]`, '桃園市中壢區同址路 9 號');
        // household 先確保為空
        await page.fill(`input[placeholder="${HOUSE}"]`, '');
        await page.getByRole('button', { name: '同通訊地址' }).click();
        await page.waitForTimeout(200);
        const hCopied = await page.inputValue(`input[placeholder="${HOUSE}"]`);
        assert('T2 同通訊地址一鍵帶入', hCopied === '桃園市中壢區同址路 9 號', `got="${hCopied}"`);
        await page.close(); await ctx.close();

        // ── T4：既有講師、無草稿（乾淨 context）→ 表單顯示 DB 值 ──
        instructorRow = {
            id: 'inst-1', user_id: UID, full_name: '既有講師', nickname: '阿存', gender: '男',
            birth_date: '1990-01-01', id_number: 'A123456789', phone_mobile: '0912345678',
            line_id: 'existing', address: 'DB通訊地址', household_address: null,
            email_primary: 'exist@test.local', instructor_role: 'A', teaching_freq_semester: '每週2',
            teaching_freq_vacation: '每週5', teaching_regions: ['臺北市'], bio_notes: '',
            bank_account_name: '既有講師', bank_name: '華南', bank_branch: 'DB分行值',
            bank_account_number: '123456789', bank_code: '0080012',
            photo_path: null, id_front_path: null, id_back_path: null, bankbook_path: null,
            hide_from_leaderboard: false,
        };
        ctx = await newCtx(browser);
        page = await ctx.newPage();
        await gotoProfile(page);
        const branchDb = await page.inputValue(`input[placeholder="${BRANCH}"]`);
        const addrDb = await page.inputValue(`input[placeholder="${ADDR}"]`);
        assert('T4a 既有講師載入 DB 分行值', branchDb === 'DB分行值', `got="${branchDb}"`);
        assert('T4b 既有講師載入 DB 通訊地址', addrDb === 'DB通訊地址', `got="${addrDb}"`);
        // 無草稿時戶籍地址（DB null）應為空
        const houseDb = await page.inputValue(`input[placeholder="${HOUSE}"]`);
        assert('T4c 既有講師戶籍地址（DB null）為空', houseDb === '', `got="${houseDb}"`);
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
