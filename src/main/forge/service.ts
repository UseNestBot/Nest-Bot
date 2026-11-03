import { FORGE_LABEL, FORGE_SOURCE_LABEL, type ForgeAccount, type ForgeKind, type ForgeLookup, type ForgePull, type ForgePullDetail, type ForgePullDraft, type GitRepoStatus } from '@shared/types';
import type { GitService } from '../git/service';
import { discoverCredentials, type DiscoveryDeps, type ForgeCredential, type ForgeStore } from './accounts';
import { ForgeError, makeClient, type Fetch, type ForgeClient, type PullListState } from './clients';
import { KNOWN_HOSTS, forgeKindFor, normalizeHost, parseRemoteUrl, type RemoteLocation } from './remote';

/** How long a host's sign-in check is trusted before Nest looks again. */
const ACCOUNT_TTL_MS = 10 * 60_000;
const REPO_TTL_MS = 10 * 60_000;
const CURRENT_PULL_TTL_MS = 20_000;
/** Hosts Settings always lists. */
const DEFAULT_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org'];

/** A forge failure worded for the user. */
export { ForgeError };

interface AccountEntry {
  account: ForgeAccount;
  cred: ForgeCredential | null;
  at: number;
}

interface Target {
  repo: GitRepoStatus;
  base: RemoteLocation & { remote: string; kind: ForgeKind };
  head: RemoteLocation & { remote: string; branch: string | null };
}

/**
 * GitHub, GitLab and Forgejo for the repositories in chats' and projects'
 * working folders. Signs in with what the user already has (the forge's CLI,
 * git's credential helper) or a token they saved in Nest.
 */
export class ForgeService {
  private readonly accountCache = new Map<string, AccountEntry>();
  private readonly pending = new Map<string, Promise<AccountEntry>>();
  private readonly repoCache = new Map<string, { defaultBranch: string; webUrl: string; at: number }>();
  private readonly currentCache = new Map<string, { pull: ForgePull | null; at: number }>();
  /** Hosts seen in repositories this session, listed in Settings. */
  private readonly seen = new Set<string>();

  constructor(
    private readonly opts: {
      store: ForgeStore;
      git: GitService;
      fetch: Fetch;
      discovery: DiscoveryDeps;
      onChange?: () => void;
    },
  ) {}

  private kindFor(host: string): ForgeKind | null {
    return forgeKindFor(host, this.opts.store.hosts());
  }

  // -------------------------------------------------------------------------
  // Accounts

  private async check(host: string, kind: ForgeKind): Promise<AccountEntry> {
    const custom = this.opts.store.hosts().some((h) => h.host === host);
    const saved = this.opts.store.token(host);
    const base: ForgeAccount = { host, kind, custom, state: 'signed-out', user: null, source: null, savedHint: this.opts.store.hint(host), error: null };
    const creds: ForgeCredential[] = saved ? [{ token: saved, username: null, source: 'saved' }] : [];
    creds.push(...(await discoverCredentials(host, kind, this.opts.discovery)));
    let firstError: string | null = null;
    for (const cred of creds) {
      try {
        const user = await makeClient(kind, this.opts.fetch, host, cred).whoami();
        return { account: { ...base, state: 'ready', user, source: cred.source }, cred, at: Date.now() };
      } catch (err) {
        firstError ??= `${FORGE_LABEL[kind]} refused the ${FORGE_SOURCE_LABEL[cred.source]}: ${(err as Error).message}`;
        // A refused saved token is worth saying; a stale helper credential falls through to the next.
        if (cred.source === 'saved') break;
      }
    }
    return { account: { ...base, state: firstError ? 'error' : 'signed-out', error: firstError }, cred: null, at: Date.now() };
  }

  /** A host's account, from cache unless `force` or it's gone stale. */
  async account(host: string, force = false): Promise<ForgeAccount> {
    return (await this.entry(host, force)).account;
  }

  private async entry(host: string, force = false): Promise<AccountEntry> {
    const kind = this.kindFor(host);
    if (!kind) throw new ForgeError(`Nest doesn’t know what kind of forge ${host} is. Add it in Settings → Git & forges.`);
    const cached = this.accountCache.get(host);
    if (!force && cached && Date.now() - cached.at < ACCOUNT_TTL_MS && cached.account.kind === kind) return cached;
    const inflight = this.pending.get(host);
    if (inflight && !force) return inflight;
    const p = this.check(host, kind).finally(() => this.pending.delete(host));
    this.pending.set(host, p);
    const entry = await p;
    this.accountCache.set(host, entry);
    return entry;
  }

  /** Every host Settings shows: the well-known ones, ones the user added, and ones seen in repositories. */
  async accounts(force = false): Promise<ForgeAccount[]> {
    const hosts = [...new Set([...DEFAULT_HOSTS, ...this.opts.store.hosts().map((h) => h.host), ...this.seen])].filter((h) => this.kindFor(h));
    return Promise.all(hosts.map((h) => this.account(h, force)));
  }

