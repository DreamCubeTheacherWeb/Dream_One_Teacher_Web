#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(appDir, relativePath), 'utf8');
const collectFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const absolutePath = path.join(directory, entry.name);
  return entry.isDirectory() ? collectFiles(absolutePath) : [absolutePath];
});

const source = collectFiles(path.join(appDir, 'src'))
  .filter((file) => /\.(js|jsx)$/.test(file))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');
const authContext = read('src/context/AuthContext.jsx');
const teacherManager = read('src/pages/admin/TeacherManager.jsx');
const downloadCenter = read('src/pages/admin/DownloadCenter.jsx');
const profileCompletion = read('src/lib/profileCompletion.js');
const formGenerator = read('src/lib/formGenerator.js');
const instructorList = read('src/pages/admin/InstructorList.jsx');
const pendingApproval = read('src/pages/PendingApproval.jsx');
const migration = read('supabase/migrations/2026-08-24_align_instructor_claim_flow.sql');
const identityMigration = read('supabase/migrations/20260826140000_recover_existing_instructor_identity_claim.sql');

const checks = [];
const check = (name, callback) => {
  try {
    callback();
    checks.push(true);
    console.log(`PASS  ${name}`);
  } catch (error) {
    checks.push(false);
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
};

check('前端只有 Google OAuth，沒有 Email 密碼登入或自行註冊 API', () => {
  assert.doesNotMatch(source, /signInWithPassword|\.auth\.signUp|signUpWithEmail|signInWithEmail/);
  assert.match(authContext, /provider:\s*'google'/);
});

check('登入決策只呼叫講師主檔認領 RPC，不再讀寫邀請名單', () => {
  assert.match(authContext, /claim_my_precreated_instructor/);
  assert.doesNotMatch(authContext, /teacher_invites|link_my_instructor_by_email/);
  assert.doesNotMatch(teacherManager, /teacher_invites|邀請/);
});

check('全新 Google 帳號可註冊為 pending，停用與重複主檔會被拒絕', () => {
  assert.match(migration, /auth_provider <> 'google'/);
  assert.match(migration, /IF blocked_count > 0/);
  assert.match(migration, /IF match_count > 1/);
  assert.match(migration, /RETURN '\{\}'::jsonb/);
  assert.match(migration, /resolved_role\s+text := 'pending'/);
});

check('唯一既有 Email 會自動認領，重複登入具冪等性', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_my_precreated_instructor/);
  assert.match(migration, /'claimed_now', false/);
  assert.match(migration, /'claimed_now', true/);
  assert.match(migration, /UPDATE public\.instructors[\s\S]*SET user_id = actor_id/);
});

check('新註冊只能在資料完整後由後台核准', () => {
  assert.match(migration, /approve_new_instructor_account/);
  assert.match(migration, /private\.instructor_profile_is_complete/);
  assert.match(teacherManager, /approve_new_instructor_account/);
});

check('表單下載以講師主檔為範圍，不以是否認領篩選', () => {
  assert.doesNotMatch(downloadCenter, /\.not\('user_id',\s*'is',\s*null\)/);
  assert.match(downloadCenter, /selectedIds\.has\(inst\.id\)/);
  assert.match(downloadCenter, /target_instructor_id:\s*inst\.id/);
});

