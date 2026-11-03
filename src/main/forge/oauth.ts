import type { ForgeKind } from '@shared/types';
import { ForgeError, type Fetch } from './clients';

/**
 * OAuth apps Nest signs in with, by host. A desktop app can't keep a client
 * secret, so this is the device flow: Nest shows a code, the user enters it on
 * the forge's site, and Nest polls for the token. Each forge needs an OAuth
 * app registered for Nest (device flow enabled; no secret); put its public
 * client ID here, or the user sets one per host in Settings.
 */
export const BUILT_IN_OAUTH_CLIENTS: Readonly<Record<string, string>> = {
  // 'github.com': '<client ID of a GitHub OAuth app with device flow enabled>',
  // 'gitlab.com': '<application ID of a non-confidential GitLab application with the api scope>',
};

/** Forges with a device flow. Forgejo and Gitea don't have one. */
export function supportsDeviceFlow(kind: ForgeKind): boolean {
  return kind === 'github' || kind === 'gitlab';
}

const SCOPES: Record<'github' | 'gitlab', string> = { github: 'repo read:org', gitlab: 'api' };
const TIMEOUT_MS = 20_000;

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  /** Seconds between polls. */
  interval: number;
  /** ms since epoch. */
  expiresAt: number;
}

export interface OAuthToken {
  access: string;
  refresh: string | null;
  /** ms since epoch; null when it doesn't expire. */
  expiresAt: number | null;
  clientId: string;
}

function endpoints(kind: ForgeKind, host: string): { device: string; token: string } {
  if (kind === 'github') return { device: `https://${host}/login/device/code`, token: `https://${host}/login/oauth/access_token` };
  if (kind === 'gitlab') return { device: `https://${host}/oauth/authorize_device`, token: `https://${host}/oauth/token` };
  throw new ForgeError('This forge doesn’t offer browser sign-in for desktop apps. Paste a token instead.');
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

async function post(fetch: Fetch, url: string, form: Record<string, string>): Promise<{ status: number; data: Json }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Nest' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ForgeError(`Couldn’t reach the forge: ${(err as Error).message}`);
  }
  let data: Json = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.status, data };
}

function token(data: Json, clientId: string): OAuthToken {
  return {
    access: data.access_token,
    refresh: data.refresh_token ?? null,
    expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : null,
    clientId,
  };
}

export async function startDeviceFlow(fetch: Fetch, kind: ForgeKind, host: string, clientId: string): Promise<DeviceStart> {
  const { device } = endpoints(kind, host);
  const { status, data } = await post(fetch, device, { client_id: clientId, scope: SCOPES[kind as 'github' | 'gitlab'] });
  if (status >= 400 || !data?.device_code) {
    const why = data?.error_description ?? data?.error ?? `${status}`;
    throw new ForgeError(/device_flow_disabled|unauthorized_client|invalid_client/.test(String(data?.error)) ? `The OAuth app for ${host} isn’t set up for device sign-in (${why}).` : `Couldn’t start the sign-in: ${why}`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri_complete ?? data.verification_uri,
    interval: Math.max(Number(data.interval) || 5, 1),
    expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
  };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new ForgeError('Sign-in cancelled.'));
      },
      { once: true },
    );
  });

/** Poll until the user approves (or denies, or the code expires). */
export async function pollDeviceFlow(fetch: Fetch, kind: ForgeKind, host: string, clientId: string, start: DeviceStart, signal: AbortSignal, wait = sleep): Promise<OAuthToken> {
  const { token: url } = endpoints(kind, host);
  let interval = start.interval;
  while (Date.now() < start.expiresAt) {
    await wait(interval * 1000, signal);
    const { data } = await post(fetch, url, { client_id: clientId, device_code: start.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
    if (data?.access_token) return token(data, clientId);
    switch (data?.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        interval = Number(data.interval) || interval + 5;
        continue;
      case 'access_denied':
        throw new ForgeError('Sign-in was denied on the forge’s site.');
      case 'expired_token':
        throw new ForgeError('The sign-in code expired. Start again.');
      default:
        throw new ForgeError(`Sign-in failed: ${data?.error_description ?? data?.error ?? 'no token came back'}`);
    }
  }
  throw new ForgeError('The sign-in code expired. Start again.');
}

/** Swap a refresh token for a new access token (GitLab's last two hours). */
export async function refreshOAuth(fetch: Fetch, kind: ForgeKind, host: string, current: OAuthToken): Promise<OAuthToken> {
  if (!current.refresh) throw new ForgeError('The browser sign-in expired. Sign in again.');
  const { token: url } = endpoints(kind, host);
  const { data } = await post(fetch, url, { client_id: current.clientId, grant_type: 'refresh_token', refresh_token: current.refresh });
  if (!data?.access_token) throw new ForgeError('The browser sign-in expired. Sign in again.');
  return token(data, current.clientId);
}
