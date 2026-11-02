import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Archive, Blocks, Bot, Brain, Check, Copy, Database, ExternalLink, FolderOpen, Info, Keyboard, LogIn, LogOut, MessageSquare, Mic, Palette, Plug, RefreshCw, Settings2, ShieldCheck, Smartphone } from 'lucide-react';
import { DICTATION_MODELS, type DictationModelStatus } from '@shared/dictation';
import {
  API_PROVIDERS,
  CLI_PROVIDERS,
  DEFAULT_SETTINGS,
  PROVIDER_LABEL,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
  type AccentColor,
  type ApiKeyState,
  type ApiProviderId,
  type AppSettings,
  type CliProviderId,
  type AgentAccess,
  type AppInfo,
  type BackupInfo,
  type ClaudePermissionMode,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type Connector,
  type ConnectorInventory,
  type LoginStart,
  type NotifyOn,
  type ProviderId,
  type ProviderStatus,
  type RemoteState,
} from '@shared/types';
import { IS_REMOTE, api } from '../api';
import { MobileBack } from '../components/MobileBack';
import { disablePush, enablePush, forget, pushEnabled, pushSupported } from '../web/client';
import { formatBytes, relativeTime, statusLabel } from '../format';
import { useStore, type SettingsSection } from '../store';
import { UpdateStatus } from '../components/Update';
import { RELEASE_CHANNEL, versionLabel } from '@shared/build';
import { Button, Segmented, Select, Toggle, Tooltip, cx, inputClass } from '../components/ui';
import { dictationEngine, useModelDownload } from '../dictation/dictation';
import { confirmDialog } from '../components/confirm';
import { useModels, usableProviders } from '../components/ModelPicker';

// Words for the PC's own desktop. A paired phone only sees sections that work there.
const UA = typeof navigator === 'undefined' ? '' : navigator.userAgent;
const OS: 'windows' | 'mac' | 'linux' = /Windows/.test(UA) ? 'windows' : /Mac OS X/.test(UA) && !/iPhone|iPad/.test(UA) ? 'mac' : 'linux';
const OS_NAME = { windows: 'Windows', mac: 'macOS', linux: 'your desktop' }[OS];
const FILE_MANAGER = { windows: 'Explorer', mac: 'Finder', linux: 'file manager' }[OS];
const HOME = OS === 'windows' ? '%USERPROFILE%' : '~';
const SEP = OS === 'windows' ? '\\' : '/';
const KEY_PROTECTION = { windows: 'Windows data protection', mac: 'the macOS Keychain', linux: 'your system keyring' }[OS];

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof Settings2 }> = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'agents', label: 'Agent tools', icon: Bot },
  { id: 'connectors', label: 'Connectors & browser', icon: Blocks },
  { id: 'conversations', label: 'Conversations', icon: MessageSquare },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'providers', label: 'Providers', icon: Plug },
  { id: 'permissions', label: 'Permissions', icon: ShieldCheck },
  { id: 'memory', label: 'Memory & context', icon: Brain },
  { id: 'remote', label: 'Remote access', icon: Smartphone },
  { id: 'device', label: 'This device', icon: Smartphone },
  { id: 'data', label: 'Data & storage', icon: Database },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
  { id: 'about', label: 'About', icon: Info },
].filter(({ id }) =>
  // On a phone: no PC-only sections (dictation, shortcuts, storage, pairing other devices).
  IS_REMOTE ? !['voice', 'shortcuts', 'data', 'remote'].includes(id) : id !== 'device',
) as Array<{ id: SettingsSection; label: string; icon: typeof Settings2 }>;

export function SettingsScreen({ section }: { section: SettingsSection }) {
  const { navigate } = useStore();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const loadInfo = useCallback(() => void api.getAppInfo().then(setInfo).catch(() => {}), []);
  // Counts and sizes only show on these sections; others use the paths, which rarely change.
  const needsFreshInfo = section === 'data' || section === 'memory';
  useEffect(loadInfo, [loadInfo, needsFreshInfo]);

  return (
    <div className="flex h-full min-w-0 flex-1">
      <nav className="w-[210px] shrink-0 border-r border-line px-2 py-4 max-[960px]:w-[176px] max-[640px]:hidden" aria-label="Settings sections">
        <div className="px-2.5 pb-3 text-[15px] font-semibold">Settings</div>
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => navigate({ name: 'settings', section: id })}
            aria-current={section === id ? 'page' : undefined}
            className={cx(
              'mb-0.5 flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors',
              section === id ? 'bg-panel font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]' : 'text-ink-2 hover:bg-hover hover:text-ink',
            )}
          >
            <Icon size={15} className="shrink-0 text-muted" />
            <span className="truncate">{label}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Window drag strip; also keeps content clear of the caption buttons in the top-right corner. */}
        <div className="app-drag flex h-14 shrink-0 items-center px-4">
          <MobileBack />
          <span className="hidden text-[16px] font-semibold max-[640px]:inline">Settings</span>
        </div>
        {/* Phones: the section list as a row of chips. */}
        <div className="scroll-quiet hidden shrink-0 gap-1.5 overflow-x-auto border-b border-line px-4 pb-2.5 max-[640px]:flex">
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => navigate({ name: 'settings', section: id })}
              aria-current={section === id ? 'page' : undefined}
              className={cx('h-8 shrink-0 rounded-full px-3 text-[13px]', section === id ? 'bg-primary text-on-primary' : 'bg-sunken text-ink-2')}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-8 pb-8 pt-2 max-[640px]:px-4 max-[640px]:pt-4">
            {section === 'general' && <General info={info} onChanged={loadInfo} />}
            {section === 'appearance' && <Appearance />}
            {section === 'agents' && <AgentTools />}
            {section === 'connectors' && <Connectors />}
            {section === 'conversations' && <Conversations />}
            {section === 'voice' && <Voice />}
            {section === 'providers' && <Providers />}
            {section === 'permissions' && <Permissions />}
            {section === 'memory' && <MemoryContext info={info} />}
            {section === 'remote' && <RemoteAccess />}
            {section === 'device' && <ThisDevice />}
            {section === 'data' && <DataStorage info={info} />}
            {section === 'shortcuts' && <Shortcuts />}
            {section === 'about' && <About info={info} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives

function Title({ children, subtitle }: { children: ReactNode; subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{children}</h1>
      {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-muted">{subtitle}</p>}
    </div>
  );
}

function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="mb-7">
      {title && <h2 className="mb-2 text-[13.5px] font-semibold text-ink">{title}</h2>}
      <div className="divide-y divide-line rounded-xl border border-line bg-panel">{children}</div>
      {footer && <div className="mt-2 px-1 text-[12px] leading-relaxed text-muted">{footer}</div>}
    </section>
  );
}

function Row({ label, description, children, stacked }: { label: ReactNode; description?: ReactNode; children?: ReactNode; stacked?: boolean }) {
  return (
    <div className={cx('px-4 py-3.5', stacked ? 'space-y-2.5' : 'flex items-center justify-between gap-6')}>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium text-ink">{label}</div>
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{description}</div>}
      </div>
      {children && <div className={cx(stacked ? '' : 'shrink-0')}>{children}</div>}
    </div>
  );
}

