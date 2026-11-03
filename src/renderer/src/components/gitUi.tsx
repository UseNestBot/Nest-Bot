import type { GitChange } from '@shared/types';
import { cx } from './ui';

/** One letter per kind of change, as git status shows them. */
export const LETTER: Record<GitChange, string> = { modified: 'M', typechange: 'T', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflicted: '!' };
export const TONE: Record<GitChange, string> = { modified: 'text-warn', typechange: 'text-warn', added: 'text-ok', untracked: 'text-ok', deleted: 'text-bad', renamed: 'text-accent', copied: 'text-accent', conflicted: 'text-bad' };

export function DiffText({ text }: { text: string }) {
  // Skip the header lines; the dialog title already names the file.
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('@@'));
  return (
    <pre className="overflow-x-auto rounded-xl bg-sunken py-2 font-mono text-[12px] leading-[1.55]">
      {(start >= 0 ? lines.slice(start) : lines).map((line, i) => (
        <div
          key={i}
          className={cx(
            'whitespace-pre px-3',
            line.startsWith('+') && 'bg-ok/15 text-ink',
            line.startsWith('-') && 'bg-bad/15 text-ink',
            line.startsWith('@@') && 'mt-1 text-accent first:mt-0',
            line.startsWith('\\') && 'text-faint',
            !/^[-+@\\]/.test(line) && 'text-ink-2',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}
