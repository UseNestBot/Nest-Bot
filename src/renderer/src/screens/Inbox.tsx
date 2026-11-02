import { CircleAlert, Inbox as InboxIcon, Send, ShieldCheck } from 'lucide-react';
import type { InboxItem } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { relativeTime } from '../format';
import { EmptyState, ScreenHeader, cx } from '../components/ui';

const ICON = { approval: ShieldCheck, handoff: Send, failure: CircleAlert } as const;

export function InboxScreen() {
  const { state, openConversation, reloadInbox } = useStore();
  const needsAction = state.inbox.filter((i) => i.kind === 'approval' && !i.resolved);
  const rest = state.inbox.filter((i) => i.kind !== 'approval');

  const open = async (item: InboxItem) => {
    if (!item.readAt) {
      await api.markInboxRead(item.id);
      await reloadInbox();
    }
    if (item.conversationId) await openConversation(item.conversationId);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <ScreenHeader title="Inbox" subtitle="Approvals waiting on you, finished handoffs and failed runs" />
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] px-6 py-6 max-[640px]:px-4 max-[640px]:py-4">
          {needsAction.length === 0 && rest.length === 0 && <EmptyState icon={<InboxIcon size={28} />} title="Nothing here">Approvals, handoff results and failures will show up here.</EmptyState>}
          {needsAction.length > 0 && (
            <List title="Needs your approval">
              {needsAction.map((i) => (
                <Row key={i.id} item={i} onOpen={open} />
              ))}
            </List>
          )}
          {rest.length > 0 && (
            <List title="Recent">
              {rest.map((i) => (
                <Row key={i.id} item={i} onOpen={open} />
              ))}
            </List>
          )}
        </div>
      </div>
    </div>
  );
}

function List({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[13px] font-semibold text-ink-2">{title}</h2>
      <div className="divide-y divide-line rounded-2xl border border-line bg-panel">{children}</div>
    </section>
  );
}

function Row({ item, onOpen }: { item: InboxItem; onOpen: (i: InboxItem) => void }) {
  const Icon = ICON[item.kind];
  const unread = item.kind === 'approval' ? !item.resolved : !item.readAt;
  return (
    <button onClick={() => onOpen(item)} className="flex w-full items-start gap-3 px-3.5 py-3 text-left transition-colors hover:bg-hover">
      <Icon size={16} className={cx('mt-0.5 shrink-0', item.kind === 'failure' ? 'text-bad' : 'text-muted')} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cx('min-w-0 flex-1 truncate text-[13.5px]', unread ? 'font-semibold text-ink' : 'text-ink-2')}>{item.title}</span>
          <span className="shrink-0 text-[11.5px] text-faint">{relativeTime(item.createdAt)}</span>
        </span>
        <span className="mt-0.5 line-clamp-3 block whitespace-pre-wrap text-[12.5px] text-muted">{item.body}</span>
      </span>
    </button>
  );
}
