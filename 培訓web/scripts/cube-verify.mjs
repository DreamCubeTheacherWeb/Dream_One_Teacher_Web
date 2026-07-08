#!/usr/bin/env node
/*
 * 方塊競速頁（/cube）完整 E2E 驗證 —— 長期資產，可重跑。
 * 用法：node scripts/cube-verify.mjs
 *
 * 2026-07-08 UI/UX 重構版：舊「打亂文字輸入框」改為按鈕排出的打亂編排器、
 * 三張分散卡片整合成一張主遊戲卡、單一狀態驅動主行動按鈕、螢幕轉面按鈕與
 * 按鍵設定改為可摺疊區塊。本腳本同步更新選擇器與流程，行為覆蓋條數不減
 * （原 38 條，新增 G1-G4 與手機熱區/溢出檢查）。
 *
 * 流程：npm run build → npx vite preview --port 4199 → Playwright 開 /cube
 * （假 session + mock Supabase，手法借自 repro-cube-page.js / interact-cube-page.js）
 * → 主行動按鈕四態文字（G4）、logo／格子排序／自由玩（F 系列）、鍵盤解題＋
 * 暫停／繼續＋再來一場（A+G3）、改鍵／恢復預設＋reload 持久化（B）、打亂編排器
 * 按鈕排出打亂（G1/G2）、實體計時（C）、模式切換觸發排行榜重載（D）、零 pageerror
 * （E）、手機熱區與橫向溢出檢查（M）。
 *
 * 任何一項 FAIL 都會讓本腳本以非 0 結束碼結束。
 */
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync, spawn } from 'child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const PORT = 4199;
const BASE = `http://localhost:${PORT}`;

const { chromium } = require(path.join(APP_DIR, 'node_modules/playwright-core'));

// ── 假登入 session（沿用 repro-cube-page.js 的手法）──────────────────
const envMap = Object.fromEntries(readFileSync(path.join(APP_DIR, '.env'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const PROJECT_REF = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

const UID = '00000000-0000-4000-8000-000000000001';
const NOW_ISO = new Date().toISOString();
const FAKE_AUTH_USER = {
    id: UID, aud: 'authenticated', role: 'authenticated', email: 'cube-verify@test.local',
    email_confirmed_at: NOW_ISO, confirmed_at: NOW_ISO, last_sign_in_at: NOW_ISO,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '驗證測試員', avatar_url: '' }, identities: [], created_at: NOW_ISO, updated_at: NOW_ISO,
};
const FAKE_SESSION = {
    access_token: 'mock.a', token_type: 'bearer', expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000, refresh_token: 'mock.r', user: FAKE_AUTH_USER,
};
const FAKE_USERS_ROW = { id: UID, name: '驗證測試員', email: 'cube-verify@test.local', role: 'admin', created_at: NOW_ISO, updated_at: NOW_ISO };

// ── mock 呼叫紀錄（給斷言用）─────────────────────────────────────────
const rpcModeCalls = [];
const insertBodies = [];

async function handleRoute(route) {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();
    const p = url.pathname;

    if (p.startsWith('/auth/v1/')) {
        if (p === '/auth/v1/user') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_AUTH_USER) });
        if (p.startsWith('/auth/v1/token')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_SESSION) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }

    if (p === '/rest/v1/rpc/get_cube_leaderboard') {
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch { /* 忽略解析失敗 */ }
        rpcModeCalls.push(body.p_mode ?? null);
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }

    if (p.startsWith('/rest/v1/')) {
        const table = p.replace('/rest/v1/', '').split('/')[0];
        if (table === 'cube_solves' && req.method() === 'POST') {
            insertBodies.push(req.postData() || '');
            return route.fulfill({ status: 201, headers: { 'content-type': 'application/json' }, body: '' });
        }
        const accept = (await req.allHeaders()).accept || '';
        const bodyData = table === 'users' && req.method() === 'GET' ? [FAKE_USERS_ROW] : (accept.includes('vnd.pgrst.object+json') ? null : []);
        const headers = { 'content-type': 'application/json' };
        if (Array.isArray(bodyData)) headers['content-range'] = bodyData.length ? `0-${bodyData.length - 1}/${bodyData.length}` : '*/0';
        return route.fulfill({ status: 200, headers, body: bodyData === null ? 'null' : JSON.stringify(bodyData) });
    }

    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

