// 一次起整套本機假 Supabase：暫時 PostgreSQL → 套全部 SQL → PostgREST → 閘道 → Vite。
// 只追蹤並收掉自己起的行程（記 PID），不 pkill、不依 port 殺人。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { TempPostgres } from './db.mjs';
import { FakeSupabaseGateway } from './gateway.mjs';
import { projectKey, randomSecret } from './jwt.mjs';
import { reservePort, sleep, waitForHttp } from './util.mjs';

const tail = (text, lines = 30) => String(text || '').split('\n').slice(-lines).join('\n');

function spawnTracked(command, args, options, owned) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.output = '';
  child.stdout?.on('data', (chunk) => { child.output += chunk; });
  child.stderr?.on('data', (chunk) => { child.output += chunk; });
  owned.push(child);
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && !child.signalCode; i += 1) await sleep(100);
  if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
}

export async function startStack({ appDir, viteMode = 'preview', log = console.log } = {}) {
  const owned = [];
  const workDir = mkdtempSync(path.join(tmpdir(), 'dream-one-e2e-stack-'));
  const stack = { owned, workDir };
  const db = new TempPostgres({ label: 'e2e-db' });
  stack.db = db;

  stack.stop = async () => {
    await stack.gateway?.close();
    for (const child of [...owned].reverse()) await stopChild(child);
    await db.stop();
    rmSync(workDir, { recursive: true, force: true });
  };

  try {
    const t0 = Date.now();
    await db.start();
    stack.chainReport = db.applyChain(appDir, { bootstrapFile: path.join(appDir, 'scripts/e2e/bootstrap.sql') });
    log(`[stack] PostgreSQL ${db.port}（PID ${db.pid}）已套 ${stack.chainReport.applied.length} 個 SQL 檔（${Date.now() - t0} ms）`);

    const jwtSecret = randomSecret();
    stack.jwtSecret = jwtSecret;
    stack.anonKey = projectKey('anon', jwtSecret);
    stack.serviceKey = projectKey('service_role', jwtSecret);

    // PostgREST：schema 載完後才啟動
    const pgrstPort = await reservePort();
    const pgrstAdminPort = await reservePort();
    const postgrest = spawnTracked('postgrest', [], {
      env: {
        ...process.env,
        PGRST_DB_URI: db.uri('authenticator'),
        PGRST_DB_SCHEMAS: 'public',
        PGRST_DB_ANON_ROLE: 'anon',
        PGRST_DB_EXTRA_SEARCH_PATH: 'public,extensions',
        PGRST_JWT_SECRET: jwtSecret,
        PGRST_SERVER_HOST: '127.0.0.1',
        PGRST_SERVER_PORT: String(pgrstPort),
        PGRST_ADMIN_SERVER_PORT: String(pgrstAdminPort),
        PGRST_DB_POOL: '20',
        PGRST_DB_MAX_ROWS: '1000',
        PGRST_DB_CHANNEL_ENABLED: 'false',
        PGRST_LOG_LEVEL: 'error',
      },
    }, owned);
    try {
      await waitForHttp(`http://127.0.0.1:${pgrstAdminPort}/ready`, { timeoutMs: 20000, okStatuses: [200] });
    } catch (error) {
      throw new Error(`PostgREST did not start: ${error.message}\n${tail(postgrest.output)}`);
    }
    stack.postgrestPort = pgrstPort;
    stack.postgrest = postgrest;
    log(`[stack] PostgREST ${pgrstPort}（PID ${postgrest.pid}）ready`);

    // 閘道
    const gatewayPort = await reservePort();
    stack.supabaseUrl = `http://127.0.0.1:${gatewayPort}`;
    stack.gateway = new FakeSupabaseGateway({
      db, postgrestPort: pgrstPort, jwtSecret, anonKey: stack.anonKey, serviceKey: stack.serviceKey,
      storageDir: path.join(workDir, 'storage'), publicUrl: stack.supabaseUrl,
    });
    await stack.gateway.listen(gatewayPort);
    log(`[stack] 閘道 ${stack.supabaseUrl}`);

    // Vite：用「行程環境變數」指向閘道（Vite 規定已存在的環境變數優先於 .env；不改 培訓web/.env）
    const viteEnv = {
      ...process.env,
      VITE_SUPABASE_URL: stack.supabaseUrl,
      VITE_SUPABASE_ANON_KEY: stack.anonKey,
      BROWSER: 'none',
    };
    const viteBin = path.join(appDir, 'node_modules/vite/bin/vite.js');
    const vitePort = await reservePort();
    if (viteMode === 'preview') {
      // 正式版建置的快照：跑測試期間別人改 src/ 不會讓頁面中途熱更新
      const outDir = path.join(workDir, 'dist');
      const t1 = Date.now();
      const build = spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
        cwd: appDir, env: viteEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      });
      if (build.status !== 0) throw new Error(`vite build failed\n${tail(build.stdout + build.stderr)}`);
      log(`[stack] vite build 完成（${Date.now() - t1} ms）`);
      stack.vite = spawnTracked(process.execPath, [viteBin, 'preview', '--outDir', outDir, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: appDir, env: viteEnv }, owned);
    } else {
      stack.vite = spawnTracked(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: appDir, env: viteEnv }, owned);
    }
    stack.baseUrl = `http://127.0.0.1:${vitePort}`;
    try {
      await waitForHttp(stack.baseUrl, { timeoutMs: 60000, okStatuses: [200] });
    } catch (error) {
      throw new Error(`Vite did not start: ${error.message}\n${tail(stack.vite.output)}`);
    }
    log(`[stack] Vite（${viteMode}）${stack.baseUrl}（PID ${stack.vite.pid}）`);
    return stack;
  } catch (error) {
    await stack.stop();
    throw error;
  }
}
