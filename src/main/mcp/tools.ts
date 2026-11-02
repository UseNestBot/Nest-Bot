import { describeCadence, sanitizeCadence } from '@shared/schedule';
import { AVATAR_PALETTE } from '@shared/templates';
import { DEFAULT_PERMISSIONS, PROVIDER_LABEL, PROVIDERS, isProviderId, type ProviderId } from '@shared/types';
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

/** Implements the Nest tools for one calling conversation. */
export class NestTools {
  constructor(
    private readonly db: NestDb,
    private readonly runs: RunManager,
    private readonly scheduler: Scheduler,
    private readonly onAgentsChanged: () => void,
    /** The built-in browser and who may use it; absent in tests and when unavailable. */
    private readonly browser?: { host: BrowserTools; enabledFor: (agentId: string) => boolean },
  ) {}

  /** Tools this conversation's agent may see: browser tools only when its Browser is set to the Nest browser. */
  listFor(conversationId: string): ToolDef[] {
    const agentId = this.db.getConversation(conversationId)?.agentId;
    const browser = Boolean(agentId && this.browser?.enabledFor(agentId));
    return browser ? [...TOOL_DEFS, ...BROWSER_TOOL_DEFS] : TOOL_DEFS;
  }

  private async browserCall(conversationId: string, agentId: string, agentName: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const host = this.browser?.host;
    if (!host || !this.browser?.enabledFor(agentId)) return { ok: false, text: 'The browser is turned off for this agent. The user can turn it on in Nest → Settings → Connectors & browser.' };
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
        return {
          ok: true,
          text: list
            .map((s) => `- ${s.title} (${names.get(s.agentId) ?? 'removed agent'}): ${describeCadence(s.cadence)}${s.enabled ? '' : ' [paused]'}${s.nextRunAt ? `, next ${new Date(s.nextRunAt).toLocaleString()}` : ''}`)
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
        const choice = await this.runs.requestLocalApproval(conversationId, {
          title: `${me.name} wants to create a schedule`,
          action: `${title}: ${describeCadence(cadence)}`,
          target: agent.name,
          reason: null,
          detail: prompt,
          approveLabel: 'Create schedule',
        }, ADMIN_ALWAYS_ASKS);
        if (choice !== 'allow') return { ok: false, text: 'The user declined this schedule.' };
        const s = this.scheduler.create({ agentId: agent.id, title, prompt, cadence, target: 'new', enabled: true });
        return { ok: true, text: `Created "${s.title}" (${describeCadence(s.cadence)}). Next run ${s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : 'not scheduled'}.` };
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
          model: str('model', 120) || null,
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

  private findAgent(name: string) {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const agents = this.db.listAgents();
    return agents.find((a) => a.name.toLowerCase() === n) ?? agents.find((a) => a.name.toLowerCase().startsWith(n)) ?? null;
  }
}
