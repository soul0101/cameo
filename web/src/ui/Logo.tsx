import { cx } from '@/lib/cx';

/** The Cameo mark: a circle with an off-centre dot. Inherits currentColor (neutral, never amber). */
export function LogoMark({ size = 16, className, title = 'Cameo' }: { size?: number; className?: string; title?: string | null }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={cx('shrink-0', className)}
      role={title ? 'img' : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
    >
      <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="20.5" cy="12.5" r="4" fill="currentColor" />
    </svg>
  );
}
