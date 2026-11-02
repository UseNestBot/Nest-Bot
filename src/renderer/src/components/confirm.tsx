import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button, cx } from './ui';

export interface ConfirmOptions {
  title: string;
  /** Supporting text under the title. Blank lines split it into paragraphs. */
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive actions get a red confirm button and a warning mark. */
  tone?: 'default' | 'danger';
}

interface Pending extends ConfirmOptions {
  id: number;
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** In-app replacement for window.confirm. Resolves true when the user confirms. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...options, id: ++nextId, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  if (!current) return;
  current.resolve(ok);
  current = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Mount once near the root; renders whichever confirm is pending. */
export function ConfirmHost() {
  const pending = useSyncExternalStore(subscribe, () => current);
  return pending ? <ConfirmDialog key={pending.id} {...pending} /> : null;
}

function ConfirmDialog({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', tone = 'default' }: Pending) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [leaving, setLeaving] = useState(false);
  const danger = tone === 'danger';

  const finish = (ok: boolean) => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => settle(ok), 110);
  };

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // Destructive confirms start on Cancel so a stray Enter doesn't delete anything.
    (danger ? cancelRef : confirmRef).current?.focus();
    // Capture phase so an Escape here doesn't also close a modal underneath.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish(false);
      } else if (e.key === 'Tab') {
        const order = [cancelRef.current, confirmRef.current];
        const at = order.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        order[(at + (e.shiftKey ? -1 : 1) + order.length) % order.length]?.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paragraphs = message?.split(/\n\s*\n/) ?? [];

  return (
    <div
      className={cx('confirm-overlay fixed inset-0 z-[60] flex items-center justify-center bg-overlay p-4', leaving && 'is-leaving')}
      onMouseDown={(e) => e.target === e.currentTarget && finish(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={message ? 'confirm-message' : undefined}
        className="confirm-card w-full max-w-[400px] rounded-[20px] border border-line bg-panel p-5 shadow-pop"
      >
        <div className="flex gap-3.5">
          {danger && (
            <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-bad-bg text-bad">
              <AlertTriangle size={17} />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 id="confirm-title" className="font-display text-[15.5px] font-semibold leading-snug text-ink">
              {title}
            </h2>
            {paragraphs.length > 0 && (
              <div id="confirm-message" className="mt-1.5 space-y-2 text-[13px] leading-relaxed text-muted">
                {paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} onClick={() => finish(false)}>
            {cancelLabel}
          </Button>
          <Button
            ref={confirmRef}
            variant="primary"
            className={cx(danger && '!bg-bad !text-white hover:!opacity-90')}
            onClick={() => finish(true)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
