import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NestEvent, TerminalStateInfo } from '@shared/types';

/** Raw output kept per terminal for replay when a panel attaches. */
const BUFFER_CHARS = 200_000;
/** Most output one terminal_run returns to the model (the tail is kept). */
const RESULT_CHARS = 30_000;
const READY_TIMEOUT_MS = 10_000;

/**
 * The shell reports every prompt with this invisible escape sequence (an OSC
 * the terminal ignores), carrying the last exit code and, from PowerShell, the
 * current folder. It is how Nest knows a command finished and the terminal is
 * free again.
 */
const MARKER_RE = /\x1b\]777;nest;(-?\d+)(?:;([^\x07\x1b]*))?\x07/g;
const MARKER_PREFIX = '\x1b]777;nest;';

// Gives the shell a real pseudo-terminal (colours, line editing, full-screen
// programs) without a native module. fd 3 carries "cols rows" lines for resizes.
const PTY_HELPER = `
import os, pty, sys, select, struct, fcntl, termios
cols, rows = int(sys.argv[1]), int(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[3], sys.argv[3:])
def size(c, r):
    try: fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))
    except OSError: pass
size(cols, rows)
watch = [fd, 0, 3]
out = sys.stdout.buffer
while True:
    try: ready, _, _ = select.select(watch, [], [])
    except InterruptedError: continue
    if fd in ready:
        try: data = os.read(fd, 65536)
        except OSError: data = b''
        if not data: break
        out.write(data); out.flush()
    if 0 in ready:
        data = os.read(0, 65536)
        if not data: break
        os.write(fd, data)
    if 3 in ready:
        data = os.read(3, 1024)
        if not data: watch.remove(3)
        for line in data.decode().split('\\n'):
            parts = line.split()
            if len(parts) == 2: size(int(parts[0]), int(parts[1]))
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`;

const BASH_RC = `[ -f ~/.bashrc ] && . ~/.bashrc
__nest_prompt() { local s=$?; printf '\\033]777;nest;%s\\007' "$s"; return $s; }
PROMPT_COMMAND="__nest_prompt\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
`;

const POWERSHELL_INIT =
  'function __nest_p { $c = if ($?) { 0 } else { 1 }; if ($global:LASTEXITCODE) { $c = $global:LASTEXITCODE }; $global:LASTEXITCODE = 0; ' +
  '[Console]::Out.Write("$([char]27)]777;nest;$c;$($PWD.ProviderPath)$([char]7)PS $($PWD.Path)> ") }\n__nest_p\n';

const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b[()][0-9A-Za-z]/g;

/** Terminal output as plain text: escape codes removed, carriage-return overwrites applied. */
export function plainText(raw: string): string {
  return raw
    .replace(ANSI_RE, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const parts = line.split('\r');
      let out = '';
      for (const part of parts) out = part + out.slice(part.length);
      return out.replace(/[^\S\n\t ]|[\x00-\x08\x0b-\x1f\x7f]/g, '').trimEnd();
    })
    .join('\n');
}

let pythonCache: string | null | undefined;
function python(): string | null {
  if (pythonCache !== undefined) return pythonCache;
  pythonCache = null;
  if (process.platform === 'win32') return null;
  for (const cmd of ['python3', 'python']) {
    const res = spawnSync(cmd, ['-c', 'import pty, termios, fcntl'], { timeout: 4000, stdio: 'ignore' });
    if (res.status === 0) return (pythonCache = cmd);
  }
  return null;
}

function bash(): string | null {
  for (const p of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) if (existsSync(p)) return p;
  return null;
}

