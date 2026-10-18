import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

/** Step title: one 24/600 verb phrase, an optional 14 --text-2 fact line, optional right-side actions. */
export function StepTitle({ title, fact, actions, className }: { title: string; fact?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cx('flex flex-wrap items-end justify-between gap-x-6 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="text-24 font-semibold tracking-[-0.015em] text-text">{title}</h1>
        {fact && <p className="mt-1 text-14 text-text-2">{fact}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">{actions}</div>}
    </header>
  );
}
