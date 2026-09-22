import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Supabase Auth access token (JWT). Supabase signs access tokens with
 * the project's JWT secret using HS256, so verification is a keyed HMAC check -
 * no network call, no dependency. On success returns the authenticated user's id
 * (the token's `sub`, a UUID) which is our tenant id. Throws on any failure:
 * malformed token, wrong signature, expired, or wrong algorithm.
 */

export interface VerifiedUser {
  userId: string;
  email: string | null;
}

interface JwtPayload {
  sub?: string;
  email?: string;
  exp?: number;
  aud?: string | string[];
  role?: string;
}

function b64urlToBuffer(part: string): Buffer {
  return Buffer.from(part, 'base64url');
}

export function verifySupabaseJwt(token: string, secret: string): VerifiedUser {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error(`unsupported alg: ${header.alg ?? 'none'}`);

  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const provided = b64urlToBuffer(signatureB64);
  // Length check first: timingSafeEqual throws on length mismatch.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error('bad signature');
  }

  const payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8')) as JwtPayload;
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
    throw new Error('token expired');
  }
  if (!payload.sub) throw new Error('token has no subject');

  return { userId: payload.sub, email: payload.email ?? null };
}

/** Pull the bearer token out of an Authorization header value. */
export function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1]!.trim() : null;
}
