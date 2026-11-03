// Forges (GitHub, GitLab, Forgejo) and the commit graph: parsing, sign-in
// discovery, API mapping against canned responses, and the agent tools.
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { layoutGraph } from '@shared/gitGraph';
import { ForgeStore, discoverCredentials, parseCredential, teaTokenFrom, type DiscoveryDeps } from '../src/main/forge/accounts';
import { ForgejoClient, GitHubClient, GitLabClient, ForgeError, rollUp, type Fetch } from '../src/main/forge/clients';
import { apiBase, forgeKindFor, normalizeHost, parseRemoteUrl } from '../src/main/forge/remote';
import { parseCommitFiles, parseLog, parseRefs } from '../src/main/git/parse';
import { REMOTE_BLOCKED } from '../src/main/remote/server';

describe('history parsing', () => {
  it('parses decorated refs', () => {
    expect(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0')).toEqual([
      { name: 'HEAD', kind: 'head' },
      { name: 'main', kind: 'branch' },
      { name: 'origin/main', kind: 'remote' },
      { name: 'v1.0', kind: 'tag' },
    ]);
    expect(parseRefs('')).toEqual([]);
    expect(parseRefs('HEAD')).toEqual([{ name: 'HEAD', kind: 'head' }]);
  });

  it('parses git log -z records', () => {
    const S = '\x1f';
    const a = 'a'.repeat(40);
    const b = 'b'.repeat(40);
    const out = [[a, b, 'Ann', '1700000000', 'HEAD -> refs/heads/main', 'Second'].join(S), ['\n' + b, '', 'Bob', '1690000000', '', 'First: with a \x1f in it'].join(S), ''].join('\0');
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ hash: a, parents: [b], author: 'Ann', date: 1700000000000, subject: 'Second' });
    expect(commits[0].refs.map((r) => r.name)).toEqual(['HEAD', 'main']);
    expect(commits[1]).toMatchObject({ hash: b, parents: [], subject: 'First: with a \x1f in it' });
  });

  it('joins name-status and numstat, including renames and binary files', () => {
    const names = ['M', 'src/a.ts', 'R087', 'old name.ts', 'new name.ts', 'A', 'img.png', 'D', 'gone.txt', ''].join('\0');
    const nums = ['3\t1\tsrc/a.ts', '2\t2\t', 'old name.ts', 'new name.ts', '-\t-\timg.png', '0\t9\tgone.txt', ''].join('\0');
    expect(parseCommitFiles(names, nums)).toEqual([
      { path: 'src/a.ts', origPath: null, change: 'modified', additions: 3, deletions: 1 },
      { path: 'new name.ts', origPath: 'old name.ts', change: 'renamed', additions: 2, deletions: 2 },
      { path: 'img.png', origPath: null, change: 'added', additions: null, deletions: null },
      { path: 'gone.txt', origPath: null, change: 'deleted', additions: 0, deletions: 9 },
    ]);
  });
});

