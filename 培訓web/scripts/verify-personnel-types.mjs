#!/usr/bin/env node
// 驗證 20261022100000_personnel_types.sql（人員類別／合作狀態拆欄）。只用本機暫時 PostgreSQL，不連任何遠端資料庫。
//   1. 靜態：三個函式除指定改動外與 repo 最新定義逐行相同；repo 內沒有更晚的重定義；preflight 的預期 md5 與實算相符。
//   2. 套用：先套檔名排在前面的 20261022010000＋20261022093700，再套本 migration；每項都要 PASS（含課程可見性整合檢查）。
//      另一輪不套那兩支、只套本 migration，也要全部 PASS（本 migration 不依賴它們）。
//   3. 反向對照（套那兩支、不套本 migration）：tag new 的檢查必須全部 FAIL、tag old 的必須全部 PASS。
//   4. preflight 在各庫實跑（唯讀 session）；負向對照：換成 8/19 版完整度包裝函式後第 7 段要判 false；lock_timeout 實測。
//   5. 回歸：把既有 verify-instructor-claim-flow.sql、verify-security-hardening.sql、verify-rls-audience-mentor.sql
//      疊上本 migration 後重跑，必須通過。
// macOS 上 postgres 需要 LC_ALL，否則會報 postmaster became multithreaded；未設定時自動補 en_US.UTF-8。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(appDir, 'supabase/migrations');
const migrationName = '20261022100000_personnel_types.sql';
const migrationPath = path.join(migrationsDir, migrationName);
const workDir = mkdtempSync(path.join(tmpdir(), 'dream-one-personnel-types-'));
const pgEnv = { ...process.env, LC_ALL: process.env.LC_ALL || 'en_US.UTF-8' };

