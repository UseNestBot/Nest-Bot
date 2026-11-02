import { useEffect, useState } from 'react';
import { FolderOpen, MessageSquarePlus, Plus, Shuffle, Trash2 } from 'lucide-react';
import { PROVIDER_LABEL, permissionStyle, type Agent, type AgentDraft, type ModelOption } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { folderName } from '../format';
import { AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES, Avatar, EYES_LABEL, SHAPE_LABEL, randomAvatar } from '../components/Avatar';
import { Button, Combobox, EmptyState, Field, Modal, ScreenHeader, Segmented, Select, Toggle, Tooltip, cx, inputClass } from '../components/ui';
import { ProviderChoice } from '../components/ModelPicker';
import { PHONE_QUERY, useMediaQuery } from '../components/MobileBack';

function toDraft(a: Agent): AgentDraft {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = a;
  return rest;
}

/** Browse and edit agents. New agents are made on the NewAgent screen (view library/'new'). */
export function AgentLibrary({ selected }: { selected?: string }) {
  const { state, navigate, startConversation } = useStore();
  const current = selected ? state.agents.find((a) => a.id === selected) : undefined;
  // On a phone the list and the editor are separate screens, each the full width.
  const phone = useMediaQuery(PHONE_QUERY);
  const editing = phone && !!current;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ScreenHeader
        title={editing ? current.name : 'Agents'}
        subtitle={editing ? PROVIDER_LABEL[current.provider] : `${state.agents.length} agent${state.agents.length === 1 ? '' : 's'}`}
        onBack={editing ? () => navigate({ name: 'library' }) : undefined}
        backLabel={editing ? 'Back to agents' : undefined}
        actions={
          <Button variant="primary" onClick={() => navigate({ name: 'library', agentId: 'new' })}>
            <Plus size={14} /> New agent
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className={cx('scroll-quiet w-[280px] shrink-0 overflow-y-auto border-r border-line p-2 max-[900px]:w-[220px] max-[640px]:w-full max-[640px]:border-r-0', editing && 'hidden')}>
          {state.agents.map((a) => (
            <button
              key={a.id}
              onClick={() => navigate({ name: 'library', agentId: a.id })}
              className={cx('mb-0.5 flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-colors', selected === a.id ? 'bg-active' : 'hover:bg-hover')}
            >
              <Avatar spec={a.avatar} size={38} className="shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold">{a.name}</span>
                <span className="block truncate text-[12px] text-muted">
                  {PROVIDER_LABEL[a.provider]}
                  {a.projectId ? ` · ${state.projects.find((p) => p.id === a.projectId)?.name ?? ''}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
        <div className={cx('scroll-quiet min-w-0 flex-1 overflow-y-auto', phone && !current && 'hidden')}>
          {current ? (
            <AgentEditor key={current.id} agent={current} initial={toDraft(current)} onChat={() => void startConversation(current.id)} />
          ) : (
            <EmptyState title="Select an agent to edit">Agents bundle a name, avatar, instructions, a default provider and model, a workspace folder and permission defaults.</EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentEditor({ agent, initial, onChat }: { agent?: Agent; initial: AgentDraft; onChat?: () => void }) {
  const { state, attempt, reloadAgents, navigate, toast } = useStore();
  const [draft, setDraft] = useState<AgentDraft>(initial);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const set = <K extends keyof AgentDraft>(k: K, v: AgentDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  useEffect(() => {
    let alive = true;
    void api.listModels(draft.provider).then((m) => alive && setModels(m)).catch(() => setModels([]));
    return () => {
      alive = false;
    };
  }, [draft.provider]);

  const save = async () => {
    setSaving(true);
    const saved = await attempt(() => (agent ? api.updateAgent(agent.id, draft) : api.createAgent(draft)));
    setSaving(false);
    if (!saved) return;
    await reloadAgents();
    toast(agent ? 'Agent saved.' : 'Agent created.', 'info');
    if (!agent) navigate({ name: 'library', agentId: saved.id });
  };

  return (
    <div className="mx-auto max-w-[680px] px-6 py-6 max-[640px]:px-4 max-[640px]:py-4">
      <div className="mb-6 flex items-center gap-4">
        <span className="flex h-[76px] w-[76px] shrink-0 items-center justify-center rounded-[24px] bg-sunken">
          <Avatar spec={draft.avatar} size={58} />
        </span>
        <div className="min-w-0 flex-1">
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Agent name" aria-label="Agent name" className="w-full bg-transparent font-display text-[21px] font-semibold outline-none placeholder:text-faint" autoFocus={!agent} />
          <div className="text-[12.5px] text-muted">{agent ? `Created ${new Date(agent.createdAt).toLocaleDateString()}` : 'New agent'}</div>
        </div>
        {onChat && (
          <Button onClick={onChat}>
            <MessageSquarePlus size={14} /> New chat
          </Button>
        )}
      </div>

      <section className="space-y-5">
        <Field label="Avatar">
          <div className="space-y-3 rounded-2xl border border-line bg-panel p-4">
            <div className="flex flex-wrap items-center gap-2">
              {AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  onClick={() => set('avatar', { ...draft.avatar, color })}
                  aria-label={`Color ${color}`}
                  className={cx('h-7 w-7 rounded-full ring-offset-2 ring-offset-panel', draft.avatar.color === color ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-line-strong')}
                  style={{ background: color }}
                />
              ))}
              <button onClick={() => set('avatar', randomAvatar())} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-ink">
                <Shuffle size={13} /> Shuffle
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {AVATAR_SHAPES.map((shape) => (
                <Tooltip key={shape} label={SHAPE_LABEL[shape]}>
                  <button
                    onClick={() => set('avatar', { ...draft.avatar, shape })}
                    className={cx('flex h-11 w-11 items-center justify-center rounded-xl border-2', draft.avatar.shape === shape ? 'border-accent' : 'border-transparent hover:bg-hover')}
                    aria-label={SHAPE_LABEL[shape]}
                  >
                    <Avatar spec={{ ...draft.avatar, shape }} size={30} still />
                  </button>
                </Tooltip>
              ))}
              <span className="mx-1.5 h-6 w-px bg-line" />
              {AVATAR_EYES.map((eyes) => (
                <Tooltip key={eyes} label={EYES_LABEL[eyes]}>
                  <button
                    onClick={() => set('avatar', { ...draft.avatar, eyes })}
                    className={cx('flex h-11 w-11 items-center justify-center rounded-xl border-2', draft.avatar.eyes === eyes ? 'border-accent' : 'border-transparent hover:bg-hover')}
                    aria-label={EYES_LABEL[eyes]}
                  >
                    <Avatar spec={{ ...draft.avatar, eyes }} size={26} still />
                  </button>
                </Tooltip>
              ))}
            </div>
          </div>
        </Field>

        <Field label="Instructions" hint="Sent through the provider’s system or developer instructions when a session starts. Changes reach existing sessions on their next turn.">
          <textarea value={draft.instructions} onChange={(e) => set('instructions', e.target.value)} rows={7} placeholder="Who is this agent and how should it work?" className={cx(inputClass, 'resize-y leading-relaxed')} />
        </Field>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Default provider">
            <ProviderChoice value={draft.provider} onChange={(p) => setDraft((d) => ({ ...d, provider: p, model: null }))} />
          </Field>
          <Field label="Model" hint={draft.provider === 'claude' ? 'Aliases track the latest model. Type a full model name to pin one.' : `From ${PROVIDER_LABEL[draft.provider]}’s model list for your account.`}>
            <Combobox
              label="Model"
              value={draft.model ?? ''}
              onChange={(v) => set('model', v.trim() ? v : null)}
              placeholder={models.find((m) => m.id === '')?.label ?? 'Default'}
              options={(models.some((m) => m.id === '') ? models : [{ id: '', label: 'Default' }, ...models]).map((m) => ({ value: m.id, label: m.label, cost: 'cost' in m ? m.cost : undefined }))}
            />
          </Field>
        </div>

        <Field label="Workspace folder" hint="The agent works here through its provider’s own file and shell tools.">
          <div className="flex items-center gap-2">
            <Tooltip label={draft.workspace} align="start">
              <div className={cx(inputClass, 'flex min-h-[32px] items-center truncate text-muted')}>{draft.workspace ?? 'Default working folder'}</div>
            </Tooltip>
            <Button
              onClick={async () => {
                const f = await attempt(() => api.pickFolder());
                if (f) set('workspace', f);
              }}
            >
              <FolderOpen size={14} /> {draft.workspace ? 'Change' : 'Choose'}
            </Button>
            {draft.workspace && (
              <Button variant="ghost" onClick={() => set('workspace', null)}>
                Clear
              </Button>
            )}
          </div>
          {draft.workspace && <span className="sr-only">{folderName(draft.workspace)}</span>}
        </Field>

        <Field label="Permissions">
          {permissionStyle(draft.provider) === 'none' ? (
            <div className="text-[13px] text-muted">API models only chat, so there is nothing to approve.</div>
          ) : permissionStyle(draft.provider) === 'claude' ? (
            <Segmented
              value={draft.permissions.claudeMode}
              onChange={(claudeMode) => set('permissions', { ...draft.permissions, claudeMode })}
              options={[
                { value: 'default', label: 'Ask before acting' },
                { value: 'acceptEdits', label: 'Auto-accept edits' },
                { value: 'plan', label: 'Plan only' },
              ]}
            />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Segmented
                value={draft.permissions.codexSandbox}
                onChange={(codexSandbox) => set('permissions', { ...draft.permissions, codexSandbox })}
                options={[
                  { value: 'workspace-write', label: 'Workspace write' },
                  { value: 'read-only', label: 'Read only' },
                ]}
              />
              <Segmented
                value={draft.permissions.codexApproval}
                onChange={(codexApproval) => set('permissions', { ...draft.permissions, codexApproval })}
                options={[
                  { value: 'on-request', label: 'Ask when needed' },
                  { value: 'untrusted', label: 'Ask often' },
                ]}
              />
            </div>
          )}
        </Field>
        {state.settings.allowSkipPermissions && (
          <Field
            label="Skip permissions"
            hint="Applies to this agent’s conversations, routines and delegated work. Skipping agents still ask before seriously consequential actions."
          >
            <Segmented<'default' | 'skip' | 'ask'>
              value={draft.permissions.skipPermissions === undefined ? 'default' : draft.permissions.skipPermissions ? 'skip' : 'ask'}
              onChange={(v) => {
                const { skipPermissions: _old, ...rest } = draft.permissions;
                set('permissions', v === 'default' ? rest : { ...rest, skipPermissions: v === 'skip' });
              }}
              options={[
                { value: 'default', label: `Default (${state.settings.skipPermissionsByDefault ? 'skip' : 'ask'})` },
                { value: 'skip', label: 'Skip' },
                { value: 'ask', label: 'Always ask' },
              ]}
            />
          </Field>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Project" hint="Shows the agent in this project and makes it a teammate there. New chats start outside any project; move a chat in from the sidebar.">
            <Select
              label="Project"
              className="w-full"
              value={draft.projectId ?? ''}
              onChange={(v) => set('projectId', v || null)}
              options={[{ value: '', label: 'No project' }, ...state.projects.map((p) => ({ value: p.id, label: p.name }))]}
            />
          </Field>
          <Field label="Pinned to sidebar">
            <div className="flex h-8 items-center">
              <Toggle checked={draft.pinned} onChange={(v) => set('pinned', v)} label="Pinned" />
            </div>
          </Field>
        </div>
      </section>

      <div className="mt-8 flex items-center justify-between border-t border-line pt-4">
        {agent ? (
          <Button variant="danger" onClick={() => setRemoving(true)}>
            <Trash2 size={14} /> Remove agent
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {dirty && agent && (
            <Button variant="ghost" onClick={() => setDraft(initial)}>
              Discard changes
            </Button>
          )}
          <Button variant="primary" disabled={saving || !draft.name.trim() || (!dirty && Boolean(agent))} onClick={save}>
            {saving ? 'Saving…' : agent ? 'Save changes' : 'Create agent'}
          </Button>
        </div>
      </div>
      {removing && agent && <RemoveAgentDialog agent={agent} onClose={() => setRemoving(false)} />}
    </div>
  );
}

/** Removing an agent keeps its chats readable unless the user also deletes them here. */
function RemoveAgentDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { state, attempt, reloadAgents, navigate, removeConversation } = useStore();
  const [busy, setBusy] = useState(false);
  const chats = state.conversations.filter((c) => c.agentId === agent.id);
  const count = chats.length === 1 ? '1 chat' : `${chats.length} chats`;

  const remove = async (deleteChats: boolean) => {
    setBusy(true);
    if (deleteChats) {
      for (const c of chats) {
        const ok = await attempt(async () => {
          await api.deleteConversation(c.id);
          return true;
        });
        if (ok) removeConversation(c.id);
      }
    }
    await attempt(() => api.deleteAgent(agent.id));
    await reloadAgents();
    setBusy(false);
    onClose();
    navigate({ name: 'library' });
  };

  return (
    <Modal
      title={`Remove ${agent.name}?`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {chats.length > 0 && (
            <Button variant="danger" onClick={() => void remove(true)} disabled={busy}>
              Remove and delete {count}
            </Button>
          )}
          <Button variant="primary" onClick={() => void remove(false)} disabled={busy}>
            {chats.length > 0 ? 'Remove, keep chats' : 'Remove'}
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] text-ink-2">
        {chats.length > 0
          ? `${agent.name} has ${count}. Kept chats stay readable in the sidebar. Deleting removes their history from Nest; provider-side session files are not touched.`
          : `${agent.name} has no chats.`}
      </p>
    </Modal>
  );
}