/** Direct children of a Windows process, except its console host. */
function windowsChildren(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | Where-Object Name -ne 'conhost.exe' | ForEach-Object ProcessId`],
      { windowsHide: true, timeout: 15_000 },
      (err, stdout) => resolve(err ? [] : stdout.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)),
    );
  });
}

/** Kill a Windows process and everything it started. */
function killTree(pid: number): void {
  spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 15_000 });
}

/** How long a pipes-mode Ctrl-C waits for the command to end before restarting the shell. */
const INTERRUPT_GRACE_MS = 1500;

interface Waiter {
  /** The exit code and where the prompt began in the output, or null on timeout or exit. */
  resolve: (res: { code: number; at: number } | null) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  conversationId: string;
  proc: ChildProcess;
  /** true: a real pseudo-terminal; false: plain pipes, so Nest echoes and edits lines itself. */
  pty: boolean;
  shell: string;
  cwd: string;
  /** The folder at the last prompt (PowerShell reports it); a restarted shell starts here. */
  cwdNow: string;
  /** Output since the start, trimmed from the front; `base` is how many characters were dropped. */
  buffer: string;
  base: number;
  /** A possibly split marker held back from the last chunk. */
  carry: string;
  /** Characters of output so far (absolute positions for slicing results). */
  written: number;
  ready: boolean;
  busy: boolean;
  lastExit: number | null;
  action: string | null;
  /** Pipes mode: the line being typed. */
  line: string;
  waiters: Waiter[];
}

/**
 * One shell per conversation, shared by the user and the agent: the user types
 * into it from the terminal panel, the agent runs commands through Nest's
 * terminal tools, and both see everything the other does.
 */
export class TerminalHost {
  private sessions = new Map<string, Session>();
  private rcFile: string | null = null;

  constructor(
    private readonly broadcast: (event: NestEvent) => void,
    /** The conversation's working folder (created if needed). */
    private readonly cwdFor: (conversationId: string) => string,
  ) {}

  state(conversationId: string): TerminalStateInfo | null {
    const s = this.sessions.get(conversationId);
    if (!s) return null;
    return { conversationId, shell: s.shell, cwd: s.cwd, busy: s.busy, action: s.action, lastExit: s.lastExit, pty: s.pty };
  }

  /** The terminal and its recent output, or null when it isn't open. */
  attach(conversationId: string): { state: TerminalStateInfo; buffer: string } | null {
    const s = this.sessions.get(conversationId);
    return s ? { state: this.state(conversationId)!, buffer: s.buffer } : null;
  }

  /** Open the conversation's terminal (or return the open one). */
  open(conversationId: string, cols = 120, rows = 30): { state: TerminalStateInfo; buffer: string } {
    if (!this.sessions.has(conversationId)) this.spawn(conversationId, cols, rows);
    return this.attach(conversationId)!;
  }

  private rc(): string {
    if (!this.rcFile) {
      // A private folder (random name, owner-only) so no one else on the machine can plant or swap the file bash runs.
      const dir = mkdtempSync(path.join(os.tmpdir(), 'nest-terminal-'));
      this.rcFile = path.join(dir, 'bashrc');
      writeFileSync(this.rcFile, BASH_RC, { mode: 0o600, flag: 'wx' });
    }
    return this.rcFile;
  }

  /** `from`: a stuck session being replaced; the new shell starts in its folder and keeps its output. */
  private spawn(conversationId: string, cols: number, rows: number, from?: Session): Session {
    const cwd = from?.cwdNow ?? this.cwdFor(conversationId);
    const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', NEST_TERMINAL: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    const py = python();
    const sh = bash();
    let proc: ChildProcess;
    let pty = false;
    let shell: string;
    if (process.platform === 'win32') {
      shell = 'powershell';
      proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'], { cwd, env, windowsHide: true, stdio: 'pipe' });
    } else if (sh) {
      shell = 'bash';
      const args = [sh, '--rcfile', this.rc(), '-i'];
      if (py) {
        pty = true;
        proc = spawn(py, ['-c', PTY_HELPER, String(cols), String(rows), ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      } else {
        proc = spawn(sh, args.slice(1), { cwd, env, stdio: 'pipe' });
      }
    } else {
      throw new Error('No bash found for the terminal.');
    }
    const s: Session = { conversationId, proc, pty, shell, cwd, cwdNow: cwd, buffer: from?.buffer ?? '', base: from?.base ?? 0, carry: '', written: from?.written ?? 0, ready: false, busy: false, lastExit: null, action: null, line: '', waiters: [] };
    this.sessions.set(conversationId, s);
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (d: string) => this.output(s, d));
    proc.stderr?.on('data', (d: string) => this.output(s, d));
    proc.on('error', (err) => this.output(s, `\r\n[Nest] The terminal could not start: ${err.message}\r\n`));
    proc.on('exit', () => {
      if (this.sessions.get(conversationId) !== s) return;
      this.sessions.delete(conversationId);
      for (const w of s.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve(null);
      }
      this.broadcast({ type: 'terminal-state', state: { conversationId, shell: s.shell, cwd: s.cwd, busy: false, action: null, lastExit: s.lastExit, pty: s.pty, closed: true } });
    });
    if (shell === 'powershell') proc.stdin?.write(POWERSHELL_INIT);
    this.announce(s);
    return s;
  }

  private announce(s: Session): void {
    const state = this.state(s.conversationId);
    if (state) this.broadcast({ type: 'terminal-state', state });
  }

  private output(s: Session, chunk: string): void {
    let text = s.carry + chunk;
    s.carry = '';
    // Hold back a marker split across chunks.
    const tail = text.lastIndexOf('\x1b');
    if (tail >= 0 && !text.includes('\x07', tail)) {
      const rest = text.slice(tail);
      if (MARKER_PREFIX.startsWith(rest) || (rest.startsWith(MARKER_PREFIX) && rest.length < MARKER_PREFIX.length + 4096)) {
        s.carry = rest;
        text = text.slice(0, tail);
      }
    }
    if (!s.pty) text = text.replace(/\r?\n/g, '\r\n');
    let last = 0;
    let prompted = false;
    for (const m of text.matchAll(MARKER_RE)) {
      this.append(s, text.slice(last, m.index));
      last = m.index + m[0].length;
      prompted = true;
      this.prompt(s, Number(m[1]), m[2]);
    }
    this.append(s, text.slice(last));
    if (prompted) this.announce(s);
  }

  private append(s: Session, text: string): void {
    if (!text) return;
    s.buffer += text;
    s.written += text.length;
    if (s.buffer.length > BUFFER_CHARS) {
      const drop = s.buffer.length - BUFFER_CHARS;
      s.buffer = s.buffer.slice(drop);
      s.base += drop;
    }
    this.broadcast({ type: 'terminal-data', conversationId: s.conversationId, data: text });
  }

  private prompt(s: Session, code: number, cwd?: string): void {
    const first = !s.ready;
    if (cwd) s.cwdNow = cwd;
    s.ready = true;
    s.busy = false;
    s.action = null;
    if (!first) s.lastExit = code;
    for (const w of s.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve({ code, at: s.written });
    }
  }

  private waitPrompt(s: Session, ms: number): Promise<{ code: number; at: number } | null> {
    return new Promise((resolve) => {
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => {
          s.waiters = s.waiters.filter((x) => x !== w);
          resolve(null);
        }, ms),
      };
      s.waiters.push(w);
    });
  }

  /** Keystrokes from the user's terminal panel. */
  input(conversationId: string, data: string): void {
    const s = this.sessions.get(conversationId);
    if (!s?.proc.stdin?.writable) return;
    if (s.pty) {
      if (data.includes('\r')) this.markBusy(s, null);
      s.proc.stdin.write(data);
      return;
    }
    // Pipes have no terminal to echo and edit lines, so do it here.
    for (const ch of data.startsWith('\x1b') ? '' : data) {
      if (ch === '\r' || ch === '\n') {
        this.append(s, '\r\n');
        this.submit(s, s.line);
        s.line = '';
      } else if (ch === '\x7f' || ch === '\b') {
        if (s.line) {
          s.line = s.line.slice(0, -1);
          this.append(s, '\b \b');
        }
      } else if (ch === '\x03') {
        s.line = '';
        this.append(s, '^C\r\n');
        this.interrupt(s);
      } else if (ch >= ' ' || ch === '\t') {
        s.line += ch;
        this.append(s, ch);
      }
    }
  }

  private submit(s: Session, line: string): void {
    this.markBusy(s, null);
    s.proc.stdin?.write(s.shell === 'powershell' ? `${line}\n__nest_p\n` : `${line}\n`);
  }

  private markBusy(s: Session, action: string | null): void {
    s.busy = true;
    s.action = action;
    this.announce(s);
  }

  resize(conversationId: string, cols: number, rows: number): void {
    const s = this.sessions.get(conversationId);
    const ctl = s?.pty ? (s.proc.stdio[3] as NodeJS.WritableStream | null) : null;
    if (ctl && cols > 0 && rows > 0) ctl.write(`${Math.round(cols)} ${Math.round(rows)}\n`);
  }

  /**
   * Ctrl-C without a real terminal, where the shell can't be signalled through
   * its pipes: stop what the running command started. On Windows, a PowerShell
   * built-in (Start-Sleep, a loop) runs inside the shell itself, so if the
   * command is still going after a moment the shell is restarted in its folder.
   */
  private interrupt(s: Session): void {
    if (!s.busy || !s.proc.pid) return;
    if (process.platform !== 'win32') {
      execFile('pkill', ['-INT', '-P', String(s.proc.pid)], () => {});
      return;
    }
    const pid = s.proc.pid;
    void windowsChildren(pid).then(async (children) => {
      for (const child of children) killTree(child);
      await new Promise((r) => setTimeout(r, INTERRUPT_GRACE_MS));
      if (this.sessions.get(s.conversationId) === s && s.busy) this.restart(s);
    });
  }

  /** Replace a stuck shell with a fresh one in the same folder, keeping the output so far. */
  private restart(s: Session): void {
    // Out of the map first, so the old shell's exit doesn't report the terminal as closed.
    this.sessions.delete(s.conversationId);
    for (const w of s.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.kill(s);
    const next = this.spawn(s.conversationId, 120, 30, s);
    this.append(next, `[Nest] PowerShell can't interrupt a built-in command without a real console, so the shell was restarted in ${next.cwd}. Variables set before are gone.\r\n`);
  }

  private kill(s: Session): void {
    s.proc.stdin?.end();
    // On Windows, killing powershell.exe alone leaves whatever it started running.
    if (process.platform === 'win32' && s.proc.pid) {
      killTree(s.proc.pid);
      return;
    }
    s.proc.kill();
    setTimeout(() => {
      if (s.proc.exitCode === null && s.proc.signalCode === null) s.proc.kill('SIGKILL');
    }, 2000);
  }

  close(conversationId: string): void {
    const s = this.sessions.get(conversationId);
    if (s) this.kill(s);
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
    if (this.rcFile) {
      rmSync(path.dirname(this.rcFile), { recursive: true, force: true });
      this.rcFile = null;
    }
  }

  /** Recent output as plain text, for the agent. */
  read(conversationId: string, lines = 100): string {
    const s = this.sessions.get(conversationId);
    if (!s) return 'The terminal is not open. Use terminal_run to open it and run a command.';
    const text = plainText(s.buffer).split('\n');
    const shown = text.slice(-Math.max(1, Math.min(lines, 2000))).join('\n');
    const status = s.busy ? 'A command is still running.' : `Idle at the prompt${s.lastExit !== null ? ` (last exit code ${s.lastExit})` : ''}.`;
    return `${status}\nWorking folder at start: ${s.cwd}\n\n${shown}`;
  }

  /**
   * Run a command in the shared terminal, visibly, and wait for it to finish.
   * Refuses while something else (the user, or a previous command) is running.
   */
  async run(conversationId: string, command: string, timeoutMs: number, who: string): Promise<{ text: string; ok: boolean }> {
    let s = this.sessions.get(conversationId) ?? this.spawn(conversationId, 120, 30);
    if (!s.ready) {
      await this.waitPrompt(s, READY_TIMEOUT_MS);
      s = this.sessions.get(conversationId) ?? s;
      if (!s.ready) return { ok: false, text: 'The terminal did not start in time. Try again, or read it with terminal_read.' };
    }
    if (s.busy) return { ok: false, text: `The terminal is busy (a command is running). Use terminal_read to see it, or terminal_send_keys with "\\u0003" to interrupt it.\n\n${this.read(conversationId, 20)}` };
    const oneLine = command.replace(/\r\n/g, '\n').trim();
    if (!oneLine) return { ok: false, text: 'command is required.' };
    // A multi-line script runs as one group, so the shell prompts (and reports) once.
    const multi = oneLine.includes('\n');
    const sent = s.shell === 'bash' && multi ? `{\n${oneLine}\n}` : oneLine;
    const start = s.written;
    this.markBusy(s, `${who}: ${oneLine.split('\n')[0].slice(0, 120)}`);
    const done = this.waitPrompt(s, timeoutMs);
    if (s.pty) s.proc.stdin?.write(`\x15${sent}\r`);
    else {
      this.append(s, `${sent.replace(/\n/g, '\r\n')}\r\n`);
      s.proc.stdin?.write(s.shell === 'powershell' ? `${sent}\n__nest_p\n` : `${sent}\n`);
    }
    const res = await done;
    const raw = s.buffer.slice(Math.max(0, start - s.base), res ? res.at - s.base : undefined);
    let lines = plainText(raw).split('\n');
    // The pty echoes what was typed; drop it (it is the command itself).
    if (s.pty) {
      let from = 0;
      for (const typed of sent.split('\n')) {
        const want = typed.trim();
        const at = lines.findIndex((l, j) => j >= from && j < from + 3 && l.trimEnd().endsWith(want));
        if (at < 0) break;
        from = at + 1;
      }
      lines = lines.slice(from);
    }
    let out = lines.join('\n').replace(/\n+$/, '');
    if (out.length > RESULT_CHARS) out = `…(${out.length - RESULT_CHARS} earlier characters cut)\n${out.slice(-RESULT_CHARS)}`;
    if (!res) {
      if (!this.sessions.has(conversationId)) return { ok: false, text: `The terminal closed.\n\n${out}` };
      if (this.sessions.get(conversationId) !== s) return { ok: false, text: `The command was stopped and the terminal restarted.\n\n${out}` };
      return { ok: true, text: `Still running after ${Math.round(timeoutMs / 1000)}s (it keeps running in the terminal; the user can see it). Use terminal_read to check on it, or terminal_send_keys with "\\u0003" to stop it.\n\n${out}` };
    }
    return { ok: true, text: `Exit code ${res.code}\n\n${out || '(no output)'}` };
  }

  /** Raw keys for interactive programs (answers to prompts, Ctrl-C as \u0003, arrows as escape codes). */
  sendKeys(conversationId: string, keys: string): string {
    const s = this.sessions.get(conversationId);
    if (!s) return 'The terminal is not open. Use terminal_run first.';
    if (s.pty) {
      if (keys.includes('\r') || keys.includes('\n')) this.markBusy(s, null);
      s.proc.stdin?.write(keys.replace(/\n/g, '\r'));
    } else {
      this.input(conversationId, keys);
      if (keys.includes('\u0003') && process.platform === 'win32')
        return 'Sent Ctrl-C. Nest stops what the command started; if it was a PowerShell built-in, the shell restarts in the same folder (variables are lost). Use terminal_read to see the result.';
    }
    return 'Sent. Use terminal_read to see the result.';
  }
}