// ── 斷言收集 ─────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail) {
    results.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// ── 打亂譜反演工具（依預設鍵位：CW=字母、CCW=Shift+字母、X2=按兩次字母）──
function invertToken(t) {
    if (t.endsWith('2')) return t; // 180° 自身互逆
    if (t.endsWith("'")) return t.slice(0, -1); // CCW → CW
    return `${t}'`; // CW → CCW
}
function tokenToKeyActions(t) {
    const letter = t[0];
    if (t.endsWith('2')) return [letter, letter];
    if (t.endsWith("'")) return [`Shift+${letter}`];
    return [letter];
}
function invertTokensToKeyActions(tokens) {
    return tokens.slice().reverse().map(invertToken).flatMap(tokenToKeyActions);
}

function parseCubeTime(text) {
    const m = (text || '').trim().match(/^(?:(\d+):)?(\d+)\.(\d{2})$/);
    if (!m) return null;
    const min = m[1] ? parseInt(m[1], 10) : 0;
    const sec = parseInt(m[2], 10);
    const cs = parseInt(m[3], 10);
    return min * 60000 + sec * 1000 + cs * 10;
}

async function waitForFile(url, timeoutMs) {
    const start = Date.now();
    for (;;) {
        try {
            const res = await fetch(url);
            if (res.ok || res.status === 404) return true;
        } catch { /* 伺服器還沒起來 */ }
        if (Date.now() - start > timeoutMs) throw new Error(`等待 ${url} 逾時`);
        await new Promise((r) => setTimeout(r, 300));
    }
}

