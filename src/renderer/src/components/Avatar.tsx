import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AvatarEyes, AvatarShape, AvatarSpec } from '@shared/types';
import type { Reaction } from '../store';

/** Brown, red, orange, amber, green, teal, blue, purple, pink, gray. */
export const AVATAR_COLORS = ['#8a5a3b', '#e5484d', '#f06f2c', '#f2a533', '#4cbe6c', '#3fb5a3', '#3b82f6', '#8b5cf6', '#ec4899', '#6e6e76'];
export const AVATAR_SHAPES: AvatarShape[] = ['blob', 'square', 'pill', 'triangle', 'hex', 'diamond', 'leaf'];
export const AVATAR_EYES: AvatarEyes[] = ['dots', 'happy', 'wide', 'sleepy'];

export const SHAPE_LABEL: Record<AvatarShape, string> = {
  blob: 'Round',
  square: 'Square',
  pill: 'Pill',
  triangle: 'Triangle',
  hex: 'Hexagon',
  diamond: 'Diamond',
  leaf: 'Drop',
};

export const EYES_LABEL: Record<AvatarEyes, string> = { dots: 'Curious', happy: 'Happy', wide: 'Wide-eyed', sleepy: 'Sleepy' };

/**
 * Flat silhouettes on a 100×100 grid. Polygons get soft corners from a round
 * stroke in the fill color (`round` is that stroke width).
 */
const SHAPES: Record<AvatarShape, { d: string; round?: number }> = {
  blob: { d: 'M50 7a43 43 0 1 1 0 86a43 43 0 1 1 0-86Z' },
  square: { d: 'M34 10h32a24 24 0 0 1 24 24v32a24 24 0 0 1-24 24H34a24 24 0 0 1-24-24V34a24 24 0 0 1 24-24Z' },
  pill: { d: 'M30 25h40a25 25 0 0 1 0 50H30a25 25 0 0 1 0-50Z' },
  triangle: { d: 'M50 15L89 83H11Z', round: 14 },
  hex: { d: 'M50 10L84 29.5V70.5L50 90L16 70.5V29.5Z', round: 12 },
  diamond: { d: 'M50 12L88 50L50 88L12 50Z', round: 14 },
  leaf: { d: 'M50 6c4 6 34 34 34 57a34 34 0 0 1-68 0c0-23 30-51 34-57Z' },
};

/** Where the pair of eyes sits in each silhouette: a little up and to the right, as if glancing aside. */
const EYE_AT: Record<AvatarShape, [number, number]> = {
  blob: [58, 42],
  square: [58, 44],
  pill: [60, 48],
  triangle: [54, 63],
  hex: [57, 46],
  diamond: [56, 47],
  leaf: [56, 61],
};

function Eye({ kind, x, y }: { kind: AvatarEyes; x: number; y: number }) {
  switch (kind) {
    case 'happy':
      return <path d={`M${x - 5} ${y + 3}q5-8 10 0`} fill="none" stroke="#fff" strokeWidth="5.5" strokeLinecap="round" />;
    case 'wide':
      return <circle cx={x} cy={y} r="6" fill="#fff" />;
    case 'sleepy':
      return <path d={`M${x - 5} ${y + 1.5}l10-2`} fill="none" stroke="#fff" strokeWidth="6" strokeLinecap="round" />;
    default:
      return <path d={`M${x - 2} ${y + 6}L${x + 2} ${y - 6}`} fill="none" stroke="#fff" strokeWidth="8" strokeLinecap="round" />;
  }
}

/** Reactions older than this are history: re-mounting a row must not replay them. */
const REACTION_FRESH_MS = 1500;
/** How long the eyes stay happy after a finished run. */
const GLEE_MS = 1600;

/**
 * One-shot reactions, in the SVG's 100-unit grid, squashing from the feet.
 * Played with the Web Animations API on their own layer so they never restart the working bob.
 */
const REACTIONS: Record<Reaction['kind'], { frames: Keyframe[]; ms: number; easing: string }> = {
  // Started a new step: a quick nod.
  perk: {
    ms: 320,
    easing: 'ease-out',
    frames: [{ transform: 'none' }, { transform: 'scale(1.06, 0.95)', offset: 0.4 }, { transform: 'scale(0.98, 1.03)', offset: 0.7 }, { transform: 'none' }],
  },
  // Finished: a little hop.
  done: {
    ms: 620,
    easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)',
    frames: [
      { transform: 'none' },
      { transform: 'scale(1.08, 0.88)', offset: 0.2 },
      { transform: 'translateY(-10px) scale(0.95, 1.06)', offset: 0.5 },
      { transform: 'scale(1.04, 0.95)', offset: 0.78 },
      { transform: 'none' },
    ],
  },
  // Failed: a wobble.
  failed: {
    ms: 450,
    easing: 'ease-in-out',
    frames: [
      { transform: 'none' },
      { transform: 'translateX(-3px) rotate(-4deg)', offset: 0.2 },
      { transform: 'translateX(3px) rotate(3deg)', offset: 0.45 },
      { transform: 'translateX(-1.5px) rotate(-1.5deg)', offset: 0.7 },
      { transform: 'none' },
    ],
  },
};

