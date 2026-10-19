import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildDocEntries,
  compareHashMaps,
  consentDecisionLabel,
  contractStatusLabel,
  deliveryKindLabel,
  deliveryStatusLabel,
  describeContractRpcError,
  formatTaipeiTime,
  isSha256Hex,
  safeDownloadName,
  sha256Hex,
  sha256HexOfBlob,
  shortHash,
  summarizeIntegrity,
} from './esign.js';

test('SHA-256 與 Node crypto 算出的結果一致，輸出為 64 位小寫 hex', async () => {
  const bytes = new TextEncoder().encode('夢想一號 contract');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const actual = await sha256Hex(bytes);
  assert.equal(actual, expected);
  assert.equal(isSha256Hex(actual), true);
  assert.equal(await sha256Hex(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), expected);
  assert.equal(await sha256HexOfBlob(new Blob([bytes])), expected);
  // 空檔案的已知雜湊
  assert.equal(await sha256Hex(new Uint8Array()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256Hex 只收二進位資料，傳字串會明確失敗而不是默默算錯', async () => {
  await assert.rejects(() => sha256Hex('字串'), TypeError);
});

test('isSha256Hex 只接受 64 位小寫 hex', () => {
  assert.equal(isSha256Hex('a'.repeat(64)), true);
  assert.equal(isSha256Hex('A'.repeat(64)), false);
  assert.equal(isSha256Hex('a'.repeat(63)), false);
  assert.equal(isSha256Hex('g'.repeat(64)), false);
  assert.equal(isSha256Hex(null), false);
});

test('簽約送出的錯誤代碼都有白話訊息與下一步', () => {
  const expectations = {
    OTP_REQUIRED: 'otp',
    OTP_EXPIRED: 'otp',
    OTP_ALREADY_USED: 'otp',
    CONSENT_REQUIRED: 'consent',
    DOC_VERSION_MISMATCH: 'reload',
    DOC_HASH_MISMATCH: 'reload',
    INVALID_HASH: null,
    ACCOUNT_NOT_ACTIVE: 'activate',
    FILE_NOT_UPLOADED: null,
    SIGNED_PDF_MISSING: null,
    NO_ACTIVE_DOCUMENTS: 'reload',
    INVALID_INPUT: null,
    CONSENT_TEXT_UNKNOWN: null,
  };
  for (const [code, action] of Object.entries(expectations)) {
    const result = describeContractRpcError({ message: `${code}` });
    assert.equal(result.code, code);
    assert.equal(result.action, action, code);
    assert.ok(!result.message.includes(code), `${code} 不應把英文代碼直接丟給使用者`);
    assert.match(result.message, /[一-鿿]/, code);
  }
  assert.equal(describeContractRpcError({ message: 'DOC_VERSION_MISMATCH' }).message, '契約剛更新版本，請重新閱讀後再簽。');
  // 代碼夾在較長的訊息裡也要認得
  assert.equal(describeContractRpcError({ message: 'raise exception: OTP_EXPIRED (ctx)' }).code, 'OTP_EXPIRED');
});

test('未知錯誤與網路錯誤', () => {
  assert.equal(describeContractRpcError({ message: 'Failed to fetch' }).code, 'NETWORK');
  const unknown = describeContractRpcError({ message: 'weird' });
  assert.equal(unknown.code, 'UNKNOWN');
  assert.equal(unknown.action, null);
  assert.match(unknown.message, /簽約送出失敗/);
  assert.equal(describeContractRpcError(null).code, 'UNKNOWN');
});

test('文件清單：依步驟順序、只列有版本的文件', () => {
  const steps = [
    { docType: 'contract', title: '講師合作契約' },
    { docType: 'rules', title: '講師管理辦法' },
    { docType: 'x', title: '沒版本的' },
  ];
  assert.deepEqual(
    buildDocEntries(steps, { rules: 2, contract: 3 }),
    [{ title: '講師合作契約', version: 3 }, { title: '講師管理辦法', version: 2 }],
  );
  assert.deepEqual(buildDocEntries(null, null), []);
});

test('台北時間顯示：UTC 換算 +8，午夜不會變成 24 點', () => {
  assert.equal(formatTaipeiTime('2026-10-20T06:03:09Z'), '2026-10-20 14:03（台北時間）');
  assert.equal(formatTaipeiTime('2026-10-20T06:03:09Z', { seconds: true }), '2026-10-20 14:03:09（台北時間）');
  assert.equal(formatTaipeiTime('2026-10-20T16:00:00Z'), '2026-10-21 00:00（台北時間）');
  assert.equal(formatTaipeiTime(''), '');
  assert.equal(formatTaipeiTime('不是時間'), '');
});

test('合約狀態與下載檔名', () => {
  assert.equal(contractStatusLabel('signed'), '有效');
  assert.equal(contractStatusLabel('voided'), '已作廢');
  assert.equal(contractStatusLabel(undefined), '—');
  assert.equal(safeDownloadName('講師/合約', ' 王小明 ', '', null, 'v3.pdf'), '講師-合約_王小明_v3.pdf');
});

test('雜湊表比對：一致、不一致、缺少', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.deepEqual(compareHashMaps({ contract: a }, { contract: a }), { ok: true, mismatched: [], missing: [] });
  assert.deepEqual(compareHashMaps({ contract: a }, { contract: a.toUpperCase() }).ok, true);
  assert.deepEqual(compareHashMaps({ contract: a, rules: a }, { contract: b }), { ok: false, mismatched: ['contract'], missing: ['rules'] });
  assert.equal(compareHashMaps(null, null).ok, true);
});

test('完整性彙整：全部一致才算通過；沒有任何檢查項目不算通過', () => {
  assert.deepEqual(summarizeIntegrity([{ label: 'a', ok: true }, { label: 'b', ok: true }]), { ok: true, total: 2, failed: [] });
  assert.deepEqual(summarizeIntegrity([{ label: 'a', ok: true }, { label: 'b', ok: false }]), { ok: false, total: 2, failed: ['b'] });
  assert.equal(summarizeIntegrity([]).ok, false);
  assert.equal(summarizeIntegrity(null).ok, false);
});

test('證據顯示用的白話標籤與雜湊縮寫', () => {
  assert.equal(consentDecisionLabel('agree_electronic'), '同意使用線上簽約');
  assert.equal(consentDecisionLabel('decline_electronic'), '不同意，改以紙本簽約');
  assert.equal(deliveryStatusLabel('not_configured'), '未設定寄信金鑰');
  assert.equal(deliveryStatusLabel('sent'), '已送出');
  assert.equal(deliveryKindLabel('contract_signed_copy'), '簽署完成通知');
  assert.equal(deliveryKindLabel('其他'), '其他');
  const hash = 'a'.repeat(32) + 'b'.repeat(32);
  assert.equal(shortHash(hash), `${'a'.repeat(10)}…${'b'.repeat(8)}`);
  assert.equal(shortHash('abc'), 'abc');
  assert.equal(shortHash(null), '');
});
