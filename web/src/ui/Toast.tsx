import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CheckCircle, Info, WarningCircle, X } from '@phosphor-icons/react';
import { useSheetEdges } from '@/lib/layers';
import { EASE } from '@/lib/motion';
import { cx } from '@/lib/cx';

export type ToastTone = 'neutral' | 'pass' | 'reject';

export interface ToastItem {
  id: number;
  title: ReactNode;
  description?: ReactNode;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
}

interface ToastState {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id' | 'tone'> & { tone?: ToastTone }) => number;
  dismiss: (id: number) => void;
}

let seq = 0;
/** When each toast appeared (ms), for the 1.5 s duplicate window. */
const born = new Map<number, number>();

const useToasts = create<ToastState>()((set) => ({
  items: [],
  push: (t) => {
    const id = ++seq;
    const now = Date.now();
    const item: ToastItem = { ...t, tone: t.tone ?? 'neutral', id };
    set((s) => {
      // The same title within 1.5 s replaces the earlier toast instead of stacking; at most 2 stay.
      const dup = typeof t.title === 'string' ? s.items.find((x) => x.title === t.title && now - (born.get(x.id) ?? 0) < 1500) : undefined;
      return { items: [...s.items.filter((x) => x !== dup), item].slice(-2) };
    });
    born.set(id, now);
    return id;
  },
  dismiss: (id) => {
    born.delete(id);
    set((s) => ({ items: s.items.filter((x) => x.id !== id) }));
  },
}));

/** Fire a toast from anywhere: `toast('Added to catalog')` or `toast({ title, description, tone })`. */
export function toast(t: string | (Omit<ToastItem, 'id' | 'tone'> & { tone?: ToastTone })) {
  return useToasts.getState().push(typeof t === 'string' ? { title: t } : t);
}

const DURATION = 3000;
/** A failure stays longer: it often explains why a paid action did not happen. */
const REJECT_DURATION = 9000;
const ICON = { neutral: Info, pass: CheckCircle, reject: WarningCircle } as const;

/**
 * Toast stack, newest on top, at most two. Bottom-right of the screen; while a sheet is open it sits
 * just left of the sheet (bottom-centre of the page on phones is replaced by the top, clear of a
 * bottom sheet), so a toast never covers a sheet's footer. Each toast closes after 3 s. Mount once.
 */
/** Bottom offsets requested by sticky bars (Previews actions), so a toast sits above them, never over their buttons. */
const useToastLiftStore = create<{ lifts: Record<string, number> }>()(() => ({ lifts: {} }));

/** While mounted, keep toasts at least `px` above the bottom edge. */
export function useToastLift(px: number) {
  const id = useId();
  useEffect(() => {
    useToastLiftStore.setState((s) => ({ lifts: { ...s.lifts, [id]: px } }));
    return () =>
      useToastLiftStore.setState((s) => {
        const lifts = { ...s.lifts };
        delete lifts[id];
        return { lifts };
      });
  }, [id, px]);
}

export function Toaster() {
  const items = useToasts((s) => s.items);
  const lift = useToastLiftStore((s) => Math.max(0, ...Object.values(s.lifts)));
  const edges = useSheetEdges((s) => s.edges);
  const vals = Object.values(edges);
  const onTop = vals.some((v) => v < 0);
  const inset = Math.max(0, ...vals);
  const style = onTop ? undefined : { ...(inset ? { right: inset + 12 } : {}), ...(lift ? { bottom: lift } : {}) };
  return createPortal(
    <div
      aria-live="polite"
      role="status"
      style={style}
      className={cx(
        'pointer-events-none fixed z-[90] flex w-[360px] max-w-[calc(100vw-32px)] flex-col items-end gap-2 transition-[right] duration-[240ms] ease-cameo motion-reduce:transition-none',
        onTop ? 'top-4 right-1/2 translate-x-1/2' : 'right-4 bottom-4 max-md:right-1/2 max-md:translate-x-1/2',
        !onTop && inset > 0 && 'max-md:translate-x-0',
      )}
    >
      <AnimatePresence initial={false}>
        {[...items].reverse().map((t) => (
          <ToastCard key={t.id} item={t} />
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

function ToastCard({ item }: { item: ToastItem }) {
  const dismiss = useToasts((s) => s.dismiss);
  // Paused while the pointer rests on it, so it can be read.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const timer = setTimeout(() => dismiss(item.id), item.tone === 'reject' ? REJECT_DURATION : DURATION);
    return () => clearTimeout(timer);
  }, [item.id, item.tone, dismiss, held]);
  const Icon = ICON[item.tone];
  const reduce = useReducedMotion();
  return (
    <motion.div
      layout={!reduce}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.2 } } : { opacity: 0, scale: 0.98, transition: { duration: 0.2 } }}
      transition={{ duration: 0.24, ease: EASE }}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      className="surface pointer-events-auto flex w-full items-start gap-3 py-3 pr-2 pl-4 shadow-[var(--shadow-lift)]!"
    >
      <Icon size={18} weight="fill" aria-hidden className={cx('mt-px shrink-0', item.tone === 'pass' ? 'text-pass' : item.tone === 'reject' ? 'text-reject' : 'text-text-2')} />
      <div className="min-w-0 flex-1">
        <p className="text-14 font-medium text-text">{item.title}</p>
        {item.description && <p className="mt-0.5 text-13 text-text-2">{item.description}</p>}
      </div>
      {item.action && (
        <button
          type="button"
          onClick={() => (item.action!.onClick(), dismiss(item.id))}
          className="h-7 shrink-0 rounded-[8px] px-2 text-13 font-medium text-accent hover:bg-surface-3"
        >
          {item.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => dismiss(item.id)} className="inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] text-text-3 hover:bg-surface-3 hover:text-text">
        <X size={14} />
      </button>
    </motion.div>
  );
}