type Anim = { ms: number; easing: string; frames: Keyframe[] };

/**
 * Clicked (petted): each pet plays the next of these, round and round.
 * Frames squash from the feet unless they set their own origin.
 */
const PETS: Anim[] = [
  // A squishy boing, bigger than the finished hop.
  {
    ms: 600,
    easing: 'cubic-bezier(0.3, 1.4, 0.5, 1)',
    frames: [
      { transform: 'none' },
      { transform: 'scale(1.15, 0.82)', offset: 0.15 },
      { transform: 'translateY(-8px) scale(0.9, 1.12)', offset: 0.35 },
      { transform: 'scale(1.05, 0.96)', offset: 0.55 },
      { transform: 'scale(0.98, 1.02)', offset: 0.75 },
      { transform: 'none' },
    ],
  },
  // A happy side-to-side wiggle, rocking on its feet.
  {
    ms: 700,
    easing: 'ease-in-out',
    frames: [
      { transform: 'none' },
      { transform: 'rotate(-12deg)', offset: 0.18 },
      { transform: 'rotate(10deg)', offset: 0.4 },
      { transform: 'rotate(-7deg)', offset: 0.6 },
      { transform: 'rotate(4deg)', offset: 0.8 },
      { transform: 'none' },
    ],
  },
  // A twirl on the spot.
  {
    ms: 750,
    easing: 'cubic-bezier(0.45, 0, 0.3, 1)',
    frames: [
      { transform: 'none', transformOrigin: '50% 50%' },
      { transform: 'scale(1.08, 0.92)', transformOrigin: '50% 50%', offset: 0.15 },
      { transform: 'translateY(-6px) rotate(360deg) scale(0.96, 1.04)', transformOrigin: '50% 50%', offset: 0.8 },
      { transform: 'rotate(360deg)', transformOrigin: '50% 50%' },
    ],
  },
  // A big crouch and a high jump.
  {
    ms: 800,
    easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)',
    frames: [
      { transform: 'none' },
      { transform: 'scale(1.2, 0.75)', offset: 0.22 },
      { transform: 'translateY(-18px) scale(0.88, 1.14)', offset: 0.5 },
      { transform: 'translateY(-14px) scale(0.95, 1.05)', offset: 0.62 },
      { transform: 'scale(1.12, 0.86)', offset: 0.84 },
      { transform: 'none' },
    ],
  },
  // A jelly wobble.
  {
    ms: 800,
    easing: 'ease-out',
    frames: [
      { transform: 'none' },
      { transform: 'scale(1.18, 0.84)', offset: 0.14 },
      { transform: 'scale(0.86, 1.16)', offset: 0.3 },
      { transform: 'scale(1.1, 0.92)', offset: 0.46 },
      { transform: 'scale(0.94, 1.06)', offset: 0.62 },
      { transform: 'scale(1.03, 0.98)', offset: 0.8 },
      { transform: 'none' },
    ],
  },
];

/** A friend joined their folder: two quick bounces. */
const CHEER: Anim = {
  ms: 900,
  easing: 'cubic-bezier(0.3, 0.7, 0.4, 1)',
  frames: [
    { transform: 'none' },
    { transform: 'scale(1.1, 0.88)', offset: 0.1 },
    { transform: 'translateY(-9px) rotate(-6deg) scale(0.95, 1.06)', offset: 0.28 },
    { transform: 'scale(1.08, 0.9)', offset: 0.46 },
    { transform: 'translateY(-9px) rotate(6deg) scale(0.95, 1.06)', offset: 0.66 },
    { transform: 'scale(1.04, 0.95)', offset: 0.85 },
    { transform: 'none' },
  ],
};
/** How long cheering agents keep their happy eyes. */
const CHEER_MS = 1300;
const CHEER_EVENT = 'nest:avatar-cheer';

/** Every avatar showing an agent other than `newcomer` cheers, each a beat apart. */
export function cheerAgents(newcomer: string) {
  window.dispatchEvent(new CustomEvent(CHEER_EVENT, { detail: { newcomer } }));
}

/** How long a poked agent stays delighted (happy eyes, blush, heart). */
const POKE_MS = 900;

/**
 * An agent's face. It blinks now and then, bobs and glances about while `working`,
 * and plays `reaction` once (see styles.css, "Avatar life"). Every instance gets its
 * own blink rhythm so a sidebar full of agents never blinks in unison.
 *
 * Clicking it pets it: happy eyes, a blush, a floating heart and the next of five
 * little dances (PETS). The click still reaches whatever button the avatar sits inside.
 * With an `agentId` it also joins in when another agent is dropped into a folder.
 */
