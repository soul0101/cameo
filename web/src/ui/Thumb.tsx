import { useState } from 'react';
import type { ImgHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';

/** Image on a flat panel-2 placeholder until it loads (120 ms fade). The parent sizes the box. */
export function Thumb({ className, onLoad, alt = '', ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      alt={alt}
      draggable={false}
      {...rest}
      ref={(el) => {
        if (el?.complete && el.naturalWidth > 0 && !loaded) setLoaded(true);
      }}
      onLoad={(e) => {
        setLoaded(true);
        onLoad?.(e);
      }}
      className={cx('h-full w-full bg-panel-2 object-cover transition-opacity duration-[120ms] ease-cameo', loaded ? 'opacity-100' : 'opacity-0', className)}
    />
  );
}
