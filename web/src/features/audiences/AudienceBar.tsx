import { useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowElbowDownRight, DotsThree, PencilSimple, Plus, Shapes, ShoppingBagOpen, Trash, UsersFour } from '@phosphor-icons/react';
import { cx } from '@/lib/cx';
import { usePlacements } from '@/store/placements';
import { useProject } from '@/store/project';
import type { Audience, AudienceId, AudienceKind } from '@/store/project';
import { ConfirmDialog, Menu, toast } from '@/ui';
import { AddAudiencePopover } from './AddAudiencePopover';
import type { AudienceFormFocus } from './AddAudiencePopover';
import { AUDIENCE_KINDS, basisOf, dependantsOf } from './model';

/** The audience's kind icon at 16 (or `size`). */
export function AudienceIcon({ kind, size = 16, className }: { kind: AudienceKind; size?: number; className?: string }) {
  const K = AUDIENCE_KINDS[kind].icon;
  return <K size={size} aria-hidden className={className} />;
}

/** "All" item value (`includeAll`). */
export const ALL_AUDIENCES = 'all';

export interface AudienceBarProps {
  /** Active audience id, or 'all' with `includeAll`. */
  value: AudienceId;
  onChange: (id: AudienceId) => void;
  /** Accessible name of the group (default "Audience"). */
  label?: string;
  /** "All" as the first item (Catalog filter); its value is 'all'. */
  includeAll?: boolean;
  /** Build pages: a quiet "+ Audience" at the end and a ⋯ menu per item (Rename, Change kind, Remove). */
  manage?: boolean;
  /** 28 px items for the Scenes timeline. */
  compact?: boolean;
  /** Only these audiences (Watch: the rendered ones). Default: every audience. */
  audiences?: Audience[];
  /** Hovering an item (Scenes: preview that audience on the video). */
  onHover?: (id: AudienceId | null) => void;
  className?: string;
}

const VISIBLE = 5;

/**
 * The one audience control: kind icon 16 + full name, 32 px, radius 10,
 * the active item `--surface-3` + `--text`. More than 5 audiences overflow into a "+n" menu (the
 * active one always stays visible). Radio-group semantics: one tab stop, arrow keys move and select.
 */
export function AudienceBar({ value, onChange, label = 'Audience', includeAll, manage, compact, audiences: only, onHover, className }: AudienceBarProps) {
  const all = useProject((s) => s.audiences);
  const list = only ?? all;
  const addRef = useRef<HTMLButtonElement>(null);
  const editAnchor = useRef<HTMLElement | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<{ audience: Audience; focus: AudienceFormFocus } | null>(null);
  const [removing, setRemoving] = useState<Audience | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const items = useMemo(() => {
    let shown = list.slice(0, VISIBLE);
    const active = list.find((a) => a.id === value);
    if (active && !shown.includes(active)) shown = [...shown.slice(0, VISIBLE - 1), active];
    return { shown, rest: list.filter((a) => !shown.includes(a)) };
  }, [list, value]);

  const order: AudienceId[] = [...(includeAll ? [ALL_AUDIENCES] : []), ...items.shown.map((a) => a.id)];
  const focusable = order.includes(value) ? value : order[0];

  const onKey = (e: KeyboardEvent, id: AudienceId) => {
    const i = order.indexOf(id);
    const to =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? order.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation();
    const next = order[(to + order.length) % order.length];
    onChange(next);
    refs.current[next]?.focus();
  };

  const h = compact ? 'h-7 text-12 [&_svg]:size-[14px]' : 'h-8 text-13';

  const item = (id: AudienceId, name: string, kind: AudienceKind | null, a?: Audience) => {
    const on = value === id;
    const basis = basisOf(a, all);
    const hint = [name, a?.note, basis && `Based on ${basis.name}`].filter(Boolean).join(' · ');
    return (
      <span
        key={id}
        className={cx('group/aud relative flex shrink-0 items-center rounded-[10px] transition-colors duration-200 ease-cameo', on ? 'bg-surface-3' : 'hover:bg-surface-2')}
        ref={(el) => {
          if (a && editing?.audience.id === a.id) editAnchor.current = el;
        }}
        data-audience={id}
      >
        <button
          ref={(el) => {
            refs.current[id] = el;
          }}
          type="button"
          role="radio"
          aria-checked={on}
          tabIndex={id === focusable ? 0 : -1}
          onClick={() => onChange(id)}
          onKeyDown={(e) => onKey(e, id)}
          onPointerEnter={() => onHover?.(id)}
          onPointerLeave={() => onHover?.(null)}
          title={a && hint !== name ? hint : undefined}
          aria-description={basis ? `Based on ${basis.name}` : undefined}
          className={cx(
            'flex max-w-[200px] min-w-0 items-center gap-1.5 rounded-[10px] px-2.5 font-medium whitespace-nowrap max-md:h-11',
            h,
            on ? 'text-text' : 'text-text-2 hover:text-text',
            // Room for the ⋯; on touch screens only the active item carries it (more names fit).
            manage && a && (on ? 'pr-7 max-md:pr-11' : 'pr-7 max-md:pr-2.5'),
          )}
        >
          {kind ? <AudienceIcon kind={kind} size={compact ? 14 : 16} className={on ? 'text-accent' : 'text-text-3'} /> : <UsersFour size={compact ? 14 : 16} aria-hidden className={on ? 'text-accent' : 'text-text-3'} />}
          <span className="truncate">{name}</span>
        </button>
        {manage && a && (
          <Menu
            label={`${a.name} options`}
            align="end"
            items={[
              ...(basis ? [{ id: 'basis', label: `Based on ${basis.name}`, icon: <ArrowElbowDownRight />, disabled: true }, 'divider' as const] : []),
              { id: 'rename', label: 'Rename', icon: <PencilSimple />, onSelect: () => setEditing({ audience: a, focus: 'name' }) },
              { id: 'kind', label: 'Change kind', icon: <Shapes />, onSelect: () => setEditing({ audience: a, focus: 'kind' }) },
              { id: 'from', label: 'Sees products from…', icon: <ShoppingBagOpen />, onSelect: () => setEditing({ audience: a, focus: 'basis' }) },
              'divider',
              { id: 'remove', label: 'Remove', icon: <Trash />, disabled: all.length <= 1, onSelect: () => setRemoving(a) },
            ]}
            trigger={(props) => (
              <button
                {...props}
                type="button"
                tabIndex={on ? 0 : -1}
                aria-label={`${a.name} options`}
                className={cx(
                  'absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-[7px] text-text-3 transition-[opacity,background-color,color] duration-200 ease-cameo hover:bg-surface-3 hover:text-text max-md:size-10',
                  on ? 'opacity-70 group-hover/aud:opacity-100' : 'opacity-0 group-hover/aud:opacity-100 focus-visible:opacity-100',
                  on ? 'max-md:opacity-100' : 'max-md:hidden',
                  props['aria-expanded'] && 'bg-surface-3 text-text opacity-100',
                )}
              >
                <DotsThree size={16} weight="bold" />
              </button>
            )}
          />
        )}
      </span>
    );
  };

  return (
    <div className={cx('flex min-w-0 items-center gap-1', className)}>
      <div role="radiogroup" aria-label={label} className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto">
        {includeAll && item(ALL_AUDIENCES, 'All', null)}
        {items.shown.map((a) => item(a.id, a.name, a.kind, a))}
      </div>
      {items.rest.length > 0 && (
        <Menu
          label="More audiences"
          align="end"
          items={items.rest.map((a) => ({ id: a.id, label: a.name, icon: <AudienceIcon kind={a.kind} />, checked: value === a.id, onSelect: () => onChange(a.id) }))}
          trigger={(props) => (
            <button
              {...props}
              type="button"
              aria-label={`${items.rest.length} more audiences`}
              className={cx('mono shrink-0 rounded-[10px] px-2.5 font-medium text-text-2 transition-colors duration-200 ease-cameo hover:bg-surface-2 hover:text-text max-md:h-11', h)}
            >
              +{items.rest.length}
            </button>
          )}
        />
      )}
      {manage && (
        <button
          ref={addRef}
          type="button"
          onClick={() => setAdding(true)}
          aria-haspopup="dialog"
          aria-expanded={adding}
          className={cx('inline-flex shrink-0 items-center gap-1 rounded-[10px] px-2.5 font-medium text-text-3 transition-colors duration-200 ease-cameo hover:bg-surface-2 hover:text-text max-md:h-11', h)}
        >
          <Plus size={compact ? 12 : 14} aria-hidden /> Audience
        </button>
      )}
      {manage && (
        <>
          <AddAudiencePopover open={adding} onClose={() => setAdding(false)} anchor={addRef} onSaved={(a) => onChange(a.id)} />
          <AddAudiencePopover open={!!editing} onClose={() => setEditing(null)} anchor={editAnchor} audience={editing?.audience} focus={editing?.focus} />
          <RemoveAudienceDialog audience={removing} onClose={() => setRemoving(null)} onRemoved={(id) => value === id && onChange(includeAll ? ALL_AUDIENCES : (all.find((a) => a.id !== id)?.id ?? ''))} />
        </>
      )}
    </div>
  );
}

