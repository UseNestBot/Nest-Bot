import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NestEvent } from '../src/shared/types';
import { TerminalHost, plainText } from '../src/main/terminal';

describe('plainText', () => {
  it('drops escape codes and applies carriage-return overwrites', () => {
    expect(plainText('\x1b[32mok\x1b[0m\r\n')).toBe('ok\n');
    expect(plainText('10%\r50%\r100%')).toBe('100%');
    expect(plainText('a\x1b]0;title\x07b')).toBe('ab');
  });
});

describe.skipIf(process.platform === 'win32')('TerminalHost', () => {
  const events: NestEvent[] = [];
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nest-term-')));
  const host = new TerminalHost((e) => events.push(e), () => dir);
  afterEach(() => host.closeAll());

  it('runs commands in the working folder and keeps shell state', async () => {
    const pwd = await host.run('c1', 'pwd', 10_000, 'Test');
    expect(pwd.text).toContain(`Exit code 0`);
    expect(pwd.text).toContain(dir);
    await host.run('c1', 'export NEST_X=hello', 10_000, 'Test');
    const echo = await host.run('c1', 'echo "$NEST_X world"', 10_000, 'Test');
    expect(echo.text).toBe('Exit code 0\n\nhello world');
    const fail = await host.run('c1', 'false', 10_000, 'Test');
    expect(fail.text).toContain('Exit code 1');
    const multi = await host.run('c1', 'echo one\necho two', 10_000, 'Test');
    expect(multi.text).toBe('Exit code 0\n\none\ntwo');
    expect(events.some((e) => e.type === 'terminal-data' && e.data.includes('hello world'))).toBe(true);
  }, 30_000);

  it('returns on timeout, refuses while busy, and stops with Ctrl-C', async () => {
    const slow = await host.run('c2', 'sleep 30', 800, 'Test');
    expect(slow.text).toContain('Still running');
    const busy = await host.run('c2', 'echo hi', 2000, 'Test');
    expect(busy.ok).toBe(false);
    host.sendKeys('c2', '\u0003');
    await new Promise((r) => setTimeout(r, 500));
    const after = await host.run('c2', 'echo back', 5000, 'Test');
    expect(after.text).toContain('back');
    expect(host.read('c2', 50)).toContain('back');
  }, 30_000);

  it('takes the user’s keystrokes', async () => {
    await host.run('c3', 'true', 10_000, 'Test');
    host.input('c3', 'echo typed-by-user\r');
    await new Promise((r) => setTimeout(r, 800));
    expect(host.read('c3', 20)).toContain('typed-by-user');
  }, 30_000);
});

// Windows has no pty without a native module: PowerShell over pipes, with Nest handling Ctrl-C itself.
describe.runIf(process.platform === 'win32')('TerminalHost on Windows', () => {
  const events: NestEvent[] = [];
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'nest-term-')));
  const host = new TerminalHost((e) => events.push(e), () => dir);
  afterEach(() => host.closeAll());
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const running = (marker: string) =>
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' -and $_.Name -eq 'ping.exe' }).Count`], { encoding: 'utf8' }).trim();

  it('runs in the working folder, keeps state and reports exit codes', async () => {
    const pwd = await host.run('w1', '(Get-Location).Path', 20_000, 'Test');
    expect(pwd.text).toContain('Exit code 0');
    expect(pwd.text.toLowerCase()).toContain(dir.toLowerCase());
    await host.run('w1', '$env:NEST_X = "hello"', 10_000, 'Test');
    expect((await host.run('w1', 'Write-Output "$env:NEST_X world"', 10_000, 'Test')).text).toContain('hello world');
    expect((await host.run('w1', 'cmd /c exit 3', 10_000, 'Test')).text).toContain('Exit code 3');
  }, 60_000);

  it('Ctrl-C stops a native command and keeps the shell', async () => {
    await host.run('w2', '$env:NEST_KEEP = "kept"', 20_000, 'Test');
    const slow = await host.run('w2', 'ping -n 60 127.0.0.1', 1500, 'Test');
    expect(slow.text).toContain('Still running');
    host.sendKeys('w2', '\u0003');
    await wait(6000);
    const after = await host.run('w2', 'Write-Output "$env:NEST_KEEP"', 10_000, 'Test');
    expect(after.text).toContain('kept');
  }, 60_000);

  it('Ctrl-C on a PowerShell built-in restarts the shell in the same folder', async () => {
    const sub = path.join(dir, 'sub');
    await host.run('w3', `New-Item -ItemType Directory -Force '${sub}' | Out-Null; Set-Location '${sub}'`, 20_000, 'Test');
    await host.run('w3', 'Start-Sleep -Seconds 60', 1500, 'Test');
    host.sendKeys('w3', '\u0003');
    await wait(8000);
    const after = await host.run('w3', '(Get-Location).Path', 20_000, 'Test');
    expect(after.text).toContain('Exit code 0');
    expect(after.text.toLowerCase()).toContain(sub.toLowerCase());
    expect(host.read('w3', 50)).toContain('restarted');
  }, 60_000);

  it('closing the terminal stops what it started', async () => {
    const marker = `127.0.0.${Math.floor(Math.random() * 200) + 2}`;
    await host.run('w4', `ping -n 60 ${marker}`, 1500, 'Test');
    expect(running(marker)).toBe('1');
    host.close('w4');
    await wait(3000);
    expect(running(marker)).toBe('0');
  }, 60_000);
});
