#!/usr/bin/env node
/*
 * 瀏覽器回歸：Email 未命中的 pending 帳號先選新進／非新進；
 * 非新進以姓名、完整手機及身分證末四碼核對，成功後帶入既有主檔。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4222;
const baseUrl = `http://localhost:${port}`;
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const envMap = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
const projectRef = new URL(envMap.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000031';
const instructorId = '00000000-0000-4000-8000-000000000032';
const now = new Date().toISOString();

const authUser = {
  id: userId,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'yijin@dreamcube.tw',
  email_confirmed_at: now,
  app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { full_name: '蔡宜津', avatar_url: '' },
  identities: [],
  created_at: now,
  updated_at: now,
};
const session = {
  access_token: 'mock.identity.payload',
  token_type: 'bearer',
  expires_in: 31536000,
  expires_at: Math.floor(Date.now() / 1000) + 31536000,
  refresh_token: 'mock.identity.refresh',
  user: authUser,
};
const instructor = {
  id: instructorId,
  user_id: userId,
  full_name: '蔡宜津',
  nickname: '宜津',
  gender: '女',
  birth_date: '1990-01-01',
  id_number: 'A123456789',
  phone_mobile: '0912-345-678',
  line_id: 'yijin-line',
  address: '原講師通訊地址',
  household_address: '原講師戶籍地址',
  email_primary: 'ww20413@gmail.com',
  email_secondary: null,
  teaching_regions: ['臺北市'],
  employment_status: 'active',
  photo_path: null,
};

let linked = false;
let identityPayload = null;

function jsonResponse(route, data) {
  const headers = { 'content-type': 'application/json' };
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
    if (url.pathname === '/auth/v1/user') return jsonResponse(route, authUser);
    if (url.pathname.startsWith('/auth/v1/token')) return jsonResponse(route, session);
    return jsonResponse(route, {});
  }

  if (url.pathname === '/rest/v1/rpc/claim_my_precreated_instructor') {
    return jsonResponse(route, linked
      ? { status: 'claimed', instructor_id: instructorId, claimed_now: false }
      : { status: 'new' });
  }

  if (url.pathname === '/rest/v1/rpc/claim_existing_instructor_by_identity') {
    identityPayload = request.postDataJSON();
    linked = true;
    return jsonResponse(route, { status: 'claimed', instructor_id: instructorId, claimed_now: true });
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
        id: userId,
        name: '蔡宜津',
        email: authUser.email,
        role: linked ? 'teacher' : 'pending',
        created_at: now,
      };
      return jsonResponse(route, wantsObject ? row : [row]);
    }

    if (table === 'instructors') {
      const rows = linked ? [instructor] : [];
      return jsonResponse(route, wantsObject ? (rows[0] || null) : rows);
    }

    return jsonResponse(route, wantsObject ? null : []);
  }

  return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
}

async function waitForServer(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) return;
    } catch { /* preview 尚未啟動 */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`server timeout: ${url}`);
}

const results = [];
function assertResult(name, condition, detail = '') {
  results.push(Boolean(condition));
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

async function main() {
  execSync('npm run build', { cwd: appDir, stdio: 'inherit' });
  const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    await waitForServer(baseUrl, 15000);
    browser = await chromium.launch(existsSync(systemChrome) ? { executablePath: systemChrome } : {});
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: session });
    await context.route('**/*', handleRoute);
    const page = await context.newPage();

    await page.goto(`${baseUrl}/pending`, { waitUntil: 'networkidle', timeout: 20000 });
    try {
      await page.getByText('請選擇你的講師身分', { exact: true }).waitFor({ timeout: 8000 });
    } catch (error) {
      console.error('Pending page debug:', page.url(), await page.locator('body').innerText());
      throw error;
    }
    assertResult('Email 未命中顯示新進與非新進',
      await page.getByRole('button', { name: /^新進/ }).isVisible()
      && await page.getByRole('button', { name: /^非新進/ }).isVisible());
    assertResult('顯示 8/25 後加入群組選新進的備註',
      await page.getByText('8/25 後才加入講師群組的，請選「新進」。', { exact: true }).isVisible());

    await page.getByRole('button', { name: /^非新進/ }).click();
    assertResult('非新進表單預填 Google 姓名',
      await page.locator('#claim-full-name').inputValue() === '蔡宜津');
    await page.locator('#claim-phone').fill('0912-345-678');
    await page.locator('#claim-id-last-four').fill('6789');
    await page.getByRole('button', { name: '核對並帶入資料' }).click();

    await page.waitForURL('**/profile', { timeout: 10000 });
    await page.waitForFunction(() => [...document.querySelectorAll('input')]
      .some((input) => input.value === '宜津'), null, { timeout: 8000 });
    assertResult('核對送出完整手機與身分證末四碼',
      identityPayload?.provided_full_name === '蔡宜津'
      && identityPayload?.provided_phone_mobile === '0912345678'
      && identityPayload?.provided_id_last_four === '6789', JSON.stringify(identityPayload));
    assertResult('核對成功後帶入既有講師資料',
      await page.locator('input').evaluateAll((inputs) => inputs.some((input) => input.value === '宜津'))
      && await page.locator('input').evaluateAll((inputs) => inputs.some((input) => input.value === 'ww20413@gmail.com')));

    await context.close();
  } finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} PASS ===`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
