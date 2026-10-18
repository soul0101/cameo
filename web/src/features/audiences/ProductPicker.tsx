import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowCounterClockwise, Check, MagnifyingGlass, Prohibit } from '@phosphor-icons/react';
import { indexOf, useCatalog } from '@/data/catalog';
import type { CatalogProduct } from '@/data/catalog';
import { suggestedProducts } from '@/features/scenes/model';
import { useIsMobile } from '@/lib/hooks';
import { cx } from '@/lib/cx';
import { EASE } from '@/lib/motion';
import { resolveWith, usePlacements } from '@/store/placements';
import { useProject } from '@/store/project';
import type { AudienceId } from '@/store/project';
import { Input, Packshot, Popover, Sheet, toast } from '@/ui';

/** What the picker writes: the box's default, or one audience's override. */
export type PickerTarget = { kind: 'default' } | { kind: 'audience'; audienceId: AudienceId };

export interface ProductPickerProps {
  open: boolean;
  onClose: () => void;
  /** What was clicked: the popover anchors here and focus returns here. */
  anchor: RefObject<HTMLElement | null>;
  boxId: string;
  target: PickerTarget;
  /** After a pick was written (product id, 'none', or null = back to the default). */
  onPick?: (value: string | 'none' | null) => void;
  /**
   * Preferred side of the anchor (desktop). 'left' keeps the row it was opened from visible (the
   * Scenes panel); Popover falls back to the opposite side, then below, when there is no room.
   */
  side?: 'left' | 'bottom';
  /** Where focus returns on close, when the anchor is not itself focusable (default: the anchor). */
  returnFocus?: RefObject<HTMLElement | null>;
}

type Option =
  | { key: string; kind: 'inherit'; label: ReactNode; product: CatalogProduct | null }
  | { key: string; kind: 'product'; product: CatalogProduct; group: 'suggested' | 'all' }
  | { key: string; kind: 'none'; label: string };

/**
 * Product picker: anchored, 360 wide, max 440 tall, nonmodal
 * (the video stays visible); a bottom sheet on mobile. Header "Box 1 · Cup on the table" over the
 * target. Search (autofocus). For an audience: "Use default · …" first, then Suggested (≤3), then
 * everything available there, then "Nothing in <audience>". Listbox semantics with
 * aria-activedescendant: ↑/↓ move, Enter picks, Esc closes. Picking writes via setDefault /
 * setOverride / clearOverride, closes, returns focus to the anchor and fires at most one toast.
 */
