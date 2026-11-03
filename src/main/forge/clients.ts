import type { ForgeCheck, ForgeCheckState, ForgeComment, ForgeKind, ForgePull, ForgePullDetail, ForgePullState } from '@shared/types';
import type { ForgeCredential } from './accounts';
import { apiBase } from './remote';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;
/** Most of a check's log Nest hands back: the end, where failures are. */
const MAX_LOG_CHARS = 60_000;
const LIST_LIMIT = 30;
/** Open pull requests whose checks a list looks up one by one (GitLab, Forgejo). */
const LIST_CHECKS_LIMIT = 20;

/** A forge API failure. `status` is the HTTP status, when there was a response. */
export class ForgeError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export interface PullCreate {
  title: string;
  body: string;
  base: string;
  /** The branch with the changes. */
  head: string;
  /** The repository the head branch is in (differs from the target for a fork). */
  headPath: string;
  draft: boolean;
}

export type PullListState = 'open' | 'closed' | 'all';

export interface ForgeClient {
  whoami(): Promise<string>;
  repo(path: string): Promise<{ defaultBranch: string; webUrl: string }>;
  /** Newest first. `head` narrows to pull requests from one branch (and, for forks, one owner). */
  listPulls(path: string, state: PullListState, head?: { branch: string; owner: string }): Promise<ForgePull[]>;
  getPull(path: string, number: number): Promise<ForgePullDetail>;
  createPull(path: string, req: PullCreate): Promise<ForgePull>;
  comment(path: string, number: number, body: string): Promise<void>;
  /** The end of a check's log. */
  checkLog(path: string, checkId: string): Promise<string>;
}

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

class Http {
  constructor(
    private readonly fetch: Fetch,
    readonly base: string,
    private readonly headers: Record<string, string>,
  ) {}

  private async send(method: string, url: string, body?: unknown, redirect: RequestRedirect = 'follow'): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetch(url.startsWith('http') ? url : `${this.base}${url}`, {
        method,
        headers: { ...this.headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect,
      });
    } catch (err) {
      const e = err as Error;
      throw new ForgeError(e.name === 'TimeoutError' ? 'The forge took too long to answer.' : `Couldn’t reach the forge: ${e.message}`);
    }
    // Browser-style fetches hide a manual redirect behind an opaque response; the caller falls back.
    if (redirect === 'manual' && (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400))) return res;
    if (!res.ok) {
      let detail = '';
      try {
        const data = (await res.json()) as Json;
        detail = typeof data?.message === 'string' ? data.message : typeof data?.error === 'string' ? data.error : Array.isArray(data?.message) ? data.message.join(', ') : '';
        if (Array.isArray(data?.errors) && data.errors.length) detail += ` (${data.errors.map((e: Json) => e?.message ?? e?.code ?? String(e)).join('; ')})`;
      } catch {
        /* not JSON */
      }
      throw new ForgeError(detail || `${res.status} ${res.statusText}`.trim(), res.status);
    }
    return res;
  }

  async json<T = Json>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.send(method, url, body);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  get<T = Json>(url: string): Promise<T> {
    return this.json<T>('GET', url);
  }

  async text(url: string): Promise<string> {
    return (await this.send('GET', url)).text();
  }

  /** Text behind a redirect to signed storage (a log file), fetched there without the forge's token. */
  async redirectedText(url: string): Promise<string> {
    const res = await this.send('GET', url, undefined, 'manual');
    if (res.type === 'opaqueredirect') return this.text(url);
    const location = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400) || !location) return res.text();
    let file: Response;
    try {
      file = await this.fetch(new URL(location, `${this.base}/`).toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new ForgeError(`Couldn’t download the log: ${(err as Error).message}`);
    }
    if (!file.ok) throw new ForgeError(`Couldn’t download the log (${file.status}).`, file.status);
    return file.text();
  }
}

function time(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}

function tail(log: string): string {
  if (log.length <= MAX_LOG_CHARS) return log;
  const cut = log.slice(-MAX_LOG_CHARS);
  return `…(earlier output cut)\n${cut.slice(cut.indexOf('\n') + 1)}`;
}

