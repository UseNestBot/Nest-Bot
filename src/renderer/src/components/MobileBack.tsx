import { useEffect, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useStore } from '../store';

/** Phone width: the sidebar becomes its own screen (the chat list) instead of a column. */
export const PHONE_QUERY = '(max-width: 640px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Back to the chat list (or `onBack`), first thing in a screen's header. Only shown at phone width. */
export function MobileBack({ onBack, label = 'Back to chats' }: { onBack?: () => void; label?: string }) {
  const { navigate } = useStore();
  return (
    <button
      onClick={onBack ?? (() => navigate({ name: 'home' }))}
      aria-label={label}
      className="-ml-2 mr-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-2 active:bg-hover max-[640px]:inline-flex"
    >
      <ChevronLeft size={22} strokeWidth={2} />
    </button>
  );
}
