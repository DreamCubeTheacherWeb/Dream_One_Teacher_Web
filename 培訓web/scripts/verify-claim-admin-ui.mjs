#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = 4224;
const baseUrl = `http://localhost:${port}`;
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && line.includes('='))
  .map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = new Date().toISOString();
const importedImageBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mP8z8Dwn4GBgYGJAQoAHgQCAftBnf0AAAAASUVORK5CYII=',
  'base64',
);
const templateDocument = await PDFDocument.create();
templateDocument.addPage([595, 842]);
const templatePdfBytes = Buffer.from(await templateDocument.save());
const importedBankbookDocument = await PDFDocument.create();
const importedBankbookPage = importedBankbookDocument.addPage([300, 200]);
importedBankbookPage.drawRectangle({ x: 20, y: 20, width: 260, height: 160, borderWidth: 2 });
const importedBankbookPdfBytes = Buffer.from(await importedBankbookDocument.save());
let importedImageRequestCount = 0;
const adminId = '00000000-0000-4000-8000-0000000000a1';
const teacherId = '00000000-0000-4000-8000-0000000000a2';
const pendingId = '00000000-0000-4000-8000-0000000000a3';
const authUser = {
  id: adminId,
  aud: 'authenticated',
  role: 'authenticated',
  email: 'admin@example.com',
  app_metadata: { provider: 'google', providers: ['google'] },
  user_metadata: { full_name: '測試管理員' },
  created_at: now,
  updated_at: now,
};
const session = {
  access_token: 'mock.admin.token',
  refresh_token: 'mock.admin.refresh',
  token_type: 'bearer',
  expires_in: 31536000,
  expires_at: Math.floor(Date.now() / 1000) + 31536000,
  user: authUser,
};
const users = [
  { id: adminId, name: '測試管理員', email: authUser.email, role: 'admin', created_at: now },
  { id: teacherId, name: '已認領老師', email: 'claimed@example.com', role: 'teacher', created_at: now },
  { id: pendingId, name: '新註冊老師', email: 'new@example.com', role: 'pending', created_at: now },
];
const completeFields = {
  nickname: '老師', gender: '女', birth_date: '1990-01-01', id_number: 'A123456789',
  phone_mobile: '0912345678', line_id: 'line', address: '通訊地址', household_address: '戶籍地址',
  teaching_freq_semester: '每週一次', teaching_freq_vacation: '每週一次', teaching_regions: ['臺北市'],
  bio_notes: '經歷', bank_account_name: '老師', bank_name: '銀行', bank_branch: '分行',
  bank_account_number: '1234567890', bank_code: '1234567', employment_status: 'active',
};
const instructors = [
  {
    id: '00000000-0000-4000-8000-0000000000b1', user_id: null,
    full_name: '未認領匯入老師', email_primary: 'imported@example.com',
    ...completeFields,
    id_front_external_url: 'https://drive.google.com/open?id=front',
    id_back_external_url: 'https://drive.google.com/open?id=back',
    bankbook_external_url: 'https://drive.google.com/open?id=bankbook',
    photo_path: null, photo_external_url: null, created_at: now,
  },
  {
    id: '00000000-0000-4000-8000-0000000000b2', user_id: teacherId,
    full_name: '已認領老師', email_primary: 'claimed@example.com',
    ...completeFields,
    id_front_path: 'front.jpg', id_back_path: 'back.jpg', bankbook_path: 'bank.jpg', created_at: now,
  },
  {
    id: '00000000-0000-4000-8000-0000000000b3', user_id: pendingId,
    full_name: '新註冊老師', email_primary: 'new@example.com', created_at: now,
  },
];
const formDocuments = [{
  doc_type: 'remittance', display_name: '講師匯款資料表', version: 1,
  sort_order: 1, doc_category: 'form', is_active: true, file_path: 'forms/remittance.pdf',
}];
const formPositions = [
  { doc_type: 'remittance', doc_version: 1, field_type: 'id_front_image', page_number: 1, x: 40, y_from_top: 40, width: 120, height: 80 },
  { doc_type: 'remittance', doc_version: 1, field_type: 'id_back_image', page_number: 1, x: 180, y_from_top: 40, width: 120, height: 80 },
  { doc_type: 'remittance', doc_version: 1, field_type: 'bankbook_image', page_number: 1, x: 320, y_from_top: 40, width: 180, height: 100 },
];

const respond = (route, body, status = 200) => {
  const headers = { 'content-type': 'application/json' };
  if (Array.isArray(body)) headers['content-range'] = body.length ? `0-${body.length - 1}/${body.length}` : '*/0';
  return route.fulfill({ status, headers, body: JSON.stringify(body) });
};

