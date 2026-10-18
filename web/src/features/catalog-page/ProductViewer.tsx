import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CaretLeft, CaretRight, PencilSimple, Star, X } from '@phosphor-icons/react';
import type { CatalogProduct } from '@/data/catalog';
import { useLayer } from '@/lib/layers';
import { cx } from '@/lib/cx';
import { useProject } from '@/store/project';
import { toast, useFocusTrap } from '@/ui';
import { Plate, wellClass } from './media';

/** Controls on the always-dark backdrop: fixed light-on-dark in both themes. */
const glass =
  'inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-white/10 bg-white/10 px-3 text-13 font-medium text-white/90 transition-[background-color,color] duration-200 ease-cameo hover:bg-white/[.18] hover:text-white disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0';

/** Move image `from` to the front (cover); returns the new list. */
export const makeCover = (images: string[], from: number) => (from <= 0 ? images : [images[from], ...images.slice(0, from), ...images.slice(from + 1)]);

/**
 * Product image viewer: a lightbox over `rgba(0,0,0,.72)` + blur 8. Slim
 * header (brand · name, "n of m", Make cover, Edit product, close), the image large on the neutral
 * plate (max 80vh, radius 20), a filmstrip of 56 px thumbs (active = 1.5 px accent ring).
 * Focus-trapped; Esc closes (only when it is the top layer); ←/→ step. Reduced motion: no scale.
 */
export function ProductViewer({
  product,
  start,
  open,
  onClose,
  onEdit,
}: {
  product: CatalogProduct | null;
  start: number;
  open: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const isTop = useLayer(open);
  const [index, setIndex] = useState(start);
  // The live product (Make cover reorders it in the store while the viewer is open).
  const live = useProject((s) => (product ? s.products.find((p) => p.id === product.id) : undefined));
  const images = live?.images ?? product?.images ?? [];
  const count = images.length;
  const i = Math.min(index, Math.max(0, count - 1));

  useEffect(() => {
    if (open) setIndex(start);
  }, [open, start]);
  useEffect(() => {
    if (open && product && count === 0) onClose();
  }, [open, product, count, onClose]);

  const escape = useCallback(() => isTop() && onClose(), [isTop, onClose]);
  useFocusTrap(ref, open, escape);

  const step = useCallback((d: number) => count > 1 && setIndex((x) => (Math.min(x, count - 1) + d + count) % count), [count]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isTop() || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') (e.preventDefault(), step(1));
      else if (e.key === 'ArrowLeft') (e.preventDefault(), step(-1));
      else if (e.key === 'Home') (e.preventDefault(), setIndex(0));
      else if (e.key === 'End') (e.preventDefault(), setIndex(count - 1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, step, count, isTop]);

  const cover = () => {
    if (!product || i === 0) return;
    useProject.getState().updateProduct(product.id, { images: makeCover(images, i) });
    setIndex(0);
    toast({ title: 'Cover updated', description: `${product.name} now opens with this image`, tone: 'pass' });
  };

  const name = product ? product.name : '';

  return createPortal(
    <AnimatePresence>
      {open && product && count > 0 && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-black/[.72] backdrop-blur-[8px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            onClick={onClose}
          />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 8 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 4 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none relative flex w-[min(1120px,calc(100vw-32px))] flex-col items-center gap-3 outline-none"
          >
            <header className="pointer-events-auto flex w-full items-center gap-3 px-1">
              <h2 id={titleId} className="min-w-0 flex-1 truncate text-14 text-white">
                <span className="text-white/60">{product.brand}</span>
                <span aria-hidden className="px-1.5 text-white/35">·</span>
                <span className="font-medium">{name}</span>
              </h2>
              <span className="shrink-0 text-13 text-white/60 tabular-nums" aria-live="polite">
                {i + 1} of {count}
              </span>
              {i === 0 ? (
                <span className={cx(glass, 'pointer-events-none border-transparent bg-transparent px-2 text-white/60 max-sm:hidden')}>
                  <Star weight="fill" className="text-accent" />
                  Cover
                </span>
              ) : (
                <button type="button" className={glass} onClick={cover}>
                  <Star />
                  Make cover
                </button>
              )}
              <button type="button" className={cx(glass, 'max-sm:hidden')} onClick={onEdit}>
                <PencilSimple />
                Edit product
              </button>
              <button type="button" className={cx(glass, 'w-[30px] px-0')} onClick={onClose} aria-label="Close" data-autofocus>
                <X size={16} weight="bold" />
              </button>
            </header>

            <div className={cx(wellClass, 'pointer-events-auto h-[min(80vh,calc(100dvh-200px))] w-full rounded-[20px] shadow-[0_24px_80px_rgba(0,0,0,.45)]')}>
              <AnimatePresence initial={false}>
                <motion.div
                  key={images[i]}
                  className="absolute inset-0"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
                >
                  <Plate src={images[i]} alt={`${product.full}, image ${i + 1} of ${count}${i === 0 ? ', cover' : ''}`} fill={0.86} radius={12} />
                </motion.div>
              </AnimatePresence>
              {count > 1 && (
                <>
                  <StageArrow side="left" onClick={() => step(-1)} label="Previous image">
                    <CaretLeft weight="bold" />
                  </StageArrow>
                  <StageArrow side="right" onClick={() => step(1)} label="Next image">
                    <CaretRight weight="bold" />
                  </StageArrow>
                </>
              )}
            </div>

            {count > 1 && (
              <div role="group" aria-label="Images" className="pointer-events-auto no-scrollbar flex max-w-full gap-2 overflow-x-auto p-1">
                {images.map((src, k) => (
                  <button
                    key={src + k}
                    type="button"
                    onClick={() => setIndex(k)}
                    aria-label={`Image ${k + 1} of ${count}${k === 0 ? ', cover' : ''}`}
                    aria-current={k === i || undefined}
                    className={cx(
                      wellClass,
                      'size-14 shrink-0 rounded-[10px] transition-[opacity,box-shadow] duration-200 ease-cameo',
                      k === i ? 'opacity-100 ring-[1.5px] ring-accent ring-offset-2 ring-offset-black/0' : 'opacity-60 hover:opacity-100',
                    )}
                  >
                    <Plate src={src} alt="" fill={0.82} radius={4} lazy />
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function StageArrow({ side, onClick, label, children }: { side: 'left' | 'right'; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cx(
        'absolute top-1/2 z-[1] inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-surface/85 text-text shadow-[0_4px_16px_rgba(0,0,0,.18),0_0_0_1px_var(--border)] backdrop-blur-sm transition-[background-color,transform] duration-200 ease-cameo hover:bg-surface active:scale-95 [&_svg]:size-[18px]',
        side === 'left' ? 'left-4' : 'right-4',
      )}
    >
      {children}
    </button>
  );
}
