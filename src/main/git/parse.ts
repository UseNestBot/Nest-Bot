import type { GitBranch, GitChange, GitFileChange, GitRemote } from '@shared/types';

/** Most changed paths Nest lists for one repository. */
export const MAX_STATUS_FILES = 2000;

export interface ParsedStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  truncated: boolean;
}

const CHANGE: Record<string, GitChange> = { M: 'modified', T: 'typechange', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' };

function change(letter: string): GitChange | null {
  return CHANGE[letter] ?? null;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): ParsedStatus {
  const status: ParsedStatus = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [], truncated: false };
  const fields = out.split('\0');
  const add = (f: GitFileChange) => {
    if (status.files.length < MAX_STATUS_FILES) status.files.push(f);
    else status.truncated = true;
  };
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.head = value === '(initial)' ? null : value.slice(0, 7);
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = line[0];
    if (kind === '1' || kind === '2') {
      // 1 XY sub mH mI mW hH hI path / 2 XY sub mH mI mW hH hI Xscore path, then origPath as the next field.
      const parts = line.split(' ');
      const xy = parts[1] ?? '..';
      const pathStart = kind === '1' ? 8 : 9;
      const p = parts.slice(pathStart).join(' ');
      const origPath = kind === '2' ? (fields[++i] ?? null) : null;
      add({ path: p, origPath, staged: change(xy[0]), unstaged: change(xy[1]) });
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      add({ path: line.split(' ').slice(10).join(' '), origPath: null, staged: 'conflicted', unstaged: 'conflicted' });
    } else if (kind === '?') {
      add({ path: line.slice(2), origPath: null, staged: null, unstaged: 'untracked' });
    }
  }
  return status;
}

/** Field separator in the for-each-ref format below. */
const SEP = '\x1f';
export const BRANCH_FORMAT = ['%(refname)', '%(objectname:short)', '%(upstream:short)', '%(HEAD)', '%(committerdate:unix)', '%(subject)'].join(SEP);

/** Parse `git for-each-ref --format=<BRANCH_FORMAT> refs/heads refs/remotes`, newest first. */
export function parseBranches(out: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [ref, head, upstream, current, date, ...subject] = line.split(SEP);
    const remote = ref.startsWith('refs/remotes/');
    const name = ref.replace(/^refs\/(heads|remotes)\//, '');
    // origin/HEAD only points at another remote branch.
    if (remote && name.endsWith('/HEAD')) continue;
    branches.push({ name, remote, current: current === '*', upstream: upstream || null, head, subject: subject.join(SEP), date: Number(date) * 1000 || 0 });
  }
  return branches.sort((a, b) => Number(b.current) - Number(a.current) || b.date - a.date);
}

/** Remove a user name, password or token from a remote URL before it leaves the main process. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

/** Parse `git remote -v`, keeping each remote's fetch URL. */
export function parseRemotes(out: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(\S+) \(fetch\)$/.exec(line.trim());
    if (m && !remotes.some((r) => r.name === m[1])) remotes.push({ name: m[1], url: redactUrl(m[2]) });
  }
  return remotes;
}

/**
 * URLs Nest will clone from or add as a remote: http(s), ssh, git and file
 * URLs, and scp-style `user@host:path`. Anything else (notably `ext::`, which
 * runs commands, and strings starting with `-`) is refused.
 */
export function isCloneableUrl(url: string): boolean {
  if (!url || url.length > 2000 || /\s/.test(url) || url.startsWith('-')) return false;
  if (/^(https?|ssh|git|file):\/\//i.test(url)) return true;
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s:][^\s]*$/.test(url);
}

/** The folder name `git clone` would pick for a URL. */
export function repoFolderName(url: string): string {
  const last = url.replace(/[/\\]+$/, '').split(/[/:\\]/).pop() ?? '';
  const name = last.replace(/\.git$/i, '').replace(/[<>:"|?*\x00-\x1f]/g, '').trim();
  return name && name !== '.' && name !== '..' ? name : 'repo';
}

/**
 * A repository-relative path from the renderer. Absolute paths and `..` are
 * refused so a call can't reach outside the repository.
 */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.length > 4000 || p.includes('\0')) return false;
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:/.test(p) || p.startsWith('-')) return false;
  return !p.split(/[/\\]/).some((part) => part === '..');
}
