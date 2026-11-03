import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ForgeKind, ForgeTokenSource } from '@shared/types';
import type { SecretCipher } from '../apiKeys';
import { maskKey } from '../apiKeys';
import { whichAll } from '../providers/process';

const isWindows = process.platform === 'win32';
const DISCOVERY_TIMEOUT_MS = 15_000;

interface ForgeFile {
  version: 1;
  /** Self-hosted forges the user added. */
  hosts: Array<{ host: string; kind: ForgeKind }>;
  /** Pasted tokens by host, encrypted, base64. Never plain text. */
  tokens: Record<string, string>;
}

/**
 * Forge hosts the user added and tokens they pasted. Like API keys, tokens
 * live encrypted in their own file and never reach the renderer.
 */
export class ForgeStore {
  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
  ) {}

  private read(): ForgeFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as ForgeFile;
      if (parsed?.version === 1) return { version: 1, hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [], tokens: parsed.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {} };
    } catch {
      /* missing or unreadable */
    }
    return { version: 1, hosts: [], tokens: {} };
  }

  private write(data: ForgeFile): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  hosts(): Array<{ host: string; kind: ForgeKind }> {
    return this.read().hosts;
  }

  addHost(host: string, kind: ForgeKind): void {
    const data = this.read();
    data.hosts = [...data.hosts.filter((h) => h.host !== host), { host, kind }];
    this.write(data);
  }

  removeHost(host: string): void {
    const data = this.read();
    data.hosts = data.hosts.filter((h) => h.host !== host);
    delete data.tokens[host];
    this.write(data);
  }

  token(host: string): string | null {
    const blob = this.read().tokens[host];
    if (!blob || !this.cipher.available()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(blob, 'base64')) || null;
    } catch {
      return null; // encrypted for another user or machine
    }
  }

  hint(host: string): string | null {
    const t = this.token(host);
    return t ? maskKey(t) : null;
  }

  setToken(host: string, token: string): void {
    if (!this.cipher.available()) throw new Error('This computer can’t encrypt the token (no system keyring is available), so Nest won’t save it.');
    const data = this.read();
    data.tokens[host] = this.cipher.encrypt(token).toString('base64');
    this.write(data);
  }

  clearToken(host: string): void {
    const data = this.read();
    if (!(host in data.tokens)) return;
    delete data.tokens[host];
    this.write(data);
  }
}

/** A credential for one host. `username` is set when it came as a user name and password. */
export interface ForgeCredential {
  token: string;
  username: string | null;
  source: ForgeTokenSource;
}

export type Exec = (command: string, args: string[], opts?: { input?: string; env?: NodeJS.ProcessEnv }) => Promise<{ code: number | null; stdout: string }>;

/** Run a helper program briefly, without a shell, a window or a terminal to prompt in. */
export const execHelper: Exec = (command, args, opts = {}) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { cwd: os.homedir(), env: opts.env ?? process.env, windowsHide: true, detached: !isWindows, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return resolve({ code: null, stdout: '' });
    }
    const out: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        if (!isWindows && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill();
      } catch {
        /* gone */
      }
    }, DISCOVERY_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: '' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });

/** The first executable called `name` on PATH (no .cmd/.bat wrappers on Windows: they need a shell). */
export function findExe(name: string): string | null {
  return whichAll(name).find((p) => !isWindows || /\.exe$/i.test(p)) ?? null;
}

/** An environment where nothing can pop up a prompt or a sign-in window. */
function quietEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
  };
}

/** Where tea (the Gitea CLI) keeps its logins. */
export function teaConfigPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = os.homedir();
  const paths = [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'tea', 'config.yml')];
  if (isWindows) {
    if (env.LOCALAPPDATA) paths.push(path.join(env.LOCALAPPDATA, 'tea', 'config.yml'));
    if (env.APPDATA) paths.push(path.join(env.APPDATA, 'tea', 'config.yml'));
  }
  if (process.platform === 'darwin') paths.push(path.join(home, 'Library', 'Application Support', 'tea', 'config.yml'));
  return paths;
}

/** Read the token for a host from tea's config.yml (a list of logins with url and token). */
export function teaTokenFrom(yaml: string, host: string): string | null {
  let url: string | null = null;
  let token: string | null = null;
  const flush = () => {
    const hit = url && token && hostOf(url) === host ? token : null;
    url = null;
    token = null;
    return hit;
  };
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\s*-\s/.test(line)) {
      const hit = flush();
      if (hit) return hit;
    }
    const m = /^\s*(?:-\s+)?(url|token):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const value = m[2].replace(/^(["'])(.*)\1$/, '$2');
    if (m[1] === 'url') url = value;
    else token = value;
  }
  return flush();
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Parse `git credential fill` output. */
export function parseCredential(out: string): { username: string | null; password: string | null } {
  const values = new Map<string, string>();
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) values.set(line.slice(0, i), line.slice(i + 1));
  }
  return { username: values.get('username') || null, password: values.get('password') || null };
}

export interface DiscoveryDeps {
  exec: Exec;
  find: (name: string) => string | null;
  readFile: (p: string) => string | null;
  git: () => string | null;
}

const readQuietly = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export const defaultDiscovery = (git: () => string | null): DiscoveryDeps => ({ exec: execHelper, find: findExe, readFile: readQuietly, git });

/**
 * Credentials the user already has for a host, best first: the forge's own
 * CLI (gh, glab, tea), then git's credential helper. Each is tried quietly:
 * nothing here may open a prompt or sign-in window.
 */
export async function discoverCredentials(host: string, kind: ForgeKind, deps: DiscoveryDeps): Promise<ForgeCredential[]> {
  const found: ForgeCredential[] = [];
  const env = quietEnv();
  const bareHost = host.split(':')[0];
  if (kind === 'github') {
    const gh = deps.find('gh');
    if (gh) {
      const res = await deps.exec(gh, ['auth', 'token', '--hostname', host], { env });
      const token = res.stdout.trim();
      if (res.code === 0 && token && !/\s/.test(token)) found.push({ token, username: null, source: 'gh' });
    }
  } else if (kind === 'gitlab') {
    const glab = deps.find('glab');
    if (glab) {
      const res = await deps.exec(glab, ['config', 'get', 'token', '--host', bareHost], { env });
      const token = res.stdout.trim();
      if (res.code === 0 && token && !/\s/.test(token)) found.push({ token, username: null, source: 'glab' });
    }
  } else {
    for (const file of teaConfigPaths()) {
      const yaml = deps.readFile(file);
      const token = yaml ? teaTokenFrom(yaml, host) : null;
      if (token) {
        found.push({ token, username: null, source: 'tea' });
        break;
      }
    }
  }
  const git = deps.git();
  if (git) {
    const res = await deps.exec(git, ['-c', 'credential.interactive=false', '-c', 'core.askPass=', 'credential', 'fill'], { env, input: `protocol=https\nhost=${host}\n\n` });
    const cred = res.code === 0 ? parseCredential(res.stdout) : null;
    if (cred?.password) found.push({ token: cred.password, username: cred.username, source: 'credential' });
  }
  return found;
}
