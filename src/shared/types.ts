// Domain types shared by the main process and the renderer.
// Nothing in here may carry credentials.

/** Coding agents installed on this computer, signed in through their own tools. */
export type CliProviderId = 'claude' | 'codex' | 'cursor' | 'gemini' | 'grok';
/** Chat models reached with an API key the user saved in Nest (billed per token to that key). */
export type ApiProviderId = 'openrouter' | 'openai-api' | 'anthropic-api' | 'gemini-api' | 'xai-api';
export type ProviderId = CliProviderId | ApiProviderId;

export const CLI_PROVIDERS: CliProviderId[] = ['claude', 'codex', 'cursor', 'gemini', 'grok'];
export const API_PROVIDERS: ApiProviderId[] = ['openrouter', 'openai-api', 'anthropic-api', 'gemini-api', 'xai-api'];
export const PROVIDERS: ProviderId[] = [...CLI_PROVIDERS, ...API_PROVIDERS];

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  grok: 'Grok CLI',
  openrouter: 'OpenRouter',
  'openai-api': 'OpenAI API',
  'anthropic-api': 'Anthropic API',
  'gemini-api': 'Gemini API',
  'xai-api': 'xAI API',
};

export function isProviderId(p: unknown): p is ProviderId {
  return typeof p === 'string' && (PROVIDERS as string[]).includes(p);
}

export function isApiProvider(p: ProviderId): p is ApiProviderId {
  return (API_PROVIDERS as string[]).includes(p);
}

/** Which permission controls a provider honours. ACP agents (Cursor, Gemini CLI, Grok CLI) use the Claude-style modes. */
export function permissionStyle(p: ProviderId): 'claude' | 'codex' | 'none' {
  if (p === 'codex') return 'codex';
  return isApiProvider(p) ? 'none' : 'claude';
}

/** API-key state for the renderer. Never carries the key, only a masked hint. */
export interface ApiKeyState {
  provider: ApiProviderId;
  set: boolean;
  /** e.g. "…a1b2"; null when no key is saved. */
  hint: string | null;
}

export type AvatarShape = 'blob' | 'square' | 'diamond' | 'leaf' | 'pill' | 'hex' | 'triangle';
export type AvatarEyes = 'dots' | 'happy' | 'wide' | 'sleepy';

export interface AvatarSpec {
  shape: AvatarShape;
  color: string;
  eyes: AvatarEyes;
}

/** Claude Code permission modes we allow. `bypassPermissions` is deliberately absent. */
export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan';
/** Codex sandbox modes selectable directly. Full access only comes from skipPermissions. */
export type CodexSandboxMode = 'read-only' | 'workspace-write';
/** Codex approval policies selectable directly. `never` only comes from skipPermissions. */
export type CodexApprovalPolicy = 'on-request' | 'untrusted';

export interface PermissionSettings {
  claudeMode: ClaudePermissionMode;
  codexSandbox: CodexSandboxMode;
  codexApproval: CodexApprovalPolicy;
  /**
   * Skip every approval: Claude Code bypassPermissions, Codex full access with
   * no approvals, and Nest's own tool approvals answered automatically. Only
   * honoured while Settings → Permissions allows it (AppSettings.allowSkipPermissions).
   * true / false is an explicit choice; undefined inherits (conversation → agent →
   * AppSettings.skipPermissionsByDefault).
   */
  skipPermissions?: boolean;
}

/** The modes a provider actually runs with, after Nest applies skipPermissions. */
export interface EffectivePermissions {
  claudeMode: ClaudePermissionMode | 'bypassPermissions';
  codexSandbox: CodexSandboxMode | 'danger-full-access';
  codexApproval: CodexApprovalPolicy | 'never';
  skipped: boolean;
}

/**
 * Whether a run skips permissions: the conversation's explicit choice, else the
 * agent's, else the global default — and never unless Settings allows skipping.
 */
export function resolveSkip(
  conversation: PermissionSettings | null | undefined,
  agent: PermissionSettings | null | undefined,
  settings: Pick<AppSettings, 'allowSkipPermissions' | 'skipPermissionsByDefault'>,
): boolean {
  if (!settings.allowSkipPermissions) return false;
  return conversation?.skipPermissions ?? agent?.skipPermissions ?? settings.skipPermissionsByDefault;
}

