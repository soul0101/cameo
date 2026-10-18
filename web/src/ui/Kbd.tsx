import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

/** Keyboard key cap (shortcuts panel, tooltips). */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cx('mono inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-[6px] border border-border-strong bg-surface-2 px-1.5 text-12 leading-none text-text-2', className)}>
      {children}
    </kbd>
  );
}