describe('commit graph layout', () => {
  it('keeps a straight history in one lane', () => {
    const { rows, width } = layoutGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(width).toBe(1);
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0]);
    expect(rows[0]).toEqual({ col: 0, up: [], down: [[0, 0]] });
    expect(rows[2]).toEqual({ col: 0, up: [[0, 0]], down: [] });
  });

  it('branches out for a merge and joins back at the fork point', () => {
    // m merges f into main; f and b both come from a.
    const { rows, width } = layoutGraph([
      { hash: 'm', parents: ['b', 'f'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(width).toBe(2);
    expect(rows[0]).toEqual({ col: 0, up: [], down: [[0, 0], [0, 1]] });
    expect(rows[1]).toEqual({ col: 1, up: [[0, 0], [1, 1]], down: [[1, 1], [0, 0]] });
    expect(rows[2].col).toBe(0);
    // a: lane 1 joins lane 0.
    expect(rows[3]).toEqual({ col: 0, up: [[0, 0], [1, 0]], down: [] });
  });

  it('starts a new lane for another branch tip', () => {
    const { rows } = layoutGraph([
      { hash: 'x', parents: ['a'] },
      { hash: 'y', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows[1]).toEqual({ col: 1, up: [[0, 0]], down: [[1, 1], [0, 0]] });
    expect(rows[2].up).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });
});

describe('remotes and hosts', () => {
  it('parses https, ssh and scp-style remotes', () => {
    expect(parseRemoteUrl('https://github.com/UseNestBot/Nest-Bot.git')).toEqual({ host: 'github.com', path: 'UseNestBot/Nest-Bot', scheme: 'https' });
    expect(parseRemoteUrl('git@github.com:o/r.git')).toEqual({ host: 'github.com', path: 'o/r', scheme: 'https' });
    expect(parseRemoteUrl('ssh://git@ssh.github.com:443/o/r.git')).toEqual({ host: 'github.com', path: 'o/r', scheme: 'https' });
    expect(parseRemoteUrl('https://gitlab.com/group/sub/proj/')).toEqual({ host: 'gitlab.com', path: 'group/sub/proj', scheme: 'https' });
    expect(parseRemoteUrl('http://git.local:3000/me/r')).toEqual({ host: 'git.local:3000', path: 'me/r', scheme: 'http' });
    expect(parseRemoteUrl('ssh://git@git.example.com:2222/me/r.git')?.host).toBe('git.example.com');
    for (const bad of ['file:///tmp/x', '/srv/repo.git', 'https://github.com/only', 'https://h/a/../b', 'ext::sh -c x']) expect(parseRemoteUrl(bad)).toBeNull();
  });

  it('knows forges by host, configuration or name', () => {
    expect(forgeKindFor('github.com')).toBe('github');
    expect(forgeKindFor('codeberg.org')).toBe('forgejo');
    expect(forgeKindFor('gitlab.example.com')).toBe('gitlab');
    expect(forgeKindFor('git.example.com')).toBeNull();
    expect(forgeKindFor('git.example.com', [{ host: 'git.example.com', kind: 'forgejo' }])).toBe('forgejo');
    expect(apiBase('github', 'github.com')).toBe('https://api.github.com');
    expect(apiBase('github', 'ghe.corp')).toBe('https://ghe.corp/api/v3');
    expect(apiBase('forgejo', 'codeberg.org')).toBe('https://codeberg.org/api/v1');
  });

  it('normalises hosts the user types', () => {
    expect(normalizeHost(' https://Git.Example.com/some/path ')).toBe('git.example.com');
    expect(normalizeHost('git.example.com:8443')).toBe('git.example.com:8443');
    expect(normalizeHost('not a host')).toBeNull();
    expect(normalizeHost('evil.com@x')).toBeNull();
  });
});

describe('sign-in discovery', () => {
  it('reads tokens from tea and git credential output', () => {
    const yaml = ['logins:', '- name: work', '  url: https://git.work.com', '  token: aaa', '- name: codeberg', '  url: "https://codeberg.org"', '  token: "bbb" # mine', '  default: true', ''].join('\n');
    expect(teaTokenFrom(yaml, 'codeberg.org')).toBe('bbb');
    expect(teaTokenFrom(yaml, 'git.work.com')).toBe('aaa');
    expect(teaTokenFrom(yaml, 'gitea.com')).toBeNull();
    expect(parseCredential('protocol=https\nhost=github.com\nusername=me\npassword=gho_x\n')).toEqual({ username: 'me', password: 'gho_x' });
  });

  it('asks the forge CLI first, then the credential helper, without prompts', async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string; env?: NodeJS.ProcessEnv }> = [];
    const deps: DiscoveryDeps = {
      find: (n) => (n === 'gh' ? '/bin/gh' : null),
      git: () => '/bin/git',
      readFile: () => null,
      exec: async (cmd, args, opts) => {
        calls.push({ cmd, args, input: opts?.input, env: opts?.env });
        if (cmd === '/bin/gh') return { code: 0, stdout: 'gho_fromgh\n' };
        return { code: 0, stdout: 'username=me\npassword=gho_fromhelper\n' };
      },
    };
    const found = await discoverCredentials('github.com', 'github', deps);
    expect(found.map((c) => c.source)).toEqual(['gh', 'credential']);
    expect(found[0].token).toBe('gho_fromgh');
    expect(calls[0].args).toEqual(['auth', 'token', '--hostname', 'github.com']);
    expect(calls[1].input).toBe('protocol=https\nhost=github.com\n\n');
    expect(calls[1].args).toContain('credential.interactive=false');
    for (const c of calls) expect(c.env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '' });
  });

  it('keeps pasted tokens encrypted on disk', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-forge-'));
    const file = path.join(dir, 'forges.json');
    const cipher = { available: () => true, encrypt: (t: string) => Buffer.from([...t].reverse().join('')), decrypt: (b: Buffer) => [...b.toString()].reverse().join('') };
    const store = new ForgeStore(file, cipher);
    store.addHost('git.example.com', 'gitlab');
    store.setToken('git.example.com', 'glpat-secret1234');
    expect(readFileSync(file, 'utf8')).not.toContain('glpat-secret1234');
    expect(store.token('git.example.com')).toBe('glpat-secret1234');
    expect(store.hint('git.example.com')).toBe('…1234');
    store.removeHost('git.example.com');
    expect(store.token('git.example.com')).toBeNull();
    expect(store.hosts()).toEqual([]);
  });
});