export function ProductPicker({ open, onClose, anchor, boxId, target, onPick, side = 'bottom', returnFocus }: ProductPickerProps) {
  const reduce = useReducedMotion();
  const mobile = useIsMobile();
  const box = usePlacements((s) => Object.values(s.boxes).flat().find((b) => b.id === boxId));
  const n = usePlacements((s) => (box ? (s.boxes[box.momentId] ?? []).findIndex((b) => b.id === boxId) + 1 : 0));
  const assign = usePlacements((s) => s.assign[boxId]);
  const siblings = usePlacements((s) => (box ? s.boxes[box.momentId] ?? [] : []));
  const allAssign = usePlacements((s) => s.assign);
  const audiences = useProject((s) => s.audiences);
  const products = useProject((s) => s.products);
  const catalog = useCatalog();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const audienceId = target.kind === 'audience' ? target.audienceId : null;
  const audienceName = audiences.find((a) => a.id === audienceId)?.name ?? '';
  const ix = useMemo(() => indexOf(products), [products]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const current: string | 'none' | 'inherit' | null = audienceId ? (assign?.overrides[audienceId] ?? 'inherit') : (assign?.default ?? null);

  const options = useMemo<Option[]>(() => {
    if (!box) return [];
    const q = query.trim().toLowerCase();
    const match = (p: CatalogProduct) => !q || [p.brand, p.name, p.kind, p.category].some((x) => x.toLowerCase().includes(q));
    const used = siblings.filter((b) => b.id !== boxId).map((b) => allAssign[b.id]?.default).filter((x): x is string => !!x);
    const out: Option[] = [];
    if (audienceId && assign?.default && !q) {
      const inherited = resolveWith({ default: assign.default, overrides: {} }, audienceId, ix);
      const d = ix.byId[assign.default];
      if (d && inherited.product) {
        out.push({
          key: 'inherit',
          kind: 'inherit',
          product: inherited.product,
          label: inherited.state === 'default' ? <>Use default · {d.full}</> : <>Use the local version · {inherited.product.full}</>,
        });
      }
    }
    const pool = audienceId ? catalog.productsFor(audienceId) : catalog.allProducts;
    // The product this audience already inherits is the "Use default" row; don't list it again.
    const inheritedId = out[0]?.kind === 'inherit' ? out[0].product?.id : undefined;
    const suggested = suggestedProducts(box, 4, audienceId ?? undefined, used)
      .filter((p) => p.id !== inheritedId && match(p))
      .slice(0, 3);
    suggested.forEach((p) => out.push({ key: `s-${p.id}`, kind: 'product', product: p, group: 'suggested' }));
    pool.filter((p) => match(p) && !suggested.some((x) => x.id === p.id)).forEach((p) => out.push({ key: `p-${p.id}`, kind: 'product', product: p, group: 'all' }));
    if (audienceId && (!q || `nothing in ${audienceName}`.toLowerCase().includes(q))) out.push({ key: 'none', kind: 'none', label: `Nothing in ${audienceName}` });
    return out;
  }, [box, boxId, query, audienceId, audienceName, assign, siblings, allAssign, catalog, ix]);

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, options.length - 1)));
  }, [options.length]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);

  if (!box) return null;

  const isCurrent = (o: Option) =>
    o.kind === 'inherit' ? current === 'inherit' : o.kind === 'none' ? current === 'none' : current === o.product.id;

  const close = () => {
    onClose();
    (returnFocus ?? anchor).current?.focus();
  };

  const pick = (o: Option) => {
    const st = usePlacements.getState();
    const where = audienceId ? `Only for ${audienceName}` : 'Every audience';
    if (isCurrent(o)) return close();
    if (o.kind === 'inherit' && audienceId) {
      st.clearOverride(boxId, audienceId);
      toast({ title: `Box ${n} follows the default in ${audienceName}`, description: o.product?.full });
      onPick?.(null);
    } else if (o.kind === 'none' && audienceId) {
      st.setOverride(boxId, audienceId, 'none');
      toast({ title: `Nothing in box ${n} for ${audienceName}` });
      onPick?.('none');
    } else if (o.kind === 'product') {
      if (audienceId) st.setOverride(boxId, audienceId, o.product.id);
      else st.setDefault(boxId, o.product.id);
      toast({ title: `${o.product.full} in box ${n}`, description: where, tone: 'pass' });
      onPick?.(o.product.id);
    }
    close();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[active];
      if (o) pick(o);
    } else if (e.key === 'Escape' && mobile) {
      e.preventDefault();
      close();
    }
  };

  const title = `Box ${n} · ${box.label}`;
  const targetLine = audienceId ? `Only for ${audienceName}` : 'Default for every audience';
  const allLabel = audienceId ? `All products available in ${audienceName}` : 'All products';

  const firstSuggested = options.findIndex((o) => o.kind === 'product' && o.group === 'suggested');
  const firstAll = options.findIndex((o) => o.kind === 'product' && o.group === 'all');

  const body = (
    <div className="flex min-h-0 flex-col">
      <div className="px-1 pb-2">
        <Input
          ref={inputRef}
          icon={<MagnifyingGlass />}
          value={query}
          placeholder="Search products"
          aria-label="Search products"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          className="max-md:h-11"
        />
      </div>
      <div id={listId} role="listbox" aria-label={`${title}, ${targetLine}`} className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        {options.length === 0 && (
          <div className="flex flex-col items-center gap-1 px-3 pt-6 pb-7 text-center">
            <MagnifyingGlass size={20} className="mb-1 text-text-3" aria-hidden />
            <p className="text-13 font-medium text-text">No products match “{query.trim()}”</p>
            <p className="text-12 text-text-3">{audienceId ? `Try a brand or category available in ${audienceName}.` : 'Try a brand or a category.'}</p>
            <button
              type="button"
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              className="mt-2 inline-flex h-8 items-center rounded-[8px] px-2.5 text-13 font-medium text-text-2 transition-colors duration-200 ease-cameo hover:bg-surface-3 hover:text-text"
            >
              Clear search
            </button>
          </div>
        )}
        {options.map((o, i) => (
          <div key={o.key}>
            {i === firstSuggested && <GroupLabel>Suggested</GroupLabel>}
            {i === firstAll && <GroupLabel>{allLabel}</GroupLabel>}
            {o.kind === 'none' && i > 0 && <div role="presentation" className="mx-2 my-1 h-px bg-border" />}
            <div
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              aria-current={isCurrent(o) || undefined}
              onPointerMove={() => setActive(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
              className={cx(
                'flex h-11 cursor-pointer items-center gap-3 rounded-[10px] px-2 select-none transition-colors duration-150 ease-cameo active:bg-[color-mix(in_oklab,var(--surface-3)_70%,var(--text)_6%)] max-md:h-12',
                i === active && 'bg-surface-3',
              )}
            >
              {o.kind === 'product' ? (
                <>
                  <Packshot productId={o.product.id} size={28} />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate text-12 text-text-3">{o.product.brand}</span>
                    <span className="truncate text-14 text-text">{o.product.name}</span>
                  </span>
                </>
              ) : o.kind === 'inherit' ? (
                <>
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-surface-2 text-text-2">
                    <ArrowCounterClockwise size={16} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-14 text-text">{o.label}</span>
                </>
              ) : (
                <>
                  <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] border border-dashed border-border-strong text-text-3">
                    <Prohibit size={16} aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-14 text-text-2">{o.label}</span>
                </>
              )}
              {isCurrent(o) && <Check size={16} weight="bold" className="shrink-0 text-accent" aria-label="Current choice" />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  if (mobile)
    return (
      <Sheet open={open} onClose={close} title={title} description={targetLine}>
        <div className="flex max-h-[60dvh] flex-col">{body}</div>
      </Sheet>
    );

  // Only the entrance animation needs the side: Popover itself falls back (opposite side, then below).
  const room = anchor.current ? anchor.current.getBoundingClientRect().left : 0;
  const placed = side === 'left' && room < 360 + 16 ? 'bottom' : side;

  return (
    <Popover
      open={open}
      onClose={() => {
        // Esc or a click outside: focus goes back where it came from (a click on something
        // focusable then takes it from there).
        onClose();
        (returnFocus ?? anchor).current?.focus({ preventScroll: true });
      }}
      anchor={anchor}
      side={side}
      align="start"
      label={`${title}, ${targetLine}`}
      className="w-[360px] max-w-[calc(100vw-32px)] animate-none! rounded-none! border-0! bg-transparent! p-0! shadow-none!"
    >
      <motion.div
        initial={reduce ? false : { opacity: 0, scale: 0.97, x: placed === 'left' ? 6 : 0, y: placed === 'left' ? 0 : -4 }}
        animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
        transition={{ duration: 0.18, ease: EASE }}
        style={{ transformOrigin: placed === 'left' ? 'right top' : 'left top' }}
        className="flex max-h-[440px] flex-col rounded-[14px] border border-border-strong bg-panel-2 p-2 shadow-pop"
      >
        <div className="px-2 pt-1.5 pb-3">
          <p className="truncate text-14 font-semibold text-text">{title}</p>
          <p className="truncate text-13 text-text-2">{targetLine}</p>
        </div>
        {body}
      </motion.div>
    </Popover>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p role="presentation" className="px-2 pt-2 pb-1 text-12 font-medium text-text-3">
      {children}
    </p>
  );
}
