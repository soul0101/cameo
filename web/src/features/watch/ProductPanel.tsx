import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { ArrowSquareOut, BookmarkSimple, X } from '@phosphor-icons/react';
import type { Placement } from '@/data/types';
import type { SavedItem } from '@/store/saved';
import { mmss } from '@/lib/timecode';
import { cx } from '@/lib/cx';
import { Packshot, Tooltip } from '@/ui';
import { openProduct } from '@/ui/ProductModal';
import { productLabel } from './products';

export type PanelTab = 'scene' | 'all' | 'saved';

interface Props {
  tab: PanelTab;
  onTab: (t: PanelTab) => void;
  live: Placement[];
  /** Placements at the playhead (highlighted in the All tab). */
  current: Placement[];
  /** Every placed product in this audience by start time. */
  all: Placement[];
  saved: SavedItem[];
  /** "View product": the link opens the brand page; this records the view. */
  onView: (p: Placement) => void;
  onToggleSave: (p: Placement) => void;
  onRemove: (item: SavedItem) => void;
  onJump: (p: Placement) => void;
  onClose: () => void;
}

/**
 * Products panel content: header with tabs In this scene · All · Saved (n),
 * one list per tab, and the "About these placements" footer.
 */
export function ProductPanel(p: Props) {
  const liveIds = new Set(p.current.map((x) => x.id));
  const savedIds = new Set(p.saved.map((s) => s.productId));
  const tabs: Array<{ id: PanelTab; label: string; count?: number }> = [
    { id: 'scene', label: 'In this scene' },
    { id: 'all', label: 'All' },
    { id: 'saved', label: 'Saved', count: p.saved.length },
  ];
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    e.stopPropagation();
    const i = tabs.findIndex((t) => t.id === p.tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    p.onTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-text">
      <header className="shrink-0 px-4 pt-3.5">
        <div className="flex h-8 items-center justify-between gap-2">
          <h2 className="text-14 font-semibold">Products</h2>
          <Tooltip content="Close" shortcut="Esc">
            <button
              type="button"
              aria-label="Close products"
              onClick={p.onClose}
              className="-mr-1.5 inline-flex size-8 items-center justify-center rounded-[10px] text-text-2 transition-colors duration-200 ease-cameo hover:bg-surface-3 hover:text-text max-md:size-11"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
        <div role="tablist" aria-label="Products" onKeyDown={onTabKey} className="-mx-1 mt-1.5 flex gap-1 border-b border-border">
          {tabs.map((t) => {
            const on = p.tab === t.id;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`products-tab-${t.id}`}
                aria-selected={on}
                aria-controls={`products-panel-${t.id}`}
                tabIndex={on ? 0 : -1}
                data-autofocus={on || undefined}
                onClick={() => p.onTab(t.id)}
                className={cx(
                  'relative -mb-px inline-flex h-10 items-center gap-1.5 px-2 text-13 font-medium transition-colors duration-200 ease-cameo max-md:h-11',
                  on ? 'text-text' : 'text-text-3 hover:text-text-2',
                )}
              >
                {t.label}
                {t.count != null && t.count > 0 && (
                  <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-surface-3 px-1.5 text-12 leading-none text-text-2 tabular-nums">
                    {t.count}
                  </span>
                )}
                <span aria-hidden className={cx('absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-text transition-opacity duration-200 ease-cameo', on ? 'opacity-100' : 'opacity-0')} />
              </button>
            );
          })}
        </div>
      </header>

      <div role="tabpanel" id={`products-panel-${p.tab}`} aria-labelledby={`products-tab-${p.tab}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
        {p.tab === 'scene' &&
          (p.live.length === 0 ? (
            <Empty title="Nothing placed in this moment" hint="Products appear here while they are on screen. All lists every product in the episode." />
          ) : (
            <ul>
              {p.live.map((pl) => (
                <Row key={pl.id} placement={pl}>
                  <SaveToggle placement={pl} saved={savedIds.has(pl.productId)} onToggle={p.onToggleSave} />
                  <ViewLink placement={pl} onView={p.onView} />
                </Row>
              ))}
            </ul>
          ))}

        {p.tab === 'all' && (
          <ul>
            {p.all.map((pl) => {
              const isLive = liveIds.has(pl.id);
              const l = productLabel(pl);
              return (
                <li key={pl.id} className="group relative flex h-14 items-center rounded-[12px] max-md:h-16">
                  <button
                    type="button"
                    onClick={() => p.onJump(pl)}
                    aria-current={isLive || undefined}
                    aria-label={`${l.full} at ${mmss(pl.tIn)}${isLive ? ', on screen now' : ''}. Play from here`}
                    className={cx(
                      'absolute inset-0 rounded-[12px] transition-colors duration-200 ease-cameo',
                      isLive ? 'bg-surface-3/70' : 'hover:bg-surface-3/50',
                    )}
                  />
                  <span className={cx('mono pointer-events-none relative w-11 shrink-0 pl-2.5 text-12 tabular-nums', isLive ? 'text-text' : 'text-text-3')}>{mmss(pl.tIn)}</span>
                  <span className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3 pl-1">
                    {l.id ? (
                      <button
                        type="button"
                        onClick={() => openProduct(l.id)}
                        aria-label={`View ${l.full}`}
                        title="View product"
                        className="pointer-events-auto shrink-0 rounded-[8px] transition-transform duration-200 ease-cameo hover:scale-105"
                      >
                        <Packshot productId={l.id} size={32} />
                      </button>
                    ) : (
                      <Packshot productId={pl.productId} size={32} />
                    )}
                    <Names brand={l.brand} name={l.name} small />
                  </span>
                  <span className="relative flex shrink-0 items-center pr-1">
                    <SaveToggle placement={pl} saved={savedIds.has(pl.productId)} onToggle={p.onToggleSave} />
                  </span>
                </li>
              );
            })}
          </ul>
        )}

        {p.tab === 'saved' &&
          (p.saved.length === 0 ? (
            <Empty title="Nothing saved yet" hint="Tap the bookmark on a product, or press B while it is on screen, to keep it for later." />
          ) : (
            <>
              <p className="px-2 pt-1 pb-1.5 text-12 text-text-3">Saved for later · kept on this device</p>
              <ul>
                {p.saved.map((item) => {
                  const pl = p.all.find((x) => x.id === item.placementId) ?? p.all.find((x) => x.productId === item.productId);
                  if (!pl) return null;
                  const l = productLabel(pl);
                  return (
                    <Row key={item.productId} placement={pl}>
                      <ViewLink placement={pl} onView={p.onView} />
                      <IconButton label={`Remove ${l.full} from saved`} tip="Remove" onClick={() => p.onRemove(item)}>
                        <X size={16} />
                      </IconButton>
                    </Row>
                  );
                })}
              </ul>
            </>
          ))}
      </div>

      <footer className="shrink-0 border-t border-border px-4 pt-3 pb-4">
        <h3 className="text-12 font-medium text-text-3">About these placements</h3>
        <p className="mt-0.5 text-13 text-text-2">Sponsored and AI-matched to the scene. Shown beside the original picture.</p>
      </footer>
    </div>
  );
}

function Row({ placement, children }: { placement: Placement; children: ReactNode }) {
  const l = productLabel(placement);
  return (
    <li className="flex h-16 items-center gap-3 border-b border-border px-2 last:border-b-0">
      {l.id ? (
        <button
          type="button"
          onClick={() => openProduct(l.id)}
          aria-label={`View ${l.full}`}
          className="-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-[10px] p-1 text-left transition-colors duration-200 ease-cameo hover:bg-surface-3/60"
        >
          <Packshot productId={l.id} size={40} />
          <Names brand={l.brand} name={l.name} />
        </button>
      ) : (
        <>
          <Packshot productId={placement.productId} size={40} />
          <Names brand={l.brand} name={l.name} />
        </>
      )}
      <span className="flex shrink-0 items-center gap-0.5">{children}</span>
    </li>
  );
}

function Names({ brand, name, small }: { brand: string; name: string; small?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-12 leading-4 text-text-2">{brand}</span>
      <span className={cx('block truncate leading-5 font-medium text-text', small ? 'text-13' : 'text-14')}>{name}</span>
    </span>
  );
}

function SaveToggle({ placement, saved, onToggle }: { placement: Placement; saved: boolean; onToggle: (p: Placement) => void }) {
  const name = productLabel(placement).full;
  return (
    <IconButton
      label={saved ? `Saved: ${name}. Remove from saved` : `Save ${name} for later`}
      tip={saved ? 'Saved' : 'Save for later'}
      shortcut="B"
      pressed={saved}
      onClick={() => onToggle(placement)}
      className={saved ? 'text-accent hover:text-accent' : undefined}
    >
      <BookmarkSimple size={18} weight={saved ? 'fill' : 'regular'} />
    </IconButton>
  );
}

function ViewLink({ placement, onView }: { placement: Placement; onView: (p: Placement) => void }) {
  const l = productLabel(placement);
  if (!l.url) return null;
  return (
    <Tooltip content="View product">
      <a
        href={l.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`View ${l.full} on the brand site`}
        onClick={() => onView(placement)}
        className="inline-flex size-8 items-center justify-center rounded-[10px] text-text-2 transition-colors duration-200 ease-cameo hover:bg-surface-3 hover:text-accent max-md:size-11"
      >
        <ArrowSquareOut size={18} />
      </a>
    </Tooltip>
  );
}

function IconButton({
  label,
  tip,
  shortcut,
  pressed,
  onClick,
  className,
  children,
}: {
  label: string;
  tip: string;
  shortcut?: string;
  pressed?: boolean;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip content={tip} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
        className={cx(
          'inline-flex size-8 items-center justify-center rounded-[10px] text-text-2 transition-[background-color,color,transform] duration-200 ease-cameo hover:bg-surface-3 hover:text-text active:scale-95 max-md:size-11',
          className,
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <p className="text-14 font-medium text-text">{title}</p>
      <p className="mt-1 max-w-[260px] text-13 text-text-3">{hint}</p>
    </div>
  );
}
