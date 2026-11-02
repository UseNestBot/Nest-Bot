import type { NestEvent, Schedule, ScheduleDraft } from '@shared/types';
import { computeNextRun, sanitizeCadence } from '@shared/schedule';
import type { NestDb } from './db';
import type { RunManager } from './runs';
import { UserFacingError } from './runs';

/**
 * Runs schedules while Nest is open. A run missed while Nest was closed fires
 * once at the next launch, then the schedule continues from now.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private firing = new Set<string>();

  constructor(
    private readonly db: NestDb,
    private readonly runs: RunManager,
    private readonly broadcast: (event: NestEvent) => void,
  ) {}

  start(intervalMs = 30_000): void {
    this.stop();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  create(draft: ScheduleDraft): Schedule {
    const clean = this.clean(draft);
    const schedule = this.db.createSchedule(clean, clean.enabled ? computeNextRun(clean.cadence, new Date()).getTime() : null);
    this.changed();
    return schedule;
  }

  update(id: string, draft: ScheduleDraft): Schedule {
    const current = this.db.getSchedule(id);
    if (!current) throw new UserFacingError('Schedule not found.');
    const clean = this.clean(draft, current);
    const schedule = this.db.updateSchedule(id, {
      ...clean,
      // A different target agent or mode starts a fresh conversation thread.
      conversationId: current.agentId === clean.agentId && clean.target === 'same' ? current.conversationId : null,
      nextRunAt: clean.enabled ? computeNextRun(clean.cadence, new Date()).getTime() : null,
    });
    this.changed();
    return schedule;
  }

  remove(id: string): void {
    this.db.deleteSchedule(id);
    this.changed();
  }

  /** Run a schedule immediately; its regular timing is unchanged. */
  async runNow(id: string): Promise<Schedule> {
    const s = this.db.getSchedule(id);
    if (!s) throw new UserFacingError('Schedule not found.');
    await this.fire(s, false);
    return this.db.getSchedule(id)!;
  }

  /** `current`: the schedule being edited, whose project is kept when the draft leaves it out. */
  private clean(d: ScheduleDraft, current?: Schedule): ScheduleDraft & { projectId: string | null } {
    const title = String(d.title ?? '').trim().slice(0, 80);
    const prompt = String(d.prompt ?? '').trim().slice(0, 20000);
    if (!title) throw new UserFacingError('Give the schedule a name.');
    if (!prompt) throw new UserFacingError('Describe what the agent should do each time.');
    const agent = this.db.getAgent(String(d.agentId));
    if (!agent) throw new UserFacingError('Pick an agent for this schedule.');
    const asked = d.projectId === undefined ? (current ? current.projectId : agent.projectId) : d.projectId;
    const projectId = typeof asked === 'string' && this.db.getProject(asked) ? asked : null;
    return { agentId: d.agentId, title, prompt, cadence: sanitizeCadence(d.cadence), target: d.target === 'same' ? 'same' : 'new', enabled: Boolean(d.enabled), projectId };
  }

  async tick(now = Date.now()): Promise<void> {
    for (const s of this.db.listSchedules()) {
      if (!s.enabled || s.nextRunAt === null || s.nextRunAt > now || this.firing.has(s.id)) continue;
      await this.fire(s, true);
    }
  }

  private async fire(s: Schedule, advance: boolean): Promise<void> {
    this.firing.add(s.id);
    const now = Date.now();
    const next = advance ? computeNextRun(s.cadence, new Date(now)).getTime() : s.nextRunAt;
    try {
      const agent = this.db.getAgent(s.agentId);
      if (!agent) {
        this.db.updateSchedule(s.id, { enabled: false, nextRunAt: null, lastStatus: 'Paused: its agent was removed.' });
        return;
      }
      let conversationId = s.target === 'same' && s.conversationId && this.db.getConversation(s.conversationId) ? s.conversationId : null;
      if (conversationId && this.runs.isRunning(conversationId)) {
        this.db.updateSchedule(s.id, { nextRunAt: next, lastRunAt: now, lastStatus: 'Skipped: the previous run was still going.' });
        return;
      }
      // Runs work in the schedule's project: the chat shows there and uses its folder, brief, memory and teammates.
      const projectId = s.projectId && this.db.getProject(s.projectId) ? s.projectId : null;
      if (conversationId && this.db.getConversation(conversationId)?.projectId !== projectId) {
        this.broadcast({ type: 'conversation', conversation: this.db.updateConversation(conversationId, { projectId }) });
      }
      if (!conversationId) {
        const stamp = new Date(now).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const conv = this.db.createConversation(agent, { title: s.target === 'same' ? s.title : `${s.title} · ${stamp}`, projectId });
        conversationId = conv.id;
        this.broadcast({ type: 'conversation', conversation: conv });
      }
      this.db.updateSchedule(s.id, {
        nextRunAt: next,
        lastRunAt: now,
        lastStatus: 'Started',
        lastConversationId: conversationId,
        conversationId: s.target === 'same' ? conversationId : s.conversationId,
      });
      await this.runs.send(conversationId, s.prompt, []);
    } catch (err) {
      this.db.updateSchedule(s.id, { nextRunAt: next, lastRunAt: now, lastStatus: `Could not start: ${(err as Error).message}` });
    } finally {
      this.firing.delete(s.id);
      this.changed();
    }
  }

  private changed(): void {
    this.broadcast({ type: 'schedules-changed' });
  }
}
