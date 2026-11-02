import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react';
import { ArrowLeft, ArrowRight, Globe, Hand, Loader2, Maximize2, Minimize2, RotateCw, X } from 'lucide-react';
import type { BrowserInput, BrowserStateInfo } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { IconButton, Tooltip, cx } from './ui';

const PAGE_W = 1280;
const PAGE_H = 800;

// DOM key names → Electron keyCode names for keys that aren't a single character.
const SPECIAL_KEYS: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Tab: 'Tab',
  Escape: 'Escape',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Live view of the agent's own browser: a small viewport in the top right of
 * the conversation, expandable to full screen where the user can take over.
 * Renders nothing until the agent has opened its browser.
 */
export function BrowserViewport({ conversationId }: { conversationId: string }) {
  const { state } = useStore();
  const agentId = state.details[conversationId]?.conversation.agentId ?? null;
  const [info, setInfo] = useState<BrowserStateInfo | null>(null);
  const [frame, setFrame] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [full, setFull] = useState(false);
  const [control, setControl] = useState(false);
  const watching = useRef(false);

  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    const start = () => {
      if (watching.current) return;
      void api.browserWatch(agentId, true).then((res) => {
        if (!alive) {
          if (res) void api.browserWatch(agentId, false);
          return;
        }
        if (!res) return;
        watching.current = true;
        setInfo(res.state);
        if (res.frame) setFrame(res.frame);
      });
    };
    start();
    const off = api.onEvent((e) => {
      if (e.type === 'browser-state' && e.state.agentId === agentId) {
        if (e.state.closed) {
          watching.current = false;
          setInfo(null);
          setFrame(null);
          setFull(false);
          return;
        }
        setInfo(e.state);
        if (!watching.current) {
          setHidden(false); // the agent just opened its browser: show it
          start();
        }
      } else if (e.type === 'browser-frame' && e.agentId === agentId) {
        setFrame(e.data);
      }
    });
    return () => {
      alive = false;
      off();
      if (watching.current) void api.browserWatch(agentId, false);
      watching.current = false;
      setInfo(null);
      setFrame(null);
      setFull(false);
    };
  }, [agentId]);

  useEffect(() => {
    if (!full) setControl(false);
  }, [full]);

  if (!agentId || !info) return null;

  const status = info.action ?? (info.loading ? 'Loading…' : hostOf(info.url) || 'Blank page');

  if (hidden && !full) {
    return (
      <Tooltip label="Show the agent’s browser" side="bottom" align="end">
        <button
          onClick={() => setHidden(false)}
          className="absolute right-3 top-3 z-20 inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-panel px-3 text-[12px] text-ink-2 shadow-pop hover:bg-hover"
        >
          <Globe size={13} /> Browser
          {info.action && <Loader2 size={12} className="animate-spin text-muted" />}
        </button>
      </Tooltip>
    );
  }

  const screen = (
    <Screen agentId={agentId} frame={frame} control={control && full} fit={full} onExpand={full ? undefined : () => setFull(true)} />
  );

  if (!full) {
    return (
      <div className="absolute right-3 top-3 z-20 w-[280px] overflow-hidden rounded-2xl border border-line bg-panel shadow-pop">
        <div className="flex items-center gap-1.5 py-1 pl-3 pr-1">
          <Globe size={13} className="shrink-0 text-muted" />
          <Tooltip label={info.url} side="bottom" align="start">
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{status}</span>
          </Tooltip>
          {(info.loading || info.action) && <Loader2 size={12} className="shrink-0 animate-spin text-faint" />}
          <IconButton label="Full screen" onClick={() => setFull(true)} className="h-7 w-7">
            <Maximize2 size={13} />
          </IconButton>
          <IconButton label="Hide" onClick={() => setHidden(true)} className="h-7 w-7">
            <X size={13} />
          </IconButton>
        </div>
        {screen}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-label="Agent browser">
      <div className="app-drag flex h-14 shrink-0 items-center gap-1 border-b border-line pl-3">
        <IconButton label="Back" disabled={!info.canGoBack} onClick={() => void api.browserNavigate(agentId, 'back')}>
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton label="Forward" disabled={!info.canGoForward} onClick={() => void api.browserNavigate(agentId, 'forward')}>
          <ArrowRight size={15} />
        </IconButton>
        <IconButton label="Reload" onClick={() => void api.browserNavigate(agentId, 'reload')}>
          {info.loading ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />}
        </IconButton>
        <div className="mx-2 flex min-w-0 flex-1 items-center gap-2 rounded-full bg-sunken px-3 py-1.5 text-[12.5px]">
          <Globe size={13} className="shrink-0 text-muted" />
          <Tooltip label={info.url} side="bottom" align="start">
            <span className="truncate text-ink-2">{info.url || 'about:blank'}</span>
          </Tooltip>
          {info.action && <span className="ml-auto shrink-0 truncate text-muted">{info.action}</span>}
        </div>
        <Tooltip label={control ? 'Give control back to the agent' : 'Use the agent’s browser yourself, e.g. to sign in'} side="bottom">
          <button
            onClick={() => setControl((c) => !c)}
            className={cx(
              'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors',
              control ? 'border border-warn-line bg-warn-bg text-warn-ink' : 'bg-primary text-on-primary hover:bg-primary-hover',
            )}
          >
            <Hand size={13} /> {control ? 'You’re in control' : 'Take control'}
          </button>
        </Tooltip>
        <IconButton label="Exit full screen" onClick={() => setFull(false)}>
          <Minimize2 size={15} />
        </IconButton>
        <div className="titlebar-spacer" />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-sunken p-4">{screen}</div>
      <div className="shrink-0 px-4 pb-3 text-center text-[11.5px] text-muted">
        {control
          ? 'Your clicks and typing go to the agent’s browser. Its logins are kept for this agent only.'
          : 'This is the agent’s own browser, separate from yours. Take control to sign in or help it along.'}
      </div>
    </div>
  );
}

