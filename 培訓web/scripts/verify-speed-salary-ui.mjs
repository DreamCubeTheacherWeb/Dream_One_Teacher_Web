#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(appDir, file), 'utf8');

const mySalary = read('src/pages/MySalary.jsx');
const mySalaryNew = read('src/pages/MySalaryNew.jsx');
const app = read('src/App.jsx');
const salaryRegister = read('src/pages/admin/SalaryRegister.jsx');
const instructorList = read('src/pages/admin/InstructorList.jsx');
const adminInstructorEdit = read('src/pages/admin/AdminInstructorEdit.jsx');
const quotePanel = read('src/components/SalaryQuotePanel.jsx');
const salaryHelpers = read('src/lib/salary.js');

const checks = [
    ['站內報酬與課程回報路由已恢復', () => {
        assert.doesNotMatch(mySalary, /SALARY_PAGE_PAUSED/);
        assert.match(app, /<Layout><MySalaryNew \/><\/Layout>/);
    }],
    ['舊外部表單收進轉換期備援，並提示不可重複回報', () => {
        assert.match(mySalary, /仍在使用舊表單/);
        assert.match(mySalary, /同一堂課請擇一回報/);
    }],
    ['講師回報只走受控 RPC', () => {
        assert.match(mySalaryNew, /rpc\('submit_my_class_session'/);
        assert.doesNotMatch(mySalaryNew, /from\('class_sessions'\)\.insert/);
    }],
    ['講師送出前會向後端試算', () => assert.match(mySalaryNew, /getSalaryQuote/)],
    ['缺資格顯示待核薪而非零元', () => {
        assert.match(quotePanel, /待管理員核薪/);
        assert.match(salaryHelpers, /待核薪/);
        assert.match(mySalary, /pricing_status === 'needs_review'/);
    }],
    ['管理端薪資登記已解除遮罩並提供手機待處理清單', () => {
        assert.doesNotMatch(salaryRegister, /尚未啟用，敬請期待/);
        assert.match(salaryRegister, /const SalaryCard/);
        assert.match(salaryRegister, /待處理/);
    }],
    ['管理端改價必須留下原因', () => {
        assert.match(salaryRegister, /人工調整薪資時必須填寫調整原因/);
        assert.match(salaryRegister, /manual_adjustment_reason/);
    }],
    ['管理端可重新試算與退回回報', () => {
        assert.match(salaryRegister, /重新依報酬表試算/);
        assert.match(salaryRegister, /退回回報/);
    }],
    ['速解資格在清單可見，並由管理員編輯頁統一維護', () => {
        assert.match(instructorList, /SPEED_QUALIFICATION_LABELS/);
        assert.doesNotMatch(instructorList, /handleSpeedQualificationChange/);
        assert.match(adminInstructorEdit, /<Field label="速解資格">/);
    }],
];

let passed = 0;
for (const [name, run] of checks) {
    try {
        run();
        passed += 1;
        console.log(`PASS  ${name}`);
    } catch (error) {
        console.error(`FAIL  ${name}\n      ${error.message}`);
    }
}

console.log(`\n=== ${passed}/${checks.length} PASS ===`);
process.exit(passed === checks.length ? 0 : 1);
