#!/usr/bin/env node
/**
 * WCA 成績自動同步
 * ────────────────────────────────────────────────────────────────
 * 每兩個月由 GitHub Actions 排程執行（.github/workflows/wca-sync.yml）。
 * 流程：
 *   1) 向 Supabase 取「有填 WCA ID 的講師清單」（RPC get_wca_sync_targets，秘鑰保護）
 *   2) 逐一打 WCA 官方公開 API 抓該選手各項目最佳成績（單次/平均，單位 centiseconds）
 *   3) 把結果整批送回 Supabase（RPC sync_wca_results，秘鑰保護，覆蓋制）
 *
 * 這不是 AI——是把官方數字原封搬回，故正確。只同步 15 個標準時間項目
 * （與站上白名單一致，避開 333fm 步數/333mbf 複合編碼的特殊解碼）。
 *
 * 環境變數：
 *   SUPABASE_URL         例如 https://xxxx.supabase.co（非機密，前端已公開）
 *   SUPABASE_ANON_KEY    anon key（非機密，前端已公開）
 *   WCA_SYNC_SECRET      共用秘鑰（唯一機密；與 DB 端 sync_wca_results 內設定一致）
 *
 * 旗標：
 *   --dry-run            不碰 Supabase：改用 --ids 指定的 ID，抓取+解析後印出，不寫入
 *   --ids=A,B,C          搭配 --dry-run，直接測這幾個 WCA ID
 */

// 只同步這 15 個標準時間項目（值皆為 centiseconds，可直接存）
const ALLOWED_EVENTS = [
  '333', '222', '444', '555', '666', '777',
  '333oh', '333bf', '444bf', '555bf',
  'pyram', 'skewb', 'minx', 'clock', 'sq1',
];

const WCA_API = 'https://www.worldcubeassociation.org/api/v0/persons';
const FETCH_DELAY_MS = 1200;   // 對官方 API 客氣一點（無官方 rate limit 文件）
const MAX_RETRY = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 抓單一 WCA ID 的官方成績，回傳 { wca_id, name, results:[{event_id,best_single,best_average}] } 或 null */
async function fetchPerson(wcaId) {
  const url = `${WCA_API}/${encodeURIComponent(wcaId)}`;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'DreamOne-WCA-Sync/1.0 (training platform)' } });
      if (res.status === 404) return { wca_id: wcaId, name: null, results: [], notFound: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const pr = json?.personal_records || {};
      const results = [];
      for (const ev of ALLOWED_EVENTS) {
        const rec = pr[ev];
        if (!rec) continue;
        const single = Number.isFinite(rec.single?.best) ? rec.single.best : null;
        const average = Number.isFinite(rec.average?.best) ? rec.average.best : null;
        // 只收合理範圍（1..360000 cs，<=1 小時），與 DB 端一致
        const clamp = (v) => (v != null && v >= 1 && v <= 360000 ? v : null);
        const s = clamp(single);
        const a = clamp(average);
        if (s == null && a == null) continue;
        results.push({ event_id: ev, best_single: s, best_average: a });
      }
      return { wca_id: wcaId, name: json?.person?.name ?? null, results };
    } catch (err) {
      if (attempt === MAX_RETRY) {
        console.error(`  ✗ ${wcaId} 抓取失敗（已重試 ${MAX_RETRY} 次）：${err.message}`);
        return null;
      }
      await sleep(FETCH_DELAY_MS * attempt);
    }
  }
  return null;
}

async function rpc(name, body) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`RPC ${name} 失敗 HTTP ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const idsArg = args.find((a) => a.startsWith('--ids='));

  let targets; // [{ instructor_id, wca_id }]
  if (dryRun) {
    const ids = idsArg ? idsArg.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean) : ['2016HOCH02'];
    targets = ids.map((id) => ({ instructor_id: null, wca_id: id }));
    console.log(`[dry-run] 測試 ${targets.length} 個 WCA ID，不寫入資料庫\n`);
  } else {
    const secret = process.env.WCA_SYNC_SECRET;
    if (!secret || !process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      console.error('缺少環境變數：SUPABASE_URL / SUPABASE_ANON_KEY / WCA_SYNC_SECRET');
      process.exit(1);
    }
    targets = await rpc('get_wca_sync_targets', { p_secret: secret });
    targets = (targets || []).filter((t) => t.wca_id && String(t.wca_id).trim());
    console.log(`取得 ${targets.length} 位有 WCA ID 的講師，開始同步…\n`);
  }

  const payload = [];
  let ok = 0, notFound = 0, failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const person = await fetchPerson(String(t.wca_id).trim());
    if (person == null) { failed++; }
    else if (person.notFound) { notFound++; console.log(`  ? ${t.wca_id} — WCA 查無此人（ID 可能填錯）`); }
    else {
      ok++;
      const evStr = person.results.map((r) => r.event_id).join(',') || '（無成績）';
      console.log(`  ✓ ${t.wca_id}${person.name ? ` (${person.name})` : ''} — ${person.results.length} 項：${evStr}`);
      payload.push({ instructor_id: t.instructor_id, wca_id: t.wca_id, name: person.name, results: person.results });
    }
    if (i < targets.length - 1) await sleep(FETCH_DELAY_MS);
  }

  console.log(`\n完成抓取：成功 ${ok}、查無此人 ${notFound}、失敗 ${failed}`);

  if (dryRun) {
    console.log('\n===== 解析結果（dry-run，不寫入）=====');
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (payload.length === 0) { console.log('沒有可寫入的資料，結束。'); return; }
  const res = await rpc('sync_wca_results', { p_secret: process.env.WCA_SYNC_SECRET, p_payload: payload });
  console.log(`寫入完成：${JSON.stringify(res)}`);
}

main().catch((err) => { console.error('同步中止：', err); process.exit(1); });
