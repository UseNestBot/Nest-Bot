import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Loader2, MessageSquare, RefreshCw, ScrollText, Sparkles } from 'lucide-react';
import { FORGE_LABEL, type ForgeCheck, type ForgeCheckState, type ForgeComment, type ForgeLookup, type ForgeMergeMethod, type ForgePull, type ForgePullDetail, type GitRepoStatus, type GitScope } from '@shared/types';
import { api, IS_REMOTE } from '../api';
import { relativeTime } from '../format';
import { useStore } from '../store';
import { confirmDialog } from './confirm';
import { pullPrompt, useGitDraft } from './gitDrafts';
import { Markdown } from './Markdown';
import { Button, Field, IconButton, Modal, Segmented, Select, Toggle, Tooltip, cx, inputClass } from './ui';

/**
 * The forge repository behind a scope's working folder. Looked up again when
 * the branch or what it points at changes, and when sign-ins change.
 */
export function useForge(scope: GitScope, repo: GitRepoStatus): { lookup: ForgeLookup | null; loading: boolean; refresh: () => void } {
  const [lookup, setLookup] = useState<ForgeLookup | null>(null);
  const [loading, setLoading] = useState(false);
  const { kind, id } = scope;
  const key = `${repo.branch}|${repo.upstream}|${repo.head}|${repo.ahead}|${repo.remotes.map((r) => r.url).join(',')}`;
  const load = useCallback(() => {
    setLoading(true);
    void api
      .forgeLookup({ kind, id })
      .then(setLookup)
      .catch((e: Error) => setLookup({ repo: null, unknownHost: null, error: e.message }))
      .finally(() => setLoading(false));
  }, [kind, id]);
  useEffect(load, [load, key]);
  useEffect(() => api.onEvent((e) => e.type === 'forges-changed' && load()), [load]);
  return { lookup, loading, refresh: load };
}

/** The chat's agent, when a scope is a chat: who "Ask the agent" buttons talk to. */
export function useChatAgent(scope: GitScope): { name: string; busy: boolean; send: (text: string) => Promise<boolean> } | null {
  const { state, attempt } = useStore();
  if (scope.kind !== 'conversation') return null;
  const conversation = state.conversations.find((c) => c.id === scope.id);
  const agent = conversation && state.agents.find((a) => a.id === conversation.agentId);
  if (!conversation || !agent) return null;
  return {
    name: agent.name,
    busy: Boolean(state.running[scope.id]),
    send: async (text) => Boolean(await attempt(() => api.sendMessage(scope.id, text, []))),
  };
}

const CHECK_ICON: Record<ForgeCheckState, { icon: typeof CircleCheck; tone: string; label: string }> = {
  success: { icon: CircleCheck, tone: 'text-ok', label: 'Checks passed' },
  failure: { icon: CircleX, tone: 'text-bad', label: 'Checks failed' },
  pending: { icon: CircleDashed, tone: 'text-warn', label: 'Checks running' },
  neutral: { icon: CircleMinus, tone: 'text-faint', label: 'Checks finished' },
  skipped: { icon: CircleMinus, tone: 'text-faint', label: 'Checks skipped' },
};

export function ChecksIcon({ state, size = 14 }: { state: ForgeCheckState | null; size?: number }) {
  if (!state) return null;
  const { icon: Icon, tone, label } = CHECK_ICON[state];
  return (
    <Tooltip label={label}>
      <span className={cx('inline-flex shrink-0', tone)} aria-label={label}>
        <Icon size={size} className={cx(state === 'pending' && 'animate-[spin_3s_linear_infinite]')} />
      </span>
    </Tooltip>
  );
}

function PullIcon({ pull, size = 15 }: { pull: ForgePull; size?: number }) {
  if (pull.state === 'merged') return <GitMerge size={size} className="shrink-0 text-[#a66bd6]" />;
  if (pull.state === 'closed') return <GitPullRequestClosed size={size} className="shrink-0 text-bad" />;
  if (pull.draft) return <GitPullRequestDraft size={size} className="shrink-0 text-faint" />;
  return <GitPullRequest size={size} className="shrink-0 text-ok" />;
}

