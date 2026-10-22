/*
 * 電子簽約相關文案（單一來源）。
 *
 * 來源：docs/specs/2026-10-20-esign-legal-copy.md §5（法規顧問 2026-10-20 定稿）。
 * 規則（同檔 §1）：
 *   1. 同意紀錄存「講師當下實際看到的全文」（佔位符已填入實際值），不存範本。
 *   2. 改一個字就升版（-v1 → -v2），舊版全文要保留，方便還原「當時講師看到什麼」。
 *   3. 勾選框不可預先打勾；同意／不同意兩顆按鈕一樣大、一樣醒目。
 *   4. 標【待業主確認】的地方照預設文字上線，業主決定後升版。
 *   5. 絕對不可宣稱「線上簽名與紙本簽約效力相同」這類法律結論（法遵紅燈 R1，舊勾選句已移除）；
 *      也不可把驗證碼稱為「電子簽章」。
 *
 * 文案內的粗體以 ⟪文字⟫ 標記（不用 ** 是因為遮罩信箱 ab***@x.com 本身含星號），
 * 畫面端用 splitEsignInline() 切開後轉成 <strong>。
 */

// 取自 src/pages/PrivacyPolicy.jsx（法規顧問標【待業主核對是否與登記名稱完全一致】）
export const ESIGN_COMPANY_NAME = '夢想一號文化教育股份有限公司';
export const ESIGN_CONTACT_EMAIL = 'hi@dreamcube.tw';

// 傳給 record_contract_consent 的 p_consent_text_version，以及存證用的版本代碼。
export const ESIGN_COPY_VERSIONS = Object.freeze({
  readAck: 'esign-read-ack-v1',
  consent: 'esign-consent-v1',
  declinePaper: 'esign-decline-paper-v1',
  minorPaper: 'esign-minor-paper-v1', // 未滿 18 歲講師的「請改以紙本簽約」說明（2026-10-22，法遵紅燈 R3）
  finalConfirm: 'esign-final-confirm-v1',
  privacyNotice: 'esign-privacy-notice-v1',
  signedEmail: 'esign-signed-email-v1', // 寄信用，資料庫端使用；前端只放常數
  otpEmail: 'esign-otp-email-v1', // 寄信用，資料庫端使用；前端只放常數
});

// 簽約 OTP 驗證通過後須在這段時間內送出（伺服器為準；這裡只用來提醒）。
export const CONTRACT_OTP_VALID_MINUTES = 15;

const BOLD_START = '⟪';
const BOLD_END = '⟫';

const FALLBACK_MASKED_EMAIL = '本公司已確認的你的信箱';

/** 把 {{key}} 換成實際值；缺值時保留原樣以便測試抓出漏填。 */
export const fillPlaceholders = (template, values) => String(template).replace(
  /\{\{(\w+)\}\}/g,
  (whole, key) => (values && values[key] !== undefined && values[key] !== null ? String(values[key]) : whole),
);

/**
 * {{doc_list}}：依 doc_versions 組成，例「講師合作契約（第 3 版）、講師管理辦法（第 2 版）」。
 * @param {{ title: string, version: number|string }[]} docs 依簽約順序
 */
export const formatDocList = (docs) => (docs || [])
  .filter((doc) => doc && doc.title)
  .map((doc) => `${doc.title}（第 ${doc.version} 版）`)
  .join('、');

/** 把 ⟪粗體⟫ 標記切成片段，畫面端決定怎麼渲染。 */
export const splitEsignInline = (text) => String(text)
  .split(/([⟪⟫])/)
  .reduce((parts, token) => {
    if (token === BOLD_START) parts.bold = true;
    else if (token === BOLD_END) parts.bold = false;
    else if (token !== '') parts.items.push({ text: token, bold: parts.bold });
    return parts;
  }, { items: [], bold: false })
  .items;

const commonValues = ({ docList, maskedEmail, instructorName }) => ({
  company_name: ESIGN_COMPANY_NAME,
  contact_email: ESIGN_CONTACT_EMAIL,
  doc_list: docList || '',
  masked_email: maskedEmail || FALLBACK_MASKED_EMAIL,
  instructor_name: instructorName || '',
});

// ── a0. esign-read-ack-v1：簽署頁「已完整閱讀」勾選（取代舊的第一個勾選句） ──
const READ_ACK_TEMPLATE = '我已完整閱讀並了解 {{doc_list}} 的內容。';

