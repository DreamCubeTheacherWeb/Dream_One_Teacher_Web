// 假帳號、REST 呼叫、種資料。所有寫入都走「正式路徑」：
//   * Google 帳號＝以 supabase_auth_admin 身分 INSERT auth.users，讓 handle_new_user trigger 照正式邏輯建 public.users；
//     建立前先以同一身分呼叫 Before User Created hook（正式環境 GoTrue 會做的事），被拒就不建。
//   * 管理員操作＝帶 admin JWT 打閘道的 /rest/v1 與 /storage/v1（RLS 與 trigger 照常檢查）。
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export function makeApi(stack) {
  const base = stack.supabaseUrl;
  const request = async (token, method, pathAndQuery, { body, prefer, headers = {}, raw } = {}) => {
    const res = await fetch(`${base}${pathAndQuery}`, {
      method,
      headers: {
        apikey: stack.anonKey,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { prefer } : {}),
        ...headers,
      },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  };
  return {
    request,
    rest: (token, method, table, opts) => request(token, method, `/rest/v1/${table}`, opts),
    rpc: (token, fn, args = {}) => request(token, 'POST', `/rest/v1/rpc/${fn}`, { body: args }),
    sql: (query, vars) => stack.db.psqlSync(query, { vars }).stdout,
    json: (query, vars) => stack.db.json(query, { vars }),
  };
}

let userCounter = 0;

export async function createGoogleUser(stack, { email, fullName, avatarUrl = '' }) {
  const id = randomUUID();
  const event = {
    user: {
      id, email, aud: 'authenticated', role: '',
      app_metadata: { provider: 'google', providers: ['google'] },
      user_metadata: { full_name: fullName, name: fullName, avatar_url: avatarUrl, email },
    },
  };
  const hook = stack.db.json(`
    SET ROLE supabase_auth_admin;
    SELECT public.hook_allow_known_google_signup(:'event'::jsonb);`, { vars: { event: JSON.stringify(event) } });
  if (hook?.error) return { id: null, email, hookRejected: hook.error };

  userCounter += 1;
  stack.db.psqlSync(`
    SET ROLE supabase_auth_admin;
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, email_confirmed_at, last_sign_in_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', :'id', 'authenticated', 'authenticated', :'email', now(), now(),
      :'app'::jsonb, :'meta'::jsonb, now(), now(), false, false
    );`, {
    vars: {
      id, email,
      app: JSON.stringify(event.user.app_metadata),
      meta: JSON.stringify({ ...event.user.user_metadata, iss: 'https://accounts.google.com', sub: `google-${userCounter}`, email_verified: true }),
    },
  });
  const session = await stack.gateway.issueSession(id);
  return { id, email, fullName, session, token: session.access_token };
}

// 真的 PNG（ProfilePage 只收圖片 MIME）：64×40 單色，尾端 tEXt 帶 label，讓每份檔案內容不同
export function samplePng(label = 'doc', color = [40, 90, 200]) {
  const width = 64;
  const height = 40;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(color, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('tEXt', Buffer.from(`Comment\0${label}`, 'latin1')),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return crc ^ 0xffffffff;
}

export async function makePdf(title, lines = []) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(title, { x: 60, y: 780, size: 22, font, color: rgb(0, 0, 0) });
  lines.forEach((line, index) => {
    page.drawText(line, { x: 60, y: 740 - index * 22, size: 12, font, color: rgb(0.2, 0.2, 0.2) });
  });
  return Buffer.from(await doc.save());
}

// 管理員、課程、合約文件（PDF 範本放假 storage＋欄位座標）
export async function seedBaseline(stack, api) {
  const runTag = Date.now().toString(36);
  api.sql(`INSERT INTO public.teacher_invites (name, email, role) VALUES ('E2E 管理員', :'email', 'admin')`, { email: `admin-${runTag}@e2e.test` });
  const admin = await createGoogleUser(stack, { email: `admin-${runTag}@e2e.test`, fullName: 'E2E 管理員' });
  const adminRole = api.sql(`SELECT role FROM public.users WHERE id = :'id'`, { id: admin.id });
  if (adminRole !== 'admin') throw new Error(`admin bootstrap failed (role=${adminRole})`);

  // 寄信設定（Supabase Vault 替身）：有這兩筆才會「寄出」OTP／通知信；測「未設定寄信金鑰」時會暫時拿掉
  setEmailConfigured(api, true);

  // 一門已發佈課程（含分類），用來證明「核准後真的看得到課程」
  const category = await api.rest(admin.token, 'POST', 'course_categories', {
    body: { title: 'E2E 培訓分類', is_published: true, order: 1, visibility: 'all' }, prefer: 'return=representation',
  });
  if (category.status !== 201) throw new Error(`seed category failed ${category.status} ${JSON.stringify(category.data)}`);
  const course = await api.rest(admin.token, 'POST', 'courses', {
    body: { title: 'E2E 第一站課程', description: '端到端測試用課程', is_published: true, order: 1, category_id: category.data[0].id },
    prefer: 'return=representation',
  });
  if (course.status !== 201) throw new Error(`seed course failed ${course.status} ${JSON.stringify(course.data)}`);

  // 合約文件：講師守則（只看）＋講師合約書（填寫簽署），PDF 用 pdf-lib 現做，以 admin 身分上傳到假 storage
  const docs = [
    { doc_type: 'rules', display_name: '講師守則', doc_mode: 'view_only', sort_order: 1, title: 'E2E Instructor Rules v1' },
    { doc_type: 'contract', display_name: '講師合約書', doc_mode: 'fill_sign', sort_order: 2, title: 'E2E Instructor Contract v1' },
  ];
  for (const doc of docs) {
    const pdf = await makePdf(doc.title, ['Name:', 'Level:', 'ID number:', 'Address:', 'Phone:', '', 'Signature:']);
    const filePath = `templates/${doc.doc_type}_v1_${runTag}.pdf`;
    const upload = await api.request(admin.token, 'POST', `/storage/v1/object/contract-documents/${filePath}`, {
      raw: pdf, headers: { 'content-type': 'application/pdf' },
    });
    if (upload.status !== 200) throw new Error(`template upload failed ${upload.status} ${JSON.stringify(upload.data)}`);
    const row = await api.rest(admin.token, 'POST', 'contract_documents', {
      body: {
        doc_type: doc.doc_type, version: 1, file_path: filePath, file_name: `${doc.doc_type}.pdf`, uploaded_by: admin.id,
        is_active: true, display_name: doc.display_name, doc_mode: doc.doc_mode, sort_order: doc.sort_order, doc_category: 'contract',
        // 與後台上傳新版相同：範本檔指紋在上傳時登錄（src/pages/admin/ContractAdmin.jsx 的 handleUpload）
        content_sha256: sha256(pdf),
      },
      prefer: 'return=representation',
    });
    if (row.status !== 201) throw new Error(`contract_documents insert failed ${row.status} ${JSON.stringify(row.data)}`);
  }
  const positions = [
    { field_type: 'name', x: 120, y_from_top: 92, width: 220, height: 20 },
    { field_type: 'instructor_role', x: 120, y_from_top: 114, width: 160, height: 20 },
    { field_type: 'id_number', x: 140, y_from_top: 136, width: 200, height: 20 },
    { field_type: 'address', x: 130, y_from_top: 158, width: 360, height: 20 },
    { field_type: 'phone', x: 120, y_from_top: 180, width: 200, height: 20 },
    { field_type: 'signature', x: 140, y_from_top: 200, width: 180, height: 60 },
  ].map((p) => ({ ...p, doc_type: 'contract', doc_version: 1, page_number: 1, font_size: 13 }));
  const pos = await api.rest(admin.token, 'POST', 'contract_field_positions', { body: positions, prefer: 'return=minimal' });
  if (pos.status !== 201) throw new Error(`field positions insert failed ${pos.status} ${JSON.stringify(pos.data)}`);

  return { admin, runTag, courseTitle: 'E2E 第一站課程', categoryId: category.data[0].id, courseId: course.data[0].id };
}

// 管理員以 REST 建立講師列（空位或舊資料）
export async function adminCreateInstructor(api, admin, fields) {
  const res = await api.rest(admin.token, 'POST', 'instructors', { body: fields, prefer: 'return=representation' });
  if (res.status !== 201) throw new Error(`admin create instructor failed ${res.status} ${JSON.stringify(res.data)}`);
  return res.data[0];
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Vault 替身：resend_api_key／resend_from 兩筆都在＝寄信已設定
export function setEmailConfigured(api, on) {
  if (on) {
    api.sql(`INSERT INTO vault.secrets (name, secret) VALUES ('resend_api_key', 're_e2e_test_key'), ('resend_from', '夢想一號 <no-reply@e2e.test>')
             ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret`);
  } else {
    api.sql(`DELETE FROM vault.secrets WHERE name = 'resend_api_key'`);
  }
}

// 模擬「migration 執行當下就存在的舊主檔」（規格 D2）：測試資料是在 migration 之後才建立的，
// 所以用超級使用者照 migration 回填的同一套規則補上 identity_verified_at 與 confirmed_email（company_existing_record）。
export function markAsPreMigrationRecord(api, instructorId) {
  api.sql(`UPDATE public.instructors i
              SET identity_verified_at = now(),
                  identity_verification_basis = '公司既有核驗結果登錄（非第三方實名認證）',
                  confirmed_email = lower(btrim(i.email_primary)),
                  confirmed_email_at = now(),
                  confirmed_email_by = NULL,
                  confirmed_email_method = 'company_existing_record',
                  confirmed_email_note = '公司既有資料之 Email（2026-10-20 migration 登錄）'
            WHERE i.id = :'id' AND NULLIF(btrim(i.email_primary), '') IS NOT NULL`, { id: instructorId });
}

// 測試信箱（net.http_post 替身存下的請求）：取某人某用途最新一筆驗證碼。只限測試，正式環境沒有這張表。
export function latestOtp(api, userId, purpose) {
  return api.json(`
    SELECT json_build_object('challenge_id', c.id, 'code', (regexp_match(r.body->>'text', '驗證碼：([0-9]{6})'))[1],
                             'to', l.to_email, 'delivery_id', l.id, 'created_at', c.created_at)
      FROM private.email_otp_challenges c
      JOIN public.email_delivery_log l ON l.id = c.delivery_id
      JOIN net._e2e_http_requests r ON r.id = l.net_request_id
     WHERE c.user_id = :'uid' AND c.purpose = :'purpose'
     ORDER BY c.created_at DESC LIMIT 1`, { uid: userId, purpose });
}

// 模擬「等了 61 秒」：把某人某用途的 challenge 建立時間往前推，跳過 60 秒重寄冷卻（不動有效期限）
export function skipOtpCooldown(api, userId, purpose) {
  api.sql(`UPDATE private.email_otp_challenges SET created_at = created_at - interval '61 seconds'
            WHERE user_id = :'uid' AND purpose = :'purpose'`, { uid: userId, purpose });
}

const completeProfileFields = (fullName, email, n) => ({
  full_name: fullName, nickname: `${fullName.slice(-2)}老師`, gender: '女', birth_date: '1992-02-02',
  id_number: `A2${String(n).padStart(8, '0').slice(-8)}`, phone_mobile: `09${String(10000000 + n).slice(-8)}`,
  line_id: `line-${n}`, address: '臺北市大安區測試路 3 號', household_address: '臺北市大安區測試路 3 號',
  email_primary: email, teaching_freq_semester: '每週 1 次', teaching_freq_vacation: '每週 2 次',
  teaching_regions: ['臺北市'], bio_notes: 'REST 建立的完整講師資料。', bank_account_name: fullName,
  bank_name: '華南銀行', bank_branch: '測試分行', bank_account_number: `9900${String(n).padStart(8, '0')}`,
  bank_code: '0080000', id_front_path: 'instructors/import/id-front.png', id_back_path: 'instructors/import/id-back.png',
  bankbook_path: 'instructors/import/bankbook.png', employment_status: 'active', instructor_role: '實習',
});
let restTeacherSeq = 0;

// 用 REST 走完正式路徑做出「已啟用的講師」：管理員建主檔（含 Email）→ Google 登入自動綁定（待啟用）
// → 管理員確認 Email → 本人 OTP 啟用。給不是要測這段流程、只是需要一位已啟用老師的情境用。
export async function makeActiveTeacherViaRest(stack, api, admin, { fullName, emailPrefix = 'rest-teacher' } = {}) {
  restTeacherSeq += 1;
  const email = `${emailPrefix}-${Date.now().toString(36)}-${restTeacherSeq}@e2e.test`;
  const name = fullName || `REST講師${restTeacherSeq}`;
  const row = await adminCreateInstructor(api, admin, completeProfileFields(name, email, Date.now() % 100000000 + restTeacherSeq));
  const user = await createGoogleUser(stack, { email, fullName: name });
  if (!user.id) throw new Error(`hook rejected ${email}: ${JSON.stringify(user.hookRejected)}`);
  const confirm = await api.rpc(admin.token, 'admin_confirm_instructor_email', { p_instructor_id: row.id, p_email: email, p_note: 'E2E：REST 建立時一併確認' });
  if (confirm.data?.status !== 'confirmed') throw new Error(`confirm email failed ${JSON.stringify(confirm.data)}`);
  const sent = await api.rpc(user.token, 'request_email_otp', { p_purpose: 'account_activation' });
  if (sent.data?.status !== 'sent') throw new Error(`activation otp not sent ${JSON.stringify(sent.data)}`);
  const otp = latestOtp(api, user.id, 'account_activation');
  const verified = await api.rpc(user.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
  if (!verified.data?.activated) throw new Error(`activation failed ${JSON.stringify(verified.data)}`);
  return { ...user, instructorId: row.id, fullName: name };
}

// 用 REST 照前端同樣的步驟簽約（同意 → 簽約 OTP → 上傳簽名與成品 → submit v2），給「不是在測簽約畫面」的情境用
export async function signViaRest(stack, api, user) {
  const docs = (await api.rest(user.token, 'GET', 'contract_documents?select=*&is_active=eq.true&doc_category=eq.contract&order=sort_order')).data;
  const docVersions = Object.fromEntries(docs.map((d) => [d.doc_type, d.version]));
  const consent = await api.rpc(user.token, 'record_contract_consent', { p_decision: 'agree_electronic', p_doc_versions: docVersions, p_consent_text_version: 'esign-consent-v1' });
  if (consent.data?.status !== 'recorded') throw new Error(`consent failed ${JSON.stringify(consent.data)}`);
  const sent = await api.rpc(user.token, 'request_email_otp', { p_purpose: 'contract_sign' });
  if (sent.data?.status !== 'sent') throw new Error(`contract otp not sent ${JSON.stringify(sent.data)}`);
  const otp = latestOtp(api, user.id, 'contract_sign');
  const verified = await api.rpc(user.token, 'verify_email_otp', { p_challenge_id: otp.challenge_id, p_code: otp.code });
  if (verified.data?.status !== 'verified') throw new Error(`contract otp verify failed ${JSON.stringify(verified.data)}`);
  const documentSha = {};
  for (const d of docs) {
    const res = await fetch(`${stack.supabaseUrl}/storage/v1/object/authenticated/contract-documents/${d.file_path}`, { headers: { apikey: stack.anonKey, authorization: `Bearer ${user.token}` } });
    documentSha[d.doc_type] = sha256(Buffer.from(await res.arrayBuffer()));
  }
  const stamp = Date.now();
  const sigPath = `signed/${user.id}/signature_${stamp}.png`;
  const pdfPath = `signed/${user.id}/contract_${stamp}.pdf`;
  const pdf = await makePdf('REST signed contract', [`signed by ${user.id}`]);
  for (const [objectPath, body, type] of [[sigPath, samplePng('rest-signature'), 'image/png'], [pdfPath, pdf, 'application/pdf']]) {
    const up = await api.request(user.token, 'POST', `/storage/v1/object/contract-documents/${objectPath}`, { raw: body, headers: { 'content-type': type } });
    if (up.status !== 200) throw new Error(`upload ${objectPath} failed ${up.status}`);
  }
  const inst = api.json(`SELECT row_to_json(i) FROM public.instructors i WHERE user_id = :'uid'`, { uid: user.id });
  const params = {
    p_filled_name: inst.full_name, p_filled_instructor_role: inst.instructor_role || '實習', p_filled_id_number: inst.id_number,
    p_filled_address: inst.address, p_filled_phone: inst.phone_mobile, p_signature_path: sigPath,
    p_signed_pdf_paths: { contract: pdfPath }, p_doc_versions: docVersions, p_user_agent: 'e2e-rest',
    p_otp_challenge_id: otp.challenge_id, p_consent_id: consent.data.consent_id,
    p_document_sha256: documentSha, p_signed_pdf_sha256: { contract: sha256(pdf) },
  };
  const result = await api.rpc(user.token, 'submit_my_contract', params);
  if (result.data?.status !== 'signed') throw new Error(`submit failed ${result.status} ${JSON.stringify(result.data)}`);
  return { ...result.data, params };
}

// 輔導員：teacher_invites 列名 mentor → Google 登入時 handle_new_user 給 mentor（需 bootstrap-after-chain.sql 的 CHECK）
export async function createMentor(stack, api, { fullName = 'E2E 輔導員' } = {}) {
  const email = `mentor-${Date.now().toString(36)}@e2e.test`;
  api.sql(`INSERT INTO public.teacher_invites (name, email, role) VALUES (:'name', :'email', 'mentor')`, { name: fullName, email });
  const mentor = await createGoogleUser(stack, { email, fullName });
  return mentor;
}
