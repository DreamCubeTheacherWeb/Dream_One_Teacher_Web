import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeBankAccountChange,
  fetchOpenEditUnlocks,
  getBankAccountLockState,
  getDocumentLockState,
  hasSubmittedDocument,
  isLockedDocumentError,
  maskAccountNumber,
  pickLockSource,
  toOpenScopeSet,
  unlockScopeForDocument,
} from './instructorDocumentLocks.js';

const saved = {
  id_front_path: 'instructors/u/id_front/a.png',
  id_back_path: null,
  id_back_external_url: '  ',
  bankbook_path: null,
  bankbook_external_url: 'https://drive.google.com/open?id=bankbook',
  bank_account_number: '1234567890',
};

test('已有路徑或匯入連結就算已提交，空白不算（與 DB trigger 判準一致）', () => {
  assert.equal(hasSubmittedDocument(saved, 'id_front'), true);
  assert.equal(hasSubmittedDocument(saved, 'id_back'), false);
  assert.equal(hasSubmittedDocument(saved, 'bankbook'), true);
});

test('身分證正反面共用 id_card 開放，大頭照不在鎖定範圍', () => {
  assert.equal(unlockScopeForDocument('id_front'), 'id_card');
  assert.equal(unlockScopeForDocument('id_back'), 'id_card');
  assert.equal(unlockScopeForDocument('bankbook'), 'bankbook');
  assert.equal(unlockScopeForDocument('photo'), null);
});

test('講師：已提交即鎖定；開放後解鎖；未提交可首次填寫', () => {
  const none = new Set();
  assert.deepEqual(getDocumentLockState({ savedInstructor: saved, key: 'id_front', isAdmin: false, openScopes: none }),
    { locked: true, unlocked: false, scope: 'id_card' });
  assert.deepEqual(getDocumentLockState({ savedInstructor: saved, key: 'id_back', isAdmin: false, openScopes: none }),
    { locked: false, unlocked: false, scope: 'id_card' });
  assert.deepEqual(getDocumentLockState({ savedInstructor: saved, key: 'bankbook', isAdmin: false, openScopes: none }),
    { locked: true, unlocked: false, scope: 'bankbook' });
  assert.deepEqual(getDocumentLockState({ savedInstructor: saved, key: 'id_front', isAdmin: false, openScopes: new Set(['id_card']) }),
    { locked: false, unlocked: true, scope: 'id_card' });
  assert.equal(getDocumentLockState({ savedInstructor: saved, key: 'photo', isAdmin: false, openScopes: none }).locked, false);
});

test('管理員看自己的個人頁不受鎖定', () => {
  assert.equal(getDocumentLockState({ savedInstructor: saved, key: 'id_front', isAdmin: true, openScopes: new Set() }).locked, false);
  assert.equal(getBankAccountLockState({ savedInstructor: saved, isAdmin: true, openScopes: new Set() }).locked, false);
});

test('匯款：有帳號即鎖定，開放 bank_account 後解鎖', () => {
  assert.equal(getBankAccountLockState({ savedInstructor: saved, isAdmin: false, openScopes: new Set() }).locked, true);
  assert.deepEqual(getBankAccountLockState({ savedInstructor: saved, isAdmin: false, openScopes: new Set(['bank_account']) }),
    { locked: false, unlocked: true, scope: 'bank_account' });
  assert.equal(getBankAccountLockState({ savedInstructor: { bank_account_number: ' ' }, isAdmin: false, openScopes: new Set() }).locked, false);
  assert.equal(getBankAccountLockState({ savedInstructor: null, isAdmin: false, openScopes: new Set() }).locked, false);
});

test('pickLockSource 只取判斷鎖定需要的欄位', () => {
  const source = pickLockSource({ ...saved, full_name: '王小明', id_number: 'A123456789' });
  assert.equal(source.full_name, undefined);
  assert.equal(source.id_number, undefined);
  assert.equal(source.bankbook_external_url, saved.bankbook_external_url);
  assert.equal(pickLockSource(null), null);
});

test('toOpenScopeSet 忽略未知項目', () => {
  assert.deepEqual([...toOpenScopeSet([{ scope: 'id_card' }, { scope: 'photo' }, { scope: 'bank_account' }])], ['id_card', 'bank_account']);
});

test('fetchOpenEditUnlocks：資料表尚未套用時回空陣列而不是丟錯', async () => {
  const fakeClient = (result) => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({ is: () => ({ gt: async () => result }) }),
        }),
      }),
    }),
  });
  assert.deepEqual(await fetchOpenEditUnlocks(fakeClient({ data: null, error: { code: 'PGRST205', message: 'missing' } }), 'i1'), []);
  assert.deepEqual(await fetchOpenEditUnlocks(fakeClient({ data: [{ id: 'u1', scope: 'id_card' }], error: null }), 'i1'), [{ id: 'u1', scope: 'id_card' }]);
  assert.deepEqual(await fetchOpenEditUnlocks(fakeClient({ data: [{ id: 'u1' }], error: null }), null), []);
});

test('帳號遮罩與匯款差異只列有變的欄位', () => {
  assert.equal(maskAccountNumber('1234567890'), '123••••890');
  assert.equal(maskAccountNumber('12345'), '12345');
  assert.equal(maskAccountNumber(''), '');
  assert.deepEqual(
    describeBankAccountChange(
      { bank_account_number: '1234567890', bank_name: '台灣銀行' },
      { bank_account_number: '5555566666', bank_name: '台灣銀行', bank_branch: '信義分行' },
    ),
    [
      { field: 'bank_branch', label: '分行', from: '（空白）', to: '信義分行' },
      { field: 'bank_account_number', label: '帳號', from: '123••••890', to: '555••••666' },
    ],
  );
});

test('isLockedDocumentError 只認 DB 鎖定規則丟出的錯', () => {
  assert.equal(isLockedDocumentError({ code: '42501', message: '身分證照片已鎖定，如需修改，請於講師群組提出。' }), true);
  assert.equal(isLockedDocumentError({ code: '42501', message: 'new row violates row-level security policy' }), false);
  assert.equal(isLockedDocumentError(null), false);
});
