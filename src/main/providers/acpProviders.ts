import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelOption } from '@shared/types';
import { isObject } from './claudeMapper';
import type { AcpDefinition, AuthCheck } from './acp';
import { geminiExecutableSpec, grokExecutableSpec, resolveCursorAgent, resolveExecutable, runCapture } from './process';

const model = (id: string, label: string): ModelOption => ({ id, label, isDefault: false, efforts: [], defaultEffort: null });

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/** Cursor's CLI (`agent`, formerly `cursor-agent`), signed in with your Cursor account. */
export const CURSOR: AcpDefinition = {
  id: 'cursor',
  resolve: (s) => resolveCursorAgent(s.cursorPath),
  installHint: 'Install the Cursor CLI (in PowerShell: irm https://cursor.com/install?win32=true | iex), then press Recheck.',
  acpArgs: async () => ['acp'],
  async checkAuth(exe, env): Promise<AuthCheck> {
    const res = await runCapture(exe, ['status', '--format', 'json'], env, 30_000);
    const parsed = (() => {
      try {
        const v = JSON.parse(res.stdout);
        return isObject(v) ? v : null;
      } catch {
        return null;
      }
    })();
    if (!parsed) return { signedIn: null, account: null, apiKey: false };
    return { signedIn: parsed.isAuthenticated === true, account: parsed.isAuthenticated === true ? 'Cursor account' : null, apiKey: false };
  },
  login: { display: 'agent login', args: ['login'] },
  logoutArgs: ['logout'],
  signedOutAction: 'Sign in with your Cursor account: press Sign in (opens a console running `agent login`) and finish in the browser, then press Recheck.',
  fallbackModels: [model('auto', 'Auto')],
};

/** Where Gemini CLI keeps its sign-in choice: `security.auth.selectedType` (current) or `selectedAuthType` (older). */
function geminiAuthType(): string | null {
  const settings = readJson(path.join(os.homedir(), '.gemini', 'settings.json'));
  if (!settings) return null;
  const security = isObject(settings.security) ? settings.security : {};
  const auth = isObject(security.auth) ? security.auth : {};
  const t = auth.selectedType ?? settings.selectedAuthType;
  return typeof t === 'string' ? t : null;
}

/** Google's Gemini CLI, signed in with a Google account. */
export const GEMINI: AcpDefinition = {
  id: 'gemini',
  resolve: (s) => resolveExecutable(geminiExecutableSpec(s.geminiPath)),
  installHint: 'Install Gemini CLI (npm install -g @google/gemini-cli), run `gemini` once to sign in with Google, then press Recheck.',
  async acpArgs(exe, env) {
    // Newer releases call the flag --acp; older ones only know --experimental-acp.
    const help = await runCapture(exe, ['--help'], env, 30_000);
    return /--acp\b/.test(help.stdout) ? ['--acp'] : ['--experimental-acp'];
  },
  launchArgs: (input) => (input.model ? ['--model', input.model] : []),
  authMethod: (offered) => {
    const selected = geminiAuthType();
    return selected && offered.includes(selected) ? selected : null;
  },
  async checkAuth(): Promise<AuthCheck> {
    const selected = geminiAuthType();
    if (!selected) return { signedIn: false, account: null, apiKey: false };
    if (selected === 'oauth-personal') {
      const signedIn = existsSync(path.join(os.homedir(), '.gemini', 'oauth_creds.json'));
      return { signedIn, account: signedIn ? 'Google account' : null, apiKey: false };
    }
    if (selected === 'gemini-api-key') return { signedIn: true, account: 'Gemini API key', apiKey: true };
    if (selected === 'vertex-ai') return { signedIn: true, account: 'Vertex AI', apiKey: true };
    return { signedIn: true, account: selected, apiKey: false };
  },
  login: { display: 'gemini', args: [] },
  logoutArgs: null,
  signedOutAction: 'Sign in with Google: press Sign in (opens Gemini CLI in a console), choose “Login with Google” and finish in the browser, then press Recheck.',
  // Gemini CLI's documented model aliases; ACP sessions don't always list models.
  fallbackModels: [model('auto', 'Auto'), model('pro', 'Pro'), model('flash', 'Flash'), model('flash-lite', 'Flash Lite')],
};

/** xAI's Grok CLI, signed in with an xAI account (`grok login`). */
export const GROK: AcpDefinition = {
  id: 'grok',
  resolve: (s) => resolveExecutable(grokExecutableSpec(s.grokPath)),
  installHint: 'Install xAI’s Grok CLI (see docs.x.ai, “Grok CLI”), run `grok login`, then press Recheck.',
  acpArgs: async () => ['agent', 'stdio'],
  // `cached_token` is the sign-in from `grok login`; `xai.api_key` would bill an API key, so it is never picked here.
  authMethod: (offered) => (offered.includes('cached_token') ? 'cached_token' : null),
  login: { display: 'grok login', args: ['login'] },
  logoutArgs: ['logout'],
  signedOutAction: 'Sign in with your xAI account: press Sign in (opens a console running `grok login`), then press Recheck.',
  fallbackModels: [],
};
