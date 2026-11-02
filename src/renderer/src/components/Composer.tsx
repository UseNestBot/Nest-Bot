import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { AlertTriangle, ArrowUp, FileText, Image as ImageIcon, FolderOpen, Lock, Mic, Plus, Square, X } from 'lucide-react';
import { PROVIDER_LABEL, permissionStyle, resolveSkip, type Agent, type AppSettings, type Attachment, type Conversation, type PermissionSettings } from '@shared/types';
import { insertDictation } from '@shared/dictation';
import { IS_REMOTE, api } from '../api';
import { useStore } from '../store';
import { folderName } from '../format';
import { useDictation } from '../dictation/dictation';
import { DictationPill } from './DictationPill';
import { MenuItem, MenuLabel, Popover, Tooltip, cx } from './ui';
import { ModelPicker } from './ModelPicker';
import { confirmDialog } from './confirm';

/** Claude takes inline images up to 5 MB; larger pastes are re-encoded as JPEG below that. */
const MAX_INLINE_IMAGE_BYTES = 4.5 * 1024 * 1024;
const PASTE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

async function shrinkImage(blob: Blob): Promise<Blob> {
  if (blob.size <= MAX_INLINE_IMAGE_BYTES) return blob;
  const bitmap = await createImageBitmap(blob);
  let scale = 1;
  for (let i = 0; i < 6; i++) {
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });
    if (out.size <= MAX_INLINE_IMAGE_BYTES) return out;
    scale *= 0.75;
  }
  return blob;
}

/** A small data-URL preview; the page's CSP allows data: images but not blob: URLs. */
async function thumbnail(blob: Blob, size = 48): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const scale = size / Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(bitmap, (size - bitmap.width * scale) / 2, (size - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale);
  return canvas.toDataURL('image/png');
}

/** Holding the dictation shortcut at least this long means push-to-talk: releasing it inserts the text. */
const HOLD_TO_TALK_MS = 400;

const CLAUDE_MODES: Array<{ id: PermissionSettings['claudeMode']; label: string; hint: string }> = [
  { id: 'default', label: 'Ask before acting', hint: 'Edits and commands need approval' },
  { id: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits in the workspace run without asking' },
  { id: 'plan', label: 'Plan only', hint: 'Read and plan; no changes' },
];

const CODEX_MODES: Array<{ sandbox: PermissionSettings['codexSandbox']; approval: PermissionSettings['codexApproval']; label: string; hint: string }> = [
  { sandbox: 'workspace-write', approval: 'on-request', label: 'Workspace, ask when needed', hint: 'Sandboxed writes in the workspace' },
  { sandbox: 'workspace-write', approval: 'untrusted', label: 'Workspace, ask often', hint: 'Approval for anything not known-safe' },
  { sandbox: 'read-only', approval: 'on-request', label: 'Read only', hint: 'No file changes' },
];

/** Same rule the main process applies at run time: conversation → agent → global default. */
export function skipsPermissions(c: Conversation, agent: Agent | undefined, settings: AppSettings): boolean {
  return resolveSkip(c.permissions, agent?.permissions, settings);
}

export function permissionLabel(c: Conversation, skipping = false): string {
  if (permissionStyle(c.provider) === 'none') return 'Chat only';
  if (skipping) return 'Permissions skipped';
  if (permissionStyle(c.provider) === 'claude') return CLAUDE_MODES.find((m) => m.id === c.permissions.claudeMode)?.label ?? 'Ask before acting';
  return CODEX_MODES.find((m) => m.sandbox === c.permissions.codexSandbox && m.approval === c.permissions.codexApproval)?.label ?? 'Custom';
}

/** Ask a pane's composer to take keyboard focus (after a keyboard shortcut moved focus to that pane). */
export const FOCUS_COMPOSER_EVENT = 'nest:focus-composer';
export function focusComposer(conversationId: string): void {
  window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT, { detail: conversationId }));
}

