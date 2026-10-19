import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  CONTRACT_OTP_VALID_MINUTES,
  ESIGN_COMPANY_NAME,
  ESIGN_CONTACT_EMAIL,
  ESIGN_COPY_VERSIONS,
  buildConsentCopy,
  buildConsentText,
  buildDeclineCopy,
  buildFinalConfirm,
  buildPaperPendingCopy,
  buildPrivacyNotice,
  buildReadAck,
  fillPlaceholders,
  formatDocList,
  splitEsignInline,
} from './esignCopy.js';

const DOC_LIST = formatDocList([
  { title: '講師合作契約', version: 3 },
  { title: '講師管理辦法', version: 2 },
  { title: '講師報酬表', version: 5 },
]);

const allCopy = () => [
  buildReadAck({ docList: DOC_LIST }).label,
  ...Object.values(buildConsentCopy({ docList: DOC_LIST, maskedEmail: 'ab***@gmail.com' }))
    .flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])),
  ...Object.values(buildDeclineCopy({ docList: DOC_LIST })).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])),
  ...Object.values(buildFinalConfirm({ instructorName: '王小明', docList: DOC_LIST })).flatMap((value) => (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])),
  ...buildPaperPendingCopy({ docList: DOC_LIST }).body,
  buildConsentText({ docList: DOC_LIST, maskedEmail: 'ab***@gmail.com', decision: 'decline_electronic' }),
];

test('版本代碼就是法規顧問定稿的 7 個', () => {
  assert.deepEqual(Object.values(ESIGN_COPY_VERSIONS).sort(), [
    'esign-consent-v1',
    'esign-decline-paper-v1',
    'esign-final-confirm-v1',
    'esign-otp-email-v1',
    'esign-privacy-notice-v1',
    'esign-read-ack-v1',
    'esign-signed-email-v1',
  ]);
});

test('文件清單格式：名稱（第 N 版），頓號分隔', () => {
  assert.equal(DOC_LIST, '講師合作契約（第 3 版）、講師管理辦法（第 2 版）、講師報酬表（第 5 版）');
  assert.equal(formatDocList([]), '');
});

test('所有文案的佔位符都已填入，沒有殘留 {{ }}，也沒有待業主確認的內部註記', () => {
  for (const text of allCopy()) {
    assert.ok(!text.includes('{{'), `殘留佔位符：${text.slice(0, 40)}`);
    assert.ok(!text.includes('待業主確認'), `不可把內部註記顯示給講師：${text.slice(0, 40)}`);
  }
});

test('紅燈 R1：不得出現「具備一樣的法律效力」類的法律結論，也不得把驗證碼稱為電子簽章', () => {
  for (const text of allCopy()) {
    assert.ok(!/一樣的法律效力/.test(text), text.slice(0, 40));
    assert.ok(!/同等法律效力|相同法律效力|等同實體簽/.test(text), text.slice(0, 40));
    assert.ok(!/驗證碼[^。]*電子簽章/.test(text), text.slice(0, 40));
  }
});

test('同意頁：說明含文件清單與遮罩信箱，勾選句與兩個按鈕文字就是定稿原文', () => {
  const consent = buildConsentCopy({ docList: DOC_LIST, maskedEmail: 'ab***@gmail.com' });
  assert.equal(consent.version, 'esign-consent-v1');
  assert.equal(consent.title, '選擇簽約方式');
  assert.ok(consent.paragraphs[0].includes(DOC_LIST));
  assert.ok(consent.paragraphs[1].includes('ab***@gmail.com'));
  assert.ok(consent.paragraphs[1].includes(ESIGN_COMPANY_NAME));
  assert.ok(consent.paragraphs[2].includes('要不要用線上簽約，由你決定'));
  assert.equal(consent.agreeButton, '同意，使用線上簽約');
  assert.equal(consent.declineButton, '不同意，改以紙本簽約');
  assert.match(consent.checkboxLabel, /^我已閱讀上述說明，同意以電子文件及線上簽署方式/);
  assert.equal(consent.privacy.version, 'esign-privacy-notice-v1');
  assert.equal(consent.privacy.items.length, 8);
});

