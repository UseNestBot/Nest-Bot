import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import type { ProviderId } from '@shared/types';
import path from 'node:path';
import os from 'node:os';

const isWindows = process.platform === 'win32';

export interface ResolvedExecutable {
  /** Absolute path to a real executable that can be spawned without a shell. */
  command: string;
  /** Arguments that must precede ours (e.g. a JS entry point run by node). */
  prefixArgs: string[];
  source: string;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.PATH ?? env.Path ?? '';
  return raw.split(path.delimiter).filter(Boolean);
}

/** Find `name` on PATH, honouring PATHEXT on Windows. Returns every hit in PATH order. */
export function whichAll(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const exts = isWindows ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  const hits: string[] = [];
  for (const dir of pathDirs(env)) {
    for (const ext of isWindows ? ['', ...exts] : ['']) {
      const candidate = path.join(dir, name + ext);
      if (isFile(candidate) && !hits.includes(candidate)) hits.push(candidate);
    }
  }
  return hits;
}

/**
 * npm installs `.cmd`/`.ps1` shims on Windows. Spawning a `.cmd` requires a
 * shell, which we avoid, so map the shim back to the real binary it launches.
 */
export function resolveNpmShim(shimPath: string, pkg: string, candidates: string[]): ResolvedExecutable | null {
  const dir = path.dirname(shimPath);
  const pkgDir = path.join(dir, 'node_modules', ...pkg.split('/'));
  for (const rel of candidates) {
    const full = path.join(pkgDir, rel);
    if (!isFile(full)) continue;
    if (full.endsWith('.js') || full.endsWith('.cjs') || full.endsWith('.mjs')) {
      const node = whichAll('node').find((p) => !/\.(cmd|bat)$/i.test(p));
      if (node) return { command: node, prefixArgs: [full], source: `npm package ${pkg} via node` };
      continue;
    }
    return { command: full, prefixArgs: [], source: `npm package ${pkg}` };
  }
  return null;
}

export interface ExecutableSpec {
  name: string;
  configuredPath: string | null;
  knownLocations: string[];
  npmPackage: string;
  npmCandidates: string[];
}

export function resolveExecutable(spec: ExecutableSpec): ResolvedExecutable | null {
  if (spec.configuredPath) {
    if (isFile(spec.configuredPath)) {
      if (/\.(c|m)?js$/i.test(spec.configuredPath)) {
        // A JavaScript entry point (e.g. an npm package's cli.js) runs under node.
        const node = whichAll('node').find((p) => !/\.(cmd|bat)$/i.test(p));
        return node ? { command: node, prefixArgs: [spec.configuredPath], source: 'configured script via node' } : null;
      }
      if (/\.(cmd|bat|ps1)$/i.test(spec.configuredPath)) {
        const viaShim = resolveNpmShim(spec.configuredPath, spec.npmPackage, spec.npmCandidates);
        if (viaShim) return viaShim;
      } else {
        return { command: spec.configuredPath, prefixArgs: [], source: 'configured path' };
      }
    }
    return null;
  }
  for (const hit of whichAll(spec.name)) {
    if (/\.(cmd|bat|ps1)$/i.test(hit)) {
      const viaShim = resolveNpmShim(hit, spec.npmPackage, spec.npmCandidates);
      if (viaShim) return viaShim;
      continue;
    }
    if (isWindows && !/\.(exe|com)$/i.test(hit)) continue; // extensionless sh scripts are not runnable
    return { command: hit, prefixArgs: [], source: 'PATH' };
  }
  for (const loc of spec.knownLocations) {
    if (isFile(loc)) return { command: loc, prefixArgs: [], source: 'default install location' };
  }
  return null;
}

