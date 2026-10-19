import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_NAME_SLOT_BATCH,
  MAX_NAME_SLOT_LENGTH,
  describeBatchDuplicate,
  describeRosterConflict,
  findNameConflicts,
  findUnclaimedNameSlots,
  isPristineNameSlot,
  normalizePersonName,
  parseNameLines,
} from './instructorNameSlots.js';

test('同名判斷會去掉所有空白（含全形空白）', () => {
  assert.equal(normalizePersonName(' 王 小　明 '), '王小明');
  assert.equal(normalizePersonName('Amy  Chen'), 'amychen');
  assert.equal(normalizePersonName(null), '');
});

test('多行姓名：一行一個、略過空行、頭尾與多餘空白被整理', () => {
  const { names, tooLong, overLimit } = parseNameLines('  王小明 \r\n\n李  小華\n   \n陳大文');
  assert.deepEqual(names, ['王小明', '李 小華', '陳大文']);
  assert.deepEqual(tooLong, []);
  assert.equal(overLimit, false);
});

test('太長的姓名與超過一次可新增的人數會被標出來', () => {
  const longName = '長'.repeat(MAX_NAME_SLOT_LENGTH + 1);
  const parsed = parseNameLines(`王小明\n${longName}`);
  assert.deepEqual(parsed.names, ['王小明']);
  assert.deepEqual(parsed.tooLong, [longName]);

  const many = Array.from({ length: MAX_NAME_SLOT_BATCH + 1 }, (_, index) => `老師${index}`).join('\n');
  assert.equal(parseNameLines(many).overLimit, true);
});

test('名冊已有同名：列出已認領與未認領人數', () => {
  const roster = [
    { full_name: '王小明', user_id: 'u1' },
    { full_name: '王 小明', user_id: null },
    { full_name: '李小華', user_id: 'u2' },
  ];
  const result = findNameConflicts(['王小明', '陳大文'], roster);
  assert.equal(result.hasConflict, true);
  assert.equal(result.rosterConflicts.length, 1);
  assert.equal(describeRosterConflict(result.rosterConflicts[0]), '名冊已有同名：王小明（已認領 1、未認領 1）');
  assert.deepEqual(result.batchDuplicates, []);
});

test('同一批裡重複輸入的名字會被提示（全形／半形空白視為相同）', () => {
  const result = findNameConflicts(['陳大文', '陳　大文', '李小華'], []);
  assert.equal(result.hasConflict, true);
  assert.deepEqual(result.rosterConflicts, []);
  assert.equal(result.batchDuplicates.length, 1);
  assert.equal(describeBatchDuplicate(result.batchDuplicates[0]), '這一批裡重複輸入：陳大文（共 2 行）');
});

test('沒有任何同名時不要求確認', () => {
  const result = findNameConflicts(['陳大文', '李小華'], [{ full_name: '王小明', user_id: null }]);
  assert.equal(result.hasConflict, false);
  assert.equal(findNameConflicts([], []).hasConflict, false);
});

test('帳號審核頁：只找同名、name_slot、未認領的空位', () => {
  const roster = [
    { id: 'a', full_name: '王小明', name_slot: true, user_id: null },
    { id: 'b', full_name: '王 小明', name_slot: true, user_id: null },
    { id: 'c', full_name: '王小明', name_slot: true, user_id: 'u1' },
    { id: 'd', full_name: '王小明', name_slot: false, user_id: null },
    { id: 'e', full_name: '李小華', name_slot: true, user_id: null },
  ];
  assert.deepEqual(findUnclaimedNameSlots('王小明', roster).map((row) => row.id), ['a', 'b']);
  assert.deepEqual(findUnclaimedNameSlots('', roster), []);
  assert.deepEqual(findUnclaimedNameSlots('不存在', roster), []);
});

test('只有乾淨的空位（只填姓名、沒人認領、沒有任何資料）才能刪除', () => {
  const slot = { id: 's', full_name: '王小明', name_slot: true, user_id: null, employment_status: 'active' };
  assert.equal(isPristineNameSlot(slot), true);

  // 已被認領、不是空位、或已被填入資料／內部備註，都不能刪
  assert.equal(isPristineNameSlot({ ...slot, user_id: 'u1' }), false);
  assert.equal(isPristineNameSlot({ ...slot, name_slot: false }), false);
  assert.equal(isPristineNameSlot({ ...slot, phone_mobile: '0912345678' }), false);
  assert.equal(isPristineNameSlot({ ...slot, teaching_regions: ['臺北市'] }), false);
  assert.equal(isPristineNameSlot({ ...slot, id_front_path: 'a.jpg' }), false);
  assert.equal(isPristineNameSlot({ ...slot, note_internal: '備註' }), false);
  assert.equal(isPristineNameSlot({ ...slot, bank_info_raw: '舊帳號' }), false);
  assert.equal(isPristineNameSlot({ ...slot, full_name: '' }), false);
  assert.equal(isPristineNameSlot(null), false);
});