function ReviewBadge({ review }: { review: ForgePull['review'] }) {
  if (!review) return null;
  return <span className={cx('shrink-0 rounded px-1 text-[10.5px] font-medium', review === 'approved' ? 'bg-ok/15 text-ok' : 'bg-bad/15 text-bad')}>{review === 'approved' ? 'Approved' : 'Changes requested'}</span>;
}

/** Why there's nothing to show, with the way out. */
export function ForgeNotice({ lookup }: { lookup: ForgeLookup }) {
  const { navigate } = useStore();
  const settings = !IS_REMOTE && (
    <button className="text-accent hover:underline" onClick={() => navigate({ name: 'settings', section: 'git' })}>
      Settings → Git & forges
    </button>
  );
  if (!lookup.repo) {
    return (
      <p className="rounded-xl bg-sunken px-3 py-2 text-[12.5px] text-muted">
        {lookup.unknownHost ? (
          <>
            Nest doesn’t know what kind of forge {lookup.unknownHost} is. {IS_REMOTE ? 'Add it in Nest on your PC.' : <>Add it in {settings}.</>}
          </>
        ) : (
          'This repository has no remote on GitHub, GitLab or Forgejo.'
        )}
      </p>
    );
  }
  const { account } = lookup.repo;
  if (account.state !== 'ready') {
    return (
      <p className="rounded-xl bg-sunken px-3 py-2 text-[12.5px] text-muted">
        {account.error ?? `Nest isn’t signed in to ${FORGE_LABEL[account.kind]} at ${account.host}.`} {IS_REMOTE ? 'Sign in from Nest on your PC.' : <>Sign in from {settings}.</>}
      </p>
    );
  }
  return lookup.error ? <p className="rounded-xl border border-warn-line bg-warn-bg px-3 py-2 text-[12.5px] text-warn-ink">{lookup.error}</p> : null;
}

/**
 * Under the branch row: the current branch's pull request, or a button to
 * open one when the branch could have one.
 */
