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

check('Email 未命中時先選新進或非新進，不會直接建立空白主檔', () => {
  assert.match(pendingApproval, />新進</);
  assert.match(pendingApproval, />非新進</);
  assert.match(pendingApproval, /8\/25 後才加入講師群組/);
  assert.match(pendingApproval, /claim_existing_instructor_by_identity/);
  assert.doesNotMatch(pendingApproval, /!data && claimState\?\.status === 'new'[\s\S]{0,120}navigate\('\/profile'/);
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

const passed = checks.filter(Boolean).length;
console.log(`\n=== ${passed}/${checks.length} PASS ===`);
process.exit(passed === checks.length ? 0 : 1);
