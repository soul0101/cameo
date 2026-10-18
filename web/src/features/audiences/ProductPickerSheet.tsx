import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsOut, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { useCatalog } from '@/data/catalog';
import type { CatalogProduct } from '@/data/catalog';
import { Plate, wellClass } from '@/features/catalog-page/media';
import { assignFor, assignLine } from '@/features/scenes/assign';
import { pickWhy, suggestedProducts } from '@/features/scenes/model';
import { cx } from '@/lib/cx';
import { usePlacements, useResolved } from '@/store/placements';
import type { AudienceId } from '@/store/project';
import { Input, Packshot, Sheet, toast } from '@/ui';
import { openProduct } from '@/ui/ProductModal';
import { audienceLabel } from './model';

export interface ProductPickerSheetProps {
  open: boolean;
  onClose: () => void;
  boxId: string;
  /** The active audience: the grid lists what is available there, and the pick is written for it. */
  audienceId: AudienceId;
}

/**
 * Product picker sheet: 560 px, "Box n · label" for one
 * audience. Search (autofocus), "Suggested for this spot" (Gemini's picks with their why) first,
 * then every product available in the audience as large cards. Click assigns through `assignFor`,
 * closes and fires one toast; the expand button on a card opens the product modal.
 */
export function ProductPickerSheet({ open, onClose, boxId, audienceId }: ProductPickerSheetProps) {
  const box = usePlacements((s) => Object.values(s.boxes).flat().find((b) => b.id === boxId));
  const siblings = usePlacements((s) => (box ? (s.boxes[box.momentId] ?? []) : []));
  const assign = usePlacements((s) => s.assign);
  const current = useResolved(boxId, audienceId).product?.id;
  const catalog = useCatalog();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const audienceName = audienceLabel(audienceId);
  const n = box ? siblings.findIndex((b) => b.id === boxId) + 1 : 0;

  useEffect(() => {
    if (!open) return;
    setQuery('');
    // After the sheet's own initial focus (its close button).
    const t = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open]);

  const { suggested, rest } = useMemo(() => {
    if (!box) return { suggested: [], rest: [] };
    const q = query.trim().toLowerCase();
    const match = (p: CatalogProduct) => !q || [p.brand, p.name, p.kind, p.category].some((x) => x.toLowerCase().includes(q));
    const used = siblings.filter((b) => b.id !== boxId).map((b) => assign[b.id]?.default).filter((x): x is string => !!x);
    const sug = suggestedProducts(box, 3, audienceId, used)
      .filter(match)
      .map((p) => ({ product: p, why: pickWhy(box, audienceId, p.id) }));
    const others = catalog.productsFor(audienceId).filter((p) => match(p) && !sug.some((s) => s.product.id === p.id));
    return { suggested: sug, rest: others };
  }, [box, boxId, siblings, assign, audienceId, query, catalog]);

  if (!box) return null;

  const pick = (p: CatalogProduct) => {
    if (p.id !== current) {
      const result = assignFor(boxId, audienceId, p.id);
      if (result !== 'same') toast({ title: `${p.full} in box ${n}`, description: assignLine(result, audienceName), tone: 'pass' });
    }
    onClose();
  };

  const first = suggested[0]?.product ?? rest[0];

  return (
    <Sheet
      open={open}
      onClose={onClose}
      width={560}
      title={`Box ${n} · ${box.label}`}
      description={`For ${audienceName}`}
      header={
        <Input
          ref={inputRef}
          icon={<MagnifyingGlass />}
          value={query}
          placeholder="Search products"
          aria-label="Search products"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && query.trim() && first) {
              e.preventDefault();
              pick(first);
            }
          }}
          className="max-md:h-11"
        />
      }
    >
      <div className="flex flex-col gap-6 px-5 pt-1 pb-6">
        {suggested.length > 0 && (
          <section aria-label="Suggested for this spot">
            <h3 className="pb-2.5 text-13 font-medium text-text-2">Suggested for this spot</h3>
            <ul className="grid grid-cols-3 gap-3 max-sm:grid-cols-2">
              {suggested.map((s) => (
                <PickCard key={s.product.id} product={s.product} why={s.why} current={s.product.id === current} onPick={pick} />
              ))}
            </ul>
          </section>
        )}
        {rest.length > 0 && (
          <section aria-label={`All products in ${audienceName}`}>
            <h3 className="pb-2.5 text-13 font-medium text-text-2">
              {suggested.length ? 'All products' : 'Products'} in {audienceName} <span className="font-normal text-text-3">· {rest.length}</span>
            </h3>
            <ul className="grid grid-cols-3 gap-3 max-sm:grid-cols-2">
              {rest.map((p) => (
                <PickCard key={p.id} product={p} current={p.id === current} onPick={pick} />
              ))}
            </ul>
          </section>
        )}
        {!suggested.length && !rest.length && (
          <p className="py-10 text-center text-14 text-text-2">
            {query.trim() ? `No products match “${query.trim()}”` : `No products available in ${audienceName} yet`}
          </p>
        )}
      </div>
    </Sheet>
  );
}

function PickCard({ product: p, why, current, onPick }: { product: CatalogProduct; why?: string; current: boolean; onPick: (p: CatalogProduct) => void }) {
  return (
    <li className="relative">
      <button
        type="button"
        onClick={() => onPick(p)}
        aria-pressed={current}
        aria-label={`${p.full}${current ? ', in this box now' : ''}`}
        className={cx(
          'group/pick flex h-full w-full flex-col rounded-[16px] border bg-surface-2 p-1.5 text-left transition-[background-color,border-color,transform] duration-200 ease-cameo hover:-translate-y-0.5 hover:bg-surface-3',
          current ? 'border-accent' : 'border-border',
        )}
      >
        <span className={cx(wellClass, 'block h-[120px] w-full rounded-[12px]')}>
          {p.packshot ? (
            <Plate src={p.packshot} alt="" lazy fill={0.8} />
          ) : (
            <span className="absolute inset-0 flex items-center justify-center">
              <Packshot productId={p.id} size={72} />
            </span>
          )}
        </span>
        <span className="flex flex-1 flex-col px-1.5 pt-2.5 pb-1.5">
          <span className="line-clamp-2 text-14 leading-[1.3] font-medium text-text">{p.name}</span>
          <span className="mt-0.5 truncate text-13 text-text-2">{p.brand}</span>
          <span className="mt-0.5 truncate text-12 text-text-3">{p.kind}</span>
          {why && <span className="mt-2 line-clamp-3 text-12 text-text-2">{why}</span>}
        </span>
      </button>
      {current && (
        <span aria-hidden className="pointer-events-none absolute top-3 left-3 inline-flex size-6 items-center justify-center rounded-full bg-accent text-accent-ink shadow-[0_1px_3px_rgba(0,0,0,.3)]">
          <Check size={14} weight="bold" />
        </span>
      )}
      <button
        type="button"
        onClick={() => openProduct(p.id)}
        aria-label={`View ${p.full}`}
        title="View product"
        className="absolute top-3 right-3 inline-flex size-7 items-center justify-center rounded-[10px] bg-black/55 text-white backdrop-blur-sm transition-colors duration-200 ease-cameo hover:bg-black/75 max-md:size-11"
      >
        <ArrowsOut size={14} weight="bold" />
      </button>
    </li>
  );
}
