import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserSupport } from '@shared/types';

/**
 * Whether Claude in Chrome (`claude --chrome`) can work on this computer.
 * Only local install facts are read: Chrome's location, Claude Code's
 * native-messaging host registration, and which extension folders exist in
 * Chrome profiles. No browser data, cookies or credentials.
 */

/** The Claude in Chrome extension, as allowed by Claude Code's native host manifest. */
export const CLAUDE_IN_CHROME_EXTENSION_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
export const CLAUDE_IN_CHROME_URL = 'https://claude.ai/chrome';
const HOST_NAME = 'com.anthropic.claude_code_browser_extension';

export interface ChromeFacts {
  /** null when the platform check isn't implemented. */
  chromeInstalled: boolean | null;
  extensionInstalled: boolean | null;
  /** Claude Code registered its native host with Chrome (it does so the first time Chrome integration runs). */
  hostRegistered: boolean | null;
}

export function claudeChromeSupport(f: ChromeFacts): BrowserSupport {
  const base = 'Claude in Chrome: the agent opens and controls tabs in your Chrome through the Claude in Chrome extension, signed in to the same Claude account as Claude Code. Each browser action asks for approval unless you allow it.';
  const missing: string[] = [];
  if (f.chromeInstalled === false) missing.push('Install Google Chrome.');
  if (f.extensionInstalled === false) missing.push(`Install the Claude in Chrome extension (${CLAUDE_IN_CHROME_URL}) and sign in with your Claude account.`);
  if (missing.length) return { available: true, ready: false, missing, note: base };
  const unknown = f.chromeInstalled === null || f.extensionInstalled === null;
  return {
    available: true,
    ready: unknown ? null : true,
    missing: [],
    note: f.hostRegistered === false ? `${base} Claude Code connects to Chrome the first time an agent uses it; keep Chrome open.` : `${base} Keep Chrome open while the agent browses.`,
  };
}

function regDefault(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /REG_SZ\s+(.+)\s*$/m.exec(String(stdout));
      resolve(m ? m[1].trim() : null);
    });
  });
}

function chromeUserDataDirs(env: NodeJS.ProcessEnv): string[] {
  return [env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data') : null].filter((d): d is string => Boolean(d && existsSync(d)));
}

/** Extension ids present in any Chrome profile (`Default`, `Profile N`, …). */
function installedExtensionIds(userData: string): Set<string> {
  const ids = new Set<string>();
  let profiles: string[] = [];
  try {
    profiles = readdirSync(userData).filter((d) => d === 'Default' || /^Profile \d+$/.test(d));
  } catch {
    return ids;
  }
  for (const p of profiles) {
    try {
      for (const id of readdirSync(path.join(userData, p, 'Extensions'))) ids.add(id);
    } catch {
      /* profile without extensions */
    }
  }
  return ids;
}

export async function detectClaudeChrome(env: NodeJS.ProcessEnv = process.env): Promise<ChromeFacts> {
  if (process.platform !== 'win32') return { chromeInstalled: null, extensionInstalled: null, hostRegistered: null };
  const exeCandidates = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter((d): d is string => Boolean(d))
    .map((d) => path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  const chromeInstalled = exeCandidates.some((p) => existsSync(p));
  const manifestPath = await regDefault(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
  let extensionIdsAllowed = [CLAUDE_IN_CHROME_EXTENSION_ID];
  if (manifestPath && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { allowed_origins?: string[] };
      const ids = (manifest.allowed_origins ?? []).map((o) => /^chrome-extension:\/\/([a-p]{32})\/?$/.exec(o)?.[1]).filter((x): x is string => Boolean(x));
      if (ids.length) extensionIdsAllowed = ids;
    } catch {
      /* fall back to the known id */
    }
  }
  const dirs = chromeUserDataDirs(env);
  const extensionInstalled = dirs.length === 0 ? false : dirs.some((d) => {
    const installed = installedExtensionIds(d);
    return extensionIdsAllowed.some((id) => installed.has(id));
  });
  return { chromeInstalled, extensionInstalled, hostRegistered: Boolean(manifestPath && existsSync(manifestPath)) };
}
