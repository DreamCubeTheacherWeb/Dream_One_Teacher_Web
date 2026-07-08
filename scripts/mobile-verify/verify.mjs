#!/usr/bin/env node
/**
 * 手機版確定性驗證腳本(培訓web)。
 *
 * 目的:Google OAuth 擋自動登入,所以這支腳本改用「偽造 localStorage session +
 * 攔截 Supabase API 回假資料」的方式,讓受保護頁面(需要 admin 角色)能在無真實登入的
 * 情況下渲染出來,藉此做手機版回歸測試(無橫向溢出、無白屏、無 pageerror)。
 *
 * 用法(在此目錄或任何目錄執行皆可,腳本內部會自己算路徑):
 *   node scripts/mobile-verify/verify.mjs
 *
 * 細節與已知限制見同目錄 README.md。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APP_DIR = path.join(REPO_ROOT, '培訓web');
const SHOTS_DIR = '/private/tmp/claude-501/-Users-lazylazy-Desktop------Dream-One-Teacher-Web/3fc538c2-fe2f-43c3-b5d8-acf80bee3d0f/scratchpad/mobile-shots';
const RESULTS_PATH = path.join(SHOTS_DIR, 'results.txt');
const PORT = 4199;
const BASE_URL = `http://localhost:${PORT}`;

if (!existsSync(APP_DIR)) {
  console.error(`FATAL: 找不到 APP_DIR ${APP_DIR}`);
  process.exit(1);
}
if (!existsSync(path.join(APP_DIR, 'dist', 'index.html'))) {
  console.error(`FATAL: ${APP_DIR}/dist 不存在或未 build,請先 cd 培訓web && npm run build`);
  process.exit(1);
}
mkdirSync(SHOTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 讀 .env 拿 Supabase URL,推算 project ref 與 localStorage session 的 key
// (supabase-js v2 預設 storageKey = `sb-${hostname 第一段}-auth-token`)
// ---------------------------------------------------------------------------
const envContent = readFileSync(path.join(APP_DIR, '.env'), 'utf8');
const envMap = Object.fromEntries(
  envContent.split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);
const SUPABASE_URL = envMap.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = envMap.VITE_SUPABASE_ANON_KEY;
if (!SUPABASE_URL) {
  console.error('FATAL: 培訓web/.env 缺 VITE_SUPABASE_URL');
  process.exit(1);
}
const SUPABASE_HOST = new URL(SUPABASE_URL).hostname; // e.g. mnovjlicwzwkefkhstte.supabase.co
const PROJECT_REF = SUPABASE_HOST.split('.')[0];
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

// ---------------------------------------------------------------------------
// 假登入身分:admin,才能走遍所有受保護頁面
// ---------------------------------------------------------------------------
const FAKE_USER_ID = '00000000-0000-4000-8000-000000000001';
const FAKE_EMAIL = 'mobile-verify-admin@test.local';
const NOW_ISO = new Date().toISOString();
const NOW_SEC = Math.floor(Date.now() / 1000);

const FAKE_AUTH_USER = {
  id: FAKE_USER_ID,
  aud: 'authenticated',
  role: 'authenticated',
  email: FAKE_EMAIL,
  email_confirmed_at: NOW_ISO,
  phone: '',
  confirmed_at: NOW_ISO,
  last_sign_in_at: NOW_ISO,
  app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { full_name: '手機驗證管理員', avatar_url: '' },
  identities: [],
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
};

const FAKE_SESSION = {
  access_token: 'mock-access-token.mobile-verify.payload',
  token_type: 'bearer',
  expires_in: 31536000,
  expires_at: NOW_SEC + 365 * 24 * 3600, // 遠未來,避開 GoTrueClient 的 90 秒過期緩衝而觸發 refresh
  refresh_token: 'mock-refresh-token',
  user: FAKE_AUTH_USER,
};

// public.users 那一列,對齊 AuthContext.fetchProfile 的 rawQuery('users', {select:'*', id:eq...})
const FAKE_USERS_ROW = {
  id: FAKE_USER_ID,
  name: '手機驗證管理員',
  email: FAKE_EMAIL,
  role: 'admin',
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
};

// ---------------------------------------------------------------------------
// 頁面清單與 viewport 清單
// ---------------------------------------------------------------------------
const PAGES = [
  { p: '/', slug: 'home' },
  { p: '/courses', slug: 'courses' },
  { p: '/leaderboard', slug: 'leaderboard' },
  { p: '/profile', slug: 'profile' },
  { p: '/my/salary', slug: 'my-salary' },
  { p: '/my/salary/new', slug: 'my-salary-new' },
  { p: '/contract', slug: 'contract' },
  { p: '/admin', slug: 'admin' },
  { p: '/admin/instructors', slug: 'admin-instructors' },
  { p: '/admin/claims', slug: 'admin-claims' },
  { p: '/pending', slug: 'pending' },
];

const VIEWPORTS = [
  { width: 390, height: 844, label: '390' },
  { width: 375, height: 667, label: '375' },
];

// ---------------------------------------------------------------------------
// 結果收集
// ---------------------------------------------------------------------------
const lines = [];
let passCount = 0;
let failCount = 0;

function record(status, pageLabel, width, assertion, detail) {
  const line = `${status} | ${pageLabel} | ${width} | ${assertion} | ${detail}`;
  lines.push(line);
  console.log(line);
  if (status === 'PASS') passCount++;
  else failCount++;
}

function info(text) {
  lines.push(text);
  console.log(text);
}

// ---------------------------------------------------------------------------
// 啟動 vite preview(cwd=培訓web,吃已 build 好的 dist)
// ---------------------------------------------------------------------------
function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = async () => {
      try {
        const res = await fetch(url, { method: 'GET' });
        if (res.ok || res.status === 404) {
          resolve();
          return;
        }
      } catch {
        // server 還沒起來,忽略
      }
      if (Date.now() > deadline) {
        reject(new Error(`server 在 ${timeoutMs}ms 內沒有就緒: ${url}`));
        return;
      }
      setTimeout(tryOnce, 300);
    };
    tryOnce();
  });
}

let previewProc = null;
function startPreviewServer() {
  const viteBin = path.join(APP_DIR, 'node_modules', '.bin', 'vite');
  previewProc = spawn(viteBin, ['preview', '--port', String(PORT), '--strictPort'], {
    cwd: APP_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  previewProc.stdout.on('data', () => {});
  previewProc.stderr.on('data', () => {});
  previewProc.on('error', (err) => {
    console.error('preview server 啟動失敗:', err.message);
  });
}

function stopPreviewServer() {
  if (previewProc && !previewProc.killed) {
    previewProc.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// Supabase route mock
// ---------------------------------------------------------------------------
async function handleRoute(route) {
  const req = route.request();
  const url = new URL(req.url());
  const host = url.hostname;

  if (host === 'localhost' || host === '127.0.0.1') {
    return route.continue();
  }

  if (!host.endsWith('.supabase.co')) {
    // 除本地 dev server 外的其他外部請求一律 abort(字型、分析、第三方腳本等)
    return route.abort();
  }

  const pathname = url.pathname;

  // --- Auth ---
  if (pathname.startsWith('/auth/v1/')) {
    if (pathname === '/auth/v1/user') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_AUTH_USER),
      });
    }
    if (pathname.startsWith('/auth/v1/token')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_SESSION),
      });
    }
    // 其他 auth 端點(settings、logout...)給個安全的空 200
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{}',
    });
  }

  // --- Storage ---
  if (pathname.startsWith('/storage/v1/')) {
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'not found (mocked)' }),
    });
  }

  // --- REST / RPC ---
  if (pathname.startsWith('/rest/v1/')) {
    const table = pathname.replace('/rest/v1/', '').split('/')[0];
    const method = req.method();
    const acceptHeader = (await req.allHeaders())['accept'] || '';
    const wantsSingle = acceptHeader.includes('vnd.pgrst.object+json');

    let body;
    let rowsForCount = 0;

    if (table === 'users' && method === 'GET') {
      body = [FAKE_USERS_ROW];
      rowsForCount = 1;
    } else if (wantsSingle) {
      // .single()/.maybeSingle():用 null 貼近「查無資料」的真實語意,
      // 避免回空陣列被誤判成 truthy 物件
      body = null;
    } else {
      body = [];
    }

    const headers = { 'content-type': 'application/json' };
    if (Array.isArray(body)) {
      rowsForCount = body.length;
      headers['content-range'] = rowsForCount > 0 ? `0-${rowsForCount - 1}/${rowsForCount}` : '*/0';
    }

    return route.fulfill({
      status: 200,
      headers,
      body: body === null ? 'null' : JSON.stringify(body),
    });
  }

  // 其他未預期的 supabase.co 請求,回 404 而不是掛住
  return route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ message: 'unhandled mock route (mobile-verify)' }),
  });
}

