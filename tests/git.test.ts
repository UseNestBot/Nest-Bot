import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitService, findGit } from '../src/main/git/service';
import { ForgeService } from '../src/main/forge/service';
import { ForgeStore } from '../src/main/forge/accounts';
import type { Fetch } from '../src/main/forge/clients';
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
  // .native expands Windows 8.3 names (RUNNER~1) to the long form git reports.
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'nest-git-')));
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

  it('reads history across branches, one commit, and its diffs', async () => {
    const dir = path.join(base, 'history');
    mkdirSync(dir);
    await git.init(dir);
    expect(await git.log(dir)).toEqual({ commits: [], more: false });
    writeFileSync(path.join(dir, 'a.txt'), 'one\n');
    await git.commit(dir, 'First', true);
    await git.createBranch(dir, 'side');
    writeFileSync(path.join(dir, 'b.txt'), 'side\n');
    await git.commit(dir, 'On the side', true);
    await git.checkout(dir, 'main');
    sh(dir, 'mv', 'a.txt', 'renamed.txt');
    await git.commit(dir, 'Rename\n\nWith a body.', true);
    sh(dir, 'merge', '--no-ff', '-m', 'Merge side', 'side');
    sh(dir, 'tag', 'v1');

    const page = await git.log(dir, 0, 3);
    expect(page.more).toBe(true);
    expect(page.commits[0]).toMatchObject({ subject: 'Merge side' });
    expect(page.commits[0].parents).toHaveLength(2);
    expect(page.commits[0].refs).toEqual(expect.arrayContaining([{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }, { name: 'v1', kind: 'tag' }]));
    const rest = await git.log(dir, 3, 10);
    expect([...page.commits, ...rest.commits].map((c) => c.subject).sort()).toEqual(['First', 'Merge side', 'On the side', 'Rename']);
    expect(rest.more).toBe(false);

    const rename = [...page.commits, ...rest.commits].find((c) => c.subject === 'Rename')!;
    const detail = await git.showCommit(dir, rename.hash);
    expect(detail.message).toBe('Rename\n\nWith a body.');
    expect(detail.author).toBe('Nest Test');
    expect(detail.files).toEqual([{ path: 'renamed.txt', origPath: 'a.txt', change: 'renamed', additions: 0, deletions: 0 }]);

    const first = rest.commits.find((c) => c.subject === 'First')!;
    const root = await git.showCommit(dir, first.hash);
    expect(root.files).toEqual([{ path: 'a.txt', origPath: null, change: 'added', additions: 1, deletions: 0 }]);
    expect((await git.commitDiff(dir, first.hash, 'a.txt')).text).toContain('+one');
    await expect(git.showCommit(dir, '--all')).rejects.toThrow(/isn’t a commit/);
    await expect(git.showCommit(dir, 'deadbeef')).rejects.toThrow(/no commit/);
  });

  it('gives a chat its own worktree and removes it again', async () => {
    const dir = path.join(base, 'wt-main');
    mkdirSync(dir);
    await git.init(dir);
    await expect(git.createWorktree(dir, 'feat')).rejects.toThrow(/first commit/);
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await git.commit(dir, 'Base', true);
    expect((await git.status(dir)).repo?.worktreeOf).toBeNull();

    const wt = await git.createWorktree(dir, 'feat/one');
    expect(wt).toBe(path.join(base, 'wt-main.worktrees', 'feat-one'));
    const inside = (await git.status(wt)).repo!;
    expect(inside).toMatchObject({ branch: 'feat/one', worktreeOf: dir });
    await expect(git.createWorktree(dir, 'feat/one')).rejects.toThrow(/already a folder/);
    await expect(git.createWorktree(dir, 'bad..name')).rejects.toThrow(/can’t be a branch name/);
    // A worktree of a worktree still goes beside the main one.
    const second = await git.createWorktree(wt, 'two');
    expect(path.dirname(second)).toBe(path.join(base, 'wt-main.worktrees'));
    expect((await git.removeWorktree(second, false))).toBe(dir);

    writeFileSync(path.join(wt, 'dirty.txt'), 'x');
    await expect(git.removeWorktree(wt, false)).rejects.toThrow(/uncommitted changes/);
    expect(await git.removeWorktree(wt, true)).toBe(dir);
    expect(existsSync(wt)).toBe(false);
    // The branch is kept.
    expect((await git.branches(dir)).map((b) => b.name)).toContain('feat/one');
    await expect(git.removeWorktree(dir, false)).rejects.toThrow(/isn’t a linked worktree/);
    // An existing branch that isn't checked out is used as is.
    const again = await git.createWorktree(dir, 'feat/one');
    expect((await git.status(again)).repo?.branch).toBe('feat/one');
  });

  it('reads and sets who commits are made as', async () => {
    expect(await git.identity()).toEqual({ name: 'Nest Test', email: 'test@nest.local' });
    await expect(git.setIdentity({ name: 'X', email: 'not an email' })).rejects.toThrow(/email/);
    await expect(git.setIdentity({ name: 'Two\nlines', email: null })).rejects.toThrow(/one line/);
    expect(await git.setIdentity({ name: 'Someone Else', email: 'else@nest.local' })).toEqual({ name: 'Someone Else', email: 'else@nest.local' });
    expect(await git.setIdentity({ name: 'Nest Test', email: 'test@nest.local' })).toEqual({ name: 'Nest Test', email: 'test@nest.local' });
  });

  it('finds the forge repository and opens a pull request, pushing first', async () => {
    // A GitHub remote whose pushes land in a local bare repository instead.
    const bare = path.join(base, 'gh-bare.git');
    sh(base, 'init', '--bare', '--initial-branch=main', bare);
    const dir = path.join(base, 'forge');
    mkdirSync(dir);
    await git.init(dir);
    await git.addRemote(dir, 'origin', 'https://github.com/o/r.git');
    sh(dir, 'config', `url.${pathToFileURL(bare).href}.pushInsteadOf`, 'https://github.com/o/r.git');
    writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    await git.commit(dir, 'Base', true);
    await git.push(dir);
    await git.createBranch(dir, 'feat');
    writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await git.commit(dir, 'Feature', true);

    const requests: Array<{ key: string; body: unknown }> = [];
    const fetch: Fetch = async (url, init) => {
      const key = `${init?.method ?? 'GET'} ${url}`;
      requests.push({ key, body: init?.body ? JSON.parse(String(init.body)) : null });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
      if (key === 'GET https://api.github.com/user') return json({ login: 'me' });
      if (key === 'GET https://api.github.com/repos/o/r') return json({ default_branch: 'main', html_url: 'https://github.com/o/r' });
      if (key === 'POST https://api.github.com/graphql') return json({ data: { repository: { pullRequests: { nodes: [] } } } });
      if (key === 'POST https://api.github.com/repos/o/r/pulls') return json({ number: 5, title: 'Feature', state: 'open', user: { login: 'me' }, head: { ref: 'feat' }, base: { ref: 'main' }, html_url: 'https://github.com/o/r/pull/5' });
      return new Response('{}', { status: 404 });
    };
    const store = new ForgeStore(path.join(base, 'forges.json'), { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() });
    store.setToken('github.com', 'tok');
    const forge = new ForgeService({ store, git, fetch, discovery: { exec: async () => ({ code: 1, stdout: '' }), find: () => null, readFile: () => null, git: () => null } });

    const found = await forge.lookup(dir);
    expect(found.error).toBeNull();
    expect(found.repo).toMatchObject({ host: 'github.com', kind: 'github', path: 'o/r', defaultBranch: 'main', current: null });
    expect(found.repo?.account).toMatchObject({ state: 'ready', user: 'me', source: 'saved' });

    const pull = await forge.createPull(dir, { title: 'Feature', body: 'Adds b', base: '', draft: false });
    expect(pull).toMatchObject({ number: 5, head: 'feat' });
    // feat had no upstream: Nest pushed it first.
    expect(sh(bare, 'branch', '--list', 'feat')).toContain('feat');
    expect((await git.status(dir)).repo).toMatchObject({ upstream: 'origin/feat', ahead: 0 });
    expect(requests.find((r) => r.key === 'POST https://api.github.com/repos/o/r/pulls')?.body).toEqual({ title: 'Feature', body: 'Adds b', head: 'feat', base: 'main', draft: false });

    await git.checkout(dir, 'main');
    await expect(forge.createPull(dir, { title: 'Oops', body: '', base: 'main', draft: false })).rejects.toThrow(/Create a branch/);
  }, 60_000);

  it('says when a remote is on a host it doesn’t know', async () => {
    const dir = path.join(base, 'unknown-host');
    mkdirSync(dir);
    await git.init(dir);
    await git.addRemote(dir, 'origin', 'https://git.example.com/o/r.git');
    const forge = new ForgeService({
      store: new ForgeStore(path.join(base, 'forges-unknown.json'), { available: () => true, encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }),
      git,
      fetch: async () => new Response('{}', { status: 500 }),
      discovery: { exec: async () => ({ code: 1, stdout: '' }), find: () => null, readFile: () => null, git: () => null },
    });
    expect(await forge.lookup(dir)).toEqual({ repo: null, unknownHost: 'git.example.com', error: null });
    await expect(forge.listPulls(dir)).rejects.toThrow(/doesn’t know what kind of forge git.example.com is/);
  });
});