const results = [];
const record = (code, ok, descr, detail = '') => {
  results.push({ code, ok, descr, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${code} ${descr}${detail ? ` — ${detail}` : ''}`);
};

const read = (file) => readFileSync(file, 'utf8');

// 抽出「CREATE OR REPLACE FUNCTION <name>(」到第一個以 $$ 結尾的那一行（含）。
const extractFunction = (file, name) => {
  const lines = read(file).split('\n');
  const starts = lines.flatMap((line, index) => (line.startsWith(`CREATE OR REPLACE FUNCTION ${name}(`) ? [index] : []));
  if (starts.length !== 1) throw new Error(`${path.basename(file)}: expected exactly one definition of ${name}, found ${starts.length}`);
  const start = starts[0];
  const end = lines.findIndex((line, index) => index > start && /^\$\$( LANGUAGE \w+)?;$/.test(line));
  if (end < 0) throw new Error(`${path.basename(file)}: no closing $$ for ${name}`);
  return { lines: lines.slice(start, end + 1), from: start + 1, to: end + 1 };
};

// 逐行 LCS diff：baseline → migrated 被刪掉與新增的行，必須剛好等於預期（以多重集合比對，對齊方式不影響結果）。
const lineDiff = (a, b) => {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed.push(a[i]);
      i += 1;
    } else {
      added.push(b[j]);
      j += 1;
    }
  }
  return { removed: [...removed, ...a.slice(i)], added: [...added, ...b.slice(j)] };
};
const sameMultiset = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const compareDefinition = (code, descr, baseline, migrated, { removed = [], added = [] }) => {
  const diff = lineDiff(baseline.lines, migrated.lines);
  const ok = sameMultiset(diff.removed, removed) && sameMultiset(diff.added, added);
  record(code, ok, descr,
    `baseline L${baseline.from}-${baseline.to} vs migration L${migrated.from}-${migrated.to}; diff -${diff.removed.length}/+${diff.added.length} lines`
    + (ok ? '' : `; removed=${JSON.stringify(diff.removed)} added=${JSON.stringify(diff.added)}`));
};

// ── 1. 靜態比對 ──────────────────────────────────────────────────────
const sources = {
  guard: path.join(migrationsDir, '20260826140000_recover_existing_instructor_identity_claim.sql'),
  complete: path.join(migrationsDir, '2026-08-24_align_instructor_claim_flow.sql'),
  reminder: path.join(migrationsDir, '20260819140407_security_hardening_release.sql'),
};
const functionNames = {
  guard: 'public.guard_instructor_admin_fields',
  complete: 'private.instructor_profile_is_complete',
  reminder: 'public.ensure_my_contract_reminder',
};

const sqlFiles = [path.join(appDir, 'supabase'), migrationsDir].flatMap((dir) => readdirSync(dir)
  .filter((file) => file.endsWith('.sql'))
  .map((file) => path.join(dir, file)));
const otherDefinitions = Object.entries(functionNames).flatMap(([key, name]) => sqlFiles
  .filter((file) => file !== migrationPath && file !== sources[key])
  .filter((file) => read(file).includes(`FUNCTION ${name}(`))
  .map((file) => `${name} also in ${path.basename(file)}`));
const supersededOk = otherDefinitions.every((entry) => entry === 'public.guard_instructor_admin_fields also in 20260819140407_security_hardening_release.sql');
record('S00', supersededOk, 'repo 內三個函式沒有比來源檔更晚的重定義',
  otherDefinitions.length ? otherDefinitions.join('; ') + '（8/19 guard 已被 8/26 取代）' : 'none');

const baseline = Object.fromEntries(Object.entries(functionNames).map(([key, name]) => [key, extractFunction(sources[key], name)]));
const migrated = Object.fromEntries(Object.entries(functionNames).map(([key, name]) => [key, extractFunction(migrationPath, name)]));

compareDefinition('S01', 'guard_instructor_admin_fields 只多 personnel_types 三行', baseline.guard, migrated.guard, {
  added: [
    "       OR NEW.personnel_types IS DISTINCT FROM ARRAY['instructor']::text[]",
    '      NEW.personnel_types,',
    '      OLD.personnel_types,',
  ],
});
compareDefinition('S02', 'instructor_profile_is_complete 只把接課四欄包進「含講師身分才要求」', baseline.complete, migrated.complete, {
  removed: [
    "      AND NULLIF(BTRIM(i.teaching_freq_semester), '') IS NOT NULL",
    "      AND NULLIF(BTRIM(i.teaching_freq_vacation), '') IS NOT NULL",
    '      AND COALESCE(cardinality(i.teaching_regions), 0) > 0',
    "      AND NULLIF(BTRIM(i.bio_notes), '') IS NOT NULL",
  ],
  added: [
    '      AND (',
    "        NOT ('instructor' = ANY (i.personnel_types))",
    '        OR (',
    "          NULLIF(BTRIM(i.teaching_freq_semester), '') IS NOT NULL",
    "          AND NULLIF(BTRIM(i.teaching_freq_vacation), '') IS NOT NULL",
    '          AND COALESCE(cardinality(i.teaching_regions), 0) > 0',
    "          AND NULLIF(BTRIM(i.bio_notes), '') IS NOT NULL",
    '        )',
    '      )',
  ],
});
compareDefinition('S03', 'ensure_my_contract_reminder 只多「有主檔但不含講師身分 → false」一段', baseline.reminder, migrated.reminder, {
  added: [
    '  IF EXISTS (',
    '    SELECT 1 FROM public.instructors i',
    '    WHERE i.user_id = actor_id',
    "      AND NOT ('instructor' = ANY (i.personnel_types))",
    '  ) THEN',
    '    RETURN false;',
    '  END IF;',
  ],
});

const migrationText = read(migrationPath);
const forbidden = ['DROP ', 'TRUNCATE', 'DELETE FROM', 'ALTER TYPE', 'DISABLE TRIGGER'];
const touchedFunctions = [...migrationText.matchAll(/CREATE OR REPLACE FUNCTION ([\w.]+)\(/g)].map((match) => match[1]);
record('S04', /^BEGIN;\n\n.*\nSET LOCAL lock_timeout = '5s';$/m.test(migrationText) && touchedFunctions.length === 3 && touchedFunctions.every((name) => Object.values(functionNames).includes(name))
  && !forbidden.some((word) => migrationText.toUpperCase().includes(word))
  && /^BEGIN;$/m.test(migrationText) && /^COMMIT;$/m.test(migrationText),
'migration 只重定義三個函式、沒有 DROP／DELETE／ALTER TYPE，包在 BEGIN／COMMIT 內，BEGIN 後先設 lock_timeout', touchedFunctions.join(', '));

// ── 2. 暫時 PostgreSQL ───────────────────────────────────────────────
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', env: pgEnv, ...options });
const mustRun = (command, args, options = {}) => {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`);
  return result;
};
const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

// 每個情境一個獨立 cluster（既有腳本會 CREATE ROLE，不能共用）。
const withCluster = async (label, fn) => {
  // socket 路徑有長度上限（macOS 約 104 字元），cluster 放在系統 tmpdir 下的短目錄。
  const dataDir = mkdtempSync(path.join(tmpdir(), `dop-${label}-`));
  let postgres;
  try {
    mustRun('initdb', ['-D', dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8']);
    const port = await reservePort();
    postgres = spawn('postgres', ['-D', dataDir, '-k', dataDir, '-p', String(port)], { stdio: ['ignore', 'pipe', 'pipe'], env: pgEnv });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (run('pg_isready', ['-h', dataDir, '-p', String(port), '-U', 'postgres']).status === 0) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`temporary PostgreSQL (${label}) did not become ready`);
    const connArgs = ['-X', '-h', dataDir, '-p', String(port), '-U', 'postgres', '-d', 'postgres'];
    return await fn((args, options) => run('psql', [...connArgs, '-v', 'ON_ERROR_STOP=1', ...args], options), connArgs);
  } finally {
    if (postgres && postgres.exitCode === null) run('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']);
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const baselineSql = path.join(workDir, 'baseline-functions.sql');
writeFileSync(baselineSql, [
  `-- ${path.basename(sources.reminder)} L${baseline.reminder.from}-${baseline.reminder.to}`,
  ...baseline.reminder.lines,
  '',
  ...['2026-07-09_claim_id_and_role.sql:public.guard_instructor_role', 'instructors_setup.sql:update_instructors_updated_at'].flatMap((entry) => {
    const [file, name] = entry.split(':');
    const block = extractFunction(path.join(appDir, 'supabase', file), name);
    return [`-- ${file} L${block.from}-${block.to}`, ...block.lines, ''];
  }),
].join('\n'));

const parseRun = (stdout) => ({
  checks: stdout.split('\n').filter((line) => line.startsWith('RESULT|')).map((line) => {
    const [, code, tag, status, descr, ...detail] = line.split('|');
    return { code, tag, ok: status === 'PASS', descr, detail: detail.join('|') };
  }),
  md5: Object.fromEntries(stdout.split('\n').filter((line) => line.startsWith('MD5|')).map((line) => {
    const [, phase, fn, value] = line.split('|');
    return [`${phase}|${fn}`, value];
  })),
});

// 8/19 版 is_my_instructor_profile_complete()（接課四欄寫死）：負向對照用，preflight 第 7 段必須判 false。
const legacyWrapper = extractFunction(sources.reminder, 'public.is_my_instructor_profile_complete');
const legacyWrapperSql = path.join(workDir, 'legacy-is-my-instructor-profile-complete.sql');
writeFileSync(legacyWrapperSql, [`-- ${path.basename(sources.reminder)} L${legacyWrapper.from}-${legacyWrapper.to}`, ...legacyWrapper.lines, ''].join('\n'));

// 同一個資料庫跑 preflight：唯讀 session（任何寫入都會報錯），輸出逐列 a|b|c 供判讀。
const runPreflight = (psql) => {
  const result = psql(['-A', '-t', '-F', '|', '-f', path.join(appDir, 'scripts/preflight-personnel-types.sql')],
    { cwd: appDir, env: { ...pgEnv, PGOPTIONS: '-c default_transaction_read_only=on' } });
  return { ok: result.status === 0, stdout: result.stdout, stderr: result.stderr };
};

// 另一個連線先拿著 instructors 的 ACCESS SHARE 鎖（模擬長交易），migration 必須在 lock_timeout 內放棄且資料不變。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checkLockTimeout = async (psql, connArgs) => {
  const blocker = spawn('psql', [...connArgs, '-c',
    "SET application_name = 'pt-blocker'; BEGIN; LOCK TABLE public.instructors IN ACCESS SHARE MODE; SELECT pg_sleep(60);"],
  { env: pgEnv, stdio: 'ignore' });
  try {
    let held = false;
    for (let attempt = 0; attempt < 100 && !held; attempt += 1) {
      const probe = psql(['-At', '-c', "SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.application_name = 'pt-blocker' AND l.relation = 'public.instructors'::regclass AND l.granted"]);
      held = probe.stdout.trim() === '1';
      if (!held) await sleep(100);
    }
    if (!held) return { ok: false, detail: 'blocker did not acquire the table lock' };
    const started = Date.now();
    const attempt = psql(['-v', 'VERBOSITY=verbose', '-f', migrationPath], { cwd: appDir });
    const seconds = (Date.now() - started) / 1000;
    const state = psql(['-At', '-c', "SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'instructors' AND column_name = 'personnel_types') || '|' || (SELECT count(*) FROM public.instructors WHERE employment_status IS NULL) || '|' || (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.instructors'::regclass AND conname IN ('instructors_personnel_types_valid', 'instructors_employment_status_cooperation_only'))"]).stdout.trim();
    const error = `${attempt.stderr}`.split('\n').find((line) => /ERROR/.test(line)) || '';
    return {
      ok: attempt.status !== 0 && /55P03/.test(error) && seconds >= 4 && seconds < 15 && state === '0|3|0',
      detail: `exit ${attempt.status} after ${seconds.toFixed(1)}s; ${error.trim()}; column|NULL rows|new constraints = ${state}`,
    };
  } finally {
    psql(['-c', "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pt-blocker'"]);
    blocker.kill();
  }
};

const runScenario = (label, { applyMigration, priorMigrations }) => withCluster(label, async (psql, connArgs) => {
  const result = psql(['-v', `apply_migration=${applyMigration ? 'on' : 'off'}`, '-v', `prior_migrations=${priorMigrations ? 'on' : 'off'}`,
    '-v', `baseline_sql=${baselineSql}`, '-f', path.join(appDir, 'scripts/verify-personnel-types.sql')], { cwd: appDir });
  if (result.status !== 0) throw new Error(`verify-personnel-types.sql (${label}) aborted\n${result.stdout}${result.stderr}`);
  const scenario = { ...parseRun(result.stdout), preflight: runPreflight(psql) };
  if (!applyMigration) {
    scenario.lockTimeout = await checkLockTimeout(psql, connArgs);
    const swap = psql(['-f', legacyWrapperSql], { cwd: appDir });
    if (swap.status !== 0) throw new Error(`could not install the 8/19 wrapper\n${swap.stderr}`);
    scenario.legacyPreflight = runPreflight(psql);
  }
  return scenario;
});
const preflightRows = (output) => output.stdout.split('\n')
  .filter((line) => /^(public|private)\.[a-z_]+\(/.test(line))
  .map((line) => line.split('|'));
// 第 5 段：fn|current|before|after|verdict
const preflightVerdicts = (output) => preflightRows(output)
  .filter((fields) => fields.length === 5)
  .map(([fn, current, before, after, verdict]) => ({ fn, current, before, after, verdict }));
// 第 7 段：fn|delegates|verdict（兩個函式＋課程 RLS 一列）
const wrapperFns = ['public.approve_new_instructor_account(uuid)', 'public.is_my_instructor_profile_complete()',
  'rls:courses/lessons/contents/course_categories'];
const wrapperRows = (output) => Object.fromEntries(output.stdout.split('\n').map((line) => line.split('|'))
  .filter((fields) => fields.length === 3 && wrapperFns.includes(fields[0]))
  .map(([fn, delegates, verdict]) => [fn, { delegates: delegates === 't', verdict }]));
// 第 8 段：migration|item|in_effect|note（只提示）
const priorRows = (output) => output.stdout.split('\n').map((line) => line.split('|'))
  .filter((fields) => fields.length === 4 && /^20261022(010000|093700)$/.test(fields[0]))
  .map(([migration, item, inEffect]) => ({ migration, item, inEffect: inEffect === 't' }));
const describeWrappers = (rows) => wrapperFns.map((fn) => `${fn}=${rows[fn] ? `${rows[fn].delegates}/${rows[fn].verdict}` : 'missing'}`).join('; ');

// 把既有 SQL 驗證在指定 migration 之後插入新 migration，並把 \ir 改成絕對路徑。
const runStacked = (code, script, anchor) => withCluster(code, (psql) => {
  const source = read(path.join(appDir, 'scripts', script));
  const anchorLine = `\\ir ../supabase/migrations/${anchor}`;
  if (!source.includes(anchorLine)) return { ok: false, detail: `anchor not found: ${anchorLine}` };
  const insertAt = source.lastIndexOf(anchorLine) + anchorLine.length;
  const stacked = `${source.slice(0, insertAt)}\n\\i ${migrationPath}${source.slice(insertAt)}`
    .replaceAll('\\ir ../supabase/', `\\i ${path.join(appDir, 'supabase')}/`);
  const stackedPath = path.join(workDir, `stacked-${script}`);
  writeFileSync(stackedPath, stacked);
  const result = psql(['-f', stackedPath], { cwd: appDir });
  const passLine = `${result.stdout}`.split('\n').map((line) => line.trim()).filter((line) => /PASS/.test(line)).pop();
  return { ok: result.status === 0, detail: result.status === 0 ? (passLine || 'exit 0') : `${result.stderr}`.trim().split('\n').slice(-3).join(' | ') };
});

try {
  console.log('\n── 先套 20261022010000＋20261022093700，再套本 migration（連跑兩次）');
  const applied = await runScenario('applied', { applyMigration: true, priorMigrations: true });
  for (const check of applied.checks) record(check.code, check.ok, `[${check.tag}] ${check.descr}`, check.ok ? '' : check.detail);
  const expectedCount = 76;
  record('X01', applied.checks.length === expectedCount, `SQL 檢查項數＝${expectedCount}（含 I00-I06 課程整合）`, `got ${applied.checks.length}`);

  console.log('\n── 不套那兩支、只套本 migration');
  const standalone = await runScenario('standalone', { applyMigration: true, priorMigrations: false });
  const standaloneFailed = standalone.checks.filter((check) => !check.ok);
  record('X10', standalone.checks.length === expectedCount - 7 && standaloneFailed.length === 0,
    '只套本 migration（沒有 010000／093700）：其餘 69 項全部 PASS',
    `${standalone.checks.length - standaloneFailed.length}/${standalone.checks.length}${standaloneFailed.length ? `; FAIL ${standaloneFailed.map((c) => `${c.code}: ${c.detail}`).join('; ')}` : ''}`);

  console.log('\n── 反向對照（套那兩支、同一組斷言、不套本 migration）');
  const reverse = await runScenario('reverse', { applyMigration: false, priorMigrations: true });
  const reverseNewPassed = reverse.checks.filter((check) => check.tag === 'new' && check.ok);
  const reverseOldFailed = reverse.checks.filter((check) => check.tag === 'old' && !check.ok);
  const reverseFailed = reverse.checks.filter((check) => !check.ok);
  for (const check of reverseFailed) console.log(`  reverse FAIL ${check.code} [${check.tag}] ${check.descr} — ${check.detail}`);
  record('X02', reverse.checks.length === applied.checks.length && reverseFailed.length > 0 && reverseNewPassed.length === 0,
    '反向對照：所有 new 檢查在沒套 migration 時都 FAIL',
    `${reverseFailed.length} FAIL / ${reverse.checks.length}${reverseNewPassed.length ? `; unexpectedly passed: ${reverseNewPassed.map((c) => c.code).join(',')}` : ''}`);
  record('X03', reverseOldFailed.length === 0, '反向對照：所有 old 檢查在沒套 migration 時也 PASS（斷言本身沒寫錯）',
    reverseOldFailed.map((check) => `${check.code}: ${check.detail}`).join('; '));

  const fnKeys = {
    'public.guard_instructor_admin_fields()': 'public.guard_instructor_admin_fields()',
    'private.instructor_profile_is_complete(uuid)': 'private.instructor_profile_is_complete(target_instructor_id uuid)',
    'public.ensure_my_contract_reminder()': 'public.ensure_my_contract_reminder()',
  };
  console.log('\n── 函式 md5(prosrc)（preflight 用）');
  const preflight = read(path.join(appDir, 'scripts/preflight-personnel-types.sql'));
  const mismatches = [];
  for (const [regproc, key] of Object.entries(fnKeys)) {
    const before = applied.md5[`before|${key}`];
    const after = applied.md5[`after|${key}`];
    console.log(`  ${regproc} before=${before} after=${after}`);
    if (!before || before !== reverse.md5[`before|${key}`]) mismatches.push(`${regproc}: before md5 differs between runs`);
    if (!preflight.includes(`('${regproc}', '${before}', '${after}')`)) mismatches.push(`${regproc}: preflight constants out of date`);
  }
  record('X04', mismatches.length === 0, 'preflight 的預期 md5（套用前／後）與本機實算一致', mismatches.join('; '));

  const beforeVerdicts = preflightVerdicts(reverse.preflight);
  const reverseLines = reverse.preflight.stdout.split('\n');
  const reverseWrappers = wrapperRows(reverse.preflight);
  record('X05', reverse.preflight.ok && beforeVerdicts.length === 3 && beforeVerdicts.every((v) => v.verdict.startsWith('OK'))
    && reverseLines.includes('0|3|10') && reverseLines.includes('f|f|f')
    && wrapperFns.every((fn) => reverseWrappers[fn]?.delegates && reverseWrappers[fn].verdict.startsWith('OK')),
  'preflight 在「未套用」庫（唯讀 session）：三個函式判 OK、違反約束 0 筆、NULL 3 筆、新欄位／約束不存在、第 7 段兩列 true',
  reverse.preflight.ok ? `${beforeVerdicts.map((v) => `${v.fn}=${v.verdict}`).join('; ')}; ${describeWrappers(reverseWrappers)}` : reverse.preflight.stderr.trim());
  const afterVerdicts = preflightVerdicts(applied.preflight);
  const appliedWrappers = wrapperRows(applied.preflight);
  record('X06', applied.preflight.ok && afterVerdicts.length === 3 && afterVerdicts.every((v) => v.verdict.startsWith('已套用'))
    && applied.preflight.stdout.split('\n').includes('t|t|t')
    && wrapperFns.every((fn) => appliedWrappers[fn]?.delegates && appliedWrappers[fn].verdict.startsWith('OK')),
  'preflight 在「已套用」庫：三個函式判「已套用」、新欄位與約束都存在、第 7 段兩列 true',
  applied.preflight.ok ? `${afterVerdicts.map((v) => `${v.fn}=${v.verdict}`).join('; ')}; ${describeWrappers(appliedWrappers)}` : applied.preflight.stderr.trim());
  const legacyWrappers = wrapperRows(reverse.legacyPreflight);
  record('X07', reverse.legacyPreflight.ok
    && legacyWrappers['public.is_my_instructor_profile_complete()']?.delegates === false
    && legacyWrappers['public.is_my_instructor_profile_complete()'].verdict.includes('不要套用')
    && legacyWrappers['public.approve_new_instructor_account(uuid)']?.delegates === true
    && legacyWrappers['rls:courses/lessons/contents/course_categories']?.delegates === true,
  `負向對照：換成 8/19 版 is_my_instructor_profile_complete()（${path.basename(sources.reminder)} L${legacyWrapper.from}-${legacyWrapper.to}）後，preflight 第 7 段判 false／不要套用`,
  reverse.legacyPreflight.ok ? describeWrappers(legacyWrappers) : reverse.legacyPreflight.stderr.trim());
  const appliedPrior = priorRows(applied.preflight);
  const standalonePrior = priorRows(standalone.preflight);
  const standaloneWrappers = wrapperRows(standalone.preflight);
  record('X09', appliedPrior.length === 5 && appliedPrior.every((row) => row.inEffect)
    && standalonePrior.length === 5
    && standalonePrior.every((row) => row.inEffect === row.item.includes('Staff can manage instructors'))
    && preflightVerdicts(standalone.preflight).every((v) => v.verdict.startsWith('已套用'))
    && wrapperFns.every((fn) => standaloneWrappers[fn]?.delegates),
  'preflight 第 8 段（只提示）：先套兩支的庫 5 項都已生效；沒套的庫 010000／093700 項目判未生效，且第 5、7 段判定不受影響',
  `applied: ${appliedPrior.map((row) => `${row.migration} ${row.inEffect}`).join(', ')}; standalone: ${standalonePrior.map((row) => `${row.migration} ${row.inEffect}`).join(', ')}`);
  record('X08', reverse.lockTimeout.ok, 'lock_timeout：另一連線拿著表鎖時，migration 約 5 秒後以 55P03 放棄、整批回滾（欄位／約束沒建、NULL 仍 3 筆）',
    reverse.lockTimeout.detail);
  const preflightStatements = read(path.join(appDir, 'scripts/preflight-personnel-types.sql'))
    .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
    .split(';').map((statement) => statement.trim()).filter(Boolean);
  record('S05', preflightStatements.length === 8 && preflightStatements.every((statement) => /^(SELECT|WITH)\b/i.test(statement)),
    'preflight 只含 SELECT（8 段查詢）', `${preflightStatements.length} statements`);

  console.log('\n── 回歸：既有 SQL 驗證疊上新 migration');
  const claimFlow = await runStacked('STACK1', 'verify-instructor-claim-flow.sql', '20260826140000_recover_existing_instructor_identity_claim.sql');
  record('STACK1', claimFlow.ok, 'verify-instructor-claim-flow.sql 疊上新 migration 後全部斷言仍通過', claimFlow.detail);
  const security = await runStacked('STACK2', 'verify-security-hardening.sql', '20260823193000_repair_instructor_guard_dependency.sql');
  record('STACK2', security.ok, 'verify-security-hardening.sql（SQL 部分）疊上新 migration 後全部斷言仍通過', security.detail);
  const audience = await runStacked('STACK3', 'verify-rls-audience-mentor.sql', '20261022010000_tighten_course_audience_and_mentor_access.sql');
  record('STACK3', audience.ok, 'verify-rls-audience-mentor.sql 在 010000 之後疊上新 migration，全部斷言仍通過', audience.detail);
} catch (error) {
  record('X99', false, '執行中斷', error.message);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n${passed}/${results.length} PASS`);
if (passed !== results.length) {
  console.log(`FAIL: ${results.filter((result) => !result.ok).map((result) => result.code).join(', ')}`);
  process.exit(1);
}
console.log('ALL PASS: personnel_types migration verified on isolated PostgreSQL');