/** A fetch that answers from a table of "METHOD url" → JSON, and records requests. */
function fakeFetch(routes: Record<string, unknown>, seen: Array<{ key: string; init?: RequestInit }> = []): Fetch {
  return async (url, init) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    seen.push({ key, init });
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, statusText: 'Not Found' });
    const body = routes[key];
    if (body instanceof Response) return body;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };
}

const cred = { token: 'tok', username: null, source: 'saved' as const };

describe('GitHub', () => {
  it('lists pull requests with checks and review state from GraphQL', async () => {
    const seen: Array<{ key: string; init?: RequestInit }> = [];
    const fetch = fakeFetch(
      {
        'POST https://api.github.com/graphql': {
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  { number: 7, title: 'Fix', state: 'OPEN', isDraft: false, url: 'u7', updatedAt: '2026-11-01T00:00:00Z', headRefName: 'fix', baseRefName: 'main', reviewDecision: 'APPROVED', author: { login: 'ann' }, headRepositoryOwner: { login: 'o' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } },
                  { number: 8, title: 'Fork', state: 'OPEN', isDraft: true, url: 'u8', updatedAt: '2026-11-02T00:00:00Z', headRefName: 'fix', baseRefName: 'main', reviewDecision: null, author: { login: 'bob' }, headRepositoryOwner: { login: 'bob' }, commits: { nodes: [] } },
                ],
              },
            },
          },
        },
      },
      seen,
    );
    const gh = new GitHubClient(fetch, 'github.com', cred);
    const all = await gh.listPulls('o/r', 'open');
    expect(all[0]).toMatchObject({ number: 7, checks: 'failure', review: 'approved', draft: false, head: 'fix' });
    expect(all[1]).toMatchObject({ number: 8, checks: null, draft: true });
    // The current branch's pull request is the one from this repository's owner, not a fork's same-named branch.
    expect((await gh.listPulls('o/r', 'open', { branch: 'fix', owner: 'o' })).map((p) => p.number)).toEqual([7]);
    const headers = seen[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(String(seen[0].init?.body)).variables).toMatchObject({ owner: 'o', name: 'r', states: ['OPEN'] });
  });

  it('reads a pull request with checks, reviews and line comments', async () => {
    const api = 'https://api.github.com/repos/o/r';
    const gh = new GitHubClient(
      fakeFetch({
        [`GET ${api}/pulls/7`]: { number: 7, title: 'Fix', state: 'open', draft: false, user: { login: 'ann' }, head: { ref: 'fix', sha: 'abc' }, base: { ref: 'main' }, html_url: 'u', updated_at: '2026-11-01T00:00:00Z', body: 'Body' },
        [`GET ${api}/commits/abc/check-runs?per_page=100`]: {
          check_runs: [
            { id: 11, name: 'build', status: 'completed', conclusion: 'failure', html_url: 'b', app: { slug: 'github-actions' } },
            { id: 12, name: 'lint', status: 'in_progress', conclusion: null, html_url: 'l', app: { slug: 'github-actions' } },
          ],
        },
        [`GET ${api}/commits/abc/status`]: { statuses: [{ id: 5, context: 'ci/legacy', state: 'success', target_url: 't' }] },
        [`GET ${api}/pulls/7/reviews?per_page=100`]: [
          { id: 1, user: { login: 'rev' }, state: 'CHANGES_REQUESTED', body: 'Please fix', submitted_at: '2026-11-01T01:00:00Z' },
          { id: 2, user: { login: 'rev2' }, state: 'COMMENTED', body: '', submitted_at: '2026-11-01T01:30:00Z' },
        ],
        [`GET ${api}/pulls/7/comments?per_page=100`]: [{ id: 3, user: { login: 'rev' }, body: 'Off by one', path: 'src/a.ts', line: 42, created_at: '2026-11-01T01:00:01Z' }],
        [`GET ${api}/issues/7/comments?per_page=100`]: [{ id: 4, user: { login: 'ann' }, body: 'Thanks', created_at: '2026-11-01T02:00:00Z' }],
      }),
      'github.com',
      cred,
    );
    const pr = await gh.getPull('o/r', 7);
    expect(pr.checks).toBe('failure');
    expect(pr.review).toBe('changes-requested');
    expect(pr.checkList.map((c) => [c.id, c.state, c.hasLog])).toEqual([
      ['run:11', 'failure', true],
      ['run:12', 'pending', true],
      ['status:5', 'success', false],
    ]);
    // The empty "commented" review is left out; the rest is in time order.
    expect(pr.comments.map((c) => [c.author, c.path, c.line, c.review])).toEqual([
      ['rev', null, null, 'changes-requested'],
      ['rev', 'src/a.ts', 42, null],
      ['ann', null, null, null],
    ]);
  });

  it('opens a pull request from a fork as owner:branch', async () => {
    const seen: Array<{ key: string; init?: RequestInit }> = [];
    const gh = new GitHubClient(fakeFetch({ 'POST https://api.github.com/repos/up/r/pulls': { number: 9, title: 'T', state: 'open', user: { login: 'me' }, head: { ref: 'feat' }, base: { ref: 'main' }, html_url: 'u9' } }, seen), 'github.com', cred);
    const pull = await gh.createPull('up/r', { title: 'T', body: 'B', base: 'main', head: 'feat', headPath: 'me/r', draft: true });
    expect(pull).toMatchObject({ number: 9, url: 'u9' });
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({ title: 'T', body: 'B', head: 'me:feat', base: 'main', draft: true });
  });

  it('downloads a job log from the redirect without sending the token there', async () => {
    const seen: Array<{ key: string; init?: RequestInit }> = [];
    const gh = new GitHubClient(
      fakeFetch(
        {
          'GET https://api.github.com/repos/o/r/actions/jobs/11/logs': new Response(null, { status: 302, headers: { location: 'https://blob.example/log?sig=1' } }),
          'GET https://blob.example/log?sig=1': 'line 1\nError: boom\n',
        },
        seen,
      ),
      'github.com',
      cred,
    );
    expect(await gh.checkLog('o/r', 'run:11')).toContain('Error: boom');
    expect(seen[1].init?.headers).toBeUndefined();
    await expect(gh.checkLog('o/r', 'status:5')).rejects.toThrow(/no log/);
  });

  it('reports API failures with their status', async () => {
    const gh = new GitHubClient(async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 }), 'github.com', cred);
    const err = await gh.whoami().catch((e: ForgeError) => e);
    expect(err).toBeInstanceOf(ForgeError);
    expect((err as ForgeError).status).toBe(401);
    expect((err as ForgeError).message).toBe('Bad credentials');
  });
});