export function claudeExecutableSpec(configuredPath: string | null): ExecutableSpec {
  const home = os.homedir();
  return {
    name: 'claude',
    configuredPath,
    knownLocations: isWindows
      ? [path.join(home, '.local', 'bin', 'claude.exe'), path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')]
      : [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude')],
    npmPackage: '@anthropic-ai/claude-code',
    npmCandidates: isWindows ? ['bin/claude.exe', 'cli.js'] : ['bin/claude', 'cli.js'],
  };
}

export function codexExecutableSpec(configuredPath: string | null): ExecutableSpec {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return {
    name: 'codex',
    configuredPath,
    knownLocations: isWindows
      ? [path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'), path.join(os.homedir(), '.codex', 'packages', 'standalone', 'current', 'bin', 'codex.exe')]
      : [path.join(os.homedir(), '.local', 'bin', 'codex')],
    npmPackage: '@openai/codex',
    npmCandidates: ['bin/codex.js'],
  };
}

export function geminiExecutableSpec(configuredPath: string | null): ExecutableSpec {
  return {
    name: 'gemini',
    configuredPath,
    knownLocations: isWindows ? [] : [path.join(os.homedir(), '.local', 'bin', 'gemini')],
    npmPackage: '@google/gemini-cli',
    npmCandidates: ['bundle/gemini.js', 'dist/index.js'],
  };
}

export function grokExecutableSpec(configuredPath: string | null): ExecutableSpec {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  return {
    name: 'grok',
    configuredPath,
    knownLocations: isWindows
      ? [path.join(home, '.grok', 'bin', 'grok.exe'), path.join(home, '.local', 'bin', 'grok.exe'), path.join(local, 'Programs', 'grok', 'grok.exe')]
      : [path.join(home, '.grok', 'bin', 'grok'), path.join(home, '.local', 'bin', 'grok')],
    // xAI ships a native binary, not an npm package.
    npmPackage: '',
    npmCandidates: [],
  };
}

/**
 * Cursor's CLI installs a `.ps1`/`.cmd` launcher next to `versions/<date>-<commit>/`,
 * each holding its own node.exe and index.js. The launcher picks the newest version;
 * we do the same so nothing goes through a shell.
 */
export function resolveCursorAgent(configuredPath: string | null): ResolvedExecutable | null {
  const fromVersions = (root: string): ResolvedExecutable | null => {
    const versions = path.join(root, 'versions');
    let names: string[];
    try {
      names = readdirSync(versions).filter((n) => /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(n));
    } catch {
      return null;
    }
    // Newest date first, as the launcher does; the optional build time breaks ties.
    const key = (n: string) => {
      const [date, ...rest] = n.split('-');
      const [y, m, d] = date.split('.');
      return `${y}${m.padStart(2, '0')}${d.padStart(2, '0')}-${rest.slice(0, -1).join('-')}`;
    };
    names.sort((a, b) => key(b).localeCompare(key(a)));
    for (const name of names) {
      const dir = path.join(versions, name);
      const node = path.join(dir, isWindows ? 'node.exe' : 'node');
      const entry = path.join(dir, 'index.js');
      if (isFile(node) && isFile(entry)) return { command: node, prefixArgs: [entry], source: `Cursor agent ${name}` };
    }
    return null;
  };
  if (configuredPath) {
    if (!existsSync(configuredPath)) return null;
    if (/\.(c|m)?js$/i.test(configuredPath)) {
      const node = path.join(path.dirname(configuredPath), isWindows ? 'node.exe' : 'node');
      if (isFile(node)) return { command: node, prefixArgs: [configuredPath], source: 'configured script' };
    }
    const root = isFile(configuredPath) ? path.dirname(configuredPath) : configuredPath;
    return fromVersions(root) ?? (isFile(configuredPath) && /\.(exe)$/i.test(configuredPath) ? { command: configuredPath, prefixArgs: [], source: 'configured path' } : null);
  }
  for (const name of ['cursor-agent', 'agent']) {
    for (const hit of whichAll(name)) {
      const viaVersions = fromVersions(path.dirname(hit));
      if (viaVersions) return viaVersions;
      if (!isWindows || /\.(exe|com)$/i.test(hit)) return { command: hit, prefixArgs: [], source: 'PATH' };
    }
  }
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return fromVersions(isWindows ? path.join(local, 'cursor-agent') : path.join(os.homedir(), '.local', 'share', 'cursor-agent'));
}

/** Env vars from a parent Claude Code / agent host that must not leak into child sessions. */
const HOST_SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_(?!OAUTH_TOKEN$|GIT_BASH_PATH$).*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*)$/;

export interface ChildEnvResult {
  env: NodeJS.ProcessEnv;
  /** Names (never values) of variables that were removed because they would change billing. */
  removedBillingVars: string[];
}

/**
 * Build the environment for a provider process. API-key and alternate-endpoint
 * variables are removed so a stray key can never silently switch a
 * subscription-backed run to API billing.
 */
const BILLING_VARS: Partial<Record<ProviderId, RegExp>> = {
  claude: /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/,
  codex: /^(OPENAI_API_KEY|CODEX_API_KEY|OPENAI_BASE_URL)$/,
  cursor: /^(CURSOR_API_KEY|CURSOR_API_ENDPOINT)$/,
  gemini: /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_VERTEXAI|GOOGLE_GENAI_USE_GCA)$/,
  grok: /^(XAI_API_KEY|GROK_API_KEY)$/,
};

export function buildChildEnv(provider: ProviderId, base: NodeJS.ProcessEnv = process.env, opts: { keepBillingVars?: boolean } = {}): ChildEnvResult {
  const env: NodeJS.ProcessEnv = {};
  const removedBillingVars: string[] = [];
  const billing = (!opts.keepBillingVars && BILLING_VARS[provider]) || /^$/;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (billing.test(key)) {
      removedBillingVars.push(key);
      continue;
    }
    if (HOST_SESSION_VARS.test(key) || key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VITE_')) continue;
    env[key] = value;
  }
  return { env, removedBillingVars };
}

/** Grace period between SIGTERM and SIGKILL when force-stopping a POSIX process tree. */
const POSIX_SIGKILL_GRACE_MS = 2000;

/** Terminate a process and all of its descendants. Safe to call more than once. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    if (isWindows) {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    const pid = child.pid;
    // Signal the whole process group: spawnProvider makes the child a group
    // leader on POSIX, so this reaches the CLI's own descendants too. Fall back
    // to the child alone if it never became one.
    const signal = (sig: NodeJS.Signals): void => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    signal('SIGTERM');
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    // SIGTERM is advisory, so a wedged agent would otherwise outlive a cancel
    // that Windows ends outright with /F. Escalate to SIGKILL after a grace period.
    let timer: NodeJS.Timeout | undefined;
    const onExit = (): void => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
    timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      signal('SIGKILL');
      resolve();
    }, POSIX_SIGKILL_GRACE_MS);
  });
}

/** Wait for a child to exit, killing its tree after `timeoutMs`. */
export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      void killTree(child);
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export function spawnProvider(exe: ResolvedExecutable, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }): ChildProcess {
  return spawn(exe.command, [...exe.prefixArgs, ...args], {
    cwd: opts.cwd && existsSync(opts.cwd) ? opts.cwd : os.homedir(),
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: !isWindows, // own process group on POSIX so killTree can signal it
  });
}

/** Run a short command and capture its output (for --version / auth status). */
export function runCapture(
  exe: ResolvedExecutable,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 15000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      exe.command,
      [...exe.prefixArgs, ...args],
      { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, cwd: os.homedir() },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException).code === 'number' ? ((error as unknown as { code: number }).code) : error ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
