import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';

/**
 * Soft-tint chip: text colour + 12 % tint of it, radius 6, 11 px 500.
 * `tone` carries meaning (status); `neutral` is a tag on --panel-2. Never decorative, never a dot.
 */
export type ChipTone = 'pass' | 'reject' | 'accent' | 'neutral' | 'muted' | 'dashed';

const TONE: Record<ChipTone, string> = {
  pass: 'text-pass bg-pass/12',
  reject: 'text-reject bg-reject/12',
  accent: 'text-accent bg-accent-soft',
  neutral: 'text-text-2 bg-surface-2 border border-border',
  muted: 'text-text-2 bg-text-2/10',
  dashed: 'text-text-3 border border-dashed border-hairline-2',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
  icon?: ReactNode;
  /** Mono label (codes, counts). */
  mono?: boolean;
}

export function Chip({ tone = 'neutral', icon, mono, className, children, ...rest }: ChipProps) {
  return (
    <span
      className={cx(
        'inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] px-2 text-12 leading-none font-medium whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
        mono && 'mono',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}