describe('GitLab', () => {
  const base = 'https://gitlab.com/api/v4/projects/g%2Fsub%2Fp';

  it('reads a merge request with its pipeline jobs, notes and approvals', async () => {
    const gl = new GitLabClient(
      fakeFetch({
        [`GET ${base}/merge_requests/3`]: { iid: 3, title: 'Feat', state: 'opened', draft: false, author: { username: 'ann' }, source_branch: 'feat', target_branch: 'main', web_url: 'w', updated_at: '2026-11-01T00:00:00Z', description: 'D', sha: 'abc', head_pipeline: { id: 50, status: 'failed', project_id: 77, web_url: 'p' } },
        'GET https://gitlab.com/api/v4/projects/77/pipelines/50/jobs?per_page=100': [
          { id: 1, name: 'test', stage: 'test', status: 'failed', web_url: 'j1' },
          { id: 2, name: 'lint', stage: 'test', status: 'success', web_url: 'j2' },
        ],
        [`GET ${base}/merge_requests/3/notes?sort=asc&order_by=created_at&per_page=100`]: [
          { id: 10, system: true, body: 'added 1 commit', author: { username: 'ann' }, created_at: '2026-11-01T00:00:00Z' },
          { id: 11, system: false, body: 'Nit', author: { username: 'rev' }, created_at: '2026-11-01T01:00:00Z', position: { new_path: 'a.ts', new_line: 3 } },
        ],
        [`GET ${base}/merge_requests/3/approvals`]: { approved: true, approved_by: [{ user: { username: 'lead' } }] },
      }),
      'gitlab.com',
      cred,
    );
    const mr = await gl.getPull('g/sub/p', 3);
    expect(mr).toMatchObject({ number: 3, state: 'open', checks: 'failure', review: 'approved', head: 'feat' });
    expect(mr.checkList.map((c) => [c.id, c.name, c.state])).toEqual([
      ['job:77:1', 'test / test', 'failure'],
      ['job:77:2', 'test / lint', 'success'],
    ]);
    expect(mr.comments.find((c) => c.author === 'rev')).toMatchObject({ path: 'a.ts', line: 3 });
    expect(mr.comments.some((c) => c.body === 'added 1 commit')).toBe(false);
  });

  it('marks drafts in the title and targets the parent project from a fork', async () => {
    const seen: Array<{ key: string; init?: RequestInit }> = [];
    const gl = new GitLabClient(
      fakeFetch(
        {
          [`GET ${base}`]: { id: 42, default_branch: 'main', web_url: 'w' },
          'POST https://gitlab.com/api/v4/projects/me%2Fp/merge_requests': { iid: 4, title: 'Draft: T', state: 'opened', draft: true, author: { username: 'me' }, source_branch: 'feat', target_branch: 'main', web_url: 'w4' },
        },
        seen,
      ),
      'gitlab.com',
      cred,
    );
    const mr = await gl.createPull('g/sub/p', { title: 'T', body: 'B', base: 'main', head: 'feat', headPath: 'me/p', draft: true });
    expect(mr).toMatchObject({ number: 4, draft: true });
    expect(JSON.parse(String(seen[1].init?.body))).toEqual({ source_branch: 'feat', target_branch: 'main', title: 'Draft: T', description: 'B', target_project_id: 42 });
  });
});

