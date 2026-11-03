import { describeCadence, sanitizeCadence } from '@shared/schedule';
import { AVATAR_PALETTE } from '@shared/templates';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, FORGE_LABEL, PROVIDER_LABEL, PROVIDERS, isProviderId, type ForgeIssue, type ForgeIssueDetail, type ForgeLookup, type ForgeMergeMethod, type ForgePull, type ForgePullDetail, type ForgePullDraft, type GitDraft, type Project, type ProviderId } from '@shared/types';
import type { NestDb } from '../db';
import type { RunManager } from '../runs';
import type { Scheduler } from '../scheduler';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  text: string;
  /** Optional image (e.g. a browser screenshot), returned to the model as MCP image content. */
  image?: { data: string; mimeType: string };
}

/** The agent's built-in browser, as the tools see it (implemented by AgentBrowserHost). */
export interface BrowserTools {
  open(agentId: string, url: string): Promise<string>;
  snapshot(agentId: string): Promise<string>;
  click(agentId: string, ref: number): Promise<string>;
  type(agentId: string, ref: number, text: string, submit: boolean, clear: boolean): Promise<string>;
  scroll(agentId: string, direction: 'up' | 'down'): Promise<string>;
  history(agentId: string, dir: 'back' | 'forward' | 'reload'): Promise<string>;
  screenshot(agentId: string): Promise<{ data: string; mimeType: string } | null>;
}

/** The conversation's shared terminal, as the tools see it (implemented by TerminalHost). */
export interface TerminalTools {
  run(conversationId: string, command: string, timeoutMs: number, who: string): Promise<{ text: string; ok: boolean }>;
  read(conversationId: string, lines: number): string;
  sendKeys(conversationId: string, keys: string): string;
}

/** Forges for a chat's working folder, as the tools see them (implemented by ForgeService). */
export interface ForgeTools {
  lookup(folder: string): Promise<ForgeLookup>;
  listPulls(folder: string, state: 'open' | 'closed' | 'all'): Promise<ForgePull[]>;
  getPull(folder: string, number: number): Promise<ForgePullDetail>;
  checkLog(folder: string, checkId: string): Promise<string>;
  createPull(folder: string, draft: ForgePullDraft): Promise<ForgePull>;
  comment(folder: string, number: number, body: string): Promise<void>;
  merge(folder: string, number: number, method: ForgeMergeMethod, deleteBranch: boolean): Promise<void>;
  listIssues(folder: string, state: 'open' | 'closed'): Promise<ForgeIssue[]>;
  getIssue(folder: string, number: number): Promise<ForgeIssueDetail>;
  createIssue(folder: string, title: string, body: string): Promise<ForgeIssue>;
  commentIssue(folder: string, number: number, body: string): Promise<void>;
}

const MAX_DELEGATION_DEPTH = 3;
const DELEGATE_WAIT_MS = 25 * 60_000;
/** Tools that change agents or schedules ask the user even when permissions are skipped: skipping must not spread to other agents. */
const ADMIN_ALWAYS_ASKS = true;
const AVATAR_SHAPES = ['blob', 'square', 'diamond', 'leaf', 'pill', 'hex', 'triangle'] as const;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_my_profile',
    description: 'Your Nest agent profile: name, instructions (system prompt), provider and model, working folder, project, and the memory notes you receive.',
    inputSchema: obj({}),
  },
  {
    name: 'remember',
    description: 'Save a short memory note that Nest will give you in future conversations. Use for durable facts and preferences, not transient details. Shared and project notes ask the user first.',
    inputSchema: obj(
      {
        note: { type: 'string', description: 'The fact to remember, in one or two sentences.' },
        project: { type: 'boolean', description: 'true to share with every member of your project.' },
        shared: { type: 'boolean', description: 'true to share with every agent in Nest; default only you.' },
      },
      ['note'],
    ),
  },
  {
    name: 'list_agents',
    description: 'List the other agents in Nest with their roles and projects, teammates first, so you can delegate work.',
    inputSchema: obj({}),
  },
  {
    name: 'get_project',
    description: 'This chat’s project (or another project by name): its brief, shared folder, members, project memory notes, and its recent chats with their last message.',
    inputSchema: obj({ project: { type: 'string', description: 'Project name; default this chat’s project.' } }),
  },
  {
    name: 'delegate',
    description: 'Hand a task to another Nest agent. By default waits for its result (up to 25 minutes) and returns it; the exchange also appears in the user’s conversation. Asks the user first unless permissions are skipped.',
    inputSchema: obj(
      {
        agent: { type: 'string', description: 'Name of the agent to delegate to.' },
        task: { type: 'string', description: 'What the agent should do, self-contained.' },
        context: { type: 'string', description: 'Any context the agent needs (it cannot see this conversation).' },
        wait: { type: 'boolean', description: 'Wait for the result (default true).' },
      },
      ['agent', 'task'],
    ),
  },
  {
    name: 'list_schedules',
    description: 'List recurring schedules (routines) and when they next run.',
    inputSchema: obj({}),
  },
  {
    name: 'create_schedule',
    description: 'Propose a recurring task for an agent (e.g. a morning brief). The user approves it in Nest.',
    inputSchema: obj(
      {
        title: { type: 'string' },
        prompt: { type: 'string', description: 'What the agent should do each time.' },
        agent: { type: 'string', description: 'Agent name; defaults to you.' },
        project: { type: 'string', description: 'Project each run works in: its chats appear there and use the project’s shared folder. Defaults to the agent’s project; "none" for no project.' },
        cadence: {
          type: 'string',
          enum: ['daily', 'weekdays', 'weekly', 'interval'],
        },
        time: { type: 'string', description: 'HH:MM, 24-hour local time (daily, weekdays, weekly).' },
        weekday: { type: 'integer', description: '0 = Sunday … 6 = Saturday (weekly).' },
        every_minutes: { type: 'integer', description: 'Minutes between runs (interval, minimum 15).' },
      },
      ['title', 'prompt', 'cadence'],
    ),
  },
  {
    name: 'update_schedule',
    description:
      'Change an existing schedule (routine): the project its runs work in (their chats appear there and use the project’s shared folder), what it does, when it runs, or pause and resume it. The user approves it in Nest.',
    inputSchema: obj(
      {
        schedule: { type: 'string', description: 'The schedule’s name, as list_schedules shows it.' },
        project: { type: 'string', description: 'Project name, or "none".' },
        prompt: { type: 'string', description: 'Replacement instructions for each run (omit to keep).' },
        cadence: {
          type: 'string',
          enum: ['daily', 'weekdays', 'weekly', 'interval'],
          description: 'New timing (omit to keep the current one).',
        },
        time: { type: 'string', description: 'HH:MM, 24-hour local time (daily, weekdays, weekly).' },
        weekday: { type: 'integer', description: '0 = Sunday … 6 = Saturday (weekly).' },
        every_minutes: { type: 'integer', description: 'Minutes between runs (interval, minimum 15).' },
        enabled: { type: 'boolean', description: 'false pauses it, true resumes it.' },
      },
      ['schedule'],
    ),
  },
  {
    name: 'update_project',
    description:
      'Set a project’s shared folder. Members without a folder of their own, and scheduled runs in the project, work there. The user approves it in Nest.',
    inputSchema: obj(
      {
        project: { type: 'string', description: 'Project name; default this chat’s project.' },
        folder: { type: 'string', description: 'Full path of the folder (created when first used), or "default" for Nest’s default working folder.' },
      },
      ['folder'],
    ),
  },
  {
    name: 'create_agent',
    description: 'Propose a new specialised agent. The user approves it in Nest.',
    inputSchema: obj(
      {
        name: { type: 'string' },
        instructions: { type: 'string', description: 'The new agent’s role and how it should work.' },
        provider: { type: 'string', enum: PROVIDERS },
        model: { type: 'string' },
        project: { type: 'string', description: 'Project name to put it in; defaults to this chat’s project. "none" for no project.' },
      },
      ['name', 'instructions'],
    ),
  },
  {
    name: 'update_my_instructions',
    description: 'Propose replacing your own instructions (system prompt). The user approves it in Nest.',
    inputSchema: obj({ instructions: { type: 'string' }, reason: { type: 'string' } }, ['instructions', 'reason']),
  },
  {
    name: 'update_agent',
    description:
      'Change another agent’s settings: its instructions, whether it skips permissions (true = acts without approval prompts, false = always asks, "default" = follow the Nest default), its provider or model. The user approves it in Nest.',
    inputSchema: obj(
      {
        agent: { type: 'string', description: 'Agent name.' },
        skip_permissions: { type: ['boolean', 'string'], description: 'true, false, or "default".' },
        instructions: { type: 'string', description: 'Replacement instructions (omit to keep).' },
        provider: { type: 'string', enum: PROVIDERS },
        model: { type: 'string', description: 'Model id, or "default".' },
        reason: { type: 'string' },
      },
      ['agent'],
    ),
  },
  {
    name: 'ask_permission',
    description:
      'Ask the user to approve one specific, seriously consequential action before you do it (sending messages or email to real people, deleting or overwriting data, spending money, publishing). Shows an approval card even when your permissions are skipped. Returns whether the user approved.',
    inputSchema: obj(
      {
        action: { type: 'string', description: 'Exactly what you will do, e.g. "Send the 12 drafted emails in outbound.csv".' },
        reason: { type: 'string', description: 'Why it needs doing now.' },
        details: { type: 'string', description: 'Optional details the user should review (recipients, rows, amounts).' },
      },
      ['action'],
    ),
  },
];

