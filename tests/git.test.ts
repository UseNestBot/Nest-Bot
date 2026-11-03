import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService, findGit } from '../src/main/git/service';
import { isCloneableUrl, isSafeRelativePath, parseBranches, parseRemotes, parseStatus, redactUrl, repoFolderName, BRANCH_FORMAT } from '../src/main/git/parse';

describe('git parsing', () => {
  it('parses porcelain v2 status with renames, conflicts and untracked files', () => {
    const out = [
      '# branch.oid 1234567890abcdef',
      '# branch.head feature/x',
      '# branch.upstream origin/feature/x',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaa bbb src/a file.ts',
      '1 A. N... 000000 100644 100644 000 bbb new.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 renamed.ts',
      'old.ts',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts',
      '? notes/',
      '',
    ].join('\0');
    const s = parseStatus(out);
    expect(s).toMatchObject({ branch: 'feature/x', head: '1234567', upstream: 'origin/feature/x', ahead: 2, behind: 1, truncated: false });
    expect(s.files).toEqual([
      { path: 'src/a file.ts', origPath: null, staged: null, unstaged: 'modified' },
      { path: 'new.ts', origPath: null, staged: 'added', unstaged: null },
      { path: 'renamed.ts', origPath: 'old.ts', staged: 'renamed', unstaged: null },
      { path: 'conflict.ts', origPath: null, staged: 'conflicted', unstaged: 'conflicted' },
      { path: 'notes/', origPath: null, staged: null, unstaged: 'untracked' },
    ]);
  });

  it('handles a fresh repository and a detached HEAD', () => {
    expect(parseStatus('# branch.oid (initial)\0# branch.head main\0')).toMatchObject({ head: null, branch: 'main' });
    expect(parseStatus('# branch.oid abcdef123\0# branch.head (detached)\0')).toMatchObject({ head: 'abcdef1', branch: null });
  });

  it('parses branches, skipping remote HEAD pointers, current first', () => {
    const S = '\x1f';
    const out = [
      ['refs/heads/main', 'aaa', 'origin/main', ' ', '100', 'old'].join(S),
      ['refs/heads/dev', 'bbb', '', '*', '50', 'current'].join(S),
      ['refs/remotes/origin/HEAD', 'aaa', '', ' ', '100', ''].join(S),
      ['refs/remotes/origin/main', 'aaa', '', ' ', '200', 'newest'].join(S),
    ].join('\n');
    expect(parseBranches(out).map((b) => [b.name, b.remote, b.current])).toEqual([
      ['dev', false, true],
      ['origin/main', true, false],
      ['main', false, false],
    ]);
  });

  it('redacts credentials from remote URLs', () => {
    expect(redactUrl('https://user:ghp_secret@github.com/o/r.git')).toBe('https://github.com/o/r.git');
    expect(redactUrl('git@github.com:o/r.git')).toBe('git@github.com:o/r.git');
    expect(parseRemotes('origin\thttps://tok@gitlab.com/g/r.git (fetch)\norigin\thttps://tok@gitlab.com/g/r.git (push)\n')).toEqual([{ name: 'origin', url: 'https://gitlab.com/g/r.git' }]);
  });

  it('only accepts real git URLs', () => {
    for (const ok of ['https://codeberg.org/o/r.git', 'ssh://git@host:2222/o/r', 'git@github.com:o/r.git', 'file:///tmp/x']) expect(isCloneableUrl(ok)).toBe(true);
    for (const bad of ['ext::sh -c touch% /tmp/pwned', '--upload-pack=evil', '/etc', 'C:\\repo', '', 'https://x y']) expect(isCloneableUrl(bad)).toBe(false);
    expect(repoFolderName('https://github.com/o/Nest-Bot.git')).toBe('Nest-Bot');
    expect(repoFolderName('git@host:o/r')).toBe('r');
  });

  it('keeps paths inside the repository', () => {
    for (const ok of ['a.ts', 'src/a b.ts', 'dir/']) expect(isSafeRelativePath(ok)).toBe(true);
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', '\\\\server\\x', '-n', '']) expect(isSafeRelativePath(bad)).toBe(false);
  });

  it('formats for-each-ref with a separator git understands', () => {
    expect(BRANCH_FORMAT.split('\x1f')).toHaveLength(6);
  });
});