/** One state for several checks: any failure fails, then anything still running, then success. */
export function rollUp(states: ForgeCheckState[]): ForgeCheckState | null {
  if (!states.length) return null;
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  if (states.includes('success')) return 'success';
  return states.includes('neutral') ? 'neutral' : 'skipped';
}

/** The latest verdict per reviewer, rolled up: any request for changes wins over approvals. */
function reviewVerdict(reviews: Array<{ author: string; verdict: ForgeComment['review'] }>): ForgePull['review'] {
  const latest = new Map<string, ForgeComment['review']>();
  for (const r of reviews) if (r.verdict === 'approved' || r.verdict === 'changes-requested') latest.set(r.author, r.verdict);
  const verdicts = [...latest.values()];
  return verdicts.includes('changes-requested') ? 'changes-requested' : verdicts.includes('approved') ? 'approved' : null;
}

function byTime(a: ForgeComment, b: ForgeComment): number {
  return a.createdAt - b.createdAt;
}

async function limited<T, R>(items: T[], fn: (item: T) => Promise<R>, concurrency = 6): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// GitHub

const GH_ROLLUP: Record<string, ForgeCheckState> = { SUCCESS: 'success', FAILURE: 'failure', ERROR: 'failure', PENDING: 'pending', EXPECTED: 'pending' };
const GH_STATE: Record<string, ForgePullState> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };

function ghRunState(run: Json): ForgeCheckState {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
      return 'failure';
    case 'skipped':
    case 'cancelled':
    case 'stale':
      return 'skipped';
    default:
      return 'neutral';
  }
}

function ghStatusState(state: string): ForgeCheckState {
  return state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure';
}

function ghPull(pr: Json): ForgePull {
  return {
    number: pr.number,
    title: pr.title ?? '',
    state: pr.merged_at || pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
    draft: Boolean(pr.draft),
    author: pr.user?.login ?? '',
    head: pr.head?.ref ?? '',
    base: pr.base?.ref ?? '',
    url: pr.html_url ?? '',
    updatedAt: time(pr.updated_at),
    checks: null,
    review: null,
  };
}

