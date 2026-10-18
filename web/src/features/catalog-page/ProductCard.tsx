import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowsOut, CaretLeft, CaretRight, DotsThree, FilmStrip, PencilSimple, Target, Trash, UsersFour, Warning } from '@phosphor-icons/react';
import type { CatalogProduct } from '@/data/catalog';
import { AudienceIcon } from '@/features/audiences/AudienceBar';
import type { AudienceKind } from '@/store/project';
import { cx } from '@/lib/cx';
import { Chip, Menu, Packshot, ProductLink } from '@/ui';
import { openProduct } from '@/ui/ProductModal';
import { Plate, wellClass } from './media';

/**
 * One product, image-first: a 4:3 media well (inset 8, radius 12) with
 * the cover on its plate, or the generated brand tile; with more images a "1 / 3" count, and on
 * hover thin chevrons and dots (200 ms crossfade). Clicking the media opens the viewer. Below:
 * brand and name (opens the product modal), availability, scene usage, category chip, link. ⋯: Edit, Place in scenes…, Remove.
 */
export function ProductCard({
  product: p,
  usedIn,
  availability,
  onOpen,
  onEdit,
  onPlace,
  onRemove,
}: {
  product: CatalogProduct;
  usedIn: number;
  availability: { text: string; full: string; kind: AudienceKind | null; none: boolean };
  /** Open the viewer at this image index. */
  onOpen: (index: number) => void;
  onEdit: () => void;
  onPlace: () => void;
  onRemove: () => void;
}) {
  const reduce = useReducedMotion();
  const images = p.images;
  const count = images.length;
  const [raw, setIndex] = useState(0);
  const index = Math.min(raw, Math.max(0, count - 1));
  const step = (d: number) => setIndex((i) => (Math.min(i, count - 1) + d + count) % count);

  const onMediaKey = (e: KeyboardEvent) => {
    if (count < 2) return;
    if (e.key === 'ArrowRight') (e.preventDefault(), step(1));
    else if (e.key === 'ArrowLeft') (e.preventDefault(), step(-1));
  };

  return (
    <article className="surface lift group/card flex flex-col p-2" aria-label={`${p.full}, ${p.category}`}>
      <div className={cx(wellClass, 'group/media aspect-[4/3] rounded-[12px]')}>
        <button
          type="button"
          onClick={() => (count ? onOpen(index) : onEdit())}
          onKeyDown={onMediaKey}
          aria-label={count ? `View images of ${p.full}, image ${index + 1} of ${count}` : `Add images to ${p.full}`}
          className="absolute inset-0 z-[1] cursor-zoom-in rounded-[12px] focus-visible:outline-offset-[-2px]"
          style={count ? undefined : { cursor: 'pointer' }}
        />
        {count ? (
          <AnimatePresence initial={false}>
            <motion.div
              key={images[index]}
              className="absolute inset-0"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
            >
              <Plate src={images[index]} alt={index === 0 ? `${p.full}` : `${p.full}, image ${index + 1}`} lazy />
            </motion.div>
          </AnimatePresence>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Packshot productId={p.id} size={88} className="shadow-[0_10px_28px_rgba(0,0,0,.18)]" />
          </div>
        )}

        {count > 1 && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute right-2 bottom-2 z-[2] inline-flex h-5 items-center rounded-[6px] bg-black/55 px-1.5 text-11 font-medium text-white tabular-nums backdrop-blur-sm transition-opacity duration-200 ease-cameo group-hover/media:opacity-0 group-focus-within/media:opacity-0"
            >
              {index + 1} / {count}
            </span>
            {[-1, 1].map((d) => (
              <button
                key={d}
                type="button"
                tabIndex={-1}
                aria-label={d < 0 ? 'Previous image' : 'Next image'}
                onClick={() => step(d)}
                className={cx(
                  'absolute top-1/2 z-[2] inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-surface/85 text-text opacity-0 shadow-[0_2px_10px_rgba(0,0,0,.18),0_0_0_1px_var(--border)] backdrop-blur-sm transition-opacity duration-200 ease-cameo group-hover/media:opacity-100 group-focus-within/media:opacity-100 hover:bg-surface max-md:opacity-100',
                  d < 0 ? 'left-2' : 'right-2',
                )}
              >
                {d < 0 ? <CaretLeft size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
              </button>
            ))}
            <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-2.5 z-[2] flex justify-center gap-1 opacity-0 transition-opacity duration-200 ease-cameo group-hover/media:opacity-100 group-focus-within/media:opacity-100">
              {images.map((src, i) => (
                <span
                  key={src + i}
                  className={cx('h-1 rounded-full transition-[width,background-color] duration-200 ease-cameo', i === index ? 'w-3 bg-text/70' : 'w-1 bg-text/25')}
                />
              ))}
            </span>
          </>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 px-2 pt-3 pb-2">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => openProduct(p.id)}
            aria-label={`View ${p.full}`}
            className="group/name -m-1 min-w-0 flex-1 rounded-[10px] p-1 text-left"
          >
            <span className="block truncate text-12 text-text-2">{p.brand || 'No brand'}</span>
            <span className="mt-0.5 line-clamp-2 text-16 leading-[1.3] font-medium text-text decoration-text-3 underline-offset-4 group-hover/name:underline" title={p.name}>
              {p.name}
            </span>
          </button>
          <Menu
            label={`${p.full} options`}
            align="end"
            items={[
              { id: 'view', label: 'View product', icon: <ArrowsOut />, onSelect: () => openProduct(p.id) },
              { id: 'edit', label: 'Edit', icon: <PencilSimple />, onSelect: onEdit },
              { id: 'place', label: 'Place in scenes…', icon: <Target />, onSelect: onPlace },
              'divider',
              { id: 'remove', label: 'Remove', icon: <Trash />, onSelect: onRemove },
            ]}
            trigger={(props) => (
              <button
                {...props}
                type="button"
                aria-label={`${p.full} options`}
                className={cx(
                  '-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-text-3 transition-[background-color,color] duration-200 ease-cameo hover:bg-surface-3 hover:text-text max-md:size-11',
                  props['aria-expanded'] && 'bg-surface-3 text-text',
                )}
              >
                <DotsThree size={18} weight="bold" />
              </button>
            )}
          />
        </div>

        <ul className="flex flex-col gap-1.5 text-13">
          <li className={cx('flex min-w-0 items-center gap-2', availability.none ? 'text-accent' : 'text-text-2')} title={availability.full}>
            {availability.none ? (
              <Warning size={16} aria-hidden className="shrink-0" />
            ) : availability.kind ? (
              <AudienceIcon kind={availability.kind} className="shrink-0 text-text-3" />
            ) : (
              <UsersFour size={16} aria-hidden className="shrink-0 text-text-3" />
            )}
            <span className="sr-only">Available in </span>
            <span className="truncate">{availability.text}</span>
          </li>
          <li className={cx('flex items-center gap-2', usedIn ? 'text-text-2' : 'text-text-3')}>
            <FilmStrip size={16} aria-hidden className="shrink-0 text-text-3" />
            {usedIn ? `Used in ${usedIn} scene${usedIn === 1 ? '' : 's'}` : 'Not in a scene yet'}
          </li>
        </ul>

        <div className="mt-auto flex items-center gap-2 pt-1">
          <Chip>{p.category}</Chip>
          <span className="flex-1" />
          {p.url ? <ProductLink href={p.url} /> : <span className="text-12 text-text-3">No link</span>}
        </div>
      </div>
    </article>
  );
}
