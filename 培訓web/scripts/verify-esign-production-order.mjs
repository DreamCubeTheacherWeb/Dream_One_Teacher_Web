#!/usr/bin/env node
// 認領啟用＋電子簽約線上線前的「正式庫實際套用順序」模擬（2026-10-21；2026-10-22 加入 main 第三批兩支 migration；
// 同日再加第三支電子簽約 migration 20261022120000「未滿 18 歲不可線上簽約」；
// 2026-10-22 晚再加 main 已套正式庫的 20261022100000「人員類別」；
// 2026-10-23 再加 main 已套正式庫的 20261022140000「一鍵標已付款」，以及電子簽約線第四支 20261023100000「未啟用的綁定者讀不到主檔關聯資料」）。
//
// 正式庫已依序套過：20261020010000 → 20261019103000 → 20261020120000 → 20261020130000 → 20261020140000
//   → 20261020150000 → 20261020160000，2026-10-22 下午再依序套了 main 的
//   20261022010000（輔導員權限收緊）→ 20261022093700（partner_no）→ 20261022100000（人員類別）。
// 電子簽約線接著套 233000 → 100000 → 120000（primary＝正式庫實際順序）；
// 也確認反過來（233000、100000、120000 先，main 那三支後套）同樣全過（variant，接近全新環境的檔名順序）。
// 120000（未滿 18 歲防線）只依賴 100000 的表與函式，與 main 那三支互不相依，兩種順序都要通。
// 人員類別 migration 與 233000／100000 都需要保護 instructors 的管理欄位：233000／100000 改用獨立 trigger
//   trg_guard_instructor_claim_fields，不再 CREATE OR REPLACE 共用的 guard_instructor_admin_fields，
//   兩種順序套完都要同時擋住 personnel_types 與 name_slot／已確認 Email／身分核驗欄位（verifyAdminFieldGuards）。
// 本腳本在隔離 PostgreSQL 依各順序套用（E2E_MIGRATION_ORDER，見 scripts/e2e/lib/db.mjs），
// 確認 20261020100000 之後 20261020140000 的「輔導員不能讀別人已簽契約檔」仍成立，再重跑 140000 一次再確認一次。
// verify-claim-activation-esign 與 e2e:onboarding 用同一個環境變數跑正式庫順序，見 STATUS.md。
//
// 用法：LC_ALL=en_US.UTF-8 node scripts/verify-esign-production-order.mjs
//   預設兩種順序都跑；ESIGN_PROD_ORDER_ONLY=primary 或 variant 只跑其中一種。
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TempPostgres, listMigrationFiles, orderMigrationFiles } from './e2e/lib/db.mjs';

const ALREADY_APPLIED = [
  '20261020010000', '20261019103000', '20261020120000', '20261020130000', '20261020140000',
  '20261020150000', '20261020160000',
];
const ESIGN = ['20261019233000', '20261020100000', '20261022120000'];
// 2026-10-23：main 的「一鍵標已付款」20261022140000 已在 10/23 套正式庫，排在人員類別之後
const MAIN_THIRD = ['20261022010000', '20261022093700', '20261022100000', '20261022140000'];
// 2026-10-23 資安審查必修 1：未啟用的綁定者讀不到主檔關聯資料；必須和 ESIGN 三支連續套用、排在最後
const LINKED_READS = ['20261023100000'];

export const PRODUCTION_ORDERS = {
  primary: [...ALREADY_APPLIED, ...MAIN_THIRD, ...ESIGN, ...LINKED_READS],
  // variant＝接近全新環境的檔名順序：電子簽約三支先於 main 第三批；20261023100000 檔名最晚，仍在最後
  variant: [...ALREADY_APPLIED, ...ESIGN, ...MAIN_THIRD, ...LINKED_READS],
};
// 相容舊用法：單一順序（primary）的逗號字串
export const PRODUCTION_ORDER = PRODUCTION_ORDERS.primary.join(',');

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVOKE = path.join(appDir, 'supabase/migrations/20261020140000_revoke_mentor_signed_contract_reads.sql');

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) pass += 1; else fail += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;

