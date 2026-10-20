#!/usr/bin/env node
// 隱私權政策頁（/privacy）補上電子簽署個資項目（spec 2026-10-20-esign-legal-copy.md §5-d、紅燈 R2）：
// 以正式版建置（vite preview）實際開頁，確認新段落文字都在頁面上，桌機與 390px 寬各截一張整頁圖，
// 並量測整頁與每個元素都沒有超出視窗寬度（水平溢出）。執行前先 `npm run build`。
import { existsSync, mkdirSync } from 'node:fs';
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
const viteBin = path.join(appDir, 'node_modules/.bin/vite');
const shotDir = path.join(appDir, 'docs/verification/2026-10-20-privacy-esign');
mkdirSync(shotDir, { recursive: true });

if (!existsSync(path.join(appDir, 'dist/index.html'))) {
    console.error('找不到 dist/，請先執行 npm run build');
    process.exit(1);
}

const expectedTexts = [
    '電子簽署紀錄：',
    '簽名影像',
    'Email 驗證碼的驗證時間',
    'IP 位址',
    'User Agent（瀏覽器與裝置資訊）',
    '證明簽約事實、處理契約爭議',
    '合作結束後 15 年',
    '使用 Resend 寄送電子郵件',
];
// 不得宣稱電子簽名與親簽效力相同（spec R1）
const forbiddenTexts = ['一樣的法律效力', '與親簽效力相同', '等同親筆簽名'];

const viewports = [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile-390', width: 390, height: 844 },
];

const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});

const waitForServer = async (url, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch { /* 還沒起來 */ }
        await new Promise(r => setTimeout(r, 300));
    }
    throw new Error(`vite preview 在 ${timeoutMs}ms 內沒有回應：${url}`);
};

// 公開頁不需要登入；Supabase 請求一律回空結果，避免打到正式資料庫
const handleRoute = (route) => {
    const url = route.request().url();
    if (url.includes('.supabase.co')) {
        return route.fulfill({ status: 200, headers: { 'content-type': 'application/json' }, body: '[]' });
    }
    return route.continue();
};

let failures = 0;
const check = (ok, label) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
    if (!ok) failures += 1;
};

const port = await reservePort();
const base = `http://127.0.0.1:${port}`;
const vite = spawn(viteBin, ['preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
console.log(`vite preview pid=${vite.pid} port=${port}`);

let browser;
try {
    await waitForServer(`${base}/`);
    browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});
    for (const vp of viewports) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        await context.route('**/*', handleRoute);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));
        await page.goto(`${base}/privacy`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '隱私權政策', level: 1 }).waitFor({ timeout: 15000 });

        const text = await page.locator('body').innerText();
        for (const t of expectedTexts) check(text.includes(t), `[${vp.name}] 頁面含「${t}」`);
        for (const t of forbiddenTexts) check(!text.includes(t), `[${vp.name}] 頁面不含「${t}」`);
        check(!text.includes('待業主確認'), `[${vp.name}] 內部註記「待業主確認」沒有顯示給訪客`);

        const metrics = await page.evaluate(() => {
            const vw = document.documentElement.clientWidth;
            const offenders = [];
            for (const el of document.querySelectorAll('body *')) {
                const r = el.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                if (getComputedStyle(el).position === 'fixed') continue;
                if (el.closest('[aria-hidden="true"]')) continue; // 頁首裝飾圓形刻意超出，父層 overflow-hidden 裁切
                if (r.right > vw + 1 || r.left < -1) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)}`);
            }
            return {
                vw,
                docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
                offenders: offenders.slice(0, 5),
            };
        });
        check(metrics.docOverflow <= 0 && metrics.bodyOverflow <= 0, `[${vp.name}] 整頁無水平溢出（scrollWidth−clientWidth：html=${metrics.docOverflow}、body=${metrics.bodyOverflow}，視窗寬 ${metrics.vw}px）`);
        check(metrics.offenders.length === 0, `[${vp.name}] 沒有元素超出視窗寬度${metrics.offenders.length ? `：${metrics.offenders.join('；')}` : ''}`);
        check(errors.length === 0, `[${vp.name}] 無 JS 錯誤${errors.length ? `：${errors.join('；')}` : ''}`);

        const shot = path.join(shotDir, `privacy-${vp.name}.png`);
        await page.screenshot({ path: shot, fullPage: true });
        console.log(`shot ${path.relative(appDir, shot)}`);

        // 新增段落所在區塊的特寫，方便業主對照
        for (const id of ['data-categories', 'purposes', 'use-scope', 'providers']) {
            const section = page.locator(`#${id}`);
            if (await section.count()) {
                const focus = path.join(shotDir, `privacy-${vp.name}-${id}.png`);
                await section.screenshot({ path: focus });
                console.log(`shot ${path.relative(appDir, focus)}`);
            } else {
                check(false, `[${vp.name}] 找不到區塊 #${id}`);
            }
        }
        await context.close();
    }
} finally {
    if (browser) await browser.close();
    vite.kill('SIGTERM');
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