/** Confirm removing an audience: says what goes with it (overrides, product availability). */
function RemoveAudienceDialog({ audience, onClose, onRemoved }: { audience: Audience | null; onClose: () => void; onRemoved: (id: AudienceId) => void }) {
  const assign = usePlacements((s) => s.assign);
  const products = useProject((s) => s.products);
  const audiences = useProject((s) => s.audiences);
  const id = audience?.id ?? '';
  const dependants = audience ? dependantsOf(id, audiences) : [];
  const nextBasis = basisOf(audience, audiences);
  const names = (list: Audience[]) => (list.length <= 2 ? list.map((a) => a.name).join(' and ') : `${list[0].name} and ${list.length - 1} more`);
  const overrides = Object.values(assign).filter((a) => a.overrides[id] !== undefined).length;
  const only = products.filter((p) => p.availableIn !== 'all' && p.availableIn.includes(id));
  const lost = only.filter((p) => p.availableIn !== 'all' && p.availableIn.length === 1).length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const one = dependants.length === 1;
  const parts = [
    'Its versions of every scene leave the episode.',
    overrides ? `${plural(overrides, 'box override')} for it ${overrides === 1 ? 'is' : 'are'} dropped.` : '',
    only.length
      ? lost === only.length
        ? `${plural(only.length, 'product')} sold only there ${only.length === 1 ? 'reaches' : 'reach'} no audience after this.`
        : `${plural(only.length, 'product')} stop listing it${lost ? `; ${lost} then reach no audience` : ''}.`
      : '',
    dependants.length
      ? `${names(dependants)} ${one ? 'is' : 'are'} based on it and will ${nextBasis ? `see products from ${nextBasis.name}` : `see only ${one ? 'its' : 'their'} own products`}.`
      : '',
  ].filter(Boolean);
  return (
    <ConfirmDialog
      open={!!audience}
      title={`Remove ${audience?.name ?? 'audience'}?`}
      description={parts.join(' ')}
      confirmLabel="Remove audience"
      onCancel={onClose}
      onConfirm={() => {
        if (audience) {
          useProject.getState().removeAudience(audience.id);
          toast({ title: `Removed ${audience.name}` });
          onRemoved(audience.id);
        }
        onClose();
      }}
    />
  );
}