function PathValue({ value }: { value: string }) {
  return (
    <Tooltip label={value} align="end">
      <span className="block max-w-[300px] truncate rounded-md bg-sunken px-2 py-1 font-mono text-[11.5px] text-ink-2">{value}</span>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Sections

function General({ info, onChanged }: { info: AppInfo | null; onChanged: () => void }) {
  const { state, updateSettings, attempt } = useStore();
  const s = state.settings;
  return (
    <>
      <Title subtitle="How Nest behaves day to day.">General</Title>
      <Group title="Working folder" footer="Agents read and write files here when a conversation has no folder of its own. Pick a folder per conversation from the folder button under the message box.">
        <Row label="Default working folder" description={s.defaultWorkspace ? 'Custom folder' : 'Nest folder in your Documents'}>
          <div className="flex items-center gap-2">
            {info && <PathValue value={info.effectiveDefaultWorkspace} />}
          </div>
        </Row>
        <div className="flex flex-wrap gap-2 px-4 py-3">
          <Button
            size="sm"
            onClick={async () => {
              const folder = await attempt(() => api.pickFolder());
              if (folder) {
                await updateSettings({ defaultWorkspace: folder });
                onChanged();
              }
            }}
          >
            <FolderOpen size={13} /> Change…
          </Button>
          {info && (
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.openFolder(info.effectiveDefaultWorkspace))}>
              Open in {FILE_MANAGER}
            </Button>
          )}
          {s.defaultWorkspace && (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                await updateSettings({ defaultWorkspace: null });
                onChanged();
              }}
            >
              Reset to Documents{SEP}Nest
            </Button>
          )}
        </div>
      </Group>
      <Group title="New agents" footer="Each agent and conversation can still change both.">
        <Row label="Default provider" description="Preselected when you create an agent, and used when an agent creates one.">
          <Select<ProviderId>
            label="Default provider"
            className="w-52"
            align="end"
            value={s.defaultProvider}
            onChange={(defaultProvider) => void updateSettings({ defaultProvider })}
            options={usableProviders(state.statuses, s.defaultProvider).map((p) => ({ value: p, label: PROVIDER_LABEL[p], hint: state.statuses[p] ? statusLabel(state.statuses[p]) : undefined }))}
          />
        </Row>
        <DefaultModelRow provider={s.defaultProvider} />
      </Group>
      <Group title="Notifications" footer="Phones paired in Remote access get the same notifications, with their own on/off switch.">
        <Row label="Notify me in the background" description={`Show a ${OS === 'linux' ? 'desktop' : OS_NAME} notification while Nest isn’t the active window.`}>
          <Toggle checked={s.notifyWhenUnfocused} onChange={(notifyWhenUnfocused) => void updateSettings({ notifyWhenUnfocused })} label="Background notifications" />
        </Row>
        {(
          [
            ['approval', 'An agent needs approval'],
            ['failed', 'A run fails'],
            ['finished', 'An agent replies'],
          ] as Array<[keyof NotifyOn, string]>
        ).map(([kind, label]) => (
          <Row key={kind} label={<span className="font-normal">{label}</span>}>
            <Toggle checked={s.notifyOn[kind]} onChange={(on) => void updateSettings({ notifyOn: { ...s.notifyOn, [kind]: on } })} label={label} />
          </Row>
        ))}
        <Row label="Play a sound" description="For approvals and failures. Replies always arrive silently.">
          <Toggle checked={s.notificationSound} onChange={(notificationSound) => void updateSettings({ notificationSound })} label="Notification sound" />
        </Row>
      </Group>
    </>
  );
}

function DefaultModelRow({ provider }: { provider: ProviderId }) {
  const { state, updateSettings } = useStore();
  const models = useModels(provider);
  const current = state.settings.defaultModels[provider] ?? '';
  const choices = (models ?? []).filter((m) => m.id);
  // A saved model the provider no longer lists stays selectable so it can be seen and changed.
  const options = [
    { value: '', label: `${PROVIDER_LABEL[provider]} default` },
    ...choices.map((m) => ({ value: m.id, label: m.label })),
    ...(current && !choices.some((m) => m.id === current) ? [{ value: current, label: current, hint: 'Not listed by the provider' }] : []),
  ];
  return (
    <Row label="Default model" description={models ? 'For new agents on this provider.' : 'Loading models…'}>
      <Select<string>
        label="Default model"
        className="w-52"
        align="end"
        value={current}
        onChange={(model) => {
          const { [provider]: _, ...rest } = state.settings.defaultModels;
          void updateSettings({ defaultModels: model ? { ...rest, [provider]: model } : rest });
        }}
        options={options}
      />
    </Row>
  );
}

const ACCENTS: Array<{ value: AccentColor; label: string; swatch: string }> = [
  { value: 'blue', label: 'Blue', swatch: '#3b82f6' },
  { value: 'violet', label: 'Violet', swatch: '#7c5cf0' },
  { value: 'green', label: 'Green', swatch: '#1f9d63' },
  { value: 'orange', label: 'Orange', swatch: '#e2701f' },
  { value: 'pink', label: 'Pink', swatch: '#d9468a' },
  { value: 'graphite', label: 'Graphite', swatch: '#5f5f68' },
];

const APPEARANCE_KEYS = ['theme', 'darkStyle', 'accentColor', 'uiScale', 'density', 'chatWidth', 'uiFont', 'codeFont', 'reduceMotion'] as const;

function Appearance() {
  const { state, updateSettings } = useStore();
  const s = state.settings;
  const [scale, setScale] = useState(s.uiScale);
  useEffect(() => setScale(s.uiScale), [s.uiScale]);
  const isDefault = APPEARANCE_KEYS.every((k) => s[k] === DEFAULT_SETTINGS[k]);
  return (
    <>
      <Title subtitle="How Nest looks. Shared with phones paired in Remote access.">Appearance</Title>
      <Group title="Colour">
        <Row label="Theme" description={`System follows ${OS === 'linux' ? 'your desktop’s' : `${OS_NAME}’s`} light or dark mode.`}>
          <Segmented
            value={s.theme}
            onChange={(theme) => void updateSettings({ theme })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        {s.theme !== 'light' && (
          <Row label="Dark style" description="Black saves power on OLED screens.">
            <Segmented
              value={s.darkStyle}
              onChange={(darkStyle) => void updateSettings({ darkStyle })}
              options={[
                { value: 'dim', label: 'Dim' },
                { value: 'black', label: 'Black' },
              ]}
            />
          </Row>
        )}
        <Row label="Accent colour" description="Switches, links, focus rings and selected text.">
          <div className="flex gap-1.5" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((a) => (
              <Tooltip key={a.value} label={a.label}>
                <button
                  role="radio"
                  aria-checked={s.accentColor === a.value}
                  aria-label={a.label}
                  onClick={() => void updateSettings({ accentColor: a.value })}
                  className={cx('flex h-6 w-6 items-center justify-center rounded-full ring-offset-2 ring-offset-panel', s.accentColor === a.value && 'ring-2 ring-line-strong')}
                  style={{ background: a.swatch }}
                >
                  {s.accentColor === a.value && <Check size={13} className="text-white" />}
                </button>
              </Tooltip>
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Layout">
        <Row label="Interface size" description="Scales text and spacing across the whole app.">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={UI_SCALE_MIN}
              max={UI_SCALE_MAX}
              step={UI_SCALE_STEP}
              value={scale}
              aria-label="Interface size"
              onChange={(e) => setScale(Number(e.target.value))}
              // Applied on release: zooming while dragging moves the slider out from under the pointer.
              onPointerUp={() => scale !== s.uiScale && void updateSettings({ uiScale: scale })}
              onKeyUp={() => scale !== s.uiScale && void updateSettings({ uiScale: scale })}
              className="w-36 accent-[var(--nest-accent)]"
            />
            <button
              className="w-11 text-right text-[12.5px] tabular-nums text-ink-2 hover:text-ink"
              onClick={() => void updateSettings({ uiScale: 100 })}
              title="Reset to 100%"
            >
              {scale}%
            </button>
          </div>
        </Row>
        <Row label="Density" description="Padding and gaps in lists, menus and the transcript.">
          <Segmented
            value={s.density}
            onChange={(density) => void updateSettings({ density })}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'default', label: 'Default' },
              { value: 'comfortable', label: 'Roomy' },
            ]}
          />
        </Row>
        <Row label="Conversation width" description="How wide the transcript and message box can grow.">
          <Segmented
            value={s.chatWidth}
            onChange={(chatWidth) => void updateSettings({ chatWidth })}
            options={[
              { value: 'narrow', label: 'Narrow' },
              { value: 'default', label: 'Default' },
              { value: 'wide', label: 'Wide' },
            ]}
          />
        </Row>
      </Group>
      <Group title="Fonts" footer="Use the names of fonts installed on this computer, separated by commas. Nest falls back to its own fonts for anything missing.">
        <FontRow label="Interface font" setting="uiFont" placeholder="Built-in (Segoe UI, system)" />
        <FontRow label="Code font" setting="codeFont" placeholder="Built-in (Cascadia Mono, monospace)" />
      </Group>
      <Group title="Accessibility">
        <Row label="Reduce motion" description="Turn off animations and transitions.">
          <Toggle checked={s.reduceMotion} onChange={(reduceMotion) => void updateSettings({ reduceMotion })} label="Reduce motion" />
        </Row>
      </Group>
      {!isDefault && (
        <Button size="sm" variant="ghost" onClick={() => void updateSettings(Object.fromEntries(APPEARANCE_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])))}>
          <RefreshCw size={13} /> Reset appearance
        </Button>
      )}
    </>
  );
}

