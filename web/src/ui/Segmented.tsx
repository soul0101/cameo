import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Required when label is icon-only. */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
  /** Mono labels (markets, codes). */
  mono?: boolean;
  /** Force dark chrome (player controls), independent of the theme. */
  onDark?: boolean;
}

/** 32 px segmented control. Radio-group semantics: one tab stop, arrow keys move and select. */
export function Segmented<T extends string>({ options, value, onChange, label, className, mono, onDark }: SegmentedProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation();
    let next = i;
    for (let k = 0; k < options.length; k++) {
      next = (next + dir + options.length) % options.length;
      if (!options[next].disabled) break;
    }
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx(
        'inline-flex h-8 shrink-0 items-center gap-0.5 rounded-[10px] border p-[3px]',
        onDark ? 'border-white/12 bg-white/5' : 'border-border bg-surface-2',
        className,
      )}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.ariaLabel}
            title={o.title}
            disabled={o.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              'inline-flex h-full min-w-8 items-center justify-center gap-1.5 rounded-[7px] px-2.5 text-13 font-medium [&_svg]:size-4',
              'transition-[background-color,color,box-shadow] duration-200 ease-cameo disabled:opacity-40',
              mono && 'mono',
              selected
                ? onDark
                  ? 'bg-white/15 text-white'
                  : 'bg-surface text-text shadow-[0_1px_3px_rgba(0,0,0,.14),inset_0_0_0_1px_var(--border)]'
                : onDark
                  ? 'text-white/60 hover:text-white'
                  : 'text-text-2 hover:text-text',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
