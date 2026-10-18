import { cloneElement, isValidElement, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '@/lib/cx';
import { useAnchoredPosition } from './anchor';
import type { Side } from './anchor';

export interface TooltipProps {
  content: ReactNode;
  /** Optional shortcut shown in mono after the label. */
  shortcut?: string;
  side?: Side;
  /** Delay before showing on hover (focus shows immediately). */
  delay?: number;
  children: ReactElement<Record<string, unknown>>;
  className?: string;
}

/** Supplementary text only: the trigger must still have its own accessible name. Portaled, so panels never clip it. */
export function Tooltip({ content, shortcut, side = 'top', delay = 400, children, className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const id = useId();
  const pos = useAnchoredPosition(open, anchor, tip, side, 'center', 6);
  const show = (now = false) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), now ? 0 : delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  if (!isValidElement(children)) return children;
  return (
    <span
      ref={anchor}
      className={cx('inline-flex', className)}
      onMouseEnter={() => show()}
      onMouseLeave={hide}
      onFocus={(e) => (e.target as HTMLElement).matches(':focus-visible') && show(true)}
      onBlur={hide}
      onPointerDown={hide}
      onKeyDown={(e) => e.key === 'Escape' && hide()}
    >
      {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      {open &&
        createPortal(
          <span
            ref={tip}
            role="tooltip"
            id={id}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className="animate-fade-in pointer-events-none fixed z-[70] flex h-7 items-center gap-2 rounded-xl border border-hairline-2 bg-panel-3 px-2.5 text-12 font-medium whitespace-nowrap text-text shadow-pop"
          >
            {content}
            {shortcut && <kbd className="mono -mr-1 rounded-[4px] border border-hairline-2 bg-panel px-1 text-11 leading-4 font-normal text-text-2">{shortcut}</kbd>}
          </span>,
          document.body,
        )}
    </span>
  );
}
