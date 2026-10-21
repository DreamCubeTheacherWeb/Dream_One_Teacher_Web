#!/usr/bin/env node
// 認領啟用＋電子簽約線上線前的「正式庫實際套用順序」模擬（2026-10-21）。
//
// 正式庫已依序套過：20261020010000 → 20261019103000 → 20261020120000 → 20261020130000 → 20261020140000
//   → 20261020150000 → 20261020160000；這次要接著套 20261019233000 → 20261020100000。
// 本腳本在隔離 PostgreSQL 依上述順序套用（E2E_MIGRATION_ORDER，見 scripts/e2e/lib/db.mjs），
// 確認 20261020100000 之後 20261020140000 的「輔導員不能讀別人已簽契約檔」仍成立，再重跑 140000 一次再確認一次。
// verify-claim-activation-esign 與 e2e:onboarding 用同一個環境變數跑正式庫順序，見 STATUS.md。
//
// 用法：LC_ALL=en_US.UTF-8 node scripts/verify-esign-production-order.mjs
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TempPostgres, listMigrationFiles, orderMigrationFiles } from './e2e/lib/db.mjs';

export const PRODUCTION_ORDER = [
  '20261020010000', '20261019103000', '20261020120000', '20261020130000', '20261020140000',
  '20261020150000', '20261020160000',
  '20261019233000', '20261020100000',
].join(',');

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REVOKE = path.join(appDir, 'supabase/migrations/20261020140000_revoke_mentor_signed_contract_reads.sql');

let pass = 0;
let fail = 0;
const check = (name, condition, detail = '') => {
  if (condition) pass += 1; else fail += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};
const lit = (value) => `'${String(value).replace(/'/g, "''")}'`;

const db = new TempPostgres({ label: 'esign-prod-order' });
try {
  process.env.E2E_MIGRATION_ORDER = PRODUCTION_ORDER;
  const ordered = orderMigrationFiles(listMigrationFiles(appDir));
  const tail = ordered.slice(-9).map((name) => name.slice(0, 14));
  check('套用順序的最後 9 支＝正式庫已套 7 支＋本次 233000、100000', tail.join(',') === PRODUCTION_ORDER, tail.join(' → '));

  await db.start();
  // after-chain 底座只補 users.role 的 mentor（正式庫在版控外已有），與 e2e:onboarding 相同
  const chain = db.applyChain(appDir, {
    bootstrapFile: path.join(appDir, 'scripts/e2e/bootstrap.sql'),
    afterChainFile: path.join(appDir, 'scripts/e2e/bootstrap-after-chain.sql'),
  });
  check(`依正式庫順序套用全部 SQL 成功（${chain.applied.length} 個檔）`,
    chain.applied.at(-2) === 'supabase/migrations/20261020100000_claim_activation_esign_evidence.sql', chain.applied.slice(-4, -1).join(' → '));

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
    check(`${stage}：contract-documents 的 SELECT 政策只有 1 條「read contract documents scoped」`,
      policyCount === 1 && policyText.startsWith('read contract documents scoped ::'), policyText.slice(0, 160));
    check(`${stage}：政策條件沒有「admin＋mentor 讀整個 bucket」`,
      !/role\s*=\s*ANY\s*\(ARRAY\['admin'::text,\s*'mentor'::text\]\)/.test(policyText) && !/IN \('admin', 'mentor'\)/.test(policyText));
    const mentor = visible('mentor');
    check(`${stage}：輔導員讀不到任何人的 signed/、讀得到範本`, mentor === 'templates/contract/v3.pdf', `mentor 看到：${mentor}`);
    const teacher = visible('teacher');
    check(`${stage}：講師只讀得到自己的 signed/＋範本`,
      teacher === [`signed/${users.teacher}/contract_1.pdf`, 'templates/contract/v3.pdf'].sort().join(','), `teacher 看到：${teacher}`);
    const admin = visible('admin');
    check(`${stage}：管理員讀得到全部（3 個檔）`, admin.split(',').length === 3, `admin 看到：${admin}`);
  };

  verifyPolicy('套完 100000 後（未重跑 140000）');
  db.psqlSync(null, { file: REVOKE, tuplesOnly: false });
  verifyPolicy('再重跑 140000 後');
} catch (error) {
  fail += 1;
  console.log(`FAIL  執行中斷：${error.message}`);
} finally {
  await db.stop().catch(() => {});
}
console.log(`=== ${pass}/${pass + fail} PASS ===`);
process.exit(fail ? 1 : 0);
