import type { ReleaseChannel } from '@shared/build';
import { versionLabel } from '@shared/build';
import type { UpdateRelease } from '@shared/types';

/** The parts of GitHub's release JSON the updater reads. */
export interface GithubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  assets: Array<{ name: string; browser_download_url: string; size: number; digest?: string | null }>;
}

export interface UpdateCandidate {
  release: UpdateRelease;
  downloadUrl: string;
  fileName: string;
  /** Hex SHA-256 from GitHub's asset digest, when GitHub provides one. */
  sha256: string | null;
}

/**
 * CI names the Windows installer "Nest-Setup-<version>-b<build>.exe" (release.yml),
 * so a release says which commit it was built from without another download.
 */
const INSTALLER = /^Nest-Setup-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-b(\d+)\.exe$/;

export function parseInstallerName(name: string): { version: string; build: number } | null {
  const m = INSTALLER.exec(name);
  return m ? { version: m[1], build: Number(m[2]) } : null;
}

function core(version: string): number[] {
  return version.split('-')[0].split('.').map((n) => Number(n) || 0);
}

/** Positive when a is newer. The version's x.y.z decides first, then the build (commit count). */
export function compareBuilds(a: { version: string; build: number }, b: { version: string; build: number }): number {
  const [x, y] = [core(a.version), core(b.version)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return a.build - b.build;
}

/** The newest installable release newer than what's running. Stable builds ignore prereleases. */
export function pickUpdate(releases: GithubRelease[], current: { version: string; build: number }, channel: ReleaseChannel): UpdateCandidate | null {
  let best: UpdateCandidate | null = null;
  for (const r of releases) {
    if (r.draft || (r.prerelease && channel !== 'beta')) continue;
    for (const asset of r.assets ?? []) {
      const parsed = parseInstallerName(asset.name);
      if (!parsed || compareBuilds(parsed, current) <= 0) continue;
      if (best && compareBuilds(parsed, best.release) <= 0) continue;
      const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : null;
      best = {
        release: { ...parsed, label: versionLabel(parsed.version, parsed.build), tag: r.tag_name, prerelease: r.prerelease, url: r.html_url, bytes: asset.size },
        downloadUrl: asset.browser_download_url,
        fileName: asset.name,
        sha256: digest && /^[0-9a-f]{64}$/.test(digest) ? digest : null,
      };
    }
  }
  return best;
}
