#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync, spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4219;
const baseUrl = `http://127.0.0.1:${port}`;
const screenshotDir = '/tmp/dream-one-teaching-materials-navigation';
const defaultUrl = 'https://dreamone-teaching-materials.vercel.app/';
const editedUrl = 'https://example.com/updated-teaching-materials';
mkdirSync(screenshotDir, { recursive: true });

const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    }));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const userId = '00000000-0000-4000-8000-000000000001';
const now = new Date().toISOString();
const authUser = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'materials-admin@test.local',
    email_confirmed_at: now,
    app_metadata: { provider: 'google', providers: ['google'] },
    user_metadata: { full_name: '教材管理員' },
    identities: [],
    created_at: now,
    updated_at: now,
};
const session = {
    access_token: 'mock.access.token',
    token_type: 'bearer',
    expires_in: 31536000,
    expires_at: Math.floor(Date.now() / 1000) + 31536000,
    refresh_token: 'mock.refresh.token',
    user: authUser,
};
let userRole = 'admin';
let instructorRow = null;
let savedTeachingMaterialsUrl = null;
let savedPayload = null;

const currentProfile = () => ({
    id: userId,
    name: userRole === 'teacher' ? '教材講師' : '教材管理員',
    email: authUser.email,
    role: userRole,
});

const completeInstructor = {
    user_id: userId,
    full_name: '教材講師',
    nickname: '教材講師',
    gender: 'female',
    birth_date: '1990-01-01',
    id_number: 'A123456789',
    phone_mobile: '0912345678',
    line_id: 'materials_teacher',
    address: '台北市測試路 1 號',
    household_address: '台北市測試路 1 號',
    email_primary: 'materials-teacher@test.local',
    teaching_freq_semester: '每週一次',
    teaching_freq_vacation: '每週一次',
    bio_notes: '教材資源導航驗證資料',
    bank_account_name: '教材講師',
    bank_name: '測試銀行',
    bank_branch: '測試分行',
    bank_account_number: '123456789012',
    bank_code: '000',
    teaching_regions: ['台北市'],
    id_front_path: 'profiles/id-front.png',
    id_back_path: 'profiles/id-back.png',
    bankbook_path: 'profiles/bankbook.png',
};

const fulfillJson = (route, data, status = 200) => route.fulfill({
    status,
    headers: {
        'content-type': 'application/json',
        'content-range': Array.isArray(data) && data.length ? `0-${data.length - 1}/${data.length}` : '*/0',
    },
    body: JSON.stringify(data),
});

const siteLinkRows = () => savedTeachingMaterialsUrl ? [{
    key: 'teaching_materials',
    label: '教材資源',
    description: '講師導航列的教材系統入口',
    url: savedTeachingMaterialsUrl,
    updated_at: now,
}] : [];

async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
    if (!url.hostname.endsWith('.supabase.co')) return route.abort();

    if (url.pathname === '/auth/v1/user') return fulfillJson(route, authUser);
    if (url.pathname.startsWith('/auth/v1/')) return fulfillJson(route, session);

    if (url.pathname.startsWith('/rest/v1/rpc/')) return fulfillJson(route, null);

    if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
        const method = request.method();
        if (table === 'site_links') {
            if (method === 'GET' || method === 'HEAD') return fulfillJson(route, siteLinkRows());
            savedPayload = request.postDataJSON();
            const row = Array.isArray(savedPayload) ? savedPayload[0] : savedPayload;
            if (row?.key === 'teaching_materials') savedTeachingMaterialsUrl = row.url;
            return fulfillJson(route, [], 201);
        }
        if (table === 'users') return fulfillJson(route, method === 'HEAD' ? [] : [currentProfile()]);
        if (table === 'instructors') return fulfillJson(route, instructorRow ? [instructorRow] : []);
        return fulfillJson(route, []);
    }

    return fulfillJson(route, {}, 404);
}

const expect = (condition, message) => {
    if (!condition) throw new Error(message);
    process.stdout.write(`PASS ${message}\n`);
};

const waitForServer = async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15000) {
        try {
            const response = await fetch(baseUrl);
            if (response.ok) return;
        } catch { /* preview 尚未啟動 */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Vite preview did not start');
};

const prepareContext = async (browser, options) => {
    const context = await browser.newContext(options);
    await context.addInitScript(({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: session });
    await context.route('**/*', handleRoute);
    return context;
};

execSync('npm run build', { cwd: appDir, stdio: 'inherit' });
const preview = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
});

