import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { PROVIDERS, PROVIDER_LABEL, isApiProvider, type Conversation, type ModelOption, type ProviderId, type ProviderStatus } from '@shared/types';
import { api } from '../api';
import { useStore } from '../store';
import { statusLabel } from '../format';
import { MenuItem, MenuLabel, Popover, Segmented, Tooltip, cx, inputClass } from './ui';

const modelCache: Partial<Record<ProviderId, ModelOption[]>> = {};
const DEFAULT_ONLY: ModelOption[] = [{ id: '', label: 'Default', isDefault: true, efforts: [], defaultEffort: null }];

async function loadModels(provider: ProviderId): Promise<ModelOption[] | undefined> {
  if (modelCache[provider]) return modelCache[provider];
  try {
    const list = await api.listModels(provider);
    // A bare "Default" usually means the provider wasn't ready yet; ask again next time.
    if (list.length > 1) modelCache[provider] = list;
    return list;
  } catch {
    return undefined; // provider unavailable; picker shows Default
  }
}

export function useModels(provider: ProviderId): ModelOption[] | undefined {
  const [models, setModels] = useState(modelCache[provider]);
  const load = useCallback(async () => {
    const list = await loadModels(provider);
    if (list) setModels(list);
  }, [provider]);
  useEffect(() => {
    void load();
  }, [load]);
  return models;
}

