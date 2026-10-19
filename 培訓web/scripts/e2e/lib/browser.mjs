// 真瀏覽器（playwright-core）：每個假帳號一個獨立 context，
// 在頁面載入前把 supabase-js 的 session 寫進 localStorage（等同 Google 登入回跳後的狀態）。
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export async function launchBrowser(appDir) {
  const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
  try {
    return await chromium.launch({ headless: true });
  } catch (bundledError) {
    const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (!existsSync(systemChrome)) throw bundledError;
    return chromium.launch({ headless: true, executablePath: systemChrome });
  }
}

// auth-js 預設 storageKey：`sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`
// （node_modules/@supabase/supabase-js/dist/index.mjs 的 defaultStorageKey）
export const storageKeyFor = (supabaseUrl) => `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;

export async function openAs(browser, stack, user, { viewport = { width: 1280, height: 900 }, label } = {}) {
  const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  const key = storageKeyFor(stack.supabaseUrl);
  if (user?.session) {
    await context.addInitScript(({ storageKey, session }) => {
      // 只在第一次載入時寫入；之後 supabase-js 自己更新（例如 Email OTP 驗證後換新 session）
      try {
        if (!window.localStorage.getItem(storageKey)) window.localStorage.setItem(storageKey, JSON.stringify(session));
      } catch { /* ignore */ }
    }, { storageKey: key, session: user.session });
  }
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const dialogs = [];
  const consoleErrors = [];
  page.on('dialog', async (dialog) => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  return { context, page, dialogs, consoleErrors, label: label || user?.email };
}

export async function shot(page, dir, name, { fullPage = true } = {}) {
  if (!dir) return null;
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}

// 量水平溢出：整頁可捲寬度不得超過視窗寬，並列出最突出的元素方便除錯
export async function measureOverflow(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const docWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const offenders = [];
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.right > vw + 1) {
        const style = getComputedStyle(el);
        if (style.position === 'fixed' || style.visibility === 'hidden') continue;
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (['hidden', 'clip', 'auto', 'scroll'].includes(ps.overflowX)) { clipped = true; break; }
        }
        if (!clipped) offenders.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} right=${Math.round(rect.right)}`);
      }
    }
    return { viewport: vw, docWidth, overflow: docWidth > vw, offenders: offenders.slice(0, 5) };
  });
}

// ProfilePage 的 <Field label="…">：label.bh-label 後面緊接的 input／select／textarea
export function fieldControl(page, label) {
  // 有些欄位外面再包一層 div（例如戶籍地址旁的「同通訊地址」按鈕），所以找緊接的第一個元素本身或其子孫
  return page.locator(`xpath=(//label[contains(@class,"bh-label")][normalize-space(text()[1])="${label}"]/following-sibling::*[1]/descendant-or-self::*[self::input or self::select or self::textarea])[1]`);
}
