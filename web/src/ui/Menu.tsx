import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { createPortal } from 'react-dom';
import { Check } from '@phosphor-icons/react';
import { cx } from '@/lib/cx';
import { useLayer } from '@/lib/layers';
import { useAnchoredPosition } from './anchor';
import type { Align, Side } from './anchor';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchor: React.RefObject<HTMLElement | null>;
  side?: Side;
  align?: Align;
  children: ReactNode;
  className?: string;
  /** Accessible role of the floating surface. */
  role?: 'dialog' | 'menu';
  label?: string;
}

/** Floating surface: 12 px radius, hairline, layered shadow. Closes on outside click and Esc. */
export function Popover({ open, onClose, anchor, side = 'bottom', align = 'start', children, className, role = 'dialog', label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(open, anchor, ref, side, align);
  const isTop = useLayer(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) {
        e.stopPropagation();
        onClose();
        anchor.current?.querySelector<HTMLElement>('button')?.focus();
        if (anchor.current instanceof HTMLButtonElement) anchor.current.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, anchor]);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      role={role}
      aria-label={label}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className={cx('animate-fade-in fixed z-[60] min-w-44 rounded-xl border border-hairline-2 bg-panel-2 p-1.5 text-13 shadow-pop', className)}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Mono hint at the right (shortcut, value). */
  hint?: ReactNode;
  /** Radio/check state; shows a check glyph. */
  checked?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

export interface MenuProps {
  /** Render the trigger; spread the given props onto a button. */
  trigger: (props: {
    ref: Ref<HTMLButtonElement>;
    onClick: () => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls': string;
  }) => ReactNode;
  items: Array<MenuItem | 'divider'>;
  label: string;
  side?: Side;
  align?: Align;
}

/** Menu button with roving focus (↑/↓, Home/End, Enter, Esc). */
export function Menu({ trigger, items, label, side = 'bottom', align = 'start' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      const els = list.current?.parentElement?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
      const checked = Array.from(els ?? []).find((el) => el.getAttribute('aria-checked') === 'true');
      (checked ?? els?.[0])?.focus();
    });
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key === 'Tab') close();
  };

  return (
    <>
      {trigger({ ref: btn, onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id })}
      <Popover open={open} onClose={close} anchor={btn} side={side} align={align} role="menu" label={label}>
        <div ref={list} id={id} onKeyDown={onKey} className="flex flex-col">
          {items.map((it, i) =>
            it === 'divider' ? (
              <div key={`d${i}`} role="separator" className="-mx-1.5 my-1.5 h-px bg-hairline" />
            ) : (
              <button
                key={it.id}
                type="button"
                role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={it.checked}
                aria-disabled={it.disabled || undefined}
                tabIndex={-1}
                onClick={() => {
                  if (it.disabled) return;
                  it.onSelect?.();
                  close();
                  btn.current?.focus();
                }}
                className={cx(
                  'flex h-8 items-center gap-2.5 rounded-md px-2 text-left text-13 text-text outline-none [&_svg]:size-4',
                  'transition-colors duration-[120ms] ease-cameo hover:bg-panel-3 focus-visible:bg-panel-3 focus-visible:outline-none',
                  it.disabled && 'text-text-3',
                )}
              >
                {it.icon && <span className="text-text-2">{it.icon}</span>}
                <span className="flex-1">{it.label}</span>
                {it.hint && <span className="mono text-11 text-text-3">{it.hint}</span>}
                {it.checked !== undefined && <Check aria-hidden weight="bold" className={cx('text-accent', !it.checked && 'invisible')} />}
              </button>
            ),
          )}
        </div>
      </Popover>
    </>
  );
}