describe.skipIf(!findGit())('GitService', () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nest-git-')));
  const changes: string[] = [];
  const git = new GitService((root) => changes.push(root));
  const saved = { ...process.env };
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

  beforeAll(() => {
    // An isolated identity and config, whatever the machine running the tests has.
    const config = path.join(base, 'gitconfig');
    writeFileSync(config, '[user]\n\tname = Nest Test\n\temail = test@nest.local\n[commit]\n\tgpgsign = false\n');
    process.env.GIT_CONFIG_GLOBAL = config;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });
  afterAll(() => {
    git.close();
    process.env = saved;
  });

  it('reports a folder that isn’t a repository, then initialises one', async () => {
    const dir = path.join(base, 'plain');
    mkdirSync(dir);
    const before = await git.status(dir);
    expect(before.git.available).toBe(true);
    expect(before.repo).toBeNull();
    await git.init(dir);
    const after = await git.status(dir);
    expect(after.repo).toMatchObject({ branch: 'main', head: null, files: [] });
    await expect(git.init(dir)).rejects.toThrow(/already/);
  });

  it('stages, diffs, commits, branches and discards', async () => {
    const dir = path.join(base, 'work');
    mkdirSync(dir);
    await git.init(dir);
    writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    let s = await git.status(dir);
    expect(s.repo?.files).toEqual([{ path: 'a.txt', origPath: null, staged: null, unstaged: 'untracked' }]);
    expect((await git.diff(dir, 'a.txt', false)).text).toContain('+one');

    await git.stage(dir, ['a.txt']);
    expect((await git.status(dir)).repo?.files[0].staged).toBe('added');
    await git.unstage(dir, ['a.txt']);
    expect((await git.status(dir)).repo?.files[0].staged).toBeNull();

    const hash = await git.commit(dir, 'First commit', true);
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    s = await git.status(dir);
    expect(s.repo).toMatchObject({ head: hash, files: [] });
    await expect(git.commit(dir, '   ', true)).rejects.toThrow(/message/);

    writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    writeFileSync(path.join(dir, 'junk.txt'), 'x');
    const diff = await git.diff(dir, 'a.txt', false);
    expect(diff.text).toContain('-one');
    expect(diff.text).toContain('+two');
    await git.discard(dir, ['a.txt', 'junk.txt']);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(path.join(dir, 'junk.txt'))).toBe(false);

    await git.createBranch(dir, 'feature/test');
    expect((await git.status(dir)).repo?.branch).toBe('feature/test');
    await expect(git.createBranch(dir, 'bad..name')).rejects.toThrow(/can’t be a branch name/);
    await git.checkout(dir, 'main');
    const branches = await git.branches(dir);
    expect(branches.find((b) => b.current)?.name).toBe('main');
    expect(branches.map((b) => b.name).sort()).toEqual(['feature/test', 'main']);

    await expect(git.diff(dir, '../outside', false)).rejects.toThrow(/inside the repository/);
    expect(changes).toContain(dir);
  });

  it('clones, pushes with upstream, and pulls', async () => {
    const remote = path.join(base, 'remote.git');
    sh(base, 'init', '--bare', '--initial-branch=main', remote);
    const seed = path.join(base, 'seed');
    mkdirSync(seed);
    await git.init(seed);
    await git.addRemote(seed, 'origin', `file://${remote}`);
    writeFileSync(path.join(seed, 'readme.md'), 'hi\n');
    await git.commit(seed, 'Seed', true);
    await git.push(seed);
    expect((await git.status(seed)).repo).toMatchObject({ upstream: 'origin/main', ahead: 0 });

    // Into a non-empty folder: a subfolder named after the repository.
    const parent = path.join(base, 'clones');
    mkdirSync(parent);
    writeFileSync(path.join(parent, 'other.txt'), '');
    const cloned = await git.clone(parent, `file://${remote}`);
    expect(cloned).toBe(path.join(parent, 'remote'));
    expect(readFileSync(path.join(cloned, 'readme.md'), 'utf8')).toBe('hi\n');
    await expect(git.clone(parent, 'ext::sh -c id')).rejects.toThrow(/git URL/);

    writeFileSync(path.join(seed, 'readme.md'), 'hi again\n');
    await git.commit(seed, 'Second', true);
    await git.push(seed);
    await git.fetch(cloned);
    expect((await git.status(cloned)).repo?.behind).toBe(1);
    await git.pull(cloned);
    expect(readFileSync(path.join(cloned, 'readme.md'), 'utf8')).toBe('hi again\n');

    // A remote branch checks out as a local tracking branch.
    sh(seed, 'push', 'origin', 'HEAD:refs/heads/topic');
    await git.fetch(cloned);
    await git.checkout(cloned, 'origin/topic');
    expect((await git.status(cloned)).repo).toMatchObject({ branch: 'topic', upstream: 'origin/topic' });
  }, 60_000);

  it('notices commits made outside Nest', async () => {
    const dir = path.join(base, 'watched');
    mkdirSync(dir);
    await git.init(dir);
    await git.status(dir); // starts the watch
    changes.length = 0;
    writeFileSync(path.join(dir, 'f'), 'x');
    sh(dir, 'add', 'f');
    sh(dir, 'commit', '-m', 'by an agent');
    await new Promise((r) => setTimeout(r, 1200));
    expect(changes).toContain(dir);
  });

  it('explains a missing remote', async () => {
    const dir = path.join(base, 'lonely');
    mkdirSync(dir);
    await git.init(dir);
    writeFileSync(path.join(dir, 'x'), 'x');
    await git.commit(dir, 'x', true);
    await expect(git.push(dir)).rejects.toThrow(/no remote/);
  });
});
