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
  isMinorOn,
  isSha256Hex,
  safeDownloadName,
  sha256Hex,
  sha256HexOfBlob,
  shortHash,
  summarizeIntegrity,
  taipeiToday,
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
    MINOR_REQUIRES_GUARDIAN: 'minor',
    INVALID_INPUT: null,
    CONSENT_TEXT_UNKNOWN: null,
    CONSENT_RATE_LIMITED: null,
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

test('未成年判斷：生日前一天、當天、隔天（出生日當天滿 18 歲）', () => {
  // 2008-10-22 出生 → 2026-10-22 滿 18 歲
  assert.equal(isMinorOn('2008-10-23', '2026-10-22'), true); // 差一天，還沒滿
  assert.equal(isMinorOn('2008-10-22', '2026-10-22'), false); // 剛好今天滿 18
  assert.equal(isMinorOn('2008-10-21', '2026-10-22'), false); // 昨天就滿了
  // 換個角度：同一個人在 18 歲生日前一天、當天、隔天
  assert.equal(isMinorOn('2008-10-22', '2026-10-21'), true);
  assert.equal(isMinorOn('2008-10-22', '2026-10-22'), false);
  assert.equal(isMinorOn('2008-10-22', '2026-10-23'), false);
  // 年底與年初
  assert.equal(isMinorOn('2008-12-31', '2026-12-30'), true);
  assert.equal(isMinorOn('2008-12-31', '2026-12-31'), false);
  assert.equal(isMinorOn('2009-01-01', '2026-12-31'), true);
  assert.equal(isMinorOn('2009-01-01', '2027-01-01'), false);
  // 明顯的成年與未成年
  assert.equal(isMinorOn('1992-02-02', '2026-10-22'), false);
  assert.equal(isMinorOn('2015-05-05', '2026-10-22'), true);
});

test('未成年判斷：閏年 2/29 出生者，滿 18 歲那年不是閏年，3/1 才算成年', () => {
  // 2008-02-29 出生 → 2026 不是閏年
  assert.equal(isMinorOn('2008-02-29', '2026-02-27'), true);
  assert.equal(isMinorOn('2008-02-29', '2026-02-28'), true); // 2/28 還沒滿（保守）
  assert.equal(isMinorOn('2008-02-29', '2026-03-01'), false); // 3/1 成年
  assert.equal(isMinorOn('2008-02-29', '2026-03-02'), false);
  // 閏日當天本身是合法日期；平年的 2/29 不存在 → 格式錯當成沒有出生日期
  assert.equal(isMinorOn('2008-02-29', '2008-02-29'), true);
  assert.equal(isMinorOn('2026-02-29', '2026-10-22'), false);
  // 其他人在閏年當天滿 18 歲：2006-02-28 出生，2024-02-29（閏年）已成年
  assert.equal(isMinorOn('2006-02-28', '2024-02-27'), true);
  assert.equal(isMinorOn('2006-02-28', '2024-02-28'), false);
  assert.equal(isMinorOn('2006-03-01', '2024-02-29'), true);
  assert.equal(isMinorOn('2006-03-01', '2024-03-01'), false);
});

test('未成年判斷：沒有出生日期或格式不對一律當成年（資料完整度另外管），帶時間尾巴也能讀', () => {
  assert.equal(isMinorOn(null, '2026-10-22'), false);
  assert.equal(isMinorOn(undefined, '2026-10-22'), false);
  assert.equal(isMinorOn('', '2026-10-22'), false);
  assert.equal(isMinorOn('不是日期', '2026-10-22'), false);
  assert.equal(isMinorOn('2010-13-40', '2026-10-22'), false);
  assert.equal(isMinorOn('2010-06-15T00:00:00+00:00', '2026-10-22'), true);
  assert.equal(isMinorOn('2008-10-22', null), false); // 今天的日期壞掉時不擋（資料庫才是防線）
});

test('台北今天：UTC 傍晚已經是台北隔天，預設用台北日期判斷', () => {
  assert.equal(taipeiToday(new Date('2026-10-21T16:00:00Z')), '2026-10-22');
  assert.equal(taipeiToday(new Date('2026-10-21T15:59:59Z')), '2026-10-21');
  // 不給 today 時用台北今天：在台北 10/22 當天，2008-10-22 出生者剛好成年
  assert.equal(isMinorOn('2008-10-22', taipeiToday(new Date('2026-10-21T16:00:00Z'))), false);
  assert.equal(isMinorOn('2008-10-22', taipeiToday(new Date('2026-10-21T15:59:59Z'))), true);
});

test('未成年的錯誤代碼提示：不直接丟英文代碼，文字中性', () => {
  const info = describeContractRpcError({ message: 'MINOR_REQUIRES_GUARDIAN' });
  assert.equal(info.code, 'MINOR_REQUIRES_GUARDIAN');
  assert.equal(info.action, 'minor');
  assert.ok(info.message.includes('法定代理人') && info.message.includes('紙本簽約'));
  assert.ok(!info.message.includes('MINOR_REQUIRES_GUARDIAN'));
});
