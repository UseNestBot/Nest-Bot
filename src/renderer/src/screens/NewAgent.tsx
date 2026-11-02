import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { AvatarSpec, ProviderId } from '@shared/types';
import { AGENT_TEMPLATES, type AgentTemplate } from '@shared/templates';
import { describeCadence } from '@shared/schedule';
import { api } from '../api';
import { useStore } from '../store';
import { AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES, Avatar, EYES_LABEL, SHAPE_LABEL } from '../components/Avatar';
import { Button, SectionLabel, Tooltip, cx } from '../components/ui';
import { ProviderChoice } from '../components/ModelPicker';
import { MobileBack } from '../components/MobileBack';

/** Create an agent the quick way: look, name, provider, optionally from a template. Everything else is editable later. */
export function NewAgentScreen({ projectId }: { projectId?: string } = {}) {
  const { state, attempt, reloadAgents, startConversation } = useStore();
  const [avatar, setAvatar] = useState<AvatarSpec>({ shape: 'blob', color: '#3b82f6', eyes: 'dots' });
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ProviderId>(state.settings.defaultProvider);
  const [template, setTemplate] = useState<AgentTemplate | null>(null);
  const [withRoutine, setWithRoutine] = useState(true);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const first = state.ready && state.agents.length === 0;
  const ready = name.trim().length > 0 && !busy;

  const applyTemplate = (t: AgentTemplate) => {
    setTemplate(t);
    setAvatar(t.avatar);
    setName(t.name);
    setProvider(t.provider);
    setWithRoutine(Boolean(t.suggestedSchedule));
    nameRef.current?.focus();
  };

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    const agent = await attempt(() =>
      api.createAgent({
        name: name.trim(),
        avatar,
        instructions: template?.instructions ?? '',
        provider,
        model: null,
        workspace: null,
        projectId: projectId ?? null,
        pinned: false,
        permissions: state.settings.defaultPermissions,
      }),
    );
    const routine = template?.suggestedSchedule;
    if (agent && routine && withRoutine) await attempt(() => api.createSchedule({ agentId: agent.id, ...routine, target: 'new', enabled: true }));
    setBusy(false);
    if (!agent) return;
    await reloadAgents();
    await startConversation(agent.id);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="app-drag flex h-14 shrink-0 items-center gap-2.5 border-b border-line px-5 max-[640px]:px-4">
        <MobileBack />
        <Avatar spec={avatar} size={28} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{name.trim() || 'New agent'}</span>
        <div className="titlebar-spacer" />
      </header>

      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[800px] flex-col items-center px-6 pb-14 pt-10">
          {first && <h1 className="mb-6 font-display text-[22px] font-semibold tracking-[-0.01em]">Create your first agent</h1>}

          <div className="flex h-[148px] w-[148px] items-center justify-center rounded-[40px] bg-sunken">
            <Avatar spec={avatar} size={110} />
          </div>

          <div className="mt-7 flex flex-wrap justify-center gap-2.5" role="radiogroup" aria-label="Color">
            {AVATAR_COLORS.map((color) => (
              <button
                key={color}
                role="radio"
                aria-checked={avatar.color === color}
                aria-label={`Color ${color}`}
                onClick={() => setAvatar((a) => ({ ...a, color }))}
                className={cx('h-8 w-8 rounded-full ring-offset-2 ring-offset-canvas transition-shadow', avatar.color === color ? 'ring-2 ring-accent' : 'hover:ring-2 hover:ring-line-strong')}
                style={{ background: color }}
              />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap justify-center gap-1.5" role="radiogroup" aria-label="Shape">
            {AVATAR_SHAPES.map((shape) => (
              <Tooltip key={shape} label={SHAPE_LABEL[shape]}>
                <button
                  role="radio"
                  aria-checked={avatar.shape === shape}
                  aria-label={SHAPE_LABEL[shape]}
                  onClick={() => setAvatar((a) => ({ ...a, shape }))}
                  className={cx('flex h-12 w-12 items-center justify-center rounded-xl border-2 transition-colors', avatar.shape === shape ? 'border-accent' : 'border-transparent hover:bg-hover')}
                >
                  <Avatar spec={{ ...avatar, shape }} size={32} still />
                </button>
              </Tooltip>
            ))}
          </div>

          <div className="mt-1.5 flex justify-center gap-1" role="radiogroup" aria-label="Expression">
            {AVATAR_EYES.map((eyes) => (
              <Tooltip key={eyes} label={EYES_LABEL[eyes]}>
                <button
                  role="radio"
                  aria-checked={avatar.eyes === eyes}
                  aria-label={EYES_LABEL[eyes]}
                  onClick={() => setAvatar((a) => ({ ...a, eyes }))}
                  className={cx('flex h-10 w-10 items-center justify-center rounded-xl border-2 transition-colors', avatar.eyes === eyes ? 'border-accent' : 'border-transparent hover:bg-hover')}
                >
                  <Avatar spec={{ ...avatar, eyes }} size={24} still />
                </button>
              </Tooltip>
            ))}
          </div>

          <div className="mt-8 w-full max-w-[420px]">
            <label className="block">
              <span className="mb-1.5 block text-[13px] text-muted">Name</span>
              <input
                ref={nameRef}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void create()}
                placeholder="New agent"
                maxLength={80}
                className="h-11 w-full rounded-xl border border-line-strong bg-panel px-3.5 text-[15px] text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
              />
            </label>
            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[13px] text-muted">Runs on</span>
              <ProviderChoice value={provider} onChange={setProvider} />
            </div>

            {template && (
              <div className="mt-4 rounded-2xl border border-line bg-sunken px-3.5 py-3 text-[13px]">
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-ink-2">
                    Starts with the <span className="font-medium text-ink">{template.name}</span> instructions. You can edit them any time.
                  </span>
                  <button onClick={() => setTemplate(null)} className="rounded-md p-0.5 text-faint hover:bg-hover hover:text-ink" aria-label="Don’t use template instructions">
                    <X size={14} />
                  </button>
                </div>
                {template.suggestedSchedule && (
                  <label className="mt-2.5 flex items-center gap-2 text-ink-2">
                    <input type="checkbox" checked={withRoutine} onChange={(e) => setWithRoutine(e.target.checked)} className="h-4 w-4 accent-[var(--nest-accent)]" />
                    Add the “{template.suggestedSchedule.title}” routine ({describeCadence(template.suggestedSchedule.cadence)})
                  </label>
                )}
              </div>
            )}

            <div className="mt-7 flex justify-center">
              <Button variant="primary" size="lg" disabled={!ready} onClick={create}>
                {busy ? 'Creating…' : 'Get started'}
              </Button>
            </div>
          </div>

          <div className="mt-16 w-full">
            <SectionLabel>Suggestions</SectionLabel>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {AGENT_TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => applyTemplate(t)}
                  aria-pressed={template?.id === t.id}
                  className={cx(
                    'flex items-center gap-4 rounded-[20px] border bg-panel px-5 py-5 text-left transition-[border-color,box-shadow]',
                    template?.id === t.id ? 'border-accent' : 'border-line hover:border-line-strong hover:shadow-float',
                  )}
                >
                  <Avatar spec={t.avatar} size={52} className="shrink-0" />
                  <span className="min-w-0">
                    <span className="block font-display text-[16px] font-semibold text-ink">{t.name}</span>
                    <span className="mt-0.5 line-clamp-2 block text-[13.5px] leading-snug text-muted">{t.tagline}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