  async addHost(input: string, kind: ForgeKind): Promise<ForgeAccount> {
    const host = normalizeHost(input);
    if (!host) throw new ForgeError('Enter a host name, like git.example.com.');
    if (KNOWN_HOSTS[host] && KNOWN_HOSTS[host] !== kind) throw new ForgeError(`${host} is ${FORGE_LABEL[KNOWN_HOSTS[host]]}.`);
    this.opts.store.addHost(host, kind);
    this.forget(host);
    return this.account(host, true);
  }

  removeHost(host: string): void {
    this.opts.store.removeHost(host);
    this.forget(host);
  }

  /** Check a pasted token works, then save it encrypted. */
  async setToken(host: string, token: string): Promise<ForgeAccount> {
    const kind = this.kindFor(host);
    if (!kind) throw new ForgeError(`Nest doesn’t know what kind of forge ${host} is.`);
    const clean = token.trim();
    if (!clean || /\s/.test(clean)) throw new ForgeError('Paste the token on its own, without spaces.');
    try {
      await makeClient(kind, this.opts.fetch, host, { token: clean, username: null, source: 'saved' }).whoami();
    } catch (err) {
      throw new ForgeError(`${FORGE_LABEL[kind]} didn’t accept that token: ${(err as Error).message}`);
    }
    this.opts.store.setToken(host, clean);
    this.forget(host);
    return this.account(host, true);
  }

  async clearToken(host: string): Promise<ForgeAccount> {
    this.opts.store.clearToken(host);
    this.forget(host);
    return this.account(host, true);
  }

  private forget(host: string): void {
    this.accountCache.delete(host);
    for (const key of [...this.repoCache.keys()]) if (key.startsWith(`${host}/`)) this.repoCache.delete(key);
    this.currentCache.clear();
    this.opts.onChange?.();
  }

  private async client(host: string): Promise<ForgeClient> {
    const entry = await this.entry(host);
    if (!entry.cred) {
      const label = FORGE_LABEL[entry.account.kind];
      throw new ForgeError(entry.account.error ?? `Nest isn’t signed in to ${label} at ${host}. ${entry.account.kind === 'github' ? 'Run gh auth login, or p' : entry.account.kind === 'gitlab' ? 'Run glab auth login, or p' : 'P'}aste a token in Settings → Git & forges.`);
    }
    return makeClient(entry.account.kind, this.opts.fetch, host, entry.cred, 'https');
  }

  /** Run a forge call, rewording failures and forgetting a credential the forge refused. */
  private async call<T>(host: string, what: string, fn: (c: ForgeClient) => Promise<T>): Promise<T> {
    const client = await this.client(host);
    try {
      return await fn(client);
    } catch (err) {
      if (!(err instanceof ForgeError)) throw err;
      const label = FORGE_LABEL[this.kindFor(host) ?? 'github'];
      if (err.status === 401) {
        this.accountCache.delete(host);
        this.opts.onChange?.();
        throw new ForgeError(`${label} signed Nest out (${err.message}). Sign in again, or paste a new token in Settings → Git & forges.`, 401);
      }
      if (err.status === 403) throw new ForgeError(`${label} won’t let Nest ${what}: ${err.message}. The token may be missing a permission.`, 403);
      if (err.status === 404) throw new ForgeError(`${label} couldn’t find that (${what}). Check the token can see this repository.`, 404);
      throw new ForgeError(`Couldn’t ${what}: ${err.message}`, err.status);
    }
  }

  // -------------------------------------------------------------------------
  // Repositories

  /** The remotes a pull request goes between: into `upstream` when there is one (a fork), from the branch's own remote. */
  private async target(folder: string): Promise<Target | { unknownHost: string | null }> {
    const status = await this.opts.git.status(folder);
    const repo = status.repo;
    if (!repo) throw new ForgeError('This folder isn’t a git repository.');
    const located = repo.remotes.map((r) => ({ remote: r.name, loc: parseRemoteUrl(r.url) })).filter((r): r is { remote: string; loc: RemoteLocation } => Boolean(r.loc));
    for (const r of located) if (this.kindFor(r.loc.host)) this.seen.add(r.loc.host);
    const onForge = located.filter((r) => this.kindFor(r.loc.host));
    const base = onForge.find((r) => r.remote === 'upstream') ?? onForge.find((r) => r.remote === 'origin') ?? onForge[0];
    if (!base) return { unknownHost: located[0]?.loc.host ?? null };
    const upstreamRemote = repo.upstream ? onForge.find((r) => repo.upstream!.startsWith(`${r.remote}/`)) : undefined;
    const headRemote = upstreamRemote ?? onForge.find((r) => r.remote === 'origin') ?? base;
    const head = headRemote.loc.host === base.loc.host ? headRemote : base;
    const branch = upstreamRemote && repo.upstream ? repo.upstream.slice(upstreamRemote.remote.length + 1) : repo.branch;
    return {
      repo,
      base: { ...base.loc, remote: base.remote, kind: this.kindFor(base.loc.host)! },
      head: { ...head.loc, remote: head.remote, branch },
    };
  }

