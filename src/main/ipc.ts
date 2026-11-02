import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { API_METHODS, type ApiMethod, type NestApi } from '@shared/ipc';
import type { AgentDraft, AppSettings, BackupInfo, Attachment, ConversationDetail, NestEvent, ProjectDraft, ProviderId } from '@shared/types';
import { API_PROVIDERS, PROVIDERS, isProviderId, type ApiProviderId } from '@shared/types';
import type { ApiKeyStore } from './apiKeys';
import type { NestDb } from './db';
import type { ProviderRegistry, RunManager } from './runs';
import type { Scheduler } from './scheduler';
import type { AgentBrowserHost } from './agentBrowser';
import { sanitizeAccess, type ConnectorService } from './connectors';
import type { ModelStore } from './models';
import type { Updater } from './updater';
import type { RemoteHost } from './remote/host';
import { sanitizePermissions, sanitizeSettings } from './settings';
import { UserFacingError } from './runs';

export type Handlers = { [K in ApiMethod]: (...args: Parameters<NestApi[K]>) => ReturnType<NestApi[K]> | Awaited<ReturnType<NestApi[K]>> };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const PASTED_IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

function assertProvider(p: unknown): ProviderId {
  if (!isProviderId(p)) throw new UserFacingError('Unknown provider');
  return p;
}

function assertString(v: unknown, name: string, max = 200_000): string {
  if (typeof v !== 'string') throw new UserFacingError(`${name} must be text`);
  if (v.length > max) throw new UserFacingError(`${name} is too long`);
  return v;
}

/** Validate agent drafts at the trust boundary; the renderer is not trusted to send well-formed data. */
function sanitizeDraft(d: AgentDraft): AgentDraft {
  const name = assertString(d?.name, 'Name', 80).trim();
  if (!name) throw new UserFacingError('Give the agent a name.');
  return {
    name,
    avatar: {
      shape: ['blob', 'square', 'diamond', 'leaf', 'pill', 'hex', 'triangle'].includes(d.avatar?.shape) ? d.avatar.shape : 'blob',
      color: /^#[0-9a-f]{6}$/i.test(d.avatar?.color ?? '') ? d.avatar.color : '#5fb87a',
      eyes: ['dots', 'happy', 'wide', 'sleepy'].includes(d.avatar?.eyes) ? d.avatar.eyes : 'dots',
    },
    instructions: assertString(d.instructions ?? '', 'Instructions', 40_000),
    provider: assertProvider(d.provider),
    model: d.model ? assertString(d.model, 'Model', 120).trim() || null : null,
    workspace: d.workspace ? assertString(d.workspace, 'Workspace', 1000) : null,
    projectId: d.projectId ? assertString(d.projectId, 'Project', 80) : null,
    pinned: Boolean(d.pinned),
    permissions: sanitizePermissions(d.permissions),
  };
}

function sanitizeProject(d: ProjectDraft): ProjectDraft {
  const name = assertString(d?.name, 'Name', 60).trim();
  if (!name) throw new UserFacingError('Give the project a name.');
  const workspace = d.workspace ? assertString(d.workspace, 'Folder', 1000).trim() : '';
  if (workspace && !path.isAbsolute(workspace)) throw new UserFacingError('The project folder must be a full path.');
  return {
    name,
    brief: assertString(d.brief ?? '', 'Brief', 20_000),
    workspace: workspace || null,
    color: /^#[0-9a-f]{6}$/i.test(d.color ?? '') ? d.color : '#3b82f6',
  };
}

/** A folder name for a new project's shared folder, safe on Windows. */
function folderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '') || 'Project';
}

/** Only conservative modes are accepted; bypass/full-access modes are never forwarded. */
function sanitizeAttachments(list: Attachment[]): Attachment[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map((a) => {
    const p = assertString(a?.path, 'Attachment path', 1000);
    if (!path.isAbsolute(p)) throw new UserFacingError('Attachment paths must be absolute');
    return { path: p, name: path.basename(p), isImage: IMAGE_EXT.test(p) };
  });
}

