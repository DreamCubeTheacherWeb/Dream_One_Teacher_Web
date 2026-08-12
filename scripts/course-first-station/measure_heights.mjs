import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const APP_DIR = '/Users/lazylazy/Desktop/夢想一號/Dream_One_Teacher_Web/培訓web';
const { chromium } = await import(pathToFileURL(path.join(APP_DIR, 'node_modules', 'playwright-core', 'index.mjs')));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
await page.goto('file://' + path.join(process.cwd(), 'preview', 'measure.html'), { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
const hs = await page.evaluate(() =>
  [...document.querySelectorAll('.m')].map(d => Math.ceil(d.getBoundingClientRect().height)));
fs.writeFileSync('heights.json', JSON.stringify(hs));
console.log('measured', hs.length, 'heights; min', Math.min(...hs), 'max', Math.max(...hs));
await browser.close();
