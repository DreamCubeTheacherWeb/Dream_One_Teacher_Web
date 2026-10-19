import { getInstructorProfileCompletion } from './profileCompletion.js';

/*
 * 後台「只填姓名」新增老師空位的姓名處理。
 * 同名判斷＝去掉所有空白（含全形空白）後相同；與資料庫認領函式 claim_instructor_name_slot
 * 的比對方式一致（BTRIM 後再去掉所有空白），另外不分英文大小寫（只會多提醒，不會漏提醒）。
 */

export const MAX_NAME_SLOT_LENGTH = 50;
export const MAX_NAME_SLOT_BATCH = 100;

export const normalizePersonName = (value) => (
  String(value ?? '').replace(/\s+/g, '').toLowerCase()
);

export const cleanDisplayName = (value) => (
  String(value ?? '').replace(/\s+/g, ' ').trim()
);

// 多行文字 → 姓名清單。一行一個姓名，空行略過；太長的行另外列出，不放進 names。
export const parseNameLines = (text) => {
  const names = [];
  const tooLong = [];
  String(text ?? '').split(/\r?\n/).forEach((line) => {
    const name = cleanDisplayName(line);
    if (!name) return;
    if (normalizePersonName(name).length > MAX_NAME_SLOT_LENGTH) tooLong.push(name);
    else names.push(name);
  });
  return { names, tooLong, overLimit: names.length > MAX_NAME_SLOT_BATCH };
};

// 名冊裡同名的人數：已認領（有 user_id）與未認領各幾位。
export const countRosterByName = (instructors) => {
  const roster = new Map();
  (instructors || []).forEach((instructor) => {
    const key = normalizePersonName(instructor?.full_name);
    if (!key) return;
    const entry = roster.get(key) || { name: instructor.full_name, claimed: 0, unclaimed: 0 };
    if (instructor.user_id) entry.claimed += 1;
    else entry.unclaimed += 1;
    roster.set(key, entry);
  });
  return roster;
};

/**
 * 找出送出前要提醒的同名：
 *  - rosterConflicts：名冊已有同名（附已認領／未認領人數）
 *  - batchDuplicates：同一批裡重複輸入的名字
 */
export const findNameConflicts = (names, instructors) => {
  const roster = countRosterByName(instructors);
  const rosterConflicts = [];
  const batchCounts = new Map();

  (names || []).forEach((name) => {
    const key = normalizePersonName(name);
    const entry = batchCounts.get(key) || { name, count: 0 };
    entry.count += 1;
    batchCounts.set(key, entry);
  });

  batchCounts.forEach((entry, key) => {
    const existing = roster.get(key);
    if (existing) {
      rosterConflicts.push({
        name: existing.name,
        typedName: entry.name,
        claimed: existing.claimed,
        unclaimed: existing.unclaimed,
      });
    }
  });

  const batchDuplicates = [...batchCounts.values()].filter((entry) => entry.count > 1);
  return { rosterConflicts, batchDuplicates, hasConflict: rosterConflicts.length + batchDuplicates.length > 0 };
};

export const describeRosterConflict = ({ name, claimed, unclaimed }) => (
  `名冊已有同名：${name}（已認領 ${claimed}、未認領 ${unclaimed}）`
);

export const describeBatchDuplicate = ({ name, count }) => (
  `這一批裡重複輸入：${name}（共 ${count} 行）`
);

// 後台未認領的「只填姓名」空位中，與某個姓名同名的有哪些（帳號審核頁用來提醒可能選錯「新建帳號」）。
export const findUnclaimedNameSlots = (fullName, instructors) => {
  const key = normalizePersonName(fullName);
  if (!key) return [];
  return (instructors || []).filter((instructor) => (
    instructor?.name_slot
    && !instructor.user_id
    && normalizePersonName(instructor.full_name) === key
  ));
};

// 「空位」還是乾淨的：只填姓名建立、沒人認領、沒有任何個資／文件／內部備註。
// 只有這種空位才提供後台「刪除空位」（打錯字或誤建時用），有資料的主檔一律不給刪。
const PRISTINE_EXTRA_FIELDS = [
  'note_internal', 'email_secondary', 'phone_home', 'line_name', 'school_info',
  'facebook_url', 'bio_personal_experience', 'bio_teaching_experience',
  'teaching_philosophy', 'note_to_team', 'bank_info_raw', 'teaching_regions_raw',
];

const hasText = (value) => value !== null && value !== undefined && String(value).trim() !== '';

export const isPristineNameSlot = (instructor) => {
  if (!instructor?.name_slot || instructor.user_id) return false;
  const { missingItems, totalItems } = getInstructorProfileCompletion(instructor);
  // 必填欄位／文件／接課地區只有「姓名」有值（總項目數 - 1 項缺漏）
  if (missingItems.length !== totalItems - 1 || missingItems.includes('姓名')) return false;
  return !PRISTINE_EXTRA_FIELDS.some((key) => hasText(instructor[key]));
};
