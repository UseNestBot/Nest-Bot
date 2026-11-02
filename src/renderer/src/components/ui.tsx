import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { Layer, useAnchoredLayer, useDismiss, type LayerAlign, type LayerSide } from './layer';
import { MobileBack } from './MobileBack';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', size = 'md', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 font-medium transition-colors disabled:pointer-events-none select-none whitespace-nowrap',
        size === 'sm' && 'h-7 rounded-lg px-2.5 text-[12.5px]',
        size === 'md' && 'h-8 rounded-[10px] px-3 text-[13px]',
        size === 'lg' && 'h-11 rounded-xl px-5 text-[15px]',
        variant === 'primary' && 'bg-primary text-on-primary hover:bg-primary-hover disabled:bg-hover disabled:text-faint',
        variant === 'secondary' && 'border border-line bg-panel text-ink hover:bg-hover disabled:opacity-45',
        variant === 'ghost' && 'text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-45',
        variant === 'danger' && 'border border-line bg-panel text-bad hover:bg-bad-bg disabled:opacity-45',
        className,
      )}
    />
  );
}

/** Icon-only button. Its label names it for screen readers and shows as its tooltip. */
export function IconButton({ label, tip, keys, tipSide, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tip?: ReactNode; keys?: string; tipSide?: LayerSide }) {
  return (
    <Tooltip label={tip ?? label} keys={keys} side={tipSide}>
      <button
        {...rest}
        aria-label={label}
        className={cx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-40', className)}
      >
        {children}
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Tooltip

/** How long the pointer has to rest on a trigger before its tooltip appears. */
const TOOLTIP_DELAY = 340;
/** Moving on to another trigger this soon after one closed skips that wait. */
const TOOLTIP_GRACE = 280;

let lastTooltipHidden = 0;

type TriggerProps = {
  disabled?: boolean;
  'aria-describedby'?: string;
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
};

/** Any single element: cloneElement has to widen whatever props it already has. */
type TriggerElement = ReactElement<any>;

function chain<E>(theirs: ((e: E) => void) | undefined, ours: (e: E) => void): (e: E) => void {
  return (e) => {
    theirs?.(e);
    ours(e);
  };
}

/**
 * Nest's own tooltip, in place of the native `title` attribute: it follows the
 * app's theme and text size, appears after a short rest and on keyboard focus,
 * and can carry a keyboard shortcut.
 *
 * Takes a single element child and adds no wrapper of its own. Chromium sends
 * no pointer events to a disabled element, so a disabled child falls back to a
 * native tooltip.
 */
export function Tooltip({ label, keys, side = 'top', align = 'center', children }: { label: ReactNode; keys?: string; side?: LayerSide; align?: LayerAlign; children: TriggerElement }) {
  const [open, setOpen] = useState(false);
  const { anchor, floating, pos } = useAnchoredLayer(open, side, align, 7);
  const timer = useRef<number | null>(null);
  const id = useId();

  const clear = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);

  const hide = useCallback(() => {
    clear();
    lastTooltipHidden = Date.now();
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && hide();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hide]);

  const show = (el: HTMLElement, now: boolean) => {
    anchor.current = el;
    clear();
    if (now || Date.now() - lastTooltipHidden < TOOLTIP_GRACE) setOpen(true);
    else timer.current = window.setTimeout(() => setOpen(true), TOOLTIP_DELAY);
  };

  const props = children.props as TriggerProps;
  // An optional hint that isn't set leaves the trigger untouched.
  if (!label) return children;
  if (props.disabled) return typeof label === 'string' ? cloneElement(children, { title: keys ? `${label} (${keys})` : label }) : children;

  const trigger = cloneElement(children, {
    'aria-describedby': open ? id : props['aria-describedby'],
    onPointerEnter: chain(props.onPointerEnter, (e: PointerEvent<HTMLElement>) => e.pointerType !== 'touch' && show(e.currentTarget, false)),
    onPointerLeave: chain(props.onPointerLeave, hide),
    onPointerDown: chain(props.onPointerDown, hide),
    // Keyboard users get it at once; clicking moves focus without :focus-visible.
    onFocus: chain(props.onFocus, (e: FocusEvent<HTMLElement>) => e.currentTarget.matches(':focus-visible') && show(e.currentTarget, true)),
    onBlur: chain(props.onBlur, hide),
  });

  return (
    <>
      {trigger}
      {open && (
        <Layer pos={pos} layerRef={floating} above>
          <div id={id} role="tooltip" className="layer-pop pointer-events-none max-w-[264px] break-words rounded-lg border border-line-strong bg-panel px-2 py-1 text-[11.5px] leading-snug text-ink-2 shadow-pop">
            {label}
            {keys && <kbd className="ml-1.5 rounded border border-line-strong bg-sunken px-1 py-px font-sans text-[10.5px] text-muted">{keys}</kbd>}
          </div>
        </Layer>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Menus

/** Shared geometry for menu rows and dropdown options. */
const rowClass = 'flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] text-ink transition-colors';

/** Click-to-open popover anchored to its trigger. Closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  width = 260,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  side?: 'bottom' | 'top';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { anchor, floating, pos } = useAnchoredLayer<HTMLDivElement>(open, side, align === 'right' ? 'end' : 'start', 6);
  useDismiss(open, close, [anchor, floating]);
  return (
    <div className="relative" ref={anchor}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <Layer pos={pos} layerRef={floating}>
          <div className="layer-pop scroll-quiet max-h-[85vh] overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-pop" style={{ width }}>
            {children(close)}
          </div>
        </Layer>
      )}
    </div>
  );
}

export function MenuItem({ children, onClick, active, disabled, hint }: { children: ReactNode; onClick: () => void; active?: boolean; disabled?: boolean; hint?: ReactNode }) {
  return (
    <button disabled={disabled} onClick={onClick} className={cx(rowClass, 'hover:bg-hover disabled:opacity-45', active && 'bg-hover font-medium')}>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {hint && <span className="shrink-0 text-[12px] text-faint">{hint}</span>}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-2 text-[11.5px] font-medium text-faint">{children}</div>;
}

// ---------------------------------------------------------------------------
// Select

export type SelectOption<T extends string> = { value: T; label: string; hint?: string; icon?: ReactNode; disabled?: boolean };

/** Next selectable option in `step` direction, wrapping around. */
function nextEnabled<T extends string>(options: ReadonlyArray<SelectOption<T>>, from: number, step: number): number {
  const n = options.length;
  for (let i = 1; i <= n; i++) {
    const at = (((from + step * i) % n) + n) % n;
    if (!options[at].disabled) return at;
  }
  return from;
}

/**
 * Nest's dropdown, in place of the native `<select>`: it renders with the app's
 * own panel, theme and text size, can show a hint line under each option, and
 * keeps the keyboard behaviour people expect from a select - arrows and
 * Home/End to move, Enter to choose, Escape to dismiss, letters to jump.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = 'Choose…',
  disabled,
  className,
  side = 'bottom',
  align = 'start',
  menuWidth,
}: {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  /** Names the control for screen readers: a <Field> label is not tied to a button. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  side?: 'bottom' | 'top';
  align?: 'start' | 'end';
  menuWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const close = useCallback(() => setOpen(false), []);
  const { anchor, floating, pos } = useAnchoredLayer<HTMLButtonElement>(open, side, align, 5);
  useDismiss(open, close, [anchor, floating]);
  const listId = useId();
  const rows = useRef<Array<HTMLDivElement | null>>([]);
  const typed = useRef({ text: '', at: 0 });

  const selected = options.findIndex((o) => o.value === value);
  const current = selected >= 0 ? options[selected] : undefined;

  useEffect(() => {
    if (open) rows.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const start = () => {
    setActive(selected >= 0 && !options[selected].disabled ? selected : nextEnabled(options, -1, 1));
    setOpen(true);
  };

  const pick = (i: number) => {
    const option = options[i];
    if (option?.disabled) return;
    close();
    anchor.current?.focus();
    if (option && option.value !== value) onChange(option.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        start();
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => nextEnabled(options, i, e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? nextEnabled(options, -1, 1) : nextEnabled(options, options.length, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Type-ahead, the same way a native select jumps to a letter.
      const now = Date.now();
      const text = (now - typed.current.at < 800 ? typed.current.text : '') + e.key.toLowerCase();
      typed.current = { text, at: now };
      const found = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(text));
      if (found >= 0) setActive(found);
    }
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : start())}
        onKeyDown={onKeyDown}
        className={cx(
          'inline-flex items-center justify-between gap-2 rounded-[10px] border border-line-strong bg-panel px-3 py-1.5 text-left text-[13.5px] text-ink outline-none transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-45',
          open && 'border-accent',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {current?.icon}
          <span className={cx('truncate', !current && 'text-faint')}>{current?.label ?? placeholder}</span>
        </span>
        <ChevronDown size={14} className={cx('shrink-0 text-faint transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && (
        // The anchor width is already zoomed, so it goes on the unzoomed wrapper;
        // the panel's own floor stays in design pixels.
        <Layer pos={pos} layerRef={floating} style={menuWidth ? undefined : { minWidth: pos?.anchorWidth }}>
          <div
            id={listId}
            role="listbox"
            aria-label={label}
            className="layer-pop scroll-quiet max-h-[min(340px,70vh)] min-w-[168px] overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-pop"
            style={{ width: menuWidth }}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                ref={(el) => {
                  rows.current[i] = el;
                }}
                onPointerMove={() => !o.disabled && i !== active && setActive(i)}
                onClick={() => pick(i)}
                className={cx(rowClass, o.disabled ? 'opacity-45' : 'cursor-default', i === active && !o.disabled && 'bg-hover')}
              >
                {o.icon}
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate', o.value === value && 'font-medium')}>{o.label}</span>
                  {o.hint && <span className="block truncate text-[11.5px] text-muted">{o.hint}</span>}
                </span>
                {o.value === value && <Check size={13} className="shrink-0 text-ink-2" />}
              </div>
            ))}
          </div>
        </Layer>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Combobox

export type ComboOption = { value: string; label: string; cost?: number };

const COST_WORDS = ['', 'Cheapest to run', 'Moderate cost to run', 'Expensive to run', 'Most expensive to run'];

/** Four signal-strength bars; the filled count shows how costly a model is to run (1–4). */
export function CostBars({ cost, className }: { cost: number; className?: string }) {
  const word = COST_WORDS[cost] ?? '';
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" role="img" aria-label={word} className={cx('shrink-0', className)}>
      <title>{word}</title>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 3.5} y={9 - i * 3} width="2.5" height={3 + i * 3} rx="0.75" fill="currentColor" opacity={i < cost ? 0.9 : 0.22} />
      ))}
    </svg>
  );
}

/**
 * A text field with Nest's own suggestion menu, in place of `<input list>` +
 * `<datalist>`: the menu matches the composer's model picker, filters as you
 * type, and free text is still accepted. An option whose value is '' clears
 * the field (e.g. "Default").
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<ComboOption>;
  placeholder?: string;
  /** Names the field for screen readers. */
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(false);
  const [active, setActive] = useState(-1);
  const close = useCallback(() => setOpen(false), []);
  const { anchor, floating, pos } = useAnchoredLayer<HTMLDivElement>(open, 'bottom', 'start', 5);
  useDismiss(open, close, [anchor, floating]);
  const input = useRef<HTMLInputElement>(null);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();

  // Typing narrows the list; opening it from the chevron or by focus shows everything.
  const q = value.trim().toLowerCase();
  const shown = filter && q ? options.filter((o) => !o.value || o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)) : options;

  useEffect(() => {
    if (open && active >= 0) rows.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const show = (filtered: boolean) => {
    setFilter(filtered);
    setActive(-1);
    setOpen(true);
  };
  const pick = (o: ComboOption) => {
    onChange(o.value);
    close();
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show(false);
      const n = shown.length;
      if (n) setActive((i) => (e.key === 'ArrowDown' ? (i + 1) % n : (i <= 0 ? n : i) - 1));
    } else if (e.key === 'Enter' && open && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  };

  return (
    <div ref={anchor} className={cx('relative', className)}>
      <input
        ref={input}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          show(true);
        }}
        onClick={() => !open && show(false)}
        onKeyDown={onKeyDown}
        className={cx(inputClass, 'pr-8', open && 'border-accent')}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={open ? 'Hide suggestions' : 'Show suggestions'}
        onClick={() => {
          if (open) close();
          else show(false);
          input.current?.focus();
        }}
        className="absolute inset-y-0 right-0 flex w-8 items-center justify-center text-faint hover:text-ink"
      >
        <ChevronDown size={14} className={cx('transition-transform duration-150', open && 'rotate-180')} />
      </button>
      {open && shown.length > 0 && (
        <Layer pos={pos} layerRef={floating} style={{ minWidth: pos?.anchorWidth }}>
          <div id={listId} role="listbox" aria-label={label} className="layer-pop scroll-quiet max-h-[min(320px,60vh)] min-w-[200px] overflow-y-auto rounded-2xl border border-line bg-panel p-1.5 shadow-pop">
            {shown.map((o, i) => {
              const selected = o.value === value.trim();
              return (
                <button
                  key={o.value || '__default'}
                  id={`${listId}-${i}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
                  ref={(el) => {
                    rows.current[i] = el;
                  }}
                  onPointerMove={() => i !== active && setActive(i)}
                  onClick={() => pick(o)}
                  className={cx(rowClass, (i === active || selected) && 'bg-hover', selected && 'font-medium')}
                >
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.cost ? <CostBars cost={o.cost} className="text-muted" /> : null}
                  {selected ? <Check size={13} className="shrink-0 text-faint" /> : o.cost ? <span className="w-[13px] shrink-0" /> : null}
                </button>
              );
            })}
          </div>
        </Layer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Modal({ title, onClose, children, footer, width = 520 }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label={title} className="flex max-h-[90vh] w-full flex-col rounded-[22px] border border-line bg-panel shadow-pop" style={{ maxWidth: width }}>
        <div className="flex items-center justify-between px-5 pb-2 pt-4">
          <h2 className="font-display text-[16px] font-semibold">{title}</h2>
          <IconButton label="Close" keys="Esc" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </div>
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * A label click activates its first control. When that's a button (a segmented
 * choice, a picker), clicking the label text would silently pick it: don't.
 */
function keepLabelOffButtons(e: React.MouseEvent<HTMLLabelElement>) {
  if ((e.target as HTMLElement).closest('button, input, textarea, select, a')) return;
  if (e.currentTarget.querySelector('button, input, textarea, select') instanceof HTMLButtonElement) e.preventDefault();
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block" onClick={keepLabelOffButtons}>
      <span className="mb-1.5 block text-[12.5px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  'w-full rounded-[10px] border border-line-strong bg-panel px-3 py-1.5 text-[13.5px] text-ink placeholder:text-faint outline-none transition-colors focus:border-accent';

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}
    >
      <span className={cx('inline-block h-[16px] w-[16px] rounded-full bg-white shadow-sm transition-transform', checked ? 'translate-x-[16px]' : 'translate-x-[2px]')} />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-[10px] bg-hover p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx('rounded-lg px-2.5 py-1 text-[12.5px] transition-colors', value === o.value ? 'bg-panel font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'text-muted hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <div className="text-[15px] font-medium text-ink">{title}</div>
      {children && <div className="mt-1 max-w-sm text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function ScreenHeader({ title, subtitle, actions, onBack, backLabel }: { title: string; subtitle?: string; actions?: ReactNode; onBack?: () => void; backLabel?: string }) {
  return (
    <div className="app-drag flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line pl-6 pr-3 max-[640px]:pl-4">
      <div className="flex min-w-0 items-center">
        <MobileBack onBack={onBack} label={backLabel} />
        <div className="min-w-0">
          <h1 className="truncate font-display text-[16px] font-semibold">{title}</h1>
          {subtitle && <div className="truncate text-[12px] text-muted">{subtitle}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <div className="titlebar-spacer" />
      </div>
    </div>
  );
}

/** Small section heading used in panels and the new-agent screen. */
export function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <h3 className="text-[13px] font-medium text-muted">{children}</h3>
      {action}
    </div>
  );
}
