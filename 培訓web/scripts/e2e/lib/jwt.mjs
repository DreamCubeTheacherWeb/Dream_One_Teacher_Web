// HS256 JWT（只用 node:crypto）：給 PostgREST 與假 GoTrue／假 Storage 共用同一把測試密鑰。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const b64url = (input) => Buffer.from(input).toString('base64url');

export function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyJwt(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
  const actual = Buffer.from(parts[2], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const randomSecret = () => randomBytes(32).toString('hex'); // 64 字元 ≥ 32

// Supabase 專案金鑰的 payload 形狀（anon／service_role）
export function projectKey(role, secret) {
  const iat = Math.floor(Date.now() / 1000);
  return signJwt({ iss: 'supabase-e2e', ref: 'e2e', role, iat, exp: iat + 60 * 60 * 24 }, secret);
}
