import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractBearer, verifySupabaseJwt } from '../../src/auth/verify.js';

const SECRET = 'super-secret-test-jwt-key';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

/** Mint an HS256 JWT the way Supabase Auth does, for tests. */
function sign(payload: Record<string, unknown>, secret = SECRET, alg = 'HS256'): string {
  const header = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const future = Math.floor(Date.now() / 1000) + 3600;
const past = Math.floor(Date.now() / 1000) - 3600;

describe('verifySupabaseJwt', () => {
  it('accepts a valid token and returns the user id + email', () => {
    const token = sign({ sub: 'user-123', email: 'a@b.com', exp: future, aud: 'authenticated' });
    expect(verifySupabaseJwt(token, SECRET)).toEqual({ userId: 'user-123', email: 'a@b.com' });
  });

  it('rejects a token signed with a different secret', () => {
    const token = sign({ sub: 'user-123', exp: future }, 'the-wrong-secret');
    expect(() => verifySupabaseJwt(token, SECRET)).toThrow(/bad signature/);
  });

  it('rejects an expired token', () => {
    const token = sign({ sub: 'user-123', exp: past });
    expect(() => verifySupabaseJwt(token, SECRET)).toThrow(/expired/);
  });

  it('rejects a malformed token', () => {
    expect(() => verifySupabaseJwt('not.a-jwt', SECRET)).toThrow(/malformed/);
  });

  it('rejects a non-HS256 algorithm', () => {
    const token = sign({ sub: 'user-123', exp: future }, SECRET, 'none');
    expect(() => verifySupabaseJwt(token, SECRET)).toThrow(/unsupported alg/);
  });

  it('rejects a token with no subject', () => {
    const token = sign({ email: 'a@b.com', exp: future });
    expect(() => verifySupabaseJwt(token, SECRET)).toThrow(/no subject/);
  });
});

describe('extractBearer', () => {
  it('pulls the token from a Bearer header', () => {
    expect(extractBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearer('bearer abc')).toBe('abc');
  });
  it('returns null for missing or non-bearer headers', () => {
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('Basic xyz')).toBeNull();
  });
});