const runOrder = async (orderName, orderList) => {
const db = new TempPostgres({ label: `esign-po-${orderName.slice(0, 3)}` });
const tag = `[${orderName}] `;
try {
  process.env.E2E_MIGRATION_ORDER = orderList.join(',');
  const ordered = orderMigrationFiles(listMigrationFiles(appDir));
  const tail = ordered.slice(-orderList.length).map((name) => name.slice(0, 14));
  check(`${tag}套用順序的最後 ${orderList.length} 支＝指定順序`, tail.join(',') === orderList.join(','), tail.join(' → '));

  await db.start();
  // after-chain 底座只補 users.role 的 mentor（正式庫在版控外已有），與 e2e:onboarding 相同
  const chain = db.applyChain(appDir, {
    bootstrapFile: path.join(appDir, 'scripts/e2e/bootstrap.sql'),
    afterChainFile: path.join(appDir, 'scripts/e2e/bootstrap-after-chain.sql'),
  });
  check(`${tag}依正式庫順序套用全部 SQL 成功（${chain.applied.length} 個檔）`,
    path.basename(chain.applied.at(-2)).startsWith(orderList.at(-1)), chain.applied.slice(-4, -1).join(' → '));

  const su = (sql) => db.psqlSync(sql).stdout;
  const users = {};
  for (const role of ['admin', 'mentor', 'teacher', 'other']) {
    const id = randomUUID();
    users[role] = id;
    su(`INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        VALUES ('00000000-0000-0000-0000-000000000000', ${lit(id)}, 'authenticated', 'authenticated', ${lit(`${role}@order.test`)}, now(),
                '{"provider":"google","providers":["google"]}'::jsonb, '{}'::jsonb, now(), now());`);
    su(`UPDATE public.users SET role = ${lit(role === 'other' ? 'teacher' : role)} WHERE id = ${lit(id)};`);
  }
  su(`INSERT INTO storage.buckets (id, name, public) VALUES ('contract-documents', 'contract-documents', false) ON CONFLICT DO NOTHING;
      INSERT INTO storage.objects (bucket_id, name) VALUES
        ('contract-documents', 'templates/contract/v3.pdf'),
        ('contract-documents', 'signed/${users.teacher}/contract_1.pdf'),
        ('contract-documents', 'signed/${users.other}/contract_1.pdf');`);

  const visible = (role) => su(`SET ROLE authenticated;
    SET request.jwt.claims = ${lit(JSON.stringify({ sub: users[role], role: 'authenticated', aud: 'authenticated' }))};
    SELECT string_agg(name, ',' ORDER BY name) FROM storage.objects WHERE bucket_id = 'contract-documents';`);
  const policies = () => su(`SELECT string_agg(policyname || ' :: ' || regexp_replace(coalesce(qual, ''), '\\s+', ' ', 'g'), ' || ')
      FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'SELECT' AND coalesce(qual, '') LIKE '%contract-documents%';`);

  const verifyPolicy = (stage) => {
    const policyText = policies();
    const policyCount = Number(su(`SELECT count(*) FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects'
      AND cmd = 'SELECT' AND coalesce(qual, '') LIKE '%contract-documents%';`));
    check(`${tag}${stage}：contract-documents 的 SELECT 政策只有 1 條「read contract documents scoped」`,
      policyCount === 1 && policyText.startsWith('read contract documents scoped ::'), policyText.slice(0, 160));
    check(`${tag}${stage}：政策條件沒有「admin＋mentor 讀整個 bucket」`,
      !/role\s*=\s*ANY\s*\(ARRAY\['admin'::text,\s*'mentor'::text\]\)/.test(policyText) && !/IN \('admin', 'mentor'\)/.test(policyText));
    const mentor = visible('mentor');
    check(`${tag}${stage}：輔導員讀不到任何人的 signed/、讀得到範本`, mentor === 'templates/contract/v3.pdf', `mentor 看到：${mentor}`);
    const teacher = visible('teacher');
    check(`${tag}${stage}：講師只讀得到自己的 signed/＋範本`,
      teacher === [`signed/${users.teacher}/contract_1.pdf`, 'templates/contract/v3.pdf'].sort().join(','), `teacher 看到：${teacher}`);
    const admin = visible('admin');
    check(`${tag}${stage}：管理員讀得到全部（3 個檔）`, admin.split(',').length === 3, `admin 看到：${admin}`);
  };

  // 未滿 18 歲防線（20261022120000）：不管 120000 與 main 第三批誰先，函式、trigger、文案種子都在，且真的擋得住
  const verifyMinorGuard = (stage) => {
    check(`${tag}${stage}：未滿 18 歲防線的函式與 4 個 trigger 都在`,
      su(`SELECT to_regprocedure('private.instructor_is_minor(uuid)') IS NOT NULL AND to_regprocedure('private.is_minor_birth_date(date,date)') IS NOT NULL`) === 't'
      && Number(su(`SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
        ('trg_block_minor_signed_contract', 'trg_block_minor_agree_consent', 'trg_guard_minor_birth_date_change', 'trg_notify_minor_paper_signing')`)) === 4);
    check(`${tag}${stage}：文案 esign-minor-paper-v1 已種入`,
      Number(su(`SELECT count(*) FROM public.esign_text_versions WHERE version_code = 'esign-minor-paper-v1'`)) === 1);
    su(`DELETE FROM public.instructors WHERE user_id = ${lit(users.other)};
        INSERT INTO public.instructors (user_id, full_name, birth_date)
        VALUES (${lit(users.other)}, '順序測試', ((now() AT TIME ZONE 'Asia/Taipei')::date - interval '18 years' + interval '1 day')::date);`);
    const minorTomorrow = su(`SELECT private.instructor_is_minor(${lit(users.other)})`);
    su(`UPDATE public.instructors SET birth_date = ((now() AT TIME ZONE 'Asia/Taipei')::date - interval '18 years')::date WHERE user_id = ${lit(users.other)}`);
    const adultToday = su(`SELECT private.instructor_is_minor(${lit(users.other)})`);
    check(`${tag}${stage}：明天才滿 18 歲＝未成年、今天剛好滿 18 歲＝成年`, minorTomorrow === 't' && adultToday === 'f', `${minorTomorrow}/${adultToday}`);
    su(`UPDATE public.instructors SET birth_date = ((now() AT TIME ZONE 'Asia/Taipei')::date - interval '18 years' + interval '1 day')::date WHERE user_id = ${lit(users.other)}`);
    const blocked = db.psqlSync(`DO $d$ BEGIN PERFORM private.internal_write_begin();
        INSERT INTO public.contract_consent_records (user_id, decision, consent_text_version, consent_text, doc_versions)
        VALUES (${lit(users.other)}, 'agree_electronic', 'esign-consent-v1', 'x', '{}'::jsonb); END $d$;`, { expectFail: true });
    check(`${tag}${stage}：未成年的 agree 同意列寫不進去（MINOR_REQUIRES_GUARDIAN）`, !blocked.ok && blocked.stderr.includes('MINOR_REQUIRES_GUARDIAN'), blocked.stderr.split('\n')[0]);
    const declineOk = db.psqlSync(`DO $d$ BEGIN PERFORM private.internal_write_begin();
        INSERT INTO public.contract_consent_records (user_id, decision, consent_text_version, consent_text, doc_versions)
        VALUES (${lit(users.other)}, 'decline_electronic', 'esign-minor-paper-v1', 'x', '{}'::jsonb); END $d$;`, { expectFail: true });
    check(`${tag}${stage}：未成年的 decline（改紙本）寫得進去`, declineOk.ok, declineOk.stderr.split('\n')[0]);
  };

  // 管理欄位 guard：人員類別（main 20261022100000）與認領／Email 確認欄位（233000／100000）兩邊的保護都要在
  const asUser = (role, sql) => db.psqlSync(`SET ROLE authenticated;
    SET request.jwt.claims = ${lit(JSON.stringify({ sub: users[role], role: 'authenticated', aud: 'authenticated' }))};
    ${sql}`, { expectFail: true });
  const verifyAdminFieldGuards = (stage) => {
    check(`${tag}${stage}：instructors 上同時有共用 guard 與獨立的認領欄位 guard`,
      Number(su(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.instructors'::regclass AND NOT tgisinternal
        AND tgname IN ('trg_guard_instructor_admin_fields', 'trg_guard_instructor_claim_fields', 'trg_guard_instructor_partner_no')`)) === 3);
    check(`${tag}${stage}：共用 guard 與完整度、合約提醒仍是人員類別版（含 personnel_types）`,
      su(`SELECT bool_and(pg_get_functiondef(p) LIKE '%personnel_types%') FROM unnest(ARRAY[
        'public.guard_instructor_admin_fields()'::regprocedure,
        'private.instructor_profile_is_complete(uuid)'::regprocedure,
        'public.ensure_my_contract_reminder()'::regprocedure]) AS p`) === 't');
    su(`DELETE FROM public.instructors WHERE user_id = ${lit(users.teacher)};
        INSERT INTO public.instructors (user_id, full_name, nickname) VALUES (${lit(users.teacher)}, '順序測試講師', '原暱稱');`);
    const own = (sql) => asUser('teacher', sql);
    const plain = own(`UPDATE public.instructors SET nickname = '新暱稱' WHERE user_id = ${lit(users.teacher)} RETURNING nickname;`);
    check(`${tag}${stage}：講師改自己的一般欄位（暱稱）照常成功`, plain.ok && plain.stdout.includes('新暱稱'), plain.stderr.split('\n')[0]);
    for (const [label, assignment] of [
      ['人員類別', `personnel_types = ARRAY['staff']::text[]`],
      ['姓名空位旗標', 'name_slot = true'],
      ['已確認 Email', `confirmed_email = 'self@order.test'`],
      ['身分核驗時間', 'identity_verified_at = now()'],
    ]) {
      const result = own(`UPDATE public.instructors SET ${assignment} WHERE user_id = ${lit(users.teacher)};`);
      check(`${tag}${stage}：講師不能自己改${label}（42501 管理欄位）`,
        !result.ok && result.stderr.includes('administrator-managed instructor fields cannot be changed by instructors'), result.stderr.split('\n')[0] || 'ok');
    }
    for (const [label, columns, values] of [
      ['人員類別', 'personnel_types', `ARRAY['staff']::text[]`],
      ['已確認 Email', 'confirmed_email', `'self@order.test'`],
    ]) {
      su(`DELETE FROM public.instructors WHERE user_id = ${lit(users.other)};`);
      const result = asUser('other', `INSERT INTO public.instructors (user_id, full_name, ${columns}) VALUES (${lit(users.other)}, '順序測試新講師', ${values});`);
      check(`${tag}${stage}：講師新增主檔時不能自帶${label}（42501 管理欄位）`,
        !result.ok && result.stderr.includes('administrator-managed instructor fields cannot be set by instructors'), result.stderr.split('\n')[0] || 'ok');
    }
    const adminEdit = asUser('admin', `UPDATE public.instructors
        SET personnel_types = ARRAY['instructor', 'staff']::text[], confirmed_email = 'teacher@order.test', name_slot = false
      WHERE user_id = ${lit(users.teacher)} RETURNING array_to_string(personnel_types, '+') || ' ' || confirmed_email;`);
    check(`${tag}${stage}：管理員可以改人員類別與已確認 Email`, adminEdit.ok && adminEdit.stdout.includes('instructor+staff teacher@order.test'),
      adminEdit.stderr.split('\n')[0] || adminEdit.stdout);
  };

  // 必修 1（20261023100000）：綁定主檔但還沒啟用（pending）讀不到上課紀錄；teacher／mentor 照舊；有紀錄的姓名空位不能被認領
  const verifyLinkedReads = (stage) => {
    check(`${tag}${stage}：class_sessions 本人讀取政策含「已啟用帳號」條件`,
      Number(su(`SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'class_sessions'
        AND policyname = 'Instructors view own sessions' AND qual LIKE '%current_user_is_approved_account%'`)) === 1);
    const pendingId = randomUUID();
    su(`INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        VALUES ('00000000-0000-0000-0000-000000000000', ${lit(pendingId)}, 'authenticated', 'authenticated', ${lit(`pending-${pendingId.slice(0, 8)}@order.test`)}, now(),
                '{"provider":"google","providers":["google"]}'::jsonb, '{}'::jsonb, now(), now());
        INSERT INTO public.instructors (user_id, full_name) VALUES (${lit(pendingId)}, '順序測試待啟用');
        INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, session_date, duration_hours, student_count,
            base_salary, bonus, paid_amount, status, pricing_status, source)
          SELECT 'regular_basic', '順序測試課', i.id, i.full_name, DATE '2026-09-01', 1.5, 3, 640, 0, 0, 'approved', 'legacy', 'manual'
            FROM public.instructors i WHERE i.user_id IN (${lit(pendingId)}, ${lit(users.teacher)});`);
    const seen = (uid) => su(`SET ROLE authenticated;
      SET request.jwt.claims = ${lit(JSON.stringify({ sub: uid, role: 'authenticated', aud: 'authenticated' }))};
      SELECT count(*) FROM public.class_sessions;`);
    check(`${tag}${stage}：pending 綁定者讀不到自己主檔的上課紀錄、teacher 讀得到自己的`,
      su(`SELECT role FROM public.users WHERE id = ${lit(pendingId)}`) === 'pending' && seen(pendingId) === '0' && Number(seen(users.teacher)) >= 1,
      `pending=${seen(pendingId)} teacher=${seen(users.teacher)}`);
    su(`INSERT INTO public.instructors (full_name, name_slot) VALUES ('順序測試有課空位', true);
        INSERT INTO public.class_sessions (course_type, course_name, instructor_id, instructor_name, session_date, duration_hours, student_count,
            base_salary, bonus, paid_amount, status, pricing_status, source)
          SELECT 'regular_basic', '空位的課', i.id, i.full_name, DATE '2026-09-02', 1.5, 3, 640, 0, 0, 'approved', 'legacy', 'manual'
            FROM public.instructors i WHERE i.full_name = '順序測試有課空位';`);
    const squatId = randomUUID();
    su(`INSERT INTO auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
        VALUES ('00000000-0000-0000-0000-000000000000', ${lit(squatId)}, 'authenticated', 'authenticated', ${lit(`squat-${squatId.slice(0, 8)}@order.test`)}, now(),
                '{"provider":"google","providers":["google"]}'::jsonb, '{}'::jsonb, now(), now());`);
    const claim = su(`SET ROLE authenticated;
      SET request.jwt.claims = ${lit(JSON.stringify({ sub: squatId, role: 'authenticated', aud: 'authenticated' }))};
      SELECT public.claim_instructor_name_slot('順序測試有課空位') ->> 'status';`);
    check(`${tag}${stage}：已有上課紀錄的姓名空位不能被認領（not_found）`, claim === 'not_found', claim);
    su(`DELETE FROM public.class_sessions WHERE course_name IN ('順序測試課', '空位的課');
        DELETE FROM public.instructors WHERE full_name IN ('順序測試待啟用', '順序測試有課空位');`);
  };

  verifyPolicy('套完 100000 後（未重跑 140000）');
  verifyMinorGuard('套完全部順序後');
  verifyAdminFieldGuards('套完全部順序後');
  verifyLinkedReads('套完全部順序後');
  db.psqlSync(null, { file: REVOKE, tuplesOnly: false });
  verifyPolicy('再重跑 140000 後');
  verifyMinorGuard('再重跑 140000 後');
} catch (error) {
  fail += 1;
  console.log(`FAIL  執行中斷：${error.message}`);
} finally {
  await db.stop().catch(() => {});
}
};

const only = process.env.ESIGN_PROD_ORDER_ONLY;
for (const [orderName, orderList] of Object.entries(PRODUCTION_ORDERS)) {
  if (only && only !== orderName) continue;
  await runOrder(orderName, orderList);
}
console.log(`=== ${pass}/${pass + fail} PASS ===`);
process.exit(fail ? 1 : 0);