/** active: the focused pane's composer. Only it takes focus on open and answers the dictation shortcut, so side-by-side chats don't all react. */
export function Composer({
  conversation,
  running,
  active = true,
  disabledReason,
  placeholder = 'Message',
}: {
  conversation: Conversation;
  running: boolean;
  active?: boolean;
  disabledReason: string | null;
  placeholder?: string;
}) {
  const { state, attempt, navigate, toast } = useStore();
  const allowSkip = state.settings.allowSkipPermissions;
  const agent = state.agents.find((a) => a.id === conversation.agentId);
  const skipping = skipsPermissions(conversation, agent, state.settings);
  const inheritedSkip = resolveSkip({ ...conversation.permissions, skipPermissions: undefined }, agent?.permissions, state.settings);
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null);
  // A chat in a project works in the project's folder unless it picked one of its own.
  const agentProject = state.projects.find((p) => p.id === conversation.projectId);
  const fallbackFolder = agentProject?.workspace ?? defaultFolder;
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Thumbnails for pasted images, keyed by saved path; picked files show an icon instead.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const draftKey = `nest:draft:${conversation.id}`;

  // Drafts are a per-device convenience only.
  useEffect(() => {
    try {
      setText(localStorage.getItem(draftKey) ?? '');
    } catch {
      setText('');
    }
    setAttachments([]);
    setPreviews({});
    if (activeRef.current) ref.current?.focus();
  }, [draftKey]);

  // A keyboard shortcut moved focus to this pane.
  useEffect(() => {
    const onFocus = (e: Event) => (e as CustomEvent<string>).detail === conversation.id && ref.current?.focus();
    window.addEventListener(FOCUS_COMPOSER_EVENT, onFocus);
    return () => window.removeEventListener(FOCUS_COMPOSER_EVENT, onFocus);
  }, [conversation.id]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);

  const updateText = (v: string) => {
    setText(v);
    try {
      if (v) localStorage.setItem(draftKey, v);
      else localStorage.removeItem(draftKey);
    } catch {
      /* ignore */
    }
  };

  const dictation = useDictation(
    state.settings.dictationModel,
    (spoken) => {
      const el = ref.current;
      const current = el?.value ?? text;
      const next = insertDictation(current, el?.selectionStart ?? current.length, el?.selectionEnd ?? current.length, spoken);
      updateText(next.value);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(next.caret, next.caret);
      });
    },
    (message) => toast(message),
  );
  const { cancel: cancelDictation } = dictation;

  // Dictation belongs to the conversation it started in.
  useEffect(() => cancelDictation, [draftKey, cancelDictation]);

  const toggleDictation = () => (dictation.state === 'recording' ? dictation.stop() : dictation.state === 'idle' ? void dictation.start() : undefined);
  const dictationRef = useRef({ dictation, toggle: toggleDictation });
  dictationRef.current = { dictation, toggle: toggleDictation };
  // Ctrl+Shift+Space: hold to talk and release to insert, or tap to start and tap again to stop.
  // While recording, Esc discards from anywhere in the window.
  useEffect(() => {
    let pressedAt = 0;
    let startedByPress = false;
    const onDown = (e: KeyboardEvent) => {
      const { dictation: d, toggle } = dictationRef.current;
      // A recording keeps listening for its own stop and Esc even if focus moved to another pane.
      if (!activeRef.current && d.state === 'idle') return;
      if (e.key === 'Escape' && d.state === 'recording') {
        e.preventDefault();
        d.cancel();
        return;
      }
      if (!(e.ctrlKey && e.shiftKey && e.code === 'Space')) return;
      e.preventDefault();
      if (e.repeat) return;
      pressedAt = Date.now();
      startedByPress = d.state === 'idle';
      toggle();
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !pressedAt) return;
      const held = Date.now() - pressedAt;
      pressedAt = 0;
      if (startedByPress && held >= HOLD_TO_TALK_MS) dictationRef.current.dictation.stop();
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  const canSend = !stopping && !sending && !disabledReason && dictation.state === 'idle' && (text.trim().length > 0 || attachments.length > 0);

  // While the agent works, sending steers it: the message reaches it at its next step.
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    const res = await attempt(() => (running ? api.steerRun(conversation.id, text, attachments) : api.sendMessage(conversation.id, text, attachments)));
    setSending(false);
    if (res) {
      updateText('');
      setAttachments([]);
    }
  };

  const stop = async () => {
    setStopping(true);
    await attempt(() => api.cancelRun(conversation.id));
  };

  const attach = async () => {
    const files = await attempt(() => api.pickFiles());
    if (files?.length) setAttachments((xs) => [...xs, ...files.filter((f) => !xs.some((x) => x.path === f.path))]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...e.clipboardData.files].filter((f) => PASTE_TYPES.includes(f.type));
    if (!images.length) return;
    // Screenshots arrive as files only; text copied alongside an image (e.g. from a web page) still pastes.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    for (const file of images) {
      void (async () => {
        const blob = await shrinkImage(file).catch(() => file);
        const saved = await attempt(async () => api.savePastedImage(new Uint8Array(await blob.arrayBuffer()), blob.type));
        if (!saved) return;
        setAttachments((xs) => [...xs, saved]);
        const preview = await thumbnail(blob).catch(() => null);
        if (preview) setPreviews((xs) => ({ ...xs, [saved.path]: preview }));
      })();
    }
  };

  const setPermissions = (permissions: PermissionSettings) => void attempt(() => api.updateConversation(conversation.id, { permissions }));

  return (
    <div className="chat-column relative px-5 pb-4 max-[640px]:px-2.5 max-[640px]:pb-[max(10px,env(safe-area-inset-bottom))]">
      <DictationPill dictation={dictation} />
      <div className="rounded-[26px] border border-line bg-panel shadow-float transition-colors focus-within:border-line-strong">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {attachments.map((a) => (
              <Tooltip key={a.path} label={a.path}>
                <span className="inline-flex max-w-[240px] items-center gap-1.5 rounded-xl bg-sunken py-1 pl-2 pr-1.5 text-[12.5px] text-ink-2">
                  {previews[a.path] ? (
                    <img src={previews[a.path]} alt="" className="h-6 w-6 shrink-0 rounded-md object-cover" />
                  ) : a.isImage ? (
                    <ImageIcon size={13} className="shrink-0 text-muted" />
                  ) : (
                    <FileText size={13} className="shrink-0 text-muted" />
                  )}
                  <span className="truncate">{a.name}</span>
                  <button onClick={() => setAttachments((xs) => xs.filter((x) => x.path !== a.path))} aria-label={`Remove ${a.name}`} className="rounded-full p-0.5 text-faint hover:bg-hover hover:text-ink">
                    <X size={12} />
                  </button>
                </span>
              </Tooltip>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 p-1.5 max-[640px]:gap-1">
          <Tooltip label="Attach files">
            <button onClick={attach} className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line text-ink-2 transition-colors hover:bg-hover hover:text-ink" aria-label="Attach files">
              <Plus size={18} strokeWidth={1.8} />
            </button>
          </Tooltip>
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => updateText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={(e) => {
              // Esc while recording is handled window-wide above; Enter inserts what was said.
              if (e.key === 'Enter' && dictation.state === 'recording') {
                e.preventDefault();
                dictation.stop();
                return;
              }
              const ctrlToSend = state.settings.sendKey === 'ctrl-enter';
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (ctrlToSend ? e.ctrlKey || e.metaKey : !e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={disabledReason ?? (running ? 'Steer while it works…' : placeholder)}
            aria-label="Message"
            className="scroll-quiet block max-h-[280px] min-h-[36px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[15px] leading-[22px] text-ink outline-none placeholder:text-faint"
          />
          {/* Whisper weights come from the PC's nest-models:// scheme; phones have their own dictation key. */}
          {!IS_REMOTE && (
          <Tooltip label={dictation.state === 'recording' ? 'Stop and insert the text' : 'Dictate: hold to talk, or tap it'} keys="Ctrl+Shift+Space">
            <button
              onClick={toggleDictation}
              disabled={dictation.state === 'transcribing'}
              className={cx(
                'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60',
                dictation.state === 'recording' ? 'bg-bad text-white' : 'text-ink-2 hover:bg-hover hover:text-ink',
              )}
              aria-label={dictation.state === 'recording' ? 'Stop dictation' : 'Dictate'}
              aria-pressed={dictation.state === 'recording'}
            >
              <Mic size={18} strokeWidth={dictation.state === 'recording' ? 2.2 : 1.8} />
            </button>
          </Tooltip>
          )}
          <ModelPicker conversation={conversation} disabled={running} />
          {running && (
            <Tooltip label={stopping ? 'Stopping…' : 'Stop the agent'}>
              <button
                onClick={stop}
                disabled={stopping}
                className={cx(
                  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60',
                  canSend ? 'border border-line text-ink-2 hover:bg-hover hover:text-ink' : 'bg-primary text-on-primary hover:bg-primary-hover',
                )}
                aria-label={stopping ? 'Stopping' : 'Stop'}
              >
                <Square size={12} fill="currentColor" />
              </button>
            </Tooltip>
          )}
          {(!running || canSend) && (
            <Tooltip label={running ? 'Steer: the agent reads this at its next step' : 'Send'} keys={state.settings.sendKey === 'ctrl-enter' ? 'Ctrl+Enter' : 'Enter'}>
              <button
                onClick={send}
                disabled={!canSend}
                className={cx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors', canSend ? 'bg-primary text-on-primary hover:bg-primary-hover' : 'bg-hover text-faint')}
                aria-label={running ? 'Steer' : 'Send'}
              >
                <ArrowUp size={17} strokeWidth={2.2} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="mt-1.5 flex items-center gap-0.5 px-2">
        <Popover
          side="top"
          width={320}
          trigger={({ toggle }) => (
            <Tooltip label={conversation.workspace ?? fallbackFolder ?? 'Default working folder'}>
              <button
                onClick={() => {
                  toggle();
                  void api.getAppInfo().then((i) => setDefaultFolder(i.effectiveDefaultWorkspace)).catch(() => {});
                }}
                disabled={running}
                className="inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50"
              >
                <FolderOpen size={14} className="shrink-0" />
                <span className="truncate">{folderName(conversation.workspace) ?? folderName(agentProject?.workspace ?? null) ?? folderName(state.settings.defaultWorkspace) ?? 'Nest'}</span>
              </button>
            </Tooltip>
          )}
        >
          {(close) => {
            const current = conversation.workspace ?? fallbackFolder;
            return (
              <>
                <MenuLabel>Working folder</MenuLabel>
                <div className="break-all px-2.5 pb-1 font-mono text-[11.5px] text-ink-2">{current ?? '…'}</div>
                <div className="px-2.5 pb-2 text-[11.5px] text-muted">
                  {conversation.workspace ? 'Chosen for this conversation.' : agentProject?.workspace ? `The ${agentProject.name} project’s shared folder.` : 'Your default working folder. Change it in Settings → General.'}
                </div>
                {current && !IS_REMOTE && (
                  <MenuItem
                    onClick={() => {
                      close();
                      void attempt(() => api.openFolder(current));
                    }}
                  >
                    Open in Explorer
                  </MenuItem>
                )}
                <MenuItem
                  onClick={async () => {
                    close();
                    const folder = await attempt(() => api.pickFolder());
                    if (folder) await attempt(() => api.updateConversation(conversation.id, { workspace: folder }));
                  }}
                >
                  Choose another folder…
                </MenuItem>
                {conversation.workspace && (
                  <MenuItem
                    onClick={() => {
                      close();
                      void attempt(() => api.updateConversation(conversation.id, { workspace: null }));
                    }}
                  >
                    {agentProject?.workspace ? 'Use the project folder' : 'Use default folder'}
                  </MenuItem>
                )}
              </>
            );
          }}
        </Popover>
        <Popover
          side="top"
          width={300}
          trigger={({ toggle }) =>
            skipping ? (
              <Tooltip label="Agents act without asking: full file and command access">
                <button
                  onClick={toggle}
                  disabled={running}
                  className="inline-flex h-7 items-center gap-1.5 rounded-full border border-warn-line bg-warn-bg px-2.5 text-[12px] text-warn-ink transition-colors disabled:opacity-50"
                >
                  <AlertTriangle size={13} className="shrink-0" />
                  <span className="truncate">Permissions skipped</span>
                </button>
              </Tooltip>
            ) : (
              <Tooltip label="Permissions">
                <button onClick={toggle} disabled={running} className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[12px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:opacity-50">
                  <Lock size={13} className="shrink-0" />
                  <span className="truncate">{permissionLabel(conversation, skipping)}</span>
                </button>
              </Tooltip>
            )
          }
        >
          {(close) => (
            <>
              <MenuLabel>{permissionStyle(conversation.provider) === 'codex' ? 'Codex sandbox & approvals' : `${PROVIDER_LABEL[conversation.provider]} permission mode`}</MenuLabel>
              {permissionStyle(conversation.provider) === 'none' ? (
                <div className="px-3 pb-2 text-[12px] leading-snug text-muted">API models only chat: they can’t run commands or change files, so there is nothing to approve.</div>
              ) : permissionStyle(conversation.provider) === 'claude'
                ? CLAUDE_MODES.map((m) => (
                    <MenuItem
                      key={m.id}
                      active={!skipping && conversation.permissions.claudeMode === m.id}
                      onClick={() => {
                        close();
                        setPermissions({ ...conversation.permissions, claudeMode: m.id, skipPermissions: skipping ? false : conversation.permissions.skipPermissions });
                      }}
                    >
                      <span>
                        <span className="block">{m.label}</span>
                        <span className="block text-[11.5px] font-normal text-muted">{m.hint}</span>
                      </span>
                    </MenuItem>
                  ))
                : CODEX_MODES.map((m) => (
                    <MenuItem
                      key={m.label}
                      active={!skipping && conversation.permissions.codexSandbox === m.sandbox && conversation.permissions.codexApproval === m.approval}
                      onClick={() => {
                        close();
                        setPermissions({ ...conversation.permissions, codexSandbox: m.sandbox, codexApproval: m.approval, skipPermissions: skipping ? false : conversation.permissions.skipPermissions });
                      }}
                    >
                      <span>
                        <span className="block">{m.label}</span>
                        <span className="block text-[11.5px] font-normal text-muted">{m.hint}</span>
                      </span>
                    </MenuItem>
                  ))}
              <div className="my-1 border-t border-line" />
              {allowSkip ? (
                <MenuItem
                  active={skipping}
                  onClick={async () => {
                    close();
                    if (
                      !skipping &&
                      !(await confirmDialog({
                        title: 'Skip permissions for this conversation?',
                        message: 'The agent will edit files anywhere on your computer and run commands without asking. Nest’s own tool approvals are answered automatically too; the agent still asks before seriously consequential actions.',
                        confirmLabel: 'Skip permissions',
                        tone: 'danger',
                      }))
                    )
                      return;
                    // Matching the agent's setting clears the override so later agent changes apply here too.
                    setPermissions({ ...conversation.permissions, skipPermissions: !skipping === inheritedSkip ? undefined : !skipping });
                  }}
                >
                  <span>
                    <span className="block">{skipping ? 'Stop skipping permissions' : 'Skip permissions'}</span>
                    <span className="block text-[11.5px] font-normal text-muted">Full access, no approvals. Use for trusted tasks only.</span>
                  </span>
                </MenuItem>
              ) : (
                <MenuItem
                  onClick={() => {
                    close();
                    navigate({ name: 'settings', section: 'permissions' });
                  }}
                >
                  <span>
                    <span className="block text-muted">Skip permissions</span>
                    <span className="block text-[11.5px] font-normal text-muted">Turn on in Settings → Permissions first</span>
                  </span>
                </MenuItem>
              )}
            </>
          )}
        </Popover>
      </div>
    </div>
  );
}