async function main() {
    console.log('── npm run build ──');
    execSync('npm run build', { cwd: APP_DIR, stdio: 'inherit' });

    console.log(`── npx vite preview --port ${PORT} ──`);
    const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
        cwd: APP_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let previewLog = '';
    preview.stdout.on('data', (d) => { previewLog += d.toString(); });
    preview.stderr.on('data', (d) => { previewLog += d.toString(); });

    let browser;
    try {
        await waitForFile(BASE, 15000);

        browser = await chromium.launch();
        const context = await browser.newContext({ viewport: { width: 1280, height: 950 } });
        await context.addInitScript(({ key, session }) => {
            window.localStorage.setItem(key, JSON.stringify(session));
        }, { key: STORAGE_KEY, session: FAKE_SESSION });
        await context.route('**/*', handleRoute);
        const page = await context.newPage();

        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));

        await page.goto(`${BASE}/cube`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.dc-cubie', { timeout: 15000 });
        await page.waitForTimeout(500);

        const snapshotTransforms = () => page.evaluate(
            () => Array.from(document.querySelectorAll('.dc-cubie')).map((el) => el.style.transform).join('|')
        );
        const getPhase = () => page.evaluate(() => document.querySelector('[data-cube-phase]')?.dataset.cubePhase);
        const waitForPhase = (target, timeout = 5000) => page.waitForFunction(
            (t) => document.querySelector('[data-cube-phase]')?.dataset.cubePhase === t,
            target,
            { timeout }
        );
        const primaryText = async () => (await page.locator('[data-testid="cube-primary-action"]').textContent() || '').trim();
        const waitScrambleDone = () => page.waitForFunction(() => {
            const btn = document.querySelector('[data-testid="cube-scramble-random"]');
            return !!btn && !btn.disabled;
        }, { timeout: 8000 });
        const waitBuilderApplyDone = () => page.waitForFunction(() => {
            const btn = document.querySelector('[data-testid="cube-builder-apply"]');
            return !!btn && !btn.disabled;
        }, { timeout: 8000 });
        const readScrambleTokens = () => page.evaluate(
            () => Array.from(document.querySelectorAll('[data-testid="cube-scramble-tokens"] span')).map((s) => s.textContent)
        );
        const getTileOrder = (containerTestId) => page.evaluate(
            (sel) => Array.from(document.querySelectorAll(`[data-testid="${sel}"] > div`)).map((el) => el.getAttribute('data-testid').replace('cube-tile-', '')),
            containerTestId
        );
        const ensureFaceOpen = async () => {
            if (await page.locator('[data-testid="cube-face-buttons"]').count() === 0) {
                await page.locator('[data-testid="cube-face-toggle"]').click();
                await page.waitForSelector('[data-testid="cube-face-buttons"]', { timeout: 3000 });
            }
        };
        const holdSpaceToStart = async () => {
            await page.keyboard.down('Space');
            await page.waitForTimeout(450);
            await page.keyboard.up('Space');
            await waitForPhase('running');
        };
        const solveViaKeyboard = async (tokens) => {
            const keyActions = invertTokensToKeyActions(tokens);
            for (const k of keyActions) {
                await page.keyboard.press(k);
                await page.waitForTimeout(200); // > 170ms 轉面動畫時長
            }
        };

        // ══════════════════════════════════════════════════════════════
        // G4. 單一主行動按鈕隨狀態變字：打亂→按住準備→暫停→繼續
        // ══════════════════════════════════════════════════════════════
        check('G4a 頁面剛載入（未打亂）主鈕顯示「打亂」', (await primaryText()).includes('打亂'), await primaryText());

        await page.locator('[data-testid="cube-primary-action"]').click(); // 尚未打亂時主鈕＝隨機打亂
        await waitScrambleDone();
        await page.waitForFunction(() => (document.querySelector('[data-testid="cube-primary-action"]')?.textContent || '').includes('按住準備'), { timeout: 8000 });
        check('G4b 打亂完成後主鈕顯示「按住準備」', (await primaryText()).includes('按住準備'), await primaryText());

        await holdSpaceToStart();
        check('G4c running 中主鈕顯示「暫停」', (await primaryText()).includes('暫停'), await primaryText());

        await page.keyboard.press('P');
        await waitForPhase('paused');
        check('G4d 暫停中主鈕顯示「繼續」', (await primaryText()).includes('繼續'), await primaryText());

        await page.keyboard.press('Escape');
        await waitForPhase('idle');

        // ══════════════════════════════════════════════════════════════
        // F. 國際代號格子／可自訂排列／M·x·y／全形正規化／logo
        // ══════════════════════════════════════════════════════════════

        // F7 白面中心貼紙含 logo.png
        const hasLogoSticker = await page.evaluate(
            () => Array.from(document.querySelectorAll('.dc-sticker')).some((el) => (el.style.backgroundImage || '').includes('logo.png'))
        );
        check('F7 白面中心貼紙 style 含 logo.png', hasLogoSticker);

        // F1 格子按代號顯示且預設順序 R F L U D B M；翻面列有 x x' y y'
        await ensureFaceOpen();
        const defaultTileOrder = await getTileOrder('cube-face-buttons');
        check('F1a 格子預設順序 R F L U D B M', defaultTileOrder.join(',') === 'R,F,L,U,D,B,M', defaultTileOrder.join(','));
        const twistOrder = await getTileOrder('cube-twist-buttons');
        check('F1b 翻面列有 x y（固定順序）', twistOrder.join(',') === 'x,y', twistOrder.join(','));
        const hasXYPrimeButtons = await page.locator('[data-testid="cube-btn-x-prime"]').count() === 1
            && await page.locator('[data-testid="cube-btn-y-prime"]').count() === 1;
        check('F1c 翻面列有 x\' y\' 按鈕', hasXYPrimeButtons);

        // F6 排序：把 R 往右移一格 → reload → 順序仍在（localStorage 持久化）
        await page.locator('[data-testid="cube-key-settings-toggle"]').click();
        await page.locator('[data-testid="cube-tile-move-right-R"]').click();
        const orderAfterMove = await getTileOrder('cube-face-buttons');
        check('F6a 把 R 往右移一格後順序變為 F R L U D B M', orderAfterMove.join(',') === 'F,R,L,U,D,B,M', orderAfterMove.join(','));

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.dc-cubie', { timeout: 15000 });
        await page.waitForTimeout(500);
        await ensureFaceOpen();
        const orderAfterReload = await getTileOrder('cube-face-buttons');
        check('F6b reload 後排序仍持久化', orderAfterReload.join(',') === 'F,R,L,U,D,B,M', orderAfterReload.join(','));

        // F3 自由玩狀態（尚未打亂，phase=idle，cube 仍 solved）按 x 綁定鍵：
        // 全部 cubie transform 改變、且不會跳出成績面板
        check('F3 前置：頁面剛載入為 idle 且無成績面板', await getPhase() === 'idle' && await page.locator('[data-testid="cube-result-panel"]').count() === 0);
        const beforeX = await snapshotTransforms();
        await page.keyboard.press('X');
        await page.waitForTimeout(250);
        const afterX = await snapshotTransforms();
        check('F3a 自由玩按 x 綁定鍵，全部 cubie transform 改變', beforeX !== afterX);
        check('F3b 原本 solved、自由玩按 x 不會跳出成績面板', await page.locator('[data-testid="cube-result-panel"]').count() === 0);

        // ══════════════════════════════════════════════════════════════
        // A. 鍵盤模式：新打亂 → 讀打亂譜 → 起錶 → 反演打回去（含暫停/繼續）→ 自動停錶
        // ══════════════════════════════════════════════════════════════
        await page.locator('[data-testid="cube-scramble-random"]').click();
        await waitScrambleDone();

        let tokens = await readScrambleTokens();
        check('A0 打亂譜讀到 15 步', tokens.length === 15, tokens.join(' '));

        await holdSpaceToStart();
        check('A1 起錶後進入 running', await getPhase() === 'running');

        // F2 M 按鈕轉動有效（running 中才能點；轉完立刻轉回去，不影響後面的反演解題）
        const beforeM = await snapshotTransforms();
        await page.locator('[data-testid="cube-btn-M"]').click();
        await page.waitForTimeout(250);
        const afterM = await snapshotTransforms();
        check('F2 M 按鈕轉動有效', beforeM !== afterM);
        await page.locator('[data-testid="cube-btn-M-prime"]').click();
        await page.waitForTimeout(250);

        const inverseTokens = tokens.slice().reverse().map(invertToken);
        const keyActions = inverseTokens.flatMap(tokenToKeyActions);
        const mid = Math.floor(keyActions.length / 2);

        for (const k of keyActions.slice(0, mid)) {
            await page.keyboard.press(k);
            await page.waitForTimeout(200);
        }

        // 中途驗暫停：按暫停鍵，時間應凍結（700ms 後讀值不變）
        await page.keyboard.press('P');
        await waitForPhase('paused');
        await page.waitForTimeout(1500); // 讓暫停前佇列中尚未播完的轉面動畫先跑完
        const frozen1 = await page.locator('[data-testid="cube-timer-display"]').textContent();
        await page.waitForTimeout(700);
        const frozen2 = await page.locator('[data-testid="cube-timer-display"]').textContent();
        check('A2 暫停中畫面時間凍結 700ms 不變', frozen1 === frozen2, `${frozen1} vs ${frozen2}`);

        // 暫停中轉面應被鎖定（不應該改變方塊狀態）
        const lockedBefore = await snapshotTransforms();
        await page.keyboard.press(keyActions[mid] || 'U');
        await page.waitForTimeout(300);
        const lockedAfter = await snapshotTransforms();
        check('A3 暫停中轉面被鎖定', lockedBefore === lockedAfter);

        // 繼續
        await page.keyboard.press('P');
        await waitForPhase('running');

        for (const k of keyActions.slice(mid)) {
            await page.keyboard.press(k);
            await page.waitForTimeout(200);
        }

        await page.waitForSelector('[data-testid="cube-result-panel"]', { timeout: 12000 });
        check('A4 解開後自動停錶、成績面板出現', await getPhase() === 'stopped');

        const resultTimeText = await page.locator('[data-testid="cube-result-time"]').textContent();
        const resultMs = parseCubeTime(resultTimeText);
        check('A5 本次成績時間 > 0', typeof resultMs === 'number' && resultMs > 0, resultTimeText);

        // ══════════════════════════════════════════════════════════════
        // G3. 停錶後按「再來一場」：不送出、自動重新打亂、回到 ready
        // ══════════════════════════════════════════════════════════════
        await page.locator('[data-testid="cube-secondary-action"]').click(); // 「🎲 再來一場」
        await waitScrambleDone();
        await page.waitForFunction(() => (document.querySelector('[data-testid="cube-primary-action"]')?.textContent || '').includes('按住準備'), { timeout: 8000 });
        check('G3 停錶後按「再來一場」自動重新打亂進 ready', await getPhase() === 'idle' && (await primaryText()).includes('按住準備'));
        check('G3b 「再來一場」未送出成績（無成功訊息殘留）', await page.locator('[data-testid="cube-submit-success"]').count() === 0);

        // 用這個新打亂再解一次，測試 A6（送出成績成功）
        tokens = await readScrambleTokens();
        await holdSpaceToStart();
        await solveViaKeyboard(tokens);
        await page.waitForSelector('[data-testid="cube-result-panel"]', { timeout: 12000 });
        await page.locator('[data-testid="cube-primary-action"]').click(); // 「送出成績」
        await page.waitForSelector('[data-testid="cube-submit-success"]', { timeout: 5000 });
        check('A6 送出成績成功訊息出現', true);

        // ══════════════════════════════════════════════════════════════
        // B. 改鍵：上⟳ 改成 KeyJ → J 有效、U 失效 → reload 後仍持久 → 恢復預設後 U 有效
        // ══════════════════════════════════════════════════════════════
        await page.locator('[data-testid="cube-key-settings-toggle"]').click();
        await page.locator('[data-testid="cube-keyrow-U_CW"]').click();
        await page.keyboard.press('J');
        const kbdText = (await page.locator('[data-testid="cube-keyrow-U_CW"] kbd').textContent() || '').trim();
        check('B1 上⟳ 改鍵為 J', kbdText === 'J', kbdText);

        let before = await snapshotTransforms();
        await page.keyboard.press('J');
        await page.waitForTimeout(250);
        let after = await snapshotTransforms();
        check('B2 按 J 轉面有效', before !== after);

        before = after;
        await page.keyboard.press('U');
        await page.waitForTimeout(250);
        after = await snapshotTransforms();
        check('B3 按 U 不再轉面', before === after);

        // 持久化：reload 後 keymap 仍在
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.dc-cubie', { timeout: 15000 });
        await page.waitForTimeout(500);
        before = await snapshotTransforms();
        await page.keyboard.press('J');
        await page.waitForTimeout(250);
        after = await snapshotTransforms();
        check('B4 reload 後 J 仍有效（localStorage 持久化）', before !== after);

        // 恢復預設
        await page.locator('[data-testid="cube-key-settings-toggle"]').click();
        await page.locator('[data-testid="cube-keymap-reset"]').click();
        const kbdTextAfterReset = (await page.locator('[data-testid="cube-keyrow-U_CW"] kbd').textContent() || '').trim();
        check('B5 恢復預設後上⟳鍵位顯示回 U', kbdTextAfterReset === 'U', kbdTextAfterReset);

        before = await snapshotTransforms();
        await page.keyboard.press('U');
        await page.waitForTimeout(250);
        after = await snapshotTransforms();
        check('B6 恢復預設後按 U 又有效', before !== after);

        // ══════════════════════════════════════════════════════════════
        // G1/G2. 打亂編排器（按鈕排出打亂，取代文字輸入框）
        // ══════════════════════════════════════════════════════════════
        await page.locator('[data-testid="cube-scramble-custom-toggle"]').click();
        await page.waitForSelector('[data-testid="cube-builder-panel"]', { timeout: 3000 });

        const builderText = () => page.locator('[data-testid="cube-builder-tokens"]').evaluate(
            (el) => Array.from(el.querySelectorAll('.cube-builder-chip')).map((s) => s.textContent).join(' ')
        );

        await page.locator('[data-testid="cube-builder-key-R"]').click();
        check('G1a 按 R 後 token strip 顯示 R', await builderText() === 'R', await builderText());

        await page.locator('[data-testid="cube-builder-mod-apostrophe"]').click();
        check("G1b 按 ' 後變成 R'", await builderText() === "R'", await builderText());

        await page.locator('[data-testid="cube-builder-key-U"]').click();
        check("G1c 再按 U 後變成「R' U」", await builderText() === "R' U", await builderText());

        await page.locator('[data-testid="cube-builder-mod-two"]').click();
        check("G1d 按 2 後最後一個變成 U2（R' U2）", await builderText() === "R' U2", await builderText());

        await page.locator('[data-testid="cube-builder-mod-backspace"]').click();
        check("G1e 按 ⌫ 後刪除最後一個，剩 R'", await builderText() === "R'", await builderText());

        await page.locator('[data-testid="cube-builder-mod-clear"]').click();
        check('G1f 按「清空」後 token strip 清空', await builderText() === '', await builderText());
        check('G1g 沒有 token 時「套用此打亂」按鈕 disabled', await page.locator('[data-testid="cube-builder-apply"]').isDisabled());

        // G2：排 4 步套用 → ready → 按住 Space 起錶進 running
        for (const letter of ['R', 'U', 'F', 'D']) {
            await page.locator(`[data-testid="cube-builder-key-${letter}"]`).click();
        }
        check('G2a 排出 4 步 R U F D', await builderText() === 'R U F D', await builderText());

        await page.locator('[data-testid="cube-builder-apply"]').click();
        await waitBuilderApplyDone();
        await page.waitForFunction(() => (document.querySelector('[data-testid="cube-primary-action"]')?.textContent || '').includes('按住準備'), { timeout: 8000 });
        check('G2b 套用後主鈕變成「按住準備」', (await primaryText()).includes('按住準備'), await primaryText());

        await holdSpaceToStart();
        check('G2c 套用打亂後按住 Space 可起錶進 running', await getPhase() === 'running');

        await page.keyboard.press('Escape');
        await waitForPhase('idle');

        // ══════════════════════════════════════════════════════════════
        // C. 實體計時：轉面按鈕隱藏、不打亂直接計時、手動停錶、Esc 放棄
        // ══════════════════════════════════════════════════════════════
        await page.locator('[data-testid="cube-mode-physical"]').click();
        await page.waitForTimeout(200);
        check('C0 切到實體模式後轉面按鈕消失', await page.locator('[data-testid="cube-face-buttons"]').count() === 0);

        await holdSpaceToStart();
        check('C1 實體模式不打亂直接起錶成功', await getPhase() === 'running');

        await page.waitForTimeout(3200);
        await page.keyboard.press('Space');
        await waitForPhase('stopped');

        const physResultText = await page.locator('[data-testid="cube-result-time"]').textContent();
        const physMs = parseCubeTime(physResultText);
        check('C2 實體計時手動停錶、成績 ≥ 3 秒', typeof physMs === 'number' && physMs >= 3000, physResultText);

        const resultPanelText = await page.locator('[data-testid="cube-result-panel"]').innerText();
        check('C3 實體成績不顯示步數', !/\d+\s*步/.test(resultPanelText), resultPanelText.slice(0, 80));

        await page.locator('[data-testid="cube-primary-action"]').click(); // 「送出成績」
        await page.waitForSelector('[data-testid="cube-submit-success"]', { timeout: 5000 });
        check('C4 實體成績送出成功', true);

        // Esc 放棄流程
        await holdSpaceToStart();
        await page.keyboard.press('Escape');
        await waitForPhase('idle');
        check('C5 Esc 放棄後回到 idle', await getPhase() === 'idle');
        check('C6 Esc 放棄後成績面板消失', await page.locator('[data-testid="cube-result-panel"]').count() === 0);

        // ══════════════════════════════════════════════════════════════
        // D. 模式切換觸發排行榜重新請求（route mock 記錄 p_mode）
        // ══════════════════════════════════════════════════════════════
        const modesSeen = new Set(rpcModeCalls.filter(Boolean));
        check('D1 排行榜 rpc 曾以 p_mode=virtual 呼叫', modesSeen.has('virtual'), [...modesSeen].join(','));
        check('D2 排行榜 rpc 曾以 p_mode=physical 呼叫', modesSeen.has('physical'), [...modesSeen].join(','));
        check('D3 送出成績時 mode 欄位正確寫入（virtual+physical 各一筆）',
            insertBodies.some((b) => b.includes('"mode":"virtual"')) && insertBodies.some((b) => b.includes('"mode":"physical"')),
            `insertBodies=${insertBodies.length}`);

        // ══════════════════════════════════════════════════════════════
        // E. 全程零 pageerror
        // ══════════════════════════════════════════════════════════════
        check('E1 全程無 JS pageerror', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 300));

        // 最終截圖要求鍵盤模式，且展開「自己排」面板
        await page.locator('[data-testid="cube-mode-virtual"]').click();
        await page.waitForTimeout(300);
        if (await page.locator('[data-testid="cube-builder-panel"]').count() === 0) {
            await page.locator('[data-testid="cube-scramble-custom-toggle"]').click();
        }
        await page.locator('[data-testid="cube-builder-key-R"]').click().catch(() => {});
        await page.locator('[data-testid="cube-builder-key-F"]').click().catch(() => {});
        await page.screenshot({ path: path.join(__dirname, 'cube-verify-final.png'), fullPage: true }).catch(() => {});

        // ══════════════════════════════════════════════════════════════
        // M. 手機檢查：390×844／375×667，hasTouch，無橫向溢出＋熱區 ≥44×44
        // ══════════════════════════════════════════════════════════════
        const checkMobileViewport = async (width, height, screenshotName) => {
            const mCtx = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
            await mCtx.addInitScript(({ key, session }) => {
                window.localStorage.setItem(key, JSON.stringify(session));
            }, { key: STORAGE_KEY, session: FAKE_SESSION });
            await mCtx.route('**/*', handleRoute);
            const mPage = await mCtx.newPage();
            await mPage.goto(`${BASE}/cube`, { waitUntil: 'domcontentloaded' });
            await mPage.waitForSelector('.dc-cubie', { timeout: 15000 });
            await mPage.waitForTimeout(500);

            const overflow = await mPage.evaluate(() => ({ scrollWidth: document.body.scrollWidth, innerWidth: window.innerWidth }));
            check(`M${width} 無橫向溢出`, overflow.scrollWidth <= overflow.innerWidth, `scrollWidth=${overflow.scrollWidth} innerWidth=${overflow.innerWidth}`);

            const primaryBox = await mPage.locator('[data-testid="cube-primary-action"]').boundingBox();
            check(`M${width} 主行動鈕熱區 ≥44x44`, !!primaryBox && primaryBox.width >= 44 && primaryBox.height >= 44, JSON.stringify(primaryBox));

            await mPage.locator('[data-testid="cube-scramble-custom-toggle"]').click();
            await mPage.waitForSelector('[data-testid="cube-builder-keys"]', { timeout: 3000 });
            const letterBoxes = await mPage.evaluate(() => Array.from(document.querySelectorAll('[data-testid="cube-builder-keys"] button')).map((b) => {
                const r = b.getBoundingClientRect();
                return { w: r.width, h: r.height };
            }));
            const allBig = letterBoxes.length === 9 && letterBoxes.every((b) => b.w >= 44 && b.h >= 44);
            check(`M${width} 字母鍵盤按鈕（共${letterBoxes.length}顆）皆 ≥44x44`, allBig, JSON.stringify(letterBoxes));

            await mPage.screenshot({ path: path.join(__dirname, screenshotName), fullPage: true }).catch(() => {});
            await mCtx.close();
        };

        await checkMobileViewport(390, 844, 'cube-verify-mobile-390.png');
        await checkMobileViewport(375, 667, 'cube-verify-mobile-375.png');
    } finally {
        if (browser) await browser.close();
        preview.kill();
        if (process.exitCode && previewLog) console.log('--- vite preview log ---\n' + previewLog.slice(-2000));
    }

    const failed = results.filter((r) => !r).length;
    console.log(`\n總結：${results.length - failed}/${results.length} 通過${failed ? '（有失敗！）' : ''}`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error('SCRIPT ERROR:', e);
    process.exit(2);
});