test('同意頁：沒有遮罩信箱時有可讀的後備文字', () => {
  const consent = buildConsentCopy({ docList: DOC_LIST, maskedEmail: null });
  assert.ok(consent.paragraphs[1].includes('本公司已確認的你的信箱'));
});

test('個資告知含法定六項加上權利與不提供的影響，聯絡信箱已填入', () => {
  const notice = buildPrivacyNotice();
  const joined = notice.items.join('\n');
  ['目的', '資料類別', '期間', '地區', '對象', '方式', '你的權利', '不提供的影響'].forEach((label) => {
    assert.ok(joined.includes(`⟪${label}⟫`), label);
  });
  assert.ok(joined.includes(ESIGN_CONTACT_EMAIL));
  assert.ok(notice.intro.includes('第 8 條'));
});

test('紙本確認視窗：四點說明、是同一版文件、不夾帶「不影響合作資格」之類業主尚未決定的承諾', () => {
  const decline = buildDeclineCopy({ docList: DOC_LIST });
  assert.equal(decline.version, 'esign-decline-paper-v1');
  assert.equal(decline.steps.length, 4);
  assert.ok(decline.steps[2].includes(DOC_LIST));
  assert.equal(decline.confirmButton, '確認改以紙本簽約');
  assert.equal(decline.backButton, '返回');
  assert.ok(decline.outro.includes(ESIGN_CONTACT_EMAIL));
  const joined = [decline.intro, ...decline.steps, decline.outro].join('\n');
  assert.ok(!/不會影響.*(資格|權益)/.test(joined));
});

test('最後確認句：帶入講師姓名與文件清單，並說明時間以伺服器為準', () => {
  const finalConfirm = buildFinalConfirm({ instructorName: '王小明', docList: DOC_LIST });
  assert.equal(finalConfirm.version, 'esign-final-confirm-v1');
  assert.equal(finalConfirm.lead, '按下「確認簽署」，即表示：');
  assert.ok(finalConfirm.items[0].includes('王小明'));
  assert.ok(finalConfirm.items[1].includes(DOC_LIST));
  assert.ok(finalConfirm.outro.includes('伺服器時間（台北時間）'));
  assert.equal(finalConfirm.button, '確認簽署');
});

test('已閱讀勾選句取代舊的「皆可遵守並配合」', () => {
  const ack = buildReadAck({ docList: DOC_LIST });
  assert.equal(ack.version, 'esign-read-ack-v1');
  assert.equal(ack.label, `我已完整閱讀並了解 ${DOC_LIST} 的內容。`);
  assert.ok(!ack.label.includes('遵守並配合'));
});

test('consent_text 存講師當下實際看到的全文：同意版含同意頁與個資告知，不同意版另含確認視窗', () => {
  const agree = buildConsentText({ docList: DOC_LIST, maskedEmail: 'ab***@gmail.com', decision: 'agree_electronic' });
  assert.ok(agree.includes('[esign-consent-v1]'));
  assert.ok(agree.includes('[esign-privacy-notice-v1]'));
  assert.ok(agree.includes('ab***@gmail.com'));
  assert.ok(!agree.includes('⟪') && !agree.includes('⟫'));
  assert.ok(!agree.includes('[esign-decline-paper-v1]'));

  const decline = buildConsentText({ docList: DOC_LIST, maskedEmail: 'ab***@gmail.com', decision: 'decline_electronic' });
  assert.ok(decline.includes('[esign-decline-paper-v1]'));
  assert.ok(decline.length > agree.length);
});

