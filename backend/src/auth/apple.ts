import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';

/**
 * Verify a Sign in with Apple identity token WITHOUT any SDK: fetch Apple's
 * public keys (JWKS), check the RS256 signature against the key named in the
 * token header, and validate issuer / audience / expiry. Returns the stable
 * Apple user id (`sub`) and email. This is what lets us do our own auth - Apple
 * proves who the user is; we mint our own session (see tokens.ts).
 */

const JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISS = 'https://appleid.apple.com';
const JWKS_TTL_MS = 60 * 60 * 1000;

interface AppleJwk extends JsonWebKey {
  kid: string;
  alg: string;
}

let cache: { keys: AppleJwk[]; at: number } | null = null;

async function appleKeys(fetchImpl: typeof fetch): Promise<AppleJwk[]> {
  if (cache && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error('could not fetch Apple public keys');
  const body = (await res.json()) as { keys: AppleJwk[] };
  cache = { keys: body.keys, at: Date.now() };
  return body.keys;
}

export interface AppleIdentity {
  appleSub: string;
  email: string | null;
}

export async function verifyAppleIdToken(
  idToken: string,
  opts: { clientId: string; fetchImpl?: typeof fetch },
): Promise<AppleIdentity> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('malformed apple token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
  if (header.alg !== 'RS256') throw new Error(`unexpected apple alg: ${header.alg ?? 'none'}`);

  const jwk = (await appleKeys(fetchImpl)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('no matching apple key');
  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const ok = cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${headerB64}.${payloadB64}`),
    publicKey,
    Buffer.from(signatureB64, 'base64url'),
  );
  if (!ok) throw new Error('bad apple signature');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
    iss?: string;
    aud?: string | string[];
    exp?: number;
    sub?: string;
    email?: string;
  };
  if (payload.iss !== APPLE_ISS) throw new Error('bad apple issuer');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.clientId)) throw new Error('apple token audience mismatch');
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) throw new Error('apple token expired');
  if (!payload.sub) throw new Error('apple token has no subject');

  return { appleSub: payload.sub, email: payload.email ?? null };
}