export const BROWSER_TOOL_DEFS: ToolDef[] = [
  {
    name: 'browser_open',
    description:
      'Open a web page in your own browser (a separate computer the user watches live in Nest; its logins are yours, not the user’s). Returns the page text and numbered interactive elements.',
    inputSchema: obj({ url: { type: 'string' } }, ['url']),
  },
  {
    name: 'browser_snapshot',
    description: 'Read the current page again: URL, title, visible text and numbered interactive elements (refs change when the page changes).',
    inputSchema: obj({}),
  },
  {
    name: 'browser_click',
    description: 'Click an element by its ref number from the latest snapshot. Returns the page afterwards.',
    inputSchema: obj({ ref: { type: 'integer' } }, ['ref']),
  },
  {
    name: 'browser_type',
    description: 'Type text into an input by ref. Set submit to press Enter afterwards, clear to replace existing text.',
    inputSchema: obj({ ref: { type: 'integer' }, text: { type: 'string' }, submit: { type: 'boolean' }, clear: { type: 'boolean' } }, ['ref', 'text']),
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page up or down by most of a screen.',
    inputSchema: obj({ direction: { type: 'string', enum: ['up', 'down'] } }, ['direction']),
  },
  {
    name: 'browser_navigate',
    description: 'Go back, forward, or reload.',
    inputSchema: obj({ action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, ['action']),
  },
  {
    name: 'browser_screenshot',
    description: 'See the page as an image, for layouts, charts or anything the text snapshot misses.',
    inputSchema: obj({}),
  },
];

/** Names agents use for special keys in terminal_send_keys (see TERMINAL_KEYS). */
const TERMINAL_KEY_NAMES = ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+l', 'enter', 'tab', 'escape', 'backspace', 'up', 'down', 'right', 'left'];

export const TERMINAL_TOOL_DEFS: ToolDef[] = [
  {
    name: 'terminal_run',
    description:
      'Run a shell command in the terminal you share with the user (shown live in Nest; the user can type into it too). It starts in this chat’s working folder and keeps its state (cd, env vars, running servers) between calls. Waits for the command to finish and returns its output and exit code. Use it when the user should see the work, or for long-running processes they may want to watch or take over.',
    inputSchema: obj(
      {
        command: { type: 'string', description: 'The command (bash on macOS/Linux, PowerShell on Windows). Several lines run as one script.' },
        timeout_seconds: { type: 'integer', description: 'How long to wait before returning (default 60, max 600). The command keeps running in the terminal after a timeout.' },
      },
      ['command'],
    ),
  },
  {
    name: 'terminal_read',
    description: 'Read the shared terminal’s recent output (including anything the user typed or ran) and whether a command is still running.',
    inputSchema: obj({ lines: { type: 'integer', description: 'How many recent lines (default 100).' } }),
  },
  {
    name: 'terminal_send_keys',
    description:
      'Type into the shared terminal, for interactive programs and to stop commands. Send text in "keys" and/or a special key in "key" (pressed after the text). To stop a running command use key "ctrl+c"; to answer a prompt send keys "y" with key "enter".',
    inputSchema: obj({
      keys: { type: 'string', description: 'Text to type, exactly as written (backslashes stay literal). Nothing is submitted until key "enter".' },
      key: { type: 'string', enum: TERMINAL_KEY_NAMES, description: 'A special key to press after the text.' },
    }),
  },
];

/** Git and forge tools: drafts go to the user's source control panel; opening and commenting ask first. */
export const GIT_TOOL_DEFS: ToolDef[] = [
  {
    name: 'draft_commit_message',
    description:
      'Put a commit message in the commit box of this chat’s source control panel for the user to review and commit. Use it when the user asks you to write a commit message. It doesn’t commit anything.',
    inputSchema: obj({ message: { type: 'string', description: 'Subject line (under about 72 characters), then a blank line and an optional body.' } }, ['message']),
  },
  {
    name: 'draft_pull_request',
    description:
      'Open the “Create pull request” form in this chat’s source control panel, filled in with your title and description, for the user to review and submit. Use it when the user asks you to write a pull request. It doesn’t push or open anything.',
    inputSchema: obj(
      {
        title: { type: 'string' },
        body: { type: 'string', description: 'The description, in Markdown.' },
        base: { type: 'string', description: 'Branch to merge into; default the repository’s default branch.' },
      },
      ['title', 'body'],
    ),
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests (merge requests on GitLab) for the repository in your working folder, on GitHub, GitLab or Forgejo, with their checks and review state.',
    inputSchema: obj({ state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Default open.' } }),
  },
  {
    name: 'get_pull_request',
    description: 'Read a pull request: its description, each check (with ids for get_check_log), reviews and comments, including comments on lines of the diff. Without a number, the current branch’s open pull request.',
    inputSchema: obj({ number: { type: 'integer' } }),
  },
  {
    name: 'get_check_log',
    description: 'Read the end of a check’s log (GitHub Actions or GitLab CI), to see why it failed. Get check ids from get_pull_request.',
    inputSchema: obj({ check_id: { type: 'string' } }, ['check_id']),
  },
  {
    name: 'create_pull_request',
    description:
      'Open a pull request for the current branch, pushing it first if the forge doesn’t have all of it. The user approves it first. Prefer draft_pull_request when the user may want to edit it.',
    inputSchema: obj(
      {
        title: { type: 'string' },
        body: { type: 'string', description: 'The description, in Markdown.' },
        base: { type: 'string', description: 'Branch to merge into; default the repository’s default branch.' },
        draft: { type: 'boolean', description: 'Open it as a draft.' },
      },
      ['title', 'body'],
    ),
  },
  {
    name: 'comment_on_pull_request',
    description: 'Post a comment on a pull request, as the user. The user approves it first.',
    inputSchema: obj({ number: { type: 'integer' }, body: { type: 'string', description: 'Markdown.' } }, ['number', 'body']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request on the forge. The user approves it first. Check get_pull_request first: it says whether it can be merged and which ways the forge allows.',
    inputSchema: obj(
      {
        number: { type: 'integer' },
        method: { type: 'string', enum: ['merge', 'squash', 'rebase'], description: 'Default merge. GitLab offers merge and squash.' },
        delete_branch: { type: 'boolean', description: 'Also delete the head branch (same repository only).' },
      },
      ['number'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List issues for the repository in your working folder, newest activity first.',
    inputSchema: obj({ state: { type: 'string', enum: ['open', 'closed'], description: 'Default open.' } }),
  },
  {
    name: 'get_issue',
    description: 'Read an issue: its description, labels, assignees and comments.',
    inputSchema: obj({ number: { type: 'integer' } }, ['number']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue, as the user. The user approves it first.',
    inputSchema: obj({ title: { type: 'string' }, body: { type: 'string', description: 'Markdown.' } }, ['title']),
  },
  {
    name: 'comment_on_issue',
    description: 'Post a comment on an issue, as the user. The user approves it first.',
    inputSchema: obj({ number: { type: 'integer' }, body: { type: 'string', description: 'Markdown.' } }, ['number', 'body']),
  },
];

const GIT_TOOL_NAMES = new Set(GIT_TOOL_DEFS.map((t) => t.name));
/** Most of a pull request's text handed to an agent at once. */
const MAX_PULL_TEXT = 40_000;

/** A pull request as text for an agent. */
export function describePull(pr: ForgePullDetail): string {
  const lines = [
    `#${pr.number} ${pr.title} (${pr.state}${pr.draft ? ', draft' : ''}) by ${pr.author}: ${pr.head} → ${pr.base}`,
    pr.url,
    `Checks: ${pr.checks ?? 'none'}${pr.review ? ` · Review: ${pr.review}` : ''}`,
  ];
  for (const c of pr.checkList) lines.push(`- [${c.state}] ${c.name} (id: ${c.id}${c.hasLog ? ', log available' : ''})${c.url ? ` ${c.url}` : ''}`);
  lines.push('', 'Description:', pr.body.trim() || '(none)');
  if (pr.state === 'open') lines.push(pr.mergeBlocker ? `Can’t merge yet: ${pr.mergeBlocker}` : `${pr.mergeable === null ? 'Mergeable: not known yet' : 'Can merge'} (${pr.mergeMethods.join(', ')})`);
  if (pr.comments.length) {
    lines.push('', 'Reviews and comments, oldest first:');
    for (const c of pr.comments) {
      const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : '';
      const verdict = c.review === 'approved' ? ' (approved)' : c.review === 'changes-requested' ? ' (requested changes)' : '';
      lines.push(`- ${c.author}${verdict}${where}: ${c.body.trim() || '(no text)'}`);
    }
  }
  const text = lines.join('\n');
  return text.length > MAX_PULL_TEXT ? `${text.slice(0, MAX_PULL_TEXT)}\n…(cut; open the pull request for the rest)` : text;
}

/** An issue as text for an agent. */
export function describeIssue(i: ForgeIssueDetail): string {
  const lines = [`#${i.number} ${i.title} (${i.state}) by ${i.author}`, i.url];
  if (i.labels.length) lines.push(`Labels: ${i.labels.join(', ')}`);
  if (i.assignees.length) lines.push(`Assigned to: ${i.assignees.join(', ')}`);
  lines.push('', i.body.trim() || '(no description)');
  if (i.comments.length) {
    lines.push('', 'Comments, oldest first:');
    for (const c of i.comments) lines.push(`- ${c.author}: ${c.body.trim() || '(no text)'}`);
  }
  const text = lines.join('\n');
  return text.length > MAX_PULL_TEXT ? `${text.slice(0, MAX_PULL_TEXT)}\n…(cut; open the issue for the rest)` : text;
}

function describePullLine(p: ForgePull): string {
  const extra = [p.draft && 'draft', p.checks && `checks ${p.checks}`, p.review].filter(Boolean).join(', ');
  return `#${p.number} ${p.title} [${p.state}${extra ? `; ${extra}` : ''}] ${p.head} → ${p.base} by ${p.author} ${p.url}`;
}

/**
 * Special keys by name. Agents can't reliably send control characters through
 * a tool call (they arrive empty), so Ctrl-C and friends are named instead.
 */
export const TERMINAL_KEYS: Record<string, string> = {
  'ctrl+c': '\u0003',
  'ctrl+d': '\u0004',
  'ctrl+z': '\u001a',
  'ctrl+l': '\u000c',
  enter: '\r',
  tab: '\t',
  escape: '\u001b',
  backspace: '\u007f',
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
};

/** Where a schedule's runs work, for approval cards and replies. */
function worksIn(project: Project | null | undefined): string {
  return project ? `in ${project.name} (${project.workspace ?? 'Nest’s default working folder'})` : 'outside any project';
}

/** Implements the Nest tools for one calling conversation. */
export class NestTools {
  constructor(
    private readonly db: NestDb,
    private readonly runs: RunManager,
    private readonly scheduler: Scheduler,
    /** Something an agent tool changed: agents (default) or projects. */
    private readonly onAgentsChanged: (what?: 'agents' | 'projects') => void,
    /** The built-in browser and who may use it; absent in tests and when unavailable. */
    private readonly browser?: { host: BrowserTools; enabledFor: (agentId: string) => boolean },
    /** The shared terminal and which agents may use it (opt-in per agent); absent in tests. */
    private readonly terminal?: { host: TerminalTools; enabledFor: (agentId: string) => boolean },
    /** Forges, and where drafts for the source control panel go; absent in tests. */
    private readonly git?: { forge: ForgeTools; onDraft: (conversationId: string, draft: GitDraft) => void },
  ) {}

  /** Tools this conversation's agent may see: browser tools only when its Browser is set to the Nest browser. */
  listFor(conversationId: string): ToolDef[] {
    const agentId = this.db.getConversation(conversationId)?.agentId;
    const browser = Boolean(agentId && this.browser?.enabledFor(agentId));
    const terminal = Boolean(agentId && this.terminal?.enabledFor(agentId));
    return [...TOOL_DEFS, ...(this.git ? GIT_TOOL_DEFS : []), ...(browser ? BROWSER_TOOL_DEFS : []), ...(terminal ? TERMINAL_TOOL_DEFS : [])];
  }

  private async terminalCall(conversationId: string, agentId: string, agentName: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const term = this.terminal?.host;
    if (!term || !this.terminal?.enabledFor(agentId))
      return { ok: false, text: `The terminal is turned off for this agent. The user can turn it on in Nest → Settings → ${'Connectors & tools'}, or from the chat's terminal panel.` };
    // The terminal runs outside the provider's own sandbox, so commands and keystrokes ask first: always, unless the
    // user turned off Settings → Permissions → "Always ask before terminal commands" and this agent skips permissions.
    const force = this.db.getSettings().terminalAlwaysAsk;
    const confirm = async (title: string, action: string) =>
      (await this.runs.requestLocalApproval(conversationId, { title, action, target: null, reason: null, detail: null, approveLabel: 'Run' }, force)) === 'allow';
    try {
      switch (name) {
        case 'terminal_run': {
          const command = typeof args.command === 'string' ? args.command.slice(0, 20000) : '';
          if (!command.trim()) return { ok: false, text: 'command is required.' };
          const secs = Number.isFinite(Number(args.timeout_seconds)) ? Math.min(Math.max(Number(args.timeout_seconds), 1), 600) : 60;
          if (!(await confirm(`${agentName} wants to run a command in the terminal`, command))) return { ok: false, text: 'The user declined this command.' };
          return await term.run(conversationId, command, secs * 1000, agentName);
        }
        case 'terminal_read': {
          const lines = Number.isFinite(Number(args.lines)) ? Math.round(Number(args.lines)) : 100;
          return { ok: true, text: term.read(conversationId, lines) };
        }
        case 'terminal_send_keys': {
          const text = typeof args.keys === 'string' ? args.keys.slice(0, 5000) : '';
          const keyName = typeof args.key === 'string' ? args.key.trim().toLowerCase() : '';
          if (keyName && !(keyName in TERMINAL_KEYS)) return { ok: false, text: `Unknown key "${args.key}". Use one of: ${TERMINAL_KEY_NAMES.join(', ')}.` };
          const keys = text + (keyName ? TERMINAL_KEYS[keyName] : '');
          if (!keys) return { ok: false, text: 'Send text in "keys", a special key in "key" (for example "ctrl+c" to stop a command), or both.' };
          // Ctrl-C alone only stops things, so it never needs asking.
          const shown = [text && JSON.stringify(text), keyName && `[${keyName}]`].filter(Boolean).join(' ');
          if (keys !== '\u0003' && !(await confirm(`${agentName} wants to type into the terminal`, shown))) return { ok: false, text: 'The user declined these keystrokes.' };
          return { ok: true, text: term.sendKeys(conversationId, keys) };
        }
        default:
          return { ok: false, text: `Unknown terminal tool: ${name}` };
      }
    } catch (err) {
      return { ok: false, text: `Terminal error: ${(err as Error).message}` };
    }
  }

  private async gitCall(conversationId: string, agentName: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const git = this.git;
    if (!git) return { ok: false, text: 'Git tools aren’t available in this Nest.' };
    const conversation = this.db.getConversation(conversationId)!;
    const folder = this.runs.workspaceFor(conversation);
    const str = (k: string, max: number) => (typeof args[k] === 'string' ? (args[k] as string).slice(0, max) : '');
    const num = Number(args.number);
    try {
      switch (name) {
        case 'draft_commit_message': {
          const message = str('message', 20_000).trim();
          if (!message) return { ok: false, text: 'message is required.' };
          git.onDraft(conversationId, { kind: 'commit', message });
          return { ok: true, text: 'The message is in the commit box of the source control panel. The user reviews it and commits.' };
        }
        case 'draft_pull_request': {
          const title = str('title', 256).trim();
          if (!title) return { ok: false, text: 'title is required.' };
          git.onDraft(conversationId, { kind: 'pull-request', title, body: str('body', 65_000), base: str('base', 250).trim() || null });
          return { ok: true, text: 'The pull request form is open in the source control panel with your title and description. The user reviews it and opens it.' };
        }
        case 'list_pull_requests': {
          const state = args.state === 'closed' || args.state === 'all' ? args.state : 'open';
          const pulls = await git.forge.listPulls(folder, state);
          return { ok: true, text: pulls.length ? pulls.map(describePullLine).join('\n') : `No ${state === 'all' ? '' : `${state} `}pull requests.` };
        }
        case 'get_pull_request': {
          let n = Number.isInteger(num) && num > 0 ? num : null;
          if (n === null) {
            const found = await git.forge.lookup(folder);
            if (found.error) return { ok: false, text: found.error };
            n = found.repo?.current?.number ?? null;
            if (n === null) return { ok: false, text: found.repo ? 'The current branch has no open pull request. Pass number to read another.' : 'This folder’s repository has no remote on a forge Nest knows.' };
          }
          return { ok: true, text: describePull(await git.forge.getPull(folder, n)) };
        }
        case 'get_check_log': {
          const id = str('check_id', 200).trim();
          if (!id) return { ok: false, text: 'check_id is required (from get_pull_request).' };
          return { ok: true, text: (await git.forge.checkLog(folder, id)) || '(The log is empty.)' };
        }
        case 'create_pull_request': {
          const title = str('title', 256).trim();
          if (!title) return { ok: false, text: 'title is required.' };
          const body = str('body', 65_000);
          const base = str('base', 250).trim();
          const found = await git.forge.lookup(folder);
          const where = found.repo ? `${FORGE_LABEL[found.repo.kind]} · ${found.repo.path}` : null;
          const choice = await this.runs.requestLocalApproval(
            conversationId,
            {
              title: `${agentName} wants to open a pull request`,
              action: title,
              target: where ? `${where}${base || found.repo?.defaultBranch ? ` → ${base || found.repo?.defaultBranch}` : ''}` : null,
              reason: null,
              detail: body.trim() ? body.slice(0, 4000) : null,
              approveLabel: args.draft === true ? 'Open draft' : 'Open pull request',
            },
            true,
          );
          if (choice !== 'allow') return { ok: false, text: 'The user declined opening this pull request.' };
          const pull = await git.forge.createPull(folder, { title, body, base, draft: args.draft === true });
          return { ok: true, text: `Opened #${pull.number}: ${pull.url}` };
        }
        case 'comment_on_pull_request': {
          if (!Number.isInteger(num) || num < 1) return { ok: false, text: 'number is required.' };
          const body = str('body', 65_000);
          if (!body.trim()) return { ok: false, text: 'body is required.' };
          const choice = await this.runs.requestLocalApproval(
            conversationId,
            { title: `${agentName} wants to comment on pull request #${num}`, action: body.slice(0, 4000), target: null, reason: null, detail: null, approveLabel: 'Post comment' },
            true,
          );
          if (choice !== 'allow') return { ok: false, text: 'The user declined posting this comment.' };
          await git.forge.comment(folder, num, body);
          return { ok: true, text: `Commented on #${num}.` };
        }
        case 'merge_pull_request': {
          if (!Number.isInteger(num) || num < 1) return { ok: false, text: 'number is required.' };
          const method: ForgeMergeMethod = args.method === 'squash' || args.method === 'rebase' ? args.method : 'merge';
          const pr = await git.forge.getPull(folder, num);
          if (!pr.mergeMethods.includes(method)) return { ok: false, text: `This forge can’t ${method} here. Use one of: ${pr.mergeMethods.join(', ')}.` };
          const remove = args.delete_branch === true && pr.sameRepo;
          const choice = await this.runs.requestLocalApproval(
            conversationId,
            {
              title: `${agentName} wants to merge pull request #${num}`,
              action: pr.title,
              target: `${pr.head} → ${pr.base} (${method}${remove ? ', then delete the branch' : ''})`,
              reason: pr.mergeBlocker,
              detail: null,
              approveLabel: method === 'squash' ? 'Squash and merge' : method === 'rebase' ? 'Rebase and merge' : 'Merge',
            },
            true,
          );
          if (choice !== 'allow') return { ok: false, text: 'The user declined merging this pull request.' };
          await git.forge.merge(folder, num, method, remove);
          return { ok: true, text: `Merged #${num} into ${pr.base}.` };
        }
        case 'list_issues': {
          const state = args.state === 'closed' ? 'closed' : 'open';
          const issues = await git.forge.listIssues(folder, state);
          return {
            ok: true,
            text: issues.length ? issues.map((i) => `#${i.number} ${i.title} [${i.state}${i.labels.length ? `; ${i.labels.join(', ')}` : ''}] by ${i.author}, ${i.commentCount} comment${i.commentCount === 1 ? '' : 's'} ${i.url}`).join('\n') : `No ${state} issues.`,
          };
        }
        case 'get_issue': {
          if (!Number.isInteger(num) || num < 1) return { ok: false, text: 'number is required.' };
          return { ok: true, text: describeIssue(await git.forge.getIssue(folder, num)) };
        }
        case 'create_issue': {
          const title = str('title', 256).trim();
          if (!title) return { ok: false, text: 'title is required.' };
          const body = str('body', 65_000);
          const choice = await this.runs.requestLocalApproval(
            conversationId,
            { title: `${agentName} wants to open an issue`, action: title, target: null, reason: null, detail: body.trim() ? body.slice(0, 4000) : null, approveLabel: 'Open issue' },
            true,
          );
          if (choice !== 'allow') return { ok: false, text: 'The user declined opening this issue.' };
          const issue = await git.forge.createIssue(folder, title, body);
          return { ok: true, text: `Opened #${issue.number}: ${issue.url}` };
        }
        case 'comment_on_issue': {
          if (!Number.isInteger(num) || num < 1) return { ok: false, text: 'number is required.' };
          const body = str('body', 65_000);
          if (!body.trim()) return { ok: false, text: 'body is required.' };
          const choice = await this.runs.requestLocalApproval(
            conversationId,
            { title: `${agentName} wants to comment on issue #${num}`, action: body.slice(0, 4000), target: null, reason: null, detail: null, approveLabel: 'Post comment' },
            true,
          );
          if (choice !== 'allow') return { ok: false, text: 'The user declined posting this comment.' };
          await git.forge.commentIssue(folder, num, body);
          return { ok: true, text: `Commented on issue #${num}.` };
        }
        default:
          return { ok: false, text: `Unknown git tool: ${name}` };
      }
    } catch (err) {
      return { ok: false, text: (err as Error).message };
    }
  }

  private async browserCall(conversationId: string, agentId: string, agentName: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const host = this.browser?.host;
    if (!host || !this.browser?.enabledFor(agentId)) return { ok: false, text: 'The browser is turned off for this agent. The user can turn it on in Nest → Settings → Connectors & tools.' };
    const ref = Math.round(Number(args.ref));
    const confirm = async (what: string, detail: string | null) =>
      (await this.runs.requestLocalApproval(conversationId, { title: `${agentName} wants to ${what} in its browser`, action: detail ?? what, target: null, reason: null, detail: null, approveLabel: 'Allow' })) === 'allow';
    try {
      switch (name) {
        case 'browser_open':
          return { ok: true, text: await host.open(agentId, String(args.url ?? '')) };
        case 'browser_snapshot':
          return { ok: true, text: await host.snapshot(agentId) };
        case 'browser_click':
          if (!Number.isFinite(ref)) return { ok: false, text: 'ref is required.' };
          if (!(await confirm('click', `Click element [${ref}]`))) return { ok: false, text: 'The user declined this click.' };
          return { ok: true, text: await host.click(agentId, ref) };
        case 'browser_type': {
          if (!Number.isFinite(ref)) return { ok: false, text: 'ref is required.' };
          const text = typeof args.text === 'string' ? args.text.slice(0, 5000) : '';
          if (!(await confirm('type', `Type “${text.slice(0, 120)}” into [${ref}]${args.submit === true ? ' and press Enter' : ''}`))) return { ok: false, text: 'The user declined this input.' };
          return { ok: true, text: await host.type(agentId, ref, text, args.submit === true, args.clear === true) };
        }
        case 'browser_scroll':
          return { ok: true, text: await host.scroll(agentId, args.direction === 'up' ? 'up' : 'down') };
        case 'browser_navigate': {
          const action = args.action === 'forward' || args.action === 'reload' ? args.action : 'back';
          return { ok: true, text: await host.history(agentId, action) };
        }
        case 'browser_screenshot': {
          const shot = await host.screenshot(agentId);
          return shot ? { ok: true, text: 'Screenshot of the current page.', image: shot } : { ok: false, text: 'The browser is not open. Use browser_open first.' };
        }
        default:
          return { ok: false, text: `Unknown browser tool: ${name}` };
      }
    } catch (err) {
      return { ok: false, text: `Browser error: ${(err as Error).message}` };
    }
  }

  async call(conversationId: string, name: string, rawArgs: unknown): Promise<ToolResult> {
    const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<string, unknown>;
    const conversation = this.db.getConversation(conversationId);
    const me = conversation ? this.db.getAgent(conversation.agentId, true) : null;
    if (!conversation || !me) return { ok: false, text: 'This conversation no longer exists in Nest.' };
    if (name.startsWith('browser_')) return this.browserCall(conversationId, me.id, me.name, name, args);
    if (name.startsWith('terminal_')) return this.terminalCall(conversationId, me.id, me.name, name, args);
    if (GIT_TOOL_NAMES.has(name)) return this.gitCall(conversationId, me.name, name, args);
    const str = (k: string, max = 20000) => (typeof args[k] === 'string' ? (args[k] as string).trim().slice(0, max) : '');

    switch (name) {
      case 'get_my_profile': {
        const notes = this.db.memoryForAgent(me.id, conversation.projectId);
        const project = conversation.projectId ? this.db.getProject(conversation.projectId) : null;
        return {
          ok: true,
          text: JSON.stringify(
            {
              name: me.name,
              instructions: me.instructions,
              project: project?.name ?? null,
              provider: PROVIDER_LABEL[conversation.provider],
              model: conversation.model ?? 'provider default',
              workingFolder: conversation.workspace ?? project?.workspace ?? 'Nest default working folder',
              memoryNotes: notes.map((n) => ({ id: n.id, scope: n.scope, note: n.content })),
            },
            null,
            2,
          ),
        };
      }
      case 'remember': {
        const note = str('note', 2000);
        if (!note) return { ok: false, text: 'note is required.' };
        if (args.project === true && !conversation.projectId) return { ok: false, text: 'This chat is not in a project. Save it for yourself, or with shared: true for every agent.' };
        // Shared and project notes reach other agents' prompts, which may run with more access than this one.
        if (args.shared === true || args.project === true) {
          const choice = await this.runs.requestLocalApproval(conversationId, {
            title: `${me.name} wants to save a memory note for ${args.shared === true ? 'every agent' : 'the project'}`,
            action: note,
            target: null,
            reason: null,
            detail: null,
            approveLabel: 'Save note',
          });
          if (choice !== 'allow') return { ok: false, text: 'The user declined saving this note.' };
        }
        const created =
          args.shared === true ? this.db.createMemory('shared', null, note, null) :
          args.project === true ? this.db.createMemory('project', conversation.projectId, note, null) :
          this.db.createMemory('agent', me.id, note, null);
        const whose = created.scope === 'shared' ? 'a shared' : created.scope === 'project' ? 'a project' : 'your';
        return { ok: true, text: `Saved ${whose} memory note. The user can see and edit it in Nest → Memory.` };
      }
      case 'list_agents': {
        const others = this.db.listAgents().filter((a) => a.id !== me.id);
        if (!others.length) return { ok: true, text: 'There are no other agents yet. You can propose one with create_agent.' };
        const projects = new Map(this.db.listProjects().map((p) => [p.id, p.name]));
        // Teammates in this chat's project first, so delegation stays inside it unless another agent fits better.
        const here = conversation.projectId;
        const team = new Set(here ? this.db.projectMembers(here).map((a) => a.id) : []);
        others.sort((a, b) => Number(team.has(b.id)) - Number(team.has(a.id)));
        return {
          ok: true,
          text: others
            .map((a) => {
              const where = here && team.has(a.id) ? `teammate in ${projects.get(here)}` : a.projectId ? projects.get(a.projectId) : null;
              return `- ${a.name} (${PROVIDER_LABEL[a.provider]}${where ? `, ${where}` : ''}): ${a.instructions.split('\n')[0].slice(0, 200) || 'no instructions'}`;
            })
            .join('\n'),
        };
      }
      case 'get_project': {
        // Any project by name (a chief of staff checking on another one), else this chat's.
        const asked = str('project', 60);
        const project = asked
          ? (this.db.listProjects().find((p) => p.name.toLowerCase() === asked.toLowerCase()) ?? null)
          : conversation.projectId
            ? this.db.getProject(conversation.projectId)
            : null;
        if (!project) {
          const names = this.db.listProjects().map((p) => p.name);
          return { ok: true, text: `${asked ? `No project named "${asked}".` : 'This chat is not in a project.'} ${names.length ? `Projects: ${names.join(', ')}. Pass project to look at one.` : 'There are no projects yet.'}` };
        }
        const members = this.db.projectMembers(project.id);
        const recent = this.db.listConversations().filter((c) => c.projectId === project.id && c.id !== conversationId);
        const names = new Map(this.db.listAgents().map((a) => [a.id, a.name]));
        return {
          ok: true,
          text: JSON.stringify(
            {
              name: project.name,
              brief: project.brief || null,
              sharedFolder: project.workspace ?? 'Nest default working folder',
              members: members.map((a) => ({ name: a.name, you: a.id === me.id, provider: PROVIDER_LABEL[a.provider], role: a.instructions.trim().split('\n')[0].slice(0, 200) })),
              projectMemory: this.db.memoryForAgent(me.id, project.id).filter((n) => n.scope === 'project').map((n) => n.content),
              recentWork: recent.slice(0, 12).map((c) => ({ agent: names.get(c.agentId), title: c.title, lastMessage: c.preview, updated: new Date(c.updatedAt).toLocaleString() })),
            },
            null,
            2,
          ),
        };
      }
      case 'delegate': {
        const target = this.findAgent(str('agent', 80));
        const task = str('task');
        if (!target) return { ok: false, text: `No agent named "${str('agent', 80)}". Use list_agents to see who is available.` };
        if (target.id === me.id) return { ok: false, text: 'You cannot delegate to yourself.' };
        if (!task) return { ok: false, text: 'task is required.' };
        if (this.runs.handoffDepth(conversationId) >= MAX_DELEGATION_DEPTH) return { ok: false, text: 'Delegation chain is too deep; do this part yourself or report back.' };
        // The target runs with its own permissions and connectors, which may exceed this agent's.
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to delegate to ${target.name}`,
          action: task,
          target: target.name,
          reason: null,
          detail: str('context', 40000) || null,
          approveLabel: 'Delegate',
        });
        if (choice !== 'allow') return { ok: false, text: `The user declined delegating to ${target.name}.` };
        try {
          const handoff = await this.runs.startHandoff({ sourceConversationId: conversationId, targetAgentId: target.id, task, context: str('context', 40000) });
          if (args.wait === false) return { ok: true, text: `Started. ${target.name} is working on it; the result will be posted to this conversation.` };
          const res = await this.runs.waitForHandoff(handoff.id, DELEGATE_WAIT_MS);
          if (res.status === 'completed') return { ok: true, text: `${target.name} finished:\n\n${res.result}` };
          return { ok: res.status !== 'failed', text: `${target.name}: ${res.result}` };
        } catch (err) {
          return { ok: false, text: `Could not delegate: ${(err as Error).message}` };
        }
      }
      case 'list_schedules': {
        const list = this.db.listSchedules();
        if (!list.length) return { ok: true, text: 'No schedules yet.' };
        const names = new Map(this.db.listAgents().map((a) => [a.id, a.name]));
        const projects = new Map(this.db.listProjects().map((p) => [p.id, p.name]));
        return {
          ok: true,
          text: list
            .map(
              (s) =>
                `- ${s.title} (${names.get(s.agentId) ?? 'removed agent'}): ${describeCadence(s.cadence)}${s.enabled ? '' : ' [paused]'}, works in ${(s.projectId && projects.get(s.projectId)) || 'no project'}${s.nextRunAt ? `, next ${new Date(s.nextRunAt).toLocaleString()}` : ''}`,
            )
            .join('\n'),
        };
      }
      case 'create_schedule': {
        const agent = str('agent', 80) ? this.findAgent(str('agent', 80)) : me;
        if (!agent) return { ok: false, text: `No agent named "${str('agent', 80)}".` };
        const cadence = sanitizeCadence({ kind: str('cadence', 20), time: str('time', 5), weekday: args.weekday, minutes: args.every_minutes });
        const title = str('title', 80);
        const prompt = str('prompt');
        if (!title || !prompt) return { ok: false, text: 'title and prompt are required.' };
        const projectArg = str('project', 80);
        const project = projectArg ? this.findProject(projectArg) : agent.projectId ? this.db.getProject(agent.projectId) : null;
        if (project === undefined) return { ok: false, text: `No project named "${projectArg}". Use get_project or list_agents to see the projects, or "none".` };
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to create a schedule`,
          action: `${title}: ${describeCadence(cadence)}`,
          target: `${agent.name} · ${worksIn(project)}`,
          reason: null,
          detail: prompt,
          approveLabel: 'Create schedule',
        }, ADMIN_ALWAYS_ASKS);
        if (choice !== 'allow') return { ok: false, text: 'The user declined this schedule.' };
        const s = this.scheduler.create({ agentId: agent.id, title, prompt, cadence, target: 'new', enabled: true, projectId: project?.id ?? null });
        return { ok: true, text: `Created "${s.title}" (${describeCadence(s.cadence)}), ${worksIn(project)}. Next run ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'not scheduled'}.` };
      }
      case 'update_schedule': {
        const name = str('schedule', 80).toLowerCase();
        const matches = this.db.listSchedules().filter((s) => s.title.toLowerCase() === name);
        if (!matches.length) return { ok: false, text: `No schedule named "${str('schedule', 80)}". Use list_schedules to see them.` };
        if (matches.length > 1) return { ok: false, text: `Several schedules are named "${str('schedule', 80)}". Ask the user to rename one in Nest.` };
        const cur = matches[0];
        const owner = this.db.getAgent(cur.agentId);
        if (!owner) return { ok: false, text: 'That schedule’s agent was removed.' };
        const changes: string[] = [];
        let projectId = cur.projectId;
        const projectArg = str('project', 80);
        if (projectArg) {
          const project = this.findProject(projectArg);
          if (project === undefined) return { ok: false, text: `No project named "${projectArg}". Use "none" for no project.` };
          if ((project?.id ?? null) !== cur.projectId) changes.push(`works in ${worksIn(project)}`);
          projectId = project?.id ?? null;
        }
        const cadence = str('cadence', 20) ? sanitizeCadence({ kind: str('cadence', 20), time: str('time', 5), weekday: args.weekday, minutes: args.every_minutes }) : cur.cadence;
        if (describeCadence(cadence) !== describeCadence(cur.cadence)) changes.push(`runs ${describeCadence(cadence)}`);
        const prompt = str('prompt') || cur.prompt;
        if (prompt !== cur.prompt) changes.push('new instructions');
        const enabled = typeof args.enabled === 'boolean' ? args.enabled : cur.enabled;
        if (enabled !== cur.enabled) changes.push(enabled ? 'resume' : 'pause');
        if (!changes.length) return { ok: true, text: `"${cur.title}" already looks like that; nothing changed.` };
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to change a schedule`,
          action: `${cur.title}: ${changes.join('; ')}`,
          target: owner.name,
          reason: null,
          detail: prompt !== cur.prompt ? prompt : null,
          approveLabel: 'Change schedule',
        }, ADMIN_ALWAYS_ASKS);
        if (choice !== 'allow') return { ok: false, text: 'The user declined this change.' };
        const s = this.scheduler.update(cur.id, { agentId: cur.agentId, title: cur.title, prompt, cadence, target: cur.target, enabled, projectId });
        const project = s.projectId ? this.db.getProject(s.projectId) : null;
        return { ok: true, text: `Updated "${s.title}": ${describeCadence(s.cadence)}${s.enabled ? '' : ' (paused)'}, ${worksIn(project)}. Its next run opens there.` };
      }
      case 'update_project': {
        const projectArg = str('project', 80);
        const project = projectArg ? this.findProject(projectArg) : conversation.projectId ? this.db.getProject(conversation.projectId) : null;
        if (!project) return { ok: false, text: projectArg ? `No project named "${projectArg}".` : 'This chat isn’t in a project. Name the project to change.' };
        const folderArg = str('folder', 1000);
        if (!folderArg) return { ok: false, text: 'folder is required: a full path, or "default".' };
        const folder = folderArg.toLowerCase() === 'default' ? null : path.resolve(folderArg);
        if (folder && !path.isAbsolute(folderArg)) return { ok: false, text: 'folder must be a full path, such as C:\\Users\\you\\Documents\\Nest\\gtm.' };
        if ((folder ?? null) === (project.workspace ?? null)) return { ok: true, text: `${project.name} already uses ${folder ?? 'Nest’s default working folder'}.` };
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to change a project’s folder`,
          action: `${project.name}: ${folder ?? 'Nest’s default working folder'}`,
          target: `Was: ${project.workspace ?? 'Nest’s default working folder'}`,
          reason: null,
          detail: 'Members without a folder of their own, and scheduled runs in this project, will work here from their next message.',
          approveLabel: 'Change folder',
        }, ADMIN_ALWAYS_ASKS);
        if (choice !== 'allow') return { ok: false, text: 'The user declined this change.' };
        this.db.updateProject(project.id, { name: project.name, brief: project.brief, workspace: folder, color: project.color });
        this.onAgentsChanged('projects');
        return { ok: true, text: `${project.name} now works in ${folder ?? 'Nest’s default working folder'}.` };
      }
      case 'create_agent': {
        const agentName = str('name', 60);
        const instructions = str('instructions', 20000);
        if (!agentName || !instructions) return { ok: false, text: 'name and instructions are required.' };
        if (this.findAgent(agentName)) return { ok: false, text: `An agent named "${agentName}" already exists.` };
        const provider: ProviderId = isProviderId(args.provider) ? args.provider : this.db.getSettings().defaultProvider;
        const projectArg = str('project', 60);
        const project =
          projectArg.toLowerCase() === 'none' ? null :
          projectArg ? this.db.listProjects().find((p) => p.name.toLowerCase() === projectArg.toLowerCase()) :
          conversation.projectId ? this.db.getProject(conversation.projectId) : null;
        if (project === undefined) return { ok: false, text: `No project named "${projectArg}". Leave project out to use yours, or ask the user to create it.` };
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to create an agent`,
          action: `${agentName} · ${PROVIDER_LABEL[provider]}`,
          target: project ? `Project: ${project.name}` : null,
          reason: null,
          detail: instructions,
          approveLabel: 'Create agent',
        }, ADMIN_ALWAYS_ASKS);
        if (choice !== 'allow') return { ok: false, text: 'The user declined creating this agent.' };
        const seed = [...agentName].reduce((n, c) => n + c.charCodeAt(0), 0);
        const created = this.db.createAgent({
          name: agentName,
          avatar: { shape: AVATAR_SHAPES[seed % AVATAR_SHAPES.length], color: AVATAR_PALETTE[seed % AVATAR_PALETTE.length], eyes: (['dots', 'happy', 'wide', 'sleepy'] as const)[seed % 4] },
          instructions,
          provider,
          model: str('model', 120) || this.db.getSettings().defaultModels[provider] || null,
          workspace: null,
          projectId: project?.id ?? null,
          pinned: false,
          permissions: this.db.getSettings().defaultPermissions ?? DEFAULT_PERMISSIONS,
        });
        this.onAgentsChanged();
        return { ok: true, text: `Created agent "${created.name}". You can now delegate to it.` };
      }
      case 'update_agent': {
        const target = this.findAgent(str('agent', 80));
        if (!target) return { ok: false, text: `No agent named "${str('agent', 80)}". Use list_agents to see who is available.` };
        const changes: string[] = [];
        const next = { ...target, permissions: { ...target.permissions } };
        const skipArg = args.skip_permissions;
        if (skipArg !== undefined) {
          const settings = this.db.getSettings();
          if (skipArg === 'default' || skipArg === null) {
            delete next.permissions.skipPermissions;
            changes.push('Permissions: follow the Nest default');
          } else {
            const skip = skipArg === true || skipArg === 'true';
            if (skip && !settings.allowSkipPermissions) {
              return { ok: false, text: 'Skipping permissions is turned off in Nest (Settings → Permissions → Allow skipping permissions). Ask the user to turn it on first.' };
            }
            next.permissions.skipPermissions = skip;
            changes.push(skip ? 'Permissions: skip (no approval prompts)' : 'Permissions: always ask');
          }
        }
        const instructions = str('instructions', 20000);
        if (instructions) {
          next.instructions = instructions;
          changes.push('Instructions: replaced');
        }
        if (isProviderId(args.provider)) {
          next.provider = args.provider;
          if (args.provider !== target.provider) next.model = null;
          changes.push(`Provider: ${PROVIDER_LABEL[args.provider]}`);
        }
        const model = str('model', 120);
        if (model) {
          next.model = model === 'default' ? null : model;
          changes.push(`Model: ${next.model ?? 'default'}`);
        }
        if (!changes.length) return { ok: false, text: 'Nothing to change. Pass skip_permissions, instructions, provider or model.' };
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to change ${target.name}`,
          action: changes.join(' · '),
          target: target.name,
          reason: str('reason', 500) || null,
          detail: instructions ? `New instructions:\n${instructions}\n\nCurrent instructions:\n${target.instructions}` : null,
          approveLabel: 'Apply changes',
        }, ADMIN_ALWAYS_ASKS);
        if (choice !== 'allow') return { ok: false, text: `The user kept ${target.name} as it was.` };
        const { id: _id, createdAt: _c, updatedAt: _u, ...draft } = next;
        this.db.updateAgent(target.id, draft);
        this.onAgentsChanged();
        return { ok: true, text: `Updated ${target.name}: ${changes.join('; ')}. Applies from its next message, including its existing conversations and routines.` };
      }
      case 'ask_permission': {
        const action = str('action', 2000);
        if (!action) return { ok: false, text: 'action is required.' };
        const choice = await this.runs.requestLocalApproval(
          conversationId,
          { title: `${me.name} asks permission`, action, target: null, reason: str('reason', 1000) || null, detail: str('details', 20000) || null, approveLabel: 'Approve' },
          true,
        );
        return choice === 'allow'
          ? { ok: true, text: 'The user approved. Go ahead with exactly this action.' }
          : { ok: true, text: 'The user declined. Do not do it; say what you did instead or what you need.' };
      }
      case 'update_my_instructions': {
        const instructions = str('instructions', 20000);
        if (!instructions) return { ok: false, text: 'instructions are required.' };
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to change its instructions`,
          action: str('reason', 500) || 'Update instructions',
          target: me.name,
          reason: null,
          detail: `New instructions:\n${instructions}\n\nCurrent instructions:\n${me.instructions}`,
          approveLabel: 'Update instructions',
        }, ADMIN_ALWAYS_ASKS);
        if (choice !== 'allow') return { ok: false, text: 'The user kept your current instructions.' };
        const { id: _id, createdAt: _c, updatedAt: _u, ...draft } = me;
        this.db.updateAgent(me.id, { ...draft, instructions });
        this.onAgentsChanged();
        return { ok: true, text: 'Your instructions were updated. They apply from your next turn.' };
      }
      default:
        return { ok: false, text: `Unknown Nest tool: ${name}` };
    }
  }

  /** A project by name; null for "none"; undefined when there's no such project. */
  private findProject(name: string): Project | null | undefined {
    const n = name.trim().toLowerCase();
    if (n === 'none') return null;
    return this.db.listProjects().find((p) => p.name.toLowerCase() === n);
  }

  private findAgent(name: string) {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const agents = this.db.listAgents();
    return agents.find((a) => a.name.toLowerCase() === n) ?? agents.find((a) => a.name.toLowerCase().startsWith(n)) ?? null;
  }
}
