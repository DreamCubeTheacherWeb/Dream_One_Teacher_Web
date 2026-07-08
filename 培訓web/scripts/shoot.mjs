// DEV-ONLY 截圖腳本：用系統 Chrome（playwright-core，--no-save）截 dev-preview。
// 用法：node scripts/shoot.mjs [tag]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'fs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5174/dev-preview';
const OUT = 'scripts/shots';
const tag = process.argv[2] || 'v';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function shoot(name, width) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900); // 等入場動畫 + canvas 繪製
    const path = `${OUT}/${name}-${tag}.png`;
    await page.screenshot({ path, fullPage: true });
    console.log('saved', path);
    await page.close();
}

// 桌機 1280 與 手機 375 兩種寬
await shoot('desktop', 1280);
await shoot('mobile', 375);

await browser.close();
console.log('done');
