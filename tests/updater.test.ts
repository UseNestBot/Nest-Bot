import { describe, expect, it } from 'vitest';
import { compareBuilds, parseInstallerName, pickUpdate, type GithubRelease } from '../src/main/updateFeed';
import { versionLabel } from '../src/shared/build';

const release = (tag: string, asset: string, opts: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: tag.includes('-'),
  html_url: `https://github.com/UseNestBot/Nest-Bot/releases/tag/${tag}`,
  assets: [
    { name: asset, browser_download_url: `https://example.test/${asset}`, size: 1000, digest: `sha256:${'a'.repeat(64)}` },
    { name: `${asset}.blockmap`, browser_download_url: 'x', size: 10 },
    { name: 'latest.yml', browser_download_url: 'x', size: 10 },
  ],
  ...opts,
});

describe('updater release feed', () => {
  it('labels versions with the build number', () => {
    expect(versionLabel('0.1.0', 15)).toBe('v0.1.0:15');
  });

  it('parses the CI installer name', () => {
    expect(parseInstallerName('Nest-Setup-0.1.0-b42.exe')).toEqual({ version: '0.1.0', build: 42 });
    expect(parseInstallerName('Nest-Setup-0.2.0-beta.1-b7.exe')).toEqual({ version: '0.2.0-beta.1', build: 7 });
    expect(parseInstallerName('Nest Setup 0.1.0.exe')).toBeNull();
  });

  it('orders by version first, then build', () => {
    expect(compareBuilds({ version: '0.1.0', build: 20 }, { version: '0.1.0', build: 15 })).toBeGreaterThan(0);
    expect(compareBuilds({ version: '0.2.0', build: 1 }, { version: '0.1.0', build: 99 })).toBeGreaterThan(0);
    expect(compareBuilds({ version: '0.1.0', build: 15 }, { version: '0.1.0', build: 15 })).toBe(0);
  });

  const feed = [
    release('v0.1.1-beta.1', 'Nest-Setup-0.1.1-beta.1-b30.exe'),
    release('v0.1.0', 'Nest-Setup-0.1.0-b20.exe'),
    release('v0.0.9', 'Nest-Setup-0.0.9-b10.exe'),
    release('v9.0.0', 'Nest-Setup-9.0.0-b99.exe', { draft: true }),
  ];

  it('stable builds skip prereleases and drafts', () => {
    const c = pickUpdate(feed, { version: '0.1.0', build: 15 }, 'stable');
    expect(c?.release.label).toBe('v0.1.0:20');
    expect(c?.sha256).toBe('a'.repeat(64));
  });

  it('beta builds take prereleases', () => {
    expect(pickUpdate(feed, { version: '0.1.0', build: 15 }, 'beta')?.release.tag).toBe('v0.1.1-beta.1');
  });

  it('nightlies reach beta builds but not stable ones', () => {
    // nightly.yml doesn't bump package.json, so the installer carries the plain version.
    const nightly = [release('v0.1.0-nightly.20261102.25', 'Nest-Setup-0.1.0-b25.exe'), release('v0.1.0', 'Nest-Setup-0.1.0-b20.exe')];
    expect(pickUpdate(nightly, { version: '0.1.0', build: 20 }, 'stable')).toBeNull();
    expect(pickUpdate(nightly, { version: '0.1.0', build: 20 }, 'beta')?.release.tag).toBe('v0.1.0-nightly.20261102.25');
  });

  it('offers nothing when already current', () => {
    expect(pickUpdate(feed, { version: '0.1.0', build: 20 }, 'stable')).toBeNull();
  });
});