export const buildReadAck = ({ docList }) => ({
  version: ESIGN_COPY_VERSIONS.readAck,
  label: fillPlaceholders(READ_ACK_TEMPLATE, commonValues({ docList })),
});

// ── a. esign-consent-v1：電子簽約同意頁 ──
const CONSENT_TITLE = '選擇簽約方式';
const CONSENT_PARAGRAPH_TEMPLATES = [
  '這次要簽的文件是：{{doc_list}}。你可以在上一步下載這些文件。',
  '{{company_name}}（以下稱「本公司」）提供⟪線上簽約⟫，讓你不必寄送紙本。流程是：系統寄一組 Email 驗證碼到本公司已確認的你的信箱（{{masked_email}}），確認是你本人操作；你在畫面上手寫簽名，按下「確認簽署」後完成。完成後系統會產生已簽署的 PDF 檔，你可以隨時登入下載。',
  '⟪要不要用線上簽約，由你決定。⟫你也可以選擇紙本簽約，兩種方式簽的是同一個版本的文件。',
  '選擇線上簽約後，如果你之後想改回紙本（例如之後的契約修訂或續約），隨時可以用 Email、LINE 或口頭告訴本公司行政人員；改回紙本之前已經完成的線上簽署，效力不受影響。',
  '為了證明簽約事實，系統會保存以下紀錄：你的帳號與 Email、你看到的文件版本與檔案指紋（SHA-256）、你在本頁的選擇與時間、Email 驗證時間、簽署時間、IP 位址、裝置與瀏覽器資訊、你的簽名影像、已簽署 PDF 的檔案指紋，以及通知信的寄送紀錄。你可以隨時向本公司索取已簽署文件的副本（電子檔或紙本）。',
];
const CONSENT_CHECKBOX_LABEL = '我已閱讀上述說明，同意以電子文件及線上簽署方式（Email 驗證碼＋線上手寫簽名）簽訂本次契約。我了解簽署紀錄會被保存作為簽約證明，也可以隨時索取副本。';
const CONSENT_AGREE_BUTTON = '同意，使用線上簽約';
const CONSENT_DECLINE_BUTTON = '不同意，改以紙本簽約';

// ── d. esign-privacy-notice-v1：同意頁內的個資蒐集告知（預設展開） ──
const PRIVACY_TITLE = '個人資料蒐集告知（電子簽約）';
const PRIVACY_INTRO_TEMPLATE = '{{company_name}} 依《個人資料保護法》第 8 條告知：';
const PRIVACY_ITEM_TEMPLATES = [
  '⟪目的⟫：訂定、履行及管理講師合作契約；證明簽約事實、處理契約爭議；辦理報酬給付及相關稅務申報。',
  '⟪資料類別⟫：姓名、身分證統一編號、地址、電話、Email、帳號識別資料、講師等級；簽名影像；簽署紀錄（文件版本與檔案指紋、同意與驗證時間、簽署時間、IP 位址、裝置與瀏覽器資訊、通知信寄送紀錄）。',
  '⟪期間⟫：合作期間，以及合作結束後 15 年；法令規定更長保存期間的，依法令規定。',
  '⟪地區⟫：中華民國，以及本公司委託的雲端資料庫、檔案儲存與電子郵件寄送服務提供服務的地區（可能在中華民國境外）。',
  '⟪對象⟫：本公司負責合約與行政的授權人員；本公司委託處理資料的資訊服務商（雲端資料庫與檔案儲存、電子郵件寄送）；依法有權調閱的機關（例如法院、稅捐機關）。',
  '⟪方式⟫：以電子方式蒐集、儲存、產生簽署文件、寄送通知，並依職務限制存取權限。',
  '⟪你的權利⟫：你可以請求查詢、閱覽、製給複製本、補充或更正、停止蒐集處理利用，或刪除你的個人資料，請寄信至 {{contact_email}}。保存期間內，如果資料是證明簽約事實或處理契約爭議所必需，本公司可能依法暫不刪除，並會向你說明原因。',
  '⟪不提供的影響⟫：不提供上述資料或不同意保存簽署紀錄，就無法完成線上簽約；你可以改用紙本簽約（紙本契約仍需填寫姓名、身分證字號、地址、電話）。',
];
const PRIVACY_OUTRO = '完整說明請見〈隱私權政策〉。';

