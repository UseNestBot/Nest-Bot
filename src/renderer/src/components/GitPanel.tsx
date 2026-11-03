import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, CloudDownload, FolderGit2, FolderMinus, GitBranch, Loader2, Minus, PanelRightClose, Plus, RefreshCw, Sparkles, Undo2, Upload } from 'lucide-react';
import type { GitBranch as Branch, GitDiff, GitFileChange, GitScope, GitStatus } from '@shared/types';
import { api, IS_REMOTE } from '../api';
import { useStore } from '../store';
import { confirmDialog } from './confirm';
import { GitHistory } from './GitHistory';
import { GitIssues } from './GitIssues';
import { CreatePullDialog, CurrentPull, GitPulls, PullDialog, useChatAgent, useForge } from './GitPulls';
import { commitPrompt, onGitDraft, useGitDraft } from './gitDrafts';
import { DiffText, LETTER, TONE } from './gitUi';
import { Button, EmptyState, Field, IconButton, MenuItem, MenuLabel, Modal, Popover, Segmented, Tooltip, cx, inputClass } from './ui';

/** Conversations whose git panel is open, kept across pane switches for this session. */
const openPanels = new Set<string>();

export function useGitPanel(conversationId: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => openPanels.has(conversationId));
  const set = useCallback(
    (v: boolean) => {
      if (v) openPanels.add(conversationId);
      else openPanels.delete(conversationId);
      setOpen(v);
    },
    [conversationId],
  );
  useEffect(() => setOpen(openPanels.has(conversationId)), [conversationId]);
  // The agent drafted a commit message or pull request: show it.
  useEffect(() => onGitDraft(conversationId, () => set(true)), [conversationId, set]);
  return [open, set];
}

type Tab = 'changes' | 'history' | 'pulls' | 'issues';
/** Each scope's last tab, for this session. */
const tabs = new Map<string, Tab>();

/** A chat's repository beside the transcript. */
export function GitPanel({ scope, floating, titlebar = true, onClose }: { scope: GitScope; floating?: boolean; titlebar?: boolean; onClose: () => void }) {
  return (
    <aside
      className={cx(
        'panel-in flex h-full w-[360px] max-w-full shrink-0 flex-col border-l border-line bg-canvas max-[1120px]:absolute max-[1120px]:inset-y-0 max-[1120px]:right-0 max-[1120px]:z-30 max-[1120px]:shadow-pop max-[640px]:w-full',
        floating && 'absolute inset-y-0 right-0 z-30 shadow-pop',
      )}
      aria-label="Source control"
    >
      <div className="app-drag flex h-14 shrink-0 items-center gap-1 border-b border-line pl-5 pr-3">
        <span className="flex-1 text-[14px] font-semibold">Source control</span>
        <IconButton label="Close source control" onClick={onClose}>
          <PanelRightClose size={17} strokeWidth={1.8} />
        </IconButton>
        {titlebar && <div className="titlebar-spacer" />}
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-4">
        <GitView scope={scope} />
      </div>
    </aside>
  );
}

/**
 * Keep a scope's git status fresh: on open, when the repository changes on
 * disk, after the chat's agent touches files, and when the window regains focus.
 */
