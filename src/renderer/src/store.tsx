import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type Agent, type AppSettings, type Conversation, type ConversationDetail, type InboxItem, type NestEvent, type Project, type ProviderId, type ProviderStatus, type Run } from '@shared/types';
import { IS_REMOTE, api } from './api';
import { RESYNC_EVENT } from './web/client';

export type View =
  | { name: 'conversation'; id: string }
  | { name: 'home' }
  /** projectId with agentId 'new': the new agent joins that project. */
  | { name: 'library'; agentId?: string | 'new'; projectId?: string }
  | { name: 'project'; id: string }
  | { name: 'memory' }
  | { name: 'inbox' }
  | { name: 'settings'; section?: SettingsSection };

/** A one-shot avatar reaction: a perk when the agent starts something, a hop when it finishes, a wobble when it fails. */
export interface Reaction {
  kind: 'perk' | 'done' | 'failed';
  at: number;
}

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'agents'
  | 'connectors'
  | 'conversations'
  | 'voice'
  | 'providers'
  | 'permissions'
  | 'memory'
  | 'remote'
  | 'device'
  | 'data'
  | 'shortcuts'
  | 'about';

interface State {
  ready: boolean;
  view: View;
  agents: Agent[];
  projects: Project[];
  conversations: Conversation[];
  statuses: Partial<Record<ProviderId, ProviderStatus>>;
  inbox: InboxItem[];
  settings: AppSettings;
  details: Record<string, ConversationDetail>;
  /** Conversations with a run in progress, tracked for every chat (not just the loaded ones) so the sidebar can show it. */
  running: Record<string, true>;
  /** Latest avatar reaction per conversation. */
  reactions: Record<string, Reaction>;
  toast: { id: number; text: string; tone: 'error' | 'info' } | null;
}

type Action =
  | { type: 'init'; agents: Agent[]; projects: Project[]; conversations: Conversation[]; statuses: ProviderStatus[]; inbox: InboxItem[]; settings: AppSettings }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'settings-patch'; patch: Partial<AppSettings> }
  | { type: 'view'; view: View }
  | { type: 'agents'; agents: Agent[] }
  | { type: 'projects'; projects: Project[] }
  | { type: 'conversations'; conversations: Conversation[] }
  | { type: 'inbox'; inbox: InboxItem[] }
  | { type: 'detail'; detail: ConversationDetail }
  | { type: 'drop-conversation'; id: string }
  | { type: 'event'; event: NestEvent }
  | { type: 'toast'; text: string; tone: 'error' | 'info' }
  | { type: 'clear-toast'; id: number };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

function trackRun(state: State, run: Run): State {
  const id = run.conversationId;
  const was = Boolean(state.running[id]);
  const is = run.status === 'running';
  if (was === is) return state;
  const running = { ...state.running };
  if (is) running[id] = true;
  else delete running[id];
  const next = { ...state, running };
  if (is) return next;
  // Interrupted runs were stopped on purpose: no reaction.
  return run.status === 'completed' ? react(next, id, 'done') : run.status === 'failed' ? react(next, id, 'failed') : next;
}

function react(state: State, conversationId: string, kind: Reaction['kind']): State {
  const now = Date.now();
  const prev = state.reactions[conversationId];
  // Perks are throttled so a burst of tool calls reads as one nudge, and never cut off a hop or wobble.
  if (kind === 'perk' && prev && now - prev.at < (prev.kind === 'perk' ? 600 : 900)) return state;
  return { ...state, reactions: { ...state.reactions, [conversationId]: { kind, at: now } } };
}