export function effectivePermissions(p: PermissionSettings, skip: boolean): EffectivePermissions {
  if (skip) return { claudeMode: 'bypassPermissions', codexSandbox: 'danger-full-access', codexApproval: 'never', skipped: true };
  return { claudeMode: p.claudeMode, codexSandbox: p.codexSandbox, codexApproval: p.codexApproval, skipped: false };
}

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  claudeMode: 'default',
  codexSandbox: 'workspace-write',
  codexApproval: 'on-request',
};

export interface Agent {
  id: string;
  name: string;
  avatar: AvatarSpec;
  instructions: string;
  provider: ProviderId;
  model: string | null;
  workspace: string | null;
  /** The project (bot family) the agent belongs to: it shows in that folder and is a teammate there. Its chats each have their own project. */
  projectId: string | null;
  pinned: boolean;
  permissions: PermissionSettings;
  createdAt: number;
  updatedAt: number;
}

export type AgentDraft = Omit<Agent, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * A family of agents working on the same thing. Members share the brief, a
 * working folder and project memory, and know each other for delegation.
 */
export interface Project {
  id: string;
  name: string;
  /** What the project is about; every member receives it as standing context. */
  brief: string;
  /** Shared working folder for members without a folder of their own. null = Nest's default folder. */
  workspace: string | null;
  color: string;
  createdAt: number;
  updatedAt: number;
}

export type ProjectDraft = Pick<Project, 'name' | 'brief' | 'workspace' | 'color'>;

export interface Conversation {
  id: string;
  agentId: string;
  title: string;
  provider: ProviderId;
  model: string | null;
  /** Reasoning effort; null means the provider/model default. */
  effort: string | null;
  workspace: string | null;
  permissions: PermissionSettings;
  createdAt: number;
  updatedAt: number;
  preview: string;
  /** Present when this conversation was created by a handoff. */
  handoffId: string | null;
  /**
   * The project this chat works on. It decides the brief, shared folder, project
   * memory and teammates the agent gets here. New chats start outside any
   * project; any chat can move into one, so one agent can work across projects.
   */
  projectId: string | null;
}

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageStatus = 'complete' | 'streaming' | 'interrupted' | 'error';
export type MessageKind = 'chat' | 'handoff-result' | 'notice';

export interface Attachment {
  path: string;
  name: string;
  isImage: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  runId: string | null;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  status: MessageStatus;
  error: string | null;
  attachments: Attachment[];
  /** For handoff-result messages: the conversation that produced the result. */
  linkConversationId: string | null;
  createdAt: number;
}

/** `note` is text the agent wrote between steps; its full text is in `detail`. */
export type ActivityKind = 'command' | 'file' | 'tool' | 'search' | 'mcp' | 'context' | 'info' | 'approval' | 'note';
export type ActivityStatus = 'running' | 'done' | 'failed' | 'declined';

/** A file change in an edit step: either before/after text, or a unified diff. */
export interface FileEdit {
  path: string;
  before?: string;
  after?: string;
  diff?: string;
}

/** Structured input of a step, for the step's expanded view. Older steps have none. */
export interface ActivityMeta {
  /** The full command, for command steps. */
  command?: string;
  /** What the agent said the command does. */
  description?: string;
  cwd?: string;
  exitCode?: number | null;
  path?: string;
  edits?: FileEdit[];
  /** Search pattern or query. */
  pattern?: string;
}

export interface Activity {
  id: string;
  runId: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  output: string | null;
  meta: ActivityMeta | null;
  status: ActivityStatus;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = 'running' | 'completed' | 'interrupted' | 'failed';

export interface Usage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
}

export interface Run {
  id: string;
  conversationId: string;
  provider: ProviderId;
  model: string | null;
  sessionId: string | null;
  status: RunStatus;
  error: string | null;
  usage: Usage | null;
  includedNoteIds: string[];
  startedAt: number;
  endedAt: number | null;
}

