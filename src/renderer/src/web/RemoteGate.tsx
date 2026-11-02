import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { IS_REMOTE } from '../api';
import { Button, cx, inputClass } from '../components/ui';
import { connect, emitLocal, getToken, onLink, onUnpaired, pair, registerServiceWorker, type Link } from './client';

/**
 * In a phone's browser: the pairing screen until this device has a token, then
 * the app with a strip that says when the PC can't be reached. On the desktop
 * it renders the app untouched.
 */
export function RemoteGate({ children }: { children: ReactNode }) {
  const [paired, setPaired] = useState(() => !IS_REMOTE || Boolean(getToken()));

  useEffect(() => {
    if (!IS_REMOTE) return;
    document.documentElement.dataset.remote = 'true';
    registerServiceWorker((conversationId) => emitLocal({ type: 'open-conversation', conversationId }));
    return onUnpaired(() => setPaired(false));
  }, []);

  if (!paired) return <PairScreen onPaired={() => location.reload()} />;
  return (
    <>
      {IS_REMOTE && <LinkStrip />}
      {children}
    </>
  );
}

function LinkStrip() {
  const [link, setLink] = useState<Link>('connecting');
  useEffect(() => onLink(setLink), []);
  if (link !== 'offline') return null;
  return (
    <div role="status" className="fixed inset-x-0 top-0 z-50 bg-bad-bg px-4 pb-1.5 pt-[max(6px,env(safe-area-inset-top))] text-center text-[12.5px] text-bad-ink">
      Can’t reach your PC. Reconnecting…
    </div>
  );
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Browser';
}

function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await pair(code.replace(/\D/g, ''), name);
      connect();
      onPaired();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-start justify-center overflow-y-auto bg-canvas px-4 pt-[14vh]">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-[360px]">
        <h1 className="font-display text-[24px] font-semibold tracking-[-0.01em]">Connect to Nest</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted">
          On your PC, open Nest → Settings → Remote access and tap <span className="font-medium text-ink">Pair a phone</span>. Enter the 6-digit code it shows.
        </p>
        <label className="mt-7 block text-[13px] font-medium" htmlFor="pair-code">
          Pairing code
        </label>
        <input
          id="pair-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          placeholder="123456"
          className={cx(inputClass, 'mt-1.5 h-12 text-center font-mono text-[22px] tracking-[0.3em]')}
        />
        <label className="mt-4 block text-[13px] font-medium" htmlFor="pair-name">
          Name for this device
        </label>
        <input id="pair-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} className={cx(inputClass, 'mt-1.5 h-11 text-[16px]')} />
        {error && <p className="mt-4 rounded-xl bg-bad-bg px-3 py-2.5 text-[13px] text-bad-ink">{error}</p>}
        <Button type="submit" variant="primary" size="lg" disabled={busy || code.replace(/\D/g, '').length !== 6} className="mt-6 w-full">
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </form>
    </div>
  );
}