function applyEvent(state: State, event: NestEvent): State {
  switch (event.type) {
    case 'provider-status':
      return { ...state, statuses: { ...state.statuses, [event.status.provider]: event.status } };
    case 'conversation': {
      const conversations = upsert(state.conversations, event.conversation).sort((a, b) => b.updatedAt - a.updatedAt);
      const d = state.details[event.conversation.id];
      return { ...state, conversations, details: d ? { ...state.details, [d.conversation.id]: { ...d, conversation: event.conversation } } : state.details };
    }
    case 'message': {
      const d = state.details[event.message.conversationId];
      if (!d) return state;
      return { ...state, details: { ...state.details, [d.conversation.id]: { ...d, messages: upsert(d.messages, event.message) } } };
    }
    case 'activity': {
      // A newly started step makes the agent perk up; repeat updates to the same step don't.
      if (event.activity.createdAt === event.activity.updatedAt && event.activity.status === 'running') state = react(state, event.conversationId, 'perk');
      const d = state.details[event.conversationId];
      if (!d) return state;
      const i = d.activities.findIndex((a) => a.id === event.activity.id && a.runId === event.activity.runId);
      const activities = d.activities.slice();
      if (i === -1) activities.push(event.activity);
      else activities[i] = event.activity;
      return { ...state, details: { ...state.details, [d.conversation.id]: { ...d, activities } } };
    }
    case 'run': {
      state = trackRun(state, event.run);
      const d = state.details[event.run.conversationId];
      if (!d) return state;
      return { ...state, details: { ...state.details, [d.conversation.id]: { ...d, runs: upsert(d.runs, event.run) } } };
    }
    case 'approval': {
      const d = state.details[event.approval.conversationId];
      if (!d) return state;
      return { ...state, details: { ...state.details, [d.conversation.id]: { ...d, approvals: upsert(d.approvals, event.approval) } } };
    }
    default:
      return state;
  }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'init':
      return {
        ...state,
        ready: true,
        agents: action.agents,
        projects: action.projects,
        conversations: action.conversations,
        inbox: action.inbox,
        settings: action.settings,
        statuses: Object.fromEntries(action.statuses.map((s) => [s.provider, s])),
      };
    case 'view':
      return { ...state, view: action.view };
    case 'agents':
      return { ...state, agents: action.agents };
    case 'projects':
      return { ...state, projects: action.projects };
    case 'conversations':
      return { ...state, conversations: action.conversations };
    case 'inbox':
      return { ...state, inbox: action.inbox };
    case 'settings':
      return { ...state, settings: action.settings };
    case 'settings-patch':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'detail': {
      // Loading a chat also syncs its running flag, which covers a renderer reload mid-run.
      const id = action.detail.conversation.id;
      const busy = action.detail.runs.some((r) => r.status === 'running');
      let running = state.running;
      if (busy !== Boolean(running[id])) {
        running = { ...running };
        if (busy) running[id] = true;
        else delete running[id];
      }
      return { ...state, running, details: { ...state.details, [id]: action.detail } };
    }
    case 'drop-conversation': {
      const details = { ...state.details };
      delete details[action.id];
      const running = { ...state.running };
      delete running[action.id];
      return { ...state, details, running, conversations: state.conversations.filter((c) => c.id !== action.id) };
    }
    case 'event':
      return applyEvent(state, action.event);
    case 'toast':
      return { ...state, toast: { id: Date.now(), text: action.text, tone: action.tone } };
    case 'clear-toast':
      return state.toast?.id === action.id ? { ...state, toast: null } : state;
  }
}

const initial: State = { ready: false, view: { name: 'home' }, agents: [], projects: [], conversations: [], statuses: {}, inbox: [], settings: DEFAULT_SETTINGS, details: {}, running: {}, reactions: {}, toast: null };

