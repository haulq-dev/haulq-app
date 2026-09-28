/**
 * Apple Push Notification service, over HTTP/2 with a token (.p8) key.
 *
 * Node's built-in `http2` and `crypto` cover all of it: an ES256 JWT signed
 * with the team's key authorizes every request, and one HTTP/2 session is
 * reused for all of them, as Apple asks. No dependency.
 *
 * The JWT is reused for 50 minutes. Apple refuses one older than an hour and
 * also refuses one refreshed more often than every 20 minutes
 * (`TooManyProviderTokenUpdates`), so it's cached, not made per request.
 *
 * Which responses mean what (Apple's "Handling notification responses"):
 *   200                       sent
 *   410, or 400 BadDeviceToken / DeviceTokenNotForTopic
 *                             dead: the app is gone or the token was never
 *                             valid for this app. Disable, never retry.
 *   429, 5xx                  retryable
 *   anything else             not retryable: our request is wrong, and
 *                             retrying won't fix it.
 */

import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { PushError, type PushDeviceAddress, type PushMessage, type PushOutcome, type PushSender } from './sender.ts';

export interface ApnsConfig {
  keyId: string;
  teamId: string;
  /** The .p8 file's contents. `\n` escapes are accepted, for a secret stored on one line. */
  privateKey: string;
  bundleId: string;
  /** `sandbox` for debug builds on a device, `production` for TestFlight and the App Store. */
  environment: 'sandbox' | 'production';
}

const TOKEN_TTL_MS = 50 * 60_000;

const base64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

/** The provider token: an ES256 JWT with the key id in the header and the team id as issuer. */
export function apnsJwt(config: Pick<ApnsConfig, 'keyId' | 'teamId'>, key: KeyObject, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: nowSeconds }));
  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  // JWS wants the raw r||s signature, not DER.
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * The notification body. `path` and `orgId` ride alongside `aps` for the
 * app's tap handler. `thread-id` groups a carrier's notifications together.
 */
export function apnsPayload(message: PushMessage): string {
  return JSON.stringify({
    aps: { alert: { title: message.title, body: message.body }, sound: 'default', 'thread-id': message.orgId },
    path: message.path,
    orgId: message.orgId,
  });
}

/** Sorts an APNs answer into sent, dead or a thrown `PushError`. */
export function classifyApnsResponse(status: number, reason: string | undefined): PushOutcome {
  if (status === 200) return 'sent';
  if (status === 410 || (status === 400 && (reason === 'BadDeviceToken' || reason === 'DeviceTokenNotForTopic'))) return 'dead';
  const retryable = status === 429 || status >= 500;
  throw new PushError(`APNs answered ${status}${reason ? ` ${reason}` : ''}`, retryable);
}

export class ApnsSender implements PushSender {
  readonly name: string;
  readonly platforms = ['ios'];
  readonly #config: ApnsConfig;
  readonly #key: KeyObject;
  #session: ClientHttp2Session | null = null;
  #token: { value: string; madeAt: number } | null = null;

  constructor(config: ApnsConfig) {
    this.#config = config;
    this.#key = createPrivateKey(config.privateKey.replace(/\\n/g, '\n'));
    this.name = `apns-${config.environment}`;
  }

  get #host(): string {
    return this.#config.environment === 'production' ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  }

  #jwt(): string {
    const now = Date.now();
    if (!this.#token || now - this.#token.madeAt > TOKEN_TTL_MS) {
      this.#token = { value: apnsJwt(this.#config, this.#key, Math.floor(now / 1000)), madeAt: now };
    }
    return this.#token.value;
  }

  #connection(): ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const session = connect(this.#host);
    // A dropped connection is replaced on the next send, not fatal.
    session.on('error', () => session.destroy());
    session.on('goaway', () => session.close());
    // Don't keep the process alive just for an idle push connection.
    session.unref();
    this.#session = session;
    return session;
  }

  send(device: PushDeviceAddress, message: PushMessage): Promise<PushOutcome> {
    const body = apnsPayload(message);
    return new Promise<PushOutcome>((resolve, reject) => {
      let request;
      try {
        request = this.#connection().request({
          [constants.HTTP2_HEADER_METHOD]: 'POST',
          [constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
          authorization: `bearer ${this.#jwt()}`,
          'apns-topic': this.#config.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-collapse-id': message.collapseId.slice(0, 64),
          'content-type': 'application/json',
        });
      } catch (err) {
        reject(new PushError(`APNs connection failed: ${err instanceof Error ? err.message : String(err)}`, true));
        return;
      }

      let status = 0;
      let text = '';
      request.setEncoding('utf8');
      request.setTimeout(10_000, () => request.close(constants.NGHTTP2_CANCEL));
      request.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      request.on('data', (chunk: string) => {
        text += chunk;
      });
      request.on('end', () => {
        let reason: string | undefined;
        try {
          reason = text ? (JSON.parse(text) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        try {
          resolve(classifyApnsResponse(status, reason));
        } catch (err) {
          reject(err);
        }
      });
      request.on('error', (err) => reject(new PushError(`APNs request failed: ${err.message}`, true)));
      request.end(body);
    });
  }

  close(): void {
    this.#session?.close();
    this.#session = null;
  }
}
