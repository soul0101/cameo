import { cx } from '@/lib/cx';

/** On/off switch, 36×20 (44 px hit area on phones). Accent track when on. Needs an accessible name. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name ("India version"). */
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'group/sw relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ease-cameo disabled:opacity-40',
        'before:absolute before:-inset-3 before:content-[""] md:before:-inset-1.5',
        checked ? 'bg-accent' : 'bg-surface-3 shadow-[inset_0_0_0_1px_var(--border-strong)]',
        className,
      )}
    >
      <span
        aria-hidden
        className={cx(
          'absolute top-0.5 left-0.5 size-4 rounded-full shadow-[0_1px_2px_rgba(0,0,0,.3)] transition-transform duration-200 ease-cameo',
          checked ? 'translate-x-4 bg-accent-ink' : 'bg-text-2',
        )}
      />
    </button>
  );
}
