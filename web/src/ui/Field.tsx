import { forwardRef, useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Leading icon inside the input. */
  icon?: ReactNode;
  /** 28 px (panel filter rows) or 32 px (forms). */
  size_?: 'sm' | 'md';
  /** Ghost: transparent until hover/focus (header search). */
  ghost?: boolean;
}

/** Text input: 4 px radius, hairline, panel-2 fill. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ icon, size_ = 'md', ghost, className, ...rest }, ref) {
  return (
    <span
      className={cx(
        'flex min-w-0 items-center gap-2 rounded-[10px] border px-3 text-text-3',
        'transition-[border-color,background-color,box-shadow] duration-[160ms] ease-cameo [&_svg]:size-4 [&_svg]:shrink-0',
        'focus-within:border-accent/60 focus-within:shadow-[0_0_0_3px_var(--accent-soft)] focus-within:text-text-2',
        ghost ? 'border-transparent bg-transparent hover:bg-panel-2 focus-within:bg-panel-2' : 'border-hairline bg-panel-2 hover:border-hairline-2',
        size_ === 'sm' ? 'h-8' : 'h-9',
        className,
      )}
    >
      {icon}
      <input
        ref={ref}
        className="h-full min-w-0 flex-1 bg-transparent text-14 text-text outline-none placeholder:text-text-3 focus-visible:outline-none"
        {...rest}
      />
    </span>
  );
});

export interface FieldProps extends InputProps {
  label: string;
  hint?: ReactNode;
}

/** Label + input, stacked. */
export function Field({ label, hint, id, className, ...rest }: FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-11 text-text-2">
        {label}
      </label>
      <Input id={inputId} {...rest} />
      {hint && <span className="text-11 text-text-3">{hint}</span>}
    </div>
  );
}
