// 假帳號、REST 呼叫、種資料。所有寫入都走「正式路徑」：
//   * Google 帳號＝以 supabase_auth_admin 身分 INSERT auth.users，讓 handle_new_user trigger 照正式邏輯建 public.users；
//     建立前先以同一身分呼叫 Before User Created hook（正式環境 GoTrue 會做的事），被拒就不建。
//   * 管理員操作＝帶 admin JWT 打閘道的 /rest/v1 與 /storage/v1（RLS 與 trigger 照常檢查）。
import { randomUUID } from 'node:crypto';
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

  return { admin, runTag, courseTitle: 'E2E 第一站課程' };
}

// 管理員以 REST 建立講師列（空位或舊資料）
export async function adminCreateInstructor(api, admin, fields) {
  const res = await api.rest(admin.token, 'POST', 'instructors', { body: fields, prefer: 'return=representation' });
  if (res.status !== 201) throw new Error(`admin create instructor failed ${res.status} ${JSON.stringify(res.data)}`);
  return res.data[0];
}
