import { spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitBranch, GitDiff, GitStatus } from '@shared/types';
import { whichAll } from '../providers/process';
import { BRANCH_FORMAT, isCloneableUrl, isSafeRelativePath, parseBranches, parseRemotes, parseStatus, repoFolderName } from './parse';

const isWindows = process.platform === 'win32';
const LOCAL_TIMEOUT_MS = 30_000;
/** Fetch, pull, push and clone talk to a server and may wait on a credential window. */
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_DIFF_CHARS = 400_000;
/** Stop watching a repository nobody has asked about for this long. */
const WATCH_IDLE_MS = 10 * 60_000;
const WATCH_DEBOUNCE_MS = 400;

/** A git failure, worded for the user. */
export class GitError extends Error {}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  timeoutMs?: number;
  /** Exit codes that aren't failures (e.g. 1 from `diff --no-index`). */
  okCodes?: number[];
}

/** Where git is: on PATH, or a usual install location. */
export function findGit(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const hit of whichAll('git', env)) {
    // Git for Windows' cmd\git.exe is the launcher meant for other programs; skip .cmd/.bat wrappers.
    if (isWindows && !/\.exe$/i.test(hit)) continue;
    return hit;
  }
  const local = env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const known = isWindows
    ? [
        path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
        path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'cmd', 'git.exe'),
        path.join(local, 'Programs', 'Git', 'cmd', 'git.exe'),
      ]
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  return known.find((p) => existsSync(p)) ?? null;
}

/** Turn git's stderr into something a person can act on. */
export function friendlyGitError(stderr: string, args: string[]): string {
  const text = stderr
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .join('\n')
    .replace(/^(fatal|error): /gm, '');
  if (/Author identity unknown|Please tell me who you are|unable to auto-detect email/i.test(stderr)) {
    return 'Git doesn’t know who you are yet. Run git config --global user.name "Your Name" and git config --global user.email you@example.com, then try again.';
  }
  if (/index\.lock/.test(stderr)) return 'Another git command is running in this repository (maybe the agent’s). Try again in a moment.';
  if (/Not possible to fast-forward|have diverged|non-fast-forward/i.test(stderr)) {
    return args[0] === 'push'
      ? 'The remote has commits you don’t have. Pull first, then push.'
      : 'Your branch and the remote have both moved on. Merge or rebase them in the terminal, then try again.';
  }
  if (/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey/i.test(stderr)) {
    return `Git couldn’t sign in to the remote. Set up a credential helper or SSH key for it, then try again.\n\n${text}`;
  }
  return text || `git ${args[0]} failed.`;
}

/**
 * Git for one machine, run through the user's own `git` so their config,
 * credential helpers, hooks and signing all apply. Nothing here prompts in a
 * terminal: it would hang with nobody to answer.
 */
export class GitService {
  private gitPath: string | null | undefined;
  private version: string | null | undefined;
  /** Mutating commands queue per repository so Nest never races itself for the index lock. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly watchers = new Map<string, { watchers: FSWatcher[]; timer: ReturnType<typeof setTimeout> | null; lastUsed: number }>();
  private sweep: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly onChange: (root: string) => void = () => {}) {}

  /** Forget the git found earlier (after the user installs it, say). */
  redetect(): void {
    this.gitPath = undefined;
    this.version = undefined;
  }

  private exe(): string {
    if (this.gitPath === undefined) this.gitPath = findGit();
    if (!this.gitPath) throw new GitError('Git isn’t installed, or Nest can’t find it. Install it from git-scm.com and restart Nest.');
    return this.gitPath;
  }

