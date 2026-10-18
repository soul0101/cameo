import { ArrowSquareOut } from '@phosphor-icons/react';
import { cx } from '@/lib/cx';

export interface ProductLinkProps {
  href: string;
  /** compact = icon only (tight rows); default shows "View product" text beside the icon. */
  compact?: boolean;
  className?: string;
}

/**
 * Quiet secondary link to the brand's product page. Text-3, no background; reads as a link, not a button.
 */
export function ProductLink({ href, compact, className }: ProductLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label="View product on brand site"
      title="View product on brand site"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      draggable={false}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-[6px] text-12 text-text-3 underline-offset-2 transition-colors duration-200 ease-cameo hover:text-text hover:underline focus-visible:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        compact && 'size-7 justify-center hover:bg-surface-3 max-md:size-11',
        className,
      )}
    >
      {!compact && <span>View product</span>}
      <ArrowSquareOut size={14} aria-hidden />
    </a>
  );
}
