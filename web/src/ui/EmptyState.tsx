import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { Surface } from './Surface';

/**
 * A page's empty state: what's missing, and a way to the
 * section that provides it. Centred on a 20 px surface, same as Watch's "Nothing rendered yet".
 */
export function EmptyState({ title, body, actions, className }: { title: string; body?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <Surface radius={20} pad="md" className={cx('flex flex-col items-center gap-3 py-16 text-center max-md:py-12', className)}>
      <p className="text-16 font-semibold text-text">{title}</p>
      {body && <p className="max-w-[44ch] text-14 text-text-2">{body}</p>}
      {actions && <div className="mt-2 flex flex-wrap justify-center gap-2">{actions}</div>}
    </Surface>
  );
}