function useGitStatus(scope: GitScope): { status: GitStatus | null; error: string | null; refresh: () => void } {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { kind, id } = scope;

  const load = useCallback(() => {
    void api
      .gitStatus({ kind, id })
      .then((s) => {
        root.current = s.repo?.root ?? null;
        setStatus(s);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [kind, id]);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 500);
  }, [load]);

  useEffect(() => {
    setStatus(null);
    load();
    const off = api.onEvent((e) => {
      if (e.type === 'git-changed' && (!root.current || e.root === root.current)) soon();
      else if (kind === 'conversation' && e.type === 'activity' && e.conversationId === id && e.activity.kind === 'file' && e.activity.status === 'done') soon();
      else if (kind === 'conversation' && e.type === 'terminal-state' && e.state.conversationId === id && !e.state.busy) soon();
      else if (kind === 'conversation' && e.type === 'conversation' && e.conversation.id === id) soon();
      else if (kind === 'project' && e.type === 'projects-changed') soon();
    });
    window.addEventListener('focus', soon);
    return () => {
      off();
      window.removeEventListener('focus', soon);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [kind, id, load, soon]);

  return { status, error, refresh: load };
}

/** The working folder's repository: branch, sync, changes and commit. Used by the chat panel and the project screen. */
export function GitView({ scope }: { scope: GitScope }) {
  const { status, error, refresh } = useGitStatus(scope);
  if (error && !status) return <p className="text-[13px] text-bad-ink">{error}</p>;
  if (!status) {
    return (
      <div className="flex items-center gap-2 py-6 text-[13px] text-muted">
        <Loader2 size={14} className="animate-spin" /> Reading the repository…
      </div>
    );
  }
  if (!status.git.available) {
    return (
      <EmptyState icon={<FolderGit2 size={28} />} title="Git isn’t installed">
        Nest uses your own git.{' '}
        {!IS_REMOTE && (
          <button className="text-accent hover:underline" onClick={() => void api.openExternal('https://git-scm.com/downloads')}>
            Install it
          </button>
        )}{' '}
        and restart Nest.
      </EmptyState>
    );
  }
  if (!status.repo) return <NoRepo scope={scope} folder={status.folder} onDone={refresh} />;
  return <Repo scope={scope} status={status} repo={status.repo} refresh={refresh} />;
}

// ---------------------------------------------------------------------------
// No repository yet

function NoRepo({ scope, folder, onDone }: { scope: GitScope; folder: string; onDone: () => void }) {
  const { state, attempt } = useStore();
  const [busy, setBusy] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    await attempt(fn);
    setBusy(false);
    onDone();
  };
  const useExisting = () =>
    run(async () => {
      const picked = await api.pickFolder();
      if (!picked) return;
      if (scope.kind === 'conversation') await api.updateConversation(scope.id, { workspace: picked });
      else {
        const project = state.projects.find((p) => p.id === scope.id);
        if (project) await api.updateProject(project.id, { name: project.name, brief: project.brief, color: project.color, workspace: picked });
      }
    });
  const owner = scope.kind === 'conversation' ? 'this chat' : 'this project';

  return (
    <div className="flex flex-col items-center px-2 pt-4 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-sunken text-ink-2">
        <FolderGit2 size={20} strokeWidth={1.8} />
      </span>
      <div className="mt-3 text-[14px] font-medium">No repository here</div>
      <div className="mt-1 max-w-full truncate font-mono text-[11px] text-faint" title={folder}>
        {folder}
      </div>
      {IS_REMOTE ? (
        <p className="mt-3 text-[13px] text-muted">Set one up from Nest on your PC.</p>
      ) : (
        <div className="mt-5 flex w-full flex-col gap-2">
          <Button disabled={busy} onClick={() => void run(() => api.gitInit(scope))}>
            <Plus size={14} /> Initialise git here
          </Button>
          <Button disabled={busy} onClick={() => setCloneOpen(true)}>
            <CloudDownload size={14} /> Clone a repository…
          </Button>
          <Button disabled={busy} onClick={() => void useExisting()}>
            <FolderGit2 size={14} /> Use an existing repository…
          </Button>
          <p className="mt-1 text-[12px] text-muted">Using another folder changes {owner}’s working folder.</p>
        </div>
      )}
      {cloneOpen && <CloneDialog scope={scope} onClose={() => setCloneOpen(false)} onDone={onDone} />}
    </div>
  );
}

function CloneDialog({ scope, onClose, onDone }: { scope: GitScope; onClose: () => void; onDone: () => void }) {
  const { attempt } = useStore();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const ok = await attempt(() => api.gitClone(scope, url.trim()));
    setBusy(false);
    if (ok) {
      onDone();
      onClose();
    }
  };
  return (
    <Modal
      title="Clone a repository"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!url.trim() || busy} onClick={() => void submit()}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Clone
          </Button>
        </>
      }
    >
      <Field label="Repository URL" hint="HTTPS or SSH, from GitHub, GitLab, Forgejo, Codeberg or anywhere else. If the folder isn’t empty, Nest clones into a new folder inside it and switches to that.">
        <input autoFocus className={inputClass} value={url} placeholder="https://codeberg.org/owner/repo.git" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && url.trim() && void submit()} />
      </Field>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// A repository


