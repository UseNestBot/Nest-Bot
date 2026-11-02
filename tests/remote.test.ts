import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteServer, webIndex } from '../src/main/remote/server';
import { RemoteStore } from '../src/main/remote/store';
import { encryptPayload, generateVapidKeys, isPushSubscription, vapidAuthorization, type PushSubscriptionJson } from '../src/main/remote/webpush';

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), 'nest-remote-'));
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** A browser's side of a push subscription, able to decrypt what the PC sends (RFC 8291). */
function browserSubscription() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSubscriptionJson = { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  const decrypt = (body: Buffer): string => {
    const salt = body.subarray(0, 16);
    const idLen = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idLen);
    const shared = ua.computeSecret(asPublic);
    const prkKey = hmac(auth, shared);
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const data = body.subarray(21 + idLen);
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
    expect(plain[plain.length - 1]).toBe(2);
    return plain.subarray(0, -1).toString('utf8');
  };
  return { sub, decrypt };
}

describe('web push', () => {
  it('encrypts a payload the subscribing browser can decrypt', () => {
    const { sub, decrypt } = browserSubscription();
    expect(isPushSubscription(sub)).toBe(true);
    const body = encryptPayload(sub, Buffer.from(JSON.stringify({ title: 'Ada replied', body: 'Done ✓' })));
    expect(JSON.parse(decrypt(body))).toEqual({ title: 'Ada replied', body: 'Done ✓' });
  });

  it('matches the RFC 8291 example byte for byte', () => {
    const b = (s: string) => Buffer.from(s, 'base64url');
    const sub = { endpoint: 'https://push.example.net/x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
    const body = encryptPayload(sub, Buffer.from('When I grow up, I want to be a watermelon'), b('DGv6ra1nlYgDCS1FRnbzlw'), b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signs a VAPID token the push service can verify with the public key', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/xyz', keys, 'https://example.com', 1_700_000_000_000);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = jwt.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(claims.exp).toBe(1_700_000_000 + 12 * 3600);
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
  });

  it('rejects malformed subscriptions', () => {
    expect(isPushSubscription({ endpoint: 'http://insecure', keys: { p256dh: 'x', auth: 'y' } })).toBe(false);
    expect(isPushSubscription(null)).toBe(false);
  });
});

describe('remote pairing', () => {
  it('trades a one-time code for a token, once', () => {
    const store = new RemoteStore(path.join(tempDir(), 'remote.json'));
    const { code } = store.startPairing();
    const paired = store.pair(code, 'iPhone');
    expect(paired?.device.name).toBe('iPhone');
    expect(store.authenticate(paired!.token)?.id).toBe(paired!.device.id);
    expect(store.pair(code, 'Again')).toBeNull();
    expect(store.authenticate('nope')).toBeNull();
  });

  it('closes the code after a few wrong guesses and when it expires', () => {
    const store = new RemoteStore(path.join(tempDir(), 'remote.json'));
    const { code } = store.startPairing();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(store.pair(wrong, 'x')).toBeNull();
    expect(store.pair(code, 'x')).toBeNull();

    const later = store.startPairing(0);
    expect(store.pair(later.code, 'x', 11 * 60_000)).toBeNull();
  });

  it('keeps devices but never their tokens on disk, and forgets revoked ones', () => {
    const file = path.join(tempDir(), 'remote.json');
    const store = new RemoteStore(file);
    store.update({ enabled: true });
    const { token, device } = store.pair(store.startPairing().code, 'Pixel')!;
    expect(readFileSync(file, 'utf8')).not.toContain(token);
    const reopened = new RemoteStore(file);
    expect(reopened.enabled).toBe(true);
    expect(reopened.authenticate(token)?.name).toBe('Pixel');
    reopened.revoke(device.id);
    expect(reopened.authenticate(token)).toBeNull();
  });
});

describe('remote server', () => {
  let server: RemoteServer | null = null;
  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  async function start() {
    const dir = tempDir();
    const staticDir = path.join(dir, 'renderer');
    mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
    writeFileSync(path.join(staticDir, 'index.html'), '<html><head><meta name="viewport" content="width=device-width" /></head><body></body></html>');
    writeFileSync(path.join(staticDir, 'assets', 'app.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'secret.txt'), 'secret');
    const store = new RemoteStore(path.join(dir, 'remote.json'));
    store.update({ enabled: true });
    const calls: Array<{ method: string; args: unknown[] }> = [];
    server = new RemoteServer({
      store,
      staticDir,
      uploadsDir: path.join(dir, 'uploads'),
      call: async (method, args) => {
        calls.push({ method, args });
        return { ok: true, value: `${method} done` };
      },
      onChange: () => {},
    });
    await server.start(0);
    const port = ((server as unknown as { server: { address(): AddressInfo } }).server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const { code } = store.startPairing();
    const pairRes = await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code, name: 'Test phone' }) });
    const { value } = (await pairRes.json()) as { value: { token: string } };
    const auth = { Authorization: `Bearer ${value.token}` };
    return { base, auth, calls, store, dir };
  }

  it('runs API calls for paired devices only, and keeps PC-only methods on the PC', async () => {
    const { base, auth, calls } = await start();
    expect((await fetch(`${base}/api/call/listAgents`, { method: 'POST', body: '{}' })).status).toBe(401);

    const ok = await fetch(`${base}/api/call/sendMessage`, { method: 'POST', headers: auth, body: JSON.stringify({ args: ['c1', 'hi', []] }) });
    expect(await ok.json()).toEqual({ ok: true, value: 'sendMessage done' });
    expect(calls).toEqual([{ method: 'sendMessage', args: ['c1', 'hi', []] }]);

    for (const blocked of ['openFolder', 'startRemotePairing', 'installUpdate', 'pickFolder']) {
      expect((await fetch(`${base}/api/call/${blocked}`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(403);
    }
    expect((await fetch(`${base}/api/call/notAMethod`, { method: 'POST', headers: auth, body: '{}' })).status).toBe(404);

    // Which programs run and how much they may do unasked can only be changed on the PC.
    await fetch(`${base}/api/call/updateSettings`, { method: 'POST', headers: auth, body: JSON.stringify({ args: [{ theme: 'dark', claudePath: 'C:\\evil.exe', allowSkipPermissions: true }] }) });
    expect(calls.at(-1)).toEqual({ method: 'updateSettings', args: [{ theme: 'dark' }] });
  });

  it('streams events to paired devices', async () => {
    const { base, auth } = await start();
    const res = await fetch(`${base}/api/events`, { headers: auth });
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toContain(': connected');
    server!.broadcast({ type: 'agents-changed' });
    expect((await reader.read()).value).toBe('data: {"type":"agents-changed"}\n\n');
    await reader.cancel();
  });

  it('saves uploads under the uploads folder with a safe name', async () => {
    const { base, auth, dir } = await start();
    const res = await fetch(`${base}/api/upload`, { method: 'POST', headers: { ...auth, 'X-File-Name': encodeURIComponent('..\\..\\photo.png') }, body: new Uint8Array([1, 2, 3]) });
    const { value } = (await res.json()) as { value: { path: string; name: string; isImage: boolean } };
    expect(value.name).toBe('photo.png');
    expect(value.isImage).toBe(true);
    expect(path.dirname(value.path)).toBe(path.join(dir, 'uploads'));
    expect([...readFileSync(value.path)]).toEqual([1, 2, 3]);
  });

  it('serves the app and its assets, but nothing outside them', async () => {
    const { base } = await start();
    const page = await (await fetch(`${base}/chats/anything`)).text();
    expect(page).toContain('rel="manifest"');
    expect(page).toContain('viewport-fit=cover');
    expect(await (await fetch(`${base}/assets/app.js`)).text()).toBe('console.log(1)');
    expect((await fetch(`${base}/..%2Fsecret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/sw.js`)).headers.get('content-type')).toContain('javascript');
  });

  it('limits pairing attempts', async () => {
    const { base } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await fetch(`${base}/api/pair`, { method: 'POST', body: JSON.stringify({ code: '999999x', name: 'x' }) })).status);
    expect(statuses.slice(0, 9).every((s) => s === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('web index', () => {
  it('adds the manifest and phone viewport to the desktop page', () => {
    const html = webIndex('<head><meta name="viewport" content="width=device-width, initial-scale=1.0" /></head>');
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(html.match(/name="viewport"/g)).toHaveLength(1);
  });
});
