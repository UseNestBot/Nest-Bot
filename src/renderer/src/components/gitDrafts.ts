import { useEffect, useState } from 'react';
import type { GitDraft } from '@shared/types';
import { api } from '../api';

type Kind = GitDraft['kind'];

/**
 * Drafts agents wrote for the source control panel, kept until the panel
 * picks them up: the agent's turn may finish while the panel is closed.
 */
const drafts = new Map<string, GitDraft>();
/** Hooks showing a draft: told when one arrives or is used. */
const listeners = new Set<(conversationId: string, kind: Kind) => void>();
/** Told only when an agent sends a new draft. */
const arrivals = new Set<(conversationId: string) => void>();

const changed = (conversationId: string, kind: Kind) => {
  for (const l of listeners) l(conversationId, kind);
};

api.onEvent((e) => {
  if (e.type !== 'git-draft') return;
  drafts.set(`${e.conversationId}:${e.draft.kind}`, e.draft);
  changed(e.conversationId, e.draft.kind);
  for (const l of arrivals) l(e.conversationId);
});

/** Called when an agent drafts something for this conversation, e.g. to open its panel. */
export function onGitDraft(conversationId: string, fn: () => void): () => void {
  const l = (id: string) => id === conversationId && fn();
  arrivals.add(l);
  return () => void arrivals.delete(l);
}

/** The latest draft of one kind for a conversation, and a way to mark it used. */
export function useGitDraft<K extends Kind>(conversationId: string | null, kind: K): [Extract<GitDraft, { kind: K }> | null, () => void] {
  const key = `${conversationId}:${kind}`;
  const [draft, setDraft] = useState(() => (conversationId ? drafts.get(key) ?? null : null));
  useEffect(() => {
    if (!conversationId) return;
    setDraft(drafts.get(key) ?? null);
    const l = (id: string, k: Kind) => id === conversationId && k === kind && setDraft(drafts.get(key) ?? null);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, [conversationId, kind, key]);
  const clear = () => {
    drafts.delete(key);
    if (conversationId) changed(conversationId, kind);
  };
  return [draft as Extract<GitDraft, { kind: K }> | null, clear];
}

/** Ask a chat's agent to write a commit message, given which changes it's for. */
export function commitPrompt(staged: boolean): string {
  return [
    `Write a commit message for ${staged ? 'the staged changes' : 'all the uncommitted changes'} in this repository.`,
    `Read the diff yourself (${staged ? 'git diff --staged' : 'git status and git diff'}), and follow the style of recent commits (git log --oneline -10).`,
    'Then call the draft_commit_message tool with it. Don’t commit, and don’t change any files.',
  ].join(' ');
}

/** Ask a chat's agent to write a pull request for the current branch. */
export function pullPrompt(branch: string, base: string): string {
  return [
    `Write a pull request for the branch ${branch} into ${base}.`,
    `Read what it changes (git log ${base}..${branch} and git diff ${base}...${branch}; use origin/${base} if ${base} isn’t a local branch).`,
    'Then call the draft_pull_request tool with a short title and a Markdown description: what changes and why, and how it was tested.',
    'Don’t push, open the pull request, or change any files.',
  ].join(' ');
}
