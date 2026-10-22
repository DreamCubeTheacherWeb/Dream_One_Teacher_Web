#!/usr/bin/env node
// 月結匯款「下載時存匯出紀錄 → 對某一份匯出標記已付款 → 還原」＋報酬登記中心只剩提示：mock Supabase＋真瀏覽器驗證，
// 斷言寫在程式裡，stdout 就是證據。
// 做法同 verify-payout-bank-export-browser.mjs：本機 vite（dev 或 PREVIEW=1 的建置產物）＋本機 Chrome＋localStorage 塞假 session，
// 所有 Supabase 請求都由 page.route 攔截回假資料；白名單外的請求一律回 404 並讓腳本 FAIL，絕不放行到正式站。
// mock 的 record_salary_payout_export／mark_salary_payout_export_paid／revert_salary_payout_export 照 migration 20261022140000
// 的規則改假資料（逐筆核對狀態、期別、講師、金額；任一不符整份不存／不改；已領不改小；還原只還原沒被改過的列），
// 匯出紀錄存在 mock 裡，重新整理、換分頁都還在（模擬資料庫）。
// 「今天」固定為 2026-10-22（台北）。測試資料全部是假人名、假號碼。
//
// 用法：cd 培訓web && node scripts/verify-salary-sessions-paid-browser.mjs
//       PREVIEW=1：改跑建置產物（先 npm run build，再用 vite preview 開 dist/）
// 需要在沙盒外跑（綁本機 port、開 Chrome）。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, '..');
const { chromium } = require(path.join(appDir, 'node_modules/playwright-core'));
const chromeExecutable = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PREVIEW = process.env.PREVIEW === '1';
const shotDir = path.join(appDir, 'docs/verification/2026-10-22-salary-sessions-paid');
mkdirSync(shotDir, { recursive: true });
const shot = (name) => path.join(shotDir, PREVIEW ? `build-${name}` : name);
const workDir = mkdtempSync(path.join(tmpdir(), 'd1-sessions-paid-browser-'));

const env = Object.fromEntries(readFileSync(path.join(appDir, '.env'), 'utf8')
    .split('\n').map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]));
const projectRef = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;
const now = '2026-10-22T04:00:00.000Z';
const TODAY = '2026-10-22';
const MIGRATION_TEXT = '需先套用資料庫更新（20261022140000_mark_salary_sessions_paid.sql）才能建立匯出紀錄與標記已付款。';
const UNCERTAIN_PREFIX = '結果不確定（網路或伺服器沒有正常回應）';

