// DEV-ONLY 最終截圖：三個物件各自單獨截（桌機 1280 + 手機 375）。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5174/dev-preview';
const OUT = 'scripts/shots';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function shootEl(name, width, selector) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const el = await page.$(selector);
    const path = `${OUT}/${name}.png`;
    await el.screenshot({ path });
    console.log('saved', path);
    await page.close();
}

// 排行榜：桌機 + 手機
await shootEl('final-leaderboard-desktop', 1280, '#sec-leaderboard');
await shootEl('final-leaderboard-mobile', 375, '#sec-leaderboard');
// 驗證閘門：桌機（三欄）+ 手機（堆疊）
await shootEl('final-otp-desktop', 1280, '#sec-otp');
await shootEl('final-otp-mobile', 375, '#sec-otp');
// 證書：固定 A4，一張即可（桌機寬較清晰）+ 手機縮放
await shootEl('final-cert-desktop', 1280, '#sec-cert');
await shootEl('final-cert-mobile', 375, '#sec-cert');

await browser.close();
console.log('done');