function FontRow({ label, setting, placeholder }: { label: string; setting: 'uiFont' | 'codeFont'; placeholder: string }) {
  const { state, updateSettings } = useStore();
  const saved = state.settings[setting];
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => {
    const next = draft.trim();
    if (next !== saved) void updateSettings({ [setting]: next });
    else setDraft(saved);
  };
  return (
    <Row label={label} stacked>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder={placeholder}
        spellCheck={false}
        aria-label={label}
        className={cx(inputClass, setting === 'codeFont' && 'font-mono text-[12.5px]')}
        style={draft.trim() ? { fontFamily: draft } : undefined}
      />
    </Row>
  );
}

const TOOL_LIST: Array<[string, string]> = [
  ['get_my_profile', 'Read its own name, instructions, model, working folder and memory notes.'],
  ['remember', 'Save a memory note (visible and editable in Memory).'],
  ['list_agents · delegate', 'See the other agents and hand them a task, waiting for the result.'],
  ['list_schedules · create_schedule', 'See routines and propose a new one. You approve it first.'],
  ['create_agent', 'Propose a new specialised agent. You approve it first.'],
  ['update_my_instructions', 'Propose changes to its own instructions. You approve it first.'],
  ['update_agent', 'Change another agent’s instructions, model or permissions. You approve it first.'],
  ['ask_permission', 'Ask you before a seriously consequential action, even when permissions are skipped.'],
];

