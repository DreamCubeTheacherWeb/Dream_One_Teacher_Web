#!/usr/bin/env node
/*
 * 回歸驗證：既有講師首次登入會認領同 Email 主檔，之後登入仍直接取得同一筆資料。
 *
 * 登入決策統一由 claim_my_precreated_instructor 處理，不依角色或額外邀請名單判斷。
 *
 * 驗證方式：假登入 session + mock Supabase。RPC 呼叫前 instructors 查不到資料；
 * RPC 成功後才回傳歷史主檔，最後從真實 React 畫面確認暱稱已自動帶入。
 *
 * 用法：node scripts/verify-instructor-autolink.mjs
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4221;
const BASE = `http://localhost:${PORT}`;
const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const envMap = Object.fromEntries(readFileSync(path.join(APP_DIR, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
const PROJECT_REF = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;
const UID = '00000000-0000-4000-8000-000000000021';
const INSTRUCTOR_ID = '00000000-0000-4000-8000-000000000022';
const NOW = new Date().toISOString();

const FAKE_AUTH_USER = {
    id: UID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'linked-teacher@test.local',
    email_confirmed_at: NOW,
    confirmed_at: NOW,
    last_sign_in_at: NOW,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: 'Google 顯示名稱', avatar_url: '' },
    identities: [],
    created_at: NOW,
    updated_at: NOW,
};
const FAKE_SESSION = {
    access_token: 'mock.autolink.payload',
    token_type: 'bearer',
    expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    refresh_token: 'mock.autolink.refresh',
    user: FAKE_AUTH_USER,
};
const HISTORICAL_INSTRUCTOR = {
    id: INSTRUCTOR_ID,
    user_id: UID,
    full_name: '歷史講師姓名',
    nickname: '歷史講師暱稱',
    gender: '男',
    birth_date: '1990-01-01',
    id_number: 'A123456789',
    phone_mobile: '0912345678',
    line_id: 'teacher-line',
    address: '測試通訊地址',
    household_address: '測試戶籍地址',
    email_primary: FAKE_AUTH_USER.email,
    instructor_role: 'A',
    teaching_freq_semester: '每週 2 次',
    teaching_freq_vacation: '每週 3 次',
    teaching_regions: ['臺北市'],
    bio_notes: '測試資料',
    bank_account_name: '歷史講師姓名',
    bank_name: '測試銀行',
    bank_branch: '測試分行',
    bank_account_number: '0000000000',
    bank_code: '0000000',
    photo_path: null,
    id_front_path: 'instructors/test/id-front.png',
    id_back_path: 'instructors/test/id-back.png',
    bankbook_path: 'instructors/test/bankbook.png',
};

let scenarioRole = 'teacher';
let linked = false;
let linkRpcCalls = 0;
let instructorReadsBeforeLink = 0;

function jsonResponse(route, data, extraHeaders = {}) {
    const headers = { 'content-type': 'application/json', ...extraHeaders };
    if (Array.isArray(data)) {
        headers['content-range'] = data.length ? `0-${data.length - 1}/${data.length}` : '*/0';
    }
    return route.fulfill({ status: 200, headers, body: JSON.stringify(data) });
}

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return jsonResponse(route, FAKE_AUTH_USER);
        if (url.pathname.startsWith('/auth/v1/token')) return jsonResponse(route, FAKE_SESSION);
        return jsonResponse(route, {});
    }

    if (url.pathname === '/rest/v1/rpc/claim_my_precreated_instructor') {
        linkRpcCalls += 1;
        linked = true;
        return jsonResponse(route, { status: 'claimed', instructor_id: INSTRUCTOR_ID, claimed_now: true });
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) return jsonResponse(route, null);

    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const accept = (await request.allHeaders()).accept || '';
        const wantsObject = accept.includes('vnd.pgrst.object+json');
        if (request.method() !== 'GET') {
            return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: wantsObject ? '{}' : '[]' });
        }

        if (table === 'users') {
            const row = {
                id: UID,
                name: 'Google 顯示名稱',
                email: FAKE_AUTH_USER.email,
                role: scenarioRole === 'pending' && linked ? 'teacher' : scenarioRole,
                created_at: NOW,
            };
            return jsonResponse(route, wantsObject ? row : [row]);
        }

        if (table === 'instructors') {
            if (!linked) instructorReadsBeforeLink += 1;
            const rows = linked ? [HISTORICAL_INSTRUCTOR] : [];
            return jsonResponse(route, wantsObject ? (rows[0] || null) : rows);
        }

        return jsonResponse(route, wantsObject ? null : []);
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

async function waitForServer(url, timeoutMs) {
    const startedAt = Date.now();
    for (;;) {
        try {
            const response = await fetch(url);
            if (response.ok || response.status === 404) return;
        } catch { /* preview 尚未啟動 */ }
        if (Date.now() - startedAt > timeoutMs) throw new Error(`server timeout: ${url}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
}

const results = [];
function assert(name, condition, detail = '') {
    results.push({ name, pass: Boolean(condition), detail });
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function runScenario(browser, role) {
    scenarioRole = role;
    linked = false;
    linkRpcCalls = 0;
    instructorReadsBeforeLink = 0;

    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(({ key, session }) => {
        window.localStorage.setItem(key, JSON.stringify(session));
    }, { key: STORAGE_KEY, session: FAKE_SESSION });
    await context.route('**/*', handleRoute);
    const page = await context.newPage();

    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    await page.getByText('歷史講師暱稱', { exact: true }).first().waitFor({ timeout: 8000 });

    assert(`${role}: 登入時呼叫自動綁定 RPC`, linkRpcCalls === 1, `calls=${linkRpcCalls}`);
    assert(`${role}: 綁定前不先讀取空的講師主檔`, instructorReadsBeforeLink === 0, `reads=${instructorReadsBeforeLink}`);
    assert(`${role}: 畫面帶入歷史講師暱稱`, await page.getByText('歷史講師暱稱', { exact: true }).first().isVisible());

    await page.close();
    await context.close();
}

async function main() {
    console.log('--- npm run build ---');
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
        cwd: APP_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let browser;
    try {
        await waitForServer(BASE, 15000);
        browser = await chromium.launch(existsSync(SYSTEM_CHROME) ? { executablePath: SYSTEM_CHROME } : {});
        for (const role of ['teacher', 'admin', 'mentor', 'pending']) {
            await runScenario(browser, role);
        }
    } finally {
        if (browser) await browser.close();
        preview.kill('SIGTERM');
    }

    const passed = results.filter((result) => result.pass).length;
    console.log(`\n=== ${passed}/${results.length} PASS ===`);
    process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
