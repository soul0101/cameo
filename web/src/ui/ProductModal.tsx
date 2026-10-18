import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowSquareOut, CaretLeft, CaretRight, X } from '@phosphor-icons/react';
import { create } from 'zustand';
import { getProduct } from '@/data/catalog';
import { Plate, wellClass } from '@/features/catalog-page/media';
import { useSceneUsage } from '@/features/catalog-page/usage';
import { useLayer } from '@/lib/layers';
import { cx } from '@/lib/cx';
import { EASE } from '@/lib/motion';
import { useProject } from '@/store/project';
import { Packshot } from './Packshot';
import { useFocusTrap } from './useFocusTrap';

/**
 * Product modal: one centred 640 px dialog, opened from any
 * product thumbnail in the app (Scenes slot and picker, Previews "In this shot", Watch, Catalog).
 * Large packshot (a gallery when the product has several images), brand, name, category, link and
 * "Used in n scenes". Mounted once (ShellOverlays); open it with `openProduct(id)`.
 */
interface ProductModalState {
  productId: string | null;
  open: (productId: string) => void;
  close: () => void;
}

const useProductModal = create<ProductModalState>()((set) => ({
  productId: null,
  open: (productId) => set({ productId }),
  close: () => set({ productId: null }),
}));

/** Open the product modal for a product id (call from any thumbnail's onClick). */
export const openProduct = (productId: string) => useProductModal.getState().open(productId);

export function ProductModal() {
  const productId = useProductModal((s) => s.productId);
  const close = useProductModal((s) => s.close);
  useProject((s) => s.products); // follow catalog edits
  const product = productId ? getProduct(productId) : undefined;
  const open = !!product;
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const isTop = useLayer(open);
  const usage = useSceneUsage();
  const [index, setIndex] = useState(0);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      setIndex(0);
      returnTo.current = document.activeElement as HTMLElement | null;
    } else returnTo.current?.focus?.({ preventScroll: true });
  }, [open, productId]);

  const escape = useCallback(() => isTop() && close(), [isTop, close]);
  useFocusTrap(ref, open, escape);

  const images = product?.images ?? [];
  const count = images.length;
  const i = Math.min(index, Math.max(0, count - 1));
  const step = useCallback((d: number) => count > 1 && setIndex((x) => (x + d + count) % count), [count]);

  useEffect(() => {
    if (!open || count < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isTop() || e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === 'ArrowRight') (e.preventDefault(), step(1));
      else if (e.key === 'ArrowLeft') (e.preventDefault(), step(-1));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, count, step, isTop]);

  const used = product ? (usage[product.id] ?? 0) : 0;
  let host = '';
  try {
    host = product?.url ? new URL(product.url).hostname.replace(/^www\./, '') : '';
  } catch {
    host = '';
  }

  return createPortal(
    <AnimatePresence>
      {open && product && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-black/[.6] backdrop-blur-[6px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={close}
          />
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="surface relative flex max-h-[calc(100dvh-32px)] w-full max-w-[640px] flex-col overflow-hidden rounded-[20px]! shadow-[var(--shadow-lift)]! outline-none"
          >
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              data-autofocus
              className="absolute top-3 right-3 z-[2] inline-flex size-9 items-center justify-center rounded-[10px] bg-surface/85 text-text-2 shadow-[0_0_0_1px_var(--border)] backdrop-blur-sm transition-colors duration-200 ease-cameo hover:bg-surface-3 hover:text-text"
            >
              <X size={18} weight="bold" />
            </button>

            <div className="p-3 pb-0">
              <div className={cx(wellClass, 'h-[min(420px,52dvh)] w-full rounded-[16px]')}>
                {count ? (
                  <AnimatePresence initial={false}>
                    <motion.div
                      key={images[i]}
                      className="absolute inset-0"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: reduce ? 0 : 0.2 }}
                    >
                      <Plate src={images[i]} alt={`${product.full}${count > 1 ? `, image ${i + 1} of ${count}` : ''}`} fill={0.82} radius={10} />
                    </motion.div>
                  </AnimatePresence>
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <Packshot productId={product.id} size={160} />
                  </span>
                )}
                {count > 1 && (
                  <>
                    <Arrow side="left" onClick={() => step(-1)} label="Previous image">
                      <CaretLeft weight="bold" />
                    </Arrow>
                    <Arrow side="right" onClick={() => step(1)} label="Next image">
                      <CaretRight weight="bold" />
                    </Arrow>
                    <span className="absolute right-3 bottom-3 rounded-full bg-black/60 px-2 py-0.5 text-12 font-medium text-white tabular-nums">
                      {i + 1} / {count}
                    </span>
                  </>
                )}
              </div>
              {count > 1 && (
                <div role="group" aria-label="Images" className="no-scrollbar flex gap-2 overflow-x-auto pt-3">
                  {images.map((src, k) => (
                    <button
                      key={src + k}
                      type="button"
                      onClick={() => setIndex(k)}
                      aria-label={`Image ${k + 1} of ${count}`}
                      aria-current={k === i || undefined}
                      className={cx(
                        wellClass,
                        'size-14 shrink-0 rounded-[10px] transition-[opacity,box-shadow] duration-200 ease-cameo',
                        k === i ? 'opacity-100 ring-[1.5px] ring-accent' : 'opacity-60 hover:opacity-100',
                      )}
                    >
                      <Plate src={src} alt="" fill={0.82} radius={4} lazy />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-4 p-6 pt-5">
              <div className="flex flex-col gap-1">
                <p className="text-14 text-text-2">{product.brand}</p>
                <h2 id={titleId} className="text-24 leading-tight font-semibold text-text">
                  {product.name}
                </h2>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-14 text-text-2">
                <span className="inline-flex h-7 items-center rounded-[8px] bg-surface-2 px-2.5 text-13 font-medium text-text-2">{product.kind || product.category}</span>
                <span aria-hidden className="text-text-3">·</span>
                <span>{used ? `Used in ${used} ${used === 1 ? 'scene' : 'scenes'}` : 'Not in a scene yet'}</span>
                {product.url && (
                  <a
                    href={product.url}
                    target="_blank"
                    rel="noreferrer"
                    className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-surface-2 px-3 text-14 font-medium text-text transition-colors duration-200 ease-cameo hover:bg-surface-3"
                  >
                    {host || 'View product'}
                    <ArrowSquareOut size={16} aria-hidden />
                  </a>
                )}
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function Arrow({ side, onClick, label, children }: { side: 'left' | 'right'; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cx(
        'absolute top-1/2 z-[1] inline-flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-surface/85 text-text shadow-[0_4px_16px_rgba(0,0,0,.18),0_0_0_1px_var(--border)] backdrop-blur-sm transition-[background-color,transform] duration-200 ease-cameo hover:bg-surface active:scale-95',
        side === 'left' ? 'left-3' : 'right-3',
      )}
    >
      {children}
    </button>
  );
}