const GH_LIST_QUERY = `query($owner: String!, $name: String!, $states: [PullRequestState!], $head: String, $first: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, states: $states, headRefName: $head, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title state isDraft url updatedAt headRefName baseRefName reviewDecision
        author { login }
        headRepositoryOwner { login }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

export class GitHubClient implements ForgeClient {
  private readonly http: Http;
  private readonly graphql: string;

  constructor(fetch: Fetch, host: string, cred: ForgeCredential, scheme: 'https' | 'http' = 'https') {
    const base = apiBase('github', host, scheme);
    this.http = new Http(fetch, base, { Authorization: `Bearer ${cred.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Nest' });
    this.graphql = host === 'github.com' ? 'https://api.github.com/graphql' : `${scheme}://${host}/api/graphql`;
  }

  async whoami(): Promise<string> {
    return (await this.http.get('/user')).login;
  }

  async repo(path: string) {
    const r = await this.http.get(`/repos/${path}`);
    return { defaultBranch: r.default_branch, webUrl: r.html_url };
  }

  async listPulls(path: string, state: PullListState, head?: { branch: string; owner: string }): Promise<ForgePull[]> {
    const [owner, name] = path.split('/');
    const states = state === 'open' ? ['OPEN'] : state === 'closed' ? ['CLOSED', 'MERGED'] : null;
    const res = await this.http.json('POST', this.graphql, { query: GH_LIST_QUERY, variables: { owner, name, states, head: head?.branch ?? null, first: LIST_LIMIT } });
    if (res?.errors?.length) throw new ForgeError(res.errors.map((e: Json) => e.message).join('; '));
    const nodes: Json[] = res?.data?.repository?.pullRequests?.nodes ?? [];
    return nodes
      .filter((n) => !head || (n.headRepositoryOwner?.login ?? '').toLowerCase() === head.owner.toLowerCase())
      .map((n) => ({
        number: n.number,
        title: n.title,
        state: GH_STATE[n.state] ?? 'closed',
        draft: Boolean(n.isDraft),
        author: n.author?.login ?? 'ghost',
        head: n.headRefName,
        base: n.baseRefName,
        url: n.url,
        updatedAt: time(n.updatedAt),
        checks: GH_ROLLUP[n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state] ?? null,
        review: n.reviewDecision === 'APPROVED' ? 'approved' : n.reviewDecision === 'CHANGES_REQUESTED' ? 'changes-requested' : null,
      }));
  }

  async getPull(path: string, number: number): Promise<ForgePullDetail> {
    const pr = await this.http.get(`/repos/${path}/pulls/${number}`);
    const sha: string | null = pr.head?.sha ?? null;
    const optional = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const [runs, status, reviews, lineComments, comments] = await Promise.all([
      sha ? optional(this.http.get(`/repos/${path}/commits/${sha}/check-runs?per_page=100`), { check_runs: [] }) : { check_runs: [] },
      sha ? optional(this.http.get(`/repos/${path}/commits/${sha}/status`), { statuses: [] }) : { statuses: [] },
      optional(this.http.get<Json[]>(`/repos/${path}/pulls/${number}/reviews?per_page=100`), []),
      optional(this.http.get<Json[]>(`/repos/${path}/pulls/${number}/comments?per_page=100`), []),
      optional(this.http.get<Json[]>(`/repos/${path}/issues/${number}/comments?per_page=100`), []),
    ]);
    const checkList: ForgeCheck[] = [
      ...(runs.check_runs ?? []).map((r: Json) => ({ id: `run:${r.id}`, name: r.name, state: ghRunState(r), url: r.html_url ?? r.details_url ?? null, hasLog: r.app?.slug === 'github-actions' })),
      ...(status.statuses ?? []).map((s: Json) => ({ id: `status:${s.id}`, name: s.context, state: ghStatusState(s.state), url: s.target_url || null, hasLog: false })),
    ];
    const verdict = (s: string): ForgeComment['review'] => (s === 'APPROVED' ? 'approved' : s === 'CHANGES_REQUESTED' ? 'changes-requested' : s === 'COMMENTED' ? 'commented' : null);
    const reviewComments: ForgeComment[] = reviews
      .filter((r) => r.state !== 'PENDING' && r.state !== 'DISMISSED' && (r.body || r.state !== 'COMMENTED'))
      .map((r) => ({ id: `review:${r.id}`, author: r.user?.login ?? 'ghost', body: r.body ?? '', createdAt: time(r.submitted_at), path: null, line: null, url: r.html_url ?? null, review: verdict(r.state) }));
    const all: ForgeComment[] = [
      ...reviewComments,
      ...lineComments.map((c) => ({ id: `line:${c.id}`, author: c.user?.login ?? 'ghost', body: c.body ?? '', createdAt: time(c.created_at), path: c.path ?? null, line: c.line ?? c.original_line ?? null, url: c.html_url ?? null, review: null })),
      ...comments.map((c) => ({ id: `comment:${c.id}`, author: c.user?.login ?? 'ghost', body: c.body ?? '', createdAt: time(c.created_at), path: null, line: null, url: c.html_url ?? null, review: null })),
    ].sort(byTime);
    return {
      ...ghPull(pr),
      body: pr.body ?? '',
      headSha: sha,
      checks: rollUp(checkList.map((c) => c.state)),
      review: reviewVerdict(reviews.map((r) => ({ author: r.user?.login ?? '', verdict: verdict(r.state) }))),
      checkList,
      comments: all,
    };
  }

  async createPull(path: string, req: PullCreate): Promise<ForgePull> {
    const head = req.headPath === path ? req.head : `${req.headPath.split('/')[0]}:${req.head}`;
    return ghPull(await this.http.json('POST', `/repos/${path}/pulls`, { title: req.title, body: req.body, head, base: req.base, draft: req.draft }));
  }

  async comment(path: string, number: number, body: string): Promise<void> {
    await this.http.json('POST', `/repos/${path}/issues/${number}/comments`, { body });
  }

  async checkLog(path: string, checkId: string): Promise<string> {
    const m = /^run:(\d+)$/.exec(checkId);
    if (!m) throw new ForgeError('That check has no log Nest can read. Open it on the web.');
    // Check runs from GitHub Actions are jobs; the API redirects to the log file.
    return tail(await this.http.redirectedText(`/repos/${path}/actions/jobs/${m[1]}/logs`));
  }
}

