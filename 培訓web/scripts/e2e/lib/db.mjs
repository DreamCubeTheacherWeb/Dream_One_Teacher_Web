// 暫時 PostgreSQL 叢集：每次執行全新 initdb，結束時 pg_ctl stop＋刪資料夾。
// 只用 Homebrew 內建的 initdb／postgres／pg_isready／psql，不裝任何套件。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { reservePort, sleep } from './util.mjs';

// ── repo SQL 的實際執行順序 ─────────────────────────────────────────
// STATUS.md 地雷 2：檔名前綴的年份不代表執行順序。真實順序：
//   setup.sql(02-15) → 02-21／02-22 一批 → contracts_setup.sql(03-01) →
//   2024_instructors_extend → 2025_salary_system → 2026_remittance_form_setup →
//   2025_instructor_claim（05 月）→ 之後的 YYYY-MM-DD_*.sql 依日期。
// 同一天的檔案依 git 首次加入時間排序（git log --diff-filter=A），再依檔名。
export const ROOT_SQL_ORDER = [
  'setup.sql',
  // 2026-02-21 17:06
  'instructors_setup.sql',
  'fix_permission_bypass.sql',
  'add_image_text_block.sql',
  // 2026-02-21 23:53
  'add_canvas_editor.sql',
  'comments_setup.sql',
  'comments_likes_setup.sql',
  // 2026-02-22
  'assignment_feedbacks_setup.sql',
  'notifications_and_feedback_setup.sql',
  'training_permissions_setup.sql',
  // 2026-03-01
  'contracts_setup.sql',
  // 2026-05（STATUS.md 記載的順序）
  '2024_instructors_extend.sql',
  '2025_salary_system.sql',
  '2026_remittance_form_setup.sql',
  '2025_instructor_claim.sql',
  // 2026-07-07
  '2026-07-07_esign_verification.sql',
  '2026-07-07_gamification.sql',
  '2026-07-07_security_hardening.sql',
  // 2026-07-08
  '2026-07-08_teaching_leaderboard.sql',
  '2026-07-08_cube_speed.sql',
  // 2026-07-09（git 加入時間順）
  '2026-07-09_mentor_instructor_read.sql',
  '2026-07-09_leaderboard_expansion.sql',
  '2026-07-09_wca_results_import.sql',
  '2026-07-09_salary_reminder_cron.sql',
  '2026-07-09_site_links.sql',
  '2026-07-09_notification_center.sql',
  '2026-07-09_badges_foundation.sql',
  '2026-07-09_badges_levels.sql',
  '2026-07-09_gamify_compute.sql',
  '2026-07-09_leaderboard_hide.sql',
  '2026-07-09_lesson_tags.sql',
  '2026-07-09_cube_public_flag.sql',
  '2026-07-09_badge_images.sql',
  '2026-07-09_wca_admin.sql',
  '2026-07-09_wca_self_report.sql',
  '2026-07-09_claim_auto_approve.sql',
  '2026-07-09_claim_id_and_role.sql',
  '2026-07-09_household_address.sql',
  // 2026-07-10
  '2026-07-10_wca_admin_manage.sql',
  '2026-07-10_sync_instructor_name.sql',
  '2026-07-10_wca_autosync.sql',
  // 2026-08-12
  '2026-08-12_fix_instructor_auto_link.sql',
];

// 套用前的文字修補（只在暫存複本上改，不動 repo 檔）。每條都寫明原因，回報會列出。
export const SQL_PATCHES = [
  {
    files: ['2026-07-09_salary_reminder_cron.sql', '2026-07-09_notification_center.sql'],
    find: /CREATE EXTENSION IF NOT EXISTS pg_cron;/g,
    replace: '-- [e2e] pg_cron 改用 bootstrap.sql 的 cron schema 替身',
    reason: 'Homebrew PostgreSQL 沒有 pg_cron 擴充；排程本身不在測試範圍，改用 bootstrap 的 cron.schedule／unschedule 替身',
  },
  {
    files: ['2025_salary_system.sql'],
    find: "to_char(session_date, 'YYYY/MM')) STORED",
    replace: "public._e2e_month_label(session_date)) STORED",
    prelude: "CREATE OR REPLACE FUNCTION public._e2e_month_label(d date) RETURNS text IMMUTABLE LANGUAGE sql AS $$ SELECT to_char(d, 'YYYY/MM') $$;\n",
    reason: 'PostgreSQL 16 拒絕 to_char() 當 generated column（STATUS.md 已知小事）；改用 IMMUTABLE 包裝，month_label 仍是衍生欄位',
  },
];