interface StoreValue {
  state: State;
  navigate: (view: View) => void;
  openConversation: (id: string) => Promise<void>;
  /** projectId: the project the chat works on; omitted or null = none. */
  startConversation: (agentId: string, projectId?: string | null) => Promise<void>;
  reloadAgents: () => Promise<void>;
  reloadProjects: () => Promise<void>;
  reloadInbox: () => Promise<void>;
  removeConversation: (id: string) => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  toast: (text: string, tone?: 'error' | 'info') => void;
  /** Run an API call and surface its error as a toast instead of throwing. */
  attempt: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);

  const toast = useCallback((text: string, tone: 'error' | 'info' = 'error') => dispatch({ type: 'toast', text, tone }), []);
  const attempt = useCallback(
    async <T,>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        toast((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
        return undefined;
      }
    },
    [toast],
  );

  const reloadInbox = useCallback(async () => dispatch({ type: 'inbox', inbox: await api.listInbox() }), []);
  const reloadAgents = useCallback(async () => dispatch({ type: 'agents', agents: await api.listAgents() }), []);
  const reloadProjects = useCallback(async () => dispatch({ type: 'projects', projects: await api.listProjects() }), []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [agents, projects, conversations, statuses, inbox, settings] = await Promise.all([api.listAgents(), api.listProjects(), api.listConversations(), api.getProviderStatuses(), api.listInbox(), api.getSettings()]);
      if (!alive) return;
      dispatch({ type: 'init', agents, projects, conversations, statuses, inbox, settings });
      const last = (() => {
        try {
          return localStorage.getItem('nest:last-conversation');
        } catch {
          return null;
        }
      })();
      // A tapped notification opens /?c=<id>. Otherwise the phone starts on the chat list.
      const fromLink = new URLSearchParams(location.search).get('c');
      if (fromLink) history.replaceState(null, '', location.pathname);
      const target = fromLink ? conversations.find((c) => c.id === fromLink) : IS_REMOTE ? undefined : (conversations.find((c) => c.id === last) ?? conversations[0]);
      if (target) {
        const detail = await api.getConversation(target.id);
        if (detail && alive) {
          dispatch({ type: 'detail', detail });
          dispatch({ type: 'view', view: { name: 'conversation', id: target.id } });
        }
      }
    })();
    const off = api.onEvent((event) => {
      dispatch({ type: 'event', event });
      if (event.type === 'open-conversation') openRef.current?.(event.conversationId);
      if (event.type === 'conversation-deleted') dispatch({ type: 'drop-conversation', id: event.conversationId });
      if (event.type === 'inbox-changed' || event.type === 'handoff') void api.listInbox().then((inbox) => dispatch({ type: 'inbox', inbox }));
      if (event.type === 'agents-changed') void api.listAgents().then((agents) => dispatch({ type: 'agents', agents }));
      if (event.type === 'projects-changed') void api.listProjects().then((projects) => dispatch({ type: 'projects', projects }));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // The phone's event stream reconnected: fetch again whatever changed while it was away.
  const viewRef = useRef(state.view);
  viewRef.current = state.view;
  useEffect(() => {
    const resync = () => {
      void Promise.all([api.listAgents(), api.listProjects(), api.listConversations(), api.listInbox()])
        .then(([agents, projects, conversations, inbox]) => {
          dispatch({ type: 'agents', agents });
          dispatch({ type: 'projects', projects });
          dispatch({ type: 'conversations', conversations });
          dispatch({ type: 'inbox', inbox });
        })
        .catch(() => {});
      const view = viewRef.current;
      if (view.name === 'conversation') void api.getConversation(view.id).then((detail) => detail && dispatch({ type: 'detail', detail })).catch(() => {});
    };
    window.addEventListener(RESYNC_EVENT, resync);
    return () => window.removeEventListener(RESYNC_EVENT, resync);
  }, []);

  // Appearance: styles.css keys the palette, zoom, spacing and column width off these attributes.
  const { theme, darkStyle, accentColor, uiScale, density, chatWidth, uiFont, codeFont, reduceMotion } = state.settings;
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      root.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };
    apply();
    root.dataset.darkStyle = darkStyle;
    root.dataset.accent = accentColor;
    root.dataset.density = density;
    root.dataset.chatWidth = chatWidth;
    root.toggleAttribute('data-reduce-motion', reduceMotion);
    root.style.setProperty('--nest-zoom', String(uiScale / 100));
    root.style.setProperty('--chat-width', chatWidth === 'narrow' ? '680px' : chatWidth === 'wide' ? '920px' : '760px');
    // Chosen fonts go first; the built-in stack stays behind them for anything not installed.
    const font = (prop: string, value: string) => (value ? root.style.setProperty(prop, `${value},`) : root.style.removeProperty(prop));
    font('--nest-font-ui', uiFont);
    font('--nest-font-code', codeFont);
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, darkStyle, accentColor, uiScale, density, chatWidth, uiFont, codeFont, reduceMotion]);

  useEffect(() => {
    if (!state.toast) return;
    const id = state.toast.id;
    const t = setTimeout(() => dispatch({ type: 'clear-toast', id }), state.toast.tone === 'error' ? 9000 : 4000);
    return () => clearTimeout(t);
  }, [state.toast]);

  const openRef = useRef<((id: string) => Promise<void>) | null>(null);
  const openConversation = useCallback(
    async (id: string) => {
      const detail = await attempt(() => api.getConversation(id));
      if (!detail) return;
      dispatch({ type: 'detail', detail });
      dispatch({ type: 'view', view: { name: 'conversation', id } });
      try {
        localStorage.setItem('nest:last-conversation', id);
      } catch {
        /* storage unavailable */
      }
    },
    [attempt],
  );

  openRef.current = openConversation;

  // Settings change on screen straight away; the saved copy replaces them once the last
  // pending save returns (an older reply would briefly undo a newer change).
  const settingsSeq = useRef(0);
  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const seq = ++settingsSeq.current;
      dispatch({ type: 'settings-patch', patch });
      const next = await attempt(() => api.updateSettings(patch));
      if (seq !== settingsSeq.current) return;
      if (next) dispatch({ type: 'settings', settings: next });
      else void api.getSettings().then((settings) => seq === settingsSeq.current && dispatch({ type: 'settings', settings })).catch(() => {});
    },
    [attempt],
  );

  const startConversation = useCallback(
    async (agentId: string, projectId?: string | null) => {
      const conversation = await attempt(() => api.createConversation(agentId, projectId));
      if (!conversation) return;
      dispatch({ type: 'event', event: { type: 'conversation', conversation } });
      await openConversation(conversation.id);
    },
    [attempt, openConversation],
  );

  const value = useMemo<StoreValue>(
    () => ({
      state,
      navigate: (view) => dispatch({ type: 'view', view }),
      openConversation,
      startConversation,
      reloadAgents,
      reloadProjects,
      reloadInbox,
      removeConversation: (id) => dispatch({ type: 'drop-conversation', id }),
      updateSettings,
      toast,
      attempt,
    }),
    [state, openConversation, startConversation, reloadAgents, reloadProjects, reloadInbox, updateSettings, toast, attempt],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore outside provider');
  return ctx;
}
