import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Loader2, Power, SquareTerminal, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { TerminalStateInfo } from '@shared/types';
import { api, IS_REMOTE } from '../api';
import { IconButton } from './ui';

const HEIGHT_KEY = 'nest:terminal-height';
const MIN_HEIGHT = 120;

/** Conversations whose terminal panel is open, kept across pane switches for this session. */
const openPanels = new Set<string>();

/**
 * Whether a conversation's terminal panel is showing. It opens by itself when
 * the agent starts running a command, so the user always sees what it does.
 */
export function useTerminalPanel(conversationId: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => openPanels.has(conversationId));
  useEffect(() => setOpen(openPanels.has(conversationId)), [conversationId]);
  const set = (v: boolean) => {
    if (v) openPanels.add(conversationId);
    else openPanels.delete(conversationId);
    setOpen(v);
  };
  useEffect(() => {
    if (IS_REMOTE) return;
    return api.onEvent((e) => {
      if (e.type === 'terminal-state' && e.state.conversationId === conversationId && e.state.action && !e.state.closed) {
        openPanels.add(conversationId);
        setOpen(true);
      }
    });
  }, [conversationId]);
  return [open && !IS_REMOTE, set];
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function savedHeight(): number {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    if (n >= MIN_HEIGHT) return n;
  } catch {
    /* storage unavailable */
  }
  return 260;
}

/**
 * The conversation's shell, shared with its agent: whatever either of you runs
 * shows here, and you can type into it at any time.
 */
export function TerminalPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(savedHeight);
  const [info, setInfo] = useState<TerminalStateInfo | null>(null);
  const [exited, setExited] = useState(false);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: cssVar('--nest-sunken', '#f5f5f7'),
        foreground: cssVar('--nest-ink', '#111113'),
        cursor: cssVar('--nest-ink', '#111113'),
        selectionBackground: cssVar('--nest-selection', '#cfe0fb'),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    let alive = true;
    let ready = false;
    const pending: string[] = [];

    const off = api.onEvent((e) => {
      if (e.type === 'terminal-data' && e.conversationId === conversationId) {
        if (ready) term.write(e.data);
        else pending.push(e.data);
      } else if (e.type === 'terminal-state' && e.state.conversationId === conversationId) {
        if (e.state.closed) {
          setInfo(null);
          setExited(true);
          term.write('\r\n\x1b[2m[The terminal closed]\x1b[0m\r\n');
        } else setInfo(e.state);
      }
    });

    void api.terminalOpen(conversationId, term.cols, term.rows).then(
      (res) => {
        if (!alive) return;
        // The buffer already holds anything that arrived before it was read.
        term.write(res.buffer);
        ready = true;
        pending.length = 0;
        setInfo(res.state);
        setExited(false);
        void api.terminalResize(conversationId, term.cols, term.rows);
        term.focus();
      },
      (err: Error) => term.write(`\x1b[31m${err.message}\x1b[0m\r\n`),
    );

    const input = term.onData((data) => void api.terminalInput(conversationId, data));
    const resized = term.onResize(({ cols, rows }) => void api.terminalResize(conversationId, cols, rows));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* hidden */
      }
    });
    observer.observe(el);

    return () => {
      alive = false;
      off();
      input.dispose();
      resized.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [conversationId, generation]);

  const startResize = (e: ReactPointerEvent) => {
    const el = panel.current;
    if (!el) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const start = el.getBoundingClientRect().height;
    const max = (el.parentElement?.getBoundingClientRect().height ?? 800) - 200;
    let next = start;
    const move = (ev: PointerEvent) => {
      next = Math.min(Math.max(start + startY - ev.clientY, MIN_HEIGHT), Math.max(max, MIN_HEIGHT));
      setHeight(next);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
      try {
        localStorage.setItem(HEIGHT_KEY, String(Math.round(next)));
      } catch {
        /* ignore */
      }
    };
    document.body.style.cursor = 'row-resize';
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  return (
    <div ref={panel} style={{ height }} className="relative flex shrink-0 flex-col border-t border-line bg-sunken">
      <div
        role="separator"
        aria-orientation="horizontal"
        title="Drag to resize"
        onPointerDown={startResize}
        className="absolute inset-x-0 -top-[3px] z-20 h-[6px] cursor-row-resize transition-colors hover:bg-accent/40"
      />
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line pl-3 pr-1.5 text-[12px] text-muted">
        <SquareTerminal size={14} className="shrink-0" />
        <span className="font-medium text-ink-2">Terminal</span>
        {info && <span className="min-w-0 truncate text-faint" title={info.cwd}>{info.cwd}</span>}
        {info?.action ? (
          <span className="ml-auto flex min-w-0 items-center gap-1.5 truncate text-accent">
            <Loader2 size={12} className="shrink-0 animate-spin" />
            <span className="truncate">{info.action}</span>
          </span>
        ) : (
          <span className="ml-auto" />
        )}
        {info && !info.pty && <span className="shrink-0 text-faint" title="Full-screen programs need Python 3 (macOS/Linux)">basic mode</span>}
        {exited ? (
          <IconButton label="Start a new terminal" onClick={() => setGeneration((g) => g + 1)} className="h-6! w-6!">
            <Power size={13} />
          </IconButton>
        ) : (
          <IconButton label="Stop the terminal" onClick={() => void api.terminalClose(conversationId)} className="h-6! w-6!">
            <Power size={13} />
          </IconButton>
        )}
        <IconButton label="Hide terminal (it keeps running)" onClick={onClose} className="h-6! w-6!">
          <X size={14} />
        </IconButton>
      </div>
      <div ref={host} className="nest-terminal min-h-0 flex-1 px-2 pt-1" />
    </div>
  );
}
