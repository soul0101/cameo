import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { cx } from '@/lib/cx';
import { EASE } from '@/lib/motion';
import { Skeleton } from './Skeleton';

/** `?skeleton=hold` keeps every page skeleton on screen (for screenshots). */
const holding = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('skeleton') === 'hold';

export interface LoadableProps {
  /** Real readiness of the page's data. The skeleton still shows for at least `minMs`. */
  ready: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  /** Minimum time the skeleton stays up, to avoid a flash. */
  minMs?: number;
  /** Safety valve: show the content after this long even if `ready` never turns true. */
  maxMs?: number;
}

/** Skeleton for at least `minMs` and until `ready`, then the content fades in over 160 ms. */
export function Loadable({ ready, skeleton, children, minMs = 250, maxMs = 6000 }: LoadableProps) {
  const reduce = useReducedMotion();
  const [hold] = useState(holding);
  const [minDone, setMinDone] = useState(false);
  const [maxDone, setMaxDone] = useState(false);

  useEffect(() => {
    const a = window.setTimeout(() => setMinDone(true), minMs);
    const b = window.setTimeout(() => setMaxDone(true), maxMs);
    return () => {
      window.clearTimeout(a);
      window.clearTimeout(b);
    };
  }, [minMs, maxMs]);

  if (hold || !minDone || !(ready || maxDone)) {
    return (
      <div aria-busy="true" aria-live="polite" className="w-full">
        <span className="sr-only">Loading</span>
        {skeleton}
      </div>
    );
  }
  return (
    <motion.div
      className="flex min-h-0 w-full flex-1 flex-col"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.16, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/* ---------- Pieces ---------- */

const card = 'surface rounded-[16px]';

function TitleRow({ action = true }: { action?: boolean }) {
  return (
    <div className="flex items-end justify-between gap-4 pb-5 max-md:flex-col max-md:items-stretch">
      <div className="flex flex-col gap-2.5">
        <Skeleton width={220} height={26} className="max-w-full" />
        <Skeleton shape="line" width={160} />
      </div>
      {action && <Skeleton width={190} height={36} className="rounded-[10px] max-md:h-11 max-md:w-full" />}
    </div>
  );
}

/** Scenes: stage frame (16:9, radius 20) + box panel rows + timeline strip. */
export function ScenesSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4">
      <TitleRow />
      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-6 max-lg:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="aspect-video w-full rounded-[20px]" />
          <div className={cx(card, 'flex flex-col gap-3 p-4')}>
            <div className="flex items-center gap-2">
              <Skeleton width={32} height={32} className="rounded-[10px]" />
              <Skeleton shape="line" width={120} />
              <Skeleton width={120} height={32} className="ml-auto rounded-[10px]" />
            </div>
            <Skeleton height={40} className="w-full rounded-[10px]" />
            <div className="flex gap-1.5">
              {Array.from({ length: 10 }, (_, i) => (
                <Skeleton key={i} height={44} className="min-w-0 flex-1 rounded-[8px]" />
              ))}
            </div>
          </div>
        </div>
        <div className={cx(card, 'flex flex-col gap-2 p-4')}>
          <Skeleton shape="line" width={150} className="mb-2" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex h-[60px] items-center gap-3 rounded-[12px] bg-surface-2/40 px-3">
              <Skeleton shape="circle" width={24} height={24} />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton shape="line" width="55%" />
                <Skeleton shape="line" width="35%" className="h-2" />
              </div>
              <Skeleton width={24} height={24} className="rounded-[6px]" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Previews: scene list (320) + detail. */
export function PreviewsSkeleton() {
  return (
    <div className="flex w-full flex-col">
      <TitleRow />
      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-6 max-md:grid-cols-1 max-md:gap-4">
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cx(card, 'flex items-center gap-3 p-3')}>
              <Skeleton width={72} height={44} className="rounded-[8px]" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton shape="line" width="70%" />
                <Skeleton shape="line" width="40%" className="h-2" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Skeleton className="aspect-video w-full rounded-[20px]" />
          <div className="flex gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} width={96} height={32} className="rounded-[10px]" />
            ))}
          </div>
          <Skeleton height={64} className="w-full rounded-[12px]" />
          <Skeleton width={160} height={36} className="rounded-[10px]" />
        </div>
      </div>
    </div>
  );
}

/** Catalog: tab row + 3 cards. */
export function CatalogSkeleton() {
  return (
    <div className="flex w-full flex-col">
      <TitleRow />
      <div className="flex flex-wrap items-center gap-2 pb-5">
        {[72, 96, 88, 104].map((w, i) => (
          <Skeleton key={i} width={w} height={32} className="rounded-[10px]" />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-4 max-lg:grid-cols-2 max-md:grid-cols-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cx(card, 'flex flex-col gap-3 p-4')}>
            <div className="flex items-center gap-3">
              <Skeleton width={56} height={56} className="rounded-[12px]" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton shape="line" width="40%" className="h-2" />
                <Skeleton shape="line" width="75%" />
              </div>
            </div>
            <Skeleton width={80} height={22} className="rounded-full" />
            <Skeleton shape="line" width="60%" />
            <Skeleton shape="line" width="45%" className="h-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Watch: player frame (+ control bar). */
export function WatchSkeleton() {
  return (
    <div className="flex w-full max-w-[1200px] flex-col gap-4">
      <TitleRow action={false} />
      <Skeleton className="aspect-video w-full rounded-[20px]" />
      <div className="flex items-center gap-3">
        <Skeleton shape="circle" width={36} height={36} />
        <Skeleton height={6} className="flex-1 rounded-full" />
        <Skeleton width={120} height={32} className="rounded-[10px] max-md:hidden" />
      </div>
    </div>
  );
}
