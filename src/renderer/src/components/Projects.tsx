import { useState, type DragEvent } from 'react';
import type { AvatarSpec } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { Avatar, AvatarStack, cheerAgents } from './Avatar';
import { Button, Field, Modal, cx, inputClass } from './ui';

/**
 * Drag payloads. A chat row carries its chat, which moves just that chat into a
 * project. An agent (pinned avatar, member card) carries the agent, which puts
 * it in the project's folder and team.
 */
const AGENT_DRAG = 'application/x-nest-agent';
const CHAT_DRAG = 'application/x-nest-chat';

export type Dragged = { kind: 'agent' | 'chat'; id: string };

export function dragAgent(e: DragEvent, agentId: string): void {
  e.dataTransfer.setData(AGENT_DRAG, agentId);
  e.dataTransfer.effectAllowed = 'move';
}

export function dragChat(e: DragEvent, conversationId: string): void {
  e.dataTransfer.setData(CHAT_DRAG, conversationId);
  e.dataTransfer.effectAllowed = 'move';
}

/** Whether a drag carries a chat. Readable during dragover, unlike its id. */
export function isChatDrag(data: DataTransfer): boolean {
  return data.types.includes(CHAT_DRAG);
}

function isNestDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(AGENT_DRAG) || e.dataTransfer.types.includes(CHAT_DRAG);
}

/** What is being dragged. Only readable in dragstart and drop. */
export function dragged(e: DragEvent): Dragged | null {
  const chat = e.dataTransfer.getData(CHAT_DRAG);
  if (chat) return { kind: 'chat', id: chat };
  const agent = e.dataTransfer.getData(AGENT_DRAG);
  return agent ? { kind: 'agent', id: agent } : null;
}

type Ctx = Pick<ReturnType<typeof useStore>, 'state' | 'attempt' | 'toast'>;

/**
 * Drop-target props for anything that accepts chats and agents. `projectId`
 * null means "no project". Returns the props plus whether something hovers over it.
 */
export function useProjectDrop(projectId: string | null) {
  const ctx = useStore();
  const [over, setOver] = useState(false);
  const props = {
    onDragOver: (e: DragEvent) => {
      if (!isNestDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!over) setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      setOver(false);
      const what = dragged(e);
      if (!what) return;
      e.preventDefault();
      void (what.kind === 'chat' ? moveChat(what.id, projectId, ctx) : moveAgent(what.id, projectId, ctx));
    },
  };
  return { over, props };
}

const projectName = (state: Ctx['state'], id: string | null) => state.projects.find((p) => p.id === id)?.name;

/** Put an agent in a project (or none) and say so. Its chats stay where they are. Joining a project gets a cheer from everyone else. */
export async function moveAgent(agentId: string, projectId: string | null, { state, attempt, toast }: Ctx): Promise<void> {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent || agent.projectId === projectId) return;
  const moved = await attempt(() => api.setAgentProject(agentId, projectId));
  if (!moved) return;
  const name = projectName(state, projectId);
  // Everyone already in the project cheers the newcomer.
  if (name) cheerAgents(agentId);
  toast(name ? `${agent.name} joined ${name}.` : `${agent.name} left ${projectName(state, agent.projectId) ?? 'its project'}.`, 'info');
}

/** Move one chat into a project (or out with null). The agent stays in its own project. */
export async function moveChat(conversationId: string, projectId: string | null, { state, attempt, toast }: Ctx): Promise<void> {
  const chat = state.conversations.find((c) => c.id === conversationId);
  if (!chat || chat.projectId === projectId) return;
  const moved = await attempt(() => api.updateConversation(conversationId, { projectId }));
  if (!moved) return;
  const name = projectName(state, projectId);
  if (name) cheerAgents(chat.agentId);
  toast(name ? `Moved “${chat.title}” to ${name}.` : `Took “${chat.title}” out of ${projectName(state, chat.projectId) ?? 'its project'}.`, 'info');
}

/**
 * How a project looks: its members' avatars, like any other row in Nest. An
 * empty project is a dashed outline until agents join it.
 */
export function ProjectMark({ members, ids = [], size = 44 }: { members: AvatarSpec[]; ids?: string[]; size?: number }) {
  const box = { width: size, height: size };
  if (members.length === 1) {
    return (
      <span className="flex shrink-0 items-center justify-center" style={box}>
        <Avatar spec={members[0]} size={Math.round(size * 0.72)} agentId={ids[0]} />
      </span>
    );
  }
  if (members.length === 2) {
    // Two avatars on a diagonal so the pair fills the square like the three-up stack does.
    const s = Math.round(size * 0.56);
    return (
      <span className="relative shrink-0" style={box}>
        <span className="absolute left-0 top-0">
          <Avatar spec={members[0]} size={s} agentId={ids[0]} />
        </span>
        <span className="absolute bottom-0 right-0">
          <Avatar spec={members[1]} size={s} agentId={ids[1]} />
        </span>
      </span>
    );
  }
  if (members.length > 2) {
    return (
      <span className="flex shrink-0 items-center justify-center" style={box}>
        <AvatarStack specs={members} ids={ids} size={Math.round(size / 1.9)} />
      </span>
    );
  }
  return <span className="shrink-0 rounded-full border-[1.5px] border-dashed border-line-strong" style={{ width: size * 0.82, height: size * 0.82, margin: size * 0.09 }} />;
}

/** Create a project, optionally moving a chat into it. */
export function NewProjectDialog({ onClose, withChat }: { onClose: () => void; withChat?: string }) {
  const { state, attempt, navigate, reloadProjects, reloadAgents } = useStore();
  const [name, setName] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const chat = withChat ? state.conversations.find((c) => c.id === withChat) : undefined;

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const project = await attempt(() => api.createProject({ name: name.trim(), brief, workspace: null, color: '#3b82f6' }));
    if (project && chat) await attempt(() => api.updateConversation(chat.id, { projectId: project.id }));
    setBusy(false);
    if (!project) return;
    await Promise.all([reloadProjects(), reloadAgents()]);
    onClose();
    navigate({ name: 'project', id: project.id });
  };

  return (
    <Modal
      title="New project"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={!name.trim() || busy}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="Project name"
            aria-label="Project name"
            autoFocus
            className="w-full bg-transparent font-display text-[19px] font-semibold outline-none placeholder:text-faint"
          />
        <Field label="Brief" hint="Every agent in the project gets this as background: the goal, constraints, where things stand.">
          <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} placeholder="Launch the new pricing page by Friday. Copy lives in pricing.md; the designer owns visuals." className={cx(inputClass, 'resize-y')} />
        </Field>
        <p className="text-[12.5px] text-muted">
          {chat ? `“${chat.title}” moves into it. ` : ''}Members share a working folder, project memory, and can hand work to each other.
        </p>
      </div>
    </Modal>
  );
}
