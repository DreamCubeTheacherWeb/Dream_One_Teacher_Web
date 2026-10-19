#!/usr/bin/env node
/*
 * 老師入門＋帳號啟用＋電子簽約端到端測試（第一、二階段）：本機假 Supabase＋真瀏覽器。
 *
 *   npm run e2e:onboarding                    # 預設連跑 3 次，每次全新資料庫
 *   npm run e2e:onboarding -- --runs=1        # 只跑 1 次
 *   npm run e2e:onboarding -- --only=A,B      # 只跑指定情境
 *   npm run e2e:onboarding -- --vite=dev      # 改用 vite dev server（預設是 build＋preview 快照）
 *
 * 架構：暫時 PostgreSQL（initdb）→ scripts/e2e/bootstrap.sql（Supabase 相容底座）→ repo 全部 SQL
 *       → PostgREST → scripts/e2e/lib/gateway.mjs（/rest 轉發、假 GoTrue、假 Storage）→ Vite → Playwright。
 * 絕不連正式 Supabase；不改 培訓web/.env。macOS 沙盒下 initdb 需要 shared memory，請在沙盒外執行。
 * 測不到：Google OAuth 本身、Supabase Auth Hook 是否真的掛在專案上（hook 函式本身有以 supabase_auth_admin 呼叫）。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startStack } from './lib/stack.mjs';
import { makeApi, seedBaseline } from './lib/fixtures.mjs';
import { launchBrowser } from './lib/browser.mjs';
import { Results } from './lib/util.mjs';
import { SCENARIOS as TEACHER_SCENARIOS, selfTest } from './scenarios.mjs';
import { ADMIN_SCENARIOS } from './scenarios-admin.mjs';
import { ESIGN_SCENARIOS } from './scenarios-esign.mjs';

// 執行順序有意義：SEC 的最後一步會竄改證據鏈（全域），必須排最後
const SCENARIOS = { ...TEACHER_SCENARIOS, ...ADMIN_SCENARIOS, ...ESIGN_SCENARIOS };

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? 'true'];
}));
const runs = Number(args.runs || 3);
const only = args.only ? args.only.split(',').map((x) => x.trim().toUpperCase()) : Object.keys(SCENARIOS);
const viteMode = args.vite === 'dev' ? 'dev' : 'preview';
const shotsDir = path.join(appDir, 'docs/verification/2026-10-20-esign-e2e');
mkdirSync(shotsDir, { recursive: true });

let activeStack = null;
let activeBrowser = null;
const cleanup = async () => {
  try { await activeBrowser?.close(); } catch { /* ignore */ }
  try { await activeStack?.stop(); } catch { /* ignore */ }
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\n收到 ${signal}，收掉本測試起的行程…`);
    await cleanup();
    process.exit(130);
  });
}

async function runOnce(runIndex) {
  const r = new Results(`[run ${runIndex}] `);
  const findings = new Set();
  const consoleErrors = [];
  console.log(`\n════════ RUN ${runIndex}/${runs}（全新資料庫） ════════`);
  activeStack = await startStack({ appDir, viteMode });
  try {
    const { chainReport } = activeStack;
    r.check(`套用 repo 全部 SQL（${chainReport.applied.length - 1} 個檔）`, chainReport.applied.length > 1,
      chainReport.patched.length ? `文字修補 ${chainReport.patched.length} 處：${[...new Set(chainReport.patched.map((p) => p.file))].join(', ')}` : '');
    const api = makeApi(activeStack);
    const base = await seedBaseline(activeStack, api);
    activeBrowser = await launchBrowser(appDir);
    const ctx = { stack: activeStack, api, base, browser: activeBrowser, r, shotsDir, findings, consoleErrors, run: runIndex, state: {} };
    // 已知問題：同時進「發現」清單與 KNOWN-ISSUE 計數
    ctx.known = (title, text) => { findings.add(text); r.known(title); };
    console.log('\n── 底座自檢 ──');
    try {
      await selfTest(ctx);
    } catch (error) {
      r.check('底座自檢中途例外', false, error.message);
    }
    for (const key of only) {
      const fn = SCENARIOS[key];
      if (!fn) {
        r.blocked(`${key} 未知情境`);
        continue;
      }
      console.log(`\n── 情境 ${key} ──`);
      const started = Date.now();
      try {
        await fn(ctx);
      } catch (error) {
        r.check(`${key} 情境中途例外`, false, error.stack?.split('\n').slice(0, 3).join(' | ') || error.message);
      }
      console.log(`   （${key} 用時 ${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
    }
    const rpcErrors = activeStack.gateway.requests.filter((req) => req.status >= 500);
    r.check('閘道沒有任何 5xx 回應', rpcErrors.length === 0, rpcErrors.slice(0, 5).map((x) => `${x.method} ${x.path} ${x.status}`).join('; '));
    if (findings.size) {
      console.log('\n發現（已知問題與設計行為紀錄，非斷言）：');
      for (const finding of findings) console.log(`  - ${finding}`);
    }
    const noisy = consoleErrors.filter((line) => !/Failed to load resource|favicon/i.test(line));
    if (noisy.length) {
      console.log(`\n瀏覽器 console 錯誤（${noisy.length} 則，前 8 則）：`);
      for (const line of [...new Set(noisy)].slice(0, 8)) console.log(`  - ${line.slice(0, 220)}`);
    }
  } finally {
    try { await activeBrowser?.close(); } catch { /* ignore */ }
    activeBrowser = null;
    await activeStack.stop();
    activeStack = null;
  }
  const counts = r.counts();
  console.log(`\nRUN ${runIndex} 結果：PASS ${counts.PASS}／FAIL ${counts.FAIL}／BLOCKED ${counts.BLOCKED}／已知問題 ${counts.KNOWN}（共 ${r.items.length} 項）`);
  return counts;
}

const totals = [];
let fatal = false;
for (let i = 1; i <= runs; i += 1) {
  try {
    totals.push(await runOnce(i));
  } catch (error) {
    fatal = true;
    console.error(`RUN ${i} 無法完成：${error.stack || error.message}`);
    totals.push({ PASS: 0, FAIL: 1, BLOCKED: 0, KNOWN: 0 });
  }
}
console.log('\n════════ 總結 ════════');
totals.forEach((c, i) => console.log(`RUN ${i + 1}: PASS ${c.PASS} / FAIL ${c.FAIL} / BLOCKED ${c.BLOCKED} / KNOWN-ISSUE ${c.KNOWN}`));
const sum = totals.reduce((acc, c) => ({ PASS: acc.PASS + c.PASS, FAIL: acc.FAIL + c.FAIL, BLOCKED: acc.BLOCKED + c.BLOCKED, KNOWN: acc.KNOWN + c.KNOWN }), { PASS: 0, FAIL: 0, BLOCKED: 0, KNOWN: 0 });
console.log(`TOTAL: PASS ${sum.PASS} / FAIL ${sum.FAIL} / BLOCKED ${sum.BLOCKED} / KNOWN-ISSUE ${sum.KNOWN}（${runs} 次；KNOWN-ISSUE 不影響結束碼）`);
console.log(`截圖：${shotsDir}`);
process.exit(fatal || sum.FAIL > 0 || sum.BLOCKED > 0 ? 1 : 0);