// ---------------------------------------------------------------------------
// GitLab

function glState(s: string): ForgeCheckState {
  switch (s) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failure';
    case 'canceled':
    case 'skipped':
      return 'skipped';
    case 'manual':
      return 'neutral';
    default:
      return 'pending'; // created, waiting_for_resource, preparing, pending, running, scheduled
  }
}

function glPull(mr: Json): ForgePull {
  return {
    number: mr.iid,
    title: mr.title ?? '',
    state: mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed',
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    author: mr.author?.username ?? '',
    head: mr.source_branch ?? '',
    base: mr.target_branch ?? '',
    url: mr.web_url ?? '',
    updatedAt: time(mr.updated_at),
    checks: mr.head_pipeline?.status ? glState(mr.head_pipeline.status) : null,
    review: null,
  };
}

export class GitLabClient implements ForgeClient {
  private readonly http: Http;

  constructor(fetch: Fetch, host: string, cred: ForgeCredential, scheme: 'https' | 'http' = 'https') {
    this.http = new Http(fetch, apiBase('gitlab', host, scheme), { Authorization: `Bearer ${cred.token}`, Accept: 'application/json', 'User-Agent': 'Nest' });
  }

  private p(path: string): string {
    return `/projects/${encodeURIComponent(path)}`;
  }

  async whoami(): Promise<string> {
    return (await this.http.get('/user')).username;
  }

  async repo(path: string) {
    const r = await this.http.get(this.p(path));
    return { defaultBranch: r.default_branch, webUrl: r.web_url };
  }

  async listPulls(path: string, state: PullListState, head?: { branch: string; owner: string }): Promise<ForgePull[]> {
    const q = new URLSearchParams({ state: state === 'open' ? 'opened' : 'all', order_by: 'updated_at', sort: 'desc', per_page: String(LIST_LIMIT) });
    if (head) q.set('source_branch', head.branch);
    const list: Json[] = await this.http.get(`${this.p(path)}/merge_requests?${q}`);
    const pulls = list.map(glPull).filter((p) => state !== 'closed' || p.state !== 'open');
    // The list leaves out each merge request's pipeline: look up the open ones.
    const open = pulls.filter((p) => p.state === 'open').slice(0, LIST_CHECKS_LIMIT);
    await limited(open, async (pull) => {
      try {
        const mr = await this.http.get(`${this.p(path)}/merge_requests/${pull.number}`);
        pull.checks = mr.head_pipeline?.status ? glState(mr.head_pipeline.status) : null;
      } catch {
        /* leave unknown */
      }
    });
    return pulls;
  }

  async getPull(path: string, number: number): Promise<ForgePullDetail> {
    const base = `${this.p(path)}/merge_requests/${number}`;
    const mr = await this.http.get(base);
    const pipeline = mr.head_pipeline;
    const optional = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const pipelineProject = pipeline?.project_id ?? encodeURIComponent(path);
    const [jobs, notes, approvals] = await Promise.all([
      pipeline?.id ? optional(this.http.get<Json[]>(`/projects/${pipelineProject}/pipelines/${pipeline.id}/jobs?per_page=100`), []) : Promise.resolve([] as Json[]),
      optional(this.http.get<Json[]>(`${base}/notes?sort=asc&order_by=created_at&per_page=100`), []),
      optional(this.http.get(`${base}/approvals`), null),
    ]);
    const checkList: ForgeCheck[] = jobs.map((j) => ({ id: `job:${pipelineProject}:${j.id}`, name: j.stage ? `${j.stage} / ${j.name}` : j.name, state: glState(j.status), url: j.web_url ?? null, hasLog: true }));
    if (!checkList.length && pipeline) checkList.push({ id: `pipeline:${pipeline.id}`, name: 'Pipeline', state: glState(pipeline.status), url: pipeline.web_url ?? null, hasLog: false });
    const comments: ForgeComment[] = notes
      .filter((n) => !n.system)
      .map((n) => ({
        id: `note:${n.id}`,
        author: n.author?.username ?? '',
        body: n.body ?? '',
        createdAt: time(n.created_at),
        path: n.position?.new_path ?? n.position?.old_path ?? null,
        line: n.position?.new_line ?? n.position?.old_line ?? null,
        url: mr.web_url ? `${mr.web_url}#note_${n.id}` : null,
        review: null,
      }));
    for (const a of approvals?.approved_by ?? []) {
      comments.push({ id: `approval:${a.user?.username}`, author: a.user?.username ?? '', body: '', createdAt: time(mr.updated_at), path: null, line: null, url: null, review: 'approved' });
    }
    comments.sort(byTime);
    return {
      ...glPull(mr),
      body: mr.description ?? '',
      headSha: mr.sha ?? null,
      checks: checkList.length ? rollUp(checkList.map((c) => c.state)) : null,
      review: approvals?.approved || approvals?.approved_by?.length ? 'approved' : null,
      checkList,
      comments,
    };
  }

