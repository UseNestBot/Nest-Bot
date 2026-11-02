import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/*
 * Shared plumbing for everything that floats above the page: tooltips, popovers
 * and dropdowns. Layers render into one host element outside #root so no
 * scroll container or rounded panel can clip them, and they are placed against
 * their anchor in viewport coordinates, flipping to the opposite side and
 * sliding along the edge when the window is too tight.
 */

export type LayerSide = 'top' | 'bottom' | 'left' | 'right';
export type LayerAlign = 'start' | 'center' | 'end';

export type Placement = { left: number; top: number; side: LayerSide; anchorWidth: number };

/** Keep layers this far from the window edges. */
const EDGE = 8;

const OPPOSITE: Record<LayerSide, LayerSide> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

let hostEl: HTMLDivElement | null = null;

function host(): HTMLDivElement {
  if (!hostEl || !hostEl.isConnected) {
    hostEl = document.createElement('div');
    hostEl.id = 'nest-layers';
    // A click-through sheet over the whole window; each layer opts back in.
    hostEl.style.cssText = 'position:fixed;inset:0;z-index:60;pointer-events:none';
    document.body.appendChild(hostEl);
  }
  return hostEl;
}

/**
 * Places a layer against an anchor while it is open. `anchor` may be set from a
 * ref or straight from an event target; it is read only when open flips to true.
 */
export function useAnchoredLayer<A extends HTMLElement = HTMLElement>(open: boolean, side: LayerSide, align: LayerAlign, gap = 6) {
  const anchor = useRef<A | null>(null);
  const floating = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const f = floating.current?.getBoundingClientRect();
      if (!a || !f) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const fits = (s: LayerSide) =>
        s === 'top'
          ? a.top - gap - f.height >= EDGE
          : s === 'bottom'
            ? a.bottom + gap + f.height <= vh - EDGE
            : s === 'left'
              ? a.left - gap - f.width >= EDGE
              : a.right + gap + f.width <= vw - EDGE;
      const chosen = fits(side) || !fits(OPPOSITE[side]) ? side : OPPOSITE[side];
      const vertical = chosen === 'top' || chosen === 'bottom';
      let left: number;
      let top: number;
      if (vertical) {
        top = chosen === 'top' ? a.top - gap - f.height : a.bottom + gap;
        left = align === 'start' ? a.left : align === 'end' ? a.right - f.width : a.left + (a.width - f.width) / 2;
      } else {
        left = chosen === 'left' ? a.left - gap - f.width : a.right + gap;
        top = align === 'start' ? a.top : align === 'end' ? a.bottom - f.height : a.top + (a.height - f.height) / 2;
      }
      left = Math.round(Math.min(Math.max(left, EDGE), Math.max(EDGE, vw - f.width - EDGE)));
      top = Math.round(Math.min(Math.max(top, EDGE), Math.max(EDGE, vh - f.height - EDGE)));
      const next: Placement = { left, top, side: chosen, anchorWidth: Math.round(a.width) };
      setPos((p) => (p && p.left === left && p.top === top && p.side === chosen && p.anchorWidth === next.anchorWidth ? p : next));
    };
    place();
    // The page can move or resize under an open layer: follow it.
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const observer = new ResizeObserver(place);
    if (floating.current) observer.observe(floating.current);
    if (anchor.current) observer.observe(anchor.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      observer.disconnect();
    };
  }, [open, side, align, gap]);

  return { anchor, floating, pos };
}

/** The positioned wrapper itself carries no look: `children` brings the panel. */
export function Layer({
  pos,
  layerRef,
  above,
  style,
  children,
}: {
  pos: Placement | null;
  layerRef: RefObject<HTMLDivElement | null>;
  /** Tooltips sit above menus when both are on screen. */
  above?: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return createPortal(
    <div
      ref={layerRef}
      data-side={pos?.side ?? ''}
      className="nest-layer"
      // Hidden for the first frame, which is the one that measures it.
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', zIndex: above ? 2 : 1, ...style }}
    >
      {children}
    </div>,
    host(),
  );
}

/**
 * Closes a layer on an outside press, Escape or the window losing focus.
 * Escape is caught on the way down and stopped, so the innermost layer closes
 * without also dismissing the dialog around it.
 */
export function useDismiss(open: boolean, close: () => void, parts: ReadonlyArray<{ readonly current: Element | null }>) {
  const latest = useRef({ close, parts });
  latest.current = { close, parts };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && latest.current.parts.some((r) => r.current?.contains(target))) return;
      latest.current.close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      latest.current.close();
    };
    const onBlur = () => latest.current.close();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);
}
