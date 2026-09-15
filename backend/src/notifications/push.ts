import http2 from 'node:http2';
import { createPrivateKey, sign } from 'node:crypto';

/**
 * Push delivery abstraction. Delivery is best-effort and sits ON TOP of the
 * persistent notification record; a failing sender must never lose the item.
 * A real APNs/web-push sender (needs provider credentials) implements this
 * later; the Noop sender is the safe default.
 */
export interface PushTarget {
  token: string;
  platform: string;
}

export interface PushMessage {
  title: string;
  body: string | null;
}

export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<void>;
}

/** Default sender: no-op success. Swap for a real APNs sender when configured. */
export class NoopPushSender implements PushSender {
  async send(): Promise<void> {
    // intentionally does nothing
  }
}

export interface ApnsConfig {
  /** The .p8 auth key contents (PEM). */
  keyP8: string;
  keyId: string;
  teamId: string;
  /** The app bundle id, e.g. com.danielwang.studentos (the APNs topic). */
  bundleId: string;
  /** 'production' for TestFlight/App Store builds, 'sandbox' for Xcode dev builds. */
  host?: string;
}

/**
 * Real APNs sender over HTTP/2 with a token-based (.p8) auth JWT. No external
 * dependency: the ES256 JWT is signed with node's crypto and cached ~50 min.
 * TestFlight and App Store builds use the production host (the default).
 */
export class ApnsPushSender implements PushSender {
  private jwt: { token: string; at: number } | null = null;
  private readonly host: string;
  constructor(private readonly cfg: ApnsConfig) {
    this.host = cfg.host ?? 'api.push.apple.com';
  }

  private authToken(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.at < 3000) return this.jwt.token;
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${b64({ alg: 'ES256', kid: this.cfg.keyId })}.${b64({ iss: this.cfg.teamId, iat: now })}`;
    // ES256 needs the raw R||S signature (JOSE), which 'ieee-p1363' produces.
    const key = createPrivateKey(this.cfg.keyP8);
    const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    const token = `${input}.${sig}`;
    this.jwt = { token, at: now };
    return token;
  }

  async send(target: PushTarget, message: PushMessage): Promise<void> {
    if (target.platform !== 'ios') return; // APNs is iOS only
    const payload = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body ?? '' }, sound: 'default' },
    });
    const jwt = this.authToken();
    await new Promise<void>((resolve, reject) => {
      const client = http2.connect(`https://${this.host}`);
      client.on('error', reject);
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${target.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': this.cfg.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      req.on('response', (h) => {
        status = Number(h[':status']);
      });
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        client.close();
        if (status === 200) resolve();
        else reject(new Error(`APNs ${status} ${body}`));
      });
      req.on('error', (e) => {
        client.close();
        reject(e);
      });
      req.end(payload);
    });
  }
}

/** Build an APNs sender from env when fully configured, else the no-op sender. */
export function createPushSender(env: NodeJS.ProcessEnv = process.env): PushSender {
  const keyP8 = env.APNS_KEY_P8?.replace(/\\n/g, '\n');
  const { APNS_KEY_ID: keyId, APNS_TEAM_ID: teamId, APNS_BUNDLE_ID: bundleId, APNS_HOST: host } = env;
  if (keyP8 && keyId && teamId && bundleId) {
    return new ApnsPushSender({ keyP8, keyId, teamId, bundleId, host });
  }
  return new NoopPushSender();
}
