import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export type Side = 'top' | 'bottom' | 'left' | 'right';
export type Align = 'start' | 'center' | 'end';

/** Fixed-position coordinates for a floating element next to an anchor, flipped to stay on screen. */
export function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  floating: RefObject<HTMLElement | null>,
  side: Side,
  align: Align,
  gap = 6,
) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const f = floating.current;
      if (!a || !f) return;
      const fw = f.offsetWidth;
      const fh = f.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const room = {
        bottom: vh - a.bottom - gap - fh >= 0,
        top: a.top - gap - fh >= 0,
        right: vw - a.right - gap - fw >= 0,
        left: a.left - gap - fw >= 0,
      };
      const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
      // Preferred side, else its opposite, else the other axis (below, then above).
      const order: Side[] = [side, opposite[side], ...(side === 'left' || side === 'right' ? (['bottom', 'top'] as Side[]) : (['right', 'left'] as Side[]))];
      const s = order.find((x) => room[x]) ?? (side === 'left' || side === 'right' ? 'bottom' : side);
      let top = 0;
      let left = 0;
      if (s === 'bottom' || s === 'top') {
        top = s === 'bottom' ? a.bottom + gap : a.top - gap - fh;
        left = align === 'start' ? a.left : align === 'end' ? a.right - fw : a.left + a.width / 2 - fw / 2;
      } else {
        left = s === 'right' ? a.right + gap : a.left - gap - fw;
        top = align === 'start' ? a.top : align === 'end' ? a.bottom - fh : a.top + a.height / 2 - fh / 2;
      }
      setPos({ top: Math.max(4, Math.min(top, vh - fh - 4)), left: Math.max(4, Math.min(left, vw - fw - 4)) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, floating, side, align, gap]);
  return pos;
}