export function CurrentPull({ repo, lookup, onCreate, onOpen }: { repo: GitRepoStatus; lookup: ForgeLookup | null; onCreate: () => void; onOpen: (n: number) => void }) {
  const forge = lookup?.repo;
  if (!forge || forge.account.state !== 'ready') return null;
  if (forge.current) {
    const p = forge.current;
    return (
      <button onClick={() => onOpen(p.number)} className="flex w-full items-center gap-2 rounded-xl border border-line px-3 py-2 text-left hover:bg-hover">
        <PullIcon pull={p} />
        <span className="min-w-0 flex-1 truncate text-[13px]">
          <span className="text-muted">#{p.number}</span> {p.title}
        </span>
        <ReviewBadge review={p.review} />
        <ChecksIcon state={p.checks} />
      </button>
    );
  }
  const canOpen = !IS_REMOTE && repo.branch && repo.head && forge.defaultBranch && repo.branch !== forge.defaultBranch;
  if (!canOpen) return null;
  return (
    <Button className="w-full" onClick={onCreate}>
      <GitPullRequest size={14} /> {repo.upstream && repo.ahead === 0 ? 'Create pull request' : 'Push and create pull request'}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// The list

export function GitPulls({ scope, repo, lookup, onRefreshLookup, onCreate }: { scope: GitScope; repo: GitRepoStatus; lookup: ForgeLookup | null; onRefreshLookup: () => void; onCreate: () => void }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [pulls, setPulls] = useState<ForgePull[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const { kind, id } = scope;
  const ready = lookup?.repo?.account.state === 'ready' && !lookup.error;

  const load = useCallback(() => {
    if (!ready) return;
    setLoading(true);
    void api
      .forgeListPulls({ kind, id }, state)
      .then((list) => {
        setPulls(list);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kind, id, state, ready]);
  useEffect(() => {
    setPulls(null);
    load();
  }, [load]);

  if (!lookup) {
    return (
      <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
        <Loader2 size={14} className="animate-spin" /> Looking for the repository’s forge…
      </div>
    );
  }
  const forge = lookup.repo;
  return (
    <div className="space-y-3">
      <ForgeNotice lookup={lookup} />
      {forge && ready && (
        <>
          <div className="flex items-center gap-1">
            <Segmented
              value={state}
              onChange={setState}
              options={[
                { value: 'open', label: 'Open' },
                { value: 'closed', label: 'Closed' },
              ]}
            />
            <div className="flex-1" />
            <IconButton
              label="Refresh"
              onClick={() => {
                onRefreshLookup();
                load();
              }}
            >
              <RefreshCw size={15} strokeWidth={1.8} className={cx(loading && 'animate-spin')} />
            </IconButton>
            {!IS_REMOTE && (
              <IconButton label={`Open on ${FORGE_LABEL[forge.kind]}`} onClick={() => void api.openExternal(forge.webUrl)}>
                <ExternalLink size={15} strokeWidth={1.8} />
              </IconButton>
            )}
          </div>
          <CurrentPull repo={repo} lookup={lookup} onCreate={onCreate} onOpen={setOpen} />
          {error && <p className="text-[13px] text-bad-ink">{error}</p>}
          {!pulls && !error && (
            <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading pull requests…
            </div>
          )}
          {pulls && pulls.length === 0 && <p className="py-4 text-center text-[13px] text-muted">No {state} pull requests.</p>}
          {pulls && pulls.length > 0 && (
            <ul className="-mx-1">
              {pulls.map((p) => (
                <li key={p.number}>
                  <button onClick={() => setOpen(p.number)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                    <span className="mt-0.5">
                      <PullIcon pull={p} size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] text-ink">{p.title}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-faint">
                        #{p.number} · {p.author} · {relativeTime(p.updatedAt)}
                        <ReviewBadge review={p.review} />
                      </span>
                    </span>
                    <span className="mt-0.5">
                      <ChecksIcon state={p.checks} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {open !== null && (
        <PullDialog
          scope={scope}
          number={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            load();
            onRefreshLookup();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One pull request

/** What to tell the agent when asking it to address a review. */
export function reviewPrompt(pr: ForgePullDetail): string {
  const notes = pr.comments.filter((c) => c.body.trim() || c.review === 'changes-requested');
  const lines = [`Please address the review on pull request #${pr.number} “${pr.title}” (${pr.url}). Its branch is ${pr.head}, into ${pr.base}.`, '', 'Review comments:'];
  for (const c of notes) lines.push(`- ${c.author}${c.review === 'changes-requested' ? ' (requested changes)' : ''}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.trim().replace(/\n+/g, ' ') || '(no text)'}`);
  lines.push('', `Make the changes on ${pr.head} (switch to it first if you’re on another branch) and commit them. Say which comments you addressed and which you didn’t, and why. You can read the whole thread with get_pull_request.`);
  return lines.join('\n');
}

/** What to tell the agent when asking it to fix failing checks. */
export function checksPrompt(pr: ForgePullDetail): string {
  const failed = pr.checkList.filter((c) => c.state === 'failure');
  const lines = [`These checks failed on pull request #${pr.number} “${pr.title}” (${pr.url}), branch ${pr.head}:`];
  for (const c of failed) lines.push(`- ${c.name} (check id ${c.id}${c.url ? `, ${c.url}` : ''})`);
  lines.push('', `${failed.some((c) => c.hasLog) ? 'Read their logs with get_check_log, f' : 'F'}ind the cause, fix it on ${pr.head} (switch to it first if you’re on another branch) and commit the fix.`);
  return lines.join('\n');
}

export function PullDialog({ scope, number, onClose, onChanged }: { scope: GitScope; number: number; onClose: () => void; onChanged?: () => void }) {
  const { attempt } = useStore();
  const agent = useChatAgent(scope);
  const [pr, setPr] = useState<ForgePullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [log, setLog] = useState<{ check: ForgeCheck; text: string | null } | null>(null);
  const { kind, id } = scope;
  const load = useCallback(() => {
    void api
      .forgeGetPull({ kind, id }, number)
      .then((p) => {
        setPr(p);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [kind, id, number]);
  useEffect(load, [load]);

  const showLog = (check: ForgeCheck) => {
    if (log?.check.id === check.id) return setLog(null);
    setLog({ check, text: null });
    void api
      .forgeCheckLog({ kind, id }, check.id)
      .then((text) => setLog((cur) => (cur?.check.id === check.id ? { check, text } : cur)))
      .catch((e: Error) => setLog((cur) => (cur?.check.id === check.id ? { check, text: e.message } : cur)));
  };
  const post = async () => {
    setPosting(true);
    const ok = await attempt(async () => {
      await api.forgeComment({ kind, id }, number, comment);
      return true;
    });
    setPosting(false);
    if (ok) {
      setComment('');
      load();
    }
  };
  const ask = async (text: string) => {
    if (agent && (await agent.send(text))) onClose();
  };
  const checkout = async () => {
    if (!pr) return;
    const branches = await attempt(() => api.gitBranches({ kind, id }));
    if (!branches) return;
    const local = branches.find((b) => !b.remote && b.name === pr.head);
    const remote = branches.find((b) => b.remote && b.name.endsWith(`/${pr.head}`));
    const target = local?.name ?? remote?.name;
    if (!target) return void attempt(() => Promise.reject(new Error(`There’s no ${pr.head} branch here yet. Fetch, then try again.`)));
    if (await attempt(() => api.gitCheckout({ kind, id }, target).then(() => true))) onClose();
  };

  const failing = pr?.checkList.filter((c) => c.state === 'failure') ?? [];
  const feedback = pr?.comments.filter((c) => c.body.trim() || c.review === 'changes-requested') ?? [];
  return (
    <Modal title={pr ? pr.title : `Pull request #${number}`} onClose={onClose} width={860}>
      {error && <p className="mb-2 text-[13px] text-bad-ink">{error}</p>}
      {!pr && !error && (
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading pull request…
        </div>
      )}
      {pr && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
            <PullIcon pull={pr} size={14} />
            <span>
              #{pr.number} · {pr.state === 'open' ? (pr.draft ? 'Draft' : 'Open') : pr.state === 'merged' ? 'Merged' : 'Closed'} · {pr.author} wants to merge <span className="font-mono text-[11.5px] text-ink-2">{pr.head}</span> into <span className="font-mono text-[11.5px] text-ink-2">{pr.base}</span>
            </span>
            <ReviewBadge review={pr.review} />
            <div className="flex-1" />
            {!IS_REMOTE && pr.state === 'open' && (
              <Button size="sm" variant="ghost" onClick={() => void checkout()}>
                <GitBranch size={13} /> Check out
              </Button>
            )}
            {!IS_REMOTE && (
              <Button size="sm" variant="ghost" onClick={() => void api.openExternal(pr.url)}>
                Open <ExternalLink size={12} />
              </Button>
            )}
          </div>

          {agent && pr.state === 'open' && (failing.length > 0 || feedback.length > 0) && (
            <div className="flex flex-wrap gap-2">
              {feedback.length > 0 && (
                <Button size="sm" disabled={agent.busy} onClick={() => void ask(reviewPrompt(pr))} title={agent.busy ? `${agent.name} is busy` : undefined}>
                  <Sparkles size={13} /> Ask {agent.name} to address the review
                </Button>
              )}
              {failing.length > 0 && (
                <Button size="sm" disabled={agent.busy} onClick={() => void ask(checksPrompt(pr))} title={agent.busy ? `${agent.name} is busy` : undefined}>
                  <Sparkles size={13} /> Ask {agent.name} to fix the failing checks
                </Button>
              )}
            </div>
          )}

          {!IS_REMOTE && pr.state === 'open' && (
            <MergeBox
              scope={scope}
              pr={pr}
              onMerged={() => {
                load();
                onChanged?.();
              }}
            />
          )}

          <section>
            {pr.body.trim() ? <Markdown text={pr.body} className="text-[13px]" /> : <p className="text-[13px] italic text-faint">No description.</p>}
          </section>

          {pr.checkList.length > 0 && (
            <section>
              <h3 className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-faint">
                Checks <ChecksIcon state={pr.checks} size={13} />
              </h3>
              <ul className="rounded-xl border border-line">
                {pr.checkList.map((c) => (
                  <li key={c.id} className="border-b border-line last:border-0">
                    <div className="flex items-center gap-2 px-3 py-1.5">
                      <ChecksIcon state={c.state} size={13} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{c.name}</span>
                      {c.hasLog && (
                        <Button size="sm" variant="ghost" onClick={() => showLog(c)}>
                          <ScrollText size={12} /> {log?.check.id === c.id ? 'Hide log' : 'Log'}
                        </Button>
                      )}
                      {c.url && !IS_REMOTE && (
                        <IconButton label="Open the check" onClick={() => void api.openExternal(c.url!)} className="h-6! w-6!">
                          <ExternalLink size={12} />
                        </IconButton>
                      )}
                    </div>
                    {log?.check.id === c.id && (
                      <pre className="max-h-[320px] overflow-auto border-t border-line bg-sunken px-3 py-2 font-mono text-[11px] leading-[1.5] text-ink-2">
                        {log.text === null ? 'Loading the log…' : log.text.split('\n').slice(-400).join('\n') || '(empty)'}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <h3 className="mb-1 text-[12px] font-medium text-faint">
              Conversation <span className="font-normal">{pr.comments.length}</span>
            </h3>
            {pr.comments.length === 0 && <p className="text-[13px] text-muted">No reviews or comments yet.</p>}
            <ul className="space-y-2">
              {pr.comments.map((c) => (
                <CommentItem key={c.id} c={c} />
              ))}
            </ul>
            {!IS_REMOTE && pr.state !== 'merged' && (
              <div className="mt-3">
                <textarea className={cx(inputClass, 'min-h-[72px] resize-y font-[inherit]')} placeholder="Leave a comment (Markdown)" value={comment} onChange={(e) => setComment(e.target.value)} />
                <div className="mt-2 flex justify-end">
                  <Button variant="primary" size="sm" disabled={!comment.trim() || posting} onClick={() => void post()}>
                    {posting ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />} Comment
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

const METHOD_LABEL: Record<ForgeMergeMethod, string> = { merge: 'Create a merge commit', squash: 'Squash and merge', rebase: 'Rebase and merge' };

/** Merge it on the forge, after asking: a merge is shared with everyone and hard to take back. */
function MergeBox({ scope, pr, onMerged }: { scope: GitScope; pr: ForgePullDetail; onMerged: () => void }) {
  const { attempt, toast } = useStore();
  const [method, setMethod] = useState<ForgeMergeMethod>(pr.mergeMethods[0] ?? 'merge');
  const [deleteBranch, setDeleteBranch] = useState(pr.sameRepo);
  const [busy, setBusy] = useState(false);
  const merge = async () => {
    const ok = await confirmDialog({
      title: `${METHOD_LABEL[method]} #${pr.number}?`,
      message: `${pr.head} goes into ${pr.base} on the forge${deleteBranch && pr.sameRepo ? `, then ${pr.head} is deleted there` : ''}. Everyone with access sees it, and it can’t simply be undone.`,
      confirmLabel: method === 'squash' ? 'Squash and merge' : method === 'rebase' ? 'Rebase and merge' : 'Merge',
    });
    if (!ok) return;
    setBusy(true);
    const done = await attempt(() => api.forgeMergePull(scope, pr.number, method, deleteBranch && pr.sameRepo).then(() => true));
    setBusy(false);
    if (done) {
      toast(`Merged #${pr.number} into ${pr.base}.`, 'info');
      onMerged();
    }
  };
  return (
    <div className={cx('rounded-xl border px-3 py-2.5', pr.mergeable === false ? 'border-warn-line bg-warn-bg' : 'border-line')}>
      <p className={cx('mb-2 text-[12.5px]', pr.mergeable === false ? 'text-warn-ink' : 'text-muted')}>
        {pr.mergeBlocker ?? (pr.mergeable === null ? 'The forge is still working out whether this can merge.' : pr.checks === 'failure' ? 'It can merge, but some checks failed.' : 'Ready to merge.')}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select<ForgeMergeMethod> label="How to merge" value={method} onChange={setMethod} options={pr.mergeMethods.map((m) => ({ value: m, label: METHOD_LABEL[m] }))} />
        {pr.sameRepo && (
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Toggle checked={deleteBranch} onChange={setDeleteBranch} label="Delete the branch after merging" /> Delete {pr.head}
          </label>
        )}
        <div className="flex-1" />
        <Button variant="primary" size="sm" disabled={busy || pr.mergeable === false} onClick={() => void merge()}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <GitMerge size={13} />} {method === 'squash' ? 'Squash and merge' : method === 'rebase' ? 'Rebase and merge' : 'Merge'}
        </Button>
      </div>
    </div>
  );
}

function CommentItem({ c }: { c: ForgeComment }) {
  return (
    <li className="rounded-xl border border-line px-3 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
        <span className="font-medium text-ink">{c.author}</span>
        {c.review === 'approved' && <span className="rounded bg-ok/15 px-1 text-[10.5px] font-medium text-ok">Approved</span>}
        {c.review === 'changes-requested' && <span className="rounded bg-bad/15 px-1 text-[10.5px] font-medium text-bad">Requested changes</span>}
        {c.path && (
          <span className="font-mono text-[11px] text-ink-2">
            {c.path}
            {c.line ? `:${c.line}` : ''}
          </span>
        )}
        <span className="text-faint">{relativeTime(c.createdAt)}</span>
      </div>
      {c.body.trim() ? <Markdown text={c.body} className="text-[13px]" /> : <p className="text-[12.5px] italic text-faint">{c.review === 'approved' ? 'Approved these changes.' : 'No text.'}</p>}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Opening one

export function CreatePullDialog({ scope, repo, lookup, onClose, onCreated }: { scope: GitScope; repo: GitRepoStatus; lookup: ForgeLookup; onClose: () => void; onCreated: (p: ForgePull) => void }) {
  const { attempt } = useStore();
  const agent = useChatAgent(scope);
  const [draft, clearDraft] = useGitDraft(scope.kind === 'conversation' ? scope.id : null, 'pull-request');
  const forge = lookup.repo!;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [base, setBase] = useState('');
  const [isDraft, setIsDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);

  // An agent's draft fills the form (it may arrive while the dialog is open).
  useEffect(() => {
    if (!draft) return;
    setTitle(draft.title);
    setBody(draft.body);
    if (draft.base) setBase(draft.base);
    setAsked(false);
    clearDraft();
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!agent?.busy) setAsked(false);
  }, [agent?.busy]);

  const into = base.trim() || forge.defaultBranch || 'main';
  const needsPush = !repo.upstream || repo.ahead > 0;
  const submit = async () => {
    setBusy(true);
    const pull = await attempt(() => api.forgeCreatePull(scope, { title, body, base: base.trim(), draft: isDraft }));
    setBusy(false);
    if (pull) {
      onCreated(pull);
      onClose();
    }
  };
  const write = async () => {
    if (!agent || !repo.branch) return;
    if (await agent.send(pullPrompt(repo.branch, into))) setAsked(true);
  };

  return (
    <Modal
      title={`Pull request into ${forge.path}`}
      onClose={onClose}
      width={720}
      footer={
        <>
          {agent && (
            <Button variant="ghost" disabled={agent.busy || asked} onClick={() => void write()} className="mr-auto">
              {asked ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} {asked ? `${agent.name} is writing it…` : `Write it with ${agent.name}`}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <GitPullRequest size={14} />} {needsPush ? 'Push and open' : 'Open pull request'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-[12.5px] text-muted">
          <span className="font-mono text-[12px] text-ink-2">{repo.branch}</span> into <span className="font-mono text-[12px] text-ink-2">{into}</span> on {FORGE_LABEL[forge.kind]}.{' '}
          {needsPush && `Nest pushes ${repo.branch} first${repo.upstream ? ` (${repo.ahead} new commit${repo.ahead === 1 ? '' : 's'})` : ''}.`}
        </p>
        <Field label="Title">
          <input autoFocus className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What this changes, in a few words" />
        </Field>
        <Field label="Description" hint="Markdown.">
          <textarea className={cx(inputClass, 'min-h-[200px] resize-y font-[inherit]')} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What changes and why, and how you tested it." />
        </Field>
        <div className="flex items-end gap-4">
          <div className="flex-1">
            <Field label="Merge into">
              <input className={inputClass} value={base} onChange={(e) => setBase(e.target.value)} placeholder={forge.defaultBranch ?? 'main'} />
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-[13px]">
            <Toggle checked={isDraft} onChange={setIsDraft} label="Draft" /> Draft
          </label>
        </div>
      </div>
    </Modal>
  );
}
