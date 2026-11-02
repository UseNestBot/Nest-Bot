import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { RemoteState } from '@shared/types';

/** Where the Tailscale CLI lives when it isn't on PATH. */
function candidates(): string[] {
  if (process.platform === 'win32') {
    return [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), 'tailscale.exe'];
  }
  if (process.platform === 'darwin') return ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', 'tailscale'];
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'];
}

function run(exe: string, args: string[], timeout = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) });
    });
  });
}

let resolvedExe: string | null | undefined;

async function findExe(): Promise<string | null> {
  if (resolvedExe !== undefined) return resolvedExe;
  for (const c of candidates()) {
    if (path.isAbsolute(c) && !existsSync(c)) continue;
    const res = await run(c, ['version'], 5000);
    if (res.code === 0) return (resolvedExe = c);
  }
  // Not cached: the user may install Tailscale while Nest is open.
  return null;
}

/** What Tailscale says about this machine and whether it already forwards HTTPS to Nest's port. */
export async function tailscaleStatus(port: number): Promise<RemoteState['tailscale']> {
  const exe = await findExe();
  if (!exe) return { installed: false, connected: false, url: null, serving: false };
  const status = await run(exe, ['status', '--json']);
  let dnsName: string | null = null;
  let connected = false;
  try {
    const json = JSON.parse(status.stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    connected = json.BackendState === 'Running';
    dnsName = json.Self?.DNSName?.replace(/\.$/, '') || null;
  } catch {
    /* not signed in, or an old CLI */
  }
  const url = connected && dnsName ? `https://${dnsName}` : null;
  let serving = false;
  if (connected) {
    const serve = await run(exe, ['serve', 'status', '--json']);
    serving = serve.code === 0 && new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(serve.stdout);
  }
  return { installed: true, connected, url, serving };
}

/**
 * `tailscale serve --bg <port>`: HTTPS on the machine's tailnet name, forwarded
 * to 127.0.0.1:<port>. Only devices on the user's tailnet can reach it.
 */
export async function serveOnTailnet(port: number): Promise<void> {
  const exe = await findExe();
  if (!exe) throw new Error('Install Tailscale on this PC first (tailscale.com/download), then sign in.');
  const res = await run(exe, ['serve', '--bg', `http://127.0.0.1:${port}`], 30_000);
  if (res.code !== 0) {
    const out = `${res.stderr}\n${res.stdout}`.trim();
    // e.g. HTTPS certificates are off for the tailnet: Tailscale prints a link to turn them on.
    throw new Error(out.split('\n').filter(Boolean).slice(0, 4).join(' ') || 'tailscale serve failed.');
  }
}
