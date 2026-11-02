import path from 'node:path';
import {
  DEFAULT_PERMISSIONS,
  DEFAULT_SETTINGS,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_STEP,
  isProviderId,
  type AppSettings,
  type PermissionSettings,
  type ProviderId,
} from '@shared/types';
import { DICTATION_MODELS } from '@shared/dictation';
import { UserFacingError } from './runs';

export function sanitizePermissions(p: PermissionSettings | undefined): PermissionSettings {
  const perms = p ?? DEFAULT_PERMISSIONS;
  return {
    claudeMode: ['default', 'acceptEdits', 'plan'].includes(perms.claudeMode) ? perms.claudeMode : 'default',
    codexSandbox: ['read-only', 'workspace-write'].includes(perms.codexSandbox) ? perms.codexSandbox : 'workspace-write',
    codexApproval: ['on-request', 'untrusted'].includes(perms.codexApproval) ? perms.codexApproval : 'on-request',
    // Stored as chosen (true, false, or absent = inherit); applied at run time against Settings.
    ...(typeof perms.skipPermissions === 'boolean' ? { skipPermissions: perms.skipPermissions } : {}),
  };
}

type Clean<K extends keyof AppSettings> = (v: unknown) => AppSettings[K];

/** One of a fixed set of values; anything else falls back to the default. */
const oneOf =
  <K extends keyof AppSettings>(key: K, values: ReadonlyArray<AppSettings[K]>): Clean<K> =>
  (v) =>
    values.includes(v as AppSettings[K]) ? (v as AppSettings[K]) : DEFAULT_SETTINGS[key];

const bool = (v: unknown): boolean => Boolean(v);

const text = (name: string, max: number) => (v: unknown): string => {
  if (typeof v !== 'string') throw new UserFacingError(`${name} must be text`);
  if (v.length > max) throw new UserFacingError(`${name} is too long`);
  return v;
};

const optionalPath = (v: unknown): string | null => (v ? text('Path', 1000)(v).trim() || null : null);

/** Font family list: names, quotes, commas and hyphens only, so it can't break out of the CSS value. */
const fontList = (v: unknown): string => {
  const s = text('Font', 200)(v ?? '').trim();
  if (s && !/^[\w\s,'"-]+$/.test(s)) throw new UserFacingError('Use font names separated by commas.');
  return s;
};

const clampStep = (v: unknown, min: number, max: number, step: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n / step) * step));
};

/**
 * How each setting is validated at the trust boundary. Every key in
 * AppSettings has an entry, so adding a setting without one fails typecheck.
 */
const CLEAN: { [K in keyof AppSettings]: Clean<K> } = {
  theme: oneOf('theme', ['system', 'light', 'dark']),
  darkStyle: oneOf('darkStyle', ['dim', 'black']),
  accentColor: oneOf('accentColor', ['blue', 'violet', 'green', 'orange', 'pink', 'graphite']),
  uiScale: (v) => clampStep(v, UI_SCALE_MIN, UI_SCALE_MAX, UI_SCALE_STEP, 100),
  density: oneOf('density', ['compact', 'default', 'comfortable']),
  chatWidth: oneOf('chatWidth', ['narrow', 'default', 'wide']),
  uiFont: fontList,
  codeFont: fontList,
  reduceMotion: bool,
  defaultWorkspace: (v) => {
    const w = v ? text('Folder', 1000)(v) : null;
    if (w && !path.isAbsolute(w)) throw new UserFacingError('Choose an absolute folder path.');
    return w;
  },
  defaultProvider: (v) => {
    if (!isProviderId(v)) throw new UserFacingError('Unknown provider');
    return v;
  },
  defaultModels: (v) => {
    const out: Partial<Record<ProviderId, string>> = {};
    if (!v || typeof v !== 'object') return out;
    for (const [p, model] of Object.entries(v)) {
      if (isProviderId(p) && typeof model === 'string' && model.trim()) out[p] = text('Model', 200)(model.trim());
    }
    return out;
  },
  agentTools: bool,
  notifyWhenUnfocused: bool,
  notifyOn: (v) => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const d = DEFAULT_SETTINGS.notifyOn;
    const pick = (k: keyof typeof d) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d[k]);
    return { finished: pick('finished'), failed: pick('failed'), approval: pick('approval') };
  },
  notificationSound: bool,
  sendKey: oneOf('sendKey', ['enter', 'ctrl-enter']),
  expandActivity: bool,
  showUsage: bool,
  dictationModel: (v) => {
    if (!DICTATION_MODELS.some((m) => m.id === v)) throw new UserFacingError('Unknown dictation model');
    return v as string;
  },
  defaultPermissions: (v) => sanitizePermissions(v as PermissionSettings),
  allowApiKeyBilling: bool,
  allowSkipPermissions: bool,
  skipPermissionsByDefault: bool,
  terminalAlwaysAsk: bool,
  transferBudgetChars: (v) => clampStep(v, 1000, 40000, 1, 8000),
  claudePath: optionalPath,
  codexPath: optionalPath,
  cursorPath: optionalPath,
  geminiPath: optionalPath,
  grokPath: optionalPath,
};

/** Validate a settings patch from the renderer, a paired phone or nest.config.json. Unknown keys are dropped. */
export function sanitizeSettings(patch: unknown): Partial<AppSettings> {
  const clean: Record<string, unknown> = {};
  if (!patch || typeof patch !== 'object') return clean;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || !(key in CLEAN)) continue;
    clean[key] = (CLEAN[key as keyof AppSettings] as (v: unknown) => unknown)(value);
  }
  return clean as Partial<AppSettings>;
}

/** Settings that change which program a provider runs or whether it may run; changing one re-detects providers. */
export const PROVIDER_SETTINGS: ReadonlyArray<keyof AppSettings> = ['claudePath', 'codexPath', 'cursorPath', 'geminiPath', 'grokPath', 'allowApiKeyBilling'];

/** Older builds stored a three-step text size; map it onto the zoom percentage. */
export function migrateLegacySettings(stored: Record<string, unknown>): void {
  if (stored.uiScale === undefined && typeof stored.textSize === 'string') {
    stored.uiScale = stored.textSize === 'small' ? 90 : stored.textSize === 'large' ? 110 : 100;
  }
}