export interface ApprovalChoice {
  id: string;
  label: string;
  tone: 'primary' | 'neutral' | 'danger';
}

export type ApprovalStatus = 'pending' | 'resolved' | 'expired';

export interface Approval {
  id: string;
  runId: string;
  conversationId: string;
  provider: ProviderId;
  title: string;
  action: string;
  target: string | null;
  reason: string | null;
  detail: string | null;
  choices: ApprovalChoice[];
  status: ApprovalStatus;
  decision: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export type MemoryScope = 'agent' | 'project' | 'shared';

export interface MemoryNote {
  id: string;
  scope: MemoryScope;
  agentId: string | null;
  /** For project notes: the project every member shares it with. */
  projectId: string | null;
  content: string;
  enabled: boolean;
  sourceMessageId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type HandoffStatus = 'running' | 'completed' | 'failed';

export interface Handoff {
  id: string;
  sourceConversationId: string;
  targetAgentId: string;
  targetConversationId: string;
  task: string;
  context: string;
  status: HandoffStatus;
  result: string | null;
  createdAt: number;
  completedAt: number | null;
}

export type InboxKind = 'handoff' | 'approval' | 'failure';

export interface InboxItem {
  id: string;
  kind: InboxKind;
  conversationId: string | null;
  refId: string | null;
  title: string;
  body: string;
  createdAt: number;
  readAt: number | null;
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// Provider state

export type ConnectionState =
  | 'checking'
  | 'not-installed'
  | 'signed-out'
  | 'api-key'
  | 'ready'
  | 'error';

export interface RateLimitWindow {
  label: string;
  usedPercent: number | null;
  resetsAt: number | null;
}

export interface ProviderStatus {
  provider: ProviderId;
  state: ConnectionState;
  executable: string | null;
  version: string | null;
  /** Human readable account description, e.g. "ChatGPT Plus" or "Claude Max". No secrets. */
  account: string | null;
  authMethod: string | null;
  /** Concrete instruction for the user when the provider is not ready. */
  action: string | null;
  detail: string | null;
  rateLimits: RateLimitWindow[];
  rateLimited: boolean;
  notes: string[];
  checkedAt: number;
}

export interface ModelOption {
  id: string;
  label: string;
  isDefault: boolean;
  /** Reasoning effort levels this model accepts, when the provider reports them. */
  efforts: string[];
  defaultEffort: string | null;
  /** Relative cost to run, 1 (cheapest) to 4 (priciest), when known. Shown as signal bars. */
  cost?: 1 | 2 | 3 | 4;
}

export interface LoginStart {
  kind: 'browser' | 'terminal';
  message: string;
  command: string | null;
}

// ---------------------------------------------------------------------------
// Events pushed from main to renderer

export type NestEvent =
  | { type: 'message'; message: Message }
  | { type: 'activity'; activity: Activity; conversationId: string }
  | { type: 'run'; run: Run }
  | { type: 'approval'; approval: Approval }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'provider-status'; status: ProviderStatus }
  | { type: 'inbox-changed' }
  | { type: 'handoff'; handoff: Handoff }
  /** Ask the window to show a conversation (e.g. a notification was clicked). */
  | { type: 'open-conversation'; conversationId: string }
  | { type: 'conversation-deleted'; conversationId: string }
  | { type: 'schedules-changed' }
  | { type: 'agents-changed' }
  | { type: 'projects-changed' }
  /** A dictation model file is downloading (main serves model files on demand). */
  | { type: 'dictation-download'; modelId: string; loaded: number; total: number; done: boolean }
  | { type: 'browser-state'; state: BrowserStateInfo }
  /** A JPEG data URL of the agent's browser, sent only while a viewport watches it. */
  | { type: 'browser-frame'; agentId: string; data: string }
  | { type: 'terminal-state'; state: TerminalStateInfo }
  /** Output from a conversation's shared terminal (raw, with escape codes). */
  | { type: 'terminal-data'; conversationId: string; data: string }
  | { type: 'update'; state: UpdateState }
  /** Remote access changed (a phone paired, a device was removed, the server started or stopped). */
  | { type: 'remote-changed' }
  /** Something in a repository changed (a commit, a checkout, the index): views of it should refresh. */
  | { type: 'git-changed'; root: string };

// ---------------------------------------------------------------------------
// Git

/**
 * Which chat or project a git call is about. The main process resolves its
 * working folder; the renderer never sends a folder path of its own.
 */
export interface GitScope {
  kind: 'conversation' | 'project';
  id: string;
}

export type GitChange = 'modified' | 'typechange' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted';

/** One changed path. `staged` and `unstaged` are what changed in the index and in the working tree. */
export interface GitFileChange {
  /** Relative to the repository root, with forward slashes. */
  path: string;
  /** The path before a rename or copy. */
  origPath: string | null;
  staged: GitChange | null;
  unstaged: GitChange | null;
}

export interface GitRemote {
  name: string;
  /** Any user name or token embedded in the URL is removed. */
  url: string;
}

export interface GitRepoStatus {
  root: string;
  /** null when HEAD is detached. */
  branch: string | null;
  /** Short hash of HEAD; null before the first commit. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  /** More changed paths than Nest lists. */
  truncated: boolean;
  /** An operation git is in the middle of, waiting for the user. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  remotes: GitRemote[];
}

/** A chat's or project's working folder as git sees it. */
export interface GitStatus {
  folder: string;
  /** Whether git is installed; null version when it isn't. */
  git: { available: boolean; version: string | null };
  /** null when the folder isn't in a repository. */
  repo: GitRepoStatus | null;
}

export interface GitBranch {
  /** e.g. "main", or "origin/main" for a remote branch. */
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  /** Short hash. */
  head: string;
  subject: string;
  /** Committer date, ms since epoch. */
  date: number;
}

export interface GitDiff {
  path: string;
  /** Unified diff text, without colour. */
  text: string;
  binary: boolean;
  truncated: boolean;
}

/** A phone or browser paired with this Nest for remote access. */
export interface RemoteDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Whether the device subscribed to push notifications. */
  push: boolean;
}

/** Remote access as the desktop Settings screen shows it. */
export interface RemoteState {
  enabled: boolean;
  port: number;
  /** The server is listening on 127.0.0.1:port. */
  running: boolean;
  /** Why the server could not start (e.g. the port is taken). */
  error: string | null;
  localUrl: string;
  tailscale: {
    installed: boolean;
    /** Signed in and connected to a tailnet. */
    connected: boolean;
    /** https://<machine>.<tailnet>.ts.net, when connected. */
    url: string | null;
    /** `tailscale serve` forwards that URL to Nest. */
    serving: boolean;
  };
  devices: RemoteDevice[];
  /** A one-time code for pairing a new device, while one is open. */
  pairing: { code: string; expiresAt: string } | null;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  runs: Run[];
  activities: Activity[];
  approvals: Approval[];
}

export type SendKey = 'enter' | 'ctrl-enter';
export type ThemeSetting = 'system' | 'light' | 'dark';
export type ChatWidth = 'narrow' | 'default' | 'wide';
export type AccentColor = 'blue' | 'violet' | 'green' | 'orange' | 'pink' | 'graphite';
export type Density = 'compact' | 'default' | 'comfortable';
export type DarkStyle = 'dim' | 'black';

/** Interface zoom, in percent. */
export const UI_SCALE_MIN = 80;
export const UI_SCALE_MAX = 130;
export const UI_SCALE_STEP = 5;

/** Which background notifications Nest sends (desktop and paired phones). */
export interface NotifyOn {
  finished: boolean;
  failed: boolean;
  approval: boolean;
}

/** A database snapshot in the backups folder. */
export interface BackupInfo {
  name: string;
  path: string;
  bytes: number;
  createdAt: number;
}

export interface AppSettings {
  // Appearance
  theme: ThemeSetting;
  /** Dark theme variant: the default dim grey, or true black for OLED screens. */
  darkStyle: DarkStyle;
  accentColor: AccentColor;
  /** Zoom for the whole interface, UI_SCALE_MIN–UI_SCALE_MAX percent. */
  uiScale: number;
  /** Spacing scale: tighter or roomier padding and gaps everywhere. */
  density: Density;
  chatWidth: ChatWidth;
  /** Font family names tried before the built-in stacks. Empty = built-in. */
  uiFont: string;
  codeFont: string;
  /** Turn off animations and transitions. */
  reduceMotion: boolean;
  // General
  /** Folder agents work in when a conversation has no workspace. null = Documents/Nest. */
  defaultWorkspace: string | null;
  /** Provider preselected for new agents. */
  defaultProvider: ProviderId;
  /** Model preselected for new agents, per provider. Missing = the provider's default. */
  defaultModels: Partial<Record<ProviderId, string>>;
  /** Give agents Nest's own tools (profile, memory, delegation, schedules) over MCP. */
  agentTools: boolean;
  /** Desktop notification when a reply finishes or needs approval while Nest is in the background. */
  notifyWhenUnfocused: boolean;
  /** Which events notify, on the desktop and on paired phones. */
  notifyOn: NotifyOn;
  /** Play the system sound with failure and approval notifications. */
  notificationSound: boolean;
  // Conversation display
  sendKey: SendKey;
  expandActivity: boolean;
  showUsage: boolean;
  // Voice
  /** Local Whisper model used for dictation (see shared/dictation.ts). */
  dictationModel: string;
  // Permissions
  /** Permission defaults for new agents. */
  defaultPermissions: PermissionSettings;
  /** Off by default: when an API key is the active auth method we refuse to run. */
  allowApiKeyBilling: boolean;
  /** Off by default. Lets conversations and agents use "Skip permissions". */
  allowSkipPermissions: boolean;
  /** With skipping allowed: every agent skips unless it (or a conversation) is set to always ask. */
  skipPermissionsByDefault: boolean;
  /** On by default: an agent's terminal commands and keystrokes wait for approval even when it skips permissions. */
  terminalAlwaysAsk: boolean;
  // Context
  /** Max characters of transcript transferred when switching provider or handing off. */
  transferBudgetChars: number;
  // Providers
  claudePath: string | null;
  codexPath: string | null;
  cursorPath: string | null;
  geminiPath: string | null;
  grokPath: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  darkStyle: 'dim',
  accentColor: 'blue',
  uiScale: 100,
  density: 'default',
  chatWidth: 'default',
  uiFont: '',
  codeFont: '',
  reduceMotion: false,
  defaultWorkspace: null,
  defaultProvider: 'claude',
  defaultModels: {},
  agentTools: true,
  notifyWhenUnfocused: true,
  notifyOn: { finished: true, failed: true, approval: true },
  notificationSound: true,
  sendKey: 'enter',
  expandActivity: false,
  showUsage: true,
  dictationModel: 'whisper-base.en',
  defaultPermissions: DEFAULT_PERMISSIONS,
  allowApiKeyBilling: false,
  allowSkipPermissions: false,
  skipPermissionsByDefault: false,
  terminalAlwaysAsk: true,
  transferBudgetChars: 8000,
  claudePath: null,
  codexPath: null,
  cursorPath: null,
  geminiPath: null,
  grokPath: null,
};

/** Read-only facts about this installation, for Settings. */
export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  platform: string;
  dataDir: string;
  databaseBytes: number;
  /** The folder actually used when a conversation has no workspace. */
  effectiveDefaultWorkspace: string;
  counts: { agents: number; conversations: number; messages: number; notes: number };
}

/** A GitHub release the updater can install. */
export interface UpdateRelease {
  version: string;
  build: number;
  /** "v0.1.0:123" */
  label: string;
  tag: string;
  prerelease: boolean;
  url: string;
  bytes: number;
}

export type UpdateState =
  /** Not the Windows installer build (dev, Linux): updates come from the releases page. */
  | { status: 'unsupported'; reason: string }
  | { status: 'idle'; checkedAt: number | null }
  | { status: 'checking' }
  | { status: 'downloading'; release: UpdateRelease; received: number; total: number }
  /** Downloaded and verified: installs silently on restart, or when Nest next quits. */
  | { status: 'ready'; release: UpdateRelease }
  | { status: 'error'; message: string; checkedAt: number | null };

// ---------------------------------------------------------------------------
// Schedules (recurring agent tasks)

export type ScheduleCadence =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; time: string; weekday: number }
  | { kind: 'interval'; minutes: number };

