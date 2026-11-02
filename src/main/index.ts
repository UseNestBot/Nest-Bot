import { app, BrowserWindow, nativeTheme, net, Notification, protocol, safeStorage, shell } from 'electron';
import path from 'node:path';
import { MODEL_SCHEME } from '@shared/dictation';
import { IPC_EVENT_CHANNEL } from '@shared/ipc';
import { mkdirSync } from 'node:fs';
import { API_PROVIDERS, PROVIDERS, type ApiProviderId, type AppSettings, type NestEvent, type ProviderId, type ProviderStatus } from '@shared/types';
import { ConnectorService } from './connectors';
import { AgentBrowserHost } from './agentBrowser';
import { NestDb } from './db';
import { PROVIDER_SETTINGS } from './settings';
import { createHandlers, invokeHandler, registerIpc } from './ipc';
import { RemoteHost } from './remote/host';
import { ClaudeProvider } from './providers/claude';
import { CodexProvider } from './providers/codex';
import { AcpProvider } from './providers/acp';
import { CURSOR, GEMINI, GROK } from './providers/acpProviders';
import { API_DEFINITIONS, ApiProvider } from './providers/api';
import { ApiKeyStore } from './apiKeys';
import { RunManager, type ProviderRegistry } from './runs';
import { applyConfigFile, seedIfEmpty } from './seed';
import { Scheduler } from './scheduler';
import { setUpSpelling } from './spelling';
import { NestBridge } from './mcp/bridge';
import { NestTools } from './mcp/tools';
import { effectiveDefaultWorkspace } from './workspace';
import { ModelStore } from './models';
import { Updater } from './updater';
import { APP_VERSION, BUILD_NUMBER, RELEASE_CHANNEL } from '@shared/build';

// Separate profile for development so experiments never touch real data.
if (process.env.NEST_USER_DATA) app.setPath('userData', path.resolve(process.env.NEST_USER_DATA));

