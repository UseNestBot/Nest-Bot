import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore, type PanePlace } from '../store';
import { ConversationView } from './Conversation';
import { dragged, isChatDrag } from './Projects';
import { cx } from './ui';

/** Narrowest a pane can be dragged to. */
const MIN_PANE_PX = 320;

/** True while a chat is being dragged anywhere in the window, so panes can show where it would dock. */
function useChatDragging(): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    // Wait a frame: changing the page during dragstart can cancel the drag.
    const start = (e: globalThis.DragEvent) => {
      const chat = Boolean(e.dataTransfer && isChatDrag(e.dataTransfer));
      requestAnimationFrame(() => setDragging(chat));
    };
    const stop = () => setDragging(false);
    document.addEventListener('dragstart', start);
    document.addEventListener('dragend', stop);
    document.addEventListener('drop', stop);
    return () => {
      document.removeEventListener('dragstart', start);
      document.removeEventListener('dragend', stop);
      document.removeEventListener('drop', stop);
    };
  }, []);
  return dragging;
}

/**
 * The open chats side by side. Click a pane to focus it, drag the dividers to
 * resize, and drag a chat (a sidebar row or a pane's grip) onto either half of
 * a pane to dock it on that side.
 */
export function Panes({ single }: { single: boolean }) {
  const { state, openConversation, resizePanes } = useStore();
  const focused = state.view.name === 'conversation' ? state.view.id : undefined;
  const dragging = useChatDragging();
  const refs = useRef(new Map<string, HTMLDivElement>());

  // On a phone only the focused chat shows.
  const panes = (single ? state.panes.filter((id) => id === focused) : state.panes).filter((id) => state.details[id]);
  const split = panes.length > 1;

  const startResize = (e: ReactPointerEvent, left: string, right: string) => {
    const a = refs.current.get(left);
    const b = refs.current.get(right);
    if (!a || !b) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const wa = a.getBoundingClientRect().width;
    const total = wa + b.getBoundingClientRect().width;
    const weight = (state.paneSizes[left] ?? 1) + (state.paneSizes[right] ?? 1);
    const move = (ev: PointerEvent) => {
      const next = Math.min(Math.max(wa + ev.clientX - startX, MIN_PANE_PX), total - MIN_PANE_PX);
      resizePanes({ [left]: (weight * next) / total, [right]: (weight * (total - next)) / total });
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  return (
    <div className="scroll-quiet flex h-full min-w-0 flex-1 overflow-x-auto">
      {panes.map((id, i) => (
        <div key={id} className="contents">
          {i > 0 && (
            <div
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize. Double-click to even out."
              onPointerDown={(e) => startResize(e, panes[i - 1], id)}
              onDoubleClick={() => resizePanes(Object.fromEntries(panes.map((p) => [p, 1])))}
              className="group/divider relative w-px shrink-0 cursor-col-resize bg-line"
            >
              <span className="absolute inset-y-0 -left-[3px] -right-[3px] z-20 transition-colors group-hover/divider:bg-accent/40" />
            </div>
          )}
          <div
            ref={(el) => {
              if (el) refs.current.set(id, el);
              else refs.current.delete(id);
            }}
            onMouseDownCapture={() => id !== focused && void openConversation(id)}
            onFocusCapture={() => id !== focused && void openConversation(id)}
            style={{ flexGrow: split ? (state.paneSizes[id] ?? 1) : 1, minWidth: split ? MIN_PANE_PX : undefined }}
            className="relative flex h-full min-w-0 shrink basis-0"
          >
            {split && id === focused && <div className="pointer-events-none absolute inset-x-0 top-0 z-30 h-[2px] bg-accent" aria-hidden="true" />}
            <ConversationView detail={state.details[id]} pane={{ split, focused: id === focused, first: i === 0, last: i === panes.length - 1 }} />
            {dragging && !single && <DockZones target={id} onDock={(chat, place) => void openConversation(chat, place, id)} />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Left and right halves of a pane that a dragged chat can be dropped on. */
function DockZones({ target, onDock }: { target: string; onDock: (chat: string, place: PanePlace) => void }) {
  const [over, setOver] = useState<'left' | 'right' | null>(null);
  const zone = (side: 'left' | 'right') => ({
    onDragOver: (e: DragEvent) => {
      if (!isChatDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (over !== side) setOver(side);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === side ? null : o));
    },
    onDrop: (e: DragEvent) => {
      setOver(null);
      const what = dragged(e);
      if (what?.kind !== 'chat') return;
      e.preventDefault();
      if (what.id !== target) onDock(what.id, side);
    },
  });
  return (
    // no-drag: the header strip is a window drag region, which would otherwise swallow the drop.
    <div className="absolute inset-0 z-40 flex [-webkit-app-region:no-drag]">
      {(['left', 'right'] as const).map((side) => (
        <div key={side} {...zone(side)} className="relative flex-1">
          <div
            className={cx(
              'pointer-events-none absolute inset-y-2 flex items-center justify-center rounded-2xl border-2 border-dashed text-[13px] font-medium transition-all',
              side === 'left' ? 'left-2 right-1' : 'left-1 right-2',
              over === side ? 'border-accent bg-accent/10 text-ink' : 'border-transparent text-transparent',
            )}
          >
            Dock {side}
          </div>
        </div>
      ))}
    </div>
  );
}
