import type { GitBranch, GitChange, GitCommit, GitCommitFile, GitFileChange, GitRef, GitRemote } from '@shared/types';

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

/** Format for `git log -z --decorate=full`: one commit per NUL-separated record. */
export const LOG_FORMAT = ['%H', '%P', '%an', '%at', '%D', '%s'].join('%x1f');

/** Parse the refs `%D` lists with `--decorate=full`, e.g. "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". */
export function parseRefs(decoration: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const raw of decoration.split(', ')) {
    const part = raw.trim();
    if (!part) continue;
    if (part === 'HEAD') {
      refs.push({ name: 'HEAD', kind: 'head' });
      continue;
    }
    const arrow = /^HEAD -> (.+)$/.exec(part);
    const ref = (arrow ? arrow[1] : part).replace(/^tag: /, '');
    if (arrow) refs.push({ name: 'HEAD', kind: 'head' });
    if (ref.startsWith('refs/heads/')) refs.push({ name: ref.slice(11), kind: 'branch' });
    else if (ref.startsWith('refs/remotes/')) {
      // origin/HEAD only points at another remote branch.
      if (!ref.endsWith('/HEAD')) refs.push({ name: ref.slice(13), kind: 'remote' });
    } else if (ref.startsWith('refs/tags/')) refs.push({ name: ref.slice(10), kind: 'tag' });
  }
  return refs;
}

/** Parse `git log -z --format=<LOG_FORMAT>`. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of out.split('\0')) {
    // git puts a newline between records when there's no body; trim it off the hash.
    const rec = record.replace(/^\n+/, '');
    if (!rec.trim()) continue;
    const [hash, parents, author, date, decoration, ...subject] = rec.split(SEP);
    if (!/^[0-9a-f]{7,64}$/.test(hash ?? '')) continue;
    commits.push({
      hash,
      parents: parents ? parents.split(' ').filter(Boolean) : [],
      author: author ?? '',
      date: Number(date) * 1000 || 0,
      subject: subject.join(SEP).replace(/\n+$/, ''),
      refs: parseRefs(decoration ?? ''),
    });
  }
  return commits;
}

const STATUS_LETTER: Record<string, GitChange> = { ...CHANGE, U: 'conflicted' };

/**
 * Join `git diff-tree -r -M --name-status -z` and `--numstat -z` for one
 * commit into one entry per file.
 */
export function parseCommitFiles(nameStatus: string, numstat: string): GitCommitFile[] {
  const files: GitCommitFile[] = [];
  const ns = nameStatus.split('\0');
  for (let i = 0; i < ns.length; i++) {
    const code = ns[i];
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const origPath = ns[++i] ?? '';
      const p = ns[++i] ?? '';
      files.push({ path: p, origPath, change: STATUS_LETTER[letter], additions: null, deletions: null });
    } else {
      const p = ns[++i] ?? '';
      files.push({ path: p, origPath: null, change: STATUS_LETTER[letter] ?? 'modified', additions: null, deletions: null });
    }
  }
  // numstat -z: "add\tdel\tpath\0", or "add\tdel\t\0old\0new\0" for a rename. "-" counts mean binary.
  const nm = numstat.split('\0');
  for (let i = 0; i < nm.length; i++) {
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(nm[i]);
    if (!m) continue;
    let p = m[3];
    if (!p) {
      i++;
      p = nm[++i] ?? '';
    }
    const file = files.find((f) => f.path === p);
    if (file) {
      file.additions = m[1] === '-' ? null : Number(m[1]);
      file.deletions = m[2] === '-' ? null : Number(m[2]);
    }
  }
  return files;
}

/** A commit hash (full or abbreviated) from the renderer. */
export function isCommitHash(h: unknown): h is string {
  return typeof h === 'string' && /^[0-9a-f]{4,64}$/i.test(h);
}
