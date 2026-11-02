import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type { useDictation } from '../dictation/dictation';
import { Tooltip } from './ui';

type Dictation = ReturnType<typeof useDictation>;

const BARS = 30;
/** How often a new column joins the waveform; the rest scroll left. */
const SAMPLE_MS = 55;

/**
 * Floating voice pill above the composer, in the spirit of Wispr Flow: a dark
 * capsule with a live waveform while listening, a calm wave while transcribing.
 */
export function DictationPill({ dictation }: { dictation: Dictation }) {
  const { state, download } = dictation;
  if (state === 'idle') return null;
  const pct = download ? Math.floor((download.loaded / Math.max(1, download.total)) * 100) : null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-full z-20 mb-2.5 flex flex-col items-center gap-1.5">
      {pct !== null && state === 'recording' && <div className="rounded-full bg-panel/90 px-2.5 py-0.5 text-[11.5px] tabular-nums text-muted shadow-float">Getting the voice model, first time only · {pct}%</div>}
      <div role="status" aria-live="polite" className="flow-pop pointer-events-auto relative flex h-11 items-center gap-2 overflow-hidden rounded-full bg-user px-1.5 text-on-user shadow-pop">
        {state === 'recording' ? (
          <>
            <Tooltip label="Discard" keys="Esc">
              <button
                onClick={dictation.cancel}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-on-user/70 transition-colors hover:bg-on-user/15 hover:text-on-user"
                aria-label="Discard dictation"
              >
                <X size={16} strokeWidth={2.2} />
              </button>
            </Tooltip>
            <span className="sr-only">Listening</span>
            <Waveform level={dictation.level} />
            <Elapsed since={dictation.startedAt} />
            <Tooltip label="Insert the text, or release Ctrl+Shift+Space" keys="Enter">
              <button
                onClick={dictation.stop}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-on-user text-user transition-opacity hover:opacity-85"
                aria-label="Insert dictation"
              >
                <Check size={16} strokeWidth={2.6} />
              </button>
            </Tooltip>
          </>
        ) : (
          <div className="flex items-center gap-2.5 pl-3 pr-4">
            <span className="flow-wave flex h-5 items-center gap-[3px]" aria-hidden="true">
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i} style={{ animationDelay: `${i * 0.09}s` }} />
              ))}
            </span>
            <span className="text-[13px] font-medium tabular-nums">{pct !== null ? `Getting the voice model · ${pct}%` : 'Transcribing'}</span>
            {pct !== null && <span className="absolute inset-x-4 bottom-1 h-[2px] rounded-full bg-on-user/15" style={{ backgroundImage: `linear-gradient(to right, currentColor ${pct}%, transparent ${pct}%)` }} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Scrolling level history: newest on the right, fading out to the left. */
function Waveform({ level }: { level: () => number }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    const history = new Array<number>(BARS).fill(0);
    let raf = 0;
    let last = 0;
    let peak = 0;
    const frame = (t: number) => {
      // Keep the loudest moment of each interval so short syllables still show.
      peak = Math.max(peak, level());
      if (t - last >= SAMPLE_MS) {
        history.shift();
        history.push(peak);
        peak = 0;
        last = t;
        history.forEach((v, i) => {
          const el = bars.current[i];
          if (el) el.style.transform = `scaleY(${0.14 + v * 0.86})`;
        });
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [level]);

  return (
    <span className="flow-bars flex h-7 w-[150px] items-center gap-[2px]" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} ref={(el) => void (bars.current[i] = el)} />
      ))}
    </span>
  );
}

function Elapsed({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return (
    <span className="w-9 text-right text-[12.5px] tabular-nums text-on-user/70">
      {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
    </span>
  );
}