function AgentTools() {
  const { state, updateSettings } = useStore();
  return (
    <>
      <Title subtitle="Nest gives agents a small toolset through each provider’s own MCP support, so a Chief of Staff can run the team.">Agent tools</Title>
      <Group footer="Tools that create or change something show an approval card in the conversation first. Changes apply from the next message.">
        <Row label="Let agents use Nest tools" description="Turn off to run agents with only their provider’s built-in tools.">
          <Toggle checked={state.settings.agentTools} onChange={(agentTools) => void updateSettings({ agentTools })} label="Nest agent tools" />
        </Row>
      </Group>
      <Group title="What agents can do">
        {TOOL_LIST.map(([name, what]) => (
          <Row key={name} label={<span className="font-mono text-[12.5px]">{name}</span>} description={what} />
        ))}
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Connectors & browser

const PROVIDERS_ORDER: ProviderId[] = ['claude', 'codex'];
const CONNECTOR_HELP: Partial<Record<ProviderId, string>> = {
  claude: 'Add connectors such as Gmail, Google Calendar or Slack at claude.ai → Settings → Connectors, or with `claude mcp add`.',
  codex: 'Add ChatGPT apps such as Gmail, Google Calendar or Slack in ChatGPT or the Codex app, or MCP servers with `codex mcp add`.',
};

function connectorStatusText(c: Connector): string | null {
  if (c.status === 'needs-auth') return 'Needs sign-in';
  if (c.status === 'failed') return 'Not connecting';
  if (c.status === 'pending') return 'Waiting for approval';
  return null;
}

function Connectors() {
  const { state, attempt } = useStore();
  const [inventories, setInventories] = useState<Partial<Record<ProviderId, ConnectorInventory>>>({});
  const [loading, setLoading] = useState<Partial<Record<ProviderId, boolean>>>({});
  const agents = state.agents;
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? '');
  const agent = agents.find((a) => a.id === agentId) ?? agents[0] ?? null;
  const [access, setAccess] = useState<AgentAccess | null>(null);

  const load = useCallback(
    async (provider: ProviderId, refresh = false) => {
      setLoading((l) => ({ ...l, [provider]: true }));
      const inv = await attempt(() => api.listConnectors(provider, refresh));
      if (inv) setInventories((all) => ({ ...all, [provider]: inv }));
      setLoading((l) => ({ ...l, [provider]: false }));
    },
    [attempt],
  );
  useEffect(() => {
    for (const p of PROVIDERS_ORDER) void load(p);
  }, [load]);
  useEffect(() => {
    setAccess(null);
    if (agent) void attempt(() => api.getAgentAccess(agent.id)).then((a) => a && setAccess(a));
  }, [agent?.id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (next: AgentAccess) => {
    if (!agent) return;
    setAccess(next);
    const saved = await attempt(() => api.setAgentAccess(agent.id, next));
    if (saved) setAccess(saved);
  };

  const order = agent ? [agent.provider, ...PROVIDERS_ORDER.filter((p) => p !== agent.provider)] : PROVIDERS_ORDER;
  return (
    <>
      <Title subtitle="Agents can use the connectors you’ve already set up in Claude Code and Codex, such as Gmail, Google Calendar and Slack. Each provider keeps its own sign-in; Nest stores no connector credentials.">
        Connectors & browser
      </Title>
      {agents.length === 0 ? (
        <Group>
          <Row label="No agents yet" description="Create an agent first, then choose what it may use here." />
        </Group>
      ) : (
        <>
          <Group footer="Changes apply from the agent’s next message.">
            <Row label="Agent" description="Choose what this agent may use. Conversations can switch provider, so both are listed.">
              <Select
                label="Agent"
                className="w-52"
                align="end"
                value={agent?.id ?? ''}
                onChange={setAgentId}
                options={agents.map((a) => ({ value: a.id, label: a.name, hint: PROVIDER_LABEL[a.provider] }))}
              />
            </Row>
            {access && agent && (() => {
              const chrome = inventories.claude?.browser;
              const blocked = chrome?.ready === false;
              return (
                <>
                  <Row
                    label="Browser"
                    description={
                      !access.browser
                        ? 'This agent can’t browse (it still has its provider’s web search).'
                        : access.browserMode === 'nest'
                          ? 'Its own built-in browser, separate from yours. Works on Claude Code and Codex, and you can watch it live in the conversation and take over.'
                          : agent.provider === 'codex'
                            ? 'My Chrome only works when this agent runs on Claude Code. Use the Nest browser for Codex.'
                            : chrome?.note ?? 'Claude in Chrome: the agent drives your own Chrome through the Claude in Chrome extension.'
                    }
                  >
                    <Segmented<'off' | 'nest' | 'chrome'>
                      value={!access.browser ? 'off' : access.browserMode}
                      onChange={(v) => void save({ ...access, browser: v !== 'off', browserMode: v === 'chrome' ? 'chrome' : 'nest' })}
                      options={[
                        { value: 'off', label: 'Off' },
                        { value: 'nest', label: 'Nest browser' },
                        { value: 'chrome', label: 'My Chrome' },
                      ]}
                    />
                  </Row>
                  {access.browser && access.browserMode === 'chrome' && blocked && (
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                      <span className="text-[12.5px] text-muted">My Chrome needs the Claude in Chrome extension.</span>
                      <Button size="sm" onClick={() => void api.openExternal('https://claude.ai/chrome')}>
                        Get Claude in Chrome <ExternalLink size={12} />
                      </Button>
                    </div>
                  )}
                  {access.browser && access.browserMode === 'chrome' && blocked && (
                    <div className="bg-warn-bg px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
                      <div className="font-medium">Before agents can browse:</div>
                      <ul className="mt-1 list-disc pl-5">
                        {chrome.missing.map((m) => (
                          <li key={m}>{m}</li>
                        ))}
                      </ul>
                      <div className="mt-1 text-muted">Then press Recheck under “Connected in Claude Code”.</div>
                    </div>
                  )}
                  {access.browser && access.browserMode === 'chrome' && inventories.codex && !inventories.codex.browser.available && (
                    <div className="px-4 py-3 text-[12.5px] leading-relaxed text-muted">
                      <span className="font-medium text-ink-2">Codex: not available. </span>
                      {inventories.codex.browser.note} {inventories.codex.browser.missing.join(' ')}
                    </div>
                  )}
                </>
              );
            })()}
          </Group>
          {access &&
            agent &&
            order.map((p) => (
              <AgentConnectorChoice
                key={p}
                provider={p}
                inventory={inventories[p]}
                loading={Boolean(loading[p])}
                allowed={p === 'claude' ? access.claudeConnectors : access.codexConnectors}
                onChange={(allowed) => void save(p === 'claude' ? { ...access, claudeConnectors: allowed } : { ...access, codexConnectors: allowed })}
                primary={p === agent.provider}
              />
            ))}
        </>
      )}
      {PROVIDERS_ORDER.map((p) => (
        <ConnectorInventoryGroup key={p} provider={p} inventory={inventories[p]} loading={Boolean(loading[p])} onRefresh={() => void load(p, true)} />
      ))}
    </>
  );
}

function AgentConnectorChoice({
  provider,
  inventory,
  loading,
  allowed,
  onChange,
  primary,
}: {
  provider: ProviderId;
  inventory?: ConnectorInventory;
  loading: boolean;
  allowed: string[] | null;
  onChange: (allowed: string[] | null) => void;
  primary: boolean;
}) {
  const known = inventory?.connectors ?? [];
  // Allowed ids the provider no longer reports stay visible so they can be removed.
  const missing = (allowed ?? []).filter((id) => !known.some((c) => c.id === id));
  const toggle = (id: string, on: boolean) => {
    const set = new Set(allowed ?? []);
    if (on) set.add(id);
    else set.delete(id);
    onChange([...set]);
  };
  return (
    <Group
      title={`${PROVIDER_LABEL[provider]} connectors${primary ? '' : ' (if a conversation switches provider)'}`}
      footer={
        allowed === null
          ? `The agent can use everything ${PROVIDER_LABEL[provider]} has connected, now and later.`
          : allowed.length === 0
            ? 'The agent runs without any connectors. Nest’s own agent tools stay available.'
            : 'Only the connectors switched on here. Ones you connect later stay off for this agent.'
      }
    >
      <Row label="Allowed">
        <Segmented<'all' | 'only'>
          value={allowed === null ? 'all' : 'only'}
          onChange={(v) => onChange(v === 'all' ? null : (allowed ?? []))}
          options={[
            { value: 'all', label: 'All' },
            { value: 'only', label: 'Only selected' },
          ]}
        />
      </Row>
      {allowed !== null && (
        <>
          {known.length === 0 && <Row label={loading ? 'Checking connectors…' : 'No connectors found'} description={loading ? undefined : CONNECTOR_HELP[provider]} />}
          {known.map((c) => (
            <Row key={c.id} label={<span className="font-normal">{c.name}</span>} description={c.source}>
              <Toggle checked={allowed.includes(c.id)} onChange={(on) => toggle(c.id, on)} label={`Allow ${c.name}`} />
            </Row>
          ))}
          {missing.map((id) => (
            <Row key={id} label={<span className="font-normal">{id}</span>} description="No longer reported by the provider">
              <Toggle checked onChange={() => toggle(id, false)} label={`Remove ${id}`} />
            </Row>
          ))}
        </>
      )}
    </Group>
  );
}

function ConnectorInventoryGroup({ provider, inventory, loading, onRefresh }: { provider: ProviderId; inventory?: ConnectorInventory; loading: boolean; onRefresh: () => void }) {
  return (
    <section className="mb-7">
      <div className="mb-2 flex items-center justify-between gap-4">
        <h2 className="text-[13.5px] font-semibold text-ink">Connected in {PROVIDER_LABEL[provider]}</h2>
        <Button size="sm" variant="ghost" disabled={loading} onClick={onRefresh}>
          <RefreshCw size={13} className={cx(loading && 'animate-spin')} /> Recheck
        </Button>
      </div>
      <div className="divide-y divide-line rounded-xl border border-line bg-panel">
        {!inventory && <Row label={loading ? 'Checking connectors…' : 'Not checked yet'} description={loading ? 'This starts each server once, so it can take a little while.' : undefined} />}
        {inventory?.error && <div className="bg-warn-bg px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">{inventory.error}</div>}
        {inventory && !inventory.error && inventory.connectors.length === 0 && <Row label="None yet" />}
        {inventory?.connectors.map((c) => {
          const attention = connectorStatusText(c);
          return (
            <Row key={c.id} label={<span className="font-normal">{c.name}</span>} description={[c.source, c.detail].filter(Boolean).join(' · ')}>
              {attention && <span className="text-[12.5px] text-warn-ink">{attention}</span>}
            </Row>
          );
        })}
      </div>
      <div className="mt-2 px-1 text-[12px] leading-relaxed text-muted">{CONNECTOR_HELP[provider]} Sign-in and permissions stay with {PROVIDER_LABEL[provider]}.</div>
    </section>
  );
}

function Conversations() {
  const { state, updateSettings } = useStore();
  const s = state.settings;
  return (
    <>
      <Title subtitle="The message box and transcript.">Conversations</Title>
      <Group title="Sending">
        <Row label="Send messages with" description={s.sendKey === 'enter' ? 'Enter sends; Shift+Enter adds a new line.' : 'Ctrl+Enter sends; Enter adds a new line.'}>
          <Segmented
            value={s.sendKey}
            onChange={(sendKey) => void updateSettings({ sendKey })}
            options={[
              { value: 'enter', label: 'Enter' },
              { value: 'ctrl-enter', label: 'Ctrl+Enter' },
            ]}
          />
        </Row>
      </Group>
      <Group title="Transcript">
        <Row label="Expand Activity by default" description="Show each reply’s commands, file edits and tool calls without clicking Activity.">
          <Toggle checked={s.expandActivity} onChange={(expandActivity) => void updateSettings({ expandActivity })} label="Expand activity" />
        </Row>
        <Row label="Show token usage" description="Tokens the provider reported for each reply. Nest doesn’t show cost estimates for subscription usage.">
          <Toggle checked={s.showUsage} onChange={(showUsage) => void updateSettings({ showUsage })} label="Show token usage" />
        </Row>
      </Group>
    </>
  );
}

function Voice() {
  const { state, updateSettings, attempt } = useStore();
  const [statuses, setStatuses] = useState<DictationModelStatus[]>([]);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const refresh = useCallback(() => void api.listDictationModels().then(setStatuses).catch(() => {}), []);
  useEffect(refresh, [refresh]);
  const download = useModelDownload(loadingId ?? '');

  const fetchModel = async (id: string) => {
    const model = DICTATION_MODELS.find((m) => m.id === id);
    if (!model) return;
    setLoadingId(id);
    await attempt(() => dictationEngine.load(model.repo).catch(() => Promise.reject(new Error('Couldn’t download the voice model. Check your internet connection and try again.'))));
    setLoadingId(null);
    refresh();
  };

  return (
    <>
      <Title subtitle="Dictate messages with the microphone button in the message box.">Voice</Title>
      <Group
        title="Dictation model"
        footer="Dictation uses OpenAI’s Whisper running on this computer, so your voice is never uploaded. Nest downloads the model from Hugging Face the first time you dictate and keeps it in its data folder."
      >
        {DICTATION_MODELS.map((m) => {
          const status = statuses.find((x) => x.id === m.id);
          const active = state.settings.dictationModel === m.id;
          const busy = loadingId === m.id;
          return (
            <div key={m.id} className="flex items-center gap-3 pr-4">
              <div className="min-w-0 flex-1">
                <Option
                  value={m.id}
                  current={state.settings.dictationModel}
                  onSelect={(dictationModel) => void updateSettings({ dictationModel })}
                  title={m.label}
                  description={`${m.hint} ${status?.downloaded ? `Downloaded · ${formatBytes(status.bytesOnDisk)}` : `About ${formatBytes(m.bytes)} to download.`}`}
                />
              </div>
              {busy ? (
                <span className="shrink-0 text-[12px] tabular-nums text-muted">{download ? `${Math.floor((download.loaded / download.total) * 100)}%` : 'Loading…'}</span>
              ) : status?.downloaded ? (
                !active && (
                  <Button
                    onClick={async () => {
                      await attempt(() => api.deleteDictationModel(m.id));
                      refresh();
                    }}
                  >
                    Delete
                  </Button>
                )
              ) : (
                <Button onClick={() => void fetchModel(m.id)} disabled={loadingId !== null}>
                  Download
                </Button>
              )}
            </div>
          );
        })}
      </Group>
      <Group title="Using dictation">
        <Row label={<span className="font-normal">Click the microphone, speak, then click it again. The text appears where your cursor is, ready to edit before you send.</span>} />
        <Row label={<span className="font-normal">Hold Ctrl+Shift+Space while you talk and let go to insert the text, or tap it once to start and again to stop. Enter inserts, Esc discards.</span>} />
        <Row label={<span className="font-normal">If Nest can’t hear you, {OS === 'windows' ? 'allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.' : OS === 'mac' ? 'allow Nest under System Settings → Privacy & Security → Microphone.' : 'check that your microphone is selected and unmuted in your system’s sound settings.'}</span>} />
      </Group>
    </>
  );
}

function Providers() {
  const { state, attempt } = useStore();
  const [refreshing, setRefreshing] = useState(false);
  const missing = CLI_PROVIDERS.filter((p) => state.statuses[p]?.state === 'not-installed');
  const installed = CLI_PROVIDERS.filter((p) => !missing.includes(p));
  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Providers</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">
            Nest drives the official agent tools installed on this computer, on your own subscriptions. They handle sign-in themselves; Nest never reads or stores those credentials. API keys you add below are the one exception.
          </p>
        </div>
        <Button
          disabled={refreshing}
          onClick={async () => {
            setRefreshing(true);
            await attempt(() => api.refreshProviders());
            setRefreshing(false);
          }}
        >
          <RefreshCw size={14} className={cx(refreshing && 'animate-spin')} /> Recheck
        </Button>
      </div>
      {installed.map((p) => (
        <ProviderGroup key={p} provider={p} status={state.statuses[p]} />
      ))}
      {missing.length > 0 && (
        <details className="group mb-7">
          <summary className="mb-2 cursor-pointer list-none px-1 text-[12px] font-semibold uppercase tracking-wide text-muted hover:text-ink">
            Not installed on this computer · {missing.map((p) => PROVIDER_LABEL[p]).join(', ')}
          </summary>
          {missing.map((p) => (
            <ProviderGroup key={p} provider={p} status={state.statuses[p]} />
          ))}
        </details>
      )}
      <ApiKeys />
    </>
  );
}

const ACCOUNT_HINT: Record<CliProviderId, string> = {
  codex: 'Uses Codex’s own ChatGPT sign-in (codex app-server).',
  claude: 'Uses Claude Code’s own Claude sign-in (claude CLI).',
  cursor: 'Uses the Cursor CLI’s own sign-in (agent acp).',
  gemini: 'Uses Gemini CLI’s own Google sign-in (gemini --acp).',
  grok: 'Uses the Grok CLI’s own xAI sign-in (grok agent stdio).',
};

const SIGN_IN_WITH: Record<CliProviderId, string> = { codex: 'ChatGPT', claude: 'Claude', cursor: 'Cursor', gemini: 'Google', grok: 'xAI' };

const PATH_SETTING = { claude: 'claudePath', codex: 'codexPath', cursor: 'cursorPath', gemini: 'geminiPath', grok: 'grokPath' } as const satisfies Record<CliProviderId, keyof AppSettings>;

function ProviderGroup({ provider, status }: { provider: CliProviderId; status?: ProviderStatus }) {
  const { state, attempt, updateSettings } = useStore();
  const [login, setLogin] = useState<LoginStart | null>(null);
  const configured = state.settings[PATH_SETTING[provider]];
  const [path, setPath] = useState(configured ?? '');
  useEffect(() => setPath(configured ?? ''), [configured]);
  const signedIn = status?.state === 'ready' || status?.state === 'api-key';
  const needsAttention = status && status.state !== 'ready' && status.state !== 'checking';

  return (
    <Group
      title={PROVIDER_LABEL[provider]}
      footer={status?.notes.length ? status.notes.join(' ') : undefined}
    >
      <Row label="Account" description={ACCOUNT_HINT[provider]}>
        <div className="text-right text-[13px]">
          <div className={cx('font-medium', needsAttention ? 'text-warn-ink' : 'text-ink')}>{signedIn ? status?.account ?? 'Signed in' : statusLabel(status)}</div>
          {status?.authMethod && signedIn && <div className="text-[12px] text-muted">via {status.authMethod}</div>}
        </div>
      </Row>
      {status?.action && (
        <div className="bg-warn-bg px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">{status.action}</div>
      )}
      {login && (
        <div className="px-4 py-3 text-[12.5px] leading-relaxed text-ink-2">
          {login.message}
          {login.command && (
            <div className="mt-1">
              Or run <code className="rounded bg-sunken px-1 font-mono">{login.command}</code> in a terminal.
            </div>
          )}
        </div>
      )}
      {status && status.state !== 'not-installed' && (
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {(status.state === 'signed-out' || status.state === 'api-key') && (
            <Button
              size="sm"
              variant="primary"
              onClick={async () => {
                const res = await attempt(() => api.startLogin(provider));
                if (res) setLogin(res);
              }}
            >
              <LogIn size={13} /> Sign in with {SIGN_IN_WITH[provider]}
            </Button>
          )}
          {signedIn && provider !== 'gemini' && (
            <Button
              size="sm"
              onClick={async () => {
                if (!(await confirmDialog({ title: `Sign ${PROVIDER_LABEL[provider]} out?`, message: 'This signs it out on this computer, which also affects its command line and other apps that use it.', confirmLabel: 'Sign out', tone: 'danger' }))) return;
                await attempt(() => api.signOut(provider));
              }}
            >
              <LogOut size={13} /> Sign out
            </Button>
          )}
        </div>
      )}
      {status && status.rateLimits.length > 0 && (
        <Row label="Usage limits" description="As reported by the provider for your plan." stacked>
          <div className="space-y-2.5">
            {status.rateLimits.map((w) => (
              <div key={w.label} className="text-[12px]">
                <div className="mb-1 flex justify-between text-ink-2">
                  <span className="capitalize">{w.label}</span>
                  <span className="text-muted">
                    {w.usedPercent !== null ? `${w.usedPercent}% used` : ''}
                    {w.resetsAt ? ` · resets ${new Date(w.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}
                  </span>
                </div>
                {w.usedPercent !== null && (
                  <div className="h-1 overflow-hidden rounded-full bg-active">
                    <div className={cx('h-full rounded-full', w.usedPercent > 85 ? 'bg-bad' : 'bg-ink-2')} style={{ width: `${Math.min(100, w.usedPercent)}%` }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Row>
      )}
      {status?.state !== 'not-installed' && (
        <Row label="Version">
          <span className="text-[13px] text-ink-2">{status?.version ?? '—'}</span>
        </Row>
      )}
      <Row label="Executable" description={status?.executable ? `Using ${status.executable}` : 'Detected from PATH and default install locations.'} stacked>
        <div className="flex gap-2">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Auto-detect" className={cx(inputClass, 'font-mono text-[12px]')} />
          <Button disabled={(configured ?? '') === path} onClick={() => void updateSettings({ [PATH_SETTING[provider]]: path.trim() || null })}>
            Save
          </Button>
        </div>
      </Row>
      {status?.detail && <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-[11.5px] text-ink-2">{status.detail}</pre>}
    </Group>
  );
}

const KEY_HELP: Record<ApiProviderId, string> = {
  openrouter: 'One key for hundreds of models from many labs.',
  'openai-api': 'GPT models on the OpenAI Platform (separate from a ChatGPT plan).',
  'anthropic-api': 'Claude models on the Claude Developer Platform (separate from a Claude plan).',
  'gemini-api': 'Gemini models from Google AI Studio.',
  'xai-api': 'Grok models from the xAI console.',
};

function ApiKeys() {
  const { state, attempt } = useStore();
  const [keys, setKeys] = useState<Partial<Record<ApiProviderId, ApiKeyState>>>({});
  useEffect(() => {
    void api.getApiKeyStates().then((list) => setKeys(Object.fromEntries(list.map((k) => [k.provider, k]))));
  }, []);
  const onSaved = (k: ApiKeyState) => setKeys((prev) => ({ ...prev, [k.provider]: k }));
  return (
    <Group
      title="API keys"
      footer={`API models are billed per token to your key, not to a subscription, and they only chat: they can’t run commands, edit files or use connectors. Keys are encrypted with ${KEY_PROTECTION} in Nest’s data folder and never shown again.`}
    >
      {API_PROVIDERS.map((p) => (
        <ApiKeyRow key={p} provider={p} state={keys[p]} status={state.statuses[p]} onSaved={onSaved} attempt={attempt} />
      ))}
    </Group>
  );
}

function ApiKeyRow({
  provider,
  state,
  status,
  onSaved,
  attempt,
}: {
  provider: ApiProviderId;
  state?: ApiKeyState;
  status?: ProviderStatus;
  onSaved: (k: ApiKeyState) => void;
  attempt: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const problem = state?.set && status && status.state !== 'ready' && status.state !== 'checking' ? status.action ?? statusLabel(status) : null;
  return (
    <Row
      label={
        <span className="inline-flex items-center gap-2">
          {PROVIDER_LABEL[provider]}
          {state?.set && <span className="font-mono text-[11.5px] font-normal text-muted">{state.hint}</span>}
        </span>
      }
      description={problem ? <span className="text-warn-ink">{problem}</span> : KEY_HELP[provider]}
      stacked
    >
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={state?.set ? 'Paste a new key to replace it' : 'Paste an API key'}
          className={cx(inputClass, 'font-mono text-[12px]')}
        />
        <Button
          disabled={!draft.trim() || saving}
          onClick={async () => {
            setSaving(true);
            const res = await attempt(() => api.setApiKey(provider, draft));
            setSaving(false);
            if (res) {
              setDraft('');
              onSaved(res);
            }
          }}
        >
          {saving ? 'Checking…' : 'Save'}
        </Button>
        {state?.set ? (
          <Button
            variant="danger"
            onClick={async () => {
              if (!(await confirmDialog({ title: `Remove the saved ${PROVIDER_LABEL[provider]} key?`, message: 'Nest forgets the key. You can paste it again any time.', confirmLabel: 'Remove key', tone: 'danger' }))) return;
              const res = await attempt(() => api.clearApiKey(provider));
              if (res) onSaved(res);
            }}
          >
            Remove
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => void attempt(() => api.startLogin(provider))}>
            Get a key <ExternalLink size={12} />
          </Button>
        )}
      </div>
    </Row>
  );
}

function Option<T extends string>({ value, current, onSelect, title, description }: { value: T; current: T; onSelect: (v: T) => void; title: string; description: string }) {
  const active = value === current;
  return (
    <button onClick={() => onSelect(value)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-hover" aria-pressed={active}>
      <span className={cx('mt-[3px] flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', active ? 'border-ink' : 'border-line-strong')}>
        {active && <span className="h-2 w-2 rounded-full bg-ink" />}
      </span>
      <span>
        <span className="block text-[13.5px] font-medium text-ink">{title}</span>
        <span className="block text-[12.5px] leading-relaxed text-muted">{description}</span>
      </span>
    </button>
  );
}

function Permissions() {
  const { state, updateSettings } = useStore();
  const s = state.settings;
  const perms = s.defaultPermissions;
  const setClaude = (claudeMode: ClaudePermissionMode) => void updateSettings({ defaultPermissions: { ...perms, claudeMode } });
  const setSandbox = (codexSandbox: CodexSandboxMode) => void updateSettings({ defaultPermissions: { ...perms, codexSandbox } });
  const setApproval = (codexApproval: CodexApprovalPolicy) => void updateSettings({ defaultPermissions: { ...perms, codexApproval } });
  return (
    <>
      <Title subtitle="Defaults for new agents. Each agent and conversation can override them. Skipping approvals entirely is a separate, opt-in switch below.">Permissions</Title>
      <Group title="Claude Code">
        <Option value="default" current={perms.claudeMode} onSelect={setClaude} title="Ask before acting" description="File edits and commands wait for your approval in the conversation." />
        <Option value="acceptEdits" current={perms.claudeMode} onSelect={setClaude} title="Auto-accept edits" description="File edits in the working folder go ahead; other commands still ask." />
        <Option value="plan" current={perms.claudeMode} onSelect={setClaude} title="Plan only" description="Claude can read and propose a plan but makes no changes." />
      </Group>
      <Group title="Codex sandbox">
        <Option value="workspace-write" current={perms.codexSandbox} onSelect={setSandbox} title="Working folder" description="Codex can edit files in the working folder inside its sandbox." />
        <Option value="read-only" current={perms.codexSandbox} onSelect={setSandbox} title="Read only" description="Codex can read files; any change needs your approval." />
      </Group>
      <Group title="Codex approvals">
        <Option value="on-request" current={perms.codexApproval} onSelect={setApproval} title="When needed" description="Codex asks when an action goes beyond its sandbox." />
        <Option value="untrusted" current={perms.codexApproval} onSelect={setApproval} title="Often" description="Codex asks for anything that isn’t a known-safe read." />
      </Group>
      <Group
        title="Skip permissions"
        footer="When allowed, choose “Skip permissions” from the lock menu under the message box, or set it on an agent. Claude Code then runs in bypassPermissions mode and Codex with full access and no approvals; Nest’s own tool approvals are answered automatically. Turning this off stops skipping everywhere from the next message."
      >
        <Row label="Allow skipping permissions" description="Off by default. Agents set to skip will edit any file and run any command without asking.">
          <Toggle
            checked={s.allowSkipPermissions}
            label="Allow skipping permissions"
            onChange={async (allowSkipPermissions) => {
              if (
                allowSkipPermissions &&
                !(await confirmDialog({
                  title: 'Allow skipping permissions?',
                  message: 'An agent set to skip can change or delete files anywhere you can, and run commands, without asking you first.',
                  confirmLabel: 'Allow',
                  tone: 'danger',
                }))
              )
                return;
              void updateSettings({ allowSkipPermissions });
            }}
          />
        </Row>
        <Row
          label="Skip for all agents by default"
          description="Every agent, routine and delegated task skips approvals unless that agent is set to “Always ask”. Agents still ask before seriously consequential actions."
        >
          <Toggle
            checked={s.allowSkipPermissions && s.skipPermissionsByDefault}
            label="Skip permissions by default"
            onChange={async (skipPermissionsByDefault) => {
              if (skipPermissionsByDefault && !s.allowSkipPermissions) {
                if (
                  !(await confirmDialog({
                    title: 'Skip permissions for all agents?',
                    message: 'This also allows skipping permissions. Agents will change files and run commands without asking. They still ask before seriously consequential actions such as sending messages or deleting data.',
                    confirmLabel: 'Turn on',
                    tone: 'danger',
                  }))
                )
                  return;
                void updateSettings({ allowSkipPermissions: true, skipPermissionsByDefault: true });
                return;
              }
              void updateSettings({ skipPermissionsByDefault });
            }}
          />
        </Row>
      </Group>
      <Group title="Billing safety" footer="API key variables such as ANTHROPIC_API_KEY and OPENAI_API_KEY are always removed from provider processes.">
        <Row label="Allow API-billed credentials" description="Off: Nest won’t send messages when a provider is signed in with an API key or a cloud provider instead of your subscription.">
          <Toggle checked={s.allowApiKeyBilling} onChange={(allowApiKeyBilling) => void updateSettings({ allowApiKeyBilling })} label="Allow API billing" />
        </Row>
      </Group>
    </>
  );
}

function MemoryContext({ info }: { info: AppInfo | null }) {
  const { state, updateSettings, navigate } = useStore();
  const [budget, setBudget] = useState(String(state.settings.transferBudgetChars));
  useEffect(() => setBudget(String(state.settings.transferBudgetChars)), [state.settings.transferBudgetChars]);
  return (
    <>
      <Title subtitle="What Nest tells an agent beyond your message.">Memory & context</Title>
      <Group title="Memory notes" footer="Notes are plain text stored on this computer. An agent receives its own notes plus shared notes, and only again when they change. Each reply’s Activity lists the notes it received.">
        <Row label="Saved notes" description={info ? `${info.counts.notes} note${info.counts.notes === 1 ? '' : 's'}` : undefined}>
          <Button size="sm" onClick={() => navigate({ name: 'memory' })}>
            Manage notes
          </Button>
        </Row>
      </Group>
      <Group title="Carrying context between sessions" footer="Codex and Claude Code keep separate sessions. When a conversation switches provider, or an earlier session can’t be resumed, Nest sends a summary of the messages that session hasn’t seen, newest first, up to this limit.">
        <Row label="Transfer limit" description="Characters (1,000–40,000)">
          <input
            type="number"
            min={1000}
            max={40000}
            step={1000}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onBlur={() => {
              // Show the value that will actually be used, and only save a real change.
              const saved = state.settings.transferBudgetChars;
              const n = Number(budget);
              const next = Number.isFinite(n) && budget.trim() ? Math.min(40000, Math.max(1000, Math.round(n))) : saved;
              setBudget(String(next));
              if (next !== saved) void updateSettings({ transferBudgetChars: next });
            }}
            className={cx(inputClass, 'w-28 text-right')}
          />
        </Row>
      </Group>
    </>
  );
}

function DataStorage({ info }: { info: AppInfo | null }) {
  const { attempt } = useStore();
  if (!info) return <Title>Data & storage</Title>;
  return (
    <>
      <Title subtitle="Everything Nest stores stays on this computer.">Data & storage</Title>
      <Group title="Local data">
        <Row label="Data folder" description="Database, settings and optional nest.config.json.">
          <div className="flex items-center gap-2">
            <PathValue value={info.dataDir} />
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.openFolder(info.dataDir))}>
              Open
            </Button>
          </div>
        </Row>
        <Row label="Database size">
          <span className="text-[13px] text-ink-2">{formatBytes(info.databaseBytes)}</span>
        </Row>
        <Row label="Contents">
          <span className="text-[13px] text-ink-2">
            {info.counts.agents} agents · {info.counts.conversations} conversations · {info.counts.messages} messages
          </span>
        </Row>
      </Group>
      <Group title="Provider data" footer="Codex and Claude Code keep their own session histories and credentials in their own folders. Deleting a conversation in Nest doesn’t touch them.">
        <Row label="Codex" description={`${HOME}${SEP}.codex`} />
        <Row label="Claude Code" description={`${HOME}${SEP}.claude`} />
      </Group>
      <Backups dataDir={info.dataDir} />
    </>
  );
}

function Backups({ dataDir }: { dataDir: string }) {
  const { attempt, toast } = useStore();
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void api.listBackups().then(setBackups).catch(() => setBackups([])), []);
  const newest = backups?.at(-1);
  return (
    <Group
      title="Backups"
      footer="Nest snapshots its database once a day and before every upgrade, keeping the 10 most recent. To restore one, quit Nest, delete nest.sqlite, nest.sqlite-wal and nest.sqlite-shm in the data folder, then copy the backup in as nest.sqlite."
    >
      <Row label="Database snapshots" description={backups === null ? 'Checking…' : newest ? `${backups.length} saved · latest ${relativeTime(newest.createdAt)}` : 'None yet'}>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const list = await attempt(() => api.backUpNow());
              setBusy(false);
              if (list) {
                setBackups(list);
                toast('Backed up', 'info');
              }
            }}
          >
            <Archive size={13} /> {busy ? 'Backing up…' : 'Back up now'}
          </Button>
          {Boolean(backups?.length) && (
            <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.openFolder(`${dataDir}${SEP}backups`))}>
              Open
            </Button>
          )}
        </div>
      </Row>
      {[...(backups ?? [])].reverse().map((b) => (
        <Row key={b.name} label={<span className="font-mono text-[12px] font-normal">{b.name}</span>} description={`${new Date(b.createdAt).toLocaleString()}${b.name.includes('before-upgrade') ? ' · before an upgrade' : ''}`}>
          <span className="text-[12.5px] tabular-nums text-muted">{formatBytes(b.bytes)}</span>
        </Row>
      ))}
    </Group>
  );
}

function Shortcuts() {
  const { state } = useStore();
  const ctrlSend = state.settings.sendKey === 'ctrl-enter';
  const shortcuts: Array<[string, string]> = [
    ['Send message', ctrlSend ? 'Ctrl+Enter' : 'Enter'],
    ['New line', ctrlSend ? 'Enter' : 'Shift+Enter'],
    ['New conversation with this agent', 'Ctrl+N'],
    ['New agent', 'Ctrl+Shift+N'],
    ['Open settings', 'Ctrl+,'],
    ['Open a chat beside the current one', 'Ctrl+Click or middle-click'],
    ['Open the latest other chat on the right', 'Ctrl+\\'],
    ['Focus the chat on the left or right', 'Ctrl+[  /  Ctrl+]'],
    ['Focus chat 1 to 4', 'Ctrl+1 … Ctrl+4'],
    ['Dock the current chat further left or right', 'Ctrl+Shift+[  /  Ctrl+Shift+]'],
    ['Close the current chat pane', 'Ctrl+Shift+W'],
    ['Close a dialog or menu', 'Esc'],
    ['Dictate: hold to talk, or tap to start and stop', 'Ctrl+Shift+Space'],
    ['Insert dictation while recording', 'Enter'],
    ['Discard dictation while recording', 'Esc'],
  ];
  return (
    <>
      <Title subtitle="Change how messages are sent in Conversations.">Keyboard shortcuts</Title>
      <Group>
        {shortcuts.map(([label, keys]) => (
          <Row key={label} label={<span className="font-normal">{label}</span>}>
            <kbd className="rounded-md border border-line bg-sunken px-1.5 py-0.5 font-sans text-[12px] text-ink-2">{keys}</kbd>
          </Row>
        ))}
      </Group>
    </>
  );
}

function About({ info }: { info: AppInfo | null }) {
  const { state } = useStore();
  const link = (url: string, label: string) => (
    <button onClick={() => void api.openExternal(url)} className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline">
      {label} <ExternalLink size={12} />
    </button>
  );
  return (
    <>
      <Title subtitle="A local workspace for agents on your own Codex and Claude Code subscriptions.">About Nest</Title>
      <Group title="Updates" footer="Updates download in the background and install silently the next time Nest restarts or closes.">
        <Row label="Nest" description={RELEASE_CHANNEL === 'beta' ? 'Beta channel · also receives prereleases' : 'Stable channel'}>
          <UpdateStatus />
        </Row>
      </Group>
      <Group title="Versions">
        <Row label="Nest">
          <span className="text-[13px] text-ink-2">
            {versionLabel(info?.version)}
            {RELEASE_CHANNEL === 'beta' && ' beta'}
          </span>
        </Row>
        <Row label="Codex">
          <span className="text-[13px] text-ink-2">{state.statuses.codex?.version ?? '—'}</span>
        </Row>
        <Row label="Claude Code">
          <span className="text-[13px] text-ink-2">{state.statuses.claude?.version ?? '—'}</span>
        </Row>
        <Row label="Electron · Node">
          <span className="text-[13px] text-ink-2">{info ? `${info.electron} · ${info.node}` : '—'}</span>
        </Row>
        <Row label="Platform">
          <span className="text-[13px] text-ink-2">{info?.platform ?? '—'}</span>
        </Row>
      </Group>
      <Group title="Documentation">
        <Row label="Codex app-server">{link('https://developers.openai.com/codex/app-server', 'Open')}</Row>
        <Row label="Claude Code programmatic use">{link('https://code.claude.com/docs/en/headless', 'Open')}</Row>
        <Row label="Claude Code legal and compliance">{link('https://code.claude.com/docs/en/legal-and-compliance', 'Open')}</Row>
      </Group>
    </>
  );
}

// ---------------------------------------------------------------------------
// Remote access (on the PC) and this device (on a paired phone)

function RemoteAccess() {
  const { attempt, toast } = useStore();
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      void api
        .getRemoteState()
        .then((r) => {
          setRemote(r);
          setPort(String(r.port));
        })
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === 'remote-changed') load();
    });
  }, [load]);
  // The pairing code's countdown, and its disappearance once it's used or expires.
  const [, tick] = useState(0);
  const pairingExpires = remote?.pairing?.expiresAt;
  useEffect(() => {
    if (!pairingExpires) return;
    const id = setInterval(() => {
      tick((n) => n + 1);
      if (Date.parse(pairingExpires) <= Date.now()) load();
    }, 1000);
    return () => clearInterval(id);
  }, [pairingExpires, load]);

  const run = async (fn: () => Promise<RemoteState>) => {
    setBusy(true);
    const next = await attempt(fn);
    setBusy(false);
    if (next) {
      setRemote(next);
      setPort(String(next.port));
    }
  };

  if (!remote) return <Title>Remote access</Title>;
  const ts = remote.tailscale;
  const command = `tailscale serve --bg http://127.0.0.1:${remote.port}`;
  const left = remote.pairing ? Math.max(0, Math.round((Date.parse(remote.pairing.expiresAt) - Date.now()) / 1000)) : 0;

  return (
    <>
      <Title subtitle="Use Nest from your phone. Agents keep running on this PC; your phone opens Nest in its browser over Tailscale, a private network only your own devices can join.">
        Remote access
      </Title>
      <Group
        footer={
          remote.error ? (
            <span className="text-bad">{remote.error}</span>
          ) : (
            'Nest only listens on this PC (127.0.0.1). Tailscale carries the connection to your phone, encrypted; nothing is opened to your network or the internet.'
          )
        }
      >
        <Row label="Allow remote access" description="Paired devices can chat with your agents, approve tool calls and get notifications.">
          <Toggle label="Allow remote access" checked={remote.enabled} onChange={(enabled) => void run(() => api.setRemoteAccess({ enabled }))} />
        </Row>
        <Row label="Port" description="Change it only if another app already uses this one.">
          <input
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onBlur={() => {
              if (Number(port) !== remote.port) void run(() => api.setRemoteAccess({ port: Number(port) }));
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            inputMode="numeric"
            aria-label="Port"
            className={cx(inputClass, 'max-w-[90px] text-center font-mono')}
          />
        </Row>
      </Group>

      {remote.enabled && (
        <>
          <Group
            title="1. Connect with Tailscale"
            footer={
              <>
                The same as running <code className="rounded bg-sunken px-1 font-mono">{command}</code> yourself.
              </>
            }
          >
            {!ts.installed ? (
              <Row label="Install Tailscale" description="Install it on this PC and on your phone, and sign in to both with the same account. It’s free for personal use.">
                <Button size="sm" onClick={() => void api.openExternal('https://tailscale.com/download')}>
                  Download <ExternalLink size={12} />
                </Button>
              </Row>
            ) : !ts.connected ? (
              <Row label="Sign in to Tailscale" description="Tailscale is installed but not connected. Open it from the system tray and sign in.">
                <Button size="sm" onClick={load}>
                  <RefreshCw size={13} /> Check again
                </Button>
              </Row>
            ) : !ts.serving ? (
              <Row label="Give Nest a private web address" description={`Makes ${ts.url ?? 'this PC'} open Nest on the devices in your tailnet.`}>
                <Button size="sm" variant="primary" disabled={busy || !remote.running} onClick={() => void run(() => api.setUpTailscale())}>
                  {busy ? 'Setting up…' : 'Set up'}
                </Button>
              </Row>
            ) : (
              <Row stacked label="Open this on your phone" description="In Safari or Chrome, with Tailscale on. Then add it to your Home Screen.">
                <div className="flex items-center gap-2">
                  {/* The whole address, selectable with one click, in case copying is blocked. */}
                  <span className="min-w-0 flex-1 select-all break-all rounded-md bg-sunken px-2.5 py-1.5 font-mono text-[12.5px] text-ink">{ts.url}</span>
                  <Button
                    size="sm"
                    onClick={() =>
                      void navigator.clipboard.writeText(ts.url ?? '').then(
                        () => toast('Address copied', 'info'),
                        () => toast('Couldn’t copy. Select the address and press Ctrl+C.'),
                      )
                    }
                  >
                    <Copy size={13} /> Copy
                  </Button>
                </div>
              </Row>
            )}
          </Group>

          <Group title="2. Pair your phone" footer="A code works once, for 10 minutes. Removing a device signs it out straight away.">
            {remote.pairing ? (
              <Row label="Enter this code on your phone" description={`Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}>
                <span className="font-mono text-[26px] font-semibold tracking-[0.25em]">{remote.pairing.code}</span>
              </Row>
            ) : (
              <Row label="Pair a phone" description="Shows a one-time code to type in on the phone.">
                <Button size="sm" variant="primary" disabled={busy || !remote.running} onClick={() => void run(() => api.startRemotePairing())}>
                  Pair a phone
                </Button>
              </Row>
            )}
            {remote.devices.map((d) => (
              <Row
                key={d.id}
                label={d.name}
                description={`Paired ${relativeTime(Date.parse(d.createdAt))}${d.lastSeenAt ? ` · last used ${relativeTime(Date.parse(d.lastSeenAt))}` : ''} · notifications ${d.push ? 'on' : 'off'}`}
              >
                <div className="flex items-center gap-1.5">
                  {d.push && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const ok = await attempt(async () => {
                          await api.testRemoteNotification(d.id);
                          return true;
                        });
                        if (ok) toast('Sent', 'info');
                      }}
                    >
                      Test
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      const confirmed = await confirmDialog({
                        title: `Remove ${d.name}?`,
                        message: 'It is signed out of Nest straight away and has to pair again to reconnect.',
                        confirmLabel: 'Remove',
                        tone: 'danger',
                      });
                      if (confirmed) void run(() => api.revokeRemoteDevice(d.id));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </Row>
            ))}
          </Group>
        </>
      )}
    </>
  );
}

function ThisDevice() {
  const { toast } = useStore();
  const [push, setPush] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void pushEnabled().then(setPush).catch(() => setPush(false)), []);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  const iOS = /iPhone|iPad/.test(navigator.userAgent);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      if (on) await enablePush();
      else await disablePush();
      setPush(on);
    } catch (err) {
      toast((err as Error).message);
    }
    setBusy(false);
  };

  return (
    <>
      <Title subtitle="This device is paired with Nest on your PC. The agents run there; this is a window onto them.">This device</Title>
      <Group
        title="Notifications"
        footer={
          iOS && !standalone
            ? 'On iPhone, notifications need Nest on your Home Screen: tap Share → Add to Home Screen, then open Nest from there.'
            : 'You’re notified when an agent replies, fails or needs your approval while Nest on the PC is in the background.'
        }
      >
        <Row label="Notify me on this device" description={pushSupported() ? undefined : 'Not available in this browser.'}>
          <Toggle label="Notifications" checked={Boolean(push)} onChange={(v) => !busy && void toggle(v)} />
        </Row>
      </Group>
      <Group footer="To connect again you’ll need a new code from Settings → Remote access on your PC.">
        <Row label="Disconnect this device" description="Forget the pairing on this device.">
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              const confirmed = await confirmDialog({ title: 'Disconnect this device?', message: 'You’ll need a new pairing code from your PC to connect again.', confirmLabel: 'Disconnect', tone: 'danger' });
              if (!confirmed) return;
              await disablePush().catch(() => {});
              forget();
            }}
          >
            Disconnect
          </Button>
        </Row>
      </Group>
    </>
  );
}