export const buildPrivacyNotice = () => {
  const values = commonValues({});
  return {
    version: ESIGN_COPY_VERSIONS.privacyNotice,
    title: PRIVACY_TITLE,
    intro: fillPlaceholders(PRIVACY_INTRO_TEMPLATE, values),
    items: PRIVACY_ITEM_TEMPLATES.map((item) => fillPlaceholders(item, values)),
    outro: PRIVACY_OUTRO,
  };
};

export const buildConsentCopy = ({ docList, maskedEmail }) => {
  const values = commonValues({ docList, maskedEmail });
  return {
    version: ESIGN_COPY_VERSIONS.consent,
    title: CONSENT_TITLE,
    paragraphs: CONSENT_PARAGRAPH_TEMPLATES.map((paragraph) => fillPlaceholders(paragraph, values)),
    checkboxLabel: CONSENT_CHECKBOX_LABEL,
    agreeButton: CONSENT_AGREE_BUTTON,
    declineButton: CONSENT_DECLINE_BUTTON,
    privacy: buildPrivacyNotice(),
  };
};

// ── b. esign-decline-paper-v1：按「不同意，改以紙本簽約」後的確認視窗 ──
// 業主 2026-10-22 授權主對話定案：照預設文字上線，不加 N 個工作天與「不影響合作資格」承諾。
// （原標【待業主確認】的三件事：幾個工作天內聯繫、紙本提供方式、是否承諾不影響合作資格與權益；
//   都不寫，也不暗示選紙本會比較慢或吃虧。之後要改文字就升版 -v2。）
const DECLINE_TITLE = '改以紙本簽約';
const DECLINE_INTRO = '你可以不使用線上簽約，這是你的權利。選擇紙本簽約不代表你不同意契約內容。';
const DECLINE_STEP_TEMPLATES = [
  '系統會記錄你選擇紙本簽約，並通知本公司行政人員。',
  '行政人員會主動和你聯繫，安排紙本簽約。',
  '紙本契約和線上版本是同一個版本：{{doc_list}}。',
  '紙本簽署完成前，網站上的簽約狀態會顯示「紙本簽約處理中」。',
];
const DECLINE_OUTRO_TEMPLATE = '如果之後改變主意想改用線上簽約，請聯絡 {{contact_email}}。';
const DECLINE_CONFIRM_BUTTON = '確認改以紙本簽約';
const DECLINE_BACK_BUTTON = '返回';

export const buildDeclineCopy = ({ docList }) => {
  const values = commonValues({ docList });
  return {
    version: ESIGN_COPY_VERSIONS.declinePaper,
    title: DECLINE_TITLE,
    intro: DECLINE_INTRO,
    lead: '確認後：',
    steps: DECLINE_STEP_TEMPLATES.map((step) => fillPlaceholders(step, values)),
    outro: fillPlaceholders(DECLINE_OUTRO_TEMPLATE, values),
    confirmButton: DECLINE_CONFIRM_BUTTON,
    backButton: DECLINE_BACK_BUTTON,
  };
};

// ── g. esign-minor-paper-v1：未滿 18 歲講師的簽約方式說明（2026-10-22，法遵紅燈 R3，業主授權主對話定案） ──
// 未滿 18 歲不能線上簽約，同意頁不顯示同意按鈕，改顯示這份說明＋一顆「改以紙本簽約」。
// 按鈕走既有的「不同意」流程（record_contract_consent decline、紙本處理中畫面），但記錄的是本版文案，
// 所以資料庫 esign_text_versions 也種入同一份全文（逐字一致，esignCopy.test.js 核對）。
// 措辭中性、不嚇人、不宣稱法律結論；個資告知照常顯示（同意與不同意都存，見 esign-privacy-notice-v1）。
const MINOR_TITLE = '請改以紙本簽約';
const MINOR_PARAGRAPH_TEMPLATES = [
  '這次要簽的文件是：{{doc_list}}。',
  '依民法規定，未滿 18 歲簽訂契約需要法定代理人（通常是父母）同意。為保障你的權益，請改以紙本簽約，由你和法定代理人一起簽名。',
  '按下方按鈕後，行政人員會和你聯繫。',
  '系統是依你個人資料裡的出生日期判斷的。如果出生日期登錄有誤，請寄信到 {{contact_email}}。',
];
const MINOR_PAPER_BUTTON = '改以紙本簽約';

export const buildMinorPaperCopy = ({ docList }) => {
  const values = commonValues({ docList });
  return {
    version: ESIGN_COPY_VERSIONS.minorPaper,
    title: MINOR_TITLE,
    paragraphs: MINOR_PARAGRAPH_TEMPLATES.map((paragraph) => fillPlaceholders(paragraph, values)),
    paperButton: MINOR_PAPER_BUTTON,
    privacy: buildPrivacyNotice(),
  };
};

