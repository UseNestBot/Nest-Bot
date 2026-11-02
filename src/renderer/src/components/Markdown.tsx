import { createContext, isValidElement, memo, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { api } from '../api';
import { Tooltip } from './ui';
import { ChartBlock } from './Chart';

const StreamingContext = createContext(false);

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = extractText(children);
  return (
    <div className="group relative">
      <pre>{children}</pre>
      <Tooltip label={copied ? 'Copied' : 'Copy code'} align="end">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
          className="absolute right-2 top-2 rounded-md border border-line bg-panel/90 p-1 text-muted opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
          aria-label="Copy code"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </Tooltip>
    </div>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (node && typeof node === 'object' && 'props' in node) return extractText((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

// Raw HTML in model output is never rendered (react-markdown escapes it without rehype-raw).
// Links open in the system browser through the main process, which only accepts http(s).
// Remote images are shown as links so model output cannot make network requests.
const components: Components = {
  a: ({ href, children }) => (
    <Tooltip label={href}>
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (href && /^https?:\/\//i.test(href)) void api.openExternal(href);
        }}
      >
        {children}
      </a>
    </Tooltip>
  ),
  img: ({ src, alt }) =>
    typeof src === 'string' && /^https?:\/\//i.test(src) ? (
      <a
        href={src}
        onClick={(e) => {
          e.preventDefault();
          void api.openExternal(src);
        }}
      >
        [image: {alt || src}]
      </a>
    ) : (
      <span>[image: {alt || 'unavailable'}]</span>
    ),
  pre: ({ children }) => {
    // ```chart blocks are chart specs from the agent, drawn as cards instead of code.
    const code = Array.isArray(children) ? children[0] : children;
    if (isValidElement<{ className?: string; children?: ReactNode }>(code) && /(^|\s)language-chart(\s|$)/.test(code.props.className ?? '')) {
      return <Chart source={extractText(code.props.children)} />;
    }
    return <CodeBlock>{children}</CodeBlock>;
  },
};

function Chart({ source }: { source: string }) {
  return <ChartBlock source={source} streaming={useContext(StreamingContext)} />;
}

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className="md">
      <StreamingContext value={streaming}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml>
          {text}
        </ReactMarkdown>
      </StreamingContext>
    </div>
  );
});
