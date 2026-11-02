import type {
  ApiKeyState,
  ApiProviderId,
  Agent,
  BrowserInput,
  BrowserStateInfo,
  AgentAccess,
  ConnectorInventory,
  AppInfo,
  Schedule,
  ScheduleDraft,
  AgentDraft,
  AppSettings,
  BackupInfo,
  Attachment,
  Conversation,
  ConversationDetail,
  Handoff,
  InboxItem,
  LoginStart,
  MemoryNote,
  MemoryScope,
  ModelOption,
  NestEvent,
  PermissionSettings,
  Project,
  ProjectDraft,
  ProviderId,
  ProviderStatus,
  RemoteState,
  UpdateState,
} from './types';
import type { DictationModelStatus } from './dictation';

export interface ConversationPatch {
  title?: string;
  provider?: ProviderId;
  model?: string | null;
  effort?: string | null;
  workspace?: string | null;
  permissions?: PermissionSettings;
  /** Move the chat to a project, or out of every project with null. */
  projectId?: string | null;
}

export interface HandoffRequest {
  sourceConversationId: string;
  targetAgentId: string;
  task: string;
  context: string;
}

/**
 * The complete surface the renderer can reach. Every method is implemented in
 * src/main/ipc.ts and exposed one-to-one by src/preload/index.ts.
 */
export interface NestApi {
  // Providers
  getProviderStatuses(): Promise<ProviderStatus[]>;
  refreshProviders(): Promise<ProviderStatus[]>;
  /** Whether each API provider has a saved key (masked hint only; keys never leave the main process). */
  getApiKeyStates(): Promise<ApiKeyState[]>;
  /** Save (encrypted) and check a key, then return its masked state. */
  setApiKey(provider: ApiProviderId, key: string): Promise<ApiKeyState>;
  clearApiKey(provider: ApiProviderId): Promise<ApiKeyState>;
  listModels(provider: ProviderId): Promise<ModelOption[]>;
  startLogin(provider: ProviderId): Promise<LoginStart>;
  signOut(provider: ProviderId): Promise<void>;
  /** The provider's own MCP servers and apps. Cached; `refresh` asks the provider again (slow). */
  listConnectors(provider: ProviderId, refresh?: boolean): Promise<ConnectorInventory>;

  // Agents
  listAgents(): Promise<Agent[]>;
  createAgent(draft: AgentDraft): Promise<Agent>;
  updateAgent(id: string, draft: AgentDraft): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;
  getAgentAccess(id: string): Promise<AgentAccess>;
  setAgentAccess(id: string, access: AgentAccess): Promise<AgentAccess>;
  /** Put an agent in a project (its folder and team), or null for none. Its chats stay where they are. */
  setAgentProject(agentId: string, projectId: string | null): Promise<Agent>;

  // Projects (bot families)
  listProjects(): Promise<Project[]>;
  /** A null workspace gets a folder of its own under Nest's default folder. */
  createProject(draft: ProjectDraft): Promise<Project>;
  updateProject(id: string, draft: ProjectDraft): Promise<Project>;
  /** Members become standalone agents; the project's memory notes are deleted. */
  deleteProject(id: string): Promise<void>;

  // Conversations
  listConversations(): Promise<Conversation[]>;
  /** projectId: the project the chat works on; omitted or null = none. */
  createConversation(agentId: string, projectId?: string | null): Promise<Conversation>;
  getConversation(id: string): Promise<ConversationDetail | null>;
  updateConversation(id: string, patch: ConversationPatch): Promise<Conversation>;
  deleteConversation(id: string): Promise<void>;

  // Runs
  sendMessage(conversationId: string, text: string, attachments: Attachment[]): Promise<{ runId: string }>;
  /** Send a message to the agent while it is working; it takes the message at its next step. */
  steerRun(conversationId: string, text: string, attachments: Attachment[]): Promise<{ runId: string }>;
  cancelRun(conversationId: string): Promise<void>;
  respondApproval(approvalId: string, choiceId: string): Promise<void>;

  // Memory
  listMemory(): Promise<MemoryNote[]>;
  /** `owner`: the agent id for agent notes, the project id for project notes, null for shared ones. */
  createMemory(scope: MemoryScope, owner: string | null, content: string, sourceMessageId?: string | null): Promise<MemoryNote>;
  updateMemory(id: string, patch: { content?: string; enabled?: boolean }): Promise<MemoryNote>;
  deleteMemory(id: string): Promise<void>;

