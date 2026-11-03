import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, CloudDownload, FolderGit2, GitBranch, Loader2, Minus, PanelRightClose, Plus, RefreshCw, Undo2, Upload } from 'lucide-react';
import type { GitBranch as Branch, GitChange, GitDiff, GitFileChange, GitScope, GitStatus } from '@shared/types';
import { api, IS_REMOTE } from '../api';
import { useStore } from '../store';
import { confirmDialog } from './confirm';
import { Button, EmptyState, Field, IconButton, MenuItem, MenuLabel, Modal, Popover, Tooltip, cx, inputClass } from './ui';

/** Conversations whose git panel is open, kept across pane switches for this session. */
const openPanels = new Set<string>();

export function useGitPanel(conversationId: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => openPanels.has(conversationId));
  useEffect(() => setOpen(openPanels.has(conversationId)), [conversationId]);
  const set = (v: boolean) => {
    if (v) openPanels.add(conversationId);
    else openPanels.delete(conversationId);
    setOpen(v);
  };
  return [open, set];
}

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

const LETTER: Record<GitChange, string> = { modified: 'M', typechange: 'T', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' };
const TONE: Record<GitChange, string> = { modified: 'text-warn', typechange: 'text-warn', added: 'text-ok', untracked: 'text-ok', deleted: 'text-bad', renamed: 'text-accent', copied: 'text-accent', conflicted: 'text-bad' };

function Repo({ scope, status, repo, refresh }: { scope: GitScope; status: GitStatus; repo: NonNullable<GitStatus['repo']>; refresh: () => void }) {
  const { attempt } = useStore();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [diff, setDiff] = useState<{ file: GitFileChange; staged: boolean } | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const readOnly = IS_REMOTE;

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
  const canCommit = Boolean(message.trim()) && (staged.length > 0 || unstaged.length > 0) && !busy && !repo.operation;
  const commit = async () => {
    if (!canCommit) return;
    const hash = await act('commit', () => api.gitCommit(scope, message, commitAll));
    if (hash) setMessage('');
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
          <Button variant="primary" className="mt-2 w-full" disabled={!canCommit} onClick={() => void commit()}>
            {busy === 'commit' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {commitAll && unstaged.length > 0 ? `Commit all ${unstaged.length} change${unstaged.length === 1 ? '' : 's'}` : 'Commit'}
          </Button>
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

      {diff && <DiffDialog scope={scope} file={diff.file} staged={diff.staged} onClose={() => setDiff(null)} />}
      {remoteOpen && <RemoteDialog scope={scope} onClose={() => setRemoteOpen(false)} onDone={refresh} />}
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
  const create = async (close: () => void) => {
    const clean = name.trim();
    if (!clean) return;
    close();
    const ok = await attempt(async () => {
      await api.gitCreateBranch(scope, clean);
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
                <Button size="sm" className="mt-1.5 w-full" onClick={() => void create(close)}>
                  <Plus size={13} /> Create “{name.trim()}” from {repo.branch ?? 'here'}
                </Button>
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

export function DiffText({ text }: { text: string }) {
  // Skip the header lines; the dialog title already names the file.
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  return (
    <pre className="overflow-x-auto rounded-xl bg-sunken py-2 font-mono text-[12px] leading-[1.55]">
      {(start >= 0 ? lines.slice(start) : lines).map((line, i) => (
        <div
          key={i}
          className={cx(
            'whitespace-pre px-3',
            line.startsWith('+') && 'bg-ok/15 text-ink',
            line.startsWith('-') && 'bg-bad/15 text-ink',
            line.startsWith('@@') && 'mt-1 text-accent first:mt-0',
            line.startsWith('\\') && 'text-faint',
            !/^[-+@\\]/.test(line) && 'text-ink-2',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
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
