// 本機「假 Supabase 閘道」（node:http，不裝套件）：
//   /rest/v1/*     → 轉給真的 PostgREST（RLS／RPC 全在 PostgreSQL 執行）
//   /auth/v1/*     → 最小假 GoTrue：user、refresh、logout、Email OTP（otp／verify）
//   /storage/v1/*  → 假 Storage：每次讀寫都「以呼叫者身分」在交易內操作 storage.objects，
//                    讓 storage RLS 真的生效；檔案位元組存在暫存資料夾
//   /__e2e/*       → 測試專用（讀 OTP 信箱、請求紀錄）。正式 Supabase 沒有這些路徑。
// 不支援（回 501）：OAuth 授權頁、Realtime、Edge Functions。
import http from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { signJwt, verifyJwt } from './jwt.mjs';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
  'access-control-expose-headers': 'content-range, content-profile, preference-applied, x-supabase-api-version, range-unit, location',
  'access-control-max-age': '600',
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const sendJson = (res, status, body, extra = {}) => {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(payload);
};

const parseJson = (buffer) => {
  try { return buffer.length ? JSON.parse(buffer.toString('utf8')) : {}; } catch { return null; }
};

// 極簡 multipart/form-data 解析（storage-js 上傳 Blob 時用 FormData，欄位名為空字串）
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let start = buffer.indexOf(boundary);
  while (start !== -1) {
    const next = buffer.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    let part = buffer.subarray(start + boundary.length, next);
    if (part.subarray(0, 2).toString() === '\r\n') part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === '\r\n') part = part.subarray(0, part.length - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const headers = Object.fromEntries(headerText.split('\r\n').map((line) => {
        const i = line.indexOf(':');
        return [line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim()];
      }));
      const disposition = headers['content-disposition'] || '';
      const name = /name="([^"]*)"/.exec(disposition)?.[1] ?? null;
      const filename = /filename="([^"]*)"/.exec(disposition)?.[1] ?? null;
      parts.push({ name, filename, contentType: headers['content-type'] || null, data: part.subarray(headerEnd + 4) });
    }
    start = next;
  }
  return parts;
}