// macOS 上 postmaster 需要有效 locale，否則 "postmaster became multithreaded during startup"
const PG_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

const normalizeMigrationKey = (name) => name.replace(/^(\d{4})-(\d{2})-(\d{2})_/, '$1$2$3_');

export function listMigrationFiles(appDir) {
  // 檔名排序；舊式 2026-08-24_ 前綴正規化成 20260824_ 再比，才會排在 20260823… 與 20260825… 之間
  return readdirSync(path.join(appDir, 'supabase/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => normalizeMigrationKey(a).localeCompare(normalizeMigrationKey(b)));
}

export function listRootFiles(appDir) {
  const onDisk = readdirSync(path.join(appDir, 'supabase')).filter((name) => name.endsWith('.sql')).sort();
  const missing = onDisk.filter((name) => !ROOT_SQL_ORDER.includes(name));
  const gone = ROOT_SQL_ORDER.filter((name) => !onDisk.includes(name));
  return { order: ROOT_SQL_ORDER.filter((name) => onDisk.includes(name)), unlisted: missing, gone };
}

export class TempPostgres {
  constructor({ label = 'e2e' } = {}) {
    this.label = label;
    this.dir = mkdtempSync(path.join(tmpdir(), `dream-one-${label}-`));
    this.dataDir = path.join(this.dir, 'data');
    this.port = null;
    this.proc = null;
  }

  async start() {
    const init = spawnSync('initdb', ['-D', this.dataDir, '-A', 'trust', '-U', 'postgres', '--no-locale', '-E', 'UTF8'], { encoding: 'utf8', env: PG_ENV });
    if (init.status !== 0) throw new Error(`initdb failed\n${init.stdout}${init.stderr}`);
    this.port = await reservePort();
    this.proc = spawn('postgres', [
      '-D', this.dataDir, '-k', this.dir, '-p', String(this.port), '-c', 'listen_addresses=',
      '-c', 'max_connections=200', '-c', 'fsync=off', '-c', 'synchronous_commit=off',
      '-c', 'full_page_writes=off', '-c', 'log_min_messages=warning',
    ], { stdio: ['ignore', 'pipe', 'pipe'], env: PG_ENV });
    this.log = '';
    this.proc.stdout.on('data', (chunk) => { this.log += chunk; });
    this.proc.stderr.on('data', (chunk) => { this.log += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const probe = spawnSync('pg_isready', ['-h', this.dir, '-p', String(this.port), '-U', 'postgres'], { encoding: 'utf8' });
      if (probe.status === 0) return this;
      if (this.proc.exitCode !== null) break;
      await sleep(100);
    }
    throw new Error(`temporary PostgreSQL did not become ready\n${this.log}`);
  }

  get pid() { return this.proc?.pid; }

  // PostgREST／psql 用的連線字串（unix socket，trust 驗證）
  uri(user = 'postgres') {
    return `postgresql://${user}@/postgres?host=${encodeURIComponent(this.dir)}&port=${this.port}`;
  }

  psqlArgs({ user = 'postgres', tuplesOnly = false, vars = {} } = {}) {
    const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', this.dir, '-p', String(this.port), '-U', user, '-d', 'postgres'];
    if (tuplesOnly) args.push('-A', '-t');
    for (const [key, value] of Object.entries(vars)) args.push('-v', `${key}=${value}`);
    return args;
  }

  // 同步版：只在建庫、seed 等「沒有別的請求在跑」的時候用
  psqlSync(sql, { file, user, tuplesOnly = true, vars, expectFail = false } = {}) {
    const args = this.psqlArgs({ user, tuplesOnly, vars });
    if (file) args.push('-f', file);
    const result = spawnSync('psql', args, { encoding: 'utf8', input: file ? undefined : sql, env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' } });
    if (!expectFail && result.status !== 0) {
      const err = new Error(`psql failed: ${(result.stderr || '').trim()}`);
      err.stderr = result.stderr;
      throw err;
    }
    return { ok: result.status === 0, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
  }

  // 非同步版：閘道處理請求時用，不擋 event loop。SQL 由 stdin 傳入，變數用 psql -v 安全帶入（:'var'）。
  psql(sql, { user, tuplesOnly = true, vars } = {}) {
    return new Promise((resolve) => {
      const child = spawn('psql', this.psqlArgs({ user, tuplesOnly, vars }), {
        stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGOPTIONS: '--client-min-messages=warning' },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
      child.stdin.end(sql);
    });
  }

  json(sql, opts) {
    const { stdout } = this.psqlSync(sql, { ...opts, tuplesOnly: true });
    return stdout ? JSON.parse(stdout) : null;
  }

  value(sql, opts) {
    return this.psqlSync(sql, { ...opts, tuplesOnly: true }).stdout;
  }

  // 套 bootstrap → supabase/*.sql（實際順序）→ supabase/migrations/*.sql（檔名順序）
  applyChain(appDir, { bootstrapFile, afterChainFile } = {}) {
    const report = { applied: [], patched: [], skipped: [], unlisted: [] };
    this.psqlSync(null, { file: bootstrapFile, tuplesOnly: false });
    report.applied.push('scripts/e2e/bootstrap.sql');

    const root = listRootFiles(appDir);
    report.unlisted = root.unlisted;
    if (root.unlisted.length) {
      throw new Error(`supabase/ 有未登記執行順序的新 SQL：${root.unlisted.join(', ')}（請加進 scripts/e2e/lib/db.mjs 的 ROOT_SQL_ORDER）`);
    }
    const files = [
      ...root.order.map((name) => ({ rel: `supabase/${name}`, name })),
      ...listMigrationFiles(appDir).map((name) => ({ rel: `supabase/migrations/${name}`, name })),
    ];
    for (const { rel, name } of files) {
      const abs = path.join(appDir, rel);
      let text = readFileSync(abs, 'utf8');
      let prelude = '';
      for (const patch of SQL_PATCHES) {
        if (!patch.files.includes(name)) continue;
        const before = text;
        text = text.replace(patch.find, patch.replace);
        if (text === before) throw new Error(`SQL patch for ${name} no longer matches; re-check ${rel}`);
        prelude += patch.prelude || '';
        report.patched.push({ file: rel, reason: patch.reason });
      }
      let target = abs;
      if (prelude || text !== readFileSync(abs, 'utf8')) {
        target = path.join(this.dir, `patched-${name}`);
        writeFileSync(target, `${prelude}${text}`, 'utf8');
      }
      // psql -f 以檔案所在目錄解析 \ir，複本不含 \ir，因此放暫存夾也安全
      const result = this.psqlSync(null, { file: target, tuplesOnly: true, expectFail: true });
      if (!result.ok) {
        const err = new Error(`套用 ${rel} 失敗：\n${result.stderr}`);
        err.file = rel;
        throw err;
      }
      report.applied.push(rel);
    }
    if (afterChainFile) {
      this.psqlSync(null, { file: afterChainFile, tuplesOnly: false });
      report.applied.push(path.relative(appDir, afterChainFile));
    }
    return report;
  }

  async stop() {
    if (this.proc && this.proc.exitCode === null) {
      spawnSync('pg_ctl', ['-D', this.dataDir, '-m', 'fast', '-w', 'stop'], { encoding: 'utf8' });
      for (let i = 0; i < 50 && this.proc.exitCode === null; i += 1) await sleep(100);
      if (this.proc.exitCode === null) this.proc.kill('SIGKILL');
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}
