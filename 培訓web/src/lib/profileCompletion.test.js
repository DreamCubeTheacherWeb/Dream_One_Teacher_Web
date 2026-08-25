import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getInstructorProfileCompletion,
  getInstructorDocumentReference,
  getInstructorLegacyRecoverableItems,
  getMissingRemittanceItems,
  hasInstructorDocument,
  isInstructorProfileComplete,
  isInstructorRemittanceComplete,
  REQUIRED_PROFILE_FIELDS,
  toFetchableInstructorDocumentUrl,
} from './profileCompletion.js';

const completeInstructor = Object.fromEntries(
  REQUIRED_PROFILE_FIELDS.map(({ key }) => [key, key === 'birth_date' ? '1990-01-01' : '有值']),
);
completeInstructor.teaching_regions = ['臺北市'];
completeInstructor.id_front_path = 'instructors/a/id-front.jpg';
completeInstructor.id_back_path = 'instructors/a/id-back.jpg';
completeInstructor.bankbook_path = 'instructors/a/bankbook.jpg';

test('大頭照是選填，不影響講師資料完整度', () => {
  const instructor = { ...completeInstructor, photo_path: null, photo_external_url: null };
  assert.equal(isInstructorProfileComplete(instructor), true);
});

test('既有匯入的外部身分證與存摺連結視為已帶入文件', () => {
  const instructor = {
    ...completeInstructor,
    id_front_path: null,
    id_back_path: null,
    bankbook_path: null,
    id_front_external_url: 'https://drive.google.com/open?id=front',
    id_back_external_url: 'https://drive.google.com/open?id=back',
    bankbook_external_url: 'https://drive.google.com/open?id=bankbook',
  };

  assert.equal(hasInstructorDocument(instructor, 'bankbook'), true);
  assert.deepEqual(getInstructorDocumentReference(instructor, 'bankbook'), {
    kind: 'external',
    value: 'https://drive.google.com/open?id=bankbook',
    fetchUrl: 'https://drive.google.com/uc?export=download&id=bankbook',
  });
  assert.equal(isInstructorProfileComplete(instructor), true);
  assert.deepEqual(getInstructorProfileCompletion(instructor).missingItems, []);
});

test('Google Drive 分享頁會轉成可跨來源讀取的文件下載網址', () => {
  assert.equal(
    toFetchableInstructorDocumentUrl('https://drive.google.com/open?id=file_123-abc'),
    'https://drive.google.com/uc?export=download&id=file_123-abc',
  );
  assert.equal(
    toFetchableInstructorDocumentUrl('https://drive.google.com/file/d/file_456/view?usp=sharing'),
    'https://drive.google.com/uc?export=download&id=file_456',
  );
  assert.equal(toFetchableInstructorDocumentUrl('http://127.0.0.1/private'), null);
  assert.equal(toFetchableInstructorDocumentUrl('https://example.com/not-imported'), null);
});

test('同一文件同時有 Storage 與外部連結時優先使用受控 Storage 檔案', () => {
  assert.deepEqual(getInstructorDocumentReference({
    id_front_path: 'instructors/a/front.jpg',
    id_front_external_url: 'https://drive.google.com/front',
  }, 'id_front'), {
    kind: 'storage',
    value: 'instructors/a/front.jpg',
  });
});

test('缺少任一必填文件時仍會被完成度關卡擋下', () => {
  const instructor = { ...completeInstructor, bankbook_path: null, bankbook_external_url: null };
  const completion = getInstructorProfileCompletion(instructor);

  assert.equal(completion.complete, false);
  assert.ok(completion.missingItems.includes('存摺封面'));
});

test('缺少接課地區與文字欄位時會列出實際缺項', () => {
  const instructor = { ...completeInstructor, nickname: ' ', teaching_regions: [] };
  const completion = getInstructorProfileCompletion(instructor);

  assert.equal(completion.complete, false);
  assert.ok(completion.missingItems.includes('講師暱稱'));
  assert.ok(completion.missingItems.includes('主要接課地區'));
});

test('舊欄位有資料時會另外標示可轉換，不會誤稱完全找不到', () => {
  const instructor = {
    ...completeInstructor,
    nickname: null,
    gender: null,
    id_number: 'A123456789',
    line_name: 'Line 顯示名稱',
    bank_account_name: null,
    bank_name: null,
    bank_branch: null,
    bank_account_number: null,
    bank_code: null,
    bank_info_raw: '0087007/123456789/王小明',
  };

  assert.deepEqual(getInstructorLegacyRecoverableItems(instructor), [
    '講師暱稱',
    '性別',
    '舊匯款帳戶資料',
  ]);
  const completion = getInstructorProfileCompletion(instructor);
  assert.equal(completion.complete, false);
  assert.deepEqual(completion.recoverableItems, [
    '講師暱稱',
    '性別',
    '舊匯款帳戶資料',
  ]);
});

test('歷史匯入用來暫存通訊地址的標記不算經歷資料', () => {
  const completion = getInstructorProfileCompletion({
    ...completeInstructor,
    bio_notes: '[通訊地址] 台北市測試路一號',
  });
  assert.equal(completion.complete, false);
  assert.ok(completion.missingItems.includes('經歷 / 理念'));
});

test('六碼銀行代碼只要有值即視為已填寫匯款資料', () => {
  const instructor = { ...completeInstructor, bank_code: '822123' };

  assert.equal(isInstructorRemittanceComplete(instructor), true);
  assert.deepEqual(getMissingRemittanceItems(instructor), []);
});

test('既有 Google Drive 存摺連結會計入匯款資料完整度', () => {
  const instructor = {
    ...completeInstructor,
    bankbook_path: null,
    bankbook_external_url: 'https://drive.google.com/open?id=bankbook',
  };

  assert.equal(isInstructorRemittanceComplete(instructor), true);
});

test('匯款資料缺項會精確列出缺少的分行與存摺封面', () => {
  const instructor = {
    ...completeInstructor,
    bank_branch: ' ',
    bankbook_path: null,
    bankbook_external_url: null,
  };

  assert.equal(isInstructorRemittanceComplete(instructor), false);
  assert.deepEqual(getMissingRemittanceItems(instructor), ['分行別', '存摺封面']);
});
