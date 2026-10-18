import { Prohibit, Warning } from '@phosphor-icons/react';
import { cx } from '@/lib/cx';
import type { ResolveState } from '@/store/placements';

/**
 * Shared look of a resolved (box, audience) for the Table view:
 * inherited (Default, Local) reads muted, an Override reads full with accent, Not placed is
 * dashed, a Gap is amber.
 */

export const STATE_LABEL: Record<ResolveState, string> = { default: 'Default', local: 'Local', override: 'Override', none: 'Not placed', gap: 'Gap' };

export const isInherited = (s: ResolveState) => s === 'default' || s === 'local';

/** 24 px stand-in tile where a packshot would be: dashed for "nothing here", amber for a gap. */
export function EmptyTile({ state, size = 24 }: { state: 'none' | 'gap'; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-[6px] border border-dashed',
        state === 'gap' ? 'border-accent/60 bg-accent-soft text-accent' : 'border-border-strong text-text-3',
      )}
    >
      {state === 'gap' ? <Warning size={13} weight="bold" /> : <Prohibit size={13} />}
    </span>
  );
}