let browser;
try {
    await waitForServer();
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });

    const desktop = await prepareContext(browser, { viewport: { width: 1440, height: 1000 } });
    const page = await desktop.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    const desktopLink = page.getByRole('link', { name: '教材資源（在新分頁開啟）' });
    await desktopLink.waitFor();
    expect(await desktopLink.getAttribute('href') === defaultUrl, '導航列未設定資料時使用指定預設網址');
    expect(await desktopLink.getAttribute('target') === '_blank', '桌面導航從新分頁直接開啟教材資源');

    await page.goto(`${baseUrl}/admin/salary-links`, { waitUntil: 'networkidle' });
    expect(await page.getByRole('heading', { name: '網站連結管理' }).isVisible(), '後台提供網站連結管理入口');
    const urlInput = page.locator('#teaching-materials-url');
    expect(await urlInput.inputValue() === defaultUrl, '後台預填教材資源指定網址');
    await urlInput.fill(editedUrl);
    await page.getByRole('button', { name: '儲存' }).first().click();
    await page.getByText('已儲存', { exact: true }).waitFor();
    expect(savedPayload?.key === 'teaching_materials', '後台以 teaching_materials key 儲存設定');
    expect(savedPayload?.url === editedUrl, '後台儲存更新後的教材資源網址');
    await page.screenshot({ path: `${screenshotDir}/admin-site-links-1440.png`, fullPage: true });

    await page.goto(baseUrl, { waitUntil: 'networkidle' });
    await desktopLink.waitFor();
    expect(await desktopLink.getAttribute('href') === editedUrl, '導航列重新載入後採用後台編輯網址');
    expect((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1440, '1440px 桌面導航沒有水平溢出');
    await page.setViewportSize({ width: 1280, height: 900 });
    const headerSpacing = await page.evaluate(() => {
        const headerRow = document.querySelector('header > div');
        const brand = headerRow?.querySelector(':scope > a');
        const nav = headerRow?.querySelector(':scope > nav');
        if (!brand || !nav || getComputedStyle(nav).display === 'none') return { desktopHidden: true };
        const brandRect = brand.getBoundingClientRect();
        const navRect = nav.getBoundingClientRect();
        return { desktopHidden: false, brandRight: brandRect.right, navLeft: navRect.left, navRight: navRect.right };
    });
    expect(headerSpacing.desktopHidden || headerSpacing.brandRight + 8 <= headerSpacing.navLeft, '1280px 導航不會與站台品牌重疊');
    expect(headerSpacing.desktopHidden || headerSpacing.navRight <= 1280, '1280px 導航內容保持在畫面內');
    expect(pageErrors.length === 0, '桌面流程沒有頁面錯誤');
    await desktop.close();

    const mobile = await prepareContext(browser, {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
    });
    const mobilePage = await mobile.newPage();
    const mobileErrors = [];
    mobilePage.on('pageerror', (error) => mobileErrors.push(error.message));
    await mobilePage.goto(baseUrl, { waitUntil: 'networkidle' });
    await mobilePage.locator('header button').filter({ has: mobilePage.locator('svg') }).last().click();
    const mobileLink = mobilePage.getByRole('link', { name: '教材資源（在新分頁開啟）' });
    await mobileLink.waitFor();
    expect(await mobileLink.getAttribute('href') === editedUrl, '手機導航顯示並採用後台編輯網址');
    expect(await mobileLink.evaluate((element) => element.getBoundingClientRect().height) >= 44, '手機教材資源入口觸控高度至少 44px');
    expect((await mobilePage.evaluate(() => document.documentElement.scrollWidth)) <= 390, '390px 手機導航沒有水平溢出');
    expect(mobileErrors.length === 0, '手機流程沒有頁面錯誤');
    await mobilePage.screenshot({ path: `${screenshotDir}/mobile-navigation-390.png`, fullPage: true });
    await mobile.close();

    userRole = 'teacher';
    instructorRow = null;

    const incompleteDesktop = await prepareContext(browser, { viewport: { width: 1440, height: 1000 } });
    const incompletePage = await incompleteDesktop.newPage();
    await incompletePage.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
    const lockedDesktopButton = incompletePage.getByRole('button', { name: '教材資源（請先完成個人資料）' });
    await lockedDesktopButton.waitFor();
    expect(await lockedDesktopButton.isDisabled(), '未完成個人資料時桌面教材資源入口保持鎖定且無法點擊');
    expect(await incompletePage.getByRole('link', { name: '教材資源（在新分頁開啟）' }).count() === 0, '未完成個人資料時桌面不提供外部教材連結');
    await incompletePage.screenshot({ path: `${screenshotDir}/profile-incomplete-navigation-1440.png`, fullPage: true });

    const incompleteMobile = await prepareContext(browser, {
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        hasTouch: true,
        isMobile: true,
    });
    const incompleteMobilePage = await incompleteMobile.newPage();
    await incompleteMobilePage.goto(`${baseUrl}/profile`, { waitUntil: 'networkidle' });
    await incompleteMobilePage.locator('header button').filter({ has: incompleteMobilePage.locator('svg') }).last().click();
    const lockedMobileButton = incompleteMobilePage.getByRole('button', { name: '教材資源（請先完成個人資料）' });
    await lockedMobileButton.waitFor();
    expect(await lockedMobileButton.isDisabled(), '未完成個人資料時手機教材資源入口保持鎖定且無法點擊');
    expect(await incompleteMobilePage.getByRole('link', { name: '教材資源（在新分頁開啟）' }).count() === 0, '未完成個人資料時手機不提供外部教材連結');
    expect(await lockedMobileButton.evaluate((element) => element.getBoundingClientRect().height) >= 44, '手機鎖定入口觸控高度至少 44px');
    await incompleteMobilePage.screenshot({ path: `${screenshotDir}/profile-incomplete-mobile-navigation-390.png`, fullPage: true });
    await incompleteMobile.close();

    instructorRow = completeInstructor;
    await incompletePage.evaluate((detail) => {
        window.dispatchEvent(new CustomEvent('instructor-profile-saved', { detail }));
    }, completeInstructor);
    const unlockedDesktopLink = incompletePage.getByRole('link', { name: '教材資源（在新分頁開啟）' });
    await unlockedDesktopLink.waitFor();
    expect(await incompletePage.getByRole('button', { name: '教材資源（請先完成個人資料）' }).count() === 0, '個人資料儲存完整後立即解除教材資源鎖定');
    expect(await unlockedDesktopLink.getAttribute('href') === editedUrl, '解鎖後教材資源採用後台編輯網址');
    await incompleteDesktop.close();

    process.stdout.write(`Screenshots: ${screenshotDir}\n`);
} finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
}
