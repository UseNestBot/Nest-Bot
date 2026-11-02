import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildChildEnv, killTree, resolveExecutable, resolveNpmShim, runCapture } from '../src/main/providers/process';

const isWindows = process.platform === 'win32';

describe('child environment', () => {
  it('removes API-billing variables and host session variables, keeps the rest', () => {
    const base = {
      PATH: 'p',
      ANTHROPIC_API_KEY: 'sk-secret',
      ANTHROPIC_BASE_URL: 'http://proxy',
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'x',
      CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
      OPENAI_API_KEY: 'sk-openai',
      HOME: 'h',
    };
    const claude = buildChildEnv('claude', base);
    expect(claude.env).toEqual({ PATH: 'p', CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token', OPENAI_API_KEY: 'sk-openai', HOME: 'h' });
    expect(claude.removedBillingVars.sort()).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
    const codex = buildChildEnv('codex', base);
    expect(codex.env.OPENAI_API_KEY).toBeUndefined();
    expect(codex.removedBillingVars).toEqual(['OPENAI_API_KEY']);
  });
});

describe('executable resolution', () => {
  it('maps an npm .cmd shim to the real binary so no shell is needed', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nest shim '));
    const bin = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'claude.exe'), '');
    writeFileSync(path.join(dir, 'claude.cmd'), '@echo off');
    const resolved = resolveNpmShim(path.join(dir, 'claude.cmd'), '@anthropic-ai/claude-code', ['bin/claude.exe', 'cli.js']);
    expect(resolved?.command).toBe(path.join(bin, 'claude.exe'));
    expect(resolved?.prefixArgs).toEqual([]);
  });

  it('runs a configured JavaScript entry point under node, and rejects missing paths', () => {
    const script = path.resolve('tests/fixtures/fake-claude.mjs');
    const r = resolveExecutable({ name: 'claude', configuredPath: script, knownLocations: [], npmPackage: 'x', npmCandidates: [] });
    expect(r?.prefixArgs).toEqual([script]);
    expect(resolveExecutable({ name: 'claude', configuredPath: 'C:\\nope\\claude.exe', knownLocations: [], npmPackage: 'x', npmCandidates: [] })).toBeNull();
  });

  it('passes arguments containing spaces, quotes and shell metacharacters through verbatim', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nest args '));
    const script = path.join(dir, 'echo args.mjs');
    writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const exe = resolveExecutable({ name: 'x', configuredPath: script, knownLocations: [], npmPackage: 'x', npmCandidates: [] })!;
    const tricky = ['a b', '"quoted"', 'x & del *', '%PATH%', '$(whoami)', 'line1\nline2'];
    const res = await runCapture(exe, tricky, process.env);
    expect(JSON.parse(res.stdout)).toEqual(tricky);
  });
});

describe('killTree', () => {
  it('terminates a process together with its children', async () => {
    // Parent spawns a long-lived grandchild and prints its pid.
    const parent = spawn(process.execPath, ['-e', `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: !isWindows,
    });
    const childPid = await new Promise<number>((resolve) => parent.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(childPid)).toBe(true);
    await killTree(parent);
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(childPid)).toBe(false);
    await killTree(parent); // idempotent
  });
});
