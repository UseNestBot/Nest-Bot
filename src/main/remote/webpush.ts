import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

/** A browser's PushSubscription.toJSON(). */
export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The application server's P-256 key pair, base64url: raw uncompressed public key and the 32-byte private scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

const b64url = (buf: Buffer): string => buf.toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

export function isPushSubscription(v: unknown): v is PushSubscriptionJson {
  const s = v as PushSubscriptionJson;
  return (
    typeof s?.endpoint === 'string' &&
    /^https:\/\//.test(s.endpoint) &&
    s.endpoint.length < 2000 &&
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys?.auth === 'string' &&
    fromB64url(s.keys.p256dh).length === 65 &&
    fromB64url(s.keys.auth).length === 16
  );
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/** Encrypt a payload for one subscription (RFC 8291, "aes128gcm" content coding, a single record). */
export function encryptPayload(sub: PushSubscriptionJson, payload: Buffer, salt = randomBytes(16), serverPrivateKey?: Buffer): Buffer {
  const uaPublic = fromB64url(sub.keys.p256dh);
  const authSecret = fromB64url(sub.keys.auth);
  // A fresh key pair per message (fixed only by the RFC test vector).
  const server = createECDH('prime256v1');
  if (serverPrivateKey) server.setPrivateKey(serverPrivateKey);
  else server.generateKeys();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);

  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (only) record; no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** The VAPID Authorization header for a push service origin (RFC 8292). */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): string {
  const pub = fromB64url(keys.publicKey);
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: 'jwk',
  });
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Deliver one notification. 'gone' means the subscription expired and should be forgotten. */
export async function sendPush(sub: PushSubscriptionJson, payload: unknown, keys: VapidKeys, fetchImpl: typeof fetch = fetch): Promise<PushResult> {
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)));
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, keys, 'https://github.com/UseNestBot/Nest-Bot'),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
        Urgency: 'high',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (!res.ok) {
      console.warn(`[nest] push failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.warn('[nest] push failed:', (err as Error).message);
    return 'failed';
  }
}