export function Avatar({
  spec,
  size = 32,
  className,
  working = false,
  reaction,
  still = false,
  agentId,
}: {
  spec: AvatarSpec;
  size?: number;
  className?: string;
  working?: boolean;
  reaction?: Reaction;
  /** No idle blinking, for pickers and other places the face is a swatch. */
  still?: boolean;
  /** Whose face this is, so it can cheer when a different agent joins a folder. */
  agentId?: string;
}) {
  const shape = SHAPES[spec.shape] ? spec.shape : 'blob';
  const { d, round } = SHAPES[shape];
  const [x, y] = EYE_AT[shape];
  const [rhythm] = useState(() => ({ dur: 4.5 + Math.random() * 3.5, delay: -Math.random() * 8 }));

  const fresh = reaction && Date.now() - reaction.at < REACTION_FRESH_MS ? reaction : undefined;
  const glee = useGlee(fresh?.kind === 'done' ? fresh.at : undefined);
  const layer = useRef<SVGGElement>(null);
  // Keyed on the timestamp: each reaction plays once.
  useEffect(() => {
    const el = layer.current;
    if (!fresh || !el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const { frames, ms, easing } = REACTIONS[fresh.kind];
    const anim = el.animate(frames, { duration: ms, easing });
    return () => anim.cancel();
  }, [fresh?.at]);
  const [poke, setPoke] = useState(0);
  const pokeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pokeTimer.current), []);
  // Which dance the next pet plays; survives the delight wearing off.
  const nextPet = useRef(0);
  const play = (anim: Anim) => {
    const el = layer.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate(anim.frames, { duration: anim.ms, easing: anim.easing });
  };
  const onPoke = () => {
    clearTimeout(pokeTimer.current);
    setPoke((n) => n + 1);
    pokeTimer.current = setTimeout(() => setPoke(0), POKE_MS);
    play(PETS[nextPet.current]);
    nextPet.current = (nextPet.current + 1) % PETS.length;
  };
  const poked = poke > 0;

  const [cheering, setCheering] = useState(false);
  useEffect(() => {
    if (!agentId) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onCheer = (e: Event) => {
      if ((e as CustomEvent<{ newcomer: string }>).detail.newcomer === agentId) return;
      // Staggered so the crowd doesn't bounce in lockstep.
      timers.push(
        setTimeout(() => {
          setCheering(true);
          play(CHEER);
          timers.push(setTimeout(() => setCheering(false), CHEER_MS));
        }, Math.random() * 300),
      );
    };
    window.addEventListener(CHEER_EVENT, onCheer);
    return () => {
      window.removeEventListener(CHEER_EVENT, onCheer);
      timers.forEach(clearTimeout);
    };
  }, [agentId]);

  const eyes = glee || poked || cheering ? 'happy' : spec.eyes;

  const blinks = !still && size >= 20;
  const style = { '--blink-dur': `${rhythm.dur}s`, '--blink-delay': `${rhythm.delay}s` } as CSSProperties;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className={className} aria-hidden="true" style={{ ...style, overflow: 'visible' }} onClick={onPoke}>
      <g ref={layer} className="av-react">
        <g className={working ? 'av-bob' : undefined}>
          <path d={d} fill={spec.color} stroke={round ? spec.color : undefined} strokeWidth={round} strokeLinejoin="round" />
          {(poked || cheering) && (
            <g fill="#ff8fb1" opacity="0.75">
              <ellipse cx={x - 15} cy={y + 10} rx="5" ry="3" />
              <ellipse cx={x + 15} cy={y + 10} rx="5" ry="3" />
            </g>
          )}
          <g className={working ? 'av-glance' : undefined}>
            <g className={blinks ? 'av-blink' : undefined}>
              <Eye kind={eyes} x={x - 8} y={y} />
              <Eye kind={eyes} x={x + 8} y={y} />
            </g>
          </g>
        </g>
      </g>
      {poked && (
        <path
          // Keyed so a second poke sends up a fresh heart.
          key={poke}
          className="avatar-heart"
          d="M84 22c-3-6-12-5-12 2c0 5 6 9 12 14c6-5 12-9 12-14c0-7-9-8-12-2Z"
          fill="#ff5c8a"
        />
      )}
    </svg>
  );
}

/** True for a short while after `at`, so a finished agent looks pleased with itself. */
function useGlee(at: number | undefined): boolean {
  const [until, setUntil] = useState(0);
  useEffect(() => {
    if (!at) return;
    const end = at + GLEE_MS;
    const left = end - Date.now();
    if (left <= 0) return;
    setUntil(end);
    const t = setTimeout(() => setUntil(0), left);
    return () => clearTimeout(t);
  }, [at]);
  return until > 0;
}

/** Small overlapping cluster for agent groups. */
export function AvatarStack({ specs, ids = [], size = 18, working = [] }: { specs: AvatarSpec[]; ids?: string[]; size?: number; working?: boolean[] }) {
  const shown = specs.slice(0, 3);
  return (
    <div className="relative shrink-0" style={{ width: size * 1.9, height: size * 1.9 }}>
      {shown.map((s, i) => (
        <div key={i} className="absolute" style={{ left: i === 1 ? size * 0.9 : i === 2 ? size * 0.45 : 0, top: i === 2 ? size * 0.9 : 0 }}>
          <Avatar spec={s} size={size} working={working[i]} agentId={ids[i]} />
        </div>
      ))}
    </div>
  );
}

export function randomAvatar(): AvatarSpec {
  const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  return { shape: pick(AVATAR_SHAPES), color: pick(AVATAR_COLORS), eyes: 'dots' };
}
