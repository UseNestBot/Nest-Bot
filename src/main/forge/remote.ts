import type { ForgeKind } from '@shared/types';

/** Where a remote lives on a forge. */
export interface RemoteLocation {
  /** Lower case, with a port only for http(s) URLs (an SSH port says nothing about the web address). */
  host: string;
  /** owner/name, or group/subgroup/name; no ".git". */
  path: string;
  /** http only when the remote itself was a plain http URL. */
  scheme: 'https' | 'http';
}

/** SSH endpoints that front a forge's main host. */
const SSH_ALIASES: Record<string, string> = { 'ssh.github.com': 'github.com', 'altssh.gitlab.com': 'gitlab.com' };

/** Hosts Nest knows without being told. */
export const KNOWN_HOSTS: Record<string, ForgeKind> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'forgejo',
  'gitea.com': 'forgejo',
};

/** Parse an https, ssh, git or scp-style (`user@host:path`) remote URL. */
export function parseRemoteUrl(url: string): RemoteLocation | null {
  let scheme: 'https' | 'http' = 'https';
  let host: string;
  let rest: string;
  const full = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url.trim());
  if (full) {
    const proto = full[1].toLowerCase();
    if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(proto)) return null;
    if (proto === 'http') scheme = 'http';
    host = full[2].toLowerCase();
    if (full[3] && (proto === 'https' || proto === 'http')) host += `:${full[3]}`;
    rest = full[4] ?? '';
  } else {
    const scp = /^(?:[^@/\s]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(url.trim());
    if (!scp) return null;
    host = scp[1].toLowerCase();
    rest = scp[2];
  }
  host = SSH_ALIASES[host] ?? host;
  const path = rest
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  const parts = path.split('/');
  if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..')) return null;
  return { host, path, scheme };
}

/** A forge kind for a host: configured, well known, or guessed from its name. */
export function forgeKindFor(host: string, configured: ReadonlyArray<{ host: string; kind: ForgeKind }> = []): ForgeKind | null {
  const h = host.toLowerCase();
  const custom = configured.find((c) => c.host === h);
  if (custom) return custom.kind;
  if (KNOWN_HOSTS[h]) return KNOWN_HOSTS[h];
  const name = h.split(':')[0];
  if (/^gitlab\./.test(name)) return 'gitlab';
  if (/^(gitea|forgejo|codeberg)\./.test(name)) return 'forgejo';
  if (/^github\./.test(name)) return 'github';
  return null;
}

/** The REST API root for a forge host. */
export function apiBase(kind: ForgeKind, host: string, scheme: 'https' | 'http' = 'https'): string {
  if (kind === 'github') return host === 'github.com' ? 'https://api.github.com' : `${scheme}://${host}/api/v3`;
  if (kind === 'gitlab') return `${scheme}://${host}/api/v4`;
  return `${scheme}://${host}/api/v1`;
}

/** A host as the user types it: "git.example.com", "https://git.example.com/", "git.example.com:8443". */
export function normalizeHost(input: string): string | null {
  const h = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/.test(h) ? h : null;
}
