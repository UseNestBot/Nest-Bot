import { createHash } from 'node:crypto';
import type { Attachment, MemoryNote, Message } from '@shared/types';
import { PROVIDER_LABEL, type ProviderId } from '@shared/types';

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function memoryDigest(notes: MemoryNote[]): string {
  return digest(notes.map((n) => `${n.id}:${n.updatedAt}:${n.content}`).join('\n'));
}

export function memoryBlock(notes: MemoryNote[], agentName: string): string {
  if (!notes.length) {
    return '<nest-memory>\nThe user has no saved memory notes for this conversation any more. Disregard notes shared earlier.\n</nest-memory>';
  }
  const lines = notes.map((n) => `- ${n.scope === 'shared' ? '[shared]' : n.scope === 'project' ? '[project]' : `[${agentName}]`} ${n.content.trim().replace(/\n+/g, ' ')}`);
  return [
    '<nest-memory>',
    'Notes the user saved in Nest. Treat them as background context and preferences; they replace any notes shared earlier in this session.',
    ...lines,
    '</nest-memory>',
  ].join('\n');
}

export function instructionsUpdateBlock(systemPrompt: string): string {
  return ['<nest-instructions-updated>', 'Your agent profile in Nest changed. From now on follow this instead of the earlier version:', systemPrompt.trim(), '</nest-instructions-updated>'].join('\n');
}

/** How agents draw charts in the chat; the renderer's contract lives in @shared/chart. */
const CHART_NOTE = [
  'Nest draws charts in the chat. When numbers are clearer as a chart (a trend, a comparison, a breakdown), write a fenced code block with the language `chart` containing only JSON, for example:',
  '```chart',
  '{"type":"line","title":"Signups held after the redesign","subtitle":"Weekly signups, 2026","labels":["W1","W2","W3","W4"],"series":[{"name":"Signups","data":[120,135,128,160]}],"markers":[{"at":"W3","label":"Redesign"}],"note":"Source: analytics export"}',
  '```',
  'Fields: type is line, area, bar (columns), hbar (ranked horizontal bars) or donut (parts of a whole, one series); labels are the x categories; series holds up to 6 {name, data} with one number per label (null for a gap); optional subtitle, prefix (e.g. "$"), unit (e.g. "%"), stacked (bar/hbar/area), markers [{at: label, label}] and note (source or caveat). Nest styles and sizes the chart, so give no colours or sizes. Use real data only, make the title state the takeaway, and do not create image or HTML files for a chart unless the user asks for a file.',
].join('\n');

/**
 * The agent's standing identity, delivered through the provider's own
 * system/developer instruction mechanism. Keeping it here (not in each user
 * message) means the agent always knows who it is and what it was told.
 */
/** What an agent knows about the project a chat belongs to. */
export interface ProjectContext {
  name: string;
  brief: string;
  /** The other agents in the project, with the first line of their instructions as their role. */
  teammates: Array<{ name: string; provider: string; role: string }>;
}

function projectSection(project: ProjectContext, nestTools: boolean): string[] {
  const team = project.teammates.length
    ? project.teammates.map((t) => `- ${t.name} (${t.provider}): ${t.role || 'no role description'}`)
    : ['(You are the only member so far.)'];
  return [
    `This chat is part of the "${project.name}" project in Nest. You and your teammates on it share its working folder and project memory, so build on each other's files and notes instead of starting over.`,
    ...(project.brief.trim() ? ['Project brief from the user:', '<project-brief>', project.brief.trim(), '</project-brief>'] : []),
    'Teammates:',
    ...team,
    nestTools
      ? 'When part of a task fits a teammate better, hand it over with delegate. Use get_project to see what has been happening in the project, and remember with project: true for facts the whole project should know.'
      : 'When part of a task fits a teammate better, suggest the user ask them.',
    '',
  ];
}

