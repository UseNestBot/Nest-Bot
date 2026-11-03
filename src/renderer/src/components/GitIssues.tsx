import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleDot, ExternalLink, FolderGit2, Loader2, MessageSquare, Plus, RefreshCw, Sparkles } from 'lucide-react';
import { FORGE_LABEL, type ForgeComment, type ForgeIssue, type ForgeIssueDetail, type ForgeLookup, type GitScope } from '@shared/types';
import { api, IS_REMOTE } from '../api';
import { relativeTime } from '../format';
import { useStore } from '../store';
import { ForgeNotice, useChatAgent } from './GitPulls';
import { Markdown } from './Markdown';
import { Button, Field, IconButton, Modal, Segmented, cx, inputClass } from './ui';

/** The repository's issues on its forge. */
export function GitIssues({ scope, lookup }: { scope: GitScope; lookup: ForgeLookup | null }) {
  const [state, setState] = useState<'open' | 'closed'>('open');
  const [issues, setIssues] = useState<ForgeIssue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const { kind, id } = scope;
  const ready = lookup?.repo?.account.state === 'ready' && !lookup.error;

  const load = useCallback(() => {
    if (!ready) return;
    setLoading(true);
    void api
      .forgeListIssues({ kind, id }, state)
      .then((list) => {
        setIssues(list);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kind, id, state, ready]);
  useEffect(() => {
    setIssues(null);
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
            <IconButton label="Refresh" onClick={load}>
              <RefreshCw size={15} strokeWidth={1.8} className={cx(loading && 'animate-spin')} />
            </IconButton>
            {!IS_REMOTE && (
              <>
                <IconButton label="New issue" onClick={() => setCreating(true)}>
                  <Plus size={15} strokeWidth={1.8} />
                </IconButton>
                <IconButton label={`Open issues on ${FORGE_LABEL[forge.kind]}`} onClick={() => void api.openExternal(forge.kind === 'gitlab' ? `${forge.webUrl}/-/issues` : `${forge.webUrl}/issues`)}>
                  <ExternalLink size={15} strokeWidth={1.8} />
                </IconButton>
              </>
            )}
          </div>
          {error && <p className="text-[13px] text-bad-ink">{error}</p>}
          {!issues && !error && (
            <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading issues…
            </div>
          )}
          {issues && issues.length === 0 && <p className="py-4 text-center text-[13px] text-muted">No {state} issues.</p>}
          {issues && issues.length > 0 && (
            <ul className="-mx-1">
              {issues.map((i) => (
                <li key={i.number}>
                  <button onClick={() => setOpen(i.number)} className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover">
                    <span className="mt-0.5">{i.state === 'open' ? <CircleDot size={14} className="text-ok" /> : <CircleCheck size={14} className="text-[#a66bd6]" />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-[13px] text-ink">{i.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
                        #{i.number} · {i.author} · {relativeTime(i.updatedAt)}
                        {i.labels.slice(0, 3).map((l) => (
                          <span key={l} className="rounded bg-sunken px-1 text-[10.5px] text-muted">
                            {l}
                          </span>
                        ))}
                      </span>
                    </span>
                    {i.commentCount > 0 && (
                      <span className="mt-0.5 flex shrink-0 items-center gap-0.5 text-[11px] text-faint">
                        <MessageSquare size={11} /> {i.commentCount}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {open !== null && <IssueDialog scope={scope} number={open} onClose={() => setOpen(null)} />}
      {creating && (
        <NewIssueDialog
          scope={scope}
          onClose={() => setCreating(false)}
          onCreated={(i) => {
            load();
            setOpen(i.number);
          }}
        />
      )}
    </div>
  );
}

/** What to tell the agent when handing it an issue. */
export function issuePrompt(issue: ForgeIssueDetail, branch: string | null): string {
  const lines = [`Work on issue #${issue.number} “${issue.title}” (${issue.url}).`, '', issue.body.trim() || '(The issue has no description.)'];
  const comments = issue.comments.filter((c) => c.body.trim());
  if (comments.length) {
    lines.push('', 'Comments:');
    for (const c of comments) lines.push(`- ${c.author}: ${c.body.trim().replace(/\n+/g, ' ')}`);
  }
  lines.push(
    '',
    branch
      ? `You’re in your own worktree on the new branch ${branch}. Make the change there and commit it.`
      : `Create a branch for it first (for example ${issueBranch(issue)}), then make the change and commit it.`,
    'Say what you changed and anything left open. You can read the issue again with get_issue.',
  );
  return lines.join('\n');
}

/** A branch name for working on an issue: "issue-12-fix-the-thing". */
export function issueBranch(issue: Pick<ForgeIssue, 'number' | 'title'>): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `issue-${issue.number}${slug ? `-${slug}` : ''}`;
}

function IssueDialog({ scope, number, onClose }: { scope: GitScope; number: number; onClose: () => void }) {
  const { attempt } = useStore();
  const agent = useChatAgent(scope);
  const [issue, setIssue] = useState<ForgeIssueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const { kind, id } = scope;
  const load = useCallback(() => {
    void api
      .forgeGetIssue({ kind, id }, number)
      .then((i) => {
        setIssue(i);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [kind, id, number]);
  useEffect(load, [load]);

  const post = async () => {
    setBusy('comment');
    const ok = await attempt(() => api.forgeCommentIssue({ kind, id }, number, comment).then(() => true));
    setBusy(null);
    if (ok) {
      setComment('');
      load();
    }
  };
  const ask = async (inWorktree: boolean) => {
    if (!agent || !issue) return;
    setBusy(inWorktree ? 'worktree' : 'ask');
    let branch: string | null = null;
    if (inWorktree) {
      branch = issueBranch(issue);
      const made = await attempt(() => api.gitCreateWorktree(scope, branch!));
      if (!made) return setBusy(null);
    }
    const sent = await agent.send(issuePrompt(issue, branch));
    setBusy(null);
    if (sent) onClose();
  };

  return (
    <Modal title={issue ? issue.title : `Issue #${number}`} onClose={onClose} width={820}>
      {error && <p className="mb-2 text-[13px] text-bad-ink">{error}</p>}
      {!issue && !error && (
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading issue…
        </div>
      )}
      {issue && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted">
            {issue.state === 'open' ? <CircleDot size={14} className="text-ok" /> : <CircleCheck size={14} className="text-[#a66bd6]" />}
            <span>
              #{issue.number} · {issue.state === 'open' ? 'Open' : 'Closed'} · opened by {issue.author}
              {issue.assignees.length > 0 && ` · assigned to ${issue.assignees.join(', ')}`}
            </span>
            {issue.labels.map((l) => (
              <span key={l} className="rounded bg-sunken px-1.5 text-[11px] text-ink-2">
                {l}
              </span>
            ))}
            <div className="flex-1" />
            {!IS_REMOTE && (
              <Button size="sm" variant="ghost" onClick={() => void api.openExternal(issue.url)}>
                Open <ExternalLink size={12} />
              </Button>
            )}
          </div>

          {agent && issue.state === 'open' && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={agent.busy || Boolean(busy)} onClick={() => void ask(false)} title={agent.busy ? `${agent.name} is busy` : undefined}>
                {busy === 'ask' ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Ask {agent.name} to work on it
              </Button>
              {!IS_REMOTE && (
                <Button size="sm" variant="ghost" disabled={agent.busy || Boolean(busy)} onClick={() => void ask(true)} title={`Creates the branch ${issueBranch(issue)} in its own worktree and switches this chat to it`}>
                  {busy === 'worktree' ? <Loader2 size={13} className="animate-spin" /> : <FolderGit2 size={13} />} …in a new worktree
                </Button>
              )}
            </div>
          )}

          <section>{issue.body.trim() ? <Markdown text={issue.body} className="text-[13px]" /> : <p className="text-[13px] italic text-faint">No description.</p>}</section>

          <section>
            <h3 className="mb-1 text-[12px] font-medium text-faint">
              Comments <span className="font-normal">{issue.comments.length}</span>
            </h3>
            {issue.comments.length === 0 && <p className="text-[13px] text-muted">No comments yet.</p>}
            <ul className="space-y-2">
              {issue.comments.map((c) => (
                <IssueComment key={c.id} c={c} />
              ))}
            </ul>
            {!IS_REMOTE && (
              <div className="mt-3">
                <textarea className={cx(inputClass, 'min-h-[72px] resize-y font-[inherit]')} placeholder="Leave a comment (Markdown)" value={comment} onChange={(e) => setComment(e.target.value)} />
                <div className="mt-2 flex justify-end">
                  <Button variant="primary" size="sm" disabled={!comment.trim() || Boolean(busy)} onClick={() => void post()}>
                    {busy === 'comment' ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />} Comment
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

function IssueComment({ c }: { c: ForgeComment }) {
  return (
    <li className="rounded-xl border border-line px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-[12px] text-muted">
        <span className="font-medium text-ink">{c.author}</span>
        <span className="text-faint">{relativeTime(c.createdAt)}</span>
      </div>
      <Markdown text={c.body} className="text-[13px]" />
    </li>
  );
}

function NewIssueDialog({ scope, onClose, onCreated }: { scope: GitScope; onClose: () => void; onCreated: (i: ForgeIssue) => void }) {
  const { attempt } = useStore();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const issue = await attempt(() => api.forgeCreateIssue(scope, title, body));
    setBusy(false);
    if (issue) {
      onCreated(issue);
      onClose();
    }
  };
  return (
    <Modal
      title="New issue"
      onClose={onClose}
      width={640}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Open issue
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Title">
          <input autoFocus className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Description" hint="Markdown.">
          <textarea className={cx(inputClass, 'min-h-[160px] resize-y font-[inherit]')} value={body} onChange={(e) => setBody(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
