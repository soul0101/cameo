import { forwardRef } from 'react';
import type { HTMLAttributes } from 'react';
import { cx } from '@/lib/cx';

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** 16 (cards) or 20 (viewer frame, sheets). */
  radius?: 16 | 20;
  /** Padding preset: none, sm 16, md 24, lg 32. */
  pad?: 'none' | 'sm' | 'md' | 'lg';
  /** Hover lift (2 px + shadow) for clickable cards. */
  interactive?: boolean;
  /** Selected: 1 px accent border. */
  selected?: boolean;
  translucent?: boolean;
}

/** Floating surface: --surface, 1 px border, soft shadow, inner top highlight on dark. */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(function Surface(
  { radius = 16, pad = 'none', interactive, selected, translucent, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cx(
        translucent ? 'surface-translucent' : 'surface',
        'relative',
        radius === 20 && 'rounded-[20px]',
        pad === 'sm' && 'p-4',
        pad === 'md' && 'p-6',
        pad === 'lg' && 'p-8',
        interactive && 'lift',
        selected && 'border-accent! shadow-[0_0_0_1px_var(--accent),var(--shadow)]!',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
});