describe('Forgejo', () => {
  it('signs in with Basic auth for a credential-helper password and filters by branch', async () => {
    const seen: Array<{ key: string; init?: RequestInit }> = [];
    const fj = new ForgejoClient(
      fakeFetch(
        {
          'GET https://codeberg.org/api/v1/repos/o/r/pulls?state=open&sort=recentupdate&limit=50': [
            { number: 1, title: 'WIP: x', state: 'open', merged: false, user: { login: 'o' }, head: { ref: 'x', sha: 's1', repo: { owner: { login: 'o' } } }, base: { ref: 'main' }, html_url: 'u1' },
            { number: 2, title: 'Other', state: 'open', merged: false, user: { login: 'o' }, head: { ref: 'y', sha: 's2', repo: { owner: { login: 'o' } } }, base: { ref: 'main' }, html_url: 'u2' },
          ],
          'GET https://codeberg.org/api/v1/repos/o/r/commits/s1/status': { state: 'success', total_count: 1, statuses: [] },
        },
        seen,
      ),
      'codeberg.org',
      { token: 'pw', username: 'me', source: 'credential' },
    );
    const list = await fj.listPulls('o/r', 'open', { branch: 'x', owner: 'o' });
    expect(list).toEqual([expect.objectContaining({ number: 1, draft: true, checks: 'success' })]);
    expect((seen[0].init?.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('me:pw').toString('base64')}`);
    await expect(fj.checkLog()).rejects.toThrow(/don’t offer check logs/);
  });

  it('sends a saved token as a token header', async () => {
    const seen: Array<{ key: string; init?: RequestInit }> = [];
    await new ForgejoClient(fakeFetch({ 'GET https://codeberg.org/api/v1/user': { login: 'me' } }, seen), 'codeberg.org', cred).whoami();
    expect((seen[0].init?.headers as Record<string, string>).Authorization).toBe('token tok');
  });
});

describe('check roll-up', () => {
  it('fails on any failure, then waits on anything running', () => {
    expect(rollUp([])).toBeNull();
    expect(rollUp(['success', 'pending', 'failure'])).toBe('failure');
    expect(rollUp(['success', 'pending'])).toBe('pending');
    expect(rollUp(['success', 'skipped'])).toBe('success');
    expect(rollUp(['skipped'])).toBe('skipped');
  });
});

describe('phones', () => {
  it('can read pull requests but not sign in, open or comment', () => {
    for (const m of ['forgeAccounts', 'forgeAddHost', 'forgeRemoveHost', 'forgeSetToken', 'forgeClearToken', 'forgeCreatePull', 'forgeComment', 'setGitIdentity', 'getGitInfo'] as const) expect(REMOTE_BLOCKED.has(m)).toBe(true);
    for (const m of ['forgeLookup', 'forgeListPulls', 'forgeGetPull', 'forgeCheckLog', 'gitLog', 'gitShowCommit', 'gitCommitDiff'] as const) expect(REMOTE_BLOCKED.has(m)).toBe(false);
  });
});