  async createPull(path: string, req: PullCreate): Promise<ForgePull> {
    const title = req.draft && !/^(draft:|\[draft\])/i.test(req.title) ? `Draft: ${req.title}` : req.title;
    const body: Record<string, unknown> = { source_branch: req.head, target_branch: req.base, title, description: req.body };
    if (req.headPath !== path) body.target_project_id = (await this.http.get(this.p(path))).id;
    return glPull(await this.http.json('POST', `${this.p(req.headPath)}/merge_requests`, body));
  }

  async comment(path: string, number: number, body: string): Promise<void> {
    await this.http.json('POST', `${this.p(path)}/merge_requests/${number}/notes`, { body });
  }

  async checkLog(_path: string, checkId: string): Promise<string> {
    const m = /^job:([^:]+):(\d+)$/.exec(checkId);
    if (!m) throw new ForgeError('That check has no log Nest can read. Open it on the web.');
    return tail(await this.http.text(`/projects/${m[1]}/jobs/${m[2]}/trace`));
  }
}

// ---------------------------------------------------------------------------
// Forgejo and Gitea

function fjState(s: string): ForgeCheckState {
  return s === 'success' ? 'success' : s === 'pending' ? 'pending' : s === 'warning' ? 'neutral' : 'failure';
}

const WIP = /^\s*(wip:|\[wip\]|draft:|\[draft\])/i;

function fjPull(pr: Json): ForgePull {
  return {
    number: pr.number,
    title: pr.title ?? '',
    state: pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed',
    draft: Boolean(pr.draft) || WIP.test(pr.title ?? ''),
    author: pr.user?.login ?? '',
    head: pr.head?.ref ?? '',
    base: pr.base?.ref ?? '',
    url: pr.html_url ?? '',
    updatedAt: time(pr.updated_at),
    checks: null,
    review: null,
  };
}

export class ForgejoClient implements ForgeClient {
  private readonly http: Http;

  constructor(fetch: Fetch, host: string, cred: ForgeCredential, scheme: 'https' | 'http' = 'https') {
    // A user name and password from git's credential helper sign in with Basic auth; a token goes as is.
    const auth = cred.username && cred.source === 'credential' ? `Basic ${Buffer.from(`${cred.username}:${cred.token}`).toString('base64')}` : `token ${cred.token}`;
    this.http = new Http(fetch, apiBase('forgejo', host, scheme), { Authorization: auth, Accept: 'application/json', 'User-Agent': 'Nest' });
  }

  async whoami(): Promise<string> {
    return (await this.http.get('/user')).login;
  }

  async repo(path: string) {
    const r = await this.http.get(`/repos/${path}`);
    return { defaultBranch: r.default_branch, webUrl: r.html_url };
  }

  private async status(path: string, sha: string): Promise<Json | null> {
    try {
      return await this.http.get(`/repos/${path}/commits/${sha}/status`);
    } catch {
      return null;
    }
  }