export interface Schedule {
  id: string;
  agentId: string;
  title: string;
  prompt: string;
  cadence: ScheduleCadence;
  /** 'new' starts a fresh conversation each run; 'same' keeps appending to one. */
  target: 'new' | 'same';
  conversationId: string | null;
  /**
   * The project each run works in: its chats appear there and use the project's
   * brief, memory, teammates and shared folder. Defaults to the agent's project.
   */
  projectId: string | null;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastConversationId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** projectId omitted: keep the schedule's project (or, for a new one, use the agent's). null: no project. */
export type ScheduleDraft = Pick<Schedule, 'agentId' | 'title' | 'prompt' | 'cadence' | 'target' | 'enabled'> & { projectId?: string | null };

// ---------------------------------------------------------------------------
// Connectors (MCP servers and apps the providers already have) and browser use.
// Nest only lists them and narrows what an agent may use; sign-in stays with the provider.

export type ConnectorStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'unknown';

export interface Connector {
  provider: ProviderId;
  /** Stable id used in an agent's allowlist: the server name (Claude) or `server:<name>` / `app:<id>` (Codex). */
  id: string;
  name: string;
  /** Where the provider gets it from, e.g. "claude.ai", "User config", "ChatGPT app". */
  source: string;
  status: ConnectorStatus;
  detail: string | null;
  /** Codex: the plugin that bundles this server, if any. */
  plugin?: string | null;
}