// Lets ONNX Runtime run Whisper on several threads. The renderer only loads the
// app's own code (CSP 'self'), so the cross-origin isolation that normally guards
// SharedArrayBuffer protects nothing extra here.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// The dictation worker fetches Whisper weights from this scheme (src/main/models.ts).
protocol.registerSchemesAsPrivileged([{ scheme: MODEL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

// Same id as "appId" in package.json, so Windows ties notifications to the installed Start Menu shortcut.
if (process.platform === 'win32') app.setAppUserModelId('io.github.chimppppy.nest');

// One process per profile: two instances must never drive the same database and provider sessions.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
}

let mainWindow: BrowserWindow | null = null;
let db: NestDb;
let runs: RunManager;
let claude: ClaudeProvider;
let codex: CodexProvider;
let adapters: Record<ProviderId, ClaudeProvider | CodexProvider | AcpProvider | ApiProvider>;
let apiKeys: ApiKeyStore;
let scheduler: Scheduler;
let bridge: NestBridge | null = null;
let updater: Updater | null = null;
let remote: RemoteHost | null = null;

/** The page's canvas colour (styles.css), so launch doesn't flash the wrong colour. */
function canvasColour(settings: AppSettings | undefined): { dark: boolean; canvas: string } {
  const theme = settings?.theme ?? 'system';
  const dark = theme === 'dark' || (theme === 'system' && nativeTheme.shouldUseDarkColors);
  return { dark, canvas: !dark ? '#ffffff' : settings?.darkStyle === 'black' ? '#000000' : '#161618' };
}

function windowBackground(): string {
  return canvasColour(db?.getSettings()).canvas;
}

/**
 * The native title bar is hidden; Windows draws only its caption buttons, over
 * the top-right of the page header. They take the page colours and stop 1px
 * short of the 56px header so its bottom border runs underneath. The header
 * scales with Appearance → Interface size (zoom on #root).
 */
function titleBarOverlay(): Electron.TitleBarOverlayOptions {
  const settings = db?.getSettings();
  const { dark, canvas } = canvasColour(settings);
  const zoom = (settings?.uiScale ?? 100) / 100;
  return { color: canvas, symbolColor: dark ? '#c9c9ce' : '#3c3c43', height: Math.round(56 * zoom) - 1 };
}

function applyWindowTheme(): void {
  if (!mainWindow) return;
  mainWindow.setBackgroundColor(windowBackground());
  if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay(titleBarOverlay());
}

function broadcast(event: NestEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    // Agents' browser windows show third-party sites: never send them Nest's events.
    if (!win.isDestroyed() && !agentBrowser?.isAgentWindow(win)) win.webContents.send(IPC_EVENT_CHANNEL, event);
  }
  remote?.broadcast(event);
}

let agentBrowser: AgentBrowserHost | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    title: 'Nest',
    backgroundColor: windowBackground(),
    titleBarStyle: 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? undefined : titleBarOverlay(),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  setUpSpelling(mainWindow);

  // Never open new windows or navigate away from the app; web links go to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  // Our own window gets the microphone (dictation) and clipboard writes (copy buttons); camera and everything else stay denied.
  mainWindow.webContents.session.setPermissionRequestHandler((wc, perm, callback, details) => {
    if (wc !== mainWindow?.webContents) return callback(false);
    // Electron asks for navigator.clipboard.writeText as 'clipboard-read'. Only Nest's own code runs here (CSP 'self').
    if (perm === 'clipboard-sanitized-write' || perm === 'clipboard-read') return callback(true);
    const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes ?? [];
    callback(perm === 'media' && types.length > 0 && types.every((t) => t === 'audio'));
  });

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    // Hidden agent browser windows would otherwise keep the app alive.
    agentBrowser?.closeAll();
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  db = new NestDb(path.join(app.getPath('userData'), 'nest.sqlite'));
  db.recoverAfterRestart();
  seedIfEmpty(db);
  applyConfigFile(db, path.join(app.getPath('userData'), 'nest.config.json'));

  const onStatus = (status: ProviderStatus) => broadcast({ type: 'provider-status', status });
  claude = new ClaudeProvider(() => db.getSettings(), onStatus);
  codex = new CodexProvider(() => db.getSettings(), onStatus, (url) => void shell.openExternal(url), app.getVersion());
  apiKeys = new ApiKeyStore(path.join(app.getPath('userData'), 'api-keys.json'), {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (data) => safeStorage.decryptString(data),
  });
  const probeDir = () => {
    const dir = path.join(app.getPath('userData'), 'probe');
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const getSettings = () => db.getSettings();
  const apiSessions = path.join(app.getPath('userData'), 'api-sessions');
  adapters = {
    claude,
    codex,
    cursor: new AcpProvider(CURSOR, getSettings, onStatus, probeDir),
    gemini: new AcpProvider(GEMINI, getSettings, onStatus, probeDir),
    grok: new AcpProvider(GROK, getSettings, onStatus, probeDir),
    ...(Object.fromEntries(API_PROVIDERS.map((id) => [id, new ApiProvider(API_DEFINITIONS[id], apiKeys, apiSessions, onStatus, (url) => void shell.openExternal(url))])) as Record<ApiProviderId, ApiProvider>),
  };
  const registry: ProviderRegistry = { get: (id: ProviderId) => adapters[id] };
  runs = new RunManager(db, registry, broadcast, () => effectiveDefaultWorkspace(db));
  // Listed on demand (listing starts every server); a restricted agent's first turn waits for it.
  const connectors = new ConnectorService((id) => registry.get(id), (agentId) => db.getAgentAccess(agentId));
  // Under userData, not the install folder, so installer updates keep downloaded models.
  const models = new ModelStore(path.join(app.getPath('userData'), 'models'), (p) => broadcast({ type: 'dictation-download', ...p }), (url) => net.fetch(String(url)));
  protocol.handle(MODEL_SCHEME, (request) => models.handle(request));
  runs.connectorPolicy = (agentId, provider) => connectors.policyFor(agentId, provider);
  claude.onServersSeen = (seen) => connectors.noteSeen('claude', seen);
  runs.onRunFinished = (conversationId, run, message) => runs.handleHandoffCompletion(conversationId, run, message);
  runs.onAttention = (e) => {
    const settings = db.getSettings();
    if (!settings.notifyOn[e.kind]) return;
    // Phones get a push whenever nobody is looking at Nest on the PC.
    if (!mainWindow?.isFocused()) void remote?.notify({ title: e.title, body: e.body, conversationId: e.conversationId, kind: e.kind });
    if (!settings.notifyWhenUnfocused || mainWindow?.isFocused() || !Notification.isSupported()) return;
    const note = new Notification({ title: e.title, body: e.body, silent: !settings.notificationSound || e.kind === 'finished' });
    note.on('click', () => {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
      broadcast({ type: 'open-conversation', conversationId: e.conversationId });
    });
    note.show();
  };

  scheduler = new Scheduler(db, runs, broadcast);
  agentBrowser = new AgentBrowserHost(broadcast);
  const browserHost = agentBrowser;
  const tools = new NestTools(db, runs, scheduler, () => broadcast({ type: 'agents-changed' }), {
    host: browserHost,
    enabledFor: (agentId) => {
      const access = db.getAgentAccess(agentId);
      return access.browser && access.browserMode === 'nest';
    },
  });
  // Codex and Claude Code run this script as their own process, which can't read inside app.asar,
  // so the installed app ships it unpacked (package.json "asarUnpack").
  const mcpScript = path.join(__dirname, 'nest-mcp.mjs').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const nestBridge = new NestBridge(tools, mcpScript);
  void nestBridge
    .start()
    .then(() => {
      bridge = nestBridge;
      runs.mcpLauncher = (conversationId) => (db.getSettings().agentTools ? bridge?.launchFor(conversationId) ?? null : null);
    })
    .catch((err) => console.error('[nest] agent tools unavailable:', (err as Error).message));
  nativeTheme.on('updated', applyWindowTheme);

  updater = new Updater({
    version: APP_VERSION,
    build: BUILD_NUMBER,
    channel: RELEASE_CHANNEL,
    dir: path.join(app.getPath('userData'), 'updates'),
    unsupportedReason: !app.isPackaged
      ? 'Development builds don’t update themselves.'
      : process.platform !== 'win32'
        ? 'Automatic updates are for the Windows installer. Download new versions from GitHub releases.'
        : null,
    fetch: (url, init) => net.fetch(url, init),
    onState: (state) => broadcast({ type: 'update', state }),
    quit: () => app.quit(),
  });

  // Created before the handlers, which manage it; its calls go through the same handlers.
  const remoteHost = new RemoteHost({
    file: path.join(app.getPath('userData'), 'remote.json'),
    staticDir: path.join(__dirname, '../renderer'),
    uploadsDir: path.join(app.getPath('userData'), 'uploads'),
    call: (method, args) => invokeHandler(handlers, method, args),
    onChange: () => broadcast({ type: 'remote-changed' }),
  });
  remote = remoteHost;

  const handlers = createHandlers({
    remote: remoteHost,
    updater,
    db,
    runs,
    scheduler,
    providers: registry,
    connectors,
    models,
    browser: browserHost,
    getWindow: () => mainWindow,
    defaultWorkspace: () => effectiveDefaultWorkspace(db),
    broadcast,
    onSettingsChanged: (_next, changed) => {
      applyWindowTheme();
      // Paths and the API-billing switch change what the installed agents resolve to. Nothing
      // else does, so a theme or text change doesn't start every provider's CLI again.
      if (changed.some((k) => PROVIDER_SETTINGS.includes(k))) {
        for (const id of ['claude', 'codex', 'cursor', 'gemini', 'grok'] as const) void adapters[id].detect().catch(() => {});
      }
    },
    backups: { list: () => db.listBackups(), create: () => db.backUpNow() },
    apiKeys,
  });
  registerIpc(handlers, () => mainWindow);
  void remoteHost.start().then(() => broadcast({ type: 'remote-changed' }));

  createWindow();
  scheduler.start();
  updater.start();
  // Detect, then warm the model lists so the picker opens instantly. API providers list models while detecting.
  for (const id of PROVIDERS) {
    const adapter = adapters[id];
    void adapter
      .detect()
      .then((s) => (s.state === 'ready' && !(adapter instanceof ApiProvider) ? adapter.listModels() : null))
      .catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  // Stop runs cleanly so transcripts are marked interrupted rather than left streaming.
  const shutdown = async () => {
    scheduler?.stop();
    updater?.stop();
    await remote?.stop();
    await Promise.race([runs?.cancelAll(), new Promise((r) => setTimeout(r, 6000))]);
    bridge?.stop();
    await Promise.allSettled(Object.values(adapters ?? {}).map((a) => a.dispose()));
    db?.close();
  };
  void shutdown().finally(() => app.quit());
});

// After shutdown has finished: a downloaded update installs silently as Nest exits.
app.on('quit', () => updater?.runPendingInstall());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