async function handleRoute(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin === baseUrl) return route.continue();
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('gstatic.com')) return route.continue();
  if (url.hostname === 'drive.google.com' && url.pathname === '/uc') {
    importedImageRequestCount += 1;
    if (url.searchParams.get('id') === 'bankbook') {
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: importedBankbookPdfBytes });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: importedImageBytes });
  }
  if (!url.hostname.endsWith('.supabase.co')) return route.abort();

  if (url.pathname.startsWith('/auth/v1/')) {
    if (url.pathname === '/auth/v1/user') return respond(route, authUser);
    if (url.pathname.startsWith('/auth/v1/token')) return respond(route, session);
    return respond(route, {});
  }
  if (url.pathname === '/rest/v1/rpc/claim_my_precreated_instructor') {
    return respond(route, { status: 'staff' });
  }
  if (url.pathname.includes('/storage/v1/object/') && url.pathname.endsWith('/forms/remittance.pdf')) {
    return route.fulfill({ status: 200, contentType: 'application/pdf', body: templatePdfBytes });
  }
  if (url.pathname.startsWith('/rest/v1/rpc/')) return respond(route, null);
  if (!url.pathname.startsWith('/rest/v1/')) return respond(route, {}, 404);

  const table = url.pathname.replace('/rest/v1/', '').split('/')[0];
  const wantsObject = ((await request.allHeaders()).accept || '').includes('vnd.pgrst.object+json');
  if (request.method() !== 'GET') return route.fulfill({ status: 204, body: '' });

  let rows = [];
  if (table === 'users') {
    const idFilter = url.searchParams.get('id');
    rows = idFilter ? users.filter((item) => idFilter === `eq.${item.id}`) : users;
  } else if (table === 'instructors') {
    const userFilter = url.searchParams.get('user_id');
    rows = userFilter ? instructors.filter((item) => userFilter === `eq.${item.user_id}`) : instructors;
  } else if (table === 'contract_documents') {
    rows = formDocuments;
  } else if (table === 'contract_field_positions') {
    rows = formPositions;
  }
  return respond(route, wantsObject ? (rows[0] || null) : rows);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch { /* preview not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('preview server timeout');
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], {
  cwd: appDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await waitForServer();
  browser = await chromium.launch(existsSync(chromePath) ? { executablePath: chromePath } : {});
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
    key: storageKey,
    value: session,
  });
  await context.route('**/*', handleRoute);
  const page = await context.newPage();

  await page.goto(`${baseUrl}/admin/instructors`, { waitUntil: 'networkidle' });
  assert.match(await page.locator('body').innerText(), /3 位.*2.*已認領.*1.*未認領/s);
  assert.ok(await page.getByText('未認領匯入老師', { exact: true }).count() > 0);
  const importedRow = page.locator('tr').filter({ hasText: '未認領匯入老師' }).first();
  assert.match(await importedRow.innerText(), /3\/3/);
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await importedRow.getByRole('button', { name: '下載表單' }).click();
  const download = await downloadPromise.catch(async (error) => {
    throw new Error(`${error.message}\nPAGE: ${await page.locator('body').innerText()}`);
  });
  const outputBytes = readFileSync(await download.path());
  const outputPdf = await PDFDocument.load(outputBytes);
  assert.equal(importedImageRequestCount, 3);
  assert.equal(outputPdf.getPageCount(), 1);
  assert.ok(outputBytes.length > templatePdfBytes.length);
  console.log('PASS  講師資料總覽顯示所有主檔與認領狀態');
  console.log('PASS  外部匯入的身分證正反面與存摺實際嵌入 PDF');

  await page.goto(`${baseUrl}/admin/download-center`, { waitUntil: 'networkidle' });
  assert.ok(await page.getByText('未認領匯入老師', { exact: true }).count() > 0);
  const importedCard = page.getByText('未認領匯入老師', { exact: true }).first().locator('..').locator('..');
  assert.match(await importedCard.innerText(), /已認領|未認領/);
  assert.doesNotMatch(await importedCard.innerText(), /還缺.*大頭照/);
  console.log('PASS  未認領匯入講師也會出現在表單下載，且大頭照不算缺項');

  await page.goto(`${baseUrl}/admin/teachers`, { waitUntil: 'networkidle' });
  const accountText = await page.locator('body').innerText();
  assert.match(accountText, /帳號審核與權限/);
  assert.match(accountText, /主檔已認領\s*2|2\s*主檔已認領/);
  assert.doesNotMatch(accountText, /邀請名單|新增邀請/);
  console.log('PASS  帳號後台只處理新註冊審核，不再出現邀請名單');

  await context.close();
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
}
