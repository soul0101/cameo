import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '@/lib/cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** sm 30 px (inside cards) · md 36 px (default) · lg 44 px (hero CTA). Radius 10. */
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon (Phosphor element; sized by the button). */
  icon?: ReactNode;
  /** Trailing content (arrow, shortcut hint). */
  trailing?: ReactNode;
  /** Icon-only button: square, requires aria-label. */
  iconOnly?: boolean;
  loading?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-ink font-semibold hover:bg-accent-hover shadow-[inset_0_1px_0_rgba(255,255,255,.28),0_1px_2px_rgba(0,0,0,.2)]',
  secondary: 'bg-surface-2 text-text border border-border hover:bg-surface-3 hover:border-border-strong',
  ghost: 'text-text-2 hover:text-text hover:bg-surface-3',
  danger: 'text-reject bg-surface-2 border border-border hover:border-reject/40 hover:bg-reject/8',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-[30px] px-3 gap-1.5 text-13 [&_svg]:size-4',
  md: 'h-9 px-4 gap-2 text-14 [&_svg]:size-[18px]',
  lg: 'h-11 px-5 gap-2 text-14 [&_svg]:size-5',
};
const squares: Record<ButtonSize, string> = { sm: 'size-[30px] [&_svg]:size-4', md: 'size-9 [&_svg]:size-[18px]', lg: 'size-11 [&_svg]:size-5' };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, trailing, iconOnly, loading, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'group/btn relative inline-flex shrink-0 items-center justify-center rounded-[10px] font-medium whitespace-nowrap select-none',
        'transition-[background-color,color,border-color,opacity,transform,box-shadow] duration-200 ease-cameo active:scale-[.98]',
        'disabled:pointer-events-none disabled:opacity-40 [&_svg]:shrink-0',
        variants[variant],
        iconOnly ? squares[size] : sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <span aria-hidden className="size-4 animate-spin-slow rounded-full border-2 border-current border-r-transparent" /> : icon}
      {!iconOnly && children}
      {!iconOnly && trailing && <span className="inline-flex transition-transform duration-200 ease-cameo group-hover/btn:translate-x-0.5">{trailing}</span>}
    </button>
  );
});