const pgError = (stderr) => {
  const text = stderr || '';
  if (/row-level security/i.test(text)) return { status: 403, body: { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' } };
  if (/duplicate key|bucketid_objname/i.test(text)) return { status: 409, body: { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' } };
  if (/permission denied/i.test(text)) return { status: 403, body: { statusCode: '403', error: 'Unauthorized', message: 'permission denied' } };
  return { status: 500, body: { statusCode: '500', error: 'internal', message: text.split('\n')[0] } };
};

export class FakeSupabaseGateway {
  constructor({ db, postgrestPort, jwtSecret, anonKey, serviceKey, storageDir, publicUrl }) {
    this.db = db;
    this.postgrestPort = postgrestPort;
    this.secret = jwtSecret;
    this.anonKey = anonKey;
    this.serviceKey = serviceKey;
    this.storageDir = storageDir;
    this.publicUrl = publicUrl;
    this.refreshTokens = new Map(); // refresh_token → { userId, amr, sessionId }
    this.mailbox = new Map(); // email → [{ code, sentAt }]
    this.requests = [];
    mkdirSync(storageDir, { recursive: true });
  }

  listen(port) {
    this.port = port;
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        console.error('[gateway] unhandled', req.method, req.url, error);
        if (!res.headersSent) sendJson(res, 500, { message: error.message });
        else res.end();
      });
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve(this));
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  log(entry) {
    this.requests.push({ at: Date.now(), ...entry });
  }

  // ── JWT／session ───────────────────────────────────────────────
  claimsFromRequest(req) {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers.apikey || '');
    return verifyJwt(token, this.secret);
  }

  async fetchAuthUser(userId) {
    const result = await this.db.psql(`
      SELECT json_build_object(
        'id', u.id, 'aud', 'authenticated', 'role', 'authenticated', 'email', u.email,
        'email_confirmed_at', u.email_confirmed_at, 'phone', '', 'confirmed_at', u.confirmed_at,
        'last_sign_in_at', u.last_sign_in_at,
        'app_metadata', COALESCE(u.raw_app_meta_data, '{}'::jsonb),
        'user_metadata', COALESCE(u.raw_user_meta_data, '{}'::jsonb),
        'identities', json_build_array(json_build_object(
          'identity_id', u.id, 'id', u.id, 'user_id', u.id, 'provider', 'google',
          'identity_data', json_build_object('email', u.email, 'sub', u.id::text,
            'full_name', u.raw_user_meta_data->>'full_name'),
          'created_at', u.created_at, 'updated_at', u.updated_at, 'last_sign_in_at', u.last_sign_in_at)),
        'created_at', u.created_at, 'updated_at', u.updated_at, 'is_anonymous', false)
      FROM auth.users u WHERE u.id = :'uid'`, { vars: { uid: userId } });
    if (!result.ok || !result.stdout) return null;
    return JSON.parse(result.stdout);
  }

  async issueSession(userId, { amr, sessionId = randomUUID() } = {}) {
    const user = await this.fetchAuthUser(userId);
    if (!user) throw new Error(`auth user ${userId} not found`);
    const iat = Math.floor(Date.now() / 1000);
    const expiresIn = 3600;
    const finalAmr = amr || [{ method: 'oauth', timestamp: iat }];
    const accessToken = signJwt({
      aud: 'authenticated', exp: iat + expiresIn, iat, iss: `${this.publicUrl}/auth/v1`,
      sub: user.id, email: user.email, phone: '', app_metadata: user.app_metadata,
      user_metadata: user.user_metadata, role: 'authenticated', aal: 'aal1', amr: finalAmr,
      session_id: sessionId, is_anonymous: false,
    }, this.secret);
    const refreshToken = randomBytes(16).toString('hex');
    this.refreshTokens.set(refreshToken, { userId: user.id, amr: finalAmr, sessionId });
    return {
      access_token: accessToken, token_type: 'bearer', expires_in: expiresIn,
      expires_at: iat + expiresIn, refresh_token: refreshToken, user,
    };
  }

  // ── 路由 ────────────────────────────────────────────────────────
  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...CORS_HEADERS,
        'access-control-allow-headers': req.headers['access-control-request-headers'] || '*',
      });
      return res.end();
    }
    if (url.pathname.startsWith('/rest/v1/')) return this.proxyRest(req, res, url);
    if (url.pathname.startsWith('/auth/v1/')) return this.handleAuth(req, res, url);
    if (url.pathname.startsWith('/storage/v1/')) return this.handleStorage(req, res, url);
    if (url.pathname.startsWith('/__e2e/')) return this.handleTestOnly(req, res, url);
    this.log({ kind: 'other', method: req.method, path: url.pathname, status: 404 });
    return sendJson(res, 404, { message: 'not found' });
  }

  async proxyRest(req, res, url) {
    // 與 Supabase 一樣：apikey 必須是本專案金鑰
    const apikey = req.headers.apikey;
    if (apikey && apikey !== this.anonKey && apikey !== this.serviceKey) {
      return sendJson(res, 401, { message: 'Invalid API key' });
    }
    const body = await readBody(req);
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.origin;
    delete headers.referer;
    delete headers['content-length'];
    if (!headers.authorization && apikey) headers.authorization = `Bearer ${apikey}`;
    headers['x-forwarded-for'] = req.socket.remoteAddress || '127.0.0.1';
    const target = `${url.pathname.slice('/rest/v1'.length)}${url.search}`;
    await new Promise((resolve) => {
      const upstream = http.request({
        host: '127.0.0.1', port: this.postgrestPort, method: req.method, path: target,
        headers: { ...headers, 'content-length': body.length },
      }, (upRes) => {
        const outHeaders = { ...upRes.headers };
        for (const key of Object.keys(outHeaders)) {
          if (key.startsWith('access-control-')) delete outHeaders[key];
        }
        res.writeHead(upRes.statusCode, { ...outHeaders, ...CORS_HEADERS });
        upRes.pipe(res);
        upRes.on('end', resolve);
        this.log({ kind: 'rest', method: req.method, path: url.pathname, status: upRes.statusCode });
      });
      upstream.on('error', (error) => {
        sendJson(res, 502, { message: `PostgREST unreachable: ${error.message}` });
        resolve();
      });
      upstream.end(body);
    });
  }

  async handleAuth(req, res, url) {
    const route = url.pathname.slice('/auth/v1'.length);
    const body = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const json = parseJson(body) || {};
    const done = (status, payload) => {
      this.log({ kind: 'auth', method: req.method, path: url.pathname, status });
      return sendJson(res, status, payload);
    };

    if (route === '/user' && req.method === 'GET') {
      const claims = this.claimsFromRequest(req);
      if (!claims?.sub) return done(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' });
      const user = await this.fetchAuthUser(claims.sub);
      if (!user) return done(403, { code: 403, error_code: 'user_not_found', msg: 'User from sub claim in JWT does not exist' });
      return done(200, user);
    }

    if (route === '/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const stored = this.refreshTokens.get(json.refresh_token);
      if (!stored) return done(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
      this.refreshTokens.delete(json.refresh_token);
      return done(200, await this.issueSession(stored.userId, { amr: stored.amr, sessionId: stored.sessionId }));
    }

    if (route === '/logout') {
      res.writeHead(204, CORS_HEADERS);
      this.log({ kind: 'auth', method: req.method, path: url.pathname, status: 204 });
      return res.end();
    }

    if (route === '/otp' && req.method === 'POST') {
      const email = String(json.email || '').trim().toLowerCase();
      const lookup = await this.db.psql(`SELECT id FROM auth.users WHERE lower(email) = :'email' LIMIT 1`, { vars: { email } });
      if (!lookup.stdout) {
        // create_user=false 而且找不到帳號：GoTrue 回 422 otp_disabled
        return done(422, { code: 422, error_code: 'otp_disabled', msg: 'Signups not allowed for otp' });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const list = this.mailbox.get(email) || [];
      list.push({ code, sentAt: Date.now() });
      this.mailbox.set(email, list);
      return done(200, {});
    }

    if (route === '/verify' && req.method === 'POST') {
      const email = String(json.email || '').trim().toLowerCase();
      const list = this.mailbox.get(email) || [];
      const latest = list[list.length - 1];
      const fresh = latest && Date.now() - latest.sentAt < 10 * 60 * 1000;
      if (!fresh || latest.code !== String(json.token || '') || !['email', 'magiclink'].includes(json.type)) {
        return done(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      }
      latest.used = true;
      const lookup = await this.db.psql(`SELECT id FROM auth.users WHERE lower(email) = :'email' LIMIT 1`, { vars: { email } });
      const now = Math.floor(Date.now() / 1000);
      return done(200, await this.issueSession(lookup.stdout, { amr: [{ method: 'otp', timestamp: now }] }));
    }

    if (route === '/settings') {
      return done(200, { external: { google: true, email: true }, disable_signup: false, mailer_autoconfirm: false });
    }

    return done(501, { code: 501, msg: `fake GoTrue does not implement ${req.method} ${route}` });
  }

  handleTestOnly(req, res, url) {
    if (url.pathname === '/__e2e/mailbox') {
      const email = String(url.searchParams.get('email') || '').toLowerCase();
      const list = this.mailbox.get(email) || [];
      return sendJson(res, 200, { email, messages: list.map(({ code, sentAt }) => ({ code, sentAt })) });
    }
    return sendJson(res, 404, { message: 'unknown test endpoint' });
  }

  // ── Storage ───────────────────────────────────────────────────
  filePath(bucket, name) {
    return path.join(this.storageDir, encodeURIComponent(bucket), encodeURIComponent(name));
  }

  // 以呼叫者身分（JWT role／claims）跑一段 SQL：BEGIN; SET LOCAL ROLE；set_config(request.jwt.claims)
  asCaller(claims, sql, vars = {}) {
    const role = ['anon', 'authenticated', 'service_role'].includes(claims?.role) ? claims.role : 'anon';
    return this.db.psql(`
      BEGIN;
      SET LOCAL ROLE ${role};
      SELECT set_config('request.jwt.claims', :'claims', true) \\g /dev/null
      ${sql}
      COMMIT;`, { vars: { ...vars, claims: JSON.stringify(claims || { role: 'anon' }) } });
  }

  async bucketInfo(bucket) {
    const result = await this.db.psql(`SELECT row_to_json(b) FROM storage.buckets b WHERE id = :'bucket'`, { vars: { bucket } });
    return result.stdout ? JSON.parse(result.stdout) : null;
  }

  signToken(bucket, name, expiresIn) {
    const iat = Math.floor(Date.now() / 1000);
    return signJwt({ url: `${bucket}/${name}`, iat, exp: iat + Number(expiresIn || 60) }, `${this.secret}:storage`);
  }

  async handleStorage(req, res, url) {
    const route = url.pathname.slice('/storage/v1'.length);
    const segments = route.split('/').filter(Boolean).map(decodeURIComponent);
    const done = (status, payload, kind = 'storage') => {
      this.log({ kind, method: req.method, path: url.pathname, status });
      return sendJson(res, status, payload);
    };
    if (segments[0] !== 'object') return done(501, { message: `fake storage does not implement ${route}` });

    // 金鑰檢查（與 Supabase 一樣，非本專案金鑰一律 401）
    const apikey = req.headers.apikey;
    const claims = this.claimsFromRequest(req);
    const isSignedGet = segments[1] === 'sign' && req.method === 'GET';
    const isPublicGet = segments[1] === 'public' && req.method === 'GET';
    if (!isSignedGet && !isPublicGet) {
      if (apikey && apikey !== this.anonKey && apikey !== this.serviceKey) return done(401, { message: 'Invalid API key' });
      if (!claims) return done(400, { statusCode: '403', error: 'Unauthorized', message: 'invalid JWT' });
    }

    // GET /object/sign/<bucket>/<path>?token=… → 用簽名網址下載
    if (isSignedGet) {
      const [, , bucket, ...rest] = segments;
      const name = rest.join('/');
      const payload = verifyJwt(url.searchParams.get('token'), `${this.secret}:storage`);
      if (!payload || payload.url !== `${bucket}/${name}`) return done(400, { statusCode: '400', error: 'InvalidSignature', message: 'invalid signature' });
      return this.serveFile(req, res, url, bucket, name);
    }

    // GET /object/public/<bucket>/<path>
    if (isPublicGet) {
      const [, , bucket, ...rest] = segments;
      const info = await this.bucketInfo(bucket);
      if (!info?.public) return done(400, { statusCode: '404', error: 'not_found', message: 'Bucket not found' });
      return this.serveFile(req, res, url, bucket, rest.join('/'));
    }

    // POST /object/sign/<bucket>/<path> {expiresIn} ／ POST /object/sign/<bucket> {expiresIn, paths}
    if (segments[1] === 'sign' && req.method === 'POST') {
      const body = parseJson(await readBody(req)) || {};
      const bucket = segments[2];
      const names = segments.length > 3 ? [segments.slice(3).join('/')] : (body.paths || []);
      const visible = await this.asCaller(claims, `
        SELECT coalesce(json_agg(o.name), '[]') FROM storage.objects o
         WHERE o.bucket_id = :'bucket' AND o.name IN (SELECT jsonb_array_elements_text(:'names'::jsonb));`,
      { bucket, names: JSON.stringify(names) });
      if (!visible.ok) return done(pgError(visible.stderr).status, pgError(visible.stderr).body);
      const allowed = new Set(JSON.parse(visible.stdout || '[]'));
      const build = (name) => `/object/sign/${bucket}/${name}?token=${this.signToken(bucket, name, body.expiresIn)}`;
      if (segments.length > 3) {
        if (!allowed.has(names[0])) return done(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        return done(200, { signedURL: build(names[0]) });
      }
      return done(200, names.map((name) => (allowed.has(name)
        ? { path: name, signedURL: build(name), error: null }
        : { path: name, signedURL: null, error: 'Either the object does not exist or you do not have access to it' })));
    }

    // GET /object/authenticated/<bucket>/<path> 或 GET /object/<bucket>/<path> → 帶身分下載
    if (req.method === 'GET' || req.method === 'HEAD') {
      const offset = segments[1] === 'authenticated' ? 2 : 1;
      const bucket = segments[offset];
      const name = segments.slice(offset + 1).join('/');
      const visible = await this.asCaller(claims, `
        SELECT count(*) FROM storage.objects o WHERE o.bucket_id = :'bucket' AND o.name = :'name';`, { bucket, name });
      if (!visible.ok) return done(pgError(visible.stderr).status, pgError(visible.stderr).body);
      if (visible.stdout !== '1') return done(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return this.serveFile(req, res, url, bucket, name);
    }

    // DELETE /object/<bucket> {prefixes:[...]}
    if (req.method === 'DELETE' && segments.length === 2) {
      const bucket = segments[1];
      const body = parseJson(await readBody(req)) || {};
      const names = Array.isArray(body.prefixes) ? body.prefixes : [];
      const deleted = await this.asCaller(claims, `
        WITH d AS (
          DELETE FROM storage.objects o
           WHERE o.bucket_id = :'bucket' AND o.name IN (SELECT jsonb_array_elements_text(:'names'::jsonb))
          RETURNING o.id, o.name, o.bucket_id, o.metadata, o.created_at, o.updated_at
        ) SELECT coalesce(json_agg(d), '[]') FROM d;`, { bucket, names: JSON.stringify(names) });
      if (!deleted.ok) return done(pgError(deleted.stderr).status, pgError(deleted.stderr).body);
      const rows = JSON.parse(deleted.stdout || '[]');
      for (const row of rows) {
        const file = this.filePath(bucket, row.name);
        if (existsSync(file)) unlinkSync(file);
      }
      return done(200, rows);
    }

    // POST/PUT /object/<bucket>/<path> → 上傳
    if ((req.method === 'POST' || req.method === 'PUT') && segments.length >= 3) {
      const bucket = segments[1];
      const name = segments.slice(2).join('/');
      const raw = await readBody(req);
      let data = raw;
      let mimetype = req.headers['content-type'] || 'application/octet-stream';
      let cacheControl = (req.headers['cache-control'] || 'max-age=3600').replace('max-age=', '');
      if (/^multipart\/form-data/i.test(mimetype)) {
        const parts = parseMultipart(raw, mimetype) || [];
        const filePart = parts.find((part) => part.filename !== null || part.name === '');
        if (!filePart) return done(400, { statusCode: '400', error: 'InvalidRequest', message: 'no file in form data' });
        data = filePart.data;
        mimetype = filePart.contentType || 'application/octet-stream';
        cacheControl = parts.find((part) => part.name === 'cacheControl')?.data.toString('utf8') || cacheControl;
      }
      const info = await this.bucketInfo(bucket);
      if (!info) return done(400, { statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' });
      if (info.file_size_limit && data.length > Number(info.file_size_limit)) {
        return done(413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
      }
      if (Array.isArray(info.allowed_mime_types) && info.allowed_mime_types.length
          && !info.allowed_mime_types.includes(mimetype.split(';')[0].trim())) {
        return done(415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${mimetype} is not supported` });
      }
      const upsert = req.method === 'PUT' || String(req.headers['x-upsert']) === 'true';
      const metadata = {
        eTag: `"${createHmac('md5', 'e2e').update(data).digest('hex')}"`, size: data.length,
        mimetype, cacheControl: `max-age=${cacheControl}`, lastModified: new Date().toISOString(),
        contentLength: data.length, httpStatusCode: 200,
      };
      const version = randomUUID();
      const sql = upsert
        ? `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version)
             VALUES (:'bucket', :'name', nullif(:'owner', '')::uuid, nullif(:'owner', ''), :'metadata'::jsonb, :'version')
           ON CONFLICT (bucket_id, name) DO UPDATE SET metadata = EXCLUDED.metadata, version = EXCLUDED.version, updated_at = now();`
        : `INSERT INTO storage.objects (bucket_id, name, owner, owner_id, metadata, version)
             VALUES (:'bucket', :'name', nullif(:'owner', '')::uuid, nullif(:'owner', ''), :'metadata'::jsonb, :'version');`;
      const inserted = await this.asCaller(claims, sql, {
        bucket, name, owner: claims?.sub || '', metadata: JSON.stringify(metadata), version,
      });
      if (!inserted.ok) {
        const mapped = pgError(inserted.stderr);
        return done(mapped.status, mapped.body);
      }
      mkdirSync(path.dirname(this.filePath(bucket, name)), { recursive: true });
      writeFileSync(this.filePath(bucket, name), data);
      const idRow = await this.db.psql(`SELECT id FROM storage.objects WHERE bucket_id = :'bucket' AND name = :'name'`, { vars: { bucket, name } });
      return done(200, { Id: idRow.stdout, Key: `${bucket}/${name}` });
    }

    return done(501, { message: `fake storage does not implement ${req.method} ${route}` });
  }

  async serveFile(req, res, url, bucket, name) {
    const meta = await this.db.psql(`SELECT metadata FROM storage.objects WHERE bucket_id = :'bucket' AND name = :'name'`, { vars: { bucket, name } });
    const file = this.filePath(bucket, name);
    if (!meta.stdout || !existsSync(file)) {
      this.log({ kind: 'storage', method: req.method, path: url.pathname, status: 400 });
      return sendJson(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    }
    const metadata = JSON.parse(meta.stdout);
    const bytes = readFileSync(file);
    res.writeHead(200, {
      ...CORS_HEADERS,
      'content-type': metadata.mimetype || 'application/octet-stream',
      'content-length': bytes.length,
      'cache-control': 'no-cache',
    });
    this.log({ kind: 'storage', method: req.method, path: url.pathname, status: 200 });
    return res.end(req.method === 'HEAD' ? undefined : bytes);
  }
}