// ───────────────────────── 假資料 ─────────────────────────
const ADMIN_UID = '00000000-0000-4000-8000-0000000000e1';
const I = {
    ding: '10000000-0000-4000-8000-0000000000e1',
    wang: '10000000-0000-4000-8000-0000000000e2',
    lin: '10000000-0000-4000-8000-0000000000e3',   // 解款行 6 碼 → 轉帳檔擋下
    chen: '10000000-0000-4000-8000-0000000000e4',  // 管理員取消勾選
};
const inst = (id, overrides) => ({
    id, user_id: null, instructor_role: 'A', household_address: '測試戶籍地址', address: '測試通訊地址', phone_mobile: '0900000000', ...overrides,
});
const INSTRUCTORS = [
    inst(I.ding, { full_name: '丁測一', bank_code: '0081832', bank_account_number: '00291234567890', bank_account_name: '丁測一', id_number: 'Z100000001', email_primary: 'ding@example.test', partner_no: 'A000001' }),
    inst(I.wang, { full_name: '王測二', bank_code: '0130017', bank_account_number: '01234567890123', bank_account_name: '王測二', id_number: 'Z200000002', email_primary: 'wang@example.test', partner_no: 'A036872' }),
    inst(I.lin, { full_name: '林測三', bank_code: '008183', bank_account_number: '00098765432100', bank_account_name: '林測三', id_number: 'Z100000003', email_primary: 'lin@example.test', partner_no: 'A000003' }),
    inst(I.chen, { full_name: '陳測四', bank_code: '0070937', bank_account_number: '98765432101', bank_account_name: '陳測四', id_number: 'Z200000004', email_primary: 'chen@example.test', partner_no: 'A000004' }),
];
const NAME = Object.fromEntries(INSTRUCTORS.map((row) => [row.id, row.full_name]));
let seq = 0;
const s = (courseName, instructorId, date, status, { base = 0, paid = 0, anomaly = null } = {}) => {
    seq += 1;
    return {
        id: `20000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
        instructor_id: instructorId, instructor_name: instructorId ? NAME[instructorId] : '對不到測試',
        session_date: date, course_type: 'regular_basic', course_name: courseName,
        base_salary: base, bonus: 0, total_salary: base, paid_amount: paid, status, pricing_status: 'quoted',
        is_anomaly: Boolean(anomaly), anomaly_reasons: anomaly || [], updated_at: '2026-10-01T00:00:00.000000+00:00', tick: 0,
    };
};
// 9 月期（8/26～9/25）
const SEED = [
    s('丁-常態課', I.ding, '2026-08-26', 'approved', { base: 1000 }),             // 納入 1000
    s('丁-部分已付', I.ding, '2026-09-10', 'approved', { base: 600, paid: 100 }),  // 納入 500
    s('丁-溢付', I.ding, '2026-09-12', 'approved', { base: 300, paid: 500 }),      // 納入 0（已領超過總額）
    s('丁-重複', I.ding, '2026-09-13', 'approved', { base: 1000, anomaly: ['同講師同日有內容完全相同的紀錄，可能重複登記'] }), // 異常 → 預設排除
    s('王-線上課', I.wang, '2026-09-01', 'approved', { base: 1200 }),             // 納入 1200
    s('王-手動排除', I.wang, '2026-09-05', 'approved', { base: 650 }),            // 管理員手動排除
    s('林-體驗課', I.lin, '2026-09-03', 'approved', { base: 900 }),               // 講師被擋
    s('陳-常態課', I.chen, '2026-09-04', 'approved', { base: 700 }),              // 講師取消勾選
    s('對不到的課', null, '2026-09-06', 'approved', { base: 350 }),               // 對不到講師
    s('丁-待核准', I.ding, '2026-09-15', 'pending', { base: 700 }),
    s('王-已付', I.wang, '2026-09-07', 'paid', { base: 900, paid: 900 }),
    s('丁-十月課', I.ding, '2026-10-05', 'approved', { base: 800 }),              // 10 月期（還沒結束）
];
const LATE = () => ({ ...s('丁-晚到課', I.ding, '2026-09-22', 'approved', { base: 450 }), updated_at: new Date().toISOString() });
const byName = (name) => world.sessions.find((row) => row.course_name === name);
const INCLUDED_NAMES = ['丁-常態課', '丁-部分已付', '丁-溢付', '王-線上課'];
const EXPECTED_EXCLUSIONS = ['異常標記預設排除 1 筆（$1,000）', '手動排除的課 1 筆（$650）', '對不到講師 1 筆（$350）',
    '資料不全被擋下的講師 1 位、1 筆（$900）：解款行有誤 1 位', '取消勾選的講師 1 位、1 筆（$700）'];

// mode：ok｜missing（表與函式都還沒套）｜record-5xx（存了但回 503 看不懂的頁面）｜mark-abort（標了但連線中斷）
const world = { sessions: [], exports: [], items: [], exportSeq: 0, mode: 'ok', rpcDelayMs: 500, register: false };
const resetWorld = ({ mode = 'ok' } = {}) => {
    seq = SEED.length;
    world.sessions = SEED.map((row) => ({ ...row }));
    world.exports = [];
    world.items = [];
    world.exportSeq = 0;
    world.mode = mode;
};
const reqLog = [];
const rpcCalls = [];
const unexpected = [];
const externalBlocked = new Set();

const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' };
const json = (route, data, status = 200, headers = {}) => route.fulfill({
    status, headers: { 'content-type': 'application/json', ...CORS, ...headers }, body: JSON.stringify(data),
});
const project = (row, select) => {
    if (!select || select === '*') return row;
    return Object.fromEntries(select.split(',').map((c) => c.trim()).map((column) => [column, row[column]]));
};
function compileFilters(params, allowed) {
    const tests = [];
    for (const [key, raw] of params.entries()) {
        if (['select', 'order', 'offset', 'limit'].includes(key)) continue;
        if (!allowed.has(key)) throw new Error(`unexpected param ${key}`);
        const dot = raw.indexOf('.');
        const op = raw.slice(0, dot);
        const value = raw.slice(dot + 1);
        if (op === 'eq') tests.push((row) => String(row[key]) === value);
        else if (op === 'gte') tests.push((row) => String(row[key]) >= value);
        else if (op === 'lte') tests.push((row) => String(row[key]) <= value);
        else if (op === 'lt') tests.push((row) => String(row[key]) < value);
        else throw new Error(`unexpected op ${key}=${raw}`);
    }
    return (row) => tests.every((t) => t(row));
}
const sortById = (rows) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const cents = (v) => Math.round(Number(v || 0) * 100);
const payable = (row) => Math.max(cents(row.total_salary) - cents(row.paid_amount), 0) / 100;
const fmt = (n) => `$${Number(n).toLocaleString('en-US')}`;
const touch = (row) => { row.tick += 1; row.updated_at = new Date().toISOString(); };

// ── mock 版資料庫函式（規則同 migration 20261022140000；逐筆核對共用 mismatchesOf）
function mismatchesOf(items, start, end) {
    const list = [];
    for (const item of items) {
        const row = world.sessions.find((r) => r.id === item.id);
        const base = { id: item.id, instructor_name: row?.instructor_name ?? null, session_date: row?.session_date ?? null };
        if (!row) list.push({ ...base, reason: 'not_found', message: '找不到這筆紀錄（可能已刪除）' });
        else if (row.status !== 'approved') list.push({ ...base, reason: 'status', message: `狀態已不是「已核准」（現在：${row.status === 'paid' ? '已付款' : '待核准'}）` });
        else if (row.session_date < start || row.session_date > end) list.push({ ...base, reason: 'period', message: `日期 ${row.session_date} 不在這一期` });
        else if (row.instructor_id !== item.instructor_id) list.push({ ...base, reason: 'instructor', message: row.instructor_id ? `講師和下載時不同（現在：${row.instructor_name}）` : '已沒有連到講師主檔' });
        else if (cents(payable(row)) !== cents(item.amount)) list.push({ ...base, reason: 'amount', message: `應付金額已變動（下載時 ${fmt(item.amount)}，現在 ${fmt(payable(row))}）` });
    }
    return list;
}
const err22023 = (message) => ({ status: 400, data: { code: '22023', message, details: null, hint: null } });
function mockRecord(body) {
    const keys = Object.keys(body).sort().join(',');
    if (keys !== 'p_exclusions,p_expected_total,p_file_kind,p_items,p_pay_date,p_people,p_period_end,p_period_start') return err22023(`unexpected keys ${keys}`);
    if (!body.p_items.every((item) => item.id && item.instructor_id && typeof item.amount === 'number')) return err22023('課的清單格式不正確。');
    for (const person of body.p_people) {
        const sum = body.p_items.filter((item) => item.instructor_id === person.instructor_id).reduce((acc, item) => acc + cents(item.amount), 0);
        if (sum + cents(person.adjustment) !== cents(person.amount)) return err22023('講師實付和他的課加總＋人工調整不一致。');
    }
    const total = body.p_people.reduce((acc, p) => acc + cents(p.amount), 0);
    if (total !== cents(body.p_expected_total)) return err22023('講師實付合計與轉帳檔總額不同。');
    const mismatches = mismatchesOf(body.p_items, body.p_period_start, body.p_period_end);
    if (mismatches.length) return { status: 200, data: { ok: false, mismatch_count: mismatches.length, mismatches } };
    world.exportSeq += 1;
    const id = world.exportSeq;
    const itemsTotal = body.p_items.reduce((acc, item) => acc + cents(item.amount), 0) / 100;
    world.exports.push({
        id, period_start: body.p_period_start, period_end: body.p_period_end, item_count: body.p_items.length, people_count: body.p_people.length,
        total_amount: itemsTotal, transfer_total: total / 100, people: body.p_people, exclusions: body.p_exclusions, pay_date: body.p_pay_date,
        file_kind: body.p_file_kind, exported_at: new Date().toISOString(), exported_by_name: '測試管理員',
        marked_at: null, marked_by_name: null, marked_count: null, marked_amount: null, reverted_count: 0, reverted_amount: 0, reverted_at: null,
    });
    for (const item of body.p_items) world.items.push({ export_id: id, session_id: item.id, instructor_id: item.instructor_id, amount: item.amount, old: null, tick: null, reverted: false });
    return { status: 200, data: { ok: true, export_id: id, item_count: body.p_items.length, people_count: body.p_people.length, total_amount: itemsTotal, transfer_total: total / 100 } };
}
function mockMark(body) {
    if (Object.keys(body).sort().join(',') !== 'p_expected_amount,p_expected_count,p_export_id') return err22023(`unexpected keys ${Object.keys(body)}`);
    const exp = world.exports.find((e) => e.id === body.p_export_id);
    if (!exp) return err22023(`找不到匯出 #${body.p_export_id}。`);
    if (exp.marked_at) return err22023(`匯出 #${exp.id} 已經標記過已付款，不能再標一次。`);
    if (body.p_expected_count !== exp.item_count || cents(body.p_expected_amount) !== cents(exp.total_amount)) return err22023('確認的筆數／金額和匯出不同，這次沒有標記任何紀錄，請重新讀取。');
    if (exp.period_end >= TODAY) return err22023('這一期還沒結束');
    const items = world.items.filter((i) => i.export_id === exp.id);
    const mismatches = mismatchesOf(items.map((i) => ({ id: i.session_id, instructor_id: i.instructor_id, amount: i.amount })), exp.period_start, exp.period_end);
    if (mismatches.length) return { status: 200, data: { ok: false, export_id: exp.id, marked_count: 0, mismatch_count: mismatches.length, mismatches } };
    const paidAt = new Date().toISOString();
    for (const item of items) {
        const row = world.sessions.find((r) => r.id === item.session_id);
        item.old = { status: row.status, paid_amount: row.paid_amount, paid_at: row.paid_at ?? null };
        row.status = 'paid';
        row.paid_amount = Math.max(Number(row.paid_amount || 0), Number(row.total_salary));
        row.paid_at = paidAt;
        touch(row);
        item.tick = row.tick;
    }
    Object.assign(exp, { marked_at: paidAt, marked_by_name: '測試管理員', marked_count: items.length, marked_amount: exp.total_amount });
    return { status: 200, data: { ok: true, export_id: exp.id, marked_count: items.length, marked_amount: exp.total_amount, paid_at: paidAt } };
}
function mockRevert({ p_export_id: exportId }) {
    const exp = world.exports.find((e) => e.id === exportId);
    if (!exp) return err22023(`找不到匯出 #${exportId}。`);
    if (!exp.marked_at) return err22023(`匯出 #${exportId} 還沒標記已付款，不需要還原。`);
    const skipped = [];
    let reverted = 0;
    let amount = 0;
    for (const item of world.items.filter((i) => i.export_id === exportId && i.tick !== null && !i.reverted)) {
        const row = world.sessions.find((r) => r.id === item.session_id);
        if (!row || row.status !== 'paid' || row.tick !== item.tick) {
            skipped.push({ id: item.session_id, instructor_name: row?.instructor_name ?? null, session_date: row?.session_date ?? null,
                reason: !row ? 'not_found' : row.status !== 'paid' ? 'status' : 'changed',
                message: !row ? '這筆紀錄已不存在' : row.status !== 'paid' ? '已不是已付款' : '標記後被改過（已領金額、付款時間或其他欄位）' });
            continue;
        }
        Object.assign(row, item.old);
        touch(row);
        item.reverted = true;
        reverted += 1;
        amount += cents(item.amount);
    }
    exp.reverted_count += reverted;
    exp.reverted_amount += amount / 100;
    if (reverted) exp.reverted_at = new Date().toISOString();
    return { status: 200, data: { export_id: exportId, reverted_count: reverted, reverted_amount: amount / 100, skipped_count: skipped.length, skipped,
        remaining_count: world.items.filter((i) => i.export_id === exportId && i.tick !== null && !i.reverted).length } };
}

const authUser = () => ({
    id: ADMIN_UID, aud: 'authenticated', role: 'authenticated', email: 'admin@example.test',
    user_metadata: { full_name: '測試管理員' }, app_metadata: { provider: 'google', providers: ['google'] },
    identities: [], created_at: now, updated_at: now,
});
const sessionFor = () => ({
    access_token: `mock.${ADMIN_UID}`, refresh_token: 'mock.refresh', token_type: 'bearer',
    expires_in: 31536000, expires_at: Math.floor(new Date('2030-01-01T00:00:00Z').getTime() / 1000), user: authUser(),
});
const MISSING_RPC = (name) => ({ code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null });
const MISSING_TABLE = (name) => ({ code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache`, details: null, hint: null });

async function handleSupabase(route, request, url) {
    const method = request.method();
    const params = new URLSearchParams(url.search);
    reqLog.push({ method, path: url.pathname, search: url.search, at: Date.now() });
    const headers = await request.allHeaders();
    const acceptsObject = (headers.accept || '').includes('vnd.pgrst.object+json');
    const wantsCount = (headers.prefer || '').includes('count=exact');
    const reject = (why) => {
        unexpected.push(`${method} ${url.pathname}${url.search}  (${why})`);
        return json(route, { code: 'MOCK_UNEXPECTED', message: `verify script did not expect: ${why}` }, 404);
    };

    if (url.pathname.startsWith('/auth/v1/')) {
        if (url.pathname === '/auth/v1/user') return json(route, authUser());
        if (url.pathname.startsWith('/auth/v1/token')) return json(route, sessionFor());
        return json(route, {});
    }
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.replace('/rest/v1/rpc/', '');
        if (['claim_my_precreated_instructor', 'ensure_my_contract_reminder'].includes(name) && method === 'POST') return json(route, null);
        const handlers = { record_salary_payout_export: mockRecord, mark_salary_payout_export_paid: mockMark, revert_salary_payout_export: mockRevert };
        if (handlers[name] && method === 'POST') {
            const body = request.postDataJSON();
            rpcCalls.push({ name, body, at: Date.now() });
            await new Promise((r) => setTimeout(r, world.rpcDelayMs));
            if (world.mode === 'missing') return json(route, MISSING_RPC(name), 404);
            const result = handlers[name](body);
            // 不確定的失敗：資料庫其實做了，但回應壞掉（503 看不懂的頁面／連線中斷）
            if (world.mode === 'record-5xx' && name === 'record_salary_payout_export') {
                return route.fulfill({ status: 503, headers: { ...CORS, 'content-type': 'text/html' }, body: '<html><body>503 Service Unavailable</body></html>' });
            }
            if (world.mode === 'mark-abort' && name === 'mark_salary_payout_export_paid') return route.abort('connectionreset');
            return json(route, result.data, result.status);
        }
        return reject(`rpc ${name}`);
    }
    if (!url.pathname.startsWith('/rest/v1/')) return reject('not a rest/auth path');
    const table = url.pathname.replace('/rest/v1/', '').split('/')[0];

    if (table === 'users' && method === 'GET') {
        const row = { id: ADMIN_UID, name: '測試管理員', email: 'admin@example.test', role: 'admin', created_at: now };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'salary_payout_schedule' && method === 'GET') {
        const row = { next_payday: '2026-11-10', regular_day: 10 };
        return json(route, acceptsObject ? row : [row]);
    }
    if (table === 'salary_payout_exports' && method === 'GET') {
        if (world.mode === 'missing') return json(route, MISSING_TABLE(table), 404);
        let rows;
        try { rows = world.exports.filter(compileFilters(params, new Set(['period_start', 'period_end']))); } catch (error) { return reject(error.message); }
        if (params.get('order') !== 'id.desc') return reject(`exports order ${params.get('order')}`);
        rows = [...rows].sort((a, b) => b.id - a.id).slice(0, Number(params.get('limit') || 1000)).map((row) => project(row, params.get('select')));
        return json(route, rows);
    }
    if (table === 'salary_payout_export_items' && method === 'GET') {
        let rows;
        try { rows = world.items.filter(compileFilters(params, new Set(['export_id']))); } catch (error) { return reject(error.message); }
        const offset = Number(params.get('offset') || 0);
        const limit = Math.min(params.has('limit') ? Number(params.get('limit')) : Infinity, 1000);
        rows = [...rows].sort((a, b) => a.session_id.localeCompare(b.session_id)).slice(offset, offset + limit).map((row) => project(row, params.get('select')));
        return json(route, rows);
    }
    if (table === 'instructors' && method === 'GET') {
        if (params.get('user_id')) return json(route, acceptsObject ? null : []);
        if (world.register) return json(route, INSTRUCTORS.map((row) => ({ id: row.id, full_name: row.full_name, instructor_role: 'A', speed_qualification: null, personnel_types: ['instructor'] })));
        const select = params.get('select') || '';
        const offset = Number(params.get('offset') || 0);
        const page = sortById(INSTRUCTORS).slice(offset, offset + 1000).map((row) => project(row, select));
        return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/*` });
    }
    if (table === 'class_sessions') {
        if (!['GET', 'HEAD'].includes(method)) return reject(`class_sessions ${method}`);
        if (world.register) {  // 報酬登記中心：只驗提示，不驗清單 → 一律回空
            if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '*/0' }, body: '' });
            return json(route, [], 200, { 'content-range': '*/0' });
        }
        let rows;
        try { rows = sortById(world.sessions.filter(compileFilters(params, new Set(['status', 'session_date'])))); } catch (error) { return reject(error.message); }
        if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': `*/${wantsCount ? rows.length : '*'}` }, body: '' });
        const offset = Number(params.get('offset') || 0);
        const limit = Math.min(params.has('limit') ? Number(params.get('limit')) : Infinity, 1000);
        const page = rows.slice(offset, offset + limit).map((row) => project(row, params.get('select')));
        return json(route, page, 200, { 'content-range': `${page.length ? `${offset}-${offset + page.length - 1}` : '*'}/${wantsCount ? rows.length : '*'}` });
    }
    if (['site_links', 'notifications', 'salary_report_options', 'announcements', 'instructor_uploads'].includes(table) && ['GET', 'HEAD'].includes(method)) {
        if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS, 'content-range': '*/0' }, body: '' });
        return json(route, acceptsObject ? null : []);
    }
    return reject(`table ${table} ${method}`);
}
async function handleRoute(route) {
    const request = route.request();
    const url = new URL(request.url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
    if (url.hostname.includes('supabase')) return handleSupabase(route, request, url);
    externalBlocked.add(url.hostname);
    return route.abort();
}

// ───────────────────────── 工具 ─────────────────────────
const results = [];
const check = (name, condition, detail = '') => {
    results.push(Boolean(condition));
    console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? `  ← ${detail}` : ''}`);
};
const section = (title) => console.log(`\n── ${title}`);
const reservePort = () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close(() => resolve(port));
    });
});
const pageErrors = [];
async function newContext(browser, viewport = { width: 1280, height: 900 }) {
    const context = await browser.newContext({ viewport, locale: 'zh-TW', timezoneId: 'Asia/Taipei', acceptDownloads: true });
    await context.addInitScript(({ key, value }) => {
        if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
    }, { key: storageKey, value: sessionFor() });
    await context.clock.setFixedTime(new Date(`${TODAY}T12:00:00+08:00`));
    await context.route('**/*', handleRoute);
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    return { context, page };
}
const testId = (page, id) => page.getByTestId(id);
const lbl = (page, name) => page.getByLabel(name, { exact: true });
const text = async (locator) => ((await locator.textContent()) || '').trim();
const flat = (value) => String(value || '').replace(/\s+/g, '');
async function waitText(locator, expected, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let last = '';
    while (Date.now() < deadline) {
        last = await text(locator).catch(() => '');
        if (expected instanceof RegExp ? expected.test(last) : last === expected) return last;
        await new Promise((r) => setTimeout(r, 100));
    }
    return last;
}
const markExportButton = (page, id) => page.getByRole('button', { name: `標記匯出 #${id} 已付款`, exact: true });
const revertExportButton = (page, id) => page.getByRole('button', { name: `還原匯出 #${id}`, exact: true });
const confirmMarkButton = (page) => testId(page, 'payout-mark-paid-confirm').getByRole('button', { name: /^確認標記匯出 #\d+/ });
async function openPayout(page, base, { period = '2026/09' } = {}) {
    await page.goto(`${base}/admin/salary/payout`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '月結匯款', exact: true }).waitFor({ timeout: 15000 });
    await lbl(page, '丁測一 納入匯款').waitFor({ timeout: 15000 }).catch(() => {});
    if (period && (await lbl(page, '期別').inputValue()) !== period) {
        await lbl(page, '期別').selectOption(period);
        await lbl(page, '丁測一 納入匯款').waitFor({ timeout: 15000 });
        await page.waitForLoadState('networkidle');
    }
}
async function prepareEdits(page) {
    await lbl(page, '付款帳號').fill('123456789012');
    await lbl(page, '付款分行').fill('0456');
    await page.getByRole('button', { name: '王測二 展開明細' }).click();
    await lbl(page, '2026-09-05 王-手動排除 排除').check();
    await lbl(page, '陳測四 納入匯款').uncheck();
    await lbl(page, '王測二 調整金額').fill('-200');
    await lbl(page, '王測二 調整原因').fill('扣回溢付');
}
async function downloadVia(page, buttonName) {
    const promise = page.waitForEvent('download', { timeout: 10000 });
    await page.getByRole('button', { name: buttonName }).click();
    const download = await promise;
    const at = Date.now();
    const target = path.join(workDir, `${at}-${download.suggestedFilename()}`);
    await download.saveAs(target);
    return { name: download.suggestedFilename(), bytes: readFileSync(target), at };
}
async function clickExpectingNoDownload(page, buttonName, waitMs = 2500) {
    let downloaded = false;
    const onDownload = () => { downloaded = true; };
    page.on('download', onDownload);
    await page.getByRole('button', { name: buttonName }).click();
    await page.waitForTimeout(waitMs);
    page.off('download', onDownload);
    return downloaded;
}
const csvRows = (bytes) => bytes.toString('utf8').slice(1).split('\r\n').slice(1, -1).map((line) => line.split(','));
async function openConfirm(page, id) {
    await markExportButton(page, id).click();
    const confirm = testId(page, 'payout-mark-paid-confirm');
    await confirm.waitFor({ timeout: 5000 });
    await testId(page, 'payout-mark-paid-confirm-later').waitFor({ timeout: 10000 }).catch(() => {});
    return confirm;
}

// ───────────────────────── 主流程 ─────────────────────────
async function run() {
    const port = await reservePort();
    const base = `http://127.0.0.1:${port}`;
    const viteArgs = [...(PREVIEW ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
    const vite = spawn(path.join(appDir, 'node_modules', '.bin', 'vite'), viteArgs, { cwd: appDir, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`vite ${PREVIEW ? 'preview（建置產物 dist/）' : 'dev'} pid=${vite.pid} port=${port}`);
    let viteLog = '';
    vite.stdout.on('data', (chunk) => { viteLog += chunk; });
    vite.stderr.on('data', (chunk) => { viteLog += chunk; });
    let browser;
    try {
        const deadline = Date.now() + 30000;
        for (;;) {
            try { if ((await fetch(base)).ok) break; } catch { /* starting */ }
            if (Date.now() > deadline) throw new Error(`vite did not start\n${viteLog}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
        // 伺服器身分：這個 port 上只有本腳本剛起的 vite，cwd＝本 worktree
        const listeners = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1)));
        const unescapeLsof = (value) => {
            const bytes = [];
            for (let i = 0; i < value.length; i += 1) {
                if (value[i] === '\\' && value[i + 1] === 'x' && /^[0-9a-f]{2}$/i.test(value.slice(i + 2, i + 4))) {
                    bytes.push(parseInt(value.slice(i + 2, i + 4), 16));
                    i += 3;
                } else bytes.push(...Buffer.from(value[i], 'utf8'));
            }
            return Buffer.from(bytes).toString('utf8');
        };
        const cwdOf = (pid) => unescapeLsof((spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout.split('\n').find((l) => l.startsWith('n')) || '').slice(1));
        const sameDir = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return false; } };
        const owned = listeners.length > 0 && listeners.every((pid) => pid === vite.pid && sameDir(cwdOf(pid), appDir));
        check(`伺服器身分：port ${port} 只有本腳本起的 vite（pid ${vite.pid}），cwd＝本 worktree`, owned, `listeners=${listeners} cwd=${listeners.map(cwdOf)}`);
        if (!owned) throw new Error('port 上的伺服器不是本 worktree 的，停止驗證');
        browser = await chromium.launch(existsSync(chromeExecutable) ? { executablePath: chromeExecutable } : {});

        // ════════ 1. 主流程：下載建立匯出紀錄 → 重新整理 → 直接標記 → 還原 ════════
        section('1. 桌機 1280：下載建立匯出 #1 → 重新整理後紀錄還在 → 直接標記（負數調整要勾選）→ 還原');
        resetWorld();
        let { context, page } = await newContext(browser);
        await openPayout(page, base);
        check('橫幅說明：每次下載都存匯出紀錄，匯款完成後對交給銀行的那一份標記',
            (await text(testId(page, 'payout-first-version-warning'))).includes('每次下載都會存一份匯出紀錄（檔名的「匯出N」）'));
        check('9 月期還沒有匯出紀錄', (await waitText(testId(page, 'payout-exports-empty'), /^這一期還沒有匯出紀錄/)).startsWith('這一期還沒有匯出紀錄'));
        await prepareEdits(page);
        rpcCalls.length = 0;
        const csv = await downloadVia(page, '轉帳檔 CSV');
        const recordCall = rpcCalls.find((c) => c.name === 'record_salary_payout_export');
        const rec = recordCall?.body || {};
        check('按下載先呼叫 record_salary_payout_export，資料庫回編號後才下載（呼叫＋500ms 回應延遲都早於下載）',
            Boolean(recordCall) && recordCall.at + world.rpcDelayMs <= csv.at, `record=${recordCall?.at} download=${csv.at}`);
        check('存進資料庫的清單＝轉帳檔納入的 4 堂課，每堂帶講師與本次應付（1000／500／0／1200）',
            JSON.stringify((rec.p_items || []).map((item) => `${world.sessions.find((r) => r.id === item.id)?.course_name}:${NAME[item.instructor_id]}:${item.amount}`).sort())
                === JSON.stringify(['丁-常態課:丁測一:1000', '丁-溢付:丁測一:0', '丁-部分已付:丁測一:500', '王-線上課:王測二:1200']), JSON.stringify(rec.p_items));
        check('每位講師的實付與人工調整一起存（丁 1500、王 1000＝1200−200「扣回溢付」），轉帳檔總額 2500、付款日 2026-10-10、CSV、5 行排除摘要',
            JSON.stringify(rec.p_people) === JSON.stringify([
                { instructor_id: I.ding, name: '丁測一', amount: 1500, adjustment: 0, adjustment_reason: null },
                { instructor_id: I.wang, name: '王測二', amount: 1000, adjustment: -200, adjustment_reason: '扣回溢付' },
            ]) && rec.p_expected_total === 2500 && rec.p_pay_date === '2026-10-10' && rec.p_file_kind === 'csv'
                && JSON.stringify(rec.p_exclusions) === JSON.stringify(EXPECTED_EXCLUSIONS), JSON.stringify(rec));
        const rows = csvRows(csv.bytes);
        check('檔名帶匯出編號：202609夢想講師轉帳檔_20261010_匯出1.csv；檔案內容不變（2 人：丁 1500、王 1000，內容沒有「匯出」字樣）',
            csv.name === '202609夢想講師轉帳檔_20261010_匯出1.csv' && rows.map((row) => `${row[6]}:${row[7]}`).join() === '丁測一:1500,王測二:1000'
                && !csv.bytes.toString('utf8').includes('匯出'), `${csv.name} ${rows.map((row) => `${row[6]}:${row[7]}`)}`);
        check('下載訊息寫匯出編號：「已下載轉帳檔 CSV（匯出 #1）：2 人，共 $2,500」', (await text(testId(page, 'payout-download-message'))) === '已下載轉帳檔 CSV（匯出 #1）：2 人，共 $2,500');
        const exportRow = testId(page, 'payout-export-1');
        await exportRow.waitFor({ timeout: 5000 });
        check('匯出紀錄列出 #1：測試管理員、CSV、2 人、4 筆、$2,500、未標記、有「標記這份已付款」',
            /^#1.*測試管理員CSV24\$2,500未標記標記這份已付款$/.test(flat(await text(exportRow))), await text(exportRow));
        await page.screenshot({ path: shot('desktop-1280-after-download.png'), fullPage: false });

        // 匯出之後又核准了一筆晚到的課；接著重新整理（網頁記憶體全清空）
        world.sessions.push(LATE());
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '月結匯款', exact: true }).waitFor({ timeout: 15000 });
        await lbl(page, '期別').selectOption('2026/09');
        await testId(page, 'payout-export-1').waitFor({ timeout: 10000 });
        check('重新整理後匯出 #1 還在（存在資料庫），不用重新下載就能標記', await markExportButton(page, 1).isVisible());
        const confirm = await openConfirm(page, 1);
        check('確認框：匯出 #1、測試管理員下載的 CSV、2 位講師、4 筆課、課程應付 $2,700、轉帳檔總額 $2,500',
            /^確定把匯出 #1（2026\/10\/22 \d{2}:\d{2} 測試管理員 下載的 CSV）標記為已付款嗎？2 位講師、4 筆課，課程應付 \$2,700；轉帳檔總額 \$2,500。$/.test((await text(testId(page, 'payout-mark-paid-confirm-main'))).replace(/\s+/g, ' ').replace('？ ', '？')),
            await text(testId(page, 'payout-mark-paid-confirm-main')));
        const peopleRows = await testId(page, 'payout-mark-paid-people').locator('tbody tr').allTextContents();
        check('確認框列出每位講師的實付（對銀行）：丁測一 $1,500、王測二 $1,000（人工調整 -$200）',
            peopleRows.map(flat).join('|') === '丁測一$1,500—|王測二$1,000-$200', peopleRows.join('|'));
        check('確認框：1 筆本次應付 $0，標記後已領不改小', (await text(testId(page, 'payout-mark-paid-confirm-zero'))) === '其中 1 筆本次應付 $0（之前已記錄付清或超付），標記後已領金額不會改小。');
        check('確認框：「這份匯出之後才新增或變動的紀錄不會被標記：1 筆」（晚到那筆），這一期另有 6 筆已核准不在檔案裡',
            flat(await text(testId(page, 'payout-mark-paid-confirm-later'))) === flat('這份匯出之後才新增或變動的紀錄不會被標記：1 筆。（這一期目前共有 6 筆已核准不在這份檔案裡，都維持已核准，下次匯款會再出現。）'),
            await text(testId(page, 'payout-mark-paid-confirm-later')));
        check('確認框列出下載當時沒納入的 5 行（異常、手動排除、對不到講師、被擋下的講師、取消勾選）',
            JSON.stringify(await testId(page, 'payout-mark-paid-confirm-excluded').locator('li').allTextContents()) === JSON.stringify(EXPECTED_EXCLUSIONS));
        const negative = testId(page, 'payout-mark-paid-negative');
        check('有負數人工調整：列出「王測二 -$200（扣回溢付）」，沒勾「我確認這些負數是扣款…」之前確認鈕不能按',
            (await negative.locator('li').allTextContents()).join() === '王測二 -$200（扣回溢付）' && await confirmMarkButton(page).isDisabled());
        await negative.getByLabel('我確認這些負數是扣款，不需要之後補發').check();
        check('勾選之後確認鈕可以按', await confirmMarkButton(page).isEnabled());
        await page.waitForTimeout(400);  // 按鈕從停用變可按有 200ms 的 CSS 過場，等它跑完再截圖
        await confirm.screenshot({ path: shot('desktop-1280-confirm-box.png') });
        rpcCalls.length = 0;
        await confirmMarkButton(page).dblclick();
        const okMessage = await waitText(testId(page, 'payout-mark-paid-message'), /^已把匯出 #1 標記為已付款/);
        const markCalls = rpcCalls.filter((c) => c.name === 'mark_salary_payout_export_paid');
        check('連點兩下只送出 1 次標記；只送匯出編號＋確認的筆數／金額（不送清單）',
            markCalls.length === 1 && JSON.stringify(markCalls[0].body) === JSON.stringify({ p_export_id: 1, p_expected_count: 4, p_expected_amount: 2700 }), JSON.stringify(markCalls.map((c) => c.body)));
        check('完成訊息：「已把匯出 #1 標記為已付款：4 筆、課程應付 $2,700（期間 8/26～9/25）…」',
            okMessage.startsWith('已把匯出 #1 標記為已付款：4 筆、課程應付 $2,700（期間 8/26～9/25）。'), okMessage);
        check('mock 資料庫：只有匯出 #1 的 4 筆變已付款（溢付那筆已領仍 500）；晚到的與被排除的仍是已核准',
            INCLUDED_NAMES.every((name) => byName(name).status === 'paid') && byName('丁-溢付').paid_amount === 500
            && ['丁-晚到課', '丁-重複', '王-手動排除', '林-體驗課', '陳-常態課', '對不到的課'].every((name) => byName(name).status === 'approved'));
        await waitText(testId(page, 'payout-export-1'), /已標記/);
        check('匯出 #1 狀態變「已標記」（附標記時間與人），只剩「還原」按鈕',
            /已標記2026\/10\/22\d{2}:\d{2}測試管理員還原$/.test(flat(await text(testId(page, 'payout-export-1')))) && (await markExportButton(page, 1).count()) === 0,
            await text(testId(page, 'payout-export-1')));
        await waitText(testId(page, 'payout-stats-period'), /已付 5 筆/);
        check('頁面重新讀取：本期「已付 5 筆」', (await text(testId(page, 'payout-stats-period'))).includes('已付 5 筆'));
        await page.screenshot({ path: shot('desktop-1280-after-mark.png'), fullPage: false });

        byName('丁-常態課').tick += 1;  // 標記後有人改了這筆 → 還原時不該動它
        await revertExportButton(page, 1).click();
        await testId(page, 'payout-revert-confirm').waitFor({ timeout: 5000 });
        check('還原確認框：匯出 #1、4 筆會改回標記前', (await text(testId(page, 'payout-revert-confirm'))).includes('確定還原匯出 #1 的已付款標記嗎？這份還沒還原的 4 筆會改回標記前的狀態'));
        await page.getByRole('button', { name: '確認還原匯出 #1' }).click();
        const revertMessage = await waitText(testId(page, 'payout-mark-paid-message'), /^匯出 #1 已還原/);
        check('還原結果：3 筆、$1,700；被改過的 1 筆列出來沒還原',
            revertMessage.startsWith('匯出 #1 已還原 3 筆、$1,700，這些紀錄回到標記前的狀態，下次匯款會再出現。另有 1 筆沒有還原：')
            && revertMessage.includes('丁測一・2026-08-26：標記後被改過（已領金額、付款時間或其他欄位）'), revertMessage);
        await waitText(testId(page, 'payout-export-1'), /已還原 3\/4 筆/);
        check('匯出 #1 狀態「已還原 3/4 筆」，仍可再按還原；mock：3 筆回到已核准、已領原值',
            (await text(testId(page, 'payout-export-1'))).includes('已還原 3/4 筆') && (await revertExportButton(page, 1).count()) === 1
            && ['丁-部分已付', '丁-溢付', '王-線上課'].every((name) => byName(name).status === 'approved') && byName('丁-部分已付').paid_amount === 100);
        await page.screenshot({ path: shot('desktop-1280-after-revert.png'), fullPage: false });
        await context.close();

        // ════════ 2. 和資料庫不符：下載時擋、標記時擋（換講師） ════════
        section('2. 下載前課被改到別的講師 → 不建立紀錄也不下載；下載後才換講師 → 標記整份被擋');
        resetWorld();
        ({ context, page } = await newContext(browser));
        await openPayout(page, base);
        await prepareEdits(page);
        Object.assign(byName('丁-常態課'), { instructor_id: I.wang, instructor_name: '王測二' });  // 頁面讀完之後資料庫才改
        const blocked = await clickExpectingNoDownload(page, '轉帳檔 CSV');
        const csvErrors = await testId(page, 'payout-csv-errors').locator('li').allTextContents();
        check('存的時候逐筆核對到講師不同：沒有下載、顯示「這份檔案有 1 筆和資料庫目前不符，沒有建立匯出紀錄，也沒有下載」與原因',
            !blocked && csvErrors[0] === '這份檔案有 1 筆和資料庫目前不符，沒有建立匯出紀錄，也沒有下載。請按「重新整理」後再下載：'
                && csvErrors[1] === '王測二・2026-08-26：講師和下載時不同（現在：王測二）' && world.exports.length === 0, csvErrors.join(' | '));
        Object.assign(byName('丁-常態課'), { instructor_id: I.ding, instructor_name: '丁測一' });
        await downloadVia(page, '轉帳檔 CSV');
        Object.assign(byName('丁-常態課'), { instructor_id: I.wang, instructor_name: '王測二' });  // 下載之後才換講師、金額不變
        await openConfirm(page, 1);
        await testId(page, 'payout-mark-paid-negative').getByLabel('我確認這些負數是扣款，不需要之後補發').check();
        await confirmMarkButton(page).click();
        const mismatch = await waitText(testId(page, 'payout-mark-paid-message'), /^匯出 #1 有/);
        check('標記時講師不同：「匯出 #1 有 1 筆和資料庫目前不符，這次沒有標記任何紀錄（資料庫已確認沒有改）」並列出原因',
            mismatch.startsWith('匯出 #1 有 1 筆和資料庫目前不符，這次沒有標記任何紀錄（資料庫已確認沒有改）') && mismatch.includes('講師和下載時不同（現在：王測二）')
            && (await testId(page, 'payout-mark-paid-message').getAttribute('role')) === 'alert', mismatch);
        check('整份不改：4 筆仍是已核准、匯出 #1 仍是未標記', INCLUDED_NAMES.every((name) => byName(name).status === 'approved') && world.exports[0].marked_at === null
            && (await text(testId(page, 'payout-export-1'))).includes('未標記'));
        await context.close();

        // ════════ 3. 不明錯誤：結果不確定 → 自動重讀；明確錯誤：說清楚沒改 ════════
        section('3. 不明錯誤：建立匯出紀錄回 503 → 不下載、提示不確定並自動重讀；標記時連線中斷 → 提示不確定、重讀後顯示真實狀態');
        resetWorld({ mode: 'record-5xx' });
        ({ context, page } = await newContext(browser));
        await openPayout(page, base);
        await prepareEdits(page);
        const reqBefore = reqLog.length;
        const blocked503 = await clickExpectingNoDownload(page, '轉帳檔 CSV');
        const uncertainRecord = await text(testId(page, 'payout-csv-errors'));
        check('建立匯出紀錄回 503（看不懂的頁面）：沒有下載，顯示「建立匯出紀錄的結果不確定…這次沒有下載」',
            !blocked503 && uncertainRecord.startsWith('建立匯出紀錄的結果不確定（網路或伺服器沒有正常回應），這次沒有下載。'), uncertainRecord);
        await testId(page, 'payout-export-1').waitFor({ timeout: 10000 });
        check('自動重讀這一期的匯出紀錄：資料庫其實存了 #1（未標記），畫面照實顯示',
            reqLog.slice(reqBefore).some((r) => r.path === '/rest/v1/salary_payout_exports' && r.method === 'GET') && (await text(testId(page, 'payout-export-1'))).includes('未標記'));
        world.mode = 'mark-abort';
        await openConfirm(page, 1);
        await testId(page, 'payout-mark-paid-negative').getByLabel('我確認這些負數是扣款，不需要之後補發').check();
        await confirmMarkButton(page).click();
        const uncertainMark = await waitText(testId(page, 'payout-mark-paid-message'), new RegExp(`^${UNCERTAIN_PREFIX}`));
        check('標記時連線中斷（其實已經標了）：顯示「結果不確定…請按重新讀取確認」，不說「沒有改任何紀錄」',
            uncertainMark.startsWith(UNCERTAIN_PREFIX) && !uncertainMark.includes('沒有改任何紀錄'), uncertainMark);
        await waitText(testId(page, 'payout-export-1'), /已標記/);
        check('自動重讀後匯出 #1 顯示資料庫的真實狀態「已標記」', (await text(testId(page, 'payout-export-1'))).includes('已標記'));
        await page.screenshot({ path: shot('desktop-1280-uncertain.png'), fullPage: false });
        await context.close();

        section('3b. 明確錯誤：確認框開著時別的管理員先標了同一份 → 資料庫回 22023，照實說明（不是「結果不確定」）');
        resetWorld();
        ({ context, page } = await newContext(browser));
        await openPayout(page, base);
        await prepareEdits(page);
        await downloadVia(page, '轉帳檔 CSV');
        await testId(page, 'payout-export-1').waitFor({ timeout: 10000 });
        await openConfirm(page, 1);
        mockMark({ p_export_id: 1, p_expected_count: 4, p_expected_amount: 2700 });  // 另一位管理員先標了
        await testId(page, 'payout-mark-paid-negative').getByLabel('我確認這些負數是扣款，不需要之後補發').check();
        await confirmMarkButton(page).click();
        const definite = await waitText(testId(page, 'payout-mark-paid-message'), /已經標記過/);
        check('資料庫明確拒絕（22023）：照實顯示「匯出 #1 已經標記過已付款，不能再標一次。」', definite === '匯出 #1 已經標記過已付款，不能再標一次。', definite);
        await context.close();

        // ════════ 4. 資料庫還沒更新：降級 ════════
        section('4. 資料庫還沒套這次的更新：照舊可以下載（沒有編號），提示無法在系統標記；標記區顯示需先更新');
        resetWorld({ mode: 'missing' });
        ({ context, page } = await newContext(browser));
        await openPayout(page, base);
        await prepareEdits(page);
        check(`標記區顯示「${MIGRATION_TEXT}」`, (await waitText(testId(page, 'payout-exports-missing'), MIGRATION_TEXT)) === MIGRATION_TEXT);
        const degraded = await downloadVia(page, '轉帳檔 CSV');
        check('照舊下載，檔名沒有匯出編號：202609夢想講師轉帳檔_20261010.csv', degraded.name === '202609夢想講師轉帳檔_20261010.csv', degraded.name);
        check('下載訊息照舊、另外提示「這次下載沒有建立匯出紀錄，之後無法在系統對這份標記已付款」',
            (await text(testId(page, 'payout-download-message'))) === '已下載轉帳檔 CSV：2 人，共 $2,500'
            && (await text(testId(page, 'payout-export-degraded'))).includes('這次下載沒有建立匯出紀錄，之後無法在系統對這份標記已付款'));
        await page.screenshot({ path: shot('desktop-1280-migration-missing.png'), fullPage: false });
        await context.close();

        // ════════ 5. 期別還沒結束 ════════
        section('5. 10 月期（10/25 才結束）：可以下載、建立匯出紀錄，但不能標記');
        resetWorld();
        ({ context, page } = await newContext(browser));
        await openPayout(page, base, { period: null });
        await lbl(page, '付款帳號').fill('123456789012');
        await lbl(page, '付款分行').fill('0456');
        const october = await downloadVia(page, '完整 Excel（四分頁）');
        check('10 月期下載 Excel：檔名 202610夢想講師轉帳檔_20261110_匯出1.xlsx', october.name === '202610夢想講師轉帳檔_20261110_匯出1.xlsx', october.name);
        await testId(page, 'payout-export-1').waitFor({ timeout: 10000 });
        await openConfirm(page, 1);
        check('確認框說「這一期到 10/25 才結束，結束後才能標記已付款。」、確認鈕不能按',
            (await text(testId(page, 'payout-mark-paid-not-ended'))) === '這一期到 10/25 才結束，結束後才能標記已付款。' && await confirmMarkButton(page).isDisabled());
        await context.close();

        // ════════ 6. 手機 390 ════════
        section('6. 手機 390：確認框不撐破版面');
        resetWorld();
        ({ context, page } = await newContext(browser, { width: 390, height: 844 }));
        await openPayout(page, base);
        await prepareEdits(page);
        await downloadVia(page, '轉帳檔 CSV');
        await testId(page, 'payout-export-1').waitFor({ timeout: 10000 });
        await markExportButton(page, 1).scrollIntoViewIfNeeded();
        await openConfirm(page, 1);
        await testId(page, 'payout-mark-paid-confirm').scrollIntoViewIfNeeded();
        const [scrollWidth, innerWidth] = await page.evaluate(() => [document.scrollingElement.scrollWidth, window.innerWidth]);
        const box = await testId(page, 'payout-mark-paid-confirm').boundingBox();
        check('390 寬：頁面沒有橫向捲動、確認框在螢幕寬度內', scrollWidth <= innerWidth && box && box.x >= 0 && box.x + box.width <= innerWidth, `scroll=${scrollWidth} inner=${innerWidth} box=${JSON.stringify(box)}`);
        const confirmBtn = await confirmMarkButton(page).boundingBox();
        const ackBox = await testId(page, 'payout-mark-paid-negative').locator('label').boundingBox();
        check('390 寬：確認鈕與負數確認勾選區高度都 ≥ 44px', confirmBtn?.height >= 44 && ackBox?.height >= 44, `${JSON.stringify(confirmBtn)} ${JSON.stringify(ackBox)}`);
        await testId(page, 'payout-mark-paid-confirm').screenshot({ path: shot('mobile-390-confirm.png') });
        await context.close();

        // ════════ 7. 報酬登記中心只剩提示 ════════
        section('7. 報酬登記中心：沒有「全部已核准」一鍵標的入口，只剩連到月結匯款頁的提示');
        resetWorld();
        world.register = true;
        ({ context, page } = await newContext(browser));
        await page.goto(`${base}/admin/salary`, { waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '報酬登記中心' }).waitFor({ timeout: 15000 });
        const hint = testId(page, 'salary-mark-paid-hint');
        await hint.waitFor({ timeout: 10000 });
        check('提示文字：到月結匯款頁下載（會存匯出紀錄），匯款完成後對那一份標記',
            flat(await text(hint)) === flat('本期匯款完成，要標「已付款」？請到月結匯款下載轉帳檔（系統會存一份匯出紀錄），銀行匯款完成後在同一頁對那一份標記：只會標記那份檔案裡的紀錄，被排除或被擋下的講師不會被標，標錯可以整份還原。'),
            await text(hint));
        check('沒有「本期匯款完成」或任何標記已付款按鈕', (await page.getByRole('button', { name: /本期匯款完成|標記為已付款|標記這份已付款/ }).count()) === 0);
        await hint.screenshot({ path: shot('salary-register-hint.png') });
        world.register = false;
        await hint.getByRole('link', { name: '月結匯款' }).click();
        await page.getByRole('heading', { name: '月結匯款', exact: true }).waitFor({ timeout: 15000 });
        check('點提示裡的「月結匯款」會到 /admin/salary/payout', new URL(page.url()).pathname === '/admin/salary/payout', page.url());
        await context.close();

        check('全程沒有呼叫任何舊函式（整期標記／吃前端清單）', !reqLog.some((r) => /mark_salary_period_paid|mark_salary_sessions_paid|revert_salary_payout_batch/.test(r.path)));
        check('全程沒有白名單外的 Supabase 請求', unexpected.length === 0, unexpected.join('\n        '));
        check('全程沒有頁面錯誤（pageerror）', pageErrors.length === 0, pageErrors.join('\n        '));
        console.log(`(外部網域一律擋下：${[...externalBlocked].join(', ') || '無'})`);
    } finally {
        await browser?.close();
        vite.kill('SIGTERM');  // 只停自己起的 vite
        rmSync(workDir, { recursive: true, force: true });
    }
}

try {
    await run();
} catch (error) {
    check('腳本本身執行中斷', false, error.stack || error.message);
}
const pass = results.filter(Boolean).length;
console.log(`\n${'-'.repeat(60)}`);
console.log(`RESULT ${pass}/${results.length}`);
console.log(`截圖：${path.relative(appDir, shotDir)}/`);
if (pass !== results.length) process.exitCode = 1;
