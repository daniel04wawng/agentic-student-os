import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Our own session tokens: short-lived access + longer refresh JWTs, signed with
 * AUTH_JWT_SECRET (HS256). Issued after a Sign in with Apple identity token is
 * verified (see apple.ts). Dependency-free - a keyed HMAC, no library.
 */

const ACCESS_TTL_S = 7 * 24 * 3600; // 7 days
const REFRESH_TTL_S = 90 * 24 * 3600; // 90 days

export type TokenType = 'access' | 'refresh';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token expiry as a unix timestamp (seconds). */
  expiresAt: number;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/** Mint an access + refresh token pair for a user. */
export function issueTokens(userId: string, secret: string): IssuedTokens {
  const now = Math.floor(Date.now() / 1000);
  const access = sign({ sub: userId, type: 'access', iat: now, exp: now + ACCESS_TTL_S }, secret);
  const refresh = sign({ sub: userId, type: 'refresh', iat: now, exp: now + REFRESH_TTL_S }, secret);
  return { accessToken: access, refreshToken: refresh, expiresAt: now + ACCESS_TTL_S };
}

/**
 * Verify one of our session tokens. Checks the HMAC signature, expiry, and
 * (optionally) that it is the expected type. Returns the user id (`sub`). Throws
 * on any failure.
 */
export function verifySessionToken(token: string, secret: string, expectedType?: TokenType): { userId: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error(`unsupported alg: ${header.alg ?? 'none'}`);

  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  const provided = Buffer.from(signatureB64, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error('bad signature');
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    sub?: string;
    type?: string;
    exp?: number;
  };
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) throw new Error('token expired');
  if (expectedType && payload.type !== expectedType) throw new Error(`expected ${expectedType} token`);
  if (!payload.sub) throw new Error('token has no subject');
  return { userId: payload.sub };
}

/** Pull the bearer token out of an Authorization header value. */
export function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1]!.trim() : null;
}
