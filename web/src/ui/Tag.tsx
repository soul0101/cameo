import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

/** Small text tag: "Preview ready", "Preview pending", "Concept", "Skipped". Status, never decoration. */
export type TagTone = 'neutral' | 'pass' | 'accent' | 'reject' | 'muted';

const TONE: Record<TagTone, string> = {
  neutral: 'bg-surface-2 text-text-2 border border-border',
  pass: 'bg-pass/10 text-pass',
  accent: 'bg-accent-soft text-accent',
  reject: 'bg-reject/10 text-reject',
  muted: 'text-text-3 border border-dashed border-border-strong',
};

export function Tag({ tone = 'neutral', icon, children, className }: { tone?: TagTone; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex h-[22px] shrink-0 items-center gap-1 rounded-[7px] px-2 text-12 leading-none font-medium whitespace-nowrap [&_svg]:size-3.5', TONE[tone], className)}>
      {icon}
      {children}
    </span>
  );
}
