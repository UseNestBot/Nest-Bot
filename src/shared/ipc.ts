import type {
  ApiKeyState,
  ApiProviderId,
  Agent,
  BrowserInput,
  BrowserStateInfo,
  TerminalStateInfo,
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
  ForgeAccount,
  ForgeIssue,
  ForgeIssueDetail,
  ForgeKind,
  ForgeLookup,
  ForgeMergeMethod,
  ForgeOAuthStart,
  ForgePull,
  ForgePullDetail,
  ForgePullDraft,
  GitBranch,
  GitCommitDetail,
  GitDiff,
  GitIdentity,
  GitInfo,
  GitLogPage,
  GitScope,
  GitStatus,
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

  // A conversation's shared terminal (the agent uses it through Nest's terminal tools)
  /** The terminal and its recent output, or null when it isn't open. */
  terminalAttach(conversationId: string): Promise<{ state: TerminalStateInfo; buffer: string } | null>;
  /** Open the terminal in the conversation's working folder (or return the open one). */
  terminalOpen(conversationId: string, cols: number, rows: number): Promise<{ state: TerminalStateInfo; buffer: string }>;
  terminalInput(conversationId: string, data: string): Promise<void>;
  terminalResize(conversationId: string, cols: number, rows: number): Promise<void>;
  terminalClose(conversationId: string): Promise<void>;
  /** Open a folder in Explorer. Only existing directories are accepted. */
  openFolder(path: string): Promise<void>;
  getAppInfo(): Promise<AppInfo>;
  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Database snapshots in the data folder's backups/, oldest first. */
  listBackups(): Promise<BackupInfo[]>;
  /** Snapshot the database now, then list the snapshots. */
  backUpNow(): Promise<BackupInfo[]>;

  // Git, in a chat's or project's working folder. Paired devices may only read.
  /** The folder's repository, or null repo when it isn't one (and whether git is installed at all). */
  gitStatus(scope: GitScope): Promise<GitStatus>;
  gitBranches(scope: GitScope): Promise<GitBranch[]>;
  /** One changed file's diff: staged, or working tree (untracked files show as all added). */
  gitDiff(scope: GitScope, path: string, staged: boolean): Promise<GitDiff>;
  /** Make the working folder a repository. */
  gitInit(scope: GitScope): Promise<GitStatus>;
  /**
   * Clone into the working folder when it's empty, otherwise into a new folder
   * inside it that then becomes the chat's or project's folder.
   */
  gitClone(scope: GitScope, url: string): Promise<GitStatus>;
  gitStage(scope: GitScope, paths: string[]): Promise<void>;
  gitUnstage(scope: GitScope, paths: string[]): Promise<void>;
  /** Throw away unstaged changes to these paths; untracked ones are deleted. */
  gitDiscard(scope: GitScope, paths: string[]): Promise<void>;
  /** Commit what's staged, or everything with `all`. Returns the short hash. */
  gitCommit(scope: GitScope, message: string, all: boolean): Promise<string>;
  /** Switch branch; a remote branch checks out as a local branch tracking it. */
  gitCheckout(scope: GitScope, branch: string): Promise<void>;
  /** Create a branch from HEAD and switch to it. */
  gitCreateBranch(scope: GitScope, name: string): Promise<void>;
  gitAddRemote(scope: GitScope, name: string, url: string): Promise<void>;
  gitFetch(scope: GitScope): Promise<void>;
  /** Fast-forward only. */
  gitPull(scope: GitScope): Promise<void>;
  /** Push the current branch, setting its upstream the first time. */
  gitPush(scope: GitScope): Promise<void>;
  /** History across HEAD and every branch and tag, newest first in graph order. */
  gitLog(scope: GitScope, skip: number, limit: number): Promise<GitLogPage>;
  gitShowCommit(scope: GitScope, hash: string): Promise<GitCommitDetail>;
  /** One file's change in a commit, against its first parent. */
  gitCommitDiff(scope: GitScope, hash: string, path: string): Promise<GitDiff>;
  /** Give a chat its own worktree on a new (or existing, not checked out) branch, and switch the chat to it. */
  gitCreateWorktree(scope: GitScope, branch: string): Promise<GitStatus>;
  /** Remove the chat's linked worktree and switch it back to the main working tree. `force` loses uncommitted changes. */
  gitRemoveWorktree(scope: GitScope, force: boolean): Promise<GitStatus>;
  /** The installed git and who it commits as. */
  getGitInfo(): Promise<GitInfo>;
  /** Set (or with empty values, unset) the global user.name and user.email. */
  setGitIdentity(identity: GitIdentity): Promise<GitIdentity>;

  // Forges (GitHub, GitLab, Forgejo). Tokens stay in the main process.
  /** Known forge hosts and whether Nest can sign in to each; `force` checks again instead of using the last check. */
  forgeAccounts(force: boolean): Promise<ForgeAccount[]>;
  /** Add a self-hosted forge. */
  forgeAddHost(host: string, kind: ForgeKind): Promise<ForgeAccount>;
  forgeRemoveHost(host: string): Promise<void>;
  /** Check a pasted token, then save it encrypted. It's used ahead of CLI and credential-helper sign-ins. */
  forgeSetToken(host: string, token: string): Promise<ForgeAccount>;
  forgeClearToken(host: string): Promise<ForgeAccount>;
  /** The forge repository behind the working folder, and the current branch's open pull request. */
  forgeLookup(scope: GitScope): Promise<ForgeLookup>;
  forgeListPulls(scope: GitScope, state: 'open' | 'closed' | 'all'): Promise<ForgePull[]>;
  /** A pull request with its checks, reviews and comments. */
  forgeGetPull(scope: GitScope, number: number): Promise<ForgePullDetail>;
  /** The end of a check's log (GitHub Actions and GitLab CI). */
  forgeCheckLog(scope: GitScope, checkId: string): Promise<string>;
  /** Open a pull request for the current branch, pushing it first when needed. */
  forgeCreatePull(scope: GitScope, draft: ForgePullDraft): Promise<ForgePull>;
  forgeComment(scope: GitScope, number: number, body: string): Promise<void>;
  /** Merge a pull request; `deleteBranch` deletes its head branch too when it's in the same repository. */
  forgeMergePull(scope: GitScope, number: number, method: ForgeMergeMethod, deleteBranch: boolean): Promise<void>;
  forgeListIssues(scope: GitScope, state: 'open' | 'closed'): Promise<ForgeIssue[]>;
  forgeGetIssue(scope: GitScope, number: number): Promise<ForgeIssueDetail>;
  forgeCreateIssue(scope: GitScope, title: string, body: string): Promise<ForgeIssue>;
  forgeCommentIssue(scope: GitScope, number: number, body: string): Promise<void>;
  /** Start a browser (OAuth device flow) sign-in; Nest saves the token when the user approves it. */
  forgeStartSignIn(host: string): Promise<ForgeOAuthStart>;
  forgeCancelSignIn(host: string): Promise<void>;
  /** Forget a browser sign-in. */
  forgeSignOut(host: string): Promise<ForgeAccount>;
  /** Set the OAuth app client ID for a host's browser sign-in, or null to clear it. */
  forgeSetOAuthClient(host: string, clientId: string | null): Promise<ForgeAccount>;

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
  'terminalAttach',
  'terminalOpen',
  'terminalInput',
  'terminalResize',
  'terminalClose',
  'openFolder',
  'getAppInfo',
  'getSettings',
  'updateSettings',
  'listBackups',
  'backUpNow',
  'gitStatus',
  'gitBranches',
  'gitDiff',
  'gitInit',
  'gitClone',
  'gitStage',
  'gitUnstage',
  'gitDiscard',
  'gitCommit',
  'gitCheckout',
  'gitCreateBranch',
  'gitAddRemote',
  'gitFetch',
  'gitPull',
  'gitPush',
  'gitLog',
  'gitShowCommit',
  'gitCommitDiff',
  'gitCreateWorktree',
  'gitRemoveWorktree',
  'getGitInfo',
  'setGitIdentity',
  'forgeAccounts',
  'forgeAddHost',
  'forgeRemoveHost',
  'forgeSetToken',
  'forgeClearToken',
  'forgeLookup',
  'forgeListPulls',
  'forgeGetPull',
  'forgeCheckLog',
  'forgeCreatePull',
  'forgeComment',
  'forgeMergePull',
  'forgeListIssues',
  'forgeGetIssue',
  'forgeCreateIssue',
  'forgeCommentIssue',
  'forgeStartSignIn',
  'forgeCancelSignIn',
  'forgeSignOut',
  'forgeSetOAuthClient',
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
