import { BrowserWindow, session as electronSession, type WebContents } from 'electron';
import type { BrowserInput, BrowserStateInfo, NestEvent } from '@shared/types';

const WIDTH = 1280;
const HEIGHT = 800;
const FRAME_INTERVAL_MS = 120;
const LOAD_TIMEOUT_MS = 20_000;

interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: Array<{ ref: number; tag: string; type: string; label: string; href: string }>;
}

interface Page {
  win: BrowserWindow;
  agentId: string;
  watchers: number;
  lastFrame: string | null;
  lastFrameAt: number;
  frameTimer: NodeJS.Timeout | null;
  action: string | null;
}

// Runs in an isolated world: it shares the DOM with the page but not its JavaScript.
const SNAPSHOT_SCRIPT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  document.querySelectorAll('[data-nest-ref]').forEach((el) => el.removeAttribute('data-nest-ref'));
  const sel = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=true], [onclick]';
  const elements = [];
  let n = 1;
  for (const el of document.querySelectorAll(sel)) {
    if (elements.length >= 200 || !visible(el)) continue;
    el.setAttribute('data-nest-ref', String(n));
    const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 100);
    elements.push({ ref: n, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || el.getAttribute('role') || '', label, href: el.getAttribute('href') || '' });
    n++;
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 8000);
  return { url: location.href, title: document.title, text, elements };
})()`;

const centerScript = (ref: number) => `(() => {
  const el = document.querySelector('[data-nest-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
})()`;

const focusScript = (ref: number, clear: boolean) => `(() => {
  const el = document.querySelector('[data-nest-ref="${ref}"]');
  if (!el) return false;
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (${clear} && ('value' in el)) { el.select ? el.select() : null; }
  return true;
})()`;

function safeUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Only http and https pages can be opened.');
  return url.toString();
}

/**
 * Each agent gets its own off-screen Chromium "computer": a hidden window with
 * a persistent, isolated profile (cookies and logins stay per agent, separate
 * from the user's own browser). Frames stream to the renderer only while a
 * viewport is watching; the user can take over with mouse and keyboard.
 */
export class AgentBrowserHost {
  private pages = new Map<string, Page>();

  constructor(private readonly broadcast: (event: NestEvent) => void) {}

  isAgentWindow(win: BrowserWindow): boolean {
    for (const p of this.pages.values()) if (p.win === win) return true;
    return false;
  }

  has(agentId: string): boolean {
    return this.pages.has(agentId);
  }

  state(agentId: string): BrowserStateInfo | null {
    const p = this.pages.get(agentId);
    if (!p || p.win.isDestroyed()) return null;
    const wc = p.win.webContents;
    return { agentId, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), action: p.action, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() };
  }

  private page(agentId: string): Page {
    const existing = this.pages.get(agentId);
    if (existing && !existing.win.isDestroyed()) return existing;
    const ses = electronSession.fromPartition(`persist:nest-browser-${agentId}`);
    // Look like ordinary Chrome so sites don't refuse an "Electron" browser.
    ses.setUserAgent(ses.getUserAgent().replace(/\s?(Electron|nest)\/\S+/gi, ''));
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.on('will-download', (event) => event.preventDefault());
    const win = new BrowserWindow({
      show: false,
      width: WIDTH,
      height: HEIGHT,
      useContentSize: true,
      webPreferences: { offscreen: true, partition: `persist:nest-browser-${agentId}`, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.webContents.setFrameRate(10);
    const page: Page = { win, agentId, watchers: 0, lastFrame: null, lastFrameAt: 0, frameTimer: null, action: null };
    // Pop-ups open in the same page so the agent keeps one place to work.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void win.webContents.loadURL(url);
      return { action: 'deny' };
    });
    win.webContents.on('paint', (_e, _dirty, image) => {
      if (page.watchers <= 0) return;
      const now = Date.now();
      const emit = () => {
        page.frameTimer = null;
        page.lastFrameAt = Date.now();
        page.lastFrame = `data:image/jpeg;base64,${image.toJPEG(70).toString('base64')}`;
        this.broadcast({ type: 'browser-frame', agentId, data: page.lastFrame });
      };
      if (now - page.lastFrameAt >= FRAME_INTERVAL_MS) emit();
      else if (!page.frameTimer) page.frameTimer = setTimeout(emit, FRAME_INTERVAL_MS - (now - page.lastFrameAt));
    });
    const announce = () => {
      const s = this.state(agentId);
      if (s) this.broadcast({ type: 'browser-state', state: s });
    };
    for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page'] as const) {
      win.webContents.on(ev as 'did-start-loading', announce);
    }
    win.on('closed', () => {
      this.pages.delete(agentId);
      this.broadcast({ type: 'browser-state', state: { agentId, url: '', title: '', loading: false, action: null, canGoBack: false, canGoForward: false, closed: true } });
    });
    this.pages.set(agentId, page);
    return page;
  }

  private setAction(agentId: string, action: string | null): void {
    const p = this.pages.get(agentId);
    if (!p) return;
    p.action = action;
    const s = this.state(agentId);
    if (s) this.broadcast({ type: 'browser-state', state: s });
  }

  private async settle(wc: WebContents, minWaitMs = 400): Promise<void> {
    await new Promise((r) => setTimeout(r, minWaitMs));
    if (!wc.isLoading()) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        wc.removeListener('did-stop-loading', done);
        resolve();
      };
      const t = setTimeout(done, LOAD_TIMEOUT_MS);
      wc.once('did-stop-loading', done);
    });
  }

  private async run<T>(wc: WebContents, code: string): Promise<T> {
    return (await wc.executeJavaScriptInIsolatedWorld(1001, [{ code }])) as T;
  }

  /** Page text plus numbered interactive elements, the agent's way of "seeing" the page. */
  async snapshot(agentId: string): Promise<string> {
    const p = this.pages.get(agentId);
    if (!p) return 'The browser is not open. Use browser_open first.';
    const snap = await this.run<Snapshot>(p.win.webContents, SNAPSHOT_SCRIPT).catch(() => null);
    if (!snap) return `URL: ${p.win.webContents.getURL()}\n(The page could not be read yet; try again.)`;
    const els = snap.elements
      .map((e) => `[${e.ref}] ${e.tag}${e.type ? `(${e.type})` : ''} “${e.label}”${e.href && e.tag === 'a' ? ` → ${e.href.slice(0, 120)}` : ''}`)
      .join('\n');
    return `URL: ${snap.url}\nTitle: ${snap.title}\n\nPage text:\n${snap.text || '(no text)'}\n\nInteractive elements (use the number as ref):\n${els || '(none)'}`;
  }

  async open(agentId: string, rawUrl: string): Promise<string> {
    const url = safeUrl(rawUrl);
    const p = this.page(agentId);
    this.setAction(agentId, `Opening ${url}`);
    try {
      await Promise.race([p.win.webContents.loadURL(url), new Promise((r) => setTimeout(r, LOAD_TIMEOUT_MS))]);
    } catch (err) {
      // Some sites abort the initial load after redirecting; the snapshot shows where we ended up.
      if (!/ERR_ABORTED/.test(String(err))) {
        this.setAction(agentId, null);
        return `Could not open ${url}: ${(err as Error).message}`;
      }
    }
    await this.settle(p.win.webContents, 300);
    this.setAction(agentId, null);
    return this.snapshot(agentId);
  }

  async click(agentId: string, ref: number): Promise<string> {
    const p = this.pages.get(agentId);
    if (!p) return 'The browser is not open. Use browser_open first.';
    const wc = p.win.webContents;
    const at = await this.run<{ x: number; y: number; label: string } | null>(wc, centerScript(ref));
    if (!at) return `No element [${ref}] on the page. Take a new browser_snapshot; refs change when the page changes.`;
    this.setAction(agentId, `Clicking “${at.label || `[${ref}]`}”`);
    await new Promise((r) => setTimeout(r, 120));
    wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await this.settle(wc, 700);
    this.setAction(agentId, null);
    return this.snapshot(agentId);
  }

  async type(agentId: string, ref: number, text: string, submit: boolean, clear: boolean): Promise<string> {
    const p = this.pages.get(agentId);
    if (!p) return 'The browser is not open. Use browser_open first.';
    const wc = p.win.webContents;
    const ok = await this.run<boolean>(wc, focusScript(ref, clear));
    if (!ok) return `No element [${ref}] on the page. Take a new browser_snapshot; refs change when the page changes.`;
    this.setAction(agentId, `Typing into [${ref}]`);
    await wc.insertText(text);
    if (submit) {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'char', keyCode: '\r' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    }
    await this.settle(wc, submit ? 900 : 200);
    this.setAction(agentId, null);
    return this.snapshot(agentId);
  }

  async scroll(agentId: string, direction: 'up' | 'down'): Promise<string> {
    const p = this.pages.get(agentId);
    if (!p) return 'The browser is not open. Use browser_open first.';
    await this.run(p.win.webContents, `window.scrollBy({ top: ${direction === 'down' ? 0.8 : -0.8} * window.innerHeight }); true`);
    await new Promise((r) => setTimeout(r, 300));
    return this.snapshot(agentId);
  }

  async history(agentId: string, dir: 'back' | 'forward' | 'reload'): Promise<string> {
    const p = this.pages.get(agentId);
    if (!p) return 'The browser is not open. Use browser_open first.';
    const wc = p.win.webContents;
    if (dir === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (dir === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (dir === 'reload') wc.reload();
    await this.settle(wc, 500);
    return this.snapshot(agentId);
  }

  async screenshot(agentId: string): Promise<{ data: string; mimeType: string } | null> {
    const p = this.pages.get(agentId);
    if (!p) return null;
    const image = await p.win.webContents.capturePage();
    return { data: image.toJPEG(70).toString('base64'), mimeType: 'image/jpeg' };
  }

  // --- Viewport -----------------------------------------------------------------

  /** A viewport started or stopped watching. Returns the current state and latest frame. */
  watch(agentId: string, watching: boolean): { state: BrowserStateInfo; frame: string | null } | null {
    const p = this.pages.get(agentId);
    if (!p || p.win.isDestroyed()) return null;
    p.watchers = Math.max(0, p.watchers + (watching ? 1 : -1));
    if (watching) p.win.webContents.invalidate(); // force a fresh frame
    return { state: this.state(agentId)!, frame: p.lastFrame };
  }

  /** The user takes over: forward their mouse and keyboard to the agent's page. */
  input(agentId: string, input: BrowserInput): void {
    const p = this.pages.get(agentId);
    if (!p) return;
    const wc = p.win.webContents;
    const x = Math.max(0, Math.min(WIDTH, Math.round(input.x ?? 0)));
    const y = Math.max(0, Math.min(HEIGHT, Math.round(input.y ?? 0)));
    switch (input.type) {
      case 'mouseDown':
      case 'mouseUp':
        wc.sendInputEvent({ type: input.type, x, y, button: input.button ?? 'left', clickCount: 1 });
        break;
      case 'mouseMove':
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        break;
      case 'mouseWheel':
        wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: -(input.deltaX ?? 0), deltaY: -(input.deltaY ?? 0) });
        break;
      case 'keyDown':
      case 'keyUp':
        if (input.key) wc.sendInputEvent({ type: input.type, keyCode: input.key, modifiers: input.modifiers ?? [] });
        break;
      case 'char':
        if (input.key) wc.sendInputEvent({ type: 'char', keyCode: input.key, modifiers: input.modifiers ?? [] });
        break;
    }
  }

  async navigate(agentId: string, action: 'back' | 'forward' | 'reload' | 'close' | 'open', url?: string): Promise<void> {
    if (action === 'close') {
      this.pages.get(agentId)?.win.destroy();
      return;
    }
    if (action === 'open') {
      if (url) await this.open(agentId, url);
      return;
    }
    await this.history(agentId, action);
  }

  closeAll(): void {
    for (const p of [...this.pages.values()]) if (!p.win.isDestroyed()) p.win.destroy();
    this.pages.clear();
  }

  static readonly size = { width: WIDTH, height: HEIGHT };
}
