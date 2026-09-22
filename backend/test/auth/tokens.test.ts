import { describe, expect, it } from 'vitest';
import { extractBearer, issueTokens, verifySessionToken } from '../../src/auth/tokens.js';

const SECRET = 'session-signing-secret';

describe('session tokens', () => {
  it('issues an access + refresh pair that verify to the user id', () => {
    const t = issueTokens('user-1', SECRET);
    expect(verifySessionToken(t.accessToken, SECRET, 'access')).toEqual({ userId: 'user-1' });
    expect(verifySessionToken(t.refreshToken, SECRET, 'refresh')).toEqual({ userId: 'user-1' });
    expect(t.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('rejects a token signed with a different secret', () => {
    const t = issueTokens('user-1', SECRET);
    expect(() => verifySessionToken(t.accessToken, 'other-secret')).toThrow(/bad signature/);
  });

  it('rejects using a refresh token where an access token is required', () => {
    const t = issueTokens('user-1', SECRET);
    expect(() => verifySessionToken(t.refreshToken, SECRET, 'access')).toThrow(/expected access token/);
  });

  it('rejects a malformed token', () => {
    expect(() => verifySessionToken('nope', SECRET)).toThrow(/malformed/);
  });
});

describe('extractBearer', () => {
  it('parses a Bearer header', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('Basic x')).toBeNull();
  });
});
