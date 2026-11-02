import { useEffect } from 'react';
import { Plus } from 'lucide-react';
import { PROVIDER_LABEL } from '@shared/types';
import { useStore } from './store';
import { Sidebar } from './components/Sidebar';
import { ConversationView } from './components/Conversation';
import { Avatar } from './components/Avatar';
import { cx } from './components/ui';
import { AgentLibrary } from './screens/AgentLibrary';
import { NewAgentScreen } from './screens/NewAgent';
import { MemoryScreen } from './screens/Memory';
import { InboxScreen } from './screens/Inbox';
import { ProjectScreen } from './screens/Project';
import { SettingsScreen } from './screens/Settings';
import { PHONE_QUERY, useMediaQuery } from './components/MobileBack';

export function App() {
  const { state, navigate, openConversation, startConversation } = useStore();
  const { view } = state;

  // Keyboard shortcuts (listed in Settings → Keyboard shortcuts).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === ',') {
        e.preventDefault();
        navigate({ name: 'settings' });
      } else if (e.key.toLowerCase() === 'n' && !e.shiftKey) {
        e.preventDefault();
        const current = view.name === 'conversation' ? state.details[view.id]?.conversation : undefined;
        const agentId = current?.agentId ?? state.agents.find((a) => a.pinned)?.id ?? state.agents[0]?.id;
        if (agentId) void startConversation(agentId);
      } else if (e.key.toLowerCase() === 'n' && e.shiftKey) {
        e.preventDefault();
        navigate({ name: 'library', agentId: 'new' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, state.details, state.agents, navigate, startConversation]);

  // If the open conversation disappears (deleted elsewhere), fall back to home.
  const detail = view.name === 'conversation' ? state.details[view.id] : undefined;
  useEffect(() => {
    if (view.name === 'conversation' && !detail) void openConversation(view.id).catch(() => navigate({ name: 'home' }));
  }, [view, detail, openConversation, navigate]);

  // On a phone the sidebar is the home screen (the chat list) and every other view takes the whole screen.
  const phone = useMediaQuery(PHONE_QUERY);
  const showList = !phone || view.name === 'home';
  const showMain = !phone || view.name !== 'home';

  return (
    <div className="flex h-full">
      {showList && <Sidebar />}
      {showMain && (
      <main className="flex min-w-0 flex-1 flex-col bg-canvas">
        {view.name === 'conversation' && detail ? (
          <ConversationView detail={detail} />
        ) : view.name === 'library' && view.agentId === 'new' ? (
          <NewAgentScreen key={view.projectId ?? 'none'} projectId={view.projectId} />
        ) : view.name === 'project' ? (
          <ProjectScreen id={view.id} />
        ) : view.name === 'library' ? (
          <AgentLibrary selected={view.agentId} />
        ) : view.name === 'memory' ? (
          <MemoryScreen />
        ) : view.name === 'inbox' ? (
          <InboxScreen />
        ) : view.name === 'settings' ? (
          <SettingsScreen section={view.section ?? 'general'} />
        ) : (
          <Home />
        )}
      </main>
      )}
      {state.toast && (
        <div
          role="status"
          className={cx(
            'fixed bottom-5 right-5 z-50 max-w-sm rounded-2xl border px-4 py-3 text-[13px] shadow-pop max-[640px]:inset-x-4 max-[640px]:bottom-auto max-[640px]:top-[calc(env(safe-area-inset-top)+12px)] max-[640px]:max-w-none',
            state.toast.tone === 'error' ? 'border-bad-line bg-bad-bg text-bad-ink' : 'border-line bg-panel text-ink',
          )}
        >
          {state.toast.text}
        </div>
      )}
    </div>
  );
}

function Home() {
  const { state, navigate, startConversation } = useStore();
  if (!state.ready) return null;
  if (state.agents.length === 0) return <NewAgentScreen />;
  return (
    <div className="scroll-quiet relative flex flex-1 flex-col items-center overflow-y-auto px-6 pb-12 pt-[12vh]">
      {/* No header here, so the top strip is the window's drag handle. */}
      <div className="app-drag absolute inset-x-0 top-0 h-14" />
      <h1 className="font-display text-[22px] font-semibold tracking-[-0.01em]">Start a chat</h1>
      <p className="mt-1.5 max-w-md text-center text-[13.5px] text-muted">Pick an agent. Each one runs on Codex or Claude Code with your own subscription.</p>
      <div className="mt-8 grid w-full max-w-[720px] grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
        {state.agents.map((a) => (
          <button
            key={a.id}
            onClick={() => void startConversation(a.id)}
            className="flex flex-col items-center gap-2 rounded-[20px] border border-line bg-panel px-3 pb-4 pt-5 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-float"
          >
            <Avatar spec={a.avatar} size={56} />
            <span className="w-full truncate text-center text-[14px] font-semibold">{a.name}</span>
            <span className="-mt-1.5 text-[12px] text-muted">{PROVIDER_LABEL[a.provider]}</span>
          </button>
        ))}
        <button
          onClick={() => navigate({ name: 'library', agentId: 'new' })}
          className="flex flex-col items-center justify-center gap-2 rounded-[20px] border border-dashed border-line-strong px-3 pb-4 pt-5 text-muted transition-colors hover:bg-hover hover:text-ink"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-hover">
            <Plus size={22} strokeWidth={1.8} />
          </span>
          <span className="text-[14px] font-medium">New agent</span>
        </button>
      </div>
    </div>
  );
}
