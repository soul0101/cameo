import type { CSSProperties } from 'react';
import { cx } from '@/lib/cx';

/**
 * Product media pieces. A **well** is a soft light stage (`--media-bg`, a touch dimmer
 * in dark so it never glares); the image sits on it with `multiply`, so white and light-grey
 * packshot backgrounds melt into the stage and the product reads as one clean tile.
 */
export const wellClass = 'relative overflow-hidden bg-[var(--media-bg)] shadow-[var(--media-ring)]';

// A small lift pushes grey studio backdrops (#e0e0e0-ish) to white, so `multiply` melts them into the stage too.
const plateStyle: CSSProperties = { boxShadow: 'var(--plate-shadow)', filter: 'brightness(1.12) contrast(1.05)' };

export function Plate({
  src,
  alt,
  fill = 0.86,
  radius = 8,
  lazy = false,
  className,
  style,
}: {
  src: string;
  alt: string;
  /** Share of the well the plate may take (0.8 = ~10% padding each side). */
  fill?: number;
  radius?: number;
  lazy?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const pct = `${Math.round(fill * 100)}%`;
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      loading={lazy ? 'lazy' : undefined}
      decoding="async"
      style={{ ...plateStyle, maxWidth: pct, maxHeight: pct, borderRadius: radius, ...style }}
      className={cx('absolute inset-0 m-auto h-auto w-auto object-contain mix-blend-multiply select-none', className)}
    />
  );
}
