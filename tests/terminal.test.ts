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