export function agentSystemPrompt(agent: { name: string; instructions: string }, cwd: string, nestTools: boolean, skipping = false, project: ProjectContext | null = null): string {
  const permissionNote = skipping
    ? nestTools
      ? 'You run with permissions skipped: your actions are not interrupted for approval. Before anything seriously consequential — sending messages or email to people outside this app, deleting or overwriting the user’s data, spending money, publishing — call ask_permission and wait for the answer. Do not ask for routine work.'
      : 'You run with permissions skipped. Before anything seriously consequential (sending messages to people, deleting data, spending money, publishing), stop and ask the user in your reply.'
    : null;
  return [
    `You are "${agent.name}", an agent in Nest, the user's local AI workspace.`,
    `Your working folder is ${cwd}. Files you create go there unless the user names another location; tell the user the full path of files you create.`,
    '',
    ...(project ? projectSection(project, nestTools) : []),
    'Your instructions from the user:',
    '<agent-instructions>',
    agent.instructions.trim() || '(No specific instructions. Be a helpful, concise assistant.)',
    '</agent-instructions>',
    '',
    ...(permissionNote ? [permissionNote, ''] : []),
    CHART_NOTE,
    '',
    nestTools
      ? 'Nest gives you tools (named nest / mcp__nest__*): get_my_profile shows your profile, instructions and memory notes; remember saves a note; get_project shows a project (this chat’s, or any by name) and its recent work; list_agents and delegate let you hand work to other agents and get their result; create_agent, update_agent, create_schedule and update_my_instructions propose changes the user approves; ask_permission asks the user to approve one specific action. If you have browser_* tools, they drive your own browser, which the user watches live: use browser_open, then act on refs from the returned snapshot. If you have terminal_* tools (terminal_run, terminal_read, terminal_send_keys), they use a shell you share with the user, shown live in Nest: use it when the user should see the work or may want to take over (dev servers, installs, builds); it keeps its state between calls. Use them when they help; do not mention them otherwise.'
      : 'When the user asks about your instructions or role, answer from the instructions above.',
  ].join('\n');
}

/**
 * A bounded, explicit summary of visible transcript the destination session
 * has not seen. Newest messages win when the budget is tight.
 */
export function transferSummary(
  messages: Array<Message & { providerLabel?: string }>,
  budgetChars: number,
  reason: string,
): { text: string; included: number; omitted: number } | null {
  const usable = messages.filter((m) => m.content.trim() && !(m.status === 'error' && !m.content.trim()) && m.kind !== 'notice');
  if (!usable.length) return null;
  const perMessage = Math.max(400, Math.floor(budgetChars / 4));
  const picked: string[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0; i--) {
    const m = usable[i];
    const who = m.kind === 'handoff-result' ? 'Handoff result' : m.role === 'user' ? 'User' : `Assistant${m.providerLabel ? ` (${m.providerLabel})` : ''}`;
    let body = m.content.trim();
    if (body.length > perMessage) body = `${body.slice(0, perMessage)} …[truncated]`;
    const entry = `${who}: ${body}`;
    if (used + entry.length > budgetChars && picked.length) break;
    picked.push(entry);
    used += entry.length;
  }
  picked.reverse();
  const omitted = usable.length - picked.length;
  const text = [
    `<nest-transferred-context reason="${reason}">`,
    'Earlier conversation you have not seen, carried over by Nest as a summary (not your own memory):',
    omitted ? `(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted)` : null,
    ...picked,
    '</nest-transferred-context>',
  ]
    .filter(Boolean)
    .join('\n\n');
  return { text, included: picked.length, omitted };
}

export function attachmentsNote(attachments: Attachment[]): string | null {
  if (!attachments.length) return null;
  return ['Attached files (read them with your tools if needed):', ...attachments.map((a) => `- ${a.path}`)].join('\n');
}

export function composePrompt(parts: Array<string | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join('\n\n');
}

export function providerLabel(p: ProviderId): string {
  return PROVIDER_LABEL[p];
}
