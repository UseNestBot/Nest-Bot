// Stamped at build time by electron.vite.config.ts (`define`). Tests run unbundled, so each falls back.
declare const __NEST_VERSION__: string;
declare const __NEST_BUILD__: number;
declare const __NEST_CHANNEL__: string;

export type ReleaseChannel = 'stable' | 'beta';

/** package.json version, e.g. "0.1.0". */
export const APP_VERSION: string = typeof __NEST_VERSION__ === 'string' ? __NEST_VERSION__ : '0.0.0';
/** Commits in the history this build came from: every commit bumps it by one. */
export const BUILD_NUMBER: number = typeof __NEST_BUILD__ === 'number' ? __NEST_BUILD__ : 0;
/** Beta (and nightly) builds get the galaxy banner and also update to prereleases. */
export const RELEASE_CHANNEL: ReleaseChannel = typeof __NEST_CHANNEL__ === 'string' && __NEST_CHANNEL__ === 'beta' ? 'beta' : 'stable';

/** "v0.1.0:123" - the version people see and quote in bug reports. */
export function versionLabel(version: string = APP_VERSION, build: number = BUILD_NUMBER): string {
  return `v${version}:${build}`;
}
