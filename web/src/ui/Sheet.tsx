import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from '@phosphor-icons/react';
import { useIsMobile } from '@/lib/hooks';
import { useLayer, useSheetEdges } from '@/lib/layers';
import { panel } from '@/lib/motion';
import { cx } from '@/lib/cx';
import { Button } from './Button';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Desktop width: 420 (catalog) or 920 (compare). Any number works. */
  width?: number;
  /** Translucent surface (blur 20 over --surface at 85%). Catalog sheet only. */
  translucent?: boolean;
  /** @deprecated alias of translucent. */
  frosted?: boolean;
  /** Extra header content (search, filters) under the title row. */
  header?: ReactNode;
  /** false: no backdrop and no focus trap; the page behind stays usable (catalog: drag onto scene cards). */
  modal?: boolean;
}

/** Floating right sheet (inset 12, radius 20) on desktop, bottom sheet on ≤767. Modal: focus moves in, Esc closes, focus returns. */
export function Sheet({ open, onClose, title, description, children, footer, width = 420, translucent, frosted, header, modal = true }: SheetProps) {
  const mobile = useIsMobile();
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const isTop = useLayer(open);
  const edgeId = useId();
  const setEdge = useSheetEdges((s) => s.set);
  // Tell the toaster where this sheet is so toasts stack beside it, not over its footer.
  useEffect(() => {
    if (!open) return;
    setEdge(edgeId, mobile ? -1 : Math.min(width, window.innerWidth - 24) + 12);
    return () => setEdge(edgeId, null);
  }, [open, mobile, width, edgeId, setEdge]);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const node = ref.current;
    requestAnimationFrame(() => node?.querySelector<HTMLElement>('[data-autofocus], button, [href], input, [tabindex]:not([tabindex="-1"])')?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) onClose();
      if (!modal || e.key !== 'Tab' || !node) return;
      const items = node.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, modal]);

  const offscreen = reduce ? { opacity: 0 } : mobile ? { y: '100%' } : { x: '100%' };
  const onscreen = reduce ? { opacity: 1 } : mobile ? { y: 0 } : { x: 0 };

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className={cx('fixed inset-0 z-50', !modal && 'pointer-events-none')}>
          {modal && <motion.div
            aria-hidden
            className="absolute inset-0 bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={panel}
            onClick={onClose}
          />}
          <motion.div
            ref={ref}
            role="dialog"
            aria-modal={modal || undefined}
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            initial={offscreen}
            animate={onscreen}
            exit={offscreen}
            transition={panel}
            style={mobile ? undefined : { width: `min(${width}px, calc(100vw - 24px))` }}
            className={cx(
              'pointer-events-auto absolute flex flex-col overflow-hidden',
              translucent || frosted ? 'surface-translucent' : 'surface',
              mobile ? 'inset-x-2 bottom-2 max-h-[88dvh] rounded-[20px]! pb-[env(safe-area-inset-bottom)]' : 'top-3 right-3 bottom-3 rounded-[20px]!',
            )}
          >
            <header className="flex shrink-0 flex-col gap-3 px-5 pt-4 pb-3">
              <div className="flex items-center gap-2">
                <h2 id={titleId} className="min-w-0 flex-1 truncate text-16 font-semibold text-text">{title}</h2>
                <Button variant="ghost" size="sm" iconOnly icon={<X />} aria-label="Close" onClick={onClose} className="-mr-1.5" />
              </div>
              {description && <p id={descId} className="-mt-2 text-13 text-text-2">{description}</p>}
              {header}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
            {footer && <footer className="flex items-center gap-2 border-t border-border px-5 py-3">{footer}</footer>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