  async listPulls(path: string, state: PullListState, head?: { branch: string; owner: string }): Promise<ForgePull[]> {
    const list: Json[] = await this.http.get(`/repos/${path}/pulls?state=${state}&sort=recentupdate&limit=${head ? 50 : LIST_LIMIT}`);
    const matching = head ? list.filter((p) => p.head?.ref === head.branch && (p.head?.repo?.owner?.login ?? head.owner).toLowerCase() === head.owner.toLowerCase()) : list;
    const pulls = matching.map((raw) => ({ pull: fjPull(raw), sha: raw.head?.sha as string | undefined }));
    await limited(
      pulls.filter((p) => p.pull.state === 'open' && p.sha).slice(0, LIST_CHECKS_LIMIT),
      async (p) => {
        const s = await this.status(path, p.sha!);
        p.pull.checks = s && s.total_count ? fjState(s.state) : null;
      },
    );
    return pulls.map((p) => p.pull);
  }

  async getPull(path: string, number: number): Promise<ForgePullDetail> {
    const pr = await this.http.get(`/repos/${path}/pulls/${number}`);
    const sha: string | null = pr.head?.sha ?? null;
    const optional = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const [status, reviews, comments] = await Promise.all([
      sha ? this.status(path, sha) : Promise.resolve(null),
      optional(this.http.get<Json[]>(`/repos/${path}/pulls/${number}/reviews`), []),
      optional(this.http.get<Json[]>(`/repos/${path}/issues/${number}/comments`), []),
    ]);
    const verdict = (s: string): ForgeComment['review'] => (s === 'APPROVED' ? 'approved' : s === 'REQUEST_CHANGES' ? 'changes-requested' : s === 'COMMENT' ? 'commented' : null);
    const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.state !== 'REQUEST_REVIEW' && !r.dismissed);
    const lineComments = (
      await limited(submitted.filter((r) => r.comments_count > 0).slice(0, 20), (r) => optional(this.http.get<Json[]>(`/repos/${path}/pulls/${number}/reviews/${r.id}/comments`), []))
    ).flat();
    const checkList: ForgeCheck[] = (status?.statuses ?? []).map((s: Json) => ({ id: `status:${s.id}`, name: s.context, state: fjState(s.status ?? s.state), url: s.target_url || null, hasLog: false }));
    const all: ForgeComment[] = [
      ...submitted
        .filter((r) => r.body || r.state !== 'COMMENT')
        .map((r) => ({ id: `review:${r.id}`, author: r.user?.login ?? '', body: r.body ?? '', createdAt: time(r.submitted_at), path: null, line: null, url: r.html_url ?? null, review: verdict(r.state) })),
      ...lineComments.map((c) => ({ id: `line:${c.id}`, author: c.user?.login ?? '', body: c.body ?? '', createdAt: time(c.created_at), path: c.path ?? null, line: c.position || c.original_position || null, url: c.html_url ?? null, review: null })),
      ...comments.map((c) => ({ id: `comment:${c.id}`, author: c.user?.login ?? '', body: c.body ?? '', createdAt: time(c.created_at), path: null, line: null, url: c.html_url ?? null, review: null })),
    ].sort(byTime);
    return {
      ...fjPull(pr),
      body: pr.body ?? '',
      headSha: sha,
      checks: rollUp(checkList.map((c) => c.state)),
      review: reviewVerdict(submitted.map((r) => ({ author: r.user?.login ?? '', verdict: verdict(r.state) }))),
      checkList,
      comments: all,
    };
  }

  async createPull(path: string, req: PullCreate): Promise<ForgePull> {
    const head = req.headPath === path ? req.head : `${req.headPath.split('/')[0]}:${req.head}`;
    const title = req.draft && !WIP.test(req.title) ? `WIP: ${req.title}` : req.title;
    return fjPull(await this.http.json('POST', `/repos/${path}/pulls`, { head, base: req.base, title, body: req.body }));
  }

  async comment(path: string, number: number, body: string): Promise<void> {
    await this.http.json('POST', `/repos/${path}/issues/${number}/comments`, { body });
  }

  async checkLog(): Promise<string> {
    throw new ForgeError('Forgejo and Gitea don’t offer check logs through their API. Open the check on the web.');
  }
}

export function makeClient(kind: ForgeKind, fetch: Fetch, host: string, cred: ForgeCredential, scheme: 'https' | 'http' = 'https'): ForgeClient {
  if (kind === 'github') return new GitHubClient(fetch, host, cred, scheme);
  if (kind === 'gitlab') return new GitLabClient(fetch, host, cred, scheme);
  return new ForgejoClient(fetch, host, cred, scheme);
}