  private async repoInfo(host: string, path: string): Promise<{ defaultBranch: string; webUrl: string }> {
    const key = `${host}/${path}`;
    const hit = this.repoCache.get(key);
    if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit;
    const info = await this.call(host, `read ${path}`, (c) => c.repo(path));
    this.repoCache.set(key, { ...info, at: Date.now() });
    return info;
  }

  /** The forge repository behind a working folder, the account Nest uses for it, and the current branch's pull request. */
  async lookup(folder: string): Promise<ForgeLookup> {
    const t = await this.target(folder);
    if (!('base' in t)) return { repo: null, unknownHost: t.unknownHost, error: null };
    const { base, head, repo } = t;
    const account = await this.account(base.host);
    const webUrl = `https://${base.host}/${base.path}`;
    const result: ForgeLookup = {
      repo: { host: base.host, kind: base.kind, path: base.path, remote: base.remote, webUrl, defaultBranch: null, account, current: null },
      unknownHost: null,
      error: null,
    };
    if (account.state !== 'ready') return result;
    try {
      const info = await this.repoInfo(base.host, base.path);
      result.repo!.defaultBranch = info.defaultBranch;
      result.repo!.webUrl = info.webUrl || webUrl;
      if (head.branch && repo.upstream) result.repo!.current = await this.currentPull(base, head, repo.head);
    } catch (err) {
      result.error = (err as Error).message;
    }
    return result;
  }

  private async currentPull(base: Target['base'], head: Target['head'], sha: string | null): Promise<ForgePull | null> {
    const key = `${base.host}/${base.path}#${head.path}:${head.branch}@${sha}`;
    const hit = this.currentCache.get(key);
    if (hit && Date.now() - hit.at < CURRENT_PULL_TTL_MS) return hit.pull;
    const owner = head.path.split('/')[0];
    const list = await this.call(base.host, 'look up this branch’s pull request', (c) => c.listPulls(base.path, 'open', { branch: head.branch!, owner }));
    const pull = list[0] ?? null;
    this.currentCache.set(key, { pull, at: Date.now() });
    return pull;
  }

  private async requireTarget(folder: string): Promise<Target> {
    const t = await this.target(folder);
    if ('base' in t) return t;
    throw new ForgeError(t.unknownHost ? `Nest doesn’t know what kind of forge ${t.unknownHost} is. Add it in Settings → Git & forges.` : 'This repository has no remote on GitHub, GitLab or Forgejo.');
  }

  async listPulls(folder: string, state: PullListState = 'open'): Promise<ForgePull[]> {
    const { base } = await this.requireTarget(folder);
    return this.call(base.host, 'list pull requests', (c) => c.listPulls(base.path, state));
  }

  async getPull(folder: string, number: number): Promise<ForgePullDetail> {
    const { base } = await this.requireTarget(folder);
    return this.call(base.host, `read pull request #${number}`, (c) => c.getPull(base.path, number));
  }

  async checkLog(folder: string, checkId: string): Promise<string> {
    const { base } = await this.requireTarget(folder);
    return this.call(base.host, 'read that check’s log', (c) => c.checkLog(base.path, checkId));
  }

  async comment(folder: string, number: number, body: string): Promise<void> {
    if (!body.trim()) throw new ForgeError('Write a comment first.');
    const { base } = await this.requireTarget(folder);
    await this.call(base.host, `comment on #${number}`, (c) => c.comment(base.path, number, body));
  }

  /** Open a pull request for the current branch, pushing it first if the forge doesn't have all of it yet. */
  async createPull(folder: string, draft: ForgePullDraft): Promise<ForgePull> {
    const title = draft.title.trim();
    if (!title) throw new ForgeError('Give the pull request a title.');
    let t = await this.requireTarget(folder);
    if (!t.repo.branch) throw new ForgeError('You’re not on a branch (HEAD is detached). Create a branch for your changes first.');
    if (!t.repo.upstream || t.repo.ahead > 0) {
      await this.opts.git.push(folder);
      t = await this.requireTarget(folder);
    }
    const { base, head } = t;
    const into = draft.base.trim() || (await this.repoInfo(base.host, base.path)).defaultBranch;
    const branch = head.branch ?? t.repo.branch!;
    if (branch === into && head.path === base.path) throw new ForgeError(`You’re on ${into}, the branch it would merge into. Create a branch for your changes first.`);
    const pull = await this.call(base.host, 'open the pull request', (c) =>
      c.createPull(base.path, { title, body: draft.body, base: into, head: branch, headPath: head.path, draft: draft.draft }),
    );
    this.currentCache.clear();
    return pull;
  }
}
