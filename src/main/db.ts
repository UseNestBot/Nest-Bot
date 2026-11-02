import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_AGENT_ACCESS,
  DEFAULT_PERMISSIONS,
  DEFAULT_SETTINGS,
  type Activity,
  type Agent,
  type AgentAccess,
  type AgentDraft,
  type AppSettings,
  type BackupInfo,
  type Approval,
  type Conversation,
  type Handoff,
  type InboxItem,
  type MemoryNote,
  type MemoryScope,
  type Message,
  type PermissionSettings,
  type Project,
  type ProjectDraft,
  type ProviderId,
  type Run,
  type Schedule,
  type ScheduleDraft,
} from '@shared/types';
import { backupDatabase, listBackupInfo } from './backup';
import { migrateLegacySettings } from './settings';

type Row = Record<string, SQLInputValue>;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL,
    model TEXT,
    workspace TEXT,
    group_name TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    permissions TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    workspace TEXT,
    permissions TEXT NOT NULL,
    handoff_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX conversations_updated ON conversations(updated_at DESC);
  -- Native provider sessions are per (conversation, provider): switching provider keeps both.
  CREATE TABLE provider_sessions (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    memory_digest TEXT,
    instructions_digest TEXT,
    synced_seq INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, provider)
  );
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    run_id TEXT,
    role TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chat',
    content TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    attachments TEXT NOT NULL DEFAULT '[]',
    link_conversation_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, seq);
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    model TEXT,
    session_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    usage TEXT,
    included_note_ids TEXT NOT NULL DEFAULT '[]',
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX runs_conversation ON runs(conversation_id, started_at);
  CREATE TABLE activities (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT,
    output TEXT,
    status TEXT NOT NULL,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, id)
  );
  CREATE INDEX activities_conversation ON activities(conversation_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    request_id TEXT NOT NULL,
    title TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    reason TEXT,
    detail TEXT,
    choices TEXT NOT NULL,
    status TEXT NOT NULL,
    decision TEXT,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE TABLE memory_notes (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    agent_id TEXT,
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    source_message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE handoffs (
    id TEXT PRIMARY KEY,
    source_conversation_id TEXT NOT NULL,
    target_agent_id TEXT NOT NULL,
    target_conversation_id TEXT NOT NULL,
    task TEXT NOT NULL,
    context TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE TABLE inbox_items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    conversation_id TEXT,
    ref_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    resolved INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `ALTER TABLE conversations ADD COLUMN effort TEXT;`,
  `
  CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cadence TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT 'new',
    conversation_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_status TEXT,
    last_conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // Which connectors and browser an agent may use. Kept apart from agents so editing an agent can't reset it.
  `
  CREATE TABLE agent_access (
    agent_id TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Projects (bot families) replace the free-text agent group; each existing group becomes a project.
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brief TEXT NOT NULL DEFAULT '',
    workspace TEXT,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  ALTER TABLE agents ADD COLUMN project_id TEXT;
  ALTER TABLE memory_notes ADD COLUMN project_id TEXT;
  INSERT INTO projects (id, name, color, created_at, updated_at)
    SELECT lower(hex(randomblob(16))), trim(group_name), '#3b82f6', MIN(created_at), MAX(updated_at)
    FROM agents WHERE deleted_at IS NULL AND trim(COALESCE(group_name, '')) != '' GROUP BY trim(group_name);
  UPDATE agents SET project_id = (SELECT p.id FROM projects p WHERE p.name = trim(agents.group_name))
    WHERE trim(COALESCE(group_name, '')) != '';
  `,
  // Chats carry their own project, so one agent can work in several. Existing chats keep their agent's project.
  `
  ALTER TABLE conversations ADD COLUMN project_id TEXT;
  UPDATE conversations SET project_id = (SELECT a.project_id FROM agents a WHERE a.id = conversations.agent_id);
  `,
];

const json = <T>(v: SQLInputValue, fallback: T): T => {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const s = (v: SQLInputValue): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: SQLInputValue): number => Number(v ?? 0);

/** Conversations start without their own skip choice so they follow the agent (and later changes to it). */
function withoutSkip(p: PermissionSettings): PermissionSettings {
  const { skipPermissions: _skip, ...rest } = p;
  return rest;
}

export class NestDb {
  readonly db: DatabaseSync;

  constructor(readonly file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    backupDatabase(this.db, file, n((this.db.prepare('PRAGMA user_version').get() as Row).user_version), MIGRATIONS.length);
    this.migrate();
  }

  /** Snapshot the database now, whatever the last backup's age. */
  backUpNow(): boolean {
    return backupDatabase(this.db, this.file, MIGRATIONS.length, MIGRATIONS.length, Date.now(), true) !== null;
  }

  listBackups(): BackupInfo[] {
    return this.file === ':memory:' ? [] : listBackupInfo(this.file);
  }

  private migrate(): void {
    const version = n((this.db.prepare('PRAGMA user_version').get() as Row).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
    this.repairSchema();
  }

  /**
   * Migrations are numbered by position, so a build from another branch can leave a database claiming a
   * version whose tables or columns it never got (e.g. "table conversations has no column named project_id").
   * Re-create anything the migrations define that is missing, and backfill the columns that need it.
   */
  private repairSchema(): void {
    const tables = new Set(this.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => String(r.name)));
    const columns = (table: string) => new Set(this.all(`PRAGMA table_info(${table})`).map((r) => String(r.name)));
    const added = new Set<string>();
    this.tx(() => {
      for (const m of MIGRATIONS) {
        for (const [ddl, table] of m.matchAll(/CREATE TABLE (\w+) \([\s\S]*?\n\s*\);/g)) {
          if (tables.has(table)) continue;
          this.db.exec(ddl);
          tables.add(table);
        }
        for (const [ddl, table, column] of m.matchAll(/ALTER TABLE (\w+) ADD COLUMN (\w+)[^;]*;/g)) {
          if (!tables.has(table) || columns(table).has(column)) continue;
          this.db.exec(ddl);
          added.add(`${table}.${column}`);
        }
      }
      if (added.has('conversations.project_id')) {
        this.db.exec(
          `UPDATE conversations SET project_id = (SELECT a.project_id FROM agents a WHERE a.id = conversations.agent_id)
            WHERE project_id IS NULL`,
        );
      }
    });
  }

  close(): void {
    this.db.close();
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  /**
   * Anything left "live" by a previous process (crash, force quit) is closed
   * out so the transcript is consistent: partial text is kept and marked.
   */
  recoverAfterRestart(): void {
    const now = Date.now();
    this.tx(() => {
      this.run(`UPDATE messages SET status = 'interrupted', error = COALESCE(error, 'Nest closed before the response finished.') WHERE status = 'streaming'`);
      this.run(`UPDATE runs SET status = 'interrupted', ended_at = ?, error = COALESCE(error, 'Nest closed during this run.') WHERE status = 'running'`, now);
      this.run(`UPDATE activities SET status = 'failed', updated_at = ? WHERE status = 'running'`, now);
      this.run(`UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending'`, now);
      this.run(`UPDATE inbox_items SET resolved = 1 WHERE kind = 'approval' AND resolved = 0`);
      this.run(`UPDATE handoffs SET status = 'failed', completed_at = ?, result = COALESCE(result, 'Nest closed before the handoff finished.') WHERE status = 'running'`, now);
    });
  }

  // ---- settings -----------------------------------------------------------

  getSettings(): AppSettings {
    const stored: Record<string, unknown> = {};
    for (const r of this.all('SELECT key, value FROM settings')) stored[String(r.key)] = json<unknown>(r.value, undefined);
    migrateLegacySettings(stored);
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const [key, value] of Object.entries(stored)) {
      // An unreadable value keeps the default rather than becoming null.
      if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
      const fallback = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
      // Objects gain fields over time: fill ones an older build didn't store.
      out[key] = fallback && typeof fallback === 'object' && !Array.isArray(fallback) && value && typeof value === 'object' ? { ...fallback, ...value } : value;
    }
    return out as unknown as AppSettings;
  }

  stats(): { agents: number; conversations: number; messages: number; notes: number } {
    const count = (sql: string) => n((this.get(sql) ?? {}).c);
    return {
      agents: count('SELECT COUNT(*) AS c FROM agents WHERE deleted_at IS NULL'),
      conversations: count('SELECT COUNT(*) AS c FROM conversations'),
      messages: count('SELECT COUNT(*) AS c FROM messages'),
      notes: count('SELECT COUNT(*) AS c FROM memory_notes'),
    };
  }

  updateSettings(patch: Partial<AppSettings>): AppSettings {
    this.tx(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS)) continue;
        this.run('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
      }
    });
    return this.getSettings();
  }

  // ---- agents -------------------------------------------------------------

  private toAgent(r: Row): Agent {
    return {
      id: String(r.id),
      name: String(r.name),
      avatar: json(r.avatar, { shape: 'blob', color: '#5fb87a', eyes: 'dots' }),
      instructions: String(r.instructions ?? ''),
      provider: String(r.provider) as ProviderId,
      model: s(r.model),
      workspace: s(r.workspace),
      projectId: s(r.project_id),
      pinned: n(r.pinned) === 1,
      permissions: { ...DEFAULT_PERMISSIONS, ...json(r.permissions, {}) },
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
    };
  }

  listAgents(): Agent[] {
    return this.all('SELECT * FROM agents WHERE deleted_at IS NULL ORDER BY pinned DESC, name COLLATE NOCASE').map((r) => this.toAgent(r));
  }

  getAgent(id: string, includeDeleted = false): Agent | null {
    const r = this.get(`SELECT * FROM agents WHERE id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`, id);
    return r ? this.toAgent(r) : null;
  }

  createAgent(d: AgentDraft): Agent {
    const id = randomUUID();
    const now = Date.now();
    this.run(
      `INSERT INTO agents (id, name, avatar, instructions, provider, model, workspace, project_id, pinned, permissions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, d.name, JSON.stringify(d.avatar), d.instructions, d.provider, d.model || null, d.workspace || null, this.validProject(d.projectId), d.pinned ? 1 : 0, JSON.stringify(d.permissions), now, now,
    );
    return this.getAgent(id)!;
  }

  updateAgent(id: string, d: AgentDraft): Agent {
    this.run(
      `UPDATE agents SET name = ?, avatar = ?, instructions = ?, provider = ?, model = ?, workspace = ?, project_id = ?, pinned = ?, permissions = ?, updated_at = ? WHERE id = ?`,
      d.name, JSON.stringify(d.avatar), d.instructions, d.provider, d.model || null, d.workspace || null, this.validProject(d.projectId), d.pinned ? 1 : 0, JSON.stringify(d.permissions), Date.now(), id,
    );
    return this.getAgent(id)!;
  }

  /** Move an agent into a project (or out of every project with null). */
  setAgentProject(id: string, projectId: string | null): Agent {
    this.run('UPDATE agents SET project_id = ?, updated_at = ? WHERE id = ?', this.validProject(projectId), Date.now(), id);
    return this.getAgent(id)!;
  }

  private validProject(projectId: string | null | undefined): string | null {
    return projectId && this.getProject(projectId) ? projectId : null;
  }

  getAgentAccess(agentId: string): AgentAccess {
    const r = this.get('SELECT value FROM agent_access WHERE agent_id = ?', agentId);
    return { ...DEFAULT_AGENT_ACCESS, ...json(r?.value ?? null, {}) };
  }

  setAgentAccess(agentId: string, access: AgentAccess): AgentAccess {
    this.run('INSERT INTO agent_access(agent_id, value) VALUES (?, ?) ON CONFLICT(agent_id) DO UPDATE SET value = excluded.value', agentId, JSON.stringify(access));
    return this.getAgentAccess(agentId);
  }

  /** Soft delete: past conversations stay readable. */
  deleteAgent(id: string): void {
    this.run('UPDATE agents SET deleted_at = ?, pinned = 0 WHERE id = ?', Date.now(), id);
  }

  // ---- projects -----------------------------------------------------------

  private toProject(r: Row): Project {
    return {
      id: String(r.id),
      name: String(r.name),
      brief: String(r.brief ?? ''),
      workspace: s(r.workspace),
      color: String(r.color),
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
    };
  }

  listProjects(): Project[] {
    return this.all('SELECT * FROM projects ORDER BY name COLLATE NOCASE').map((r) => this.toProject(r));
  }

  getProject(id: string): Project | null {
    const r = this.get('SELECT * FROM projects WHERE id = ?', id);
    return r ? this.toProject(r) : null;
  }

  createProject(d: ProjectDraft): Project {
    const id = randomUUID();
    const now = Date.now();
    this.run('INSERT INTO projects (id, name, brief, workspace, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, d.name, d.brief, d.workspace || null, d.color, now, now);
    return this.getProject(id)!;
  }

  updateProject(id: string, d: ProjectDraft): Project {
    this.run('UPDATE projects SET name = ?, brief = ?, workspace = ?, color = ?, updated_at = ? WHERE id = ?', d.name, d.brief, d.workspace || null, d.color, Date.now(), id);
    return this.getProject(id)!;
  }

  /** Members and chats stay, outside any project; the project's own memory notes go with it. */
  deleteProject(id: string): void {
    this.tx(() => {
      this.run('UPDATE agents SET project_id = NULL WHERE project_id = ?', id);
      this.run('UPDATE conversations SET project_id = NULL WHERE project_id = ?', id);
      this.run(`DELETE FROM memory_notes WHERE scope = 'project' AND project_id = ?`, id);
      this.run('DELETE FROM projects WHERE id = ?', id);
    });
  }

  /** Agents in the project, plus agents with a chat in it (e.g. a chief of staff working across projects). */
  projectMembers(projectId: string): Agent[] {
    const guests = new Set(this.all('SELECT DISTINCT agent_id FROM conversations WHERE project_id = ?', projectId).map((r) => String(r.agent_id)));
    return this.listAgents().filter((a) => a.projectId === projectId || guests.has(a.id));
  }

  // ---- conversations ------------------------------------------------------

  private toConversation(r: Row): Conversation {
    return {
      id: String(r.id),
      agentId: String(r.agent_id),
      title: String(r.title),
      provider: String(r.provider) as ProviderId,
      model: s(r.model),
      effort: s(r.effort),
      workspace: s(r.workspace),
      permissions: { ...DEFAULT_PERMISSIONS, ...json(r.permissions, {}) },
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
      preview: String(r.preview ?? ''),
      handoffId: s(r.handoff_id),
      projectId: s(r.project_id),
    };
  }

  private conversationSelect = `
    SELECT c.*, (
      SELECT substr(m.content, 1, 160) FROM messages m
      WHERE m.conversation_id = c.id AND m.kind != 'notice' AND m.content != ''
      ORDER BY m.seq DESC LIMIT 1
    ) AS preview
    FROM conversations c`;

  listConversations(): Conversation[] {
    return this.all(`${this.conversationSelect} ORDER BY c.updated_at DESC LIMIT 500`).map((r) => this.toConversation(r));
  }

  getConversation(id: string): Conversation | null {
    const r = this.get(`${this.conversationSelect} WHERE c.id = ?`, id);
    return r ? this.toConversation(r) : null;
  }

  /** New chats start outside any project unless one is given (a project view, a handoff from a project chat). */
  createConversation(agent: Agent, opts: { title?: string; handoffId?: string | null; projectId?: string | null } = {}): Conversation {
    const id = randomUUID();
    const now = Date.now();
    const projectId = this.validProject(opts.projectId ?? null);
    this.run(
      `INSERT INTO conversations (id, agent_id, title, provider, model, workspace, permissions, handoff_id, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, agent.id, opts.title ?? 'New conversation', agent.provider, agent.model, agent.workspace, JSON.stringify(withoutSkip(agent.permissions)), opts.handoffId ?? null, projectId, now, now,
    );
    return this.getConversation(id)!;
  }

  updateConversation(id: string, patch: Partial<Pick<Conversation, 'title' | 'provider' | 'model' | 'effort' | 'workspace' | 'permissions' | 'projectId'>>): Conversation {
    const current = this.getConversation(id);
    if (!current) throw new Error('Conversation not found');
    const next = { ...current, ...patch };
    this.run(
      'UPDATE conversations SET title = ?, provider = ?, model = ?, effort = ?, workspace = ?, permissions = ?, project_id = ? WHERE id = ?',
      next.title, next.provider, next.model, next.effort, next.workspace, JSON.stringify(next.permissions), this.validProject(next.projectId), id,
    );
    return this.getConversation(id)!;
  }

  touchConversation(id: string): void {
    this.run('UPDATE conversations SET updated_at = ? WHERE id = ?', Date.now(), id);
  }

  deleteConversation(id: string): void {
    this.tx(() => {
      this.run('DELETE FROM approvals WHERE conversation_id = ?', id);
      this.run('DELETE FROM activities WHERE conversation_id = ?', id);
      this.run('DELETE FROM inbox_items WHERE conversation_id = ?', id);
      this.run('DELETE FROM conversations WHERE id = ?', id);
    });
  }

  // ---- provider sessions ---------------------------------------------------

  getProviderSession(conversationId: string, provider: ProviderId): { sessionId: string; memoryDigest: string | null; instructionsDigest: string | null; syncedSeq: number } | null {
    const r = this.get('SELECT * FROM provider_sessions WHERE conversation_id = ? AND provider = ?', conversationId, provider);
    return r ? { sessionId: String(r.session_id), memoryDigest: s(r.memory_digest), instructionsDigest: s(r.instructions_digest), syncedSeq: n(r.synced_seq) } : null;
  }

  upsertProviderSession(conversationId: string, provider: ProviderId, fields: { sessionId: string; memoryDigest?: string | null; instructionsDigest?: string | null; syncedSeq?: number }): void {
    const existing = this.getProviderSession(conversationId, provider);
    const merged = {
      sessionId: fields.sessionId,
      memoryDigest: fields.memoryDigest !== undefined ? fields.memoryDigest : existing?.sessionId === fields.sessionId ? existing.memoryDigest : null,
      instructionsDigest: fields.instructionsDigest !== undefined ? fields.instructionsDigest : existing?.sessionId === fields.sessionId ? existing.instructionsDigest : null,
      syncedSeq: fields.syncedSeq ?? (existing?.sessionId === fields.sessionId ? existing.syncedSeq : 0),
    };
    this.run(
      `INSERT INTO provider_sessions (conversation_id, provider, session_id, memory_digest, instructions_digest, synced_seq, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, provider) DO UPDATE SET session_id = excluded.session_id, memory_digest = excluded.memory_digest,
         instructions_digest = excluded.instructions_digest, synced_seq = excluded.synced_seq, updated_at = excluded.updated_at`,
      conversationId, provider, merged.sessionId, merged.memoryDigest, merged.instructionsDigest, merged.syncedSeq, Date.now(),
    );
  }

  clearProviderSession(conversationId: string, provider: ProviderId): void {
    this.run('DELETE FROM provider_sessions WHERE conversation_id = ? AND provider = ?', conversationId, provider);
  }

  // ---- messages -----------------------------------------------------------

  private toMessage(r: Row): Message {
    return {
      id: String(r.id),
      conversationId: String(r.conversation_id),
      runId: s(r.run_id),
      role: String(r.role) as Message['role'],
      kind: String(r.kind) as Message['kind'],
      content: String(r.content),
      status: String(r.status) as Message['status'],
      error: s(r.error),
      attachments: json(r.attachments, []),
      linkConversationId: s(r.link_conversation_id),
      createdAt: n(r.created_at),
    };
  }

  listMessages(conversationId: string): Message[] {
    return this.all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', conversationId).map((r) => this.toMessage(r));
  }

  /** Messages with their sequence numbers, for building transfer summaries. */
  listMessagesWithSeq(conversationId: string, afterSeq = 0): Array<Message & { seq: number }> {
    return this.all('SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq', conversationId, afterSeq).map((r) => ({ ...this.toMessage(r), seq: n(r.seq) }));
  }

  seqOfMessage(id: string): number {
    return n((this.get('SELECT seq FROM messages WHERE id = ?', id) ?? {}).seq);
  }

  maxMessageSeq(conversationId: string): number {
    return n((this.get('SELECT MAX(seq) AS m FROM messages WHERE conversation_id = ?', conversationId) ?? {}).m);
  }

  getMessage(id: string): Message | null {
    const r = this.get('SELECT * FROM messages WHERE id = ?', id);
    return r ? this.toMessage(r) : null;
  }

  insertMessage(m: Omit<Message, 'id' | 'createdAt'> & { id?: string }): Message {
    const id = m.id ?? randomUUID();
    this.run(
      `INSERT INTO messages (id, conversation_id, run_id, role, kind, content, status, error, attachments, link_conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, m.conversationId, m.runId, m.role, m.kind, m.content, m.status, m.error, JSON.stringify(m.attachments), m.linkConversationId, Date.now(),
    );
    this.touchConversation(m.conversationId);
    return this.getMessage(id)!;
  }

  updateMessage(id: string, patch: Partial<Pick<Message, 'content' | 'status' | 'error'>>): Message {
    const cur = this.getMessage(id);
    if (!cur) throw new Error('Message not found');
    const next = { ...cur, ...patch };
    this.run('UPDATE messages SET content = ?, status = ?, error = ? WHERE id = ?', next.content, next.status, next.error, id);
    return next;
  }

  // ---- runs ---------------------------------------------------------------

  private toRun(r: Row): Run {
    return {
      id: String(r.id),
      conversationId: String(r.conversation_id),
      provider: String(r.provider) as ProviderId,
      model: s(r.model),
      sessionId: s(r.session_id),
      status: String(r.status) as Run['status'],
      error: s(r.error),
      usage: json(r.usage, null),
      includedNoteIds: json(r.included_note_ids, []),
      startedAt: n(r.started_at),
      endedAt: r.ended_at === null ? null : n(r.ended_at),
    };
  }

  createRun(r: Pick<Run, 'conversationId' | 'provider' | 'model' | 'sessionId' | 'includedNoteIds'>): Run {
    const id = randomUUID();
    this.run(
      `INSERT INTO runs (id, conversation_id, provider, model, session_id, status, included_note_ids, started_at) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
      id, r.conversationId, r.provider, r.model, r.sessionId, JSON.stringify(r.includedNoteIds), Date.now(),
    );
    return this.getRun(id)!;
  }

  getRun(id: string): Run | null {
    const r = this.get('SELECT * FROM runs WHERE id = ?', id);
    return r ? this.toRun(r) : null;
  }

  listRuns(conversationId: string): Run[] {
    return this.all('SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at', conversationId).map((r) => this.toRun(r));
  }

  updateRun(id: string, patch: Partial<Pick<Run, 'status' | 'error' | 'usage' | 'sessionId' | 'endedAt' | 'model' | 'includedNoteIds'>>): Run {
    const cur = this.getRun(id);
    if (!cur) throw new Error('Run not found');
    const next = { ...cur, ...patch };
    this.run(
      'UPDATE runs SET status = ?, error = ?, usage = ?, session_id = ?, ended_at = ?, model = ?, included_note_ids = ? WHERE id = ?',
      next.status, next.error, next.usage ? JSON.stringify(next.usage) : null, next.sessionId, next.endedAt, next.model, JSON.stringify(next.includedNoteIds), id,
    );
    return next;
  }

  // ---- activities ---------------------------------------------------------

  private toActivity(r: Row): Activity {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      kind: String(r.kind) as Activity['kind'],
      title: String(r.title),
      detail: s(r.detail),
      output: s(r.output),
      status: String(r.status) as Activity['status'],
      seq: n(r.seq),
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
    };
  }

  /** Insert or merge an activity; empty/undefined fields never erase stored values. */
  upsertActivity(conversationId: string, a: Pick<Activity, 'id' | 'runId' | 'kind' | 'status'> & { title?: string; detail?: string | null; output?: string | null }): Activity {
    const now = Date.now();
    const cur = this.get('SELECT * FROM activities WHERE run_id = ? AND id = ?', a.runId, a.id);
    if (!cur) {
      const seq = n((this.get('SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM activities WHERE run_id = ?', a.runId) ?? {}).s);
      this.run(
        `INSERT INTO activities (id, run_id, conversation_id, kind, title, detail, output, status, seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        a.id, a.runId, conversationId, a.kind, a.title || a.kind, a.detail ?? null, a.output ?? null, a.status, seq, now, now,
      );
    } else {
      this.run(
        'UPDATE activities SET title = ?, detail = ?, output = ?, status = ?, updated_at = ? WHERE run_id = ? AND id = ?',
        a.title || String(cur.title), a.detail ?? s(cur.detail), a.output ?? s(cur.output), a.status, now, a.runId, a.id,
      );
    }
    return this.toActivity(this.get('SELECT * FROM activities WHERE run_id = ? AND id = ?', a.runId, a.id)!);
  }

  listActivities(conversationId: string): Activity[] {
    return this.all('SELECT * FROM activities WHERE conversation_id = ? ORDER BY run_id, seq', conversationId).map((r) => this.toActivity(r));
  }

  failRunningActivities(runId: string, status: Activity['status']): Activity[] {
    const rows = this.all(`SELECT id FROM activities WHERE run_id = ? AND status = 'running'`, runId);
    this.run(`UPDATE activities SET status = ?, updated_at = ? WHERE run_id = ? AND status = 'running'`, status, Date.now(), runId);
    return rows.map((r) => this.toActivity(this.get('SELECT * FROM activities WHERE run_id = ? AND id = ?', runId, String(r.id))!));
  }

  // ---- approvals ----------------------------------------------------------

  private toApproval(r: Row): Approval {
    return {
      id: String(r.id),
      runId: String(r.run_id),
      conversationId: String(r.conversation_id),
      provider: String(r.provider) as ProviderId,
      title: String(r.title),
      action: String(r.action),
      target: s(r.target),
      reason: s(r.reason),
      detail: s(r.detail),
      choices: json(r.choices, []),
      status: String(r.status) as Approval['status'],
      decision: s(r.decision),
      createdAt: n(r.created_at),
      resolvedAt: r.resolved_at === null ? null : n(r.resolved_at),
    };
  }

  createApproval(a: Omit<Approval, 'id' | 'status' | 'decision' | 'createdAt' | 'resolvedAt'> & { requestId: string }): Approval {
    const id = randomUUID();
    this.run(
      `INSERT INTO approvals (id, run_id, conversation_id, provider, request_id, title, action, target, reason, detail, choices, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      id, a.runId, a.conversationId, a.provider, a.requestId, a.title, a.action, a.target, a.reason, a.detail, JSON.stringify(a.choices), Date.now(),
    );
    return this.getApproval(id)!;
  }

  getApproval(id: string): (Approval & { requestId: string }) | null {
    const r = this.get('SELECT * FROM approvals WHERE id = ?', id);
    return r ? { ...this.toApproval(r), requestId: String(r.request_id) } : null;
  }

  findApprovalByRequest(runId: string, requestId: string): Approval | null {
    const r = this.get(`SELECT * FROM approvals WHERE run_id = ? AND request_id = ? AND status = 'pending'`, runId, requestId);
    return r ? this.toApproval(r) : null;
  }

  resolveApproval(id: string, status: 'resolved' | 'expired', decision: string | null): Approval {
    this.run('UPDATE approvals SET status = ?, decision = ?, resolved_at = ? WHERE id = ?', status, decision, Date.now(), id);
    this.run(`UPDATE inbox_items SET resolved = 1 WHERE kind = 'approval' AND ref_id = ?`, id);
    return this.getApproval(id)!;
  }

  listApprovals(conversationId: string): Approval[] {
    return this.all('SELECT * FROM approvals WHERE conversation_id = ? ORDER BY created_at', conversationId).map((r) => this.toApproval(r));
  }

  // ---- memory -------------------------------------------------------------

  private toNote(r: Row): MemoryNote {
    return {
      id: String(r.id),
      scope: String(r.scope) as MemoryScope,
      agentId: s(r.agent_id),
      projectId: s(r.project_id),
      content: String(r.content),
      enabled: n(r.enabled) === 1,
      sourceMessageId: s(r.source_message_id),
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
    };
  }

  listMemory(): MemoryNote[] {
    return this.all('SELECT * FROM memory_notes ORDER BY scope, created_at').map((r) => this.toNote(r));
  }

  /** Enabled notes for an agent working in a project (default: the project it belongs to): shared ones, the project's, then its own. */
  memoryForAgent(agentId: string, projectId: string | null = this.getAgent(agentId, true)?.projectId ?? null): MemoryNote[] {
    return this.all(
      `SELECT * FROM memory_notes WHERE enabled = 1 AND (scope = 'shared' OR (scope = 'project' AND project_id = ?) OR (scope = 'agent' AND agent_id = ?))
       ORDER BY CASE scope WHEN 'shared' THEN 0 WHEN 'project' THEN 1 ELSE 2 END, created_at`,
      projectId, agentId,
    ).map((r) => this.toNote(r));
  }

  /** `owner` is the agent id for agent notes and the project id for project notes. */
  createMemory(scope: MemoryScope, owner: string | null, content: string, sourceMessageId: string | null = null): MemoryNote {
    const id = randomUUID();
    const now = Date.now();
    this.run(
      'INSERT INTO memory_notes (id, scope, agent_id, project_id, content, enabled, source_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)',
      id, scope, scope === 'agent' ? owner : null, scope === 'project' ? owner : null, content, sourceMessageId, now, now,
    );
    return this.toNote(this.get('SELECT * FROM memory_notes WHERE id = ?', id)!);
  }

  updateMemory(id: string, patch: { content?: string; enabled?: boolean }): MemoryNote {
    const cur = this.get('SELECT * FROM memory_notes WHERE id = ?', id);
    if (!cur) throw new Error('Note not found');
    const note = this.toNote(cur);
    this.run(
      'UPDATE memory_notes SET content = ?, enabled = ?, updated_at = ? WHERE id = ?',
      patch.content ?? note.content, (patch.enabled ?? note.enabled) ? 1 : 0, Date.now(), id,
    );
    return this.toNote(this.get('SELECT * FROM memory_notes WHERE id = ?', id)!);
  }

  deleteMemory(id: string): void {
    this.run('DELETE FROM memory_notes WHERE id = ?', id);
  }

  // ---- schedules ----------------------------------------------------------

  private toSchedule(r: Row): Schedule {
    return {
      id: String(r.id),
      agentId: String(r.agent_id),
      title: String(r.title),
      prompt: String(r.prompt),
      cadence: json(r.cadence, { kind: 'daily', time: '09:00' }),
      target: String(r.target) === 'same' ? 'same' : 'new',
      conversationId: s(r.conversation_id),
      enabled: n(r.enabled) === 1,
      nextRunAt: r.next_run_at === null ? null : n(r.next_run_at),
      lastRunAt: r.last_run_at === null ? null : n(r.last_run_at),
      lastStatus: s(r.last_status),
      lastConversationId: s(r.last_conversation_id),
      createdAt: n(r.created_at),
      updatedAt: n(r.updated_at),
    };
  }

  listSchedules(): Schedule[] {
    return this.all('SELECT * FROM schedules ORDER BY created_at').map((r) => this.toSchedule(r));
  }

  getSchedule(id: string): Schedule | null {
    const r = this.get('SELECT * FROM schedules WHERE id = ?', id);
    return r ? this.toSchedule(r) : null;
  }

  createSchedule(d: ScheduleDraft, nextRunAt: number | null): Schedule {
    const id = randomUUID();
    const now = Date.now();
    this.run(
      `INSERT INTO schedules (id, agent_id, title, prompt, cadence, target, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, d.agentId, d.title, d.prompt, JSON.stringify(d.cadence), d.target, d.enabled ? 1 : 0, nextRunAt, now, now,
    );
    return this.getSchedule(id)!;
  }

  updateSchedule(id: string, patch: Partial<Omit<Schedule, 'id' | 'createdAt' | 'updatedAt'>>): Schedule {
    const cur = this.getSchedule(id);
    if (!cur) throw new Error('Schedule not found');
    const x = { ...cur, ...patch };
    this.run(
      `UPDATE schedules SET agent_id = ?, title = ?, prompt = ?, cadence = ?, target = ?, conversation_id = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_status = ?, last_conversation_id = ?, updated_at = ? WHERE id = ?`,
      x.agentId, x.title, x.prompt, JSON.stringify(x.cadence), x.target, x.conversationId, x.enabled ? 1 : 0, x.nextRunAt, x.lastRunAt, x.lastStatus, x.lastConversationId, Date.now(), id,
    );
    return this.getSchedule(id)!;
  }

  deleteSchedule(id: string): void {
    this.run('DELETE FROM schedules WHERE id = ?', id);
  }

  // ---- handoffs & inbox ---------------------------------------------------

  private toHandoff(r: Row): Handoff {
    return {
      id: String(r.id),
      sourceConversationId: String(r.source_conversation_id),
      targetAgentId: String(r.target_agent_id),
      targetConversationId: String(r.target_conversation_id),
      task: String(r.task),
      context: String(r.context),
      status: String(r.status) as Handoff['status'],
      result: s(r.result),
      createdAt: n(r.created_at),
      completedAt: r.completed_at === null ? null : n(r.completed_at),
    };
  }

  createHandoff(h: Pick<Handoff, 'id' | 'sourceConversationId' | 'targetAgentId' | 'targetConversationId' | 'task' | 'context'>): Handoff {
    this.run(
      `INSERT INTO handoffs (id, source_conversation_id, target_agent_id, target_conversation_id, task, context, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      h.id, h.sourceConversationId, h.targetAgentId, h.targetConversationId, h.task, h.context, Date.now(),
    );
    return this.getHandoff(h.id)!;
  }

  getHandoff(id: string): Handoff | null {
    const r = this.get('SELECT * FROM handoffs WHERE id = ?', id);
    return r ? this.toHandoff(r) : null;
  }

  completeHandoff(id: string, status: 'completed' | 'failed', result: string): Handoff {
    this.run('UPDATE handoffs SET status = ?, result = ?, completed_at = ? WHERE id = ?', status, result, Date.now(), id);
    return this.getHandoff(id)!;
  }

  listHandoffs(): Handoff[] {
    return this.all('SELECT * FROM handoffs ORDER BY created_at DESC LIMIT 200').map((r) => this.toHandoff(r));
  }

  addInbox(item: Pick<InboxItem, 'kind' | 'conversationId' | 'refId' | 'title' | 'body'>): void {
    this.run(
      'INSERT INTO inbox_items (id, kind, conversation_id, ref_id, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      randomUUID(), item.kind, item.conversationId, item.refId, item.title, item.body, Date.now(),
    );
  }

  listInbox(): InboxItem[] {
    return this.all('SELECT * FROM inbox_items ORDER BY created_at DESC LIMIT 200').map((r) => ({
      id: String(r.id),
      kind: String(r.kind) as InboxItem['kind'],
      conversationId: s(r.conversation_id),
      refId: s(r.ref_id),
      title: String(r.title),
      body: String(r.body),
      createdAt: n(r.created_at),
      readAt: r.read_at === null ? null : n(r.read_at),
      resolved: n(r.resolved) === 1,
    }));
  }

  markInboxRead(id: string): void {
    this.run('UPDATE inbox_items SET read_at = ? WHERE id = ? AND read_at IS NULL', Date.now(), id);
  }
}