function Repo({ scope, status, repo, refresh }: { scope: GitScope; status: GitStatus; repo: NonNullable<GitStatus['repo']>; refresh: () => void }) {
  const { attempt } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [diff, setDiff] = useState<{ file: GitFileChange; staged: boolean } | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState<number | null>(null);
  const [asked, setAsked] = useState(false);
  const tabKey = `${scope.kind}:${scope.id}`;
  const [tab, setTabState] = useState<Tab>(() => tabs.get(tabKey) ?? 'changes');
  const setTab = (t: Tab) => {
    tabs.set(tabKey, t);
    setTabState(t);
  };
  const readOnly = IS_REMOTE;
  const agent = useChatAgent(scope);
  const forge = useForge(scope, repo);
  const chatId = scope.kind === 'conversation' ? scope.id : null;
  const [commitDraft, clearCommitDraft] = useGitDraft(chatId, 'commit');
  const [pullDraft] = useGitDraft(chatId, 'pull-request');

  // The agent's commit message goes in the box, for the user to read before committing.
  useEffect(() => {
    if (!commitDraft) return;
    setMessage(commitDraft.message);
    setAsked(false);
    setTabState('changes');
    clearCommitDraft();
  }, [commitDraft]); // eslint-disable-line react-hooks/exhaustive-deps
  // Its pull request opens the form, which picks the draft up.
  useEffect(() => {
    if (pullDraft && forge.lookup?.repo?.account.state === 'ready' && !readOnly) setCreateOpen(true);
  }, [pullDraft, forge.lookup, readOnly]);
  // Stop showing "writing…" once the agent's turn ends, drafted or not.
  useEffect(() => {
    if (!agent?.busy) setAsked(false);
  }, [agent?.busy]);

  const act = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    const result = await attempt(fn);
    setBusy(null);
    refresh();
    return result;
  };

  const staged = repo.files.filter((f) => f.staged && f.staged !== 'conflicted');
  const unstaged = repo.files.filter((f) => f.unstaged);
  const commitAll = staged.length === 0;
  const hasChanges = staged.length > 0 || unstaged.length > 0;
  const canCommit = Boolean(message.trim()) && hasChanges && !busy && !repo.operation;
  const commit = async () => {
    if (!canCommit) return;
    const hash = await act('commit', () => api.gitCommit(scope, message, commitAll));
    if (hash) setMessage('');
  };
  const writeMessage = async () => {
    if (agent && (await agent.send(commitPrompt(!commitAll)))) setAsked(true);
  };
  const discard = async (files: GitFileChange[]) => {
    const untracked = files.some((f) => f.unstaged === 'untracked');
    const ok = await confirmDialog({
      title: files.length === 1 ? `Discard changes to ${baseName(files[0].path)}?` : `Discard ${files.length} changes?`,
      message: untracked ? 'New files are deleted. This can’t be undone.' : 'Your unstaged edits are lost. This can’t be undone.',
      confirmLabel: 'Discard',
      tone: 'danger',
    });
    if (ok) await act('discard', () => api.gitDiscard(scope, files.map((f) => f.path)));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-1.5">
        <BranchPicker scope={scope} repo={repo} readOnly={readOnly} onChanged={refresh} />
        <div className="flex-1" />
        {(repo.ahead > 0 || repo.behind > 0) && (
          <Tooltip label={`${repo.ahead} to push, ${repo.behind} to pull`}>
            <span className="flex items-center gap-1.5 px-1 font-mono text-[11.5px] text-muted">
              {repo.behind > 0 && (
                <span className="flex items-center">
                  <ArrowDown size={11} />
                  {repo.behind}
                </span>
              )}
              {repo.ahead > 0 && (
                <span className="flex items-center">
                  <ArrowUp size={11} />
                  {repo.ahead}
                </span>
              )}
            </span>
          </Tooltip>
        )}
        {!readOnly && repo.remotes.length > 0 && (
          <>
            <IconButton label="Fetch" tip="Fetch from every remote" disabled={Boolean(busy)} onClick={() => void act('fetch', () => api.gitFetch(scope))}>
              <RefreshCw size={15} strokeWidth={1.8} className={cx(busy === 'fetch' && 'animate-spin')} />
            </IconButton>
            <IconButton label="Pull" tip={repo.upstream ? `Pull from ${repo.upstream} (fast-forward only)` : 'This branch has no upstream yet'} disabled={Boolean(busy) || !repo.upstream} onClick={() => void act('pull', () => api.gitPull(scope))}>
              {busy === 'pull' ? <Loader2 size={15} className="animate-spin" /> : <ArrowDown size={15} strokeWidth={1.8} />}
            </IconButton>
            <IconButton label="Push" tip={repo.upstream ? `Push to ${repo.upstream}` : 'Publish this branch'} disabled={Boolean(busy) || !repo.head || !repo.branch} onClick={() => void act('push', () => api.gitPush(scope))}>
              {busy === 'push' ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} strokeWidth={1.8} />}
            </IconButton>
          </>
        )}
      </div>

      {folderKey(repo.root) !== folderKey(status.folder) && (
        <p className="text-[12px] text-muted">
          The working folder is inside the repository at <span className="break-all font-mono text-[11px] text-ink-2">{repo.root}</span>.
        </p>
      )}
      {repo.worktreeOf && <WorktreeNote scope={scope} repo={repo} onDone={refresh} />}
      {repo.operation && (
        <div className="rounded-xl border border-warn-line bg-warn-bg px-3 py-2 text-[12.5px] text-warn-ink">
          A {repo.operation} is in progress. Finish or abort it in the terminal (git {repo.operation} --continue or --abort).
        </div>
      )}
      {repo.remotes.length === 0 && (
        <div className="rounded-xl bg-sunken px-3 py-2 text-[12.5px] text-muted">
          No remote yet, so there’s nowhere to push.{' '}
          {!readOnly && (
            <button className="text-accent hover:underline" onClick={() => setRemoteOpen(true)}>
              Add a remote
            </button>
          )}
        </div>
      )}

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'changes', label: hasChanges ? `Changes ${repo.files.length}${repo.truncated ? '+' : ''}` : 'Changes' },
          { value: 'history', label: 'History' },
          { value: 'pulls', label: forge.lookup?.repo?.kind === 'gitlab' ? 'MRs' : 'PRs' },
          { value: 'issues', label: 'Issues' },
        ]}
      />

      {tab === 'history' && <GitHistory scope={scope} version={`${repo.head}|${repo.branch}|${repo.upstream}|${repo.ahead}|${repo.behind}`} />}
      {tab === 'issues' && <GitIssues scope={scope} lookup={forge.lookup} />}
      {tab === 'pulls' && <GitPulls scope={scope} repo={repo} lookup={forge.lookup} onRefreshLookup={forge.refresh} onCreate={() => setCreateOpen(true)} />}

      {tab === 'changes' && (
        <>
          <CurrentPull repo={repo} lookup={forge.lookup} onCreate={() => setCreateOpen(true)} onOpen={setPullOpen} />
          {!readOnly && (
            <div>
              <textarea
                className={cx(inputClass, 'min-h-[64px] resize-y font-[inherit]')}
                placeholder={repo.branch ? `Message (commit on ${repo.branch})` : 'Commit message'}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void commit();
                  }
                }}
              />
              <div className="mt-2 flex gap-2">
                <Button variant="primary" className="flex-1" disabled={!canCommit} onClick={() => void commit()}>
                  {busy === 'commit' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {commitAll && unstaged.length > 0 ? `Commit all ${unstaged.length} change${unstaged.length === 1 ? '' : 's'}` : 'Commit'}
                </Button>
                {agent && hasChanges && (
                  <IconButton
                    label={`Write the message with ${agent.name}`}
                    tip={asked ? `${agent.name} is writing the message…` : agent.busy ? `${agent.name} is busy` : `Write the message with ${agent.name}`}
                    disabled={agent.busy || asked}
                    onClick={() => void writeMessage()}
                    className="h-[34px]! w-[34px]! border border-line"
                  >
                    {asked ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} strokeWidth={1.8} />}
                  </IconButton>
                )}
              </div>
            </div>
          )}

          {repo.files.length === 0 ? (
            <p className="py-4 text-center text-[13px] text-muted">{repo.head ? 'No changes. Everything is committed.' : 'No commits yet. Add some files to get started.'}</p>
          ) : (
            <>
              {staged.length > 0 && (
                <FileGroup
                  title="Staged"
                  files={staged}
                  kind="staged"
                  readOnly={readOnly}
                  onOpen={(file) => setDiff({ file, staged: true })}
                  groupAction={!readOnly && <GroupButton label="Unstage all" onClick={() => void act('unstage', () => api.gitUnstage(scope, staged.map((f) => f.path)))} icon={<Minus size={13} />} />}
                  rowActions={(f) => <RowButton label="Unstage" onClick={() => void act('unstage', () => api.gitUnstage(scope, [f.path]))} icon={<Minus size={13} />} />}
                />
              )}
              {unstaged.length > 0 && (
                <FileGroup
                  title="Changes"
                  files={unstaged}
                  kind="unstaged"
                  readOnly={readOnly}
                  onOpen={(file) => setDiff({ file, staged: false })}
                  groupAction={
                    !readOnly && (
                      <>
                        <GroupButton label="Discard all" onClick={() => void discard(unstaged.filter((f) => f.unstaged !== 'conflicted'))} icon={<Undo2 size={13} />} />
                        <GroupButton label="Stage all" onClick={() => void act('stage', () => api.gitStage(scope, unstaged.map((f) => f.path)))} icon={<Plus size={13} />} />
                      </>
                    )
                  }
                  rowActions={(f) => (
                    <>
                      {f.unstaged !== 'conflicted' && <RowButton label="Discard changes" onClick={() => void discard([f])} icon={<Undo2 size={13} />} />}
                      <RowButton label={f.unstaged === 'conflicted' ? 'Mark resolved' : 'Stage'} onClick={() => void act('stage', () => api.gitStage(scope, [f.path]))} icon={<Plus size={13} />} />
                    </>
                  )}
                />
              )}
              {repo.truncated && <p className="text-[12px] text-faint">Showing the first {repo.files.length} changes.</p>}
            </>
          )}
        </>
      )}

      {diff && <DiffDialog scope={scope} file={diff.file} staged={diff.staged} onClose={() => setDiff(null)} />}
      {remoteOpen && <RemoteDialog scope={scope} onClose={() => setRemoteOpen(false)} onDone={refresh} />}
      {createOpen && forge.lookup?.repo && (
        <CreatePullDialog
          scope={scope}
          repo={repo}
          lookup={forge.lookup}
          onClose={() => setCreateOpen(false)}
          onCreated={(p) => {
            forge.refresh();
            refresh();
            setPullOpen(p.number);
          }}
        />
      )}
      {pullOpen !== null && (
        <PullDialog
          scope={scope}
          number={pullOpen}
          onClose={() => setPullOpen(null)}
          onChanged={() => {
            forge.refresh();
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** This chat works in a linked worktree: say where the main one is, and offer to go back. */
function WorktreeNote({ scope, repo, onDone }: { scope: GitScope; repo: NonNullable<GitStatus['repo']>; onDone: () => void }) {
  const { attempt } = useStore();
  const [busy, setBusy] = useState(false);
  const chat = scope.kind === 'conversation' && !IS_REMOTE;
  const remove = async () => {
    const ok = await confirmDialog({
      title: 'Remove this worktree?',
      message: `Its folder is deleted and the chat goes back to ${repo.worktreeOf}. The ${repo.branch ?? 'worktree’s'} branch and its commits are kept.`,
      confirmLabel: 'Remove worktree',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.gitRemoveWorktree(scope, false);
    } catch (err) {
      const message = (err as Error).message;
      if (!/uncommitted changes/.test(message)) await attempt(() => Promise.reject(err));
      else if (await confirmDialog({ title: 'The worktree has uncommitted changes', message: 'Remove it anyway? Those changes are lost.', confirmLabel: 'Remove and lose them', tone: 'danger' })) {
        await attempt(() => api.gitRemoveWorktree(scope, true));
      }
    }
    setBusy(false);
    onDone();
  };
  return (
    <div className="flex items-start gap-2 rounded-xl bg-sunken px-3 py-2 text-[12.5px] text-muted">
      <FolderGit2 size={14} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        A worktree of <span className="break-all font-mono text-[11px] text-ink-2">{repo.worktreeOf}</span>
        {chat ? ', just for this chat.' : '.'}
      </span>
      {chat && (
        <IconButton label="Remove this worktree" tip="Remove this worktree and go back to the main one" disabled={busy} onClick={() => void remove()} className="h-6! w-6!">
          {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderMinus size={13} />}
        </IconButton>
      )}
    </div>
  );
}

function FileGroup({
  title,
  files,
  kind,
  readOnly,
  onOpen,
  groupAction,
  rowActions,
}: {
  title: string;
  files: GitFileChange[];
  kind: 'staged' | 'unstaged';
  readOnly: boolean;
  onOpen: (f: GitFileChange) => void;
  groupAction?: ReactNode;
  rowActions: (f: GitFileChange) => ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-1 px-1">
        <span className="flex-1 text-[12px] font-medium text-faint">
          {title} <span className="font-normal">{files.length}</span>
        </span>
        {groupAction}
      </div>
      <ul>
        {files.map((f) => {
          const change = (kind === 'staged' ? f.staged : f.unstaged)!;
          const dir = dirName(f.path);
          return (
            <li key={f.path} className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-hover">
              <button onClick={() => onOpen(f)} className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                <span className="min-w-0 truncate text-[13px] text-ink">{baseName(f.path)}</span>
                {dir && <span className="min-w-0 shrink truncate text-[11.5px] text-faint">{dir}</span>}
              </button>
              {!readOnly && <span className="hidden shrink-0 items-center group-hover:flex">{rowActions(f)}</span>}
              <span className={cx('w-4 shrink-0 text-center font-mono text-[11.5px] font-semibold', TONE[change])} title={change}>
                {LETTER[change]}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RowButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: ReactNode }) {
  return (
    <IconButton label={label} onClick={onClick} className="h-6! w-6!">
      {icon}
    </IconButton>
  );
}

function GroupButton({ label, onClick, icon }: { label: string; onClick: () => void; icon: ReactNode }) {
  return (
    <IconButton label={label} onClick={onClick} className="h-6! w-6! text-faint">
      {icon}
    </IconButton>
  );
}

// ---------------------------------------------------------------------------
// Branches

function BranchPicker({ scope, repo, readOnly, onChanged }: { scope: GitScope; repo: NonNullable<GitStatus['repo']>; readOnly: boolean; onChanged: () => void }) {
  const { attempt } = useStore();
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [name, setName] = useState('');
  const label = repo.branch ?? (repo.head ? `detached at ${repo.head}` : 'no branch');
  const load = () => void api.gitBranches(scope).then(setBranches).catch(() => setBranches([]));
  const local = branches?.filter((b) => !b.remote) ?? [];
  // Remote branches that don't already have a local branch of the same name.
  const remote = branches?.filter((b) => b.remote && !local.some((l) => b.name.endsWith(`/${l.name}`))) ?? [];

  const switchTo = async (branch: string, close: () => void) => {
    close();
    await attempt(() => api.gitCheckout(scope, branch));
    onChanged();
  };
  const create = async (close: () => void, worktree = false) => {
    const clean = name.trim();
    if (!clean) return;
    close();
    const ok = await attempt(async () => {
      if (worktree) await api.gitCreateWorktree(scope, clean);
      else await api.gitCreateBranch(scope, clean);
      return true;
    });
    if (ok) setName('');
    onChanged();
  };

  return (
    <Popover
      width={300}
      trigger={({ toggle }) => (
        <button
          onClick={() => {
            if (!readOnly) load();
            toggle();
          }}
          className="flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] font-medium hover:bg-hover"
        >
          <GitBranch size={14} className="shrink-0 text-muted" />
          <span className="truncate">{label}</span>
          {!readOnly && <ChevronDown size={13} className="shrink-0 text-faint" />}
        </button>
      )}
    >
      {(close) =>
        readOnly ? (
          <p className="px-2.5 py-2 text-[12.5px] text-muted">Switch branches from Nest on your PC.</p>
        ) : (
          <>
            <div className="p-1">
              <input
                className={inputClass}
                placeholder="New branch name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void create(close)}
              />
              {name.trim() && (
                <>
                  <Button size="sm" className="mt-1.5 w-full" onClick={() => void create(close)}>
                    <Plus size={13} /> Create “{name.trim()}” from {repo.branch ?? 'here'}
                  </Button>
                  {scope.kind === 'conversation' && repo.head && (
                    <Tooltip label="A separate folder on the new branch, just for this chat, so its agent doesn’t touch other chats’ work.">
                      <Button size="sm" variant="ghost" className="mt-1 w-full" onClick={() => void create(close, true)}>
                        <FolderGit2 size={13} /> …in its own worktree for this chat
                      </Button>
                    </Tooltip>
                  )}
                </>
              )}
            </div>
            {!branches && (
              <div className="flex items-center gap-2 px-2.5 py-2 text-[12.5px] text-muted">
                <Loader2 size={13} className="animate-spin" /> Loading branches…
              </div>
            )}
            {local.length > 0 && <MenuLabel>Branches</MenuLabel>}
            {local.map((b) => (
              <MenuItem key={b.name} active={b.current} onClick={() => void (b.current ? close() : switchTo(b.name, close))} hint={b.current ? <Check size={13} /> : null}>
                <span className="truncate">{b.name}</span>
              </MenuItem>
            ))}
            {remote.length > 0 && <MenuLabel>Remote branches</MenuLabel>}
            {remote.map((b) => (
              <MenuItem key={b.name} onClick={() => void switchTo(b.name, close)}>
                <span className="truncate text-ink-2">{b.name}</span>
              </MenuItem>
            ))}
          </>
        )
      }
    </Popover>
  );
}

function RemoteDialog({ scope, onClose, onDone }: { scope: GitScope; onClose: () => void; onDone: () => void }) {
  const { attempt } = useStore();
  const [name, setName] = useState('origin');
  const [url, setUrl] = useState('');
  const submit = async () => {
    const ok = await attempt(async () => {
      await api.gitAddRemote(scope, name.trim(), url.trim());
      return true;
    });
    if (ok) {
      onDone();
      onClose();
    }
  };
  return (
    <Modal
      title="Add a remote"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim() || !url.trim()} onClick={() => void submit()}>
            Add remote
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="URL" hint="Create an empty repository on GitHub, GitLab or Forgejo first, then paste its HTTPS or SSH address.">
          <input autoFocus className={inputClass} value={url} placeholder="git@codeberg.org:owner/repo.git" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
        </Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Diffs

function DiffDialog({ scope, file, staged, onClose }: { scope: GitScope; file: GitFileChange; staged: boolean; onClose: () => void }) {
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { kind, id } = scope;
  useEffect(() => {
    void api
      .gitDiff({ kind, id }, file.path, staged)
      .then(setDiff)
      .catch((e: Error) => setError(e.message));
  }, [kind, id, file.path, staged]);
  return (
    <Modal title={`${file.path}${staged ? ' (staged)' : ''}`} onClose={onClose} width={960}>
      {error && <p className="text-[13px] text-bad-ink">{error}</p>}
      {!diff && !error && (
        <div className="flex items-center gap-2 py-4 text-[13px] text-muted">
          <Loader2 size={14} className="animate-spin" /> Loading diff…
        </div>
      )}
      {diff && (diff.binary ? <p className="text-[13px] text-muted">Binary file, no text diff.</p> : !diff.text.trim() ? <p className="text-[13px] text-muted">No textual changes (only file mode or whitespace).</p> : <DiffText text={diff.text} />)}
      {diff?.truncated && <p className="mt-2 text-[12px] text-faint">The diff is long, so only the start is shown.</p>}
    </Modal>
  );
}

function baseName(p: string): string {
  const parts = p.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] + (p.endsWith('/') ? '/' : '');
}

function dirName(p: string): string {
  const parts = p.replace(/\/$/, '').split('/');
  return parts.slice(0, -1).join('/');
}

/** Compare folders the way the OS does (Windows paths are case-insensitive, either slash). */
function folderKey(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(n) ? n.toLowerCase() : n;
}