export interface BrowserSupport {
  /** The provider has an official browser option that works under Nest. */
  available: boolean;
  /** Set up on this computer: true, false (see `missing`), or null when it can't be checked. */
  ready: boolean | null;
  /** What the user must install or enable before the browser works. */
  missing: string[];
  /** What the browser option does, or why it is not available. */
  note: string;
}

export interface ConnectorInventory {
  provider: ProviderId;
  connectors: Connector[];
  browser: BrowserSupport;
  error: string | null;
  checkedAt: number;
}

export interface AgentAccess {
  /** null: everything the provider has configured. Otherwise only these connector ids. */
  claudeConnectors: string[] | null;
  codexConnectors: string[] | null;
  /** Let the agent use a browser. */
  browser: boolean;
  /**
   * Which browser: 'nest' = the agent's own built-in Nest browser (works for every
   * provider that loads Nest's tools, shown live in the conversation); 'chrome' =
   * the user's Chrome through Claude in Chrome (Claude Code only).
   */
  browserMode: BrowserMode;
  /** Let the agent use each chat's shared terminal (the terminal_* tools). Off by default: it runs outside the provider's sandbox. */
  terminal: boolean;
}

export type BrowserMode = 'nest' | 'chrome';

export const DEFAULT_AGENT_ACCESS: AgentAccess = { claudeConnectors: null, codexConnectors: null, browser: false, browserMode: 'nest', terminal: false };

/** The agent's built-in browser, as shown in the live viewport. */
export interface BrowserStateInfo {
  agentId: string;
  url: string;
  title: string;
  loading: boolean;
  /** What the agent is doing right now ("Clicking “Sign in”"), or null. */
  action: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  closed?: boolean;
}

/** A conversation's shared terminal, which the user and the agent both type into. */
export interface TerminalStateInfo {
  conversationId: string;
  shell: string;
  /** The folder the shell started in. */
  cwd: string;
  /** A command is running (the shell is not at its prompt). */
  busy: boolean;
  /** What the agent is running right now, or null. */
  action: string | null;
  lastExit: number | null;
  /** A real pseudo-terminal; false when Nest falls back to plain pipes (no full-screen programs). */
  pty: boolean;
  closed?: boolean;
}

/** Mouse and keyboard input when the user takes over the agent's browser. Coordinates are page pixels. */
export interface BrowserInput {
  type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel' | 'keyDown' | 'keyUp' | 'char';
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  deltaX?: number;
  deltaY?: number;
  key?: string;
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>;
}
