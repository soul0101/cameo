import type { CSSProperties } from 'react';
import { cx } from '@/lib/cx';

export interface SkeletonProps {
  className?: string;
  width?: CSSProperties['width'];
  height?: CSSProperties['height'];
  shape?: 'line' | 'block' | 'circle';
}

/** Loading placeholder: a flat panel-2 block with a soft shimmer. Mark the region aria-busy. */
export function Skeleton({ className, width, height, shape = 'block' }: SkeletonProps) {
  return (
    <span
      aria-hidden
      style={{ width, height }}
      className={cx('shimmer block bg-surface-2', shape === 'line' && 'h-2.5 rounded-full', shape === 'block' && 'rounded-[12px]', shape === 'circle' && 'rounded-full', className)}
    />
  );
}