  private run(cwd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const exe = this.exe();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      // Paths from the renderer are literal, never globs or pathspec magic.
      GIT_LITERAL_PATHSPECS: '1',
      // Reading status must not take the index lock an agent's git may need.
      GIT_OPTIONAL_LOCKS: '0',
      GIT_PAGER: 'cat',
      LANG: 'C',
      LC_ALL: 'C',
    };
    return new Promise((resolve, reject) => {
      // detached on POSIX: no controlling terminal, so ssh can't sit waiting on a passphrase prompt.
      const child = spawn(exe, ['-c', 'core.quotepath=false', '-c', 'color.ui=false', ...args], { cwd, env, windowsHide: true, detached: !isWindows, stdio: ['ignore', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      let killed: string | null = null;
      const kill = (why: string) => {
        killed = why;
        try {
          if (!isWindows && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill();
        } catch {
          /* already gone */
        }
      };
      child.stdout.on('data', (b: Buffer) => {
        size += b.length;
        if (size > MAX_OUTPUT_BYTES) kill('produced too much output');
        else out.push(b);
      });
      child.stderr.on('data', (b: Buffer) => err.push(b));
      const timer = setTimeout(() => kill('took too long'), opts.timeoutMs ?? LOCAL_TIMEOUT_MS);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new GitError(`Couldn’t run git: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const res = { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
        if (killed) reject(new GitError(`git ${args[0]} ${killed} and was stopped.`));
        else if (code === 0 || (code !== null && opts.okCodes?.includes(code))) resolve(res);
        else reject(new GitError(friendlyGitError(res.stderr, args)));
      });
    });
  }

  /** Run a mutating command once earlier ones on the same repository have finished. */
  private queued<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(root) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.queues.set(root, next);
    const done = () => {
      if (this.queues.get(root) === next) this.queues.delete(root);
    };
    next.then(done, done);
    return next;
  }

  async gitVersion(): Promise<string | null> {
    if (this.version !== undefined) return this.version;
    try {
      const res = await this.run(os.homedir(), ['--version']);
      this.version = res.stdout.trim().replace(/^git version /, '') || null;
    } catch {
      this.version = null;
    }
    return this.version;
  }

  /** The repository a folder is in, or null. */
  async repoRoot(folder: string): Promise<{ root: string; gitDir: string } | null> {
    if (!existsSync(folder)) return null;
    try {
      const res = await this.run(folder, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
      const [root, gitDir] = res.stdout.trim().split('\n');
      return root && gitDir ? { root: path.normalize(root), gitDir: path.normalize(gitDir) } : null;
    } catch {
      return null; // not a repository (or a bare one, which has no working tree to show)
    }
  }

  /** Tell views of the repository holding `folder` to refresh (after an agent's turn, say). */
  async notifyFolder(folder: string): Promise<void> {
    if (!this.gitPath && this.gitPath !== undefined) return;
    const repo = await this.repoRoot(folder).catch(() => null);
    if (repo) this.onChange(repo.root);
  }

  private async requireRepo(folder: string): Promise<string> {
    const repo = await this.repoRoot(folder);
    if (!repo) throw new GitError('This folder isn’t a git repository.');
    return repo.root;
  }

  async status(folder: string): Promise<GitStatus> {
    const version = await this.gitVersion();
    if (!version) return { folder, git: { available: false, version: null }, repo: null };
    const repo = await this.repoRoot(folder);
    if (!repo) return { folder, git: { available: true, version }, repo: null };
    this.watchRepo(repo.root, repo.gitDir);
    const [st, remotes] = await Promise.all([
      this.run(repo.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
      this.run(repo.root, ['remote', '-v']),
    ]);
    const parsed = parseStatus(st.stdout);
    return {
      folder,
      git: { available: true, version },
      repo: { root: repo.root, ...parsed, operation: operationIn(repo.gitDir), remotes: parseRemotes(remotes.stdout) },
    };
  }

  async branches(folder: string): Promise<GitBranch[]> {
    const root = await this.requireRepo(folder);
    const res = await this.run(root, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']);
    return parseBranches(res.stdout);
  }

  /** The diff of one changed file: what's staged, or what's in the working tree but not staged. */
  async diff(folder: string, file: string, staged: boolean): Promise<GitDiff> {
    assertPath(file);
    const root = await this.requireRepo(folder);
    const base = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '-M'];
    let res: RunResult;
    if (staged) {
      res = await this.run(root, [...base, '--cached', '--', file]);
    } else {
      const tracked = await this.run(root, ['ls-files', '--error-unmatch', '--', file], { okCodes: [1] });
      res =
        tracked.code === 0
          ? await this.run(root, [...base, '--', file])
          : // Untracked: show the whole file as added.
            await this.run(root, [...base, '--no-index', '--', isWindows ? 'NUL' : '/dev/null', file], { okCodes: [1] });
    }
    const truncated = res.stdout.length > MAX_DIFF_CHARS;
    const text = truncated ? res.stdout.slice(0, MAX_DIFF_CHARS) : res.stdout;
    return { path: file, text, binary: /^Binary files /m.test(text), truncated };
  }

  async init(folder: string): Promise<void> {
    const repo = await this.repoRoot(folder);
    if (repo && path.relative(realpathSync(repo.root), realpathSync(folder)) === '') throw new GitError('This folder is already a git repository.');
    const configured = await this.run(folder, ['config', '--get', 'init.defaultBranch'], { okCodes: [1] }).catch(() => null);
    const branch = configured?.stdout.trim() || 'main';
    await this.run(folder, ['init', `--initial-branch=${branch}`]);
    this.onChange(folder);
  }

  /**
   * Clone into `folder` when it's empty or missing, otherwise into a new folder
   * inside it named after the repository. Returns the folder the repository is in.
   */
  async clone(folder: string, url: string): Promise<string> {
    if (!isCloneableUrl(url)) throw new GitError('That doesn’t look like a git URL. Use an https:// or SSH address.');
    const empty = !existsSync(folder) || (statSync(folder).isDirectory() && readdirSync(folder).length === 0);
    const target = empty ? folder : path.join(folder, repoFolderName(url));
    if (!empty && existsSync(target)) throw new GitError(`There’s already a folder called “${path.basename(target)}” here.`);
    await this.run(path.dirname(target), ['clone', '--', url, target], { timeoutMs: NETWORK_TIMEOUT_MS });
    return target;
  }

  async stage(folder: string, files: string[]): Promise<void> {
    files.forEach(assertPath);
    const root = await this.requireRepo(folder);
    await this.queued(root, () => this.run(root, ['add', '-A', '--', ...files]));
    this.onChange(root);
  }

  async unstage(folder: string, files: string[]): Promise<void> {
    files.forEach(assertPath);
    const root = await this.requireRepo(folder);
    await this.queued(root, async () => {
      // Before the first commit there's no HEAD to restore from.
      const head = await this.run(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1] });
      await this.run(root, head.code === 0 ? ['restore', '--staged', '--', ...files] : ['rm', '--cached', '-r', '--quiet', '--', ...files]);
    });
    this.onChange(root);
  }

  /** Throw away working-tree changes. Untracked files are deleted. Staged changes are kept. */
  async discard(folder: string, files: string[]): Promise<void> {
    files.forEach(assertPath);
    const root = await this.requireRepo(folder);
    await this.queued(root, async () => {
      // A path is tracked when git knows it, or anything under it (status lists new folders as "dir/").
      const known = (await this.run(root, ['ls-files', '-z', '--', ...files])).stdout.split('\0').filter(Boolean);
      const isTracked = (f: string) => known.some((k) => k === f || k.startsWith(f.endsWith('/') ? f : `${f}/`));
      const tracked = files.filter(isTracked);
      const untracked = files.filter((f) => !isTracked(f));
      if (tracked.length) await this.run(root, ['restore', '--worktree', '--', ...tracked]);
      if (untracked.length) await this.run(root, ['clean', '-f', '-d', '--', ...untracked]);
    });
    this.onChange(root);
  }

  /** Commit what's staged, or every change when `all` is set. Returns the new commit's short hash. */
  async commit(folder: string, message: string, all: boolean): Promise<string> {
    if (!message.trim()) throw new GitError('Write a commit message first.');
    const root = await this.requireRepo(folder);
    const hash = await this.queued(root, async () => {
      if (all) await this.run(root, ['add', '-A']);
      await this.run(root, ['commit', '--cleanup=strip', '-m', message], { timeoutMs: NETWORK_TIMEOUT_MS }); // hooks may be slow
      return (await this.run(root, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    });
    this.onChange(root);
    return hash;
  }

  /** Switch to a branch. A remote branch ("origin/x") checks out a local "x" that tracks it. */
  async checkout(folder: string, branch: string): Promise<void> {
    const root = await this.requireRepo(folder);
    const all = await this.branches(root);
    const target = all.find((b) => b.name === branch);
    if (!target) throw new GitError(`There’s no branch called “${branch}”.`);
    await this.queued(root, async () => {
      if (!target.remote) return this.run(root, ['switch', branch]);
      const local = branch.slice(branch.indexOf('/') + 1);
      if (all.some((b) => !b.remote && b.name === local)) return this.run(root, ['switch', local]);
      return this.run(root, ['switch', '--track', '-c', local, branch]);
    });
    this.onChange(root);
  }

  async createBranch(folder: string, name: string): Promise<void> {
    const root = await this.requireRepo(folder);
    const check = await this.run(root, ['check-ref-format', '--branch', name], { okCodes: [1, 128] });
    if (check.code !== 0 || name.startsWith('-')) throw new GitError(`“${name}” can’t be a branch name.`);
    await this.queued(root, () => this.run(root, ['switch', '-c', name]));
    this.onChange(root);
  }

  async addRemote(folder: string, name: string, url: string): Promise<void> {
    if (!isCloneableUrl(url)) throw new GitError('That doesn’t look like a git URL. Use an https:// or SSH address.');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new GitError('Remote names may only use letters, numbers, dots, dashes and underscores.');
    const root = await this.requireRepo(folder);
    await this.queued(root, () => this.run(root, ['remote', 'add', '--', name, url]));
    this.onChange(root);
  }

  async fetch(folder: string): Promise<void> {
    const root = await this.requireRepo(folder);
    await this.queued(root, () => this.run(root, ['fetch', '--all', '--prune'], { timeoutMs: NETWORK_TIMEOUT_MS }));
    this.onChange(root);
  }

  /** Fast-forward only: anything that needs a merge is left to the user. */
  async pull(folder: string): Promise<void> {
    const root = await this.requireRepo(folder);
    await this.queued(root, () => this.run(root, ['pull', '--ff-only'], { timeoutMs: NETWORK_TIMEOUT_MS }));
    this.onChange(root);
  }

  /** Push the current branch, setting its upstream on the first push. */
  async push(folder: string): Promise<void> {
    const status = await this.status(folder);
    const repo = status.repo;
    if (!repo) throw new GitError('This folder isn’t a git repository.');
    if (!repo.branch) throw new GitError('You’re not on a branch (HEAD is detached). Create or switch to a branch first.');
    if (!repo.head) throw new GitError('Make a commit before pushing.');
    await this.queued(repo.root, async () => {
      if (repo.upstream) return this.run(repo.root, ['push'], { timeoutMs: NETWORK_TIMEOUT_MS });
      const remote = await this.pushRemote(repo.root, repo.branch!, repo.remotes.map((r) => r.name));
      return this.run(repo.root, ['push', '--set-upstream', '--', remote, 'HEAD'], { timeoutMs: NETWORK_TIMEOUT_MS });
    });
    this.onChange(repo.root);
  }

  private async pushRemote(root: string, branch: string, remotes: string[]): Promise<string> {
    if (!remotes.length) throw new GitError('This repository has no remote yet. Add one first.');
    for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault']) {
      const res = await this.run(root, ['config', '--get', key], { okCodes: [1] });
      const name = res.stdout.trim();
      if (name && remotes.includes(name)) return name;
    }
    if (remotes.includes('origin')) return 'origin';
    if (remotes.length === 1) return remotes[0];
    throw new GitError(`This repository has several remotes (${remotes.join(', ')}) and none is called origin. Push once from the terminal to choose.`);
  }

  // -------------------------------------------------------------------------
  // Watching

  /** Watch a repository's git folder so commits, checkouts and index changes refresh open views. */
  private watchRepo(root: string, gitDir: string): void {
    const existing = this.watchers.get(root);
    if (existing) {
      existing.lastUsed = Date.now();
      return;
    }
    const entry = { watchers: [] as FSWatcher[], timer: null as ReturnType<typeof setTimeout> | null, lastUsed: Date.now() };
    const changed = (name: string | Buffer | null) => {
      const file = String(name ?? '');
      if (file.endsWith('.lock') || file === 'FETCH_HEAD') return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        this.onChange(root);
      }, WATCH_DEBOUNCE_MS);
    };
    // HEAD, the index and in-progress operations sit at the top of the git folder; branches under refs/.
    // Not the whole folder: on Linux a recursive watch costs one watch per objects/ subfolder.
    for (const [dir, recursive] of [
      [gitDir, false],
      [path.join(gitDir, 'refs'), true],
    ] as const) {
      try {
        const w = watch(dir, { recursive, persistent: false });
        w.on('change', (_event, name) => changed(name));
        w.on('error', () => this.unwatch(root));
        entry.watchers.push(w);
      } catch {
        /* e.g. out of watches: views still refresh after Nest's own commands and agent turns */
      }
    }
    if (!entry.watchers.length) return;
    this.watchers.set(root, entry);
    if (!this.sweep) {
      this.sweep = setInterval(() => {
        for (const [r, w] of this.watchers) if (Date.now() - w.lastUsed > WATCH_IDLE_MS) this.unwatch(r);
      }, 60_000);
      this.sweep.unref?.();
    }
  }

  private unwatch(root: string): void {
    const w = this.watchers.get(root);
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    for (const watcher of w.watchers) watcher.close();
    this.watchers.delete(root);
  }

  close(): void {
    for (const root of [...this.watchers.keys()]) this.unwatch(root);
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }
}

function assertPath(p: string): void {
  if (typeof p !== 'string' || !isSafeRelativePath(p)) throw new GitError('That file path isn’t inside the repository.');
}

function operationIn(gitDir: string): 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null {
  const has = (f: string) => existsSync(path.join(gitDir, f));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase';
  if (has('MERGE_HEAD')) return 'merge';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (has('REVERT_HEAD')) return 'revert';
  return null;
}