function Screen({ agentId, frame, control, fit, onExpand }: { agentId: string; frame: string | null; control: boolean; fit?: boolean; onExpand?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  const toPage = (e: MouseEvent | WheelEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * PAGE_W, y: ((e.clientY - r.top) / r.height) * PAGE_H };
  };
  const send = (input: BrowserInput) => void api.browserInput(agentId, input);
  const button = (b: number): BrowserInput['button'] => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left');
  const modifiers = (e: KeyboardEvent | MouseEvent) =>
    [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean) as BrowserInput['modifiers'];

  const onKey = (e: KeyboardEvent, down: boolean) => {
    if (!control) return;
    e.preventDefault();
    const special = SPECIAL_KEYS[e.key];
    if (special) {
      send({ type: down ? 'keyDown' : 'keyUp', key: special, modifiers: modifiers(e) });
    } else if (e.key.length === 1) {
      send({ type: down ? 'keyDown' : 'keyUp', key: e.key, modifiers: modifiers(e) });
      if (down && !e.ctrlKey && !e.metaKey) send({ type: 'char', key: e.key, modifiers: modifiers(e) });
    }
  };

  return (
    <div
      ref={ref}
      tabIndex={control ? 0 : -1}
      onClick={onExpand}
      onMouseDown={control ? (e) => (ref.current?.focus(), send({ type: 'mouseDown', ...toPage(e), button: button(e.button) })) : undefined}
      onMouseUp={control ? (e) => send({ type: 'mouseUp', ...toPage(e), button: button(e.button) }) : undefined}
      onMouseMove={control ? (e) => send({ type: 'mouseMove', ...toPage(e) }) : undefined}
      onWheel={control ? (e) => send({ type: 'mouseWheel', ...toPage(e), deltaX: e.deltaX, deltaY: e.deltaY }) : undefined}
      onContextMenu={control ? (e) => e.preventDefault() : undefined}
      onKeyDown={(e) => onKey(e, true)}
      onKeyUp={(e) => onKey(e, false)}
      className={cx(
        'relative aspect-[1280/800] bg-sunken outline-none',
        // Full screen: as large as fits both ways, never taller than the space.
        fit ? 'max-h-full max-w-full overflow-hidden rounded-xl border border-line shadow-pop' : 'w-full',
        onExpand && 'cursor-zoom-in',
        control && 'cursor-default ring-2 ring-inset ring-warn',
      )}
      style={fit ? { height: 'min(100%, calc((100vw - 2rem) * 0.625))' } : undefined}
    >
      {frame ? (
        <img src={frame} alt="The agent’s browser" draggable={false} className="pointer-events-none h-full w-full select-none object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center text-[12px] text-muted">
          <Loader2 size={14} className="mr-1.5 animate-spin" /> Starting browser…
        </div>
      )}
    </div>
  );
}