  // Schedules
  listSchedules(): Promise<Schedule[]>;
  createSchedule(draft: ScheduleDraft): Promise<Schedule>;
  updateSchedule(id: string, draft: ScheduleDraft): Promise<Schedule>;
  deleteSchedule(id: string): Promise<void>;
  runScheduleNow(id: string): Promise<Schedule>;

  // Handoffs & inbox
  startHandoff(req: HandoffRequest): Promise<Handoff>;
  listHandoffs(): Promise<Handoff[]>;
  listInbox(): Promise<InboxItem[]>;
  markInboxRead(id: string): Promise<void>;

  // System
  pickFolder(): Promise<string | null>;
  pickFiles(): Promise<Attachment[]>;
  /** Save a clipboard image to Nest's data folder and return it as an attachment. */
  savePastedImage(data: Uint8Array, mimeType: string): Promise<Attachment>;
  openExternal(url: string): Promise<void>;

  // An agent's built-in browser (live viewport)
  /** Start or stop watching an agent's browser; returns its state and latest frame, or null when it isn't open. */
  browserWatch(agentId: string, watching: boolean): Promise<{ state: BrowserStateInfo; frame: string | null } | null>;
  browserInput(agentId: string, input: BrowserInput): Promise<void>;
  browserNavigate(agentId: string, action: 'back' | 'forward' | 'reload' | 'close' | 'open', url?: string): Promise<void>;
  /** Open a folder in Explorer. Only existing directories are accepted. */
  openFolder(path: string): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Database snapshots in the data folder's backups/, oldest first. */
  listBackups(): Promise<BackupInfo[]>;
  /** Snapshot the database now, then list the snapshots. */
  backUpNow(): Promise<BackupInfo[]>;

  // Updates (GitHub releases, installed silently by the NSIS installer)
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  /** Quit and run the downloaded installer silently; Nest reopens when it finishes. */
  installUpdate(): Promise<void>;

  // Voice dictation (the model itself runs in a renderer worker)
  listDictationModels(): Promise<DictationModelStatus[]>;
  deleteDictationModel(id: string): Promise<void>;

  // Remote access (phone/web over Tailscale). Desktop only: paired devices can't call these.
  getRemoteState(): Promise<RemoteState>;
  setRemoteAccess(patch: { enabled?: boolean; port?: number }): Promise<RemoteState>;
  /** Open a one-time pairing code (valid 10 minutes), replacing any open one. */
  startRemotePairing(): Promise<RemoteState>;
  revokeRemoteDevice(id: string): Promise<RemoteState>;
  /** Run `tailscale serve` so https://<machine>.ts.net reaches Nest. */
  setUpTailscale(): Promise<RemoteState>;
  /** Send a test push notification to one paired device. */
  testRemoteNotification(deviceId: string): Promise<void>;

  onEvent(listener: (event: NestEvent) => void): () => void;
}

export const IPC_EVENT_CHANNEL = 'nest:event';

/** Method names, used by preload and main to build the bridge without stringly typed drift. */
export const API_METHODS = [
  'getProviderStatuses',
  'refreshProviders',
  'getApiKeyStates',
  'setApiKey',
  'clearApiKey',
  'listModels',
  'startLogin',
  'signOut',
  'listConnectors',
  'listAgents',
  'createAgent',
  'updateAgent',
  'deleteAgent',
  'getAgentAccess',
  'setAgentAccess',
  'setAgentProject',
  'listProjects',
  'createProject',
  'updateProject',
  'deleteProject',
  'listConversations',
  'createConversation',
  'getConversation',
  'updateConversation',
  'deleteConversation',
  'sendMessage',
  'steerRun',
  'cancelRun',
  'respondApproval',
  'listMemory',
  'createMemory',
  'updateMemory',
  'deleteMemory',
  'listSchedules',
  'createSchedule',
  'updateSchedule',
  'deleteSchedule',
  'runScheduleNow',
  'startHandoff',
  'listHandoffs',
  'listInbox',
  'markInboxRead',
  'pickFolder',
  'pickFiles',
  'savePastedImage',
  'openExternal',
  'browserWatch',
  'browserInput',
  'browserNavigate',
  'openFolder',
  'getAppInfo',
  'getSettings',
  'updateSettings',
  'listBackups',
  'backUpNow',
  'getUpdateState',
  'checkForUpdates',
  'installUpdate',
  'listDictationModels',
  'deleteDictationModel',
  'getRemoteState',
  'setRemoteAccess',
  'startRemotePairing',
  'revokeRemoteDevice',
  'setUpTailscale',
  'testRemoteNotification',
] as const satisfies readonly Exclude<keyof NestApi, 'onEvent'>[];

export type ApiMethod = (typeof API_METHODS)[number];