/** Model lists for several providers, loaded as they are needed. */
function useModelLists(providers: ProviderId[]): Partial<Record<ProviderId, ModelOption[]>> {
  const [lists, setLists] = useState<Partial<Record<ProviderId, ModelOption[]>>>(() => ({ ...modelCache }));
  const key = providers.join(',');
  useEffect(() => {
    let live = true;
    for (const p of key.split(',') as ProviderId[]) {
      void loadModels(p).then((list) => {
        if (live && list) setLists((prev) => ({ ...prev, [p]: list }));
      });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return lists;
}

/** Providers worth offering: ready ones, plus the one already in use. Signed-out or missing ones are set up in Settings. */
export function usableProviders(statuses: Partial<Record<ProviderId, ProviderStatus>>, current?: ProviderId): ProviderId[] {
  return PROVIDERS.filter((p) => p === current || statuses[p]?.state === 'ready' || (!statuses[p] && (p === 'claude' || p === 'codex')));
}

function effortLabel(e: string): string {
  return e === 'xhigh' ? 'Extra high' : e.charAt(0).toUpperCase() + e.slice(1);
}

/** Model + reasoning effort selector shown in the composer bar. */
export function ModelPicker({ conversation, disabled }: { conversation: Conversation; disabled: boolean }) {
  const { state, attempt, navigate } = useStore();
  const providers = usableProviders(state.statuses, conversation.provider);
  const lists = useModelLists(providers);
  const [open, setOpen] = useState<ProviderId>(conversation.provider);
  const [query, setQuery] = useState('');
  const current = lists[conversation.provider]?.find((m) => m.id === (conversation.model ?? ''));
  // "Default (GPT-6-Astra)" reads better as just the model name in the bar.
  const modelName = current ? current.label.replace(/^Default \((.*)\)$/, '$1') : conversation.model ?? 'Default';
  const effectiveEffort = conversation.effort ?? current?.defaultEffort ?? null;

  const patch = (p: { provider?: ProviderId; model?: string | null; effort?: string | null }) => void attempt(() => api.updateConversation(conversation.id, p));

  return (
    <Popover
      side="top"
      align="right"
      width={290}
      trigger={({ open, toggle }) => (
        <Tooltip label={disabled ? 'Wait for the response to finish to change the model' : open ? '' : `${PROVIDER_LABEL[conversation.provider]} model`}>
          <button
            onClick={toggle}
            disabled={disabled}
            className="inline-flex h-9 min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] max-[640px]:max-w-[120px] max-[640px]:gap-1 max-[640px]:px-2 text-ink-2 transition-colors hover:bg-hover hover:text-ink disabled:opacity-55"
          >
            <span className="truncate">{modelName}</span>
            {effectiveEffort && <span className="shrink-0 text-faint max-[640px]:hidden">{effortLabel(effectiveEffort)}</span>}
            <ChevronDown size={13} className={cx('shrink-0 text-faint transition-transform duration-150', open && 'rotate-180')} />
          </button>
        </Tooltip>
      )}
    >
      {(close) => (
        <div className="scroll-quiet max-h-[60vh] overflow-y-auto">
          {providers.map((p) => {
            const status = state.statuses[p];
            const unavailable = status && status.state !== 'ready' && status.state !== 'checking';
            const expanded = open === p;
            const all = lists[p] ?? DEFAULT_ONLY;
            const q = query.trim().toLowerCase();
            const shown = expanded && q ? all.filter((m) => !m.id || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : all;
            return (
              <div key={p}>
                <button
                  onClick={() => {
                    setOpen(expanded ? conversation.provider : p);
                    setQuery('');
                  }}
                  className="flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted hover:text-ink"
                >
                  <ChevronRight size={12} className={cx('shrink-0 transition-transform', expanded && 'rotate-90')} />
                  <span className="truncate">{PROVIDER_LABEL[p]}</span>
                  {isApiProvider(p) && (
                    <Tooltip label="Billed per token to your API key. Chat only.">
                      <span className="rounded border border-line px-1 text-[10px] normal-case tracking-normal text-faint">API</span>
                    </Tooltip>
                  )}
                  {unavailable && <span className="truncate normal-case tracking-normal text-warn-ink"> · {statusLabel(status)}</span>}
                  {conversation.provider === p && !expanded && <span className="ml-auto truncate normal-case tracking-normal text-faint">{modelName}</span>}
                </button>
                {expanded && (
                  <>
                    {all.length > 12 && (
                      <div className="px-2 pb-1">
                        <input
                          autoFocus
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder={`Search ${all.length - 1} models`}
                          className="h-7 w-full rounded-lg border border-line bg-sunken px-2 text-[12.5px] text-ink outline-none placeholder:text-faint focus:border-primary"
                        />
                      </div>
                    )}
                    {shown.slice(0, 200).map((m) => {
                      const active = conversation.provider === p && (conversation.model ?? '') === m.id;
                      return (
                        <MenuItem
                          key={m.id || 'default'}
                          active={active}
                          hint={active ? <Check size={13} /> : undefined}
                          onClick={() => {
                            close();
                            if (!active) patch({ provider: p, model: m.id || null, effort: null });
                          }}
                        >
                          <span className="truncate">{m.label}</span>
                        </MenuItem>
                      );
                    })}
                    {shown.length > 200 && <div className="px-3 py-1 text-[11.5px] text-muted">Type to narrow {shown.length - 200} more…</div>}
                  </>
                )}
              </div>
            );
          })}
          {current && current.efforts.length > 0 && (
            <>
              <div className="my-1 border-t border-line" />
              <MenuLabel>Reasoning effort</MenuLabel>
              <div className="flex flex-wrap gap-1 px-2 pb-1.5">
                {[null, ...current.efforts].map((e) => {
                  const active = (conversation.effort ?? null) === e;
                  return (
                    <button
                      key={e ?? 'default'}
                      onClick={() => patch({ effort: e })}
                      className={cx('rounded-full border px-2.5 py-0.5 text-[12px]', active ? 'border-primary bg-primary text-on-primary' : 'border-line bg-panel text-ink-2 hover:bg-hover')}
                    >
                      {e ? effortLabel(e) : `Default${current.defaultEffort ? ` (${effortLabel(current.defaultEffort)})` : ''}`}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div className="mx-2.5 mb-1 mt-1 border-t border-line pt-1.5 text-[11.5px] leading-snug text-muted">
            Each provider keeps its own native session. Switching provider sends a bounded summary of messages it has not seen.{' '}
            <button
              className="text-ink-2 underline underline-offset-2 hover:text-ink"
              onClick={() => {
                close();
                navigate({ name: 'settings', section: 'providers' });
              }}
            >
              Add providers
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/**
 * Picks the provider an agent runs on. Only providers that are ready (plus the current one) are offered;
 * a short list is a segmented control, a longer one a grouped select.
 */
export function ProviderChoice({ value, onChange }: { value: ProviderId; onChange: (p: ProviderId) => void }) {
  const { state } = useStore();
  const options = usableProviders(state.statuses, value);
  if (options.length <= 3) return <Segmented<ProviderId> value={value} onChange={onChange} options={options.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))} />;
  const group = (api: boolean) =>
    options
      .filter((p) => isApiProvider(p) === api)
      .map((p) => (
        <option key={p} value={p}>
          {PROVIDER_LABEL[p]}
        </option>
      ));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as ProviderId)} className={cx(inputClass, 'w-auto min-w-[180px]')}>
      <optgroup label="On this computer">{group(false)}</optgroup>
      {options.some(isApiProvider) && <optgroup label="API key (billed per token, chat only)">{group(true)}</optgroup>}
    </select>
  );
}