test('佔位符工具：缺值時保留原樣，粗體標記可切開', () => {
  assert.equal(fillPlaceholders('嗨 {{a}} 與 {{b}}', { a: 'X' }), '嗨 X 與 {{b}}');
  assert.deepEqual(splitEsignInline('前⟪粗⟫後'), [
    { text: '前', bold: false },
    { text: '粗', bold: true },
    { text: '後', bold: false },
  ]);
  assert.deepEqual(splitEsignInline('無粗體'), [{ text: '無粗體', bold: false }]);
  // 遮罩信箱本身含星號，不可被當成粗體標記吃掉
  assert.deepEqual(splitEsignInline('信箱 ab***@gmail.com'), [{ text: '信箱 ab***@gmail.com', bold: false }]);
});

test('簽約 OTP 驗證通過後的有效期為 15 分鐘（與規格一致）', () => {
  assert.equal(CONTRACT_OTP_VALID_MINUTES, 15);
});

// ── 與資料庫種入的文案核對 ─────────────────────────────────────
// 同意紀錄的 consent_text 由資料庫依版本代碼抄入（esign_text_versions）；畫面顯示的是 esignCopy.js。
// 兩邊任何一個字不同，就會變成「存證的文字不是講師看到的文字」。這裡逐字（忽略排版符號）核對。
const MIGRATION_URL = new URL('../../supabase/migrations/20261020100000_claim_activation_esign_evidence.sql', import.meta.url);
const readSeeds = () => {
  if (!existsSync(MIGRATION_URL)) return null;
  const sql = readFileSync(MIGRATION_URL, 'utf8');
  const seeds = {};
  for (const match of sql.matchAll(/\('(esign-[a-z-]+-v\d+)', \$t\$([\s\S]*?)\$t\$\)/g)) seeds[match[1]] = match[2];
  return seeds;
};
// 去掉排版：空白、項目符號、勾選框、按鈕括號、粗體標記、有序清單的編號
const normalize = (text) => String(text)
  .replace(/^\s*\d+\.\s*/gm, '')
  .replace(/[\s⟪⟫*\-☐［］[\]]/g, '');
const PLACEHOLDER_VALUES = { docList: '{{doc_list}}', maskedEmail: '{{masked_email}}', instructorName: '{{instructor_name}}' };

test('畫面文案與資料庫種入的法規文案逐字一致（同意頁、紙本確認、最後確認句、個資告知、已閱讀勾選）', (t) => {
  const seeds = readSeeds();
  if (!seeds) { t.skip('找不到 migration 檔，略過'); return; }

  const consent = buildConsentCopy(PLACEHOLDER_VALUES);
  const decline = buildDeclineCopy(PLACEHOLDER_VALUES);
  const finalConfirm = buildFinalConfirm(PLACEHOLDER_VALUES);
  const privacy = buildPrivacyNotice();
  const readAck = buildReadAck(PLACEHOLDER_VALUES);

  const screens = {
    'esign-consent-v1': [consent.title, ...consent.paragraphs, consent.checkboxLabel, consent.agreeButton, consent.declineButton],
    'esign-decline-paper-v1': [decline.title, decline.intro, decline.lead, ...decline.steps, decline.outro, decline.confirmButton, decline.backButton],
    'esign-final-confirm-v1': [finalConfirm.lead, ...finalConfirm.items, finalConfirm.outro, finalConfirm.button],
    'esign-privacy-notice-v1': [privacy.title, privacy.intro, ...privacy.items, privacy.outro],
    'esign-read-ack-v1': [readAck.label],
  };

  for (const [code, parts] of Object.entries(screens)) {
    assert.ok(seeds[code], `資料庫沒有種入 ${code}`);
    assert.equal(normalize(parts.join('\n')), normalize(seeds[code]), `${code} 畫面文案與資料庫文案不一致`);
  }
  // 寄信用的兩份只在資料庫使用，前端只要認得版本代碼
  assert.ok(seeds[ESIGN_COPY_VERSIONS.signedEmail] && seeds[ESIGN_COPY_VERSIONS.otpEmail]);
});