// ---------------------------------------------------------------------------
// 單一 viewport 的完整跑法
// ---------------------------------------------------------------------------
async function runViewport(chromium, browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });

  await context.addInitScript(({ key, session }) => {
    window.localStorage.setItem(key, JSON.stringify(session));
  }, { key: STORAGE_KEY, session: FAKE_SESSION });

  await context.route('**/*', handleRoute);

  const page = await context.newPage();

  let pageErrors = [];
  let consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const allConsoleErrorsThisRound = [];

  for (const pg of PAGES) {
    pageErrors = [];
    consoleErrors = [];

    const label = pg.p;
    const shotPath = path.join(SHOTS_DIR, `${pg.slug}-${viewport.label}.png`);

    try {
      await page.goto(BASE_URL + pg.p, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (err) {
      record('FAIL', label, viewport.label, 'page-load', `goto 失敗: ${err.message}`);
      continue;
    }

    try {
      await page.waitForLoadState('networkidle', { timeout: 1500 });
    } catch {
      // 1.5s 內沒到 networkidle 就算了,繼續往下跑
    }
    await page.waitForTimeout(300); // React render 緩衝

    // 斷言 A:無橫向溢出
    const overflowCheck = await page.evaluate(() => ({
      scrollWidth: document.body.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    if (overflowCheck.scrollWidth <= overflowCheck.innerWidth + 1) {
      record('PASS', label, viewport.label, 'no-horizontal-overflow',
        `scrollWidth=${overflowCheck.scrollWidth} innerWidth=${overflowCheck.innerWidth}`);
    } else {
      record('FAIL', label, viewport.label, 'no-horizontal-overflow',
        `scrollWidth=${overflowCheck.scrollWidth} innerWidth=${overflowCheck.innerWidth}`);
    }

    // 斷言 B:有渲染、沒白屏(空狀態渲染也算過;卡在 loading 骨架也算過)
    const renderCheck = await page.evaluate(() => {
      const root = document.getElementById('root');
      const text = root ? root.innerText.trim() : '';
      const hasSkeleton = !!document.querySelector('.animate-pulse, .animate-spin')
        || text.includes('載入中');
      return { textLen: text.length, hasSkeleton };
    });
    if (renderCheck.textLen > 20) {
      record('PASS', label, viewport.label, 'no-blank-screen', `rootTextLen=${renderCheck.textLen}`);
    } else if (renderCheck.hasSkeleton) {
      record('PASS', label, viewport.label, 'no-blank-screen',
        `rootTextLen=${renderCheck.textLen} (loading-skeleton,mock不足時的允許狀態)`);
    } else {
      record('FAIL', label, viewport.label, 'no-blank-screen', `rootTextLen=${renderCheck.textLen}`);
    }

    // 斷言 C:無 pageerror(特別是 ReferenceError,回歸驗證今天修的 6 處 Icon is not defined)
    if (pageErrors.length === 0) {
      record('PASS', label, viewport.label, 'no-pageerror', 'none');
    } else {
      record('FAIL', label, viewport.label, 'no-pageerror', pageErrors.join(' || '));
    }

    if (consoleErrors.length > 0) {
      allConsoleErrorsThisRound.push(`${label} (${viewport.label}): ${consoleErrors.join(' || ')}`);
    }

    await page.screenshot({ path: shotPath, fullPage: true });
  }

  if (allConsoleErrorsThisRound.length > 0) {
    info(`--- console error 彙總(僅供參考,不計入 PASS/FAIL,viewport ${viewport.label}) ---`);
    allConsoleErrorsThisRound.forEach((l) => info(l));
  }

  // -------------------------------------------------------------------------
  // 額外互動測試,只在 390 這輪、在首頁上跑
  // -------------------------------------------------------------------------
  if (viewport.label === '390') {
    await page.goto(BASE_URL + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    try {
      await page.waitForLoadState('networkidle', { timeout: 1500 });
    } catch {
      // ignore
    }
    await page.waitForTimeout(300);

    // 漢堡按鈕
    // 注意:Layout.jsx 同時渲染桌面版(hidden md:flex)與手機版(flex md:hidden)兩份導覽,
    // 通知鈴鐺甚至存在兩個實例(桌面版靠 CSS display:none 隱藏,但仍在 DOM 裡)。
    // 所以找按鈕時一定要濾掉 boundingClientRect 是 0x0(= 沒有實際版面/不可見)的那個,
    // 否則會抓到隱藏的桌面版元素,量出來的座標全是 0(曾經在此踩坑,見 README)。
    const hamburgerBox = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        if (!b.querySelector('svg.lucide-menu')) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });

    if (hamburgerBox && hamburgerBox.width >= 44 && hamburgerBox.height >= 44) {
      record('PASS', '/', '390', 'hamburger-tap-target',
        `${hamburgerBox.width.toFixed(1)}x${hamburgerBox.height.toFixed(1)}`);
    } else {
      record('FAIL', '/', '390', 'hamburger-tap-target',
        hamburgerBox ? `${hamburgerBox.width.toFixed(1)}x${hamburgerBox.height.toFixed(1)}` : '找不到漢堡按鈕');
    }

    // 點開手機選單
    const clicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        if (!b.querySelector('svg.lucide-menu')) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (clicked) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'menu-open-390.png'), fullPage: true });

      const linkHeights = await page.evaluate(() => {
        const header = document.querySelector('header');
        if (!header) return null;
        const panel = Array.from(header.querySelectorAll('div')).find(
          (d) => d.className.includes('shadow-lg') && d.className.includes('border-t')
        );
        if (!panel) return null;
        const items = Array.from(panel.querySelectorAll('a, button'));
        return items.map((el) => el.getBoundingClientRect().height);
      });

      if (linkHeights && linkHeights.length > 0) {
        const minHeight = Math.min(...linkHeights);
        if (minHeight >= 44) {
          record('PASS', '/', '390', 'mobile-menu-links-tap-target',
            `${linkHeights.length} 個項目,最小高度=${minHeight.toFixed(1)}`);
        } else {
          record('FAIL', '/', '390', 'mobile-menu-links-tap-target',
            `${linkHeights.length} 個項目,最小高度=${minHeight.toFixed(1)} (< 44)`);
        }
      } else {
        record('FAIL', '/', '390', 'mobile-menu-links-tap-target', '找不到選單面板或項目');
      }

      // 關閉選單,回到乾淨狀態再測通知鈴鐺
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find((b) => {
          if (!b.querySelector('svg.lucide-x')) return false;
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (btn) btn.click();
      });
      await page.waitForTimeout(300);
    } else {
      record('FAIL', '/', '390', 'mobile-menu-links-tap-target', '漢堡按鈕點擊失敗');
    }

    // 通知鈴鐺(NotificationBell 在桌面/手機導覽各渲染一份,務必只挑可見的那個)
    const bellClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => {
        if (!b.querySelector('svg.lucide-bell')) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!btn) return false;
      btn.click();
      return true;
    });

    if (bellClicked) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'bell-open-390.png'), fullPage: true });

      const panelRect = await page.evaluate(() => {
        const h3 = Array.from(document.querySelectorAll('h3')).find(
          (el) => el.textContent.trim() === '通知'
        );
        if (!h3 || !h3.parentElement || !h3.parentElement.parentElement) return null;
        const panel = h3.parentElement.parentElement;
        const r = panel.getBoundingClientRect();
        return { x: r.x, width: r.width, innerWidth: window.innerWidth };
      });

      if (panelRect && panelRect.width > 0 && panelRect.x >= 0 && panelRect.x + panelRect.width <= panelRect.innerWidth + 1) {
        record('PASS', '/', '390', 'notification-panel-in-viewport',
          `x=${panelRect.x.toFixed(1)} width=${panelRect.width.toFixed(1)} innerWidth=${panelRect.innerWidth}`);
      } else {
        record('FAIL', '/', '390', 'notification-panel-in-viewport',
          panelRect
            ? `x=${panelRect.x.toFixed(1)} width=${panelRect.width.toFixed(1)} innerWidth=${panelRect.innerWidth} (width<=0 表示面板沒有真的顯示)`
            : '找不到通知面板');
      }
    } else {
      record('FAIL', '/', '390', 'notification-panel-in-viewport', '通知鈴鐺點擊失敗(找不到按鈕,可能因為 mock 角色未顯示鈴鐺)');
    }
  }

  await context.close();
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  info(`=== 手機版驗證開始 ${new Date().toISOString()} ===`);
  info(`APP_DIR=${APP_DIR}`);
  info(`SUPABASE storageKey=${STORAGE_KEY}`);

  startPreviewServer();
  try {
    await waitForServer(BASE_URL, 30000);
  } catch (err) {
    console.error('FATAL:', err.message);
    stopPreviewServer();
    process.exit(1);
  }

  const playwrightEntry = pathToFileURL(
    path.join(APP_DIR, 'node_modules', 'playwright-core', 'index.mjs')
  ).href;
  const { chromium } = await import(playwrightEntry);

  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of VIEWPORTS) {
      info(`--- viewport ${vp.width}x${vp.height} ---`);
      await runViewport(chromium, browser, vp);
    }
  } finally {
    await browser.close();
    stopPreviewServer();
  }

  info(`SUMMARY: ${passCount} passed, ${failCount} failed`);
  writeFileSync(RESULTS_PATH, lines.join('\n') + '\n');

  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('FATAL uncaught:', err);
  stopPreviewServer();
  process.exitCode = 1;
});
