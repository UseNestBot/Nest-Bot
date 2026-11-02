import { API_METHODS, type NestApi } from '@shared/ipc';
import type { Attachment, NestEvent } from '@shared/types';

/** The device token from pairing; it lives only in this browser. */
const TOKEN_KEY = 'nest.remote.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: pairing lasts for this tab only */
  }
  memoryToken = token;
}

let memoryToken: string | null = getToken();

/** Raised when the PC no longer accepts this device's token. */
export class UnpairedError extends Error {}

const unpairedListeners = new Set<() => void>();
export function onUnpaired(listener: () => void): () => void {
  unpairedListeners.add(listener);
  return () => unpairedListeners.delete(listener);
}

function unpaired(): never {
  setToken(null);
  for (const l of unpairedListeners) l();
  throw new UnpairedError('This device isn’t paired with Nest any more.');
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...(memoryToken ? { Authorization: `Bearer ${memoryToken}` } : {}) } });
  } catch {
    throw new Error('Can’t reach your PC. Check that it’s on, Nest is open, and Tailscale is connected.');
  }
  if (res.status === 401 && memoryToken && !url.endsWith('/api/pair')) unpaired();
  const body = (await res.json().catch(() => null)) as { ok: true; value: T } | { ok: false; error: string } | null;
  if (!body) throw new Error(`Your PC answered with an error (${res.status}).`);
  if (!body.ok) throw new Error(body.error);
  return body.value;
}

const postJson = <T>(url: string, data: unknown): Promise<T> => request<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

export async function pair(code: string, name: string): Promise<void> {
  const { token } = await postJson<{ token: string }>('/api/pair', { code, name });
  setToken(token);
}

export function forget(): void {
  setToken(null);
  for (const l of unpairedListeners) l();
}

/** Send a file to the PC; agents get it as an attachment path there. */
export function upload(file: Blob, name: string): Promise<Attachment> {
  return request<Attachment>('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) }, body: file });
}

function chooseFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    // No change event when the picker is dismissed; resolve empty once focus comes back.
    input.addEventListener('cancel', () => resolve([]));
    input.click();
  });
}

const listeners = new Set<(event: NestEvent) => void>();

/** Hand an event to the app as if the PC had sent it (e.g. a tapped notification). */
export function emitLocal(event: NestEvent): void {
  for (const l of listeners) l(event);
}

/** Connection state for the banner. */
export type Link = 'connecting' | 'online' | 'offline';
const linkListeners = new Set<(link: Link) => void>();
let link: Link = 'connecting';
function setLink(next: Link): void {
  if (next === link) return;
  link = next;
  for (const l of linkListeners) l(next);
}
export function onLink(listener: (link: Link) => void): () => void {
  linkListeners.add(listener);
  listener(link);
  return () => linkListeners.delete(listener);
}

let streaming = false;

/** Window event: the stream reconnected, so lists and the open chat should be fetched again. */
export const RESYNC_EVENT = 'nest:resync';

/**
 * One event stream for the whole app (fetch, not EventSource, so the token can
 * go in a header). Reconnects with backoff; after a reconnect the app reloads
 * its lists, since events sent while offline are gone.
 */
async function streamEvents(): Promise<void> {
  if (streaming) return;
  streaming = true;
  let delay = 1000;
  let wasOnline = false;
  while (memoryToken) {
    try {
      const res = await fetch('/api/events', { headers: { Authorization: `Bearer ${memoryToken}` }, cache: 'no-store' });
      if (res.status === 401) {
        streaming = false;
        unpaired();
      }
      if (!res.ok || !res.body) throw new Error(String(res.status));
      setLink('online');
      // Events sent while offline are gone: reload what's on screen.
      if (wasOnline) window.dispatchEvent(new Event(RESYNC_EVENT));
      wasOnline = true;
      delay = 1000;
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const data = chunk
            .split('\n')
            .filter((l) => l.startsWith('data: '))
            .map((l) => l.slice(6))
            .join('\n');
          if (data) emitLocal(JSON.parse(data) as NestEvent);
        }
      }
    } catch (err) {
      if (err instanceof UnpairedError) return;
    }
    setLink('offline');
    // Phones suspend background tabs; retry as soon as the app is looked at again.
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        document.removeEventListener('visibilitychange', onVisible);
        resolve();
      };
      const onVisible = () => document.visibilityState === 'visible' && done();
      const timer = setTimeout(done, delay);
      document.addEventListener('visibilitychange', onVisible);
    });
    delay = Math.min(delay * 2, 15_000);
  }
  streaming = false;
}

/** NestApi over HTTP to the PC, for the web app on a phone. */
export function createWebApi(): NestApi {
  const remote = Object.fromEntries(API_METHODS.map((method) => [method, (...args: unknown[]) => postJson(`/api/call/${method}`, { args })])) as unknown as NestApi;
  return {
    ...remote,
    // Things the PC does with its own dialogs and apps, done in the phone's browser instead.
    pickFiles: async () => Promise.all((await chooseFiles()).map((f) => upload(f, f.name))),
    savePastedImage: (data, mimeType) => upload(new Blob([data as Uint8Array<ArrayBuffer>], { type: mimeType }), `pasted.${mimeType.split('/')[1] ?? 'png'}`),
    pickFolder: async () => window.prompt('Folder on your PC (full path):')?.trim() || null,
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    openFolder: async () => {
      throw new Error('Open folders on your PC.');
    },
    onEvent(listener) {
      listeners.add(listener);
      void streamEvents();
      return () => listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// Push notifications. iOS only offers them once Nest is added to the Home Screen.

export function pushSupported(): boolean {
  return isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Installed on every load so a tapped notification can find the app. */
export function registerServiceWorker(onOpen: (conversationId: string) => void): void {
  if (!isSecureContext || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent<{ type?: string; conversationId?: string }>) => {
    if (e.data?.type === 'open-conversation' && e.data.conversationId) onOpen(e.data.conversationId);
  });
}

/** Whether this device gets notifications from the PC right now. */
export async function pushEnabled(): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const { subscribed } = await request<{ subscribed: boolean }>('/api/push');
  const reg = await navigator.serviceWorker.getRegistration();
  return subscribed && Boolean(await reg?.pushManager.getSubscription());
}

export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('This browser can’t get notifications. On iPhone, add Nest to your Home Screen first (Share → Add to Home Screen) and open it from there.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for Nest in this browser’s settings.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await request<{ publicKey: string }>('/api/push');
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  let sub = await reg.pushManager.getSubscription();
  // A subscription made for another server key can't receive this PC's pushes.
  const current = sub?.options.applicationServerKey;
  if (sub && current && !sameBytes(new Uint8Array(current), key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await postJson('/api/push', { subscription: sub.toJSON() });
}

export async function disablePush(): Promise<void> {
  await postJson('/api/push', { subscription: null });
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Restart the event stream after pairing. */
export function connect(): void {
  void streamEvents();
}