export function createHandlers(deps: {
  db: NestDb;
  runs: RunManager;
  scheduler: Scheduler;
  providers: ProviderRegistry;
  connectors: ConnectorService;
  models: ModelStore;
  getWindow: () => BrowserWindow | null;
  /** Agents' built-in browsers (live viewport, take-over). */
  browser?: AgentBrowserHost;
  defaultWorkspace: () => string;
  broadcast: (event: NestEvent) => void;
  /** `changed`: the keys the patch actually set. */
  onSettingsChanged: (s: AppSettings, changed: Array<keyof AppSettings>) => void;
  backups: { list: () => BackupInfo[]; create: () => boolean };
  apiKeys: ApiKeyStore;
  updater: Updater;
  remote: RemoteHost;
}): Handlers {
  const { db, runs, providers } = deps;
  const assertApiProvider = (p: unknown): ApiProviderId => {
    if (!(API_PROVIDERS as unknown[]).includes(p)) throw new UserFacingError('Unknown API provider');
    return p as ApiProviderId;
  };

  const remoteCall = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new UserFacingError((err as Error).message);
    }
  };

  return {
    getProviderStatuses: () => PROVIDERS.map((p) => providers.get(p).getStatus()),
    refreshProviders: () => Promise.all(PROVIDERS.map((p) => providers.get(p).detect())),
    // Keys go in and never come back out: the renderer only gets set/unset and a masked hint.
    getApiKeyStates: () => deps.apiKeys.states(),
    setApiKey: async (p, key) => {
      const provider = assertApiProvider(p);
      const clean = assertString(key, 'Key', 1000).trim();
      if (clean.length < 8 || /\s/.test(clean)) throw new UserFacingError('That doesn’t look like an API key.');
      try {
        deps.apiKeys.set(provider, clean);
      } catch (err) {
        throw new UserFacingError((err as Error).message);
      }
      await providers.get(provider).detect();
      return deps.apiKeys.state(provider);
    },
    clearApiKey: async (p) => {
      const provider = assertApiProvider(p);
      deps.apiKeys.clear(provider);
      await providers.get(provider).detect();
      return deps.apiKeys.state(provider);
    },
    listModels: (p) => providers.get(assertProvider(p)).listModels(),
    startLogin: (p) => providers.get(assertProvider(p)).startLogin(),
    signOut: (p) => providers.get(assertProvider(p)).signOut(),
    listConnectors: (p, refresh) => deps.connectors.list(assertProvider(p), Boolean(refresh)),

    listAgents: () => db.listAgents(),
    createAgent: (d) => db.createAgent(sanitizeDraft(d)),
    updateAgent: (id, d) => db.updateAgent(assertString(id, 'id'), sanitizeDraft(d)),
    deleteAgent: (id) => db.deleteAgent(assertString(id, 'id')),
    getAgentAccess: (id) => db.getAgentAccess(assertString(id, 'id')),
    setAgentAccess: (id, access) => {
      if (!db.getAgent(assertString(id, 'id'))) throw new UserFacingError('Agent not found');
      return db.setAgentAccess(id, sanitizeAccess(access));
    },

    setAgentProject: (id, projectId) => {
      if (!db.getAgent(assertString(id, 'id'))) throw new UserFacingError('Agent not found');
      if (projectId !== null && !db.getProject(assertString(projectId, 'projectId'))) throw new UserFacingError('Project not found');
      const agent = db.setAgentProject(id, projectId);
      deps.broadcast({ type: 'agents-changed' });
      return agent;
    },

    listProjects: () => db.listProjects(),
    createProject: (d) => {
      const draft = sanitizeProject(d);
      if (db.listProjects().some((p) => p.name.toLowerCase() === draft.name.toLowerCase())) throw new UserFacingError(`There is already a project called "${draft.name}".`);
      const project = db.createProject({ ...draft, workspace: draft.workspace ?? path.join(deps.defaultWorkspace(), folderName(draft.name)) });
      deps.broadcast({ type: 'projects-changed' });
      return project;
    },
    updateProject: (id, d) => {
      if (!db.getProject(assertString(id, 'id'))) throw new UserFacingError('Project not found');
      const draft = sanitizeProject(d);
      if (db.listProjects().some((p) => p.id !== id && p.name.toLowerCase() === draft.name.toLowerCase())) throw new UserFacingError(`There is already a project called "${draft.name}".`);
      const project = db.updateProject(id, draft);
      deps.broadcast({ type: 'projects-changed' });
      return project;
    },
    deleteProject: (id) => {
      db.deleteProject(assertString(id, 'id'));
      deps.broadcast({ type: 'projects-changed' });
      deps.broadcast({ type: 'agents-changed' });
    },

    listConversations: () => db.listConversations(),
    createConversation: (agentId, projectId) => {
      const agent = db.getAgent(assertString(agentId, 'agentId'));
      if (!agent) throw new UserFacingError('Agent not found');
      if (projectId && !db.getProject(assertString(projectId, 'projectId'))) throw new UserFacingError('Project not found');
      return db.createConversation(agent, { projectId: projectId ?? null });
    },
    getConversation: (id): ConversationDetail | null => {
      const conversation = db.getConversation(assertString(id, 'id'));
      if (!conversation) return null;
      return {
        conversation,
        messages: db.listMessages(id),
        runs: db.listRuns(id),
        activities: db.listActivities(id),
        approvals: db.listApprovals(id),
      };
    },
    updateConversation: (id, patch) => {
      if (runs.isRunning(id) && (patch.provider || patch.model !== undefined || patch.effort !== undefined || patch.workspace !== undefined || patch.permissions || patch.projectId !== undefined)) {
        throw new UserFacingError('Wait for the current response to finish before changing provider settings.');
      }
      const clean: Parameters<NestDb['updateConversation']>[1] = {};
      if (patch.title !== undefined) clean.title = assertString(patch.title, 'Title', 120).trim() || 'Untitled';
      if (patch.provider !== undefined) clean.provider = assertProvider(patch.provider);
      if (patch.model !== undefined) clean.model = patch.model ? assertString(patch.model, 'Model', 120) : null;
      if (patch.effort !== undefined) clean.effort = patch.effort ? assertString(patch.effort, 'Effort', 40) : null;
      if (patch.workspace !== undefined) clean.workspace = patch.workspace ? assertString(patch.workspace, 'Workspace', 1000) : null;
      if (patch.permissions !== undefined) clean.permissions = sanitizePermissions(patch.permissions);
      if (patch.projectId !== undefined) {
        if (patch.projectId !== null && !db.getProject(assertString(patch.projectId, 'projectId'))) throw new UserFacingError('Project not found');
        clean.projectId = patch.projectId;
      }
      // Models and effort levels are provider specific.
      if (clean.provider && !('model' in patch)) clean.model = null;
      if ((clean.provider || 'model' in patch) && !('effort' in patch)) clean.effort = null;
      const updated = db.updateConversation(id, clean);
      deps.broadcast({ type: 'conversation', conversation: updated });
      return updated;
    },
    deleteConversation: async (id) => {
      await runs.cancel(id);
      db.deleteConversation(assertString(id, 'id'));
      deps.broadcast({ type: 'conversation-deleted', conversationId: id });
    },

    sendMessage: (conversationId, text, attachments) => runs.send(assertString(conversationId, 'id'), assertString(text, 'Message'), sanitizeAttachments(attachments)),
    cancelRun: (conversationId) => runs.cancel(assertString(conversationId, 'id')),
    respondApproval: (approvalId, choiceId) => runs.respondApproval(assertString(approvalId, 'id'), assertString(choiceId, 'choice')),

    listMemory: () => db.listMemory(),
    createMemory: (scope, agentId, content, sourceMessageId) => {
      if (scope !== 'agent' && scope !== 'project' && scope !== 'shared') throw new UserFacingError('Unknown memory scope');
      const text = assertString(content, 'Note', 8000).trim();
      if (!text) throw new UserFacingError('Note is empty');
      if (scope === 'agent' && !(agentId && db.getAgent(agentId))) throw new UserFacingError('Pick an agent for this note');
      if (scope === 'project' && !(agentId && db.getProject(agentId))) throw new UserFacingError('Pick a project for this note');
      return db.createMemory(scope, agentId, text, sourceMessageId ?? null);
    },
    updateMemory: (id, patch) => db.updateMemory(assertString(id, 'id'), { content: patch.content !== undefined ? assertString(patch.content, 'Note', 8000) : undefined, enabled: patch.enabled }),
    deleteMemory: (id) => db.deleteMemory(assertString(id, 'id')),

    listSchedules: () => db.listSchedules(),
    createSchedule: (draft) => deps.scheduler.create(draft),
    updateSchedule: (id, draft) => deps.scheduler.update(assertString(id, 'id'), draft),
    deleteSchedule: (id) => deps.scheduler.remove(assertString(id, 'id')),
    runScheduleNow: (id) => deps.scheduler.runNow(assertString(id, 'id')),
    startHandoff: (req) => runs.startHandoff({ ...req, task: assertString(req.task, 'Task', 20000), context: assertString(req.context ?? '', 'Context', 40000) }),
    listHandoffs: () => db.listHandoffs(),
    listInbox: () => db.listInbox(),
    markInboxRead: (id) => db.markInboxRead(assertString(id, 'id')),

    pickFolder: async () => {
      const win = deps.getWindow();
      const res = win ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return res.canceled ? null : res.filePaths[0] ?? null;
    },
    pickFiles: async () => {
      const win = deps.getWindow();
      const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      return res.canceled ? [] : res.filePaths.map((p) => ({ path: p, name: path.basename(p), isImage: IMAGE_EXT.test(p) }));
    },
    browserWatch: (agentId, watching) => deps.browser?.watch(assertString(agentId, 'agentId', 100), Boolean(watching)) ?? null,
    browserInput: (agentId, input) => {
      const types = ['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel', 'keyDown', 'keyUp', 'char'];
      if (!input || !types.includes(input.type)) throw new UserFacingError('Unknown input');
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const mods = Array.isArray(input.modifiers) ? input.modifiers.filter((m) => ['shift', 'control', 'alt', 'meta'].includes(m)) : undefined;
      deps.browser?.input(assertString(agentId, 'agentId', 100), {
        type: input.type,
        x: num(input.x),
        y: num(input.y),
        button: input.button === 'right' || input.button === 'middle' ? input.button : 'left',
        deltaX: num(input.deltaX),
        deltaY: num(input.deltaY),
        key: typeof input.key === 'string' ? input.key.slice(0, 32) : undefined,
        modifiers: mods,
      });
    },
    browserNavigate: async (agentId, action, url) => {
      if (!['back', 'forward', 'reload', 'close', 'open'].includes(action)) throw new UserFacingError('Unknown browser action');
      await deps.browser?.navigate(assertString(agentId, 'agentId', 100), action, url ? assertString(url, 'url', 4000) : undefined);
    },
    savePastedImage: (data, mimeType) => {
      const ext = PASTED_IMAGE_EXT[assertString(mimeType, 'Image type', 40)];
      if (!ext) throw new UserFacingError('Only PNG, JPEG, GIF and WebP images can be pasted.');
      if (!(data instanceof Uint8Array) || !data.byteLength) throw new UserFacingError('The pasted image is empty.');
      if (data.byteLength > MAX_PASTED_IMAGE_BYTES) throw new UserFacingError('The pasted image is too large (20 MB max).');
      // Kept under userData so the file outlives the message and both agents can read it by path.
      const dir = path.join(app.getPath('userData'), 'pasted');
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
      const name = `pasted-${stamp}-${randomBytes(3).toString('hex')}${ext}`;
      const p = path.join(dir, name);
      writeFileSync(p, data);
      return { path: p, name, isImage: true };
    },
    openExternal: async (url) => {
      const parsed = new URL(assertString(url, 'url', 4000));
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new UserFacingError('Only web links can be opened.');
      await shell.openExternal(parsed.toString());
    },
    openFolder: async (p) => {
      const dir = assertString(p, 'Folder', 1000);
      let isDir = false;
      try {
        isDir = path.isAbsolute(dir) && statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new UserFacingError('That folder does not exist yet. It is created the first time an agent works in it.');
      const err = await shell.openPath(dir);
      if (err) throw new UserFacingError(err);
    },
    getAppInfo: () => {
      const dataDir = app.getPath('userData');
      let databaseBytes = 0;
      for (const f of ['nest.sqlite', 'nest.sqlite-wal']) {
        try {
          databaseBytes += statSync(path.join(dataDir, f)).size;
        } catch {
          /* not present */
        }
      }
      return {
        version: app.getVersion(),
        electron: process.versions.electron ?? '',
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
        dataDir,
        databaseBytes,
        effectiveDefaultWorkspace: deps.defaultWorkspace(),
        counts: db.stats(),
      };
    },
    getSettings: () => db.getSettings(),
    getUpdateState: () => deps.updater.getState(),
    checkForUpdates: () => deps.updater.check(),
    installUpdate: () => {
      try {
        deps.updater.install();
      } catch (err) {
        throw new UserFacingError((err as Error).message);
      }
    },
    updateSettings: (patch) => {
      const clean = sanitizeSettings(patch);
      const next = db.updateSettings(clean);
      deps.onSettingsChanged(next, Object.keys(clean) as Array<keyof AppSettings>);
      return next;
    },
    listBackups: () => deps.backups.list(),
    backUpNow: () => {
      if (!deps.backups.create()) throw new UserFacingError('Couldn’t back up the database. Check there’s free space in the data folder.');
      return deps.backups.list();
    },

    listDictationModels: () => deps.models.status(),
    deleteDictationModel: async (id) => {
      try {
        await deps.models.remove(assertString(id, 'id', 100));
      } catch (err) {
        throw new UserFacingError((err as Error).message);
      }
    },

    getRemoteState: () => deps.remote.state(),
    setRemoteAccess: (patch) =>
      remoteCall(() =>
        deps.remote.update({
          ...(patch?.enabled !== undefined ? { enabled: Boolean(patch.enabled) } : {}),
          ...(patch?.port !== undefined ? { port: Number(patch.port) } : {}),
        }),
      ),
    startRemotePairing: () => remoteCall(() => deps.remote.startPairing()),
    revokeRemoteDevice: (id) => remoteCall(() => deps.remote.revoke(assertString(id, 'id', 100))),
    setUpTailscale: () => remoteCall(() => deps.remote.setUpTailscale()),
    testRemoteNotification: async (id) => {
      const sent = await deps.remote.notify({ title: 'Nest', body: 'Notifications from your PC are working.' }, assertString(id, 'id', 100));
      if (!sent) throw new UserFacingError('That device didn’t get it. Turn notifications on again from the phone.');
    },
  };
}

/** Run one API method, turning errors into the { ok, error } shape both transports send. */
export async function invokeHandler(handlers: Handlers, method: ApiMethod, args: unknown[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await (handlers[method] as (...a: unknown[]) => unknown)(...args) };
  } catch (err) {
    const message = err instanceof UserFacingError ? err.message : `Unexpected error: ${(err as Error).message}`;
    if (!(err instanceof UserFacingError)) console.error(`[nest] ${method} failed`, err);
    return { ok: false, error: message };
  }
}

export function registerIpc(handlers: Handlers, getWindow: () => BrowserWindow | null): void {
  for (const method of API_METHODS) {
    ipcMain.handle(`nest:${method}`, async (event, ...args: unknown[]) => {
      // Only our own window may call in.
      const win = getWindow();
      if (!win || event.sender !== win.webContents) throw new Error('Unauthorized sender');
      return invokeHandler(handlers, method, args);
    });
  }
}
