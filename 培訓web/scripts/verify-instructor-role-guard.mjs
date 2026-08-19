#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickInstructorProfileDraftFields, stripAdminManagedInstructorFields } from '../src/lib/instructorProfile.js';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => readFileSync(path.join(appDir, relativePath), 'utf8');

const results = [];
const check = (name, test) => {
    try {
        test();
        results.push({ name, pass: true });
        console.log(`PASS  ${name}`);
    } catch (error) {
        results.push({ name, pass: false });
        console.error(`FAIL  ${name}\n      ${error.message}`);
    }
};

check('講師端 payload 會移除 instructor_role', () => {
    const original = { full_name: '測試講師', instructor_role: 'S' };
    const filtered = stripAdminManagedInstructorFields(original);
    assert.deepEqual(filtered, { full_name: '測試講師' });
    assert.equal(original.instructor_role, 'S', '不可改動原始表單物件');
});

check('伺服器端草稿不留檔案路徑或管理欄位', () => {
    const filtered = pickInstructorProfileDraftFields({
        full_name: '測試講師',
        id_front_path: 'private/id-front.png',
        bankbook_mime: 'image/png',
        instructor_role: 'S',
        note_internal: '不可寫入',
    });
    assert.deepEqual(filtered, { full_name: '測試講師' });
});

const profilePage = read('src/pages/ProfilePage.jsx');
const roleFieldStart = profilePage.indexOf('<Field label="講師等級">');
const roleFieldEnd = profilePage.indexOf('<Field label="接課頻率（學期間）"', roleFieldStart);
const roleFieldMarkup = profilePage.slice(roleFieldStart, roleFieldEnd);

check('講師個人頁的等級欄沒有下拉選單', () => {
    assert.ok(roleFieldStart >= 0 && roleFieldEnd > roleFieldStart, '找不到講師等級欄位');
    assert.equal(roleFieldMarkup.includes('<select'), false);
    assert.equal(roleFieldMarkup.includes("handleChange('instructor_role'"), false);
});

check('講師端草稿與儲存請求都套用管理欄位過濾', () => {
    assert.match(profilePage, /data:\s*pickInstructorProfileDraftFields\(form\)/);
    assert.match(profilePage, /\.\.\.stripAdminManagedInstructorFields\(nextForm\)/);
    assert.doesNotMatch(profilePage, /instructor_role:\s*form\.instructor_role/);
});

const instructorList = read('src/pages/admin/InstructorList.jsx');

check('管理端等級選單由 isAdmin 條件包住', () => {
    assert.match(instructorList, /const isAdmin = profile\?\.role === 'admin'/);
    assert.match(instructorList, /\{isAdmin \? \(\s*<select[\s\S]*?onRoleChange/);
    assert.match(instructorList, /\{isAdmin && \([\s\S]*?新增講師/);
});

const guardMigration = read('supabase/2026-07-09_claim_id_and_role.sql');

check('資料庫 trigger 阻止非管理員自行設定或修改等級', () => {
    assert.match(guardMigration, /role = 'admin'/);
    assert.match(guardMigration, /IF TG_OP = 'INSERT' THEN\s*NEW\.instructor_role := '實習'/);
    assert.match(guardMigration, /ELSIF TG_OP = 'UPDATE' THEN\s*NEW\.instructor_role := OLD\.instructor_role/);
    assert.match(guardMigration, /CREATE TRIGGER trg_guard_instructor_role/);
});

const passed = results.filter(({ pass }) => pass).length;
console.log(`\n=== ${passed}/${results.length} PASS ===`);
process.exit(passed === results.length ? 0 : 1);