check('外部匯入文件算完整，大頭照不是必填', () => {
  assert.match(profileCompletion, /\[`\$\{key\}_external_url`\]/);
  assert.doesNotMatch(profileCompletion, /key:\s*'photo'/);
  assert.match(migration, /bankbook_external_url/);
  assert.match(formGenerator, /getInstructorDocumentReference/);
  assert.match(profileCompletion, /drive\.google\.com\/uc/);
  assert.match(formGenerator, /fetch\(reference\.fetchUrl/);
  assert.match(instructorList, /REQUIRED_PROFILE_DOCUMENTS\.length/);
});

check('Email 衝突帳號不會進入新主檔填寫流程', () => {
  assert.match(pendingApproval, /claimState\?\.status === 'new'/);
  assert.match(pendingApproval, /claimState\?\.status !== 'conflict'/);
});

check('Email 未命中時先選認領帳號或新建帳號，不會直接建立空白主檔', () => {
  assert.match(pendingApproval, />認領帳號</);
  assert.match(pendingApproval, />新建帳號</);
  assert.match(pendingApproval, /claim_instructor_name_slot/);
  assert.match(pendingApproval, /claim_existing_instructor_by_identity/);
  assert.doesNotMatch(pendingApproval, /!data && claimState\?\.status === 'new'[\s\S]{0,120}navigate\('\/profile'/);
});

check('認領帳號分兩步：先只填姓名，姓名沒命中（not_found）才要手機與身分證末四碼', () => {
  assert.match(pendingApproval, /provided_full_name:\s*fullName/);
  assert.match(pendingApproval, /data\?\.status === 'not_found'[\s\S]{0,160}setClaimStep\('identity'\)/);
  assert.match(pendingApproval, /claimStep === 'identity'/);
  assert.match(pendingApproval, /onSubmit=\{claimStep === 'name' \? handleNameClaim : handleExistingClaim\}/);
});

check('後台可只填姓名新增空位，並用資料進度追蹤到簽約', () => {
  assert.match(instructorList, /name_slot:\s*true/);
  assert.match(instructorList, /\.insert\(rows\)/);
  assert.match(instructorList, /searchParams\.get\('progress'\)/);
  assert.match(instructorList, /findNameConflicts/);
  assert.match(instructorList, /我確定要再新增同名空位（同名同姓不同人）/);
  assert.match(instructorList, /若認領錯人：按解除綁定，對方會回到待審核/);
  assert.match(teacherManager, /findUnclaimedNameSlots/);
  assert.match(teacherManager, /後台有同名空位未認領/);
  assert.match(read('src/pages/admin/Dashboard.jsx'), /\/admin\/instructors\?progress=todo/);
  const progress = read('src/lib/instructorProgress.js');
  assert.match(progress, /getInstructorProfileCompletion/);
  assert.match(read('src/lib/instructorProgressLoader.js'), /\.from\('instructor_contracts'\)/);
  assert.match(progress, /signedUserIds\.has\(instructor\.user_id\)/);
});

check('既有講師以姓名、完整手機與身分證末四碼直接認領並限制重試', () => {
  assert.match(identityMigration, /claim_existing_instructor_by_identity/);
  assert.match(identityMigration, /provided_full_name text/);
  assert.match(identityMigration, /provided_phone_mobile text/);
  assert.match(identityMigration, /provided_id_last_four text/);
  assert.match(identityMigration, /next_attempts >= 5/);
  assert.match(identityMigration, /interval '24 hours'/);
  assert.match(identityMigration, /SET role = 'teacher'/);
  assert.match(identityMigration, /OLD\.user_id IS NULL AND NEW\.user_id = actor_id/);
});

check('Google Email 同時比對主要與備用 Email', () => {
  assert.match(identityMigration, /email_primary[\s\S]{0,180}email_secondary/);
  assert.match(identityMigration, /idx_instructors_normalized_secondary_email/);
});

check('Auth hook 權限只開給 supabase_auth_admin', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.hook_allow_known_google_signup\(jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.hook_allow_known_google_signup\(jsonb\) TO supabase_auth_admin/);
});

// ── 2026-10-20 帳號啟用（Email OTP）與電子簽約：前端（UI）部分 ──
const productionSource = collectFiles(path.join(appDir, 'src'))
  .filter((file) => /\.(js|jsx)$/.test(file) && !/\.test\.js$/.test(file))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

check('帳號啟用與簽約前身分驗證走本系統 OTP（request_email_otp／verify_email_otp），前端不再用 Supabase Auth 的 signInWithOtp／verifyOtp', () => {
  assert.doesNotMatch(productionSource, /signInWithOtp|\.verifyOtp\(/);
  const dialog = read('src/components/EmailOtpDialog.jsx');
  assert.match(dialog, /request_email_otp/);
  assert.match(dialog, /verify_email_otp/);
  assert.match(dialog, /autoComplete="one-time-code"/);
  assert.match(dialog, /inputMode="numeric"/);
  assert.match(read('src/pages/ContractSigningFlow.jsx'), /OTP_PURPOSES\.CONTRACT/);
  assert.match(read('src/pages/ProfilePage.jsx'), /OTP_PURPOSES\.ACTIVATION/);
});

check('認領後待啟用的人被導去 /profile 完成啟用，不顯示「帳號審核中」；個人頁頂端有啟用按鈕', () => {
  assert.match(pendingApproval, /useActivationStatus/);
  assert.match(pendingApproval, /activation\.pending[\s\S]{0,80}Navigate to="\/profile"/);
  const profilePage = read('src/pages/ProfilePage.jsx');
  assert.match(profilePage, /ACTIVATION_BUTTON_LABEL/);
  assert.match(profilePage, /activation\.showButton/);
  assert.equal(read('src/lib/accountActivation.js').includes("'確認資料無誤，驗證信箱啟用帳號'"), true);
});

check('簽約流程：電子簽約同意（同意／不同意）、簽約 OTP、送出帶 4 個新欄位與 WebCrypto SHA-256；舊的「一樣的法律效力」勾選句已移除', () => {
  const signing = read('src/pages/ContractSigningFlow.jsx');
  assert.match(signing, /record_contract_consent/);
  assert.match(signing, /agree_electronic/);
  assert.match(signing, /decline_electronic/);
  for (const param of ['p_otp_challenge_id', 'p_consent_id', 'p_document_sha256', 'p_signed_pdf_sha256']) {
    assert.match(signing, new RegExp(param), param);
  }
  assert.match(read('src/lib/esign.js'), /crypto\?*\.subtle|subtle\.digest\('SHA-256'/);
  assert.doesNotMatch(productionSource, /一樣的法律效力|皆可遵守並配合/);
  assert.equal(productionSource.includes('EmailOtpGate'), false);
});

check('法規顧問定稿的 7 個文案版本代碼都在 esignCopy.js', () => {
  const copy = read('src/lib/esignCopy.js');
  for (const code of ['esign-read-ack-v1', 'esign-consent-v1', 'esign-decline-paper-v1', 'esign-final-confirm-v1', 'esign-privacy-notice-v1', 'esign-signed-email-v1', 'esign-otp-email-v1']) {
    assert.ok(copy.includes(code), code);
  }
});

check('後台：講師名單可確認 Email、進度含待確認 Email／待信箱驗證；合約後台上傳帶 content_sha256、可看簽署證據並驗證檔案與證據鏈', () => {
  assert.match(instructorList, /admin_confirm_instructor_email|ConfirmInstructorEmailModal/);
  assert.match(read('src/components/ConfirmInstructorEmail.jsx'), /admin_confirm_instructor_email/);
  const progress = read('src/lib/instructorProgress.js');
  assert.match(progress, /awaiting_email_confirm/);
  assert.match(progress, /awaiting_email_verify/);
  const contractAdmin = read('src/pages/admin/ContractAdmin.jsx');
  assert.match(contractAdmin, /content_sha256/);
  assert.match(contractAdmin, /admin_set_document_hash/);
  const evidence = read('src/components/ContractEvidencePanel.jsx');
  assert.match(evidence, /admin_verify_contract_evidence_chain/);
  assert.match(evidence, /email_delivery_log/);
  assert.match(evidence, /contract_signing_evidence/);
});

const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} PASS ===`);
process.exit(passed === checks.length ? 0 : 1);
