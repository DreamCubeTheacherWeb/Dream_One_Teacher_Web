#!/usr/bin/env node
// 帳號認領啟用（Email OTP）＋電子契約簽署證據：資料庫層驗證（migration 20261020100000）
//
// 做法：用 scripts/e2e/lib/db.mjs 起一個全新的暫時 PostgreSQL，套 scripts/e2e/bootstrap.sql（Supabase 相容底座，
// 含 pg_net／Vault 替身）＋ supabase/*.sql ＋ supabase/migrations/*.sql（含新 migration），再以不同假使用者身分
// （SET ROLE authenticated＋request.jwt.claims＋request.headers，與 PostgREST 相同）跑情境。
// pg_net 替身把寄出的請求存進 net._e2e_http_requests，測試從那裡讀出驗證碼明碼——只限測試，正式環境沒有這張表。
// 每項印 PASS／FAIL；有 FAIL 就 exit 1。結束時只停自己起的 PostgreSQL（記錄 PID，不 pkill）。
//
// 用法：LC_ALL=en_US.UTF-8 node scripts/verify-claim-activation-esign.mjs
//   突變測試（證明測試抓得到漏洞）：加 --mutate=<名稱>，只在暫存複本上改 SQL（不動 repo 檔），套完照跑全部情境，
//   必須有 FAIL（見下方 MUTATIONS）：
//     --mutate=drop-role-check          拿掉 20261023100000 的「已啟用帳號」條件（未啟用的綁定者讀得到空位的上課與報酬）
//     --mutate=drop-claim-records-check 拿掉 20261020100000 姓名空位認領的「已有上課或報酬紀錄」排除條件
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { TempPostgres, SQL_PATCHES } from './e2e/lib/db.mjs';
import { isMinorOn } from '../src/lib/esign.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = path.join(appDir, 'supabase/migrations/20261020100000_claim_activation_esign_evidence.sql');
const LEGAL_COPY = path.join(appDir, 'docs/specs/2026-10-20-esign-legal-copy.md');
const MINOR_MIGRATION = path.join(appDir, 'supabase/migrations/20261022120000_block_minor_online_signing.sql');
const LINKED_READS_MIGRATION = path.join(appDir, 'supabase/migrations/20261023100000_linked_reads_require_active_account.sql');

// ── 突變測試 ────────────────────────────────────────────────────────
// 每個突變是一條 SQL 文字修補（同 scripts/e2e/lib/db.mjs 的 SQL_PATCHES 格式）；修補對不到就直接報錯，
// 確保突變真的生效。測試中途單獨重跑的 migration 也套同一條修補（migrationFile）。
const MUTATIONS = {
  'drop-role-check': {
    files: ['20261023100000_linked_reads_require_active_account.sql'],
    find: /\(SELECT private\.current_user_is_approved_account\(\)\)/g,
    replace: 'true',
    reason: '突變測試：拿掉 20261023100000 所有「本人是已啟用帳號（teacher／mentor／admin）」條件',
  },
  'drop-claim-records-check': {
    files: ['20261020100000_claim_activation_esign_evidence.sql'],
    find: /-- \[claim-records-check\][\s\S]*?-- \[\/claim-records-check\]/g,
    replace: '-- [mutated] claim records check removed',
    reason: '突變測試：拿掉姓名空位認領的「已有上課或報酬紀錄」排除條件',
  },
};
const mutateArg = (process.argv.find((arg) => arg.startsWith('--mutate=')) || '').slice('--mutate='.length) || null;
const mutation = mutateArg ? MUTATIONS[mutateArg] : null;
if (mutateArg && !mutation) {
  console.error(`未知的突變：${mutateArg}（可用：${Object.keys(MUTATIONS).join(', ')}）`);
  process.exit(2);
}
if (mutation) {
  SQL_PATCHES.push(mutation);
  console.log(`*** 突變測試 ${mutateArg}：${mutation.reason}。預期會有 FAIL。***`);
}
const COMPANY = '夢想一號文化教育股份有限公司';
const CONTACT = 'hi@dreamcube.tw';
const RESEND_KEY = 're_test_key_DO_NOT_USE';
const RESEND_FROM = '夢想一號 <no-reply@example.test>';

// ── 結果收集 ────────────────────────────────────────────────────────
const results = [];
let currentGroup = 'setup';
const group = (name) => { currentGroup = name; console.log(`\n── ${name} ──`); };
function check(name, condition, detail = '') {
  const pass = Boolean(condition);
  results.push({ group: currentGroup, name, pass });
  const extra = !pass && detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
  console.log(`${pass ? 'PASS' : 'FAIL'}: [${currentGroup}] ${name}${extra}`);
  return pass;
}

const sha = (text) => createHash('sha256').update(text).digest('hex');
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;
const dq = (sql) => {
  if (sql.includes('$tq$')) throw new Error('nested $tq$');
  return `$tq$${sql}$tq$`;
};
const jlit = (value) => (value === null || value === undefined ? 'NULL' : `${lit(JSON.stringify(value))}::jsonb`);
const ulit = (value) => (value ? `${lit(value)}::uuid` : 'NULL');
const errOf = (r) => (r && r.ok === false ? r.message : null);

const db = new TempPostgres({ label: 'claim-esign' });
const emails = new Map();
// 測試中途單獨重跑某支 migration：有突變時改用套過同一條修補的暫存複本（否則重跑會把突變蓋回正確版本）
function migrationFile(file) {
  if (!mutation || !mutation.files.includes(path.basename(file))) return file;
  const text = readFileSync(file, 'utf8');
  const patched = text.replace(mutation.find, mutation.replace);
  if (patched === text) throw new Error(`mutation ${mutateArg} no longer matches ${file}`);
  const target = path.join(db.dir, `mutated-${path.basename(file)}`);
  writeFileSync(target, patched, 'utf8');
  return target;
}

// ── 身分切換（與 PostgREST 相同：SET ROLE＋request.jwt.claims＋request.headers） ──
function sqlAs(uid, sql, { headers = {}, role = 'authenticated' } = {}) {
  const claims = uid ? JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated', email: emails.get(uid) }) : '';
  const prefix = role === 'postgres' ? '' : `SET ROLE ${role};\n`;
  return db.psqlSync(`${prefix}SET request.jwt.claims = :'claims';\nSET request.headers = :'hdrs';\n${sql}`, {
    vars: { claims, hdrs: JSON.stringify(headers) },
  }).stdout;
}
const jsonAs = (uid, sql, opts) => { const out = sqlAs(uid, sql, opts); return out ? JSON.parse(out) : null; };
// call：執行一個回傳 jsonb 的運算式 → {ok:true,result} 或 {ok:false,sqlstate,message}（失敗時子交易回滾，等同 PostgREST 整筆回滾）
const call = (uid, expr, opts) => jsonAs(uid, `SELECT t.try(${dq(`SELECT ${expr}`)});`, opts);
// exec：執行任意指令 → {ok:true,rows} 或 {ok:false,...}
const exec = (uid, stmt, opts) => jsonAs(uid, `SELECT t.exec(${dq(stmt)});`, opts);
const su = (sql) => db.psqlSync(sql).stdout;
const suJson = (sql) => { const out = su(sql); return out ? JSON.parse(out) : null; };
const suExec = (stmt) => suJson(`SELECT t.exec(${dq(stmt)});`);
const suVal = (sql) => su(sql);