// 選擇紙本之後的「處理中」畫面（承接 b 段第 1～4 點，不新增法律承諾）。
// 未滿 18 歲：不提「改變主意改用線上簽約」（那條路現在走不通），改提醒紙本簽約要和法定代理人一起簽。
export const buildPaperPendingCopy = ({ docList, minor = false }) => {
  const values = commonValues({ docList });
  const body = [
    '系統已記錄你選擇紙本簽約，並已通知本公司行政人員。',
    '行政人員會主動和你聯繫，安排紙本簽約。',
    fillPlaceholders('紙本契約和線上版本是同一個版本：{{doc_list}}。', values),
  ];
  if (minor) body.push('紙本簽約時，請由你和法定代理人（通常是父母）一起簽名。');
  body.push('紙本簽署完成前，網站上的簽約狀態會顯示「紙本簽約處理中」。');
  if (!minor) body.push(fillPlaceholders('如果之後改變主意想改用線上簽約，請聯絡 {{contact_email}}。', values));
  return { title: '已記錄：改以紙本簽約', body };
};

// ── c. esign-final-confirm-v1：「確認簽署」按鈕正上方 ──
const FINAL_CONFIRM_LEAD = '按下「確認簽署」，即表示：';
const FINAL_CONFIRM_ITEM_TEMPLATES = [
  '我是 {{instructor_name}} 本人，簽名是我親自在本畫面完成的；',
  '我已閱讀並同意 {{doc_list}} 的全部內容，並以上方的簽名簽署這些文件；',
  '我填寫的姓名、身分證字號、地址、電話正確無誤。',
];
const FINAL_CONFIRM_OUTRO_TEMPLATE = '簽署完成後，簽署時間以系統伺服器時間（台北時間）為準，已簽署的文件不能自行修改或撤回；如有錯誤，請聯絡 {{contact_email}}。';
const FINAL_CONFIRM_BUTTON = '確認簽署';

export const buildFinalConfirm = ({ instructorName, docList }) => {
  const values = commonValues({ instructorName, docList });
  return {
    version: ESIGN_COPY_VERSIONS.finalConfirm,
    lead: FINAL_CONFIRM_LEAD,
    items: FINAL_CONFIRM_ITEM_TEMPLATES.map((item) => fillPlaceholders(item, values)),
    outro: fillPlaceholders(FINAL_CONFIRM_OUTRO_TEMPLATE, values),
    button: FINAL_CONFIRM_BUTTON,
  };
};

// ── e / f. 寄信用文案：資料庫端寄信時使用，前端只保留版本代碼與主旨供對照 ──
export const SIGNED_EMAIL_SUBJECT = '【夢想一號】講師合作契約簽署完成通知';

/** 去掉粗體標記，存進 consent_text 的純文字。 */
const plain = (text) => String(text).replaceAll(BOLD_START, '').replaceAll(BOLD_END, '');

/**
 * 「講師當下實際看到的全文」（佔位符已填入實際值）。
 * 同意紀錄的 consent_text 應存這份；見 docs/specs 法遵檔 §1 規則 1。
 * 同意與不同意各自對應當下實際顯示的畫面：同意＝同意頁（含個資告知），不同意＝同意頁＋確認視窗。
 */
export const buildConsentText = ({ docList, maskedEmail, decision }) => {
  const consent = buildConsentCopy({ docList, maskedEmail });
  const lines = [
    `[${consent.version}] ${consent.title}`,
    ...consent.paragraphs.map(plain),
    `☐ ${consent.checkboxLabel}`,
    `[按鈕] ${consent.agreeButton}｜${consent.declineButton}`,
    '',
    `[${consent.privacy.version}] ${consent.privacy.title}`,
    consent.privacy.intro,
    ...consent.privacy.items.map((item) => `- ${plain(item)}`),
    consent.privacy.outro,
  ];
  if (decision === 'decline_electronic') {
    const decline = buildDeclineCopy({ docList });
    lines.push(
      '',
      `[${decline.version}] ${decline.title}`,
      decline.intro,
      decline.lead,
      ...decline.steps.map((step, index) => `${index + 1}. ${step}`),
      decline.outro,
      `[按鈕] ${decline.confirmButton}｜${decline.backButton}`,
    );
  }
  return lines.join('\n');
};