// ── 測試資料工具 ────────────────────────────────────────────────────
function createAuthUser(email, fullName) {
  const id = randomUUID();
  emails.set(id, email);
  su(`INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES ('00000000-0000-0000-0000-000000000000', ${lit(id)}, 'authenticated', 'authenticated', ${lit(email)}, now(),
              '{"provider":"google","providers":["google"]}'::jsonb, jsonb_build_object('full_name', ${lit(fullName)}), now(), now());`);
  return id;
}
const roleOf = (uid) => suVal(`SELECT role FROM public.users WHERE id = ${lit(uid)}`);
const instructorOf = (uid) => suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE user_id = ${lit(uid)}`);
const activationsOf = (uid) => suJson(`SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.claimed_at), '[]'::jsonb) FROM public.instructor_account_activations a WHERE a.user_id = ${lit(uid)}`);
const openActivation = (uid) => (activationsOf(uid) || []).find((a) => a.status === 'pending' || a.status === 'active') || null;
const makeInstructor = (name, email, { phone = '0912345678', idNumber = 'A123456789', userId = null } = {}) =>
  suVal(`SELECT t.make_instructor(${lit(name)}, ${email ? lit(email) : 'NULL'}, ${lit(phone)}, ${lit(idNumber)}, ${ulit(userId)})`);

function requestOtp(uid, purpose) {
  const r = call(uid, `public.request_email_otp(${lit(purpose)})`);
  return r?.ok ? r.result : r;
}
function codeOf(challengeId) {
  return suVal(`SELECT (regexp_match(r.body->>'text', '驗證碼：([0-9]{6})'))[1]
                  FROM private.email_otp_challenges c
                  JOIN public.email_delivery_log l ON l.id = c.delivery_id
                  JOIN net._e2e_http_requests r ON r.id = l.net_request_id
                 WHERE c.id = ${lit(challengeId)}`);
}
function verifyOtp(uid, challengeId, code) {
  const r = call(uid, `public.verify_email_otp(${ulit(challengeId)}, ${lit(code)})`);
  return r?.ok ? r.result : r;
}
// 把這個人的舊 challenge 往前推 2 小時（跳過 60 秒冷卻與每小時上限），再寄一封新的並回傳 challenge
function freshOtp(uid, purpose) {
  su(`UPDATE private.email_otp_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = ${lit(uid)}`);
  const sent = requestOtp(uid, purpose);
  if (sent?.status !== 'sent') throw new Error(`freshOtp(${purpose}) failed: ${JSON.stringify(sent)}`);
  return { id: sent.challenge_id, code: codeOf(sent.challenge_id), sent };
}
function verifiedContractOtp(uid) {
  const otp = freshOtp(uid, 'contract_sign');
  const v = verifyOtp(uid, otp.id, otp.code);
  if (v?.status !== 'verified') throw new Error(`contract otp verify failed ${JSON.stringify(v)}`);
  return otp.id;
}
function recordConsent(uid, decision, versions, code = 'esign-consent-v1', headers = {}) {
  return call(uid, `public.record_contract_consent(${lit(decision)}, ${jlit(versions)}, ${lit(code)})`, { headers });
}
function submitExpr({ name = '王小明', sig, pdfs, versions, otp, consent, docHash, pdfHash, ua = 'client-UA' }) {
  return `public.submit_my_contract(p_filled_name => ${lit(name)}, p_filled_instructor_role => 'A',
    p_filled_id_number => 'A123456789', p_filled_address => '台北市信義區某路 1 號', p_filled_phone => '0912345678',
    p_signature_path => ${lit(sig)}, p_signed_pdf_paths => ${jlit(pdfs)}, p_doc_versions => ${jlit(versions)},
    p_user_agent => ${lit(ua)}, p_otp_challenge_id => ${ulit(otp)}, p_consent_id => ${ulit(consent)},
    p_document_sha256 => ${jlit(docHash)}, p_signed_pdf_sha256 => ${jlit(pdfHash)})`;
}

// ── 法規文案原文（docs/specs/2026-10-20-esign-legal-copy.md §5）──
const legal = readFileSync(LEGAL_COPY, 'utf8');
function legalQuoteLines(code) {
  const anchor = legal.indexOf('## 5.');
  const at = legal.indexOf('`' + code + '`', anchor);
  if (anchor < 0 || at < 0) return [];
  const headingStart = legal.lastIndexOf('### ', at);
  const nextHeading = legal.indexOf('\n### ', at);
  const end = nextHeading === -1 ? legal.indexOf('\n---', at) : nextHeading;
  return legal.slice(headingStart, end).split('\n')
    .filter((line) => line.startsWith('> '))
    .map((line) => line.slice(2)
      .replace(/\*\*/g, '')
      .replace(/【待業主確認[^】]*】/g, '')
      .replaceAll('{{company_name}}', COMPANY)
      .replaceAll('{{contact_email}}', CONTACT)
      .trim())
    .filter(Boolean);
}

let pgPid = null;
try {
  // ════════════════════════════════════════════════════════════════
  group('setup');
  await db.start();
  pgPid = db.pid;
  console.log(`temporary PostgreSQL pid=${pgPid} port=${db.port}`);
  const chain = db.applyChain(appDir, { bootstrapFile: path.join(appDir, 'scripts/e2e/bootstrap.sql') });
  check(`全部 SQL 套用成功（${chain.applied.length} 個檔，含新 migration）`,
    chain.applied.includes('supabase/migrations/20261020100000_claim_activation_esign_evidence.sql'));

  su(`
    CREATE SCHEMA t;
    GRANT USAGE ON SCHEMA t TO anon, authenticated, service_role;
    CREATE FUNCTION t.try(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
    DECLARE v jsonb; v_state text; v_msg text;
    BEGIN
      BEGIN
        EXECUTE p_sql INTO v;
        RETURN jsonb_build_object('ok', true, 'result', v);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
      END;
    END $f$;
    CREATE FUNCTION t.exec(p_sql text) RETURNS jsonb LANGUAGE plpgsql AS $f$
    DECLARE n bigint; v_state text; v_msg text;
    BEGIN
      BEGIN
        EXECUTE p_sql;
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN jsonb_build_object('ok', true, 'rows', n);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        RETURN jsonb_build_object('ok', false, 'sqlstate', v_state, 'message', v_msg);
      END;
    END $f$;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO anon, authenticated, service_role;
    -- 資料齊全的講師主檔（以超級使用者建立＝模擬匯入／後台既有資料）
    CREATE FUNCTION t.make_instructor(p_name text, p_email text, p_phone text, p_id_number text, p_user uuid)
    RETURNS uuid LANGUAGE sql AS $f$
      INSERT INTO public.instructors (
        user_id, full_name, nickname, gender, birth_date, id_number, phone_mobile, line_id, address, household_address,
        email_primary, teaching_freq_semester, teaching_freq_vacation, teaching_regions, bio_notes,
        bank_account_name, bank_name, bank_branch, bank_account_number, bank_code,
        id_front_path, id_back_path, bankbook_path, instructor_role, employment_status)
      VALUES (
        p_user, p_name, p_name || '暱稱', '男', '1990-01-01', p_id_number, p_phone, 'line-' || p_phone,
        '台北市信義區 1 號', '台北市信義區 1 號', p_email, '每週 2 次', '每週 3 次', ARRAY['臺北市']::public.tw_county[], '測試資料',
        p_name, '測試銀行', '測試分行', '0000000000', '0000000',
        'instructors/import/id-front.png', 'instructors/import/id-back.png', 'instructors/import/bankbook.png',
        'A', 'active')
      RETURNING id
    $f$;
  `);
  su(`INSERT INTO vault.secrets (name, secret) VALUES ('resend_api_key', ${lit(RESEND_KEY)}), ('resend_from', ${lit(RESEND_FROM)});`);

  const rpcs = [
    'public.get_my_activation_status()',
    'public.request_email_otp(text)',
    'public.verify_email_otp(uuid,text)',
    'public.record_contract_consent(text,jsonb,text)',
    'public.submit_my_contract(text,text,text,text,text,text,jsonb,jsonb,text,uuid,uuid,jsonb,jsonb)',
    'public.admin_confirm_instructor_email(uuid,text,text)',
    'public.admin_set_document_hash(uuid,text)',
    'public.admin_verify_contract_evidence_chain()',
  ];
  const fnInfo = suJson(`SELECT jsonb_agg(jsonb_build_object('fn', f, 'definer', p.prosecdef, 'path', p.proconfig,
      'anon', has_function_privilege('anon', f::regprocedure, 'EXECUTE'),
      'auth', has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'),
      'service', has_function_privilege('service_role', f::regprocedure, 'EXECUTE')))
    FROM unnest(ARRAY[${rpcs.map(lit).join(',')}]) AS f JOIN pg_proc p ON p.oid = f::regprocedure`);
  check('8 個新 RPC 都是 SECURITY DEFINER＋search_path=\'\'', fnInfo.length === 8 && fnInfo.every((f) => f.definer && JSON.stringify(f.path) === '["search_path=\\"\\""]'), fnInfo);
  check('8 個新 RPC：anon／service_role 無 EXECUTE、authenticated 有', fnInfo.every((f) => !f.anon && !f.service && f.auth), fnInfo);
  check('submit_my_contract 只剩一個多載（v2）', suVal(`SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'submit_my_contract'`) === '1');
  const privAnon = suVal(`SELECT has_schema_privilege('anon', 'private', 'USAGE') OR has_table_privilege('authenticated', 'private.email_otp_challenges', 'SELECT')`);
  check('private.email_otp_challenges：authenticated 沒有任何讀取權、anon 沒有 private schema', privAnon === 'f');
  check('pg_cron 排程 dreamone-refresh-email-delivery-status 每分鐘', suVal(`SELECT schedule || '|' || command FROM cron.job WHERE jobname = 'dreamone-refresh-email-delivery-status'`) === '* * * * *|SELECT private.refresh_email_delivery_status();');

  // ════════════════════════════════════════════════════════════════
  group('backfill D2/D4');
  // 模擬「migration 執行當下已存在」的資料：以超級使用者直接寫成舊流程的結果
  const legacyTeacher = createAuthUser('legacy-teacher@t.test', '舊講師');
  const legacyInstructor = makeInstructor('舊講師', 'Legacy-Teacher@T.test ', { userId: legacyTeacher });
  su(`UPDATE public.users SET role = 'teacher' WHERE id = ${lit(legacyTeacher)}`);
  const unlinkedOld = makeInstructor('未綁定舊講師', ' Unlinked.Old@T.test');
  const badEmailOld = makeInstructor('信箱格式壞掉', 'not-an-email');
  const pendingNew = createAuthUser('pending-new@t.test', '待審新講師');
  const pendingNewInstructor = makeInstructor('待審新講師', 'pending-new@t.test', { userId: pendingNew });
  const updatedBefore = suVal(`SELECT updated_at FROM public.instructors WHERE id = ${lit(unlinkedOld)}`);
  su(`DELETE FROM private.schema_backfill_markers WHERE name = '20261020100000_claim_activation_esign_evidence'`);
  const rerun1 = db.psqlSync(null, { file: migrationFile(MIGRATION), tuplesOnly: false, expectFail: true });
  check('migration 第二次套用成功（模擬上線時的回填）', rerun1.ok, rerun1.stderr);
  const lt = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE id = ${lit(legacyInstructor)}`);
  check('D2 既有講師：identity_verified_at 已登錄、依據為公司既有核驗結果（非第三方實名認證）',
    lt.identity_verified_at && lt.identity_verification_basis === '公司既有核驗結果登錄（非第三方實名認證）', lt);
  check('D2 既有 email_primary 小寫去空白登錄為 confirmed_email（company_existing_record，by NULL）',
    lt.confirmed_email === 'legacy-teacher@t.test' && lt.confirmed_email_method === 'company_existing_record' && lt.confirmed_email_by === null && lt.confirmed_email_at, lt);
  const uo = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE id = ${lit(unlinkedOld)}`);
  check('D2 未綁定的既有主檔也登錄（unlinked.old@t.test）', uo.identity_verified_at && uo.confirmed_email === 'unlinked.old@t.test', uo);
  check('D2 回填不改 instructors.updated_at', suVal(`SELECT updated_at FROM public.instructors WHERE id = ${lit(unlinkedOld)}`) === updatedBefore);
  const bo = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE id = ${lit(badEmailOld)}`);
  check('D2 格式錯誤的 Email 不登錄（confirmed_email 維持 NULL，身分仍登錄）', bo.identity_verified_at && bo.confirmed_email === null, bo);
  const pn = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE id = ${lit(pendingNewInstructor)}`);
  check('D2 排除「新建帳號待審核」（綁在 pending 帳號的列）', pn.identity_verified_at === null && pn.confirmed_email === null, pn);
  const legacyAct = openActivation(legacyTeacher);
  check('D4 既有 teacher 補一筆 legacy_pre_activation（active）', legacyAct?.claim_method === 'legacy_pre_activation' && legacyAct.status === 'active' && legacyAct.activated_at && legacyAct.instructor_id === legacyInstructor, legacyAct);
  check('D4 既有 teacher 角色不受影響', roleOf(legacyTeacher) === 'teacher');
  check('D4 待審新講師（pending）沒有被補啟用紀錄', (activationsOf(pendingNew) || []).length === 0);
  const markerBefore = suVal(`SELECT applied_at || detail::text FROM private.schema_backfill_markers`);
  const rerun2 = db.psqlSync(null, { file: migrationFile(MIGRATION), tuplesOnly: false, expectFail: true });
  check('migration 第三次套用成功，回填不重做（標記不變、啟用紀錄不重複）',
    rerun2.ok && suVal(`SELECT applied_at || detail::text FROM private.schema_backfill_markers`) === markerBefore && activationsOf(legacyTeacher).length === 1, rerun2.stderr);
  const legacyStatus = call(legacyTeacher, 'public.get_my_activation_status()');
  check('legacy teacher 的 get_my_activation_status = active / legacy_pre_activation / 有已確認 Email',
    legacyStatus.result?.status === 'active' && legacyStatus.result?.claim_method === 'legacy_pre_activation' && legacyStatus.result?.has_confirmed_email === true && legacyStatus.result?.masked_email === 'le***@t.test', legacyStatus);

  // ════════════════════════════════════════════════════════════════
  group('activation: claim paths');
  su(`INSERT INTO public.teacher_invites (name, email, role) VALUES ('管理員', 'admin@t.test', 'admin')`);
  const admin = createAuthUser('admin@t.test', '管理員');
  check('管理員帳號建立（staff 邀請）', roleOf(admin) === 'admin');

  // 路徑 1：Email 對應（首次登入 trigger）
  const emailInstructor = makeInstructor('信箱老師', 'em@t.test');
  const uEmail = createAuthUser('em@t.test', 'Google 顯示名');
  check('Email 對應：首次登入就綁定主檔', instructorOf(uEmail)?.id === emailInstructor);
  check('Email 對應：綁定後 role 仍是 pending（不再直接開通）', roleOf(uEmail) === 'pending');
  const actEmail = openActivation(uEmail);
  check('Email 對應：寫一筆 pending 啟用紀錄（email_match、claimed_at 伺服器時間、instructor_id）',
    actEmail?.status === 'pending' && actEmail.claim_method === 'email_match' && actEmail.claimed_at && actEmail.instructor_id === emailInstructor, actEmail);
  const rClaimAgain = call(uEmail, 'public.claim_my_precreated_instructor()');
  check('Email 對應：再呼叫 claim_my_precreated_instructor → claimed、activation_required=true',
    rClaimAgain.result?.status === 'claimed' && rClaimAgain.result?.activation_required === true && rClaimAgain.result?.claimed_now === false, rClaimAgain);

  // 路徑 1b：先註冊、後建檔，再由 claim_my_precreated_instructor 認領
  const uPre = createAuthUser('pre@t.test', '後建檔老師');
  const preInstructor = makeInstructor('後建檔老師', 'pre@t.test', { phone: '0933000111', idNumber: 'C123450001' });
  const rPre = call(uPre, 'public.claim_my_precreated_instructor()');
  check('claim_my_precreated_instructor：status claimed 不變、另加 activation_required:true',
    rPre.result?.status === 'claimed' && rPre.result?.claimed_now === true && rPre.result?.activation_required === true && rPre.result?.instructor_id === preInstructor, rPre);
  check('claim_my_precreated_instructor：role 仍是 pending、啟用紀錄 pending email_match',
    roleOf(uPre) === 'pending' && openActivation(uPre)?.claim_method === 'email_match' && openActivation(uPre)?.status === 'pending');

  // 路徑 2：姓名＋手機＋身分證末四碼
  const idInstructor = makeInstructor('核對老師', 'old-idc@t.test', { phone: '0922333444', idNumber: 'B223456789' });
  const uId = createAuthUser('idc@t.test', '核對老師 Google');
  const rId = call(uId, `public.claim_existing_instructor_by_identity('核對 老師', '0922-333-444', '6789')`);
  check('claim_existing_instructor_by_identity：claimed＋activation_required:true',
    rId.result?.status === 'claimed' && rId.result?.activation_required === true && rId.result?.instructor_id === idInstructor, rId);
  check('claim_existing_instructor_by_identity：role 仍是 pending、啟用紀錄 identity_check',
    roleOf(uId) === 'pending' && openActivation(uId)?.claim_method === 'identity_check');

  // 路徑 3：姓名空位（管理員只填姓名建立）
  const slotInsert = exec(admin, `INSERT INTO public.instructors (full_name, name_slot) VALUES ('空位老師', true)`);
  check('管理員可建立姓名空位', slotInsert?.ok && slotInsert.rows === 1, slotInsert);
  const slot = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE full_name = '空位老師'`);
  check('管理員新建講師列：identity_verified_at 登錄、依據「管理員建立講師資料」、Email 未確認',
    slot.identity_verified_at && slot.identity_verification_basis === '管理員建立講師資料' && slot.confirmed_email === null, slot);
  const uSlot = createAuthUser('slot@t.test', '空位老師 Google');
  const rSlot = call(uSlot, `public.claim_instructor_name_slot('空位老師')`);
  check('claim_instructor_name_slot：claimed＋activation_required:true（只綁不開通）',
    rSlot.result?.status === 'claimed' && rSlot.result?.activation_required === true && rSlot.result?.instructor_id === slot.id, rSlot);
  check('claim_instructor_name_slot：role 仍是 pending、啟用紀錄 name_slot',
    roleOf(uSlot) === 'pending' && openActivation(uSlot)?.claim_method === 'name_slot');
  const slotStatus = call(uSlot, 'public.get_my_activation_status()').result;
  check('姓名空位：get_my_activation_status = pending、沒有已確認 Email、資料未完整',
    slotStatus?.status === 'pending' && slotStatus.claim_method === 'name_slot' && slotStatus.has_confirmed_email === false && slotStatus.masked_email === null && slotStatus.profile_complete === false, slotStatus);
  check('姓名空位：沒有已確認 Email → request_email_otp 回 no_confirmed_email', requestOtp(uSlot, 'account_activation')?.status === 'no_confirmed_email');

  // admin_confirm_instructor_email 的權限與輸入檢查
  check('teacher／pending 呼叫 admin_confirm_instructor_email → 42501',
    call(uSlot, `public.admin_confirm_instructor_email(${ulit(slot.id)}, 'slot@t.test', 'x')`)?.sqlstate === '42501');
  check('admin_confirm_instructor_email：格式錯 → INVALID_EMAIL',
    errOf(call(admin, `public.admin_confirm_instructor_email(${ulit(slot.id)}, 'not an email', '電話確認')`)) === 'INVALID_EMAIL');
  check('admin_confirm_instructor_email：沒有註記 → NOTE_REQUIRED',
    errOf(call(admin, `public.admin_confirm_instructor_email(${ulit(slot.id)}, 'slot@t.test', '  ')`)) === 'NOTE_REQUIRED');
  const conf = call(admin, `public.admin_confirm_instructor_email(${ulit(slot.id)}, ' Slot@T.test ', '10/20 透過 LINE 與老師確認')`);
  check('admin_confirm_instructor_email → {status:confirmed}', conf.result?.status === 'confirmed', conf);
  const slotAfter = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE id = ${lit(slot.id)}`);
  check('確認 Email 寫入 confirmed_email（小寫去空白）／by 管理員／admin_trusted_channel／註記',
    slotAfter.confirmed_email === 'slot@t.test' && slotAfter.confirmed_email_by === admin && slotAfter.confirmed_email_method === 'admin_trusted_channel' && slotAfter.confirmed_email_note === '10/20 透過 LINE 與老師確認', slotAfter);
  check('姓名空位：Email 確認後但資料不完整 → profile_incomplete（不能要 OTP）', requestOtp(uSlot, 'account_activation')?.status === 'profile_incomplete');

  // 講師不能自己設定／更改 admin 專屬欄位
  const selfEdit = exec(uSlot, `UPDATE public.instructors SET confirmed_email = 'hacker@evil.test' WHERE user_id = auth.uid()`);
  check('講師自己改 confirmed_email 被 guard 擋（42501）', selfEdit?.ok === false && selfEdit.sqlstate === '42501', selfEdit);
  const selfVerify = exec(uSlot, `UPDATE public.instructors SET identity_verified_at = now() WHERE user_id = auth.uid()`);
  check('講師自己改 identity_verified_at 被 guard 擋（42501）', selfVerify?.ok === false && selfVerify.sqlstate === '42501', selfVerify);

  // 新建帳號：管理員審核
  const uNew = createAuthUser('new@t.test', '新進老師');
  const newIns = exec(uNew, `INSERT INTO public.instructors (
      user_id, full_name, nickname, gender, birth_date, id_number, phone_mobile, line_id, address, household_address, email_primary,
      teaching_freq_semester, teaching_freq_vacation, teaching_regions, bio_notes, bank_account_name, bank_name, bank_branch,
      bank_account_number, bank_code, id_front_path, id_back_path, bankbook_path)
    VALUES (auth.uid(), '新進老師', '新新', '女', '1995-05-05', 'D223456789', '0955000111', 'line-new', '台中市', '台中市', 'new@t.test',
      '每週 1 次', '每週 2 次', ARRAY['臺中市']::public.tw_county[], '新進', '新進老師', '銀行', '分行', '1111111111', '0000001',
      'instructors/' || auth.uid() || '/f.png', 'instructors/' || auth.uid() || '/b.png', 'instructors/' || auth.uid() || '/k.png')`);
  check('新進講師自建主檔（不能帶 admin 欄位，照舊可建）', newIns?.ok && newIns.rows === 1, newIns);
  const selfSetConfirmed = exec(uNew, `UPDATE public.instructors SET confirmed_email = 'new@t.test' WHERE user_id = auth.uid()`);
  check('新進講師不能自己登錄 confirmed_email', selfSetConfirmed?.ok === false, selfSetConfirmed);
  check('新進講師沒有啟用紀錄、request_email_otp(account_activation) → not_allowed',
    (activationsOf(uNew) || []).length === 0 && requestOtp(uNew, 'account_activation')?.status === 'not_allowed');
  const approve = exec(admin, `SELECT public.approve_new_instructor_account(${ulit(uNew)})`);
  check('approve_new_instructor_account 成功', approve?.ok, approve);
  check('核准後 role = teacher', roleOf(uNew) === 'teacher');
  const newAct = openActivation(uNew);
  check('核准寫 new_instructor_approved（active、activation_email＝Google 信箱）',
    newAct?.claim_method === 'new_instructor_approved' && newAct.status === 'active' && newAct.activated_at && newAct.activation_email === 'new@t.test', newAct);
  const newInstr = instructorOf(uNew);
  check('核准＝公司核驗：confirmed_email＝Google 信箱（google_login_new_instructor、by 管理員）、identity_verified_at＝now、依據「管理員審核新進講師」',
    newInstr.confirmed_email === 'new@t.test' && newInstr.confirmed_email_method === 'google_login_new_instructor' && newInstr.confirmed_email_by === admin
    && newInstr.identity_verified_at && newInstr.identity_verification_basis === '管理員審核新進講師', newInstr);
  const approveClaimed = exec(admin, `SELECT public.approve_new_instructor_account(${ulit(uId)})`);
  check('認領既有主檔（pending 啟用）的帳號不能由管理員直接核准開通',
    approveClaimed?.ok === false && approveClaimed.sqlstate === '23514' && roleOf(uId) === 'pending', approveClaimed);

  // 路徑 4：後台手動綁定 admin_link_instructor（只綁不開通）
  const linkSql = (instructorId, userId) => `SELECT public.admin_link_instructor(${ulit(instructorId)}, ${ulit(userId)})`;
  const alInstructor = makeInstructor('手動綁定老師', 'al-old@t.test', { phone: '0944000222', idNumber: 'E123450002' });
  const uAl = createAuthUser('al@t.test', '手動綁定 Google');
  const alDenied = exec(uAl, linkSql(alInstructor, uAl));
  check('非 admin 呼叫 admin_link_instructor → 42501', alDenied?.ok === false && alDenied.sqlstate === '42501' && !instructorOf(uAl), alDenied);
  const al = exec(admin, linkSql(alInstructor, uAl));
  check('admin_link_instructor：綁定成功', al?.ok && instructorOf(uAl)?.id === alInstructor, al);
  check('admin_link_instructor：pending 帳號維持 pending（不再直接升 teacher）', roleOf(uAl) === 'pending');
  const alAct = openActivation(uAl);
  check('admin_link_instructor：寫 pending 啟用紀錄（claim_method admin_link、instructor_id、claimed_at）',
    alAct?.status === 'pending' && alAct.claim_method === 'admin_link' && alAct.instructor_id === alInstructor && alAct.claimed_at && alAct.activated_at === null, alAct);
  const alStatus = call(uAl, 'public.get_my_activation_status()').result;
  check('手動綁定：get_my_activation_status → pending／admin_link', alStatus?.status === 'pending' && alStatus.claim_method === 'admin_link', alStatus);
  const alApprove = exec(admin, `SELECT public.approve_new_instructor_account(${ulit(uAl)})`);
  check('手動綁定的 pending 帳號也不能由 approve 直接開通', alApprove?.ok === false && alApprove.sqlstate === '23514' && roleOf(uAl) === 'pending', alApprove);
  call(admin, `public.admin_confirm_instructor_email(${ulit(alInstructor)}, 'al@t.test', '電話確認')`);
  const alOtp = freshOtp(uAl, 'account_activation');
  const alVerify = verifyOtp(uAl, alOtp.id, alOtp.code);
  const alActDone = openActivation(uAl);
  check('手動綁定帳號由講師本人 OTP 啟用 → teacher、啟用紀錄 active（admin_link、otp 欄位齊全）',
    alVerify.activated === true && roleOf(uAl) === 'teacher' && alActDone.status === 'active' && alActDone.claim_method === 'admin_link'
    && alActDone.otp_challenge_id === alOtp.id && alActDone.otp_verified_at && alActDone.activation_email === 'al@t.test', { alVerify, alActDone });

  // 已是 teacher：比照 mentor／admin 規則（不降級、不需再 OTP），寫 active 的 admin_link 讓簽約資格成立
  const uAlTeacher = createAuthUser('al-teacher@t.test', '在職老師');
  su(`UPDATE public.users SET role = 'teacher' WHERE id = ${lit(uAlTeacher)}`);
  const alTeacherInstructor = makeInstructor('在職老師', 'alt-old@t.test', { phone: '0944000333', idNumber: 'E123450003' });
  const alT = exec(admin, linkSql(alTeacherInstructor, uAlTeacher));
  const alTAct = openActivation(uAlTeacher);
  check('已是 teacher 的帳號手動綁定：角色不變、寫 active admin_link（otp 欄位 NULL）',
    alT?.ok && roleOf(uAlTeacher) === 'teacher' && alTAct?.status === 'active' && alTAct.claim_method === 'admin_link'
    && alTAct.otp_challenge_id === null && alTAct.activated_at && alTAct.instructor_id === alTeacherInstructor, { alT, alTAct });
  call(admin, `public.admin_confirm_instructor_email(${ulit(alTeacherInstructor)}, 'al-teacher@t.test', 'Email 確認')`);
  check('已是 teacher 的手動綁定帳號可直接要簽約碼（帳號有效）', requestOtp(uAlTeacher, 'contract_sign')?.status === 'sent');

  // mentor：staff 免啟用紀錄
  // repo 的 setup.sql 建 users.role CHECK 時只有 pending/teacher/admin，但整個應用（RLS、前端）都在用 mentor；
  // 只在這個暫時資料庫把 CHECK 補上 mentor 來測 staff 規則（不改 repo SQL）。
  su(`ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN ('pending', 'teacher', 'mentor', 'admin'));`);
  const uMentor = createAuthUser('mentor@t.test', '輔導員');
  su(`UPDATE public.users SET role = 'mentor' WHERE id = ${lit(uMentor)}`);
  const mentorInstructor = makeInstructor('輔導員本人', 'mentor-old@t.test', { phone: '0944000444', idNumber: 'E123450004' });
  const alM = exec(admin, linkSql(mentorInstructor, uMentor));
  check('mentor 手動綁定：角色維持 mentor、不寫啟用紀錄', alM?.ok && roleOf(uMentor) === 'mentor' && (activationsOf(uMentor) || []).length === 0, alM);
  call(admin, `public.admin_confirm_instructor_email(${ulit(mentorInstructor)}, 'mentor@t.test', 'Email 確認')`);
  check('mentor 手動綁定後可要簽約碼（staff 免啟用，仍須綁主檔＋已確認 Email）', requestOtp(uMentor, 'contract_sign')?.status === 'sent');

  // 停用主檔：只綁定
  const frozenInstructor = makeInstructor('停用老師', 'fz-old@t.test', { phone: '0944000555', idNumber: 'E123450005' });
  su(`UPDATE public.instructors SET employment_status = 'frozen' WHERE id = ${lit(frozenInstructor)}`);
  const uFrozen = createAuthUser('fz@t.test', '停用老師');
  const alF = exec(admin, linkSql(frozenInstructor, uFrozen));
  check('停用主檔手動綁定：只綁定、維持 pending、不寫啟用紀錄',
    alF?.ok && instructorOf(uFrozen)?.id === frozenInstructor && roleOf(uFrozen) === 'pending' && (activationsOf(uFrozen) || []).length === 0, alF);
  const alMissing = exec(admin, linkSql(randomUUID(), uFrozen));
  check('admin_link_instructor：主檔不存在 → INSTRUCTOR_NOT_FOUND', alMissing?.ok === false && alMissing.message === 'INSTRUCTOR_NOT_FOUND', alMissing);

  // ════════════════════════════════════════════════════════════════
  // 上線前審查 必修 1（2026-10-22）：回填之後才出現的「沒有任何啟用紀錄的 teacher」不能被簽約卡死。
  // 他們不會有啟用卡（get_my_activation_status = none）、也要不到啟用碼（no_pending_activation），
  // 所以簽約資格只擋「有啟用紀錄但沒有 active」的人（只綁不開通的 pending 仍須本人啟用）。
  group('legacy teachers without activation records (必修 1)');
  const signingActive = (uid) => suVal(`SELECT COALESCE(s.is_active, false) FROM private.signing_account_state(${lit(uid)}) s`) === 't';
  const selfCreateInstructorSql = (name, email, phone, idNumber) => `INSERT INTO public.instructors (
      user_id, full_name, nickname, gender, birth_date, id_number, phone_mobile, line_id, address, household_address, email_primary,
      teaching_freq_semester, teaching_freq_vacation, teaching_regions, bio_notes, bank_account_name, bank_name, bank_branch,
      bank_account_number, bank_code, id_front_path, id_back_path, bankbook_path)
    VALUES (auth.uid(), ${lit(name)}, ${lit(name + '暱稱')}, '女', '1992-02-02', ${lit(idNumber)}, ${lit(phone)}, ${lit('line-' + phone)},
      '新北市', '新北市', ${lit(email)}, '每週 1 次', '每週 2 次', ARRAY['新北市']::public.tw_county[], '自建', ${lit(name)}, '銀行', '分行',
      '2222222222', '0000002', 'instructors/' || auth.uid() || '/f.png', 'instructors/' || auth.uid() || '/b.png', 'instructors/' || auth.uid() || '/k.png')`;

  // T-legacy-1：回填之後才出現、role 已是 teacher、還沒有主檔 → 在 /profile 第一次存檔自建主檔
  const uLate = createAuthUser('late-teacher@t.test', '晚建檔老師');
  su(`UPDATE public.users SET role = 'teacher' WHERE id = ${lit(uLate)}`);
  const lateIns = exec(uLate, selfCreateInstructorSql('晚建檔老師', 'late-teacher@t.test', '0966000111', 'F223450001'));
  check('T-legacy-1 前提：teacher 自建主檔成功、完全沒有啟用紀錄、get_my_activation_status = none',
    lateIns?.ok && lateIns.rows === 1 && (activationsOf(uLate) || []).length === 0
    && call(uLate, 'public.get_my_activation_status()').result?.status === 'none', { lateIns, acts: activationsOf(uLate) });
  check('T-legacy-1 signing_account_state.is_active = true（無啟用紀錄的 teacher 視為 legacy）', signingActive(uLate),
    suJson(`SELECT to_jsonb(s) FROM private.signing_account_state(${lit(uLate)}) s`));
  check('T-legacy-1 行政確認 Email 前 → no_confirmed_email（走既有待行政確認路徑，不是 account_not_active）',
    requestOtp(uLate, 'contract_sign')?.status === 'no_confirmed_email');
  const lateInstructor = instructorOf(uLate);
  call(admin, `public.admin_confirm_instructor_email(${ulit(lateInstructor.id)}, 'late-teacher@t.test', 'Email 確認')`);
  const lateOtp = requestOtp(uLate, 'contract_sign');
  check('T-legacy-1 行政確認 Email 後可要簽約碼（sent，不再回 account_not_active）', lateOtp?.status === 'sent', lateOtp);
  const lateVerify = lateOtp?.challenge_id ? verifyOtp(uLate, lateOtp.challenge_id, codeOf(lateOtp.challenge_id)) : null;
  check('T-legacy-1 簽約碼可驗證（verified）', lateVerify?.status === 'verified', lateVerify);
  const lateConsent = recordConsent(uLate, 'agree_electronic', { rules: 1, contract: 1 });
  check('T-legacy-1 可記錄電子簽約同意（不再 ACCOUNT_NOT_ACTIVE）', lateConsent?.result?.status === 'recorded', lateConsent);

  // T-legacy-1b：新進講師自建主檔後，被行政用角色下拉直接改成 teacher（沒走核准 RPC，所以沒有啟用紀錄）
  const uDropdown = createAuthUser('dropdown@t.test', '下拉改角色');
  const ddIns = exec(uDropdown, selfCreateInstructorSql('下拉改角色', 'dropdown@t.test', '0966000222', 'F223450002'));
  const ddRole = exec(admin, `UPDATE public.users SET role = 'teacher' WHERE id = ${lit(uDropdown)}`);
  if (!(ddRole?.ok && ddRole.rows === 1)) su(`UPDATE public.users SET role = 'teacher' WHERE id = ${lit(uDropdown)}`);
  check('T-legacy-1b 角色下拉改成 teacher、沒有啟用紀錄 → signing_account_state.is_active = true',
    ddIns?.ok && roleOf(uDropdown) === 'teacher' && (activationsOf(uDropdown) || []).length === 0 && signingActive(uDropdown), { ddIns, ddRole });

  // T-legacy-2：teacher 但有一筆 pending 啟用紀錄（只綁不開通）→ 仍擋
  const uPendTeacher = createAuthUser('pend-teacher@t.test', '只綁不開通');
  const pendTeacherInstructor = makeInstructor('只綁不開通', 'pend-teacher@t.test', { phone: '0966000333', idNumber: 'F223450003', userId: uPendTeacher });
  su(`SELECT private.open_pending_activation(${lit(uPendTeacher)}, ${lit(pendTeacherInstructor)}, 'name_slot')`);
  su(`UPDATE public.users SET role = 'teacher' WHERE id = ${lit(uPendTeacher)}`);
  call(admin, `public.admin_confirm_instructor_email(${ulit(pendTeacherInstructor)}, 'pend-teacher@t.test', 'Email 確認')`);
  const ptReq = requestOtp(uPendTeacher, 'contract_sign');
  check('T-legacy-2 teacher＋pending 啟用紀錄 → is_active = false、要簽約碼仍回 account_not_active',
    openActivation(uPendTeacher)?.status === 'pending' && !signingActive(uPendTeacher)
    && ptReq?.status === 'not_allowed' && ptReq.reason === 'account_not_active', { ptReq, acts: activationsOf(uPendTeacher) });
  check('T-legacy-2 記同意仍 ACCOUNT_NOT_ACTIVE', errOf(recordConsent(uPendTeacher, 'agree_electronic', { rules: 1, contract: 1 })) === 'ACCOUNT_NOT_ACTIVE');

  // T-legacy-3：teacher＋active 啟用紀錄 → 放行（既有行為不變）
  check('T-legacy-3 teacher＋active（legacy_pre_activation／admin_link）→ is_active = true',
    openActivation(legacyTeacher)?.status === 'active' && signingActive(legacyTeacher)
    && openActivation(uAlTeacher)?.status === 'active' && signingActive(uAlTeacher));

  // T-legacy-4：只剩 revoked 紀錄（主檔被解除綁定過）→ 依規則仍擋（有紀錄但沒有 active）
  const uRevoked = createAuthUser('revoked-teacher@t.test', '解綁過');
  const revokedInstructor = makeInstructor('解綁過', 'revoked-teacher@t.test', { phone: '0966000444', idNumber: 'F223450004', userId: uRevoked });
  su(`UPDATE public.users SET role = 'teacher' WHERE id = ${lit(uRevoked)}`);
  su(`SELECT private.open_pending_activation(${lit(uRevoked)}, ${lit(revokedInstructor)}, 'admin_link')`);
  su(`UPDATE public.instructors SET user_id = NULL WHERE id = ${lit(revokedInstructor)}`);
  su(`UPDATE public.instructors SET user_id = ${lit(uRevoked)} WHERE id = ${lit(revokedInstructor)}`);
  check('T-legacy-4 teacher 只剩 revoked 紀錄 → is_active = false（有紀錄但沒有 active 一律擋）',
    (activationsOf(uRevoked) || []).every((a) => a.status === 'revoked') && (activationsOf(uRevoked) || []).length === 1 && !signingActive(uRevoked),
    activationsOf(uRevoked));

  // ════════════════════════════════════════════════════════════════
  group('OTP rules');
  check('Email 對應帳號沒有已確認 Email（新主檔未回填）→ no_confirmed_email', requestOtp(uEmail, 'account_activation')?.status === 'no_confirmed_email');
  call(admin, `public.admin_confirm_instructor_email(${ulit(emailInstructor)}, 'em@t.test', '電話確認')`);
  const emStatus = call(uEmail, 'public.get_my_activation_status()').result;
  check('admin 確認後：has_confirmed_email=true、masked_email=e***@t.test（本機名只有 2 字只露 1 字）、profile_complete=true',
    emStatus.has_confirmed_email === true && emStatus.masked_email === 'e***@t.test' && emStatus.profile_complete === true && emStatus.status === 'pending', emStatus);
  check('遮罩格式：abcdef@gmail.com → ab***@gmail.com', suVal(`SELECT private.mask_email('abcdef@gmail.com')`) === 'ab***@gmail.com');
  check('目的代碼錯 → not_allowed', requestOtp(uEmail, 'whatever')?.status === 'not_allowed');
  check('已是 teacher（legacy、無 pending）要啟用碼 → not_allowed（already_active）',
    (() => { const r = requestOtp(legacyTeacher, 'account_activation'); return r?.status === 'not_allowed' && r.reason === 'already_active'; })());

  const reqCount0 = Number(suVal(`SELECT count(*) FROM net._e2e_http_requests`));
  const c1 = requestOtp(uEmail, 'account_activation');
  const c1Row = suJson(`SELECT to_jsonb(c) FROM private.email_otp_challenges c WHERE id = ${ulit(c1.challenge_id)}`);
  const expiresDelta = Number(suVal(`SELECT extract(epoch FROM (${lit(c1.expires_at)}::timestamptz - now()))`));
  check('request_email_otp → sent（challenge_id、expires_at≈5 分、masked_email、resend_after_seconds:60）',
    c1.status === 'sent' && c1.challenge_id && c1.masked_email === 'e***@t.test' && c1.resend_after_seconds === 60 && expiresDelta > 280 && expiresDelta <= 300, { c1, expiresDelta });
  const code1 = codeOf(c1.challenge_id);
  check('驗證碼是 6 位數字', /^[0-9]{6}$/.test(code1), code1);
  check('challenge 只存 salt＋SHA-256：code_hash = sha256(salt:code)、沒有明碼欄位',
    c1Row.code_hash === sha(`${c1Row.salt}:${code1}`) && !Object.keys(c1Row).some((k) => /^code$|plain/.test(k)) && c1Row.max_attempts === 5, c1Row);
  // 全庫掃描：public／private／auth／storage 所有文字欄位都不得出現明碼（net 是 pg_net 替身佇列，正式環境為 pg_net 暫存，見回報）
  const scanFor = (needle) => suVal(`
    DO $$
    DECLARE r record; n bigint; total bigint := 0;
    BEGIN
      FOR r IN SELECT c.table_schema, c.table_name, c.column_name
                 FROM information_schema.columns c
                 JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
                WHERE c.table_schema IN ('public', 'private', 'auth', 'storage')
                  AND c.data_type IN ('text', 'character varying', 'jsonb', 'json')
      LOOP
        EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I::text ~ %L', r.table_schema, r.table_name, r.column_name, '(^|[^0-9a-z.@])${needle}([^0-9a-z.@]|$)') INTO n;
        total := total + n;
        IF n > 0 THEN RAISE NOTICE 'leak in %.%.%', r.table_schema, r.table_name, r.column_name; END IF;
      END LOOP;
      PERFORM set_config('t.leaks', total::text, false);
    END $$;
    SELECT current_setting('t.leaks');`);
  const leaks = scanFor(code1);
  const control = scanFor('em@t\\.test');
  check('資料庫（public／private／auth／storage 所有文字欄）查不到驗證碼明碼（對照組：同一掃描找得到 em@t.test）', leaks === '0' && Number(control) > 0, { leaks, control });
  const req1 = suJson(`SELECT to_jsonb(r) FROM net._e2e_http_requests r ORDER BY id DESC LIMIT 1`);
  check('寄信：有設定時呼叫 net.http_post（Resend API、Bearer vault 金鑰、from＝vault resend_from、to＝已確認 Email）',
    Number(suVal(`SELECT count(*) FROM net._e2e_http_requests`)) === reqCount0 + 1
    && req1.url === 'https://api.resend.com/emails' && req1.headers.Authorization === `Bearer ${RESEND_KEY}`
    && req1.body.from === RESEND_FROM && JSON.stringify(req1.body.to) === '["em@t.test"]', req1);
  check('OTP 信：主旨「夢想一號講師資源站驗證碼」、內文含 6 碼、5 分鐘有效、「若非本人操作請忽略並通知行政」',
    req1.body.subject === '夢想一號講師資源站驗證碼' && req1.body.text.includes(code1) && req1.body.text.includes('5 分鐘')
    && req1.body.text.includes('若非本人操作請忽略並通知行政') && req1.body.html.includes(code1), req1.body);
  const log1 = suJson(`SELECT to_jsonb(l) FROM public.email_delivery_log l WHERE id = (SELECT delivery_id FROM private.email_otp_challenges WHERE id = ${ulit(c1.challenge_id)})`);
  check('email_delivery_log：otp_activation／queued／net_request_id／subject，且紀錄裡沒有驗證碼',
    log1.kind === 'otp_activation' && log1.status === 'queued' && log1.net_request_id === req1.id && log1.to_email === 'em@t.test'
    && log1.subject === '夢想一號講師資源站驗證碼' && !JSON.stringify(log1).includes(code1), log1);

  const cool = requestOtp(uEmail, 'account_activation');
  check('60 秒內重寄 → cooldown（retry_after_seconds 1～60）', cool.status === 'cooldown' && cool.retry_after_seconds >= 1 && cool.retry_after_seconds <= 60, cool);
  check('cooldown 一併帶回本人剛寄出、仍有效的 challenge（challenge_id／expires_at／masked_email，可繼續輸入同一組碼）',
    cool.challenge_id === c1.challenge_id && cool.expires_at === c1.expires_at && cool.masked_email === 'e***@t.test', cool);
  check('cooldown 不會另外產生新 challenge 或寄信', suVal(`SELECT count(*) FROM private.email_otp_challenges WHERE user_id = ${lit(uEmail)}`) === '1'
    && Number(suVal(`SELECT count(*) FROM net._e2e_http_requests`)) === reqCount0 + 1);

  const wrong = code1 === '000000' ? '111111' : '000000';
  const w1 = verifyOtp(uEmail, c1.challenge_id, wrong);
  const w2 = verifyOtp(uEmail, c1.challenge_id, 'abc');
  const w3 = verifyOtp(uEmail, c1.challenge_id, wrong);
  const w4 = verifyOtp(uEmail, c1.challenge_id, wrong);
  check('錯碼 → invalid，attempts_remaining 4／3／2／1（格式錯也算一次）',
    [w1, w2, w3, w4].map((x) => `${x.status}:${x.attempts_remaining}`).join(',') === 'invalid:4,invalid:3,invalid:2,invalid:1', [w1, w2, w3, w4]);
  const w5 = verifyOtp(uEmail, c1.challenge_id, wrong);
  check('第 5 次錯 → locked', w5.status === 'locked', w5);
  check('鎖住後輸入正確碼仍是 locked', verifyOtp(uEmail, c1.challenge_id, code1).status === 'locked');
  su(`UPDATE private.email_otp_challenges SET created_at = now() - interval '10 seconds' WHERE id = ${ulit(c1.challenge_id)}`);
  const coolLocked = requestOtp(uEmail, 'account_activation');
  check('cooldown 時若唯一的 challenge 已鎖 → 只回 retry_after_seconds，不帶 challenge',
    coolLocked.status === 'cooldown' && coolLocked.retry_after_seconds > 0 && !('challenge_id' in coolLocked) && !('masked_email' in coolLocked), coolLocked);

  su(`UPDATE private.email_otp_challenges SET created_at = created_at - interval '61 seconds' WHERE user_id = ${lit(uEmail)}`);
  const c2 = requestOtp(uEmail, 'account_activation');
  check('冷卻過後可再寄 → sent', c2.status === 'sent', c2);
  const c1After = suJson(`SELECT to_jsonb(c) FROM private.email_otp_challenges c WHERE id = ${ulit(c1.challenge_id)}`);
  check('新寄出後舊 challenge 標 superseded', c1After.superseded_at !== null, c1After);
  check('用舊 challenge 驗證 → superseded', verifyOtp(uEmail, c1.challenge_id, code1).status === 'superseded');
  const code2 = codeOf(c2.challenge_id);
  const impostor = verifyOtp(uPre, c2.challenge_id, code2);
  check('冒用：別人的 challenge_id＋正確碼 → invalid（attempts_remaining 0）', impostor.status === 'invalid' && impostor.attempts_remaining === 0, impostor);
  check('冒用不會累計本人的錯誤次數、也不會驗證成功',
    suVal(`SELECT attempts || '|' || (verified_at IS NULL) FROM private.email_otp_challenges WHERE id = ${ulit(c2.challenge_id)}`) === '0|true' && roleOf(uEmail) === 'pending');
  su(`UPDATE private.email_otp_challenges SET expires_at = now() - interval '1 second' WHERE id = ${ulit(c2.challenge_id)}`);
  check('過期（5 分鐘後）→ expired', verifyOtp(uEmail, c2.challenge_id, code2).status === 'expired');

  const c3 = freshOtp(uEmail, 'account_activation');
  const v3 = verifyOtp(uEmail, c3.id, c3.code);
  check('正確碼 → verified、activated:true', v3.status === 'verified' && v3.activated === true && v3.verified_at, v3);
  check('啟用：users.role pending → teacher', roleOf(uEmail) === 'teacher');
  const actDone = openActivation(uEmail);
  check('啟用紀錄 active，claimed_at／otp_verified_at／activated_at／activation_email／instructor_id／otp_challenge_id 齊全',
    actDone.status === 'active' && actDone.claimed_at && actDone.otp_verified_at && actDone.activated_at
    && actDone.activation_email === 'em@t.test' && actDone.instructor_id === emailInstructor && actDone.otp_challenge_id === c3.id, actDone);
  check('get_my_activation_status → active', call(uEmail, 'public.get_my_activation_status()').result?.status === 'active');
  check('同一碼再驗 → used（只能成功一次）', verifyOtp(uEmail, c3.id, c3.code).status === 'used');

  // 每小時 5 封上限（兩種目的合計）
  call(admin, `public.admin_confirm_instructor_email(${ulit(preInstructor)}, 'pre@t.test', 'Email 確認')`);
  su(`UPDATE private.email_otp_challenges SET created_at = created_at - interval '2 hours' WHERE user_id = ${lit(uPre)}`);
  const sentStatuses = [];
  for (let i = 0; i < 5; i += 1) {
    sentStatuses.push(requestOtp(uPre, 'account_activation').status);
    su(`UPDATE private.email_otp_challenges SET created_at = created_at - interval '61 seconds' WHERE user_id = ${lit(uPre)}`);
  }
  su(`UPDATE private.email_otp_challenges SET created_at = now() - interval '5 seconds' WHERE id = (SELECT id FROM private.email_otp_challenges WHERE user_id = ${lit(uPre)} ORDER BY created_at DESC LIMIT 1)`);
  const preCool = requestOtp(uPre, 'account_activation');
  const preCoolOwner = preCool.challenge_id ? suVal(`SELECT user_id FROM private.email_otp_challenges WHERE id = ${ulit(preCool.challenge_id)}`) : null;
  check('cooldown 只回本人自己的 challenge（另一位講師拿到的是自己的、遮罩是自己的信箱）',
    preCool.status === 'cooldown' && preCoolOwner === uPre && preCool.masked_email === 'pr***@t.test', { preCool, preCoolOwner });
  su(`UPDATE private.email_otp_challenges SET created_at = created_at - interval '61 seconds' WHERE user_id = ${lit(uPre)}`);
  const sixth = requestOtp(uPre, 'account_activation');
  check('一小時內第 1～5 封 sent、第 6 封 rate_limited', sentStatuses.every((s) => s === 'sent') && sixth.status === 'rate_limited', { sentStatuses, sixth });
  const preOtp = freshOtp(uPre, 'account_activation');
  check('超過一小時後恢復可寄', preOtp.sent.status === 'sent');
  check('第二位講師啟用成功（後續簽約用）', verifyOtp(uPre, preOtp.id, preOtp.code).activated === true && roleOf(uPre) === 'teacher');

  // 寄信設定缺少 → not_configured
  call(admin, `public.admin_confirm_instructor_email(${ulit(idInstructor)}, 'idc@t.test', 'Email 確認')`);
  su(`DELETE FROM vault.secrets WHERE name = 'resend_api_key'`);
  const challengesBefore = suVal(`SELECT count(*) FROM private.email_otp_challenges WHERE user_id = ${lit(uId)}`);
  const reqsBefore = suVal(`SELECT count(*) FROM net._e2e_http_requests`);
  const nc = requestOtp(uId, 'account_activation');
  const ncLog = suJson(`SELECT to_jsonb(l) FROM public.email_delivery_log l WHERE related_user_id = ${lit(uId)} ORDER BY requested_at DESC LIMIT 1`);
  check('缺 Vault resend_api_key → request_email_otp 回 email_not_configured（不丟錯）', nc?.status === 'email_not_configured', nc);
  check('缺設定：email_delivery_log 記 not_configured、沒有呼叫 net.http_post、沒有產生驗證碼',
    ncLog?.status === 'not_configured' && ncLog.kind === 'otp_activation' && ncLog.to_email === 'idc@t.test'
    && suVal(`SELECT count(*) FROM net._e2e_http_requests`) === reqsBefore
    && suVal(`SELECT count(*) FROM private.email_otp_challenges WHERE user_id = ${lit(uId)}`) === challengesBefore, ncLog);
  su(`INSERT INTO vault.secrets (name, secret) VALUES ('resend_api_key', ${lit(RESEND_KEY)})`);

  // 寄送狀態回寫（pg_cron 每分鐘跑的函式）
  const logC3 = suJson(`SELECT to_jsonb(l) FROM public.email_delivery_log l WHERE id = (SELECT delivery_id FROM private.email_otp_challenges WHERE id = ${ulit(c3.id)})`);
  su(`INSERT INTO net._http_response (id, status_code, content_type, content) VALUES
      (${logC3.net_request_id}, 200, 'application/json', '{"id":"re_msg_123"}'),
      (${log1.net_request_id}, 422, 'application/json', '{"message":"invalid from"}')`);
  const refreshed = suVal(`SELECT private.refresh_email_delivery_status()`);
  const logC3After = suJson(`SELECT to_jsonb(l) FROM public.email_delivery_log l WHERE id = ${lit(logC3.id)}`);
  const log1After = suJson(`SELECT to_jsonb(l) FROM public.email_delivery_log l WHERE id = ${lit(log1.id)}`);
  check('refresh_email_delivery_status：200 → sent＋provider_message_id；422 → failed＋http_status＋error_text',
    Number(refreshed) >= 2 && logC3After.status === 'sent' && logC3After.provider_message_id === 're_msg_123' && logC3After.http_status === 200
    && log1After.status === 'failed' && log1After.http_status === 422 && log1After.error_text.includes('invalid from'), { refreshed, logC3After, log1After });
  su(`UPDATE public.email_delivery_log SET requested_at = now() - interval '2 hours' WHERE id = ${lit(ncLog.id)}`);
  check('refresh 不動 not_configured 紀錄', suVal(`SELECT private.refresh_email_delivery_status()`) >= '0' && suVal(`SELECT status FROM public.email_delivery_log WHERE id = ${lit(ncLog.id)}`) === 'not_configured');

  // ════════════════════════════════════════════════════════════════
  group('signing');
  su(`
    INSERT INTO public.contract_documents (doc_type, version, file_path, file_name, display_name, doc_mode, sort_order, is_active, content_sha256) VALUES
      ('rules', 1, 'templates/rules/v1.pdf', 'rules.pdf', '講師管理辦法', 'view_only', 1, true, upper(${lit(sha('rules-v1'))})),
      ('contract', 1, 'templates/contract/v1.pdf', 'contract.pdf', '委任契約書', 'fill_sign', 3, true, NULL),
      ('misc', 1, 'templates/misc/v1.pdf', 'misc.pdf', '未使用範本', 'view_only', 9, false, NULL);
    INSERT INTO storage.objects (bucket_id, name) VALUES
      ('contract-documents', 'templates/rules/v1.pdf'),
      ('contract-documents', 'templates/contract/v1.pdf'),
      ('contract-documents', 'templates/misc/v1.pdf'),
      ('contract-documents', 'signed/${uEmail}/signature_1.png'),
      ('contract-documents', 'signed/${uEmail}/contract_1.pdf'),
      ('contract-documents', 'signed/${uEmail}/contract_2.pdf'),
      ('contract-documents', 'signed/${uPre}/signature_1.png'),
      ('contract-documents', 'signed/${uPre}/contract_1.pdf');
  `);
  check('範本雜湊寫入時正規化成小寫', suVal(`SELECT content_sha256 FROM public.contract_documents WHERE doc_type = 'rules'`) === sha('rules-v1'));
  const V = { rules: 1, contract: 1 };
  const SIG = `signed/${uEmail}/signature_1.png`;
  const PDF1 = { contract: `signed/${uEmail}/contract_1.pdf` };
  const DOCH = { rules: sha('rules-v1'), contract: sha('contract-v1') };
  const PDFH1 = { contract: sha('signed-contract-1').toUpperCase() };
  const base = { sig: SIG, pdfs: PDF1, versions: V, docHash: DOCH, pdfHash: PDFH1 };
  const submit = (uid, args, opts) => call(uid, submitExpr({ ...base, ...args }), opts);

  // 同意紀錄
  const consentHeaders = { 'x-forwarded-for': '198.51.100.7, 10.0.0.1', 'user-agent': 'ConsentAgent/1.0' };
  const consentOk = recordConsent(uEmail, 'agree_electronic', V, 'esign-consent-v1', consentHeaders);
  check('record_contract_consent(agree) → recorded／consent_id／created_at', consentOk.result?.status === 'recorded' && consentOk.result.consent_id && consentOk.result.created_at, consentOk);
  const consentRow = suJson(`SELECT to_jsonb(r) FROM public.contract_consent_records r WHERE id = ${ulit(consentOk.result.consent_id)}`);
  check('同意紀錄存「實際顯示的全文」：代碼 esign-consent-v1、文件清單與遮罩信箱已代入、無殘留佔位符',
    consentRow.consent_text_version === 'esign-consent-v1' && consentRow.consent_text.includes('講師管理辦法（第 1 版）、委任契約書（第 1 版）')
    && consentRow.consent_text.includes('（e***@t.test）') && !consentRow.consent_text.includes('{{') && consentRow.consent_text.includes(COMPANY), consentRow.consent_text);
  check('同意紀錄：IP 取 x-forwarded-for 第一段、UA 取 header、doc_versions、instructor_id',
    consentRow.ip_address === '198.51.100.7' && consentRow.user_agent === 'ConsentAgent/1.0' && JSON.stringify(consentRow.doc_versions) === JSON.stringify(V)
    && consentRow.instructor_id === emailInstructor, consentRow);
  const privacySeed = suVal(`SELECT content FROM public.esign_text_versions WHERE version_code = 'esign-privacy-notice-v1'`);
  const privacyLegal = legalQuoteLines('esign-privacy-notice-v1');
  check('同意紀錄同時存同頁顯示的個資告知：privacy_notice_version＝esign-privacy-notice-v1、privacy_notice_text＝全文（逐句等於法規 §5-d）',
    consentRow.privacy_notice_version === 'esign-privacy-notice-v1' && consentRow.privacy_notice_text === privacySeed
    && privacyLegal.length >= 10 && privacyLegal.every((line) => consentRow.privacy_notice_text.includes(line)), consentRow.privacy_notice_text);
  check('不存在的文案代碼 → CONSENT_TEXT_UNKNOWN', errOf(recordConsent(uEmail, 'agree_electronic', V, 'esign-consent-v9')) === 'CONSENT_TEXT_UNKNOWN');
  check('決定值錯 → INVALID_INPUT', errOf(recordConsent(uEmail, 'maybe', V)) === 'INVALID_INPUT');
  check('pending（未啟用）帳號記同意 → ACCOUNT_NOT_ACTIVE', errOf(recordConsent(uSlot, 'agree_electronic', V)) === 'ACCOUNT_NOT_ACTIVE');

  // 簽約 OTP 信
  const k1 = freshOtp(uEmail, 'contract_sign');
  const k1Req = suJson(`SELECT to_jsonb(r) FROM net._e2e_http_requests r ORDER BY id DESC LIMIT 1`);
  const otpLegal = legalQuoteLines('esign-otp-email-v1');
  check('簽約驗證碼信：otp_contract、加上法規 §5-f 說明句', k1Req.body.text.includes(k1.code) && otpLegal.length === 1 && k1Req.body.text.includes(otpLegal[0])
    && suVal(`SELECT kind FROM public.email_delivery_log WHERE id = (SELECT delivery_id FROM private.email_otp_challenges WHERE id = ${ulit(k1.id)})`) === 'otp_contract', { otpLegal, text: k1Req.body.text });
  check('pending 帳號要簽約碼 → not_allowed', requestOtp(uSlot, 'contract_sign')?.status === 'not_allowed');

  // CONSENT_REQUIRED
  check('沒有同意 → CONSENT_REQUIRED', errOf(submit(uEmail, { otp: k1.id, consent: null })) === 'CONSENT_REQUIRED');
  check('同意 id 不存在 → CONSENT_REQUIRED', errOf(submit(uEmail, { otp: k1.id, consent: randomUUID() })) === 'CONSENT_REQUIRED');
  const declineForSubmit = recordConsent(uEmail, 'decline_electronic', V, 'esign-decline-paper-v1').result.consent_id;
  check('用「不同意」紀錄送出 → CONSENT_REQUIRED', errOf(submit(uEmail, { otp: k1.id, consent: declineForSubmit })) === 'CONSENT_REQUIRED');
  const consentOtherVersions = recordConsent(uEmail, 'agree_electronic', { rules: 1, contract: 1, extra: 1 }).result.consent_id;
  check('同意的 doc_versions 與送出不一致 → CONSENT_REQUIRED', errOf(submit(uEmail, { otp: k1.id, consent: consentOtherVersions })) === 'CONSENT_REQUIRED');
  const consentOld = recordConsent(uEmail, 'agree_electronic', V).result.consent_id;
  su(`SET session_replication_role = replica; UPDATE public.contract_consent_records SET created_at = now() - interval '2 hours 1 minute' WHERE id = ${ulit(consentOld)}; RESET session_replication_role;`);
  check('同意超過 2 小時 → CONSENT_REQUIRED', errOf(submit(uEmail, { otp: k1.id, consent: consentOld })) === 'CONSENT_REQUIRED');
  const consentOfOther = recordConsent(uPre, 'agree_electronic', V).result.consent_id;
  check('拿別人的同意紀錄 → CONSENT_REQUIRED', errOf(submit(uEmail, { otp: k1.id, consent: consentOfOther })) === 'CONSENT_REQUIRED');

  // OTP
  const consentId = consentOk.result.consent_id;
  check('沒有 OTP → OTP_REQUIRED', errOf(submit(uEmail, { otp: null, consent: consentId })) === 'OTP_REQUIRED');
  check('OTP 尚未驗證 → OTP_REQUIRED', errOf(submit(uEmail, { otp: k1.id, consent: consentId })) === 'OTP_REQUIRED');
  const k1Cool = requestOtp(uEmail, 'contract_sign');
  check('簽約用途 cooldown 帶回的是同一用途（contract_sign）最新一筆，不是啟用用途的 challenge',
    k1Cool.status === 'cooldown' && k1Cool.challenge_id === k1.id, k1Cool);
  check('拿啟用用途的 challenge 簽約 → OTP_REQUIRED', errOf(submit(uEmail, { otp: c3.id, consent: consentId })) === 'OTP_REQUIRED');
  const preK = verifiedContractOtp(uPre);
  check('拿別人的（已驗證）簽約 challenge → OTP_REQUIRED', errOf(submit(uEmail, { otp: preK, consent: consentId })) === 'OTP_REQUIRED');
  check('簽約碼驗證 → verified、activated:false', JSON.stringify(Object.keys(verifyOtp(uEmail, k1.id, k1.code)).sort()) === JSON.stringify(['activated', 'status', 'verified_at'])
    && suVal(`SELECT verified_at IS NOT NULL AND consumed_at IS NULL FROM private.email_otp_challenges WHERE id = ${ulit(k1.id)}`) === 't');
  const k1CoolVerified = requestOtp(uEmail, 'contract_sign');
  check('challenge 已驗證後的 cooldown 不再帶回它', k1CoolVerified.status === 'cooldown' && !('challenge_id' in k1CoolVerified), k1CoolVerified);
  su(`UPDATE private.email_otp_challenges SET verified_at = now() - interval '16 minutes' WHERE id = ${ulit(k1.id)}`);
  check('OTP 驗證超過 15 分鐘 → OTP_EXPIRED', errOf(submit(uEmail, { otp: k1.id, consent: consentId })) === 'OTP_EXPIRED');
  su(`UPDATE private.email_otp_challenges SET verified_at = now() - interval '14 minutes' WHERE id = ${ulit(k1.id)}`);

  // 雜湊
  check('範本雜湊格式錯 → INVALID_HASH', errOf(submit(uEmail, { otp: k1.id, consent: consentId, docHash: { rules: 'xyz', contract: DOCH.contract } })) === 'INVALID_HASH');
  check('範本雜湊少一份文件 → INVALID_HASH', errOf(submit(uEmail, { otp: k1.id, consent: consentId, docHash: { rules: DOCH.rules } })) === 'INVALID_HASH');
  check('範本雜湊多一個鍵 → INVALID_HASH', errOf(submit(uEmail, { otp: k1.id, consent: consentId, docHash: { ...DOCH, other: DOCH.rules } })) === 'INVALID_HASH');
  check('成品雜湊沒給 → INVALID_HASH', errOf(submit(uEmail, { otp: k1.id, consent: consentId, pdfHash: null })) === 'INVALID_HASH');
  check('範本雜湊與登錄值不符 → DOC_HASH_MISMATCH', errOf(submit(uEmail, { otp: k1.id, consent: consentId, docHash: { rules: sha('tampered'), contract: DOCH.contract } })) === 'DOC_HASH_MISMATCH');
  const consentWrongVersion = recordConsent(uEmail, 'agree_electronic', { rules: 1, contract: 2 }).result.consent_id;
  check('文件版本不是目前啟用版本 → DOC_VERSION_MISMATCH', errOf(submit(uEmail, { otp: k1.id, consent: consentWrongVersion, versions: { rules: 1, contract: 2 } })) === 'DOC_VERSION_MISMATCH');
  check('檔案路徑不在自己 signed/<uid>/ → FILE_NOT_UPLOADED', errOf(submit(uEmail, { otp: k1.id, consent: consentId, sig: `signed/${uPre}/signature_1.png` })) === 'FILE_NOT_UPLOADED');
  check('所有拒絕案都沒有消耗 OTP、沒有留下契約或證據',
    suVal(`SELECT consumed_at IS NULL FROM private.email_otp_challenges WHERE id = ${ulit(k1.id)}`) === 't'
    && suVal(`SELECT count(*) FROM public.instructor_contracts`) === '0' && suVal(`SELECT count(*) FROM public.contract_signing_evidence`) === '0');

  // 成功
  const before = suVal(`SELECT now()`);
  const signHeaders = { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1', 'user-agent': 'Mozilla/5.0 TestSigner' };
  const ok1 = submit(uEmail, { otp: k1.id, consent: consentId }, { headers: signHeaders });
  const after = suVal(`SELECT now()`);
  check('成功 → {status:signed, contract_id, signed_at, evidence_id, copy_email_masked}',
    ok1.ok && ok1.result.status === 'signed' && ok1.result.contract_id && ok1.result.evidence_id && ok1.result.signed_at && ok1.result.copy_email_masked === 'e***@t.test', ok1);
  const contract1 = suJson(`SELECT to_jsonb(c) FROM public.instructor_contracts c WHERE id = ${ulit(ok1.result.contract_id)}`);
  const k1Row = suJson(`SELECT to_jsonb(c) FROM private.email_otp_challenges c WHERE id = ${ulit(k1.id)}`);
  check('instructor_contracts 欄位齊全（instructor_id、bound_email、consent_id、otp_challenge_id、otp_verified_at、雜湊 map 小寫、evidence_id）',
    contract1.status === 'signed' && contract1.instructor_id === emailInstructor && contract1.bound_email === 'em@t.test'
    && contract1.consent_id === consentId && contract1.otp_challenge_id === k1.id && contract1.otp_verified_at === k1Row.verified_at
    && JSON.stringify(contract1.document_sha256) === JSON.stringify(DOCH) && contract1.signed_pdf_sha256.contract === PDFH1.contract.toLowerCase()
    && contract1.evidence_id === ok1.result.evidence_id && contract1.verify_method === 'email_otp', contract1);
  check('IP 取 cf-connecting-ip、UA 取 header（前端參數只當後備）', contract1.ip_address === '203.0.113.9' && contract1.user_agent === 'Mozilla/5.0 TestSigner', contract1);
  check('簽署時間是伺服器時間（在呼叫前後兩個 now() 之間）',
    suVal(`SELECT ${lit(contract1.signed_at)}::timestamptz BETWEEN ${lit(before)}::timestamptz AND ${lit(after)}::timestamptz`) === 't', { before, signed: contract1.signed_at, after });
  check('OTP 已消耗（consumed_at）', k1Row.consumed_at !== null);
  const ev1 = suJson(`SELECT to_jsonb(e) FROM public.contract_signing_evidence e WHERE id = ${ulit(ok1.result.evidence_id)}`);
  check('contract_signing_evidence 欄位齊全（第一筆 chain_seq=1、previous NULL）',
    ev1.contract_id === contract1.id && ev1.user_id === uEmail && ev1.instructor_id === emailInstructor && ev1.bound_email === 'em@t.test'
    && JSON.stringify(ev1.doc_versions) === JSON.stringify(V) && JSON.stringify(ev1.document_sha256) === JSON.stringify(DOCH)
    && JSON.stringify(ev1.signed_pdf_paths) === JSON.stringify(PDF1) && ev1.signed_pdf_sha256.contract === PDFH1.contract.toLowerCase()
    && ev1.consent_id === consentId && ev1.consent_at === consentRow.created_at && ev1.otp_challenge_id === k1.id && ev1.otp_verified_at === k1Row.verified_at
    && ev1.signed_at === contract1.signed_at && ev1.ip_address === '203.0.113.9' && ev1.user_agent === 'Mozilla/5.0 TestSigner'
    && ev1.chain_seq === 1 && ev1.previous_evidence_sha256 === null && /^[0-9a-f]{64}$/.test(ev1.evidence_sha256) && ev1.signature_path === SIG, ev1);
  const copyLog = suJson(`SELECT to_jsonb(l) FROM public.email_delivery_log l WHERE related_contract_id = ${ulit(contract1.id)}`);
  const copyReq = suJson(`SELECT to_jsonb(r) FROM net._e2e_http_requests r WHERE id = ${copyLog?.net_request_id ?? 0}`);
  check('簽署完成信排入寄送（contract_signed_copy／queued／寄到綁定信箱）',
    copyLog?.kind === 'contract_signed_copy' && copyLog.status === 'queued' && copyLog.to_email === 'em@t.test' && copyReq?.body?.to?.[0] === 'em@t.test', copyLog);
  const signedAtTaipei = suVal(`SELECT to_char(${lit(contract1.signed_at)}::timestamptz AT TIME ZONE 'Asia/Taipei', 'YYYY-MM-DD HH24:MI') || '（台北時間）'`);
  const downloadUrl = `https://dream-one-teacher.zeabur.app/contract/view/${contract1.id}`;
  const signedLegal = legalQuoteLines('esign-signed-email-v1').map((line) => line
    .replaceAll('{{instructor_name}}', '王小明').replaceAll('{{signed_at_taipei}}', signedAtTaipei)
    .replaceAll('{{doc_list}}', '講師管理辦法（第 1 版）、委任契約書（第 1 版）').replaceAll('{{contract_ref}}', contract1.id.slice(0, 8))
    .replaceAll('{{download_url}}', downloadUrl));
  const missingSigned = signedLegal.filter((line) => !copyReq.body.text.includes(line));
  check(`簽署完成信內文逐句照抄法規 §5-e（${signedLegal.length} 句，含台北時間、文件版本、下載網址）`, signedLegal.length >= 10 && missingSigned.length === 0, missingSigned);
  check('簽署完成信主旨照 §5-e、HTML 有下載連結、紀錄不存內文',
    copyReq.body.subject === '【夢想一號】講師合作契約簽署完成通知' && copyReq.body.html.includes(`href="${downloadUrl}"`)
    && copyLog.subject === '【夢想一號】講師合作契約簽署完成通知' && !JSON.stringify(copyLog).includes('保存期間'), copyReq.body.subject);

  check('同一 challenge 第二次送出 → OTP_ALREADY_USED', errOf(submit(uEmail, { otp: k1.id, consent: consentId })) === 'OTP_ALREADY_USED');

  // 重簽：舊約 voided＋superseded_by、證據鏈相接
  const k2 = verifiedContractOtp(uEmail);
  const consent2 = recordConsent(uEmail, 'agree_electronic', V).result.consent_id;
  const ok2 = submit(uEmail, { otp: k2, consent: consent2, pdfs: { contract: `signed/${uEmail}/contract_2.pdf` }, pdfHash: { contract: sha('signed-contract-2') } },
    { headers: { 'x-forwarded-for': '192.0.2.44, 10.1.1.1' } });
  check('重簽成功', ok2.ok && ok2.result.status === 'signed', ok2);
  const old1 = suJson(`SELECT to_jsonb(c) FROM public.instructor_contracts c WHERE id = ${ulit(contract1.id)}`);
  check('重簽後舊約 voided，voided_at／voided_reason／superseded_by＝新約',
    old1.status === 'voided' && old1.voided_at && old1.voided_reason === 'superseded_by_new_signature' && old1.superseded_by === ok2.result.contract_id, old1);
  check('舊約其他欄位沒有被改（ip／簽署時間／雜湊）', old1.ip_address === contract1.ip_address && old1.signed_at === contract1.signed_at && JSON.stringify(old1.document_sha256) === JSON.stringify(contract1.document_sha256));
  const ev2 = suJson(`SELECT to_jsonb(e) FROM public.contract_signing_evidence e WHERE id = ${ulit(ok2.result.evidence_id)}`);
  check('證據兩筆、雜湊鏈相接（第二筆 previous＝第一筆 evidence_sha256、chain_seq=2）',
    suVal(`SELECT count(*) FROM public.contract_signing_evidence`) === '2' && ev2.previous_evidence_sha256 === ev1.evidence_sha256 && ev2.chain_seq === 2, ev2);
  check('沒有 cf-connecting-ip 時 IP 取 x-forwarded-for 第一段', suVal(`SELECT ip_address FROM public.instructor_contracts WHERE id = ${ulit(ok2.result.contract_id)}`) === '192.0.2.44');
  check('只剩一份 signed', suVal(`SELECT count(*) FROM public.instructor_contracts WHERE user_id = ${lit(uEmail)} AND status = 'signed'`) === '1');
  check('x-real-ip 是第三順位後備', suVal(`SET request.headers = '{"x-real-ip":"192.0.2.99"}'; SELECT ip_address FROM private.request_client_meta();`) === '192.0.2.99');
  const chainOk = call(admin, 'public.admin_verify_contract_evidence_chain()').result;
  check('admin_verify_contract_evidence_chain → {ok:true, checked:2, first_broken_id:null}', chainOk?.ok === true && chainOk.checked === 2 && chainOk.first_broken_id === null, chainOk);
  check('teacher 呼叫 admin_verify_contract_evidence_chain → 42501', call(uEmail, 'public.admin_verify_contract_evidence_chain()')?.sqlstate === '42501');

  // 不同意電子簽約 → 通知所有 admin
  const notifBefore = Number(suVal(`SELECT count(*) FROM public.notifications WHERE user_id = ${lit(admin)} AND type = 'contract'`));
  const decline = recordConsent(uPre, 'decline_electronic', V, 'esign-decline-paper-v1');
  const notif = suJson(`SELECT to_jsonb(n) FROM public.notifications n WHERE user_id = ${lit(admin)} AND type = 'contract' ORDER BY created_at DESC LIMIT 1`);
  check('decline 紀錄 → recorded，並通知 admin（type contract）',
    decline.result?.status === 'recorded' && Number(suVal(`SELECT count(*) FROM public.notifications WHERE user_id = ${lit(admin)} AND type = 'contract'`)) === notifBefore + 1
    && notif.title === '講師選擇改以紙本簽約' && notif.body.includes('後建檔老師'), notif);
  const declineRow = suJson(`SELECT to_jsonb(r) FROM public.contract_consent_records r WHERE id = ${ulit(decline.result.consent_id)}`);
  check('decline 紀錄存 esign-decline-paper-v1 全文', declineRow.decision === 'decline_electronic' && declineRow.consent_text.startsWith('改以紙本簽約') && declineRow.consent_text.includes('講師管理辦法（第 1 版）'), declineRow.consent_text);
  check('decline 紀錄也存個資告知版本與全文', declineRow.privacy_notice_version === 'esign-privacy-notice-v1' && declineRow.privacy_notice_text === privacySeed, declineRow);
  check('個資告知欄位在 append-only 保護內（admin 改不了）',
    exec(admin, `UPDATE public.contract_consent_records SET privacy_notice_text = 'x' WHERE id = ${ulit(decline.result.consent_id)}`)?.ok === false
    && suExec(`UPDATE public.contract_consent_records SET privacy_notice_text = 'x' WHERE id = ${ulit(decline.result.consent_id)}`)?.message === 'EVIDENCE_IMMUTABLE');

  // 簽署途中契約改版
  const preConsent = recordConsent(uPre, 'agree_electronic', V).result.consent_id;
  const preOtpSign = verifiedContractOtp(uPre);
  const bump1 = exec(admin, `UPDATE public.contract_documents SET is_active = false WHERE doc_type = 'contract' AND version = 1`);
  const bump2 = exec(admin, `INSERT INTO public.contract_documents (doc_type, version, file_path, display_name, doc_mode, sort_order, is_active) VALUES ('contract', 2, 'templates/contract/v2.pdf', '委任契約書', 'fill_sign', 3, true)`);
  check('管理員可停用已被引用的版本並上傳新版（只鎖檔案／版本／雜湊）', bump1?.ok && bump2?.ok, { bump1, bump2 });
  const midway = submit(uPre, { sig: `signed/${uPre}/signature_1.png`, pdfs: { contract: `signed/${uPre}/contract_1.pdf` }, otp: preOtpSign, consent: preConsent, pdfHash: { contract: sha('pre-1') } });
  check('簽署途中契約改版 → DOC_VERSION_MISMATCH（不會簽到舊版）', errOf(midway) === 'DOC_VERSION_MISMATCH', midway);
  check('改版被擋的那次沒有消耗 OTP', suVal(`SELECT consumed_at IS NULL FROM private.email_otp_challenges WHERE id = ${ulit(preOtpSign)}`) === 't');

  // ════════════════════════════════════════════════════════════════
  group('tamper resistance');
  const c2Id = ok2.result.contract_id;
  const ev2Id = ok2.result.evidence_id;
  // 講師
  check('講師 UPDATE 自己的已簽契約 → 0 列', exec(uEmail, `UPDATE public.instructor_contracts SET filled_name = 'x' WHERE user_id = auth.uid()`)?.rows === 0);
  check('講師 DELETE 自己的契約 → 0 列', exec(uEmail, `DELETE FROM public.instructor_contracts WHERE user_id = auth.uid()`)?.rows === 0);
  const tIns = exec(uEmail, `INSERT INTO public.instructor_contracts (user_id, filled_name, filled_instructor_role, filled_id_number, filled_address, filled_phone, signature_path) VALUES (auth.uid(), 'x', 'A', 'A123456789', 'x', 'x', 's.png')`);
  check('講師直接 INSERT 契約 → 被拒（42501）', tIns?.ok === false && tIns.sqlstate === '42501', tIns);
  for (const table of ['contract_signing_evidence', 'contract_consent_records', 'instructor_account_activations']) {
    const u = exec(uEmail, `UPDATE public.${table} SET user_id = user_id WHERE user_id = auth.uid()`);
    const d = exec(uEmail, `DELETE FROM public.${table} WHERE user_id = auth.uid()`);
    check(`講師 UPDATE／DELETE ${table} → 被拒`, u?.ok === false && d?.ok === false, { u, d });
  }
  // admin（PostgREST 身分）
  const aUpd = exec(admin, `UPDATE public.instructor_contracts SET filled_name = '竄改' WHERE id = ${ulit(c2Id)}`);
  check('admin UPDATE 已簽契約內容 → CONTRACT_IMMUTABLE', aUpd?.ok === false && aUpd.message === 'CONTRACT_IMMUTABLE', aUpd);
  const aVoid = exec(admin, `UPDATE public.instructor_contracts SET status = 'voided', voided_at = now(), voided_reason = 'admin' WHERE id = ${ulit(c2Id)}`);
  check('admin 自行 signed→voided（非內部流程）→ CONTRACT_IMMUTABLE', aVoid?.ok === false && aVoid.message === 'CONTRACT_IMMUTABLE', aVoid);
  const aDel = exec(admin, `DELETE FROM public.instructor_contracts WHERE id = ${ulit(contract1.id)}`);
  check('admin DELETE 契約（含已作廢）→ CONTRACT_IMMUTABLE', aDel?.ok === false && aDel.message === 'CONTRACT_IMMUTABLE', aDel);
  const aIns = exec(admin, `INSERT INTO public.instructor_contracts (user_id, filled_name, filled_instructor_role, filled_id_number, filled_address, filled_phone, signature_path) VALUES (${ulit(uPre)}, '偽造', 'A', 'A123456789', 'x', 'x', 's.png')`);
  check('admin 直接 INSERT 偽造契約 → CONTRACT_WRITE_DENIED', aIns?.ok === false && aIns.message === 'CONTRACT_WRITE_DENIED', aIns);
  for (const table of ['contract_signing_evidence', 'contract_consent_records', 'instructor_account_activations']) {
    const u = exec(admin, `UPDATE public.${table} SET user_id = user_id`);
    const d = exec(admin, `DELETE FROM public.${table}`);
    check(`admin UPDATE／DELETE ${table} → 被拒`, u?.ok === false && d?.ok === false, { u, d });
  }
  // service_role（BYPASSRLS）：trigger 仍擋
  const sUpd = exec(null, `UPDATE public.contract_signing_evidence SET ip_address = '6.6.6.6'`, { role: 'service_role' });
  check('service_role UPDATE 證據 → EVIDENCE_IMMUTABLE（RLS 繞過也擋）', sUpd?.ok === false && sUpd.message === 'EVIDENCE_IMMUTABLE', sUpd);
  const sDel = exec(null, `DELETE FROM public.instructor_contracts`, { role: 'service_role' });
  check('service_role DELETE 契約 → CONTRACT_IMMUTABLE', sDel?.ok === false && sDel.message === 'CONTRACT_IMMUTABLE', sDel);
  const sIns = exec(null, `INSERT INTO public.contract_consent_records (user_id, decision, consent_text_version, consent_text, doc_versions) VALUES (${ulit(uPre)}, 'agree_electronic', 'esign-consent-v1', 'x', '{}')`, { role: 'service_role' });
  check('service_role 直接 INSERT 同意紀錄 → EVIDENCE_WRITE_DENIED', sIns?.ok === false && sIns.message === 'EVIDENCE_WRITE_DENIED', sIns);
  const sTrunc = exec(null, `TRUNCATE public.contract_signing_evidence CASCADE`, { role: 'service_role' });
  check('service_role TRUNCATE 證據 → EVIDENCE_IMMUTABLE（trigger 擋，不只是權限）', sTrunc?.ok === false && sTrunc.message === 'EVIDENCE_IMMUTABLE', sTrunc);
  const sAct = exec(null, `UPDATE public.instructor_account_activations SET status = 'revoked', revoked_at = now() WHERE user_id = ${ulit(uEmail)}`, { role: 'service_role' });
  check('service_role 改啟用紀錄 → ACTIVATION_RECORD_IMMUTABLE', sAct?.ok === false && sAct.message === 'ACTIVATION_RECORD_IMMUTABLE', sAct);
  // 超級使用者（不刻意繞過時）也被 trigger 擋
  const pUpd = suExec(`UPDATE public.contract_signing_evidence SET ip_address = '6.6.6.6' WHERE id = ${ulit(ev2Id)}`);
  check('postgres 不繞過 trigger 時 UPDATE 證據 → EVIDENCE_IMMUTABLE', pUpd?.ok === false && pUpd.message === 'EVIDENCE_IMMUTABLE', pUpd);
  const pText = suExec(`UPDATE public.esign_text_versions SET content = 'x' WHERE version_code = 'esign-consent-v1'`);
  const pTextDel = suExec(`DELETE FROM public.esign_text_versions WHERE version_code = 'esign-consent-v1'`);
  check('法規文案 append-only：同一代碼不能改內容／刪除（ESIGN_TEXT_IMMUTABLE）', pText?.message === 'ESIGN_TEXT_IMMUTABLE' && pTextDel?.message === 'ESIGN_TEXT_IMMUTABLE', { pText, pTextDel });
  check('法規文案：可以新增 -v2', suExec(`INSERT INTO public.esign_text_versions (version_code, content) VALUES ('esign-consent-v2', '新版')`)?.rows === 1);
  check('法規文案：authenticated 不能新增', exec(admin, `INSERT INTO public.esign_text_versions (version_code, content) VALUES ('esign-x-v1', 'x')`)?.ok === false);

  // Storage
  check('admin DELETE signed/ 物件 → 0 列', exec(admin, `DELETE FROM storage.objects WHERE bucket_id = 'contract-documents' AND name = ${lit(SIG)}`)?.rows === 0);
  check('admin UPDATE（覆寫／改名）signed/ 物件 → 0 列', exec(admin, `UPDATE storage.objects SET name = name || '.bak' WHERE bucket_id = 'contract-documents' AND name LIKE 'signed/%'`)?.rows === 0);
  check('admin DELETE 被已簽契約引用的範本 → 0 列', exec(admin, `DELETE FROM storage.objects WHERE bucket_id = 'contract-documents' AND name = 'templates/rules/v1.pdf'`)?.rows === 0);
  check('admin UPDATE 被引用的範本 → 0 列', exec(admin, `UPDATE storage.objects SET metadata = '{"x":1}' WHERE bucket_id = 'contract-documents' AND name = 'templates/contract/v1.pdf'`)?.rows === 0);
  check('admin 仍可刪除沒被引用的範本（1 列）', exec(admin, `DELETE FROM storage.objects WHERE bucket_id = 'contract-documents' AND name = 'templates/misc/v1.pdf'`)?.rows === 1);
  check('講師 DELETE 自己的 signed/ 檔 → 0 列', exec(uEmail, `DELETE FROM storage.objects WHERE name = ${lit(SIG)}`)?.rows === 0);
  check('storage 物件都還在', suVal(`SELECT count(*) FROM storage.objects WHERE name IN (${lit(SIG)}, 'templates/rules/v1.pdf', 'templates/contract/v1.pdf')`) === '3');

  // contract_documents
  const dDel = exec(admin, `DELETE FROM public.contract_documents WHERE doc_type = 'rules' AND version = 1`);
  check('admin 刪除被引用的文件版本 → DOCUMENT_REFERENCED', dDel?.ok === false && dDel.message === 'DOCUMENT_REFERENCED', dDel);
  const dPath = exec(admin, `UPDATE public.contract_documents SET file_path = 'templates/rules/other.pdf' WHERE doc_type = 'rules' AND version = 1`);
  check('admin 改被引用版本的 file_path → DOCUMENT_REFERENCED', dPath?.ok === false && dPath.message === 'DOCUMENT_REFERENCED', dPath);
  const dVer = exec(admin, `UPDATE public.contract_documents SET version = 9 WHERE doc_type = 'rules' AND version = 1`);
  const dHash = exec(admin, `UPDATE public.contract_documents SET content_sha256 = ${lit(sha('x'))} WHERE doc_type = 'rules' AND version = 1`);
  check('admin 改被引用版本的 version／content_sha256 → DOCUMENT_REFERENCED', dVer?.message === 'DOCUMENT_REFERENCED' && dHash?.message === 'DOCUMENT_REFERENCED', { dVer, dHash });
  check('admin 可刪除未被引用的文件版本', exec(admin, `DELETE FROM public.contract_documents WHERE doc_type = 'misc'`)?.rows === 1);
  const contractV1Id = suVal(`SELECT id FROM public.contract_documents WHERE doc_type = 'contract' AND version = 1`);
  check('admin_set_document_hash：teacher → 42501', call(uEmail, `public.admin_set_document_hash(${ulit(contractV1Id)}, ${lit(sha('contract-v1'))})`)?.sqlstate === '42501');
  check('admin_set_document_hash：格式錯 → INVALID_HASH', errOf(call(admin, `public.admin_set_document_hash(${ulit(contractV1Id)}, 'zz')`)) === 'INVALID_HASH');
  check('admin_set_document_hash：補登 NULL（即使已被引用）→ saved',
    call(admin, `public.admin_set_document_hash(${ulit(contractV1Id)}, ${lit(sha('contract-v1').toUpperCase())})`)?.result?.status === 'saved'
    && suVal(`SELECT content_sha256 FROM public.contract_documents WHERE id = ${lit(contractV1Id)}`) === sha('contract-v1'));
  check('admin_set_document_hash：已有值不能再改 → HASH_ALREADY_SET', errOf(call(admin, `public.admin_set_document_hash(${ulit(contractV1Id)}, ${lit(sha('y'))})`)) === 'HASH_ALREADY_SET');

  // 刪帳號／解除綁定
  const delSigned = exec(admin, `SELECT public.delete_user_completely(${ulit(uEmail)})`);
  check('delete_user_completely：有已簽契約 → 拒絕（依簽署證據保存規定不可刪除，請改用停用）',
    delSigned?.ok === false && delSigned.message === '依簽署證據保存規定不可刪除，請改用停用' && roleOf(uEmail) === 'teacher', delSigned);
  const delDeclined = exec(admin, `SELECT public.delete_user_completely(${ulit(uPre)})`);
  check('delete_user_completely：只有同意／不同意紀錄也拒絕', delDeclined?.ok === false && delDeclined.message === '依簽署證據保存規定不可刪除，請改用停用', delDeclined);
  const idActId = openActivation(uId).id;
  const delPending = exec(admin, `SELECT public.delete_user_completely(${ulit(uId)})`);
  const idActAfter = suJson(`SELECT to_jsonb(a) FROM public.instructor_account_activations a WHERE id = ${lit(idActId)}`);
  check('delete_user_completely：沒有簽署紀錄的 pending 帳號可刪；啟用紀錄保留並改 revoked（account_deleted）',
    delPending?.ok && suVal(`SELECT count(*) FROM auth.users WHERE id = ${lit(uId)}`) === '0' && idActAfter.status === 'revoked' && idActAfter.revoked_reason === 'account_deleted', { delPending, idActAfter });
  check('刪帳號後講師主檔回到未認領', suVal(`SELECT user_id IS NULL FROM public.instructors WHERE id = ${lit(idInstructor)}`) === 't');
  const unlink = exec(admin, `SELECT public.admin_unlink_instructor(${ulit(slot.id)})`);
  const slotActs = activationsOf(uSlot);
  check('admin_unlink_instructor：啟用紀錄改 revoked（admin_unlink）', unlink?.ok && slotActs.length === 1 && slotActs[0].status === 'revoked' && slotActs[0].revoked_reason === 'admin_unlink', slotActs);
  check('解除綁定後 get_my_activation_status → none', call(uSlot, 'public.get_my_activation_status()').result?.status === 'none');

  // 超級使用者繞過 trigger 偷改 → 雜湊鏈抓得到
  const ipOrig = ev1.ip_address;
  su(`SET session_replication_role = replica; UPDATE public.contract_signing_evidence SET ip_address = '6.6.6.6' WHERE id = ${ulit(ev1.id)}; RESET session_replication_role;`);
  const broken1 = call(admin, 'public.admin_verify_contract_evidence_chain()').result;
  check('超級使用者偷改證據 IP → ok=false、first_broken_id＝該筆', broken1.ok === false && broken1.first_broken_id === ev1.id && broken1.broken_reason === 'evidence_hash_mismatch', broken1);
  su(`SET session_replication_role = replica; UPDATE public.contract_signing_evidence SET ip_address = ${lit(ipOrig)} WHERE id = ${ulit(ev1.id)}; RESET session_replication_role;`);
  check('改回原值後 ok=true', call(admin, 'public.admin_verify_contract_evidence_chain()').result?.ok === true);
  su(`SET session_replication_role = replica; UPDATE public.contract_signing_evidence SET evidence_sha256 = ${lit(sha('forged'))} WHERE id = ${ulit(ev1.id)}; RESET session_replication_role;`);
  const broken2 = call(admin, 'public.admin_verify_contract_evidence_chain()').result;
  check('偷改證據雜湊本身 → 抓到第一筆', broken2.ok === false && broken2.first_broken_id === ev1.id, broken2);
  su(`SET session_replication_role = replica; UPDATE public.contract_signing_evidence SET evidence_sha256 = ${lit(ev1.evidence_sha256)} WHERE id = ${ulit(ev1.id)}; RESET session_replication_role;`);
  su(`SET session_replication_role = replica; UPDATE public.instructor_contracts SET filled_id_number = 'Z999999999' WHERE id = ${ulit(c2Id)}; RESET session_replication_role;`);
  const broken3 = call(admin, 'public.admin_verify_contract_evidence_chain()').result;
  check('超級使用者偷改契約的身分證欄 → 交叉比對抓到第二筆證據（contract_mismatch）', broken3.ok === false && broken3.first_broken_id === ev2Id && broken3.broken_reason === 'contract_mismatch', broken3);
  su(`SET session_replication_role = replica; UPDATE public.instructor_contracts SET filled_id_number = 'A123456789' WHERE id = ${ulit(c2Id)}; RESET session_replication_role;`);
  su(`CREATE TABLE t.saved_ev AS SELECT * FROM public.contract_signing_evidence WHERE id = ${ulit(ev2Id)};
      SET session_replication_role = replica; DELETE FROM public.contract_signing_evidence WHERE id = ${ulit(ev2Id)}; RESET session_replication_role;`);
  const broken4 = call(admin, 'public.admin_verify_contract_evidence_chain()').result;
  check('超級使用者刪掉鏈尾證據 → 抓到缺證據的契約（evidence_missing_for_contract）', broken4.ok === false && broken4.first_broken_id === c2Id && broken4.broken_reason === 'evidence_missing_for_contract', broken4);
  su(`SET session_replication_role = replica; INSERT INTO public.contract_signing_evidence SELECT * FROM t.saved_ev; RESET session_replication_role;`);
  const finalChain = call(admin, 'public.admin_verify_contract_evidence_chain()').result;
  check('還原後證據鏈 ok=true、checked=2', finalChain.ok === true && finalChain.checked === 2, finalChain);

  // ════════════════════════════════════════════════════════════════
  group('RLS reads');
  const own = (uid, table) => jsonAs(uid, `SELECT count(*) FROM public.${table}`);
  check('講師讀得到自己的證據、同意、啟用、寄送紀錄', own(uEmail, 'contract_signing_evidence') === 2 && own(uEmail, 'contract_consent_records') >= 5
    && own(uEmail, 'instructor_account_activations') === 1 && own(uEmail, 'email_delivery_log') >= 1);
  check('講師讀不到別人的證據／同意／啟用紀錄', jsonAs(uPre, `SELECT count(*) FROM public.contract_signing_evidence WHERE user_id = ${lit(uEmail)}`) === 0
    && jsonAs(uPre, `SELECT count(*) FROM public.contract_consent_records WHERE user_id = ${lit(uEmail)}`) === 0
    && jsonAs(uPre, `SELECT count(*) FROM public.instructor_account_activations WHERE user_id = ${lit(uEmail)}`) === 0
    && jsonAs(uPre, `SELECT count(*) FROM public.email_delivery_log WHERE related_user_id = ${lit(uEmail)}`) === 0);
  check('admin 讀得到全部證據與啟用紀錄', own(admin, 'contract_signing_evidence') === 2 && own(admin, 'instructor_account_activations') === Number(suVal(`SELECT count(*) FROM public.instructor_account_activations`)));
  const anonRead = exec(null, `SELECT * FROM public.contract_signing_evidence`, { role: 'anon' });
  check('anon 讀證據 → 權限不足', anonRead?.ok === false && anonRead.sqlstate === '42501', anonRead);
  check('講師讀不到 private.email_otp_challenges', exec(uEmail, `SELECT * FROM private.email_otp_challenges`)?.ok === false);

  // ════════════════════════════════════════════════════════════════
  group('minor: 未滿 18 歲不可線上簽約（法遵紅燈 R3，migration 20261022120000）');
  check('新 migration 已被套用（chain 包含 20261022120000_block_minor_online_signing.sql）',
    chain.applied.includes('supabase/migrations/20261022120000_block_minor_online_signing.sql'));

  // 函式與 trigger 的硬化：SECURITY DEFINER、search_path=''、PUBLIC／anon／authenticated 都沒有 EXECUTE
  const minorFns = suJson(`SELECT jsonb_agg(jsonb_build_object('fn', p.proname, 'definer', p.prosecdef, 'path', p.proconfig,
      'anon', has_function_privilege('anon', p.oid, 'EXECUTE'), 'auth', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
      'public', EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)) ORDER BY p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'private' AND p.proname IN ('is_minor_birth_date', 'instructor_is_minor', 'block_minor_online_signing', 'guard_minor_birth_date_change', 'notify_minor_paper_signing')`);
  check('5 個新函式都是 SECURITY DEFINER＋search_path=\'\'', minorFns?.length === 5
    && minorFns.every((f) => f.definer && JSON.stringify(f.path) === '["search_path=\\"\\""]'), minorFns);
  check('5 個新函式：PUBLIC／anon／authenticated 都沒有 EXECUTE', minorFns.every((f) => !f.public && !f.anon && !f.auth), minorFns);
  const minorTriggers = suJson(`SELECT jsonb_agg(tgname ORDER BY tgname) FROM pg_trigger WHERE NOT tgisinternal
      AND tgname IN ('trg_block_minor_signed_contract', 'trg_block_minor_agree_consent', 'trg_guard_minor_birth_date_change', 'trg_notify_minor_paper_signing')`);
  check('4 個新 trigger 都在（擋簽署列、擋 agree 同意、擋未成年改生日、通知管理員）', minorTriggers?.length === 4, minorTriggers);
  check('既有 append-only／契約 guard trigger 仍在（沒有被我們取代）',
    suVal(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_guard_instructor_contracts', 'trg_guard_contract_consent_records')`) === '2');

  // 邊界：資料庫函式與前端 isMinorOn 逐筆相同（生日前一天／當天／隔天、閏年 2/29、年底年初）
  const grid = [
    ['2008-10-23', '2026-10-22'], ['2008-10-22', '2026-10-22'], ['2008-10-21', '2026-10-22'],
    ['2008-10-22', '2026-10-21'], ['2008-10-22', '2026-10-23'],
    ['2008-02-29', '2026-02-27'], ['2008-02-29', '2026-02-28'], ['2008-02-29', '2026-03-01'], ['2008-02-29', '2026-03-02'],
    ['2006-02-28', '2024-02-27'], ['2006-02-28', '2024-02-28'], ['2006-03-01', '2024-02-29'], ['2006-03-01', '2024-03-01'],
    ['2008-12-31', '2026-12-30'], ['2008-12-31', '2026-12-31'], ['2009-01-01', '2026-12-31'], ['2009-01-01', '2027-01-01'],
    ['2015-05-05', '2026-10-22'], ['1992-02-02', '2026-10-22'],
  ];
  const gridSql = suJson(`SELECT jsonb_agg(private.is_minor_birth_date(v.b::date, v.o::date) ORDER BY v.n)
      FROM (VALUES ${grid.map(([b, o], i) => `(${i}, ${lit(b)}, ${lit(o)})`).join(', ')}) AS v(n, b, o)`);
  const gridMismatch = grid.filter(([b, o], i) => gridSql[i] !== isMinorOn(b, o));
  check(`資料庫 is_minor_birth_date 與前端 isMinorOn 在 ${grid.length} 個邊界日期完全一致`, gridMismatch.length === 0, gridMismatch);
  check('邊界答案本身正確：生日前一天未成年、當天成年、隔天成年；2/29 出生者 2/28 未成年、3/1 成年',
    gridSql[0] === true && gridSql[1] === false && gridSql[2] === false && gridSql[6] === true && gridSql[7] === false, gridSql);
  check('birth_date 為 NULL → false（視為成年）', suVal(`SELECT private.is_minor_birth_date(NULL, '2026-10-22')`) === 'f');
  const todayTpe = suVal(`SELECT (now() AT TIME ZONE 'Asia/Taipei')::date`);
  const birthRel = (days) => suVal(`SELECT ((now() AT TIME ZONE 'Asia/Taipei')::date - interval '18 years' + interval '${days} days')::date`);
  const turns18Today = birthRel(0);
  const turns18Tomorrow = birthRel(1);
  const turned18Yesterday = birthRel(-1);
  check('以台灣今天為準：今天滿 18 歲（成年）、明天才滿 18 歲（未成年）、昨天已滿（成年）',
    suVal(`SELECT private.is_minor_birth_date(${lit(turns18Today)}::date)`) === 'f'
    && suVal(`SELECT private.is_minor_birth_date(${lit(turns18Tomorrow)}::date)`) === 't'
    && suVal(`SELECT private.is_minor_birth_date(${lit(turned18Yesterday)}::date)`) === 'f', { todayTpe, turns18Today, turns18Tomorrow });

  // 受測帳號：legacy teacher（無啟用紀錄視為已啟用）＋已確認 Email＋指定出生日期
  let minorSeq = 0;
  const MV = suJson(`SELECT jsonb_object_agg(d.doc_type, d.version)
      FROM (SELECT DISTINCT ON (d0.doc_type) d0.doc_type, d0.version FROM public.contract_documents d0
             WHERE d0.is_active = true AND COALESCE(to_jsonb(d0) ->> 'doc_category', 'contract') <> 'form'
             ORDER BY d0.doc_type, d0.version DESC) d`);
  const DOCH_M = Object.fromEntries(Object.keys(MV).map((k) => [k, k === 'rules' ? sha('rules-v1') : sha(`${k}-v${MV[k]}`)]));
  const makeSigner = (tag, birthDate) => {
    minorSeq += 1;
    const email = `${tag}@t.test`;
    const uid = createAuthUser(email, tag);
    const iid = makeInstructor(tag, email, { phone: `097000000${minorSeq}`, idNumber: `M2234500${minorSeq}0`.slice(0, 10), userId: uid });
    su(`UPDATE public.users SET role = 'teacher' WHERE id = ${lit(uid)}`);
    su(`UPDATE public.instructors SET birth_date = ${birthDate ? lit(birthDate) : 'NULL'} WHERE id = ${lit(iid)}`);
    const confirmed = call(admin, `public.admin_confirm_instructor_email(${ulit(iid)}, ${lit(email)}, 'minor 測試：Email 確認')`);
    if (confirmed?.result?.status !== 'confirmed') throw new Error(`confirm email failed ${JSON.stringify(confirmed)}`);
    su(`INSERT INTO storage.objects (bucket_id, name) VALUES ('contract-documents', 'signed/${uid}/signature_1.png'), ('contract-documents', 'signed/${uid}/contract_1.pdf')`);
    return { uid, iid, email };
  };
  const submitFor = (signer, { otp, consent }) => call(signer.uid, submitExpr({
    sig: `signed/${signer.uid}/signature_1.png`, pdfs: { contract: `signed/${signer.uid}/contract_1.pdf` }, versions: MV,
    docHash: DOCH_M, pdfHash: { contract: sha(`signed-${signer.uid}`) }, otp, consent,
  }));
  const countOf = (table, uid, col = 'user_id') => Number(suVal(`SELECT count(*) FROM public.${table} WHERE ${col} = ${lit(uid)}`));
  const notifCount = () => Number(suVal(`SELECT count(*) FROM public.notifications WHERE user_id = ${lit(admin)} AND type = 'contract'`));
  const minor = makeSigner('minor-tomorrow', turns18Tomorrow);
  check('前提：受測帳號是 teacher（無啟用紀錄視為已啟用）、已確認 Email、出生日期＝明天才滿 18 歲',
    roleOf(minor.uid) === 'teacher' && suVal(`SELECT s.is_active FROM private.signing_account_state(${lit(minor.uid)}) s`) === 't'
    && suVal(`SELECT private.instructor_is_minor(${lit(minor.uid)})`) === 't');

  // 未成年：同意（agree）被擋，沒有留下任何紀錄
  const mAgree = recordConsent(minor.uid, 'agree_electronic', MV, 'esign-consent-v1');
  check('未成年 record_contract_consent(agree) → MINOR_REQUIRES_GUARDIAN（P0001）', errOf(mAgree) === 'MINOR_REQUIRES_GUARDIAN' && mAgree.sqlstate === 'P0001', mAgree);
  check('未成年 agree 被擋後沒有留下任何同意紀錄', countOf('contract_consent_records', minor.uid) === 0);

  // 未成年：不同意（改紙本）照常可用，記錄未成年說明全文，通知管理員（原本一則＋未成年補充一則）
  const notifBeforeMinor = notifCount();
  const mDecline = recordConsent(minor.uid, 'decline_electronic', MV, 'esign-minor-paper-v1');
  check('未成年 record_contract_consent(decline, esign-minor-paper-v1) → recorded', mDecline.result?.status === 'recorded' && mDecline.result.consent_id, mDecline);
  const mRow = suJson(`SELECT to_jsonb(r) FROM public.contract_consent_records r WHERE id = ${ulit(mDecline.result?.consent_id)}`);
  check('decline 紀錄存「未成年說明」全文：代碼 esign-minor-paper-v1、文件清單已代入、有法定代理人、無殘留佔位符',
    mRow?.decision === 'decline_electronic' && mRow.consent_text_version === 'esign-minor-paper-v1'
    && mRow.consent_text.startsWith('請改以紙本簽約') && mRow.consent_text.includes('法定代理人（通常是父母）') && !mRow.consent_text.includes('{{')
    && mRow.consent_text.includes('（第 1 版）') && mRow.instructor_id === minor.iid, mRow?.consent_text);
  check('decline 紀錄同時存個資告知版本與全文（與一般 decline 相同）', mRow?.privacy_notice_version === 'esign-privacy-notice-v1' && mRow.privacy_notice_text === privacySeed);
  check('未成年也可以用一般的「不同意」文案記錄（esign-decline-paper-v1 不受影響）',
    recordConsent(minor.uid, 'decline_electronic', MV, 'esign-decline-paper-v1').result?.status === 'recorded');
  const minorNotif = suJson(`SELECT to_jsonb(n) FROM public.notifications n WHERE n.user_id = ${lit(admin)} AND n.title LIKE '未滿 18 歲%' ORDER BY n.created_at DESC LIMIT 1`);
  check('管理員收到通知：原本「講師選擇改以紙本簽約」×2（兩次 decline）＋「未滿 18 歲…法定代理人」×2',
    notifCount() === notifBeforeMinor + 4 && minorNotif?.body?.includes('minor-tomorrow') && minorNotif.body.includes('法定代理人') && minorNotif.link === '/admin/contracts', { count: notifCount() - notifBeforeMinor, minorNotif });
  check('成年講師選擇紙本時不會多出「未滿 18 歲」通知', (() => {
    const before = Number(suVal(`SELECT count(*) FROM public.notifications WHERE title LIKE '未滿 18 歲%'`));
    recordConsent(uPre, 'decline_electronic', V, 'esign-decline-paper-v1');
    return Number(suVal(`SELECT count(*) FROM public.notifications WHERE title LIKE '未滿 18 歲%'`)) === before;
  })());

  // 未成年：直接呼叫 submit_my_contract 被擋，而且不留半套紀錄；OTP 不被消耗（整筆交易回滾）
  //   作法：出生日期原本是成年 → 記同意、驗證簽約碼（此時完全合法）→ 出生日期被更正為未成年 → 送出
  const corrected = makeSigner('minor-corrected', '1990-01-01');
  const cConsent = recordConsent(corrected.uid, 'agree_electronic', MV, 'esign-consent-v1');
  check('對照組：同一人在出生日期是成年時可記同意（agree → recorded）', cConsent.result?.status === 'recorded', cConsent);
  const cOtp = verifiedContractOtp(corrected.uid);
  su(`UPDATE public.instructors SET birth_date = ${lit(turns18Tomorrow)} WHERE id = ${lit(corrected.iid)}`);
  const evidenceBefore = Number(suVal(`SELECT count(*) FROM public.contract_signing_evidence`));
  const mailBefore = Number(suVal(`SELECT count(*) FROM public.email_delivery_log WHERE kind = 'contract_signed_copy'`));
  const cSubmit = submitFor(corrected, { otp: cOtp, consent: cConsent.result.consent_id });
  check('未成年（出生日期被更正）呼叫 submit_my_contract → MINOR_REQUIRES_GUARDIAN', errOf(cSubmit) === 'MINOR_REQUIRES_GUARDIAN', cSubmit);
  const cChallenge = suJson(`SELECT to_jsonb(c) FROM private.email_otp_challenges c WHERE c.id = ${ulit(cOtp)}`);
  check('被擋之後 OTP 沒有被消耗（consumed_at 仍是 NULL，verified_at 還在）：整筆交易回滾', cChallenge.consumed_at === null && cChallenge.verified_at !== null, cChallenge);
  check('被擋之後沒有任何半套紀錄：沒有契約、沒有證據、沒有簽署完成通知信、證據鏈長度不變',
    countOf('instructor_contracts', corrected.uid) === 0 && Number(suVal(`SELECT count(*) FROM public.contract_signing_evidence`)) === evidenceBefore
    && Number(suVal(`SELECT count(*) FROM public.email_delivery_log WHERE kind = 'contract_signed_copy'`)) === mailBefore
    && Number(suVal(`SELECT count(*) FROM public.email_delivery_log WHERE related_contract_id IS NOT NULL AND related_user_id = ${lit(corrected.uid)}`)) === 0);
  // 出生日期改回成年後，同一組 OTP＋同意還能用（證明上面真的沒消耗任何東西）
  su(`UPDATE public.instructors SET birth_date = '1990-01-01' WHERE id = ${lit(corrected.iid)}`);
  const cRetry = submitFor(corrected, { otp: cOtp, consent: cConsent.result.consent_id });
  check('出生日期更正回成年後，同一組同意＋OTP 可以簽成功（證明被擋時沒有消耗 OTP）', cRetry.ok && cRetry.result?.status === 'signed', cRetry);
  su(`UPDATE public.instructors SET birth_date = ${lit(turns18Tomorrow)} WHERE id = ${lit(corrected.iid)}`);

  // 未成年：拿別人的同意／沒有同意直接送出 → 在更前面就被擋
  check('未成年沒有同意直接送出 → CONSENT_REQUIRED（被擋，沒有留下契約）',
    errOf(submitFor(minor, { otp: cOtp, consent: null })) === 'CONSENT_REQUIRED' && countOf('instructor_contracts', minor.uid) === 0);
  check('未成年拿別人（成年）的同意紀錄送出 → CONSENT_REQUIRED（被擋，沒有留下契約）',
    errOf(submitFor(minor, { otp: cOtp, consent: cConsent.result.consent_id })) === 'CONSENT_REQUIRED' && countOf('instructor_contracts', minor.uid) === 0);

  // 資料庫 trigger 本身（深度防禦）：即使走「內部寫入」通道，未成年的 signed 契約列與 agree 同意列也寫不進去
  const mInsContract = suExec(`DO $d$ BEGIN PERFORM private.internal_write_begin();
      INSERT INTO public.instructor_contracts (user_id, filled_name, filled_instructor_role, filled_id_number, filled_address, filled_phone, signature_path, status)
      VALUES (${lit(minor.uid)}, 'x', 'A', 'A123456789', 'x', 'x', 's.png', 'signed'); END $d$`);
  check('內部寫入通道也寫不進未成年的 signed 契約列（MINOR_REQUIRES_GUARDIAN）', mInsContract?.ok === false && mInsContract.message === 'MINOR_REQUIRES_GUARDIAN', mInsContract);
  const mInsConsent = suExec(`DO $d$ BEGIN PERFORM private.internal_write_begin();
      INSERT INTO public.contract_consent_records (user_id, decision, consent_text_version, consent_text, doc_versions)
      VALUES (${lit(minor.uid)}, 'agree_electronic', 'esign-consent-v1', 'x', '{}'::jsonb); END $d$`);
  check('內部寫入通道也寫不進未成年的 agree 同意列（MINOR_REQUIRES_GUARDIAN）', mInsConsent?.ok === false && mInsConsent.message === 'MINOR_REQUIRES_GUARDIAN', mInsConsent);
  const mSrv = exec(null, `INSERT INTO public.contract_consent_records (user_id, decision, consent_text_version, consent_text, doc_versions) VALUES (${ulit(minor.uid)}, 'agree_electronic', 'esign-consent-v1', 'x', '{}')`, { role: 'service_role' });
  check('service_role 直接寫未成年的 agree 同意列也被擋（不是靠 RPC 才擋）', mSrv?.ok === false && ['MINOR_REQUIRES_GUARDIAN', 'EVIDENCE_WRITE_DENIED'].includes(mSrv.message), mSrv);

  // 邊界：今天剛好滿 18 歲可以簽；出生日期 NULL 當成年；成年人不受影響
  const bday = makeSigner('adult-bday-today', turns18Today);
  const bConsent = recordConsent(bday.uid, 'agree_electronic', MV, 'esign-consent-v1');
  check('剛好今天滿 18 歲：可記錄 agree 同意', bConsent.result?.status === 'recorded', bConsent);
  const bOtp = verifiedContractOtp(bday.uid);
  const bSign = submitFor(bday, { otp: bOtp, consent: bConsent.result.consent_id });
  check('剛好今天滿 18 歲：submit_my_contract 簽署成功（signed）、證據多一筆', bSign.ok && bSign.result?.status === 'signed'
    && Number(suVal(`SELECT count(*) FROM public.contract_signing_evidence`)) === evidenceBefore + 2 && countOf('instructor_contracts', bday.uid) === 1,
    { bSign, evidenceBefore });
  const nullBirth = makeSigner('adult-no-birth', null);
  check('出生日期 NULL：視為成年，可記錄 agree 同意', recordConsent(nullBirth.uid, 'agree_electronic', MV, 'esign-consent-v1').result?.status === 'recorded');
  const adult = makeSigner('adult-1990', '1990-01-01');
  const aConsent = recordConsent(adult.uid, 'agree_electronic', MV, 'esign-consent-v1');
  const aSign = submitFor(adult, { otp: verifiedContractOtp(adult.uid), consent: aConsent.result?.consent_id });
  check('成年人（1990）：同意＋簽署完全不受影響', aConsent.result?.status === 'recorded' && aSign.ok && aSign.result?.status === 'signed', { aConsent, aSign });
  const chainAfterMinor = call(admin, 'public.admin_verify_contract_evidence_chain()').result;
  check('新增三份簽署（corrected 重試、今天滿 18、成年）後證據鏈仍完整', chainAfterMinor?.ok === true && chainAfterMinor.checked === evidenceBefore + 3, chainAfterMinor);

  // 出生日期防繞過：未成年講師不能自己把出生日期改成成年或清空
  const flipAdult = exec(minor.uid, `UPDATE public.instructors SET birth_date = '1990-01-01' WHERE user_id = auth.uid()`);
  check('未成年講師自己把出生日期改成成年 → BIRTH_DATE_ADMIN_ONLY（42501）', flipAdult?.ok === false && flipAdult.message === 'BIRTH_DATE_ADMIN_ONLY' && flipAdult.sqlstate === '42501', flipAdult);
  const flipNull = exec(minor.uid, `UPDATE public.instructors SET birth_date = NULL WHERE user_id = auth.uid()`);
  check('未成年講師自己清空出生日期 → BIRTH_DATE_ADMIN_ONLY', flipNull?.ok === false && flipNull.message === 'BIRTH_DATE_ADMIN_ONLY', flipNull);
  check('被擋之後出生日期沒變、仍是未成年', suVal(`SELECT birth_date FROM public.instructors WHERE id = ${lit(minor.iid)}`) === turns18Tomorrow
    && suVal(`SELECT private.instructor_is_minor(${lit(minor.uid)})`) === 't');
  const keepMinor = exec(minor.uid, `UPDATE public.instructors SET birth_date = ${lit(birthRel(5))} WHERE user_id = auth.uid()`);
  check('未成年講師把出生日期改成另一個（仍未成年的）日期 → 允許（更正筆誤）', keepMinor?.ok === true && keepMinor.rows === 1, keepMinor);
  const resave = exec(minor.uid, `UPDATE public.instructors SET birth_date = birth_date, nickname = '暱稱改了' WHERE user_id = auth.uid()`);
  check('未成年講師存檔其他欄位（出生日期沒變）→ 不受影響', resave?.ok === true && resave.rows === 1, resave);
  const adultEdit = exec(adult.uid, `UPDATE public.instructors SET birth_date = '1985-05-05' WHERE user_id = auth.uid()`);
  check('成年講師把出生日期改成另一個成年日期 → 允許', adultEdit?.ok === true && adultEdit.rows === 1, adultEdit);
  const adultToMinor = exec(adult.uid, `UPDATE public.instructors SET birth_date = ${lit(turns18Tomorrow)} WHERE user_id = auth.uid()`);
  check('成年講師把出生日期改成未成年日期 → 允許（誤填也不傷人；之後只有管理員能改回）', adultToMinor?.ok === true && adultToMinor.rows === 1, adultToMinor);
  const adminFix = exec(admin, `UPDATE public.instructors SET birth_date = '1999-09-09' WHERE id = ${ulit(minor.iid)}`);
  check('管理員可以更正未成年講師的出生日期（改成成年）', adminFix?.ok === true && adminFix.rows === 1
    && suVal(`SELECT private.instructor_is_minor(${lit(minor.uid)})`) === 'f', adminFix);
  check('管理員更正後，原本的未成年講師可以記錄 agree 同意', recordConsent(minor.uid, 'agree_electronic', MV, 'esign-consent-v1').result?.status === 'recorded');

  // migration 可重複執行；文案種子 append-only
  const textBefore = suVal(`SELECT content FROM public.esign_text_versions WHERE version_code = 'esign-minor-paper-v1'`);
  const rerunMinor = db.psqlSync(null, { file: migrationFile(MINOR_MIGRATION), tuplesOnly: false, expectFail: true });
  check('新 migration 第二次套用成功（可重複執行）、文案種子不變、trigger 不重複',
    rerunMinor.ok && suVal(`SELECT content FROM public.esign_text_versions WHERE version_code = 'esign-minor-paper-v1'`) === textBefore
    && !/WARNING/.test(rerunMinor.stderr || '')
    && Number(suVal(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_%minor%'`)) === 4, rerunMinor.stderr);
  check('esign-minor-paper-v1 種入 esign_text_versions 且是 append-only（不能改內容）',
    textBefore.startsWith('請改以紙本簽約') && suExec(`UPDATE public.esign_text_versions SET content = 'x' WHERE version_code = 'esign-minor-paper-v1'`)?.message === 'ESIGN_TEXT_IMMUTABLE');

  // ════════════════════════════════════════════════════════════════
  group('legal copy fidelity');
  for (const code of ['esign-read-ack-v1', 'esign-consent-v1', 'esign-decline-paper-v1', 'esign-final-confirm-v1', 'esign-privacy-notice-v1', 'esign-signed-email-v1', 'esign-otp-email-v1']) {
    const content = suVal(`SELECT content FROM public.esign_text_versions WHERE version_code = ${lit(code)}`);
    const lines = legalQuoteLines(code);
    const missing = lines.filter((line) => !content.includes(line));
    check(`${code}：種入的全文逐句等於 docs/specs/2026-10-20-esign-legal-copy.md（${lines.length} 句）`, content && lines.length > 0 && missing.length === 0, missing);
  }

  // ════════════════════════════════════════════════════════════════
  // 2026-10-23 資安審查必修 1：綁定講師主檔但還沒用驗證碼啟用（role 仍是 pending）的帳號，
  // 讀不到這份主檔背後原本的上課、報酬、徽章資料；已有上課或報酬紀錄的姓名空位不能只靠姓名認領。
  group('linked reads require activated account (必修 1, 20261023100000)');
  check('新 migration 已被套用（chain 包含 20261023100000_linked_reads_require_active_account.sql）',
    chain.applied.includes('supabase/migrations/20261023100000_linked_reads_require_active_account.sql'));
  su(`INSERT INTO storage.buckets (id, name, public) VALUES ('instructor_uploads', 'instructor_uploads', false) ON CONFLICT DO NOTHING`);
  let sessionSeq = 0;
  // 行政登錄的上課紀錄（以超級使用者寫入＝後台／匯入）；日期都在講師可見範圍（2026-01-01 起）
  const addSessions = (instructorId, name, count = 2) => {
    const rows = [];
    for (let k = 0; k < count; k += 1) {
      sessionSeq += 1;
      const day = String(1 + (sessionSeq % 27)).padStart(2, '0');
      const month = String(3 + Math.floor(sessionSeq / 27)).padStart(2, '0');
      rows.push(`('regular_basic', ${lit(`紀錄課 ${sessionSeq}`)}, ${lit(instructorId)}, ${lit(name)}, DATE '2026-${month}-${day}',
        1.5, ${3 + k}, 640, 0, 0, 'approved', 'legacy', 'manual')`);
    }
    su(`INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, session_date,
          duration_hours, student_count, base_salary, bonus, paid_amount, status, pricing_status, source)
        VALUES ${rows.join(',')}`);
    return count;
  };
  const sessionsSeen = (uid, instructorId) => jsonAs(uid, `SELECT count(*) FROM public.class_sessions WHERE instructor_id = ${lit(instructorId)}`);
  const salarySeen = (uid, instructorId) => jsonAs(uid, `SELECT COALESCE(sum(total_salary), 0) FROM public.class_sessions WHERE instructor_id = ${lit(instructorId)}`);
  const summarySeen = (uid) => jsonAs(uid, `SELECT COALESCE(jsonb_agg(jsonb_build_object('n', s.total_sessions, 'salary', s.total_salary)), '[]'::jsonb)
      FROM public.instructor_salary_summary s WHERE s.user_id = auth.uid()`);
  const badgeStatsSeen = (uid, instructorId) => jsonAs(uid, `SELECT COALESCE(jsonb_agg(jsonb_build_object('n', s.session_count, 'hours', s.total_hours)), '[]'::jsonb)
      FROM public.get_teacher_badge_stats(${lit(instructorId)}) s`);
  const leaderboardSeen = (uid, instructorId) => jsonAs(uid, `SELECT jsonb_build_object(
      'v2', (SELECT count(*) FROM public.get_teaching_leaderboard_v2(NULL, 'all')),
      'v2_mine', (SELECT count(*) FROM public.get_teaching_leaderboard_v2(NULL, 'all') l WHERE l.instructor_id = ${lit(instructorId)}),
      'v1', (SELECT count(*) FROM public.get_teaching_leaderboard(NULL)))`);
  const overridesSeen = (uid, instructorId) => jsonAs(uid, `SELECT count(*) FROM public.badge_overrides WHERE instructor_id = ${lit(instructorId)}`);
  const objectSeen = (uid, name) => jsonAs(uid, `SELECT count(*) FROM storage.objects WHERE bucket_id = 'instructor_uploads' AND name = ${lit(name)}`);
  const grantOverride = (instructorId) => suVal(`WITH ins AS (
      INSERT INTO public.badge_overrides (instructor_id, badge_key, state, note)
      SELECT ${lit(instructorId)}, d.key, 'granted', '後台頒發（測試）' FROM public.badge_definitions d ORDER BY d.key LIMIT 1
      ON CONFLICT DO NOTHING RETURNING 1) SELECT count(*) FROM ins`);

  // R1（總指揮在正式庫預檢到的真實型態）：name_slot＝true、四項個資全空、但已有上課紀錄的空位
  const recSlotInsert = exec(admin, `INSERT INTO public.instructors (full_name, name_slot) VALUES ('有紀錄空位', true)`);
  const recSlot = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE full_name = '有紀錄空位'`);
  const recSessions = addSessions(recSlot.id, '有紀錄空位', 3);
  check('R1 前提：name_slot＝true、user_id 空、email／身分證／手機／銀行帳號全空，但有 3 筆上課紀錄',
    recSlotInsert?.ok && recSlot.name_slot === true && recSlot.user_id === null && !recSlot.email_primary && !recSlot.id_number
    && !recSlot.phone_mobile && !recSlot.bank_account_number && Number(suVal(`SELECT count(*) FROM public.class_sessions WHERE instructor_id = ${lit(recSlot.id)}`)) === recSessions, recSlot);
  const uSquat = createAuthUser('squat@t.test', '同名路人');
  const squat = call(uSquat, `public.claim_instructor_name_slot('有紀錄 空位')`);
  check('R1 有上課紀錄的姓名空位：輸入同名認領 → not_found（不透露名冊有這個姓名）',
    squat.result?.status === 'not_found' && !('instructor_id' in (squat.result || {})), squat);
  check('R1 認領被擋後：空位仍未綁定、認領者沒有主檔、沒有啟用紀錄、角色仍是 pending',
    suVal(`SELECT user_id IS NULL FROM public.instructors WHERE id = ${lit(recSlot.id)}`) === 't' && !instructorOf(uSquat)
    && (activationsOf(uSquat) || []).length === 0 && roleOf(uSquat) === 'pending');
  check('R1 認領被擋的人讀不到該空位任何上課紀錄', sessionsSeen(uSquat, recSlot.id) === 0);
  // R2：只有隔離區或薪資總表紀錄的空位也一樣（報酬紀錄）
  exec(admin, `INSERT INTO public.instructors (full_name, name_slot) VALUES ('隔離紀錄空位', true)`);
  const qSlot = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE full_name = '隔離紀錄空位'`);
  addSessions(qSlot.id, '隔離紀錄空位', 1);
  su(`INSERT INTO public.class_sessions_quarantine (id, course_type, course_name, instructor_id, instructor_name, session_date,
          duration_hours, student_count, base_salary, bonus, paid_amount, status, pricing_status, source, quarantine_batch, quarantine_reason)
      SELECT s.id, s.course_type, s.course_name, s.instructor_id, s.instructor_name, s.session_date,
             s.duration_hours, s.student_count, s.base_salary, s.bonus, s.paid_amount, s.status, s.pricing_status, s.source, 'test-batch', '測試隔離'
        FROM public.class_sessions s WHERE s.instructor_id = ${lit(qSlot.id)};
      SET session_replication_role = replica;
      DELETE FROM public.class_sessions WHERE instructor_id = ${lit(qSlot.id)};
      RESET session_replication_role;`);
  const uSquat2 = createAuthUser('squat2@t.test', '同名路人二');
  check('R2 只剩隔離區上課紀錄的姓名空位 → not_found',
    Number(suVal(`SELECT count(*) FROM public.class_sessions_quarantine WHERE instructor_id = ${lit(qSlot.id)}`)) === 1
    && Number(suVal(`SELECT count(*) FROM public.class_sessions WHERE instructor_id = ${lit(qSlot.id)}`)) === 0
    && call(uSquat2, `public.claim_instructor_name_slot('隔離紀錄空位')`).result?.status === 'not_found');
  // 對照組：沒有任何紀錄的空位照舊可認領（下面 P2 用）
  exec(admin, `INSERT INTO public.instructors (full_name, name_slot, photo_path) VALUES ('待啟用空位', true, 'instructors/import/slot-photo.png')`);
  const freshSlot = suJson(`SELECT to_jsonb(i) FROM public.instructors i WHERE full_name = '待啟用空位'`);
  su(`INSERT INTO storage.objects (bucket_id, name) VALUES ('instructor_uploads', 'instructors/import/slot-photo.png')`);
  const uP2 = createAuthUser('p2@t.test', '待啟用老師');
  const p2Claim = call(uP2, `public.claim_instructor_name_slot('待啟用空位')`);
  check('對照組：沒有上課／報酬紀錄的姓名空位照舊可認領（claimed、只綁不開通）',
    p2Claim.result?.status === 'claimed' && p2Claim.result.instructor_id === freshSlot.id && roleOf(uP2) === 'pending', p2Claim);

  // P2：綁定之後行政才登錄課（真實順序：空位先建、老師綁定、行政補登課）＋後台頒徽章
  const p2Sessions = addSessions(freshSlot.id, '待啟用空位', 2);
  check('P2 前提：徽章頒發寫入 1 筆', grantOverride(freshSlot.id) === '1');
  check('P2 pending＋已綁定：讀不到該空位的上課紀錄（class_sessions 0 筆、報酬金額 0）',
    sessionsSeen(uP2, freshSlot.id) === 0 && Number(salarySeen(uP2, freshSlot.id)) === 0, { n: sessionsSeen(uP2, freshSlot.id) });
  const p2Summary = summarySeen(uP2);
  check('P2 pending＋已綁定：報酬彙總 instructor_salary_summary 只看到自己的列、堂數與金額都是 0',
    Array.isArray(p2Summary) && p2Summary.length === 1 && Number(p2Summary[0].n) === 0 && Number(p2Summary[0].salary) === 0, p2Summary);
  check('P2 pending＋已綁定：get_teacher_badge_stats(自己綁的主檔) → 空集合', JSON.stringify(badgeStatsSeen(uP2, freshSlot.id)) === '[]', badgeStatsSeen(uP2, freshSlot.id));
  const p2Board = leaderboardSeen(uP2, freshSlot.id);
  check('P2 pending＋已綁定：教學排行榜 v1／v2 都是空集合', p2Board?.v2 === 0 && p2Board.v1 === 0 && p2Board.v2_mine === 0, p2Board);
  check('P2 pending＋已綁定：讀不到後台頒給這個主檔的徽章（badge_overrides）', overridesSeen(uP2, freshSlot.id) === 0);
  check('P2 pending＋已綁定：讀不到主檔路徑指到、但不在自己資料夾的影像（空位原本的照片）',
    objectSeen(uP2, 'instructors/import/slot-photo.png') === 0);
  // 不能擋的：本人主檔、本人資料夾的上傳檔、草稿、通知、啟用流程
  check('P2 pending 仍讀得到自己的講師主檔', jsonAs(uP2, `SELECT count(*) FROM public.instructors WHERE user_id = auth.uid()`) === 1);
  const p2Upload = exec(uP2, `INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('instructor_uploads', 'instructors/' || auth.uid() || '/id-front.png', auth.uid())`);
  check('P2 pending 可上傳到自己的資料夾，並讀得到自己剛上傳的檔',
    p2Upload?.ok && p2Upload.rows === 1 && objectSeen(uP2, `instructors/${uP2}/id-front.png`) === 1, p2Upload);
  const p2Fill = exec(uP2, `UPDATE public.instructors SET
      nickname = '待啟用', gender = '女', birth_date = '1993-03-03', id_number = 'G223450001', phone_mobile = '0977000111',
      line_id = 'line-p2', address = '桃園市', household_address = '桃園市', email_primary = 'p2@t.test',
      teaching_freq_semester = '每週 1 次', teaching_freq_vacation = '每週 2 次', teaching_regions = ARRAY['桃園市']::public.tw_county[],
      bio_notes = '待啟用', bank_account_name = '待啟用老師', bank_name = '銀行', bank_branch = '分行',
      bank_account_number = '3333333333', bank_code = '0000003',
      id_front_path = 'instructors/' || auth.uid() || '/id-front.png', id_back_path = 'instructors/' || auth.uid() || '/id-back.png',
      bankbook_path = 'instructors/' || auth.uid() || '/bankbook.png'
    WHERE user_id = auth.uid()`);
  check('P2 pending 可在 /profile 補齊並存檔自己的主檔', p2Fill?.ok && p2Fill.rows === 1, p2Fill);
  const p2Draft = exec(uP2, `INSERT INTO public.instructor_profile_drafts (user_id, data) VALUES (auth.uid(), '{"nickname":"草稿"}'::jsonb)
      ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data`);
  check('P2 pending 可寫入並讀回自己的資料草稿', p2Draft?.ok && jsonAs(uP2, `SELECT count(*) FROM public.instructor_profile_drafts WHERE user_id = auth.uid()`) === 1, p2Draft);
  su(`INSERT INTO public.notifications (user_id, type, title, body) VALUES (${lit(uP2)}, 'announcement', '測試通知', '本人通知')`);
  check('P2 pending 讀得到自己的通知', jsonAs(uP2, `SELECT count(*) FROM public.notifications WHERE user_id = auth.uid()`) === 1);
  check('P2 pending 的啟用狀態查詢照常（pending／name_slot）', call(uP2, 'public.get_my_activation_status()').result?.status === 'pending');

  // 啟用成 teacher 之後就讀得到
  call(admin, `public.admin_confirm_instructor_email(${ulit(freshSlot.id)}, 'p2@t.test', '10/23 透過 LINE 與老師本人確認')`);
  const p2Otp = freshOtp(uP2, 'account_activation');
  const p2Verify = verifyOtp(uP2, p2Otp.id, p2Otp.code);
  check('P2 用 Email 驗證碼啟用 → teacher', p2Verify?.activated === true && roleOf(uP2) === 'teacher', p2Verify);
  check('P2 啟用後讀得到該主檔的上課紀錄與報酬金額',
    sessionsSeen(uP2, freshSlot.id) === p2Sessions && Number(salarySeen(uP2, freshSlot.id)) === 640 * p2Sessions,
    { n: sessionsSeen(uP2, freshSlot.id), salary: salarySeen(uP2, freshSlot.id) });
  const p2SummaryAfter = summarySeen(uP2);
  check('P2 啟用後報酬彙總有堂數與金額', p2SummaryAfter?.length === 1 && Number(p2SummaryAfter[0].n) === p2Sessions && Number(p2SummaryAfter[0].salary) === 640 * p2Sessions, p2SummaryAfter);
  const p2Badge = badgeStatsSeen(uP2, freshSlot.id);
  check('P2 啟用後 get_teacher_badge_stats 有統計（堂數＝2）', p2Badge?.length === 1 && Number(p2Badge[0].n) === p2Sessions, p2Badge);
  const p2BoardAfter = leaderboardSeen(uP2, freshSlot.id);
  check('P2 啟用後教學排行榜 v1／v2 有資料且包含自己', p2BoardAfter?.v2 > 0 && p2BoardAfter.v1 > 0 && p2BoardAfter.v2_mine === 1, p2BoardAfter);
  check('P2 啟用後讀得到後台頒的徽章與主檔路徑指到的影像（照片仍是空位原本的路徑）', overridesSeen(uP2, freshSlot.id) === 1
    && objectSeen(uP2, 'instructors/import/slot-photo.png') === 1 && objectSeen(uP2, `instructors/${uP2}/id-front.png`) === 1);

  // P3：Email 對應（首次登入自動綁定）、主檔原本就有課 → 綁定後 pending，同樣讀不到
  const p3Instructor = makeInstructor('信箱有課老師', 'p3@t.test', { phone: '0977000222', idNumber: 'G223450002' });
  su(`UPDATE public.instructors SET photo_path = 'instructors/import/p3-photo.png' WHERE id = ${lit(p3Instructor)};
      INSERT INTO storage.objects (bucket_id, name) VALUES ('instructor_uploads', 'instructors/import/p3-photo.png');`);
  const p3Sessions = addSessions(p3Instructor, '信箱有課老師', 2);
  const uP3 = createAuthUser('p3@t.test', '信箱有課老師 Google');
  check('P3 前提：Email 對應自動綁定、role pending、主檔有 2 筆上課紀錄',
    instructorOf(uP3)?.id === p3Instructor && roleOf(uP3) === 'pending' && p3Sessions === 2);
  check('P3 pending（email_match）讀不到主檔的上課紀錄、報酬彙總為 0、成就統計空、匯入的影像讀不到',
    sessionsSeen(uP3, p3Instructor) === 0 && Number(summarySeen(uP3)?.[0]?.n) === 0
    && JSON.stringify(badgeStatsSeen(uP3, p3Instructor)) === '[]' && objectSeen(uP3, 'instructors/import/p3-photo.png') === 0);
  check('P3 pending 仍讀得到自己的主檔（啟用前確認資料）', jsonAs(uP3, `SELECT count(*) FROM public.instructors WHERE user_id = auth.uid()`) === 1);

  // mentor／admin／既有 teacher 原本的讀取不受影響
  const totalSessions = Number(suVal(`SELECT count(*) FROM public.class_sessions`));
  check('admin 讀得到全部上課紀錄（含空位與未啟用者的）', jsonAs(admin, `SELECT count(*) FROM public.class_sessions`) === totalSessions && totalSessions > 0);
  check('admin 讀得到任一主檔的成就統計、排行榜、徽章頒發',
    Number(badgeStatsSeen(admin, recSlot.id)?.[0]?.n) === recSessions && leaderboardSeen(admin, recSlot.id)?.v2_mine === 1 && overridesSeen(admin, freshSlot.id) === 1);
  const mentorSessions = addSessions(mentorInstructor, '輔導員本人', 2);
  check('mentor 讀得到自己綁定主檔的上課紀錄（照舊）', sessionsSeen(uMentor, mentorInstructor) === mentorSessions);
  check('mentor 讀不到別人的上課紀錄（照舊）', sessionsSeen(uMentor, recSlot.id) === 0);
  check('mentor 呼叫排行榜、成就統計照常有資料', leaderboardSeen(uMentor, recSlot.id)?.v2 > 0 && Number(badgeStatsSeen(uMentor, recSlot.id)?.[0]?.n) === recSessions);
  const legacySessions = addSessions(legacyInstructor, '舊講師', 2);
  check('既有 teacher（legacy 啟用紀錄）讀得到自己的上課紀錄（照舊）', sessionsSeen(legacyTeacher, legacyInstructor) === legacySessions);
  const lateSessions = addSessions(lateInstructor.id, '晚建檔老師', 1);
  check('沒有任何啟用紀錄的 teacher（回填後自建主檔）也讀得到自己的上課紀錄——條件看角色、不看啟用紀錄',
    (activationsOf(uLate) || []).length === 0 && sessionsSeen(uLate, lateInstructor.id) === lateSessions);
  check('teacher 讀不到別人的上課紀錄（照舊）', sessionsSeen(legacyTeacher, freshSlot.id) === 0);

  // 可重複執行
  const rerunLinked = db.psqlSync(null, { file: migrationFile(LINKED_READS_MIGRATION), tuplesOnly: false, expectFail: true });
  check('20261023100000 第二次套用成功（可重複執行），套完 pending 仍讀不到、teacher 仍讀得到',
    rerunLinked.ok && sessionsSeen(uP3, p3Instructor) === 0 && sessionsSeen(uP2, freshSlot.id) === p2Sessions
    && Number(suVal(`SELECT count(*) FROM pg_policies WHERE tablename = 'class_sessions' AND policyname = 'Instructors view own sessions'`)) === 1, rerunLinked.stderr);
} catch (error) {
  check(`unexpected error: ${error.message.split('\n')[0]}`, false, error.stack);
} finally {
  await db.stop();
}

const failed = results.filter((r) => !r.pass);
const groups = [...new Set(results.map((r) => r.group))];
console.log('\n=== summary ===');
for (const g of groups) {
  const rows = results.filter((r) => r.group === g);
  console.log(`${g}: ${rows.filter((r) => r.pass).length}/${rows.length}`);
}
console.log(`TOTAL: ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
