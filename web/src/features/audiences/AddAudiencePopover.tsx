import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { CaretUpDown } from '@phosphor-icons/react';
import { indexOf } from '@/data/catalog';
import { cx } from '@/lib/cx';
import { usePlacements } from '@/store/placements';
import { useProject } from '@/store/project';
import type { Audience, AudienceId, AudienceKind } from '@/store/project';
import { Button, Input, Popover, toast } from '@/ui';
import { AUDIENCE_KINDS, AUDIENCE_KIND_ORDER, basisOptions, defaultBasedOn } from './model';

/** Which field takes focus when the form opens (the bar's ⋯ menu: Rename → name, Change kind → kind). */
export type AudienceFormFocus = 'name' | 'kind' | 'basis';

const OWN = '';

/**
 * "New audience" popover: anchored,
 * 340 wide. Six kind chips (Place selected), the name (placeholder follows the kind), an optional
 * "Who sees it" line, "Sees products from" (the other audiences or "Its own products only"; the
 * default follows the kind until the user picks one) and a fact line under it ("Every box starts
 * like India (9 boxes)"). Primary "Add audience", one toast. With `audience` it edits that audience.
 */
export function AddAudiencePopover({
  open,
  onClose,
  anchor,
  audience,
  focus = 'name',
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  /** Edit this audience; absent = add a new one. */
  audience?: Audience | null;
  focus?: AudienceFormFocus;
  /** After saving (the new or edited audience; `added` = it is new). */
  onSaved?: (a: Audience, added: boolean) => void;
}) {
  const audiences = useProject((s) => s.audiences);
  const products = useProject((s) => s.products);
  const boxList = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const [kind, setKind] = useState<AudienceKind>('place');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [basis, setBasis] = useState<AudienceId>(OWN);
  /** The user picked "Sees products from" themselves: a kind change no longer moves it. */
  const [basisTouched, setBasisTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const basisRef = useRef<HTMLSelectElement>(null);
  const kindRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const titleId = useId();
  const nameId = useId();
  const noteId = useId();
  const basisId = useId();
  const factId = useId();

  useEffect(() => {
    if (!open) return;
    const k = audience?.kind ?? 'place';
    setKind(k);
    setName(audience?.name ?? '');
    setNote(audience?.note ?? '');
    setBasis(audience ? (audience.basedOn ?? OWN) : (defaultBasedOn(k, useProject.getState().audiences) ?? OWN));
    setBasisTouched(!!audience);
    const raf = requestAnimationFrame(() => {
      if (focus === 'kind') kindRefs.current[AUDIENCE_KIND_ORDER.indexOf(k)]?.focus();
      else if (focus === 'basis') basisRef.current?.focus();
      else {
        nameRef.current?.focus();
        nameRef.current?.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, audience, focus]);

  const options = useMemo(() => basisOptions(audience?.id, audiences), [audience?.id, audiences]);
  const basisAudience = audiences.find((a) => a.id === basis);

  /** Boxes, and how many would show something for an audience that sees only its own products. */
  const boxes = useMemo(() => {
    const ix = indexOf(products);
    const list = Object.values(boxList)
      .flat();
    const filled = list.filter((b) => {
      const d = ix.byId[assign[b.id]?.default ?? ''];
      if (!d) return false;
      return d.availableIn === 'all' || (ix.byBrand[d.brand.trim().toLowerCase()] ?? []).some((x) => x.availableIn === 'all');
    }).length;
    return { total: list.length, filled };
  }, [boxList, assign, products]);

  const trimmed = name.trim();
  const taken = audiences.some((a) => a.id !== audience?.id && a.name.trim().toLowerCase() === trimmed.toLowerCase());
  const valid = trimmed.length > 0 && !taken;
  const changed =
    !audience || trimmed !== audience.name || kind !== audience.kind || note.trim() !== (audience.note ?? '') || basis !== (audience.basedOn ?? OWN);

  const who = trimmed || 'this audience';
  const n = boxes.total;
  const boxesWord = `${n} ${n === 1 ? 'box' : 'boxes'}`;
  const fact = basisAudience
    ? audience
      ? `Every box follows ${basisAudience.name} (${boxesWord})`
      : `Every box starts like ${basisAudience.name} (${boxesWord})`
    : boxes.filled === 0
      ? `Starts empty: add products available in ${who}`
      : boxes.filled >= n
        ? `Starts with the default product in every box (${boxesWord})`
        : `${boxes.filled} of ${boxesWord} start filled: add products available in ${who} for the rest`;

  const close = () => {
    onClose();
    anchor.current?.focus();
  };

  const submit = () => {
    if (!valid) {
      nameRef.current?.focus();
      return;
    }
    const s = useProject.getState();
    const basedOn = basis || undefined;
    if (audience) {
      if (changed) {
        const renamed = audience.name !== trimmed;
        s.updateAudience(audience.id, { name: trimmed, kind, note: note.trim(), basedOn });
        const next = useProject.getState().audiences.find((a) => a.id === audience.id)!;
        toast({ title: renamed ? `Renamed to ${next.name}` : `Saved ${next.name}`, tone: 'pass' });
        onSaved?.(next, false);
      }
    } else {
      const a = s.addAudience({ name: trimmed, kind, note: note.trim(), basedOn });
      toast({ title: `Added ${a.name}`, tone: 'pass' });
      onSaved?.(a, true);
    }
    close();
  };

  const pickKind = (k: AudienceKind) => {
    setKind(k);
    if (!basisTouched) setBasis(defaultBasedOn(k, audiences, audience?.id) ?? OWN);
  };

  const onKindKey = (e: React.KeyboardEvent, i: number) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (i + dir + AUDIENCE_KIND_ORDER.length) % AUDIENCE_KIND_ORDER.length;
    pickKind(AUDIENCE_KIND_ORDER[next]);
    kindRefs.current[next]?.focus();
  };

  const field = 'flex flex-col gap-1.5';
  const label = 'text-13 font-medium text-text-2';

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} label={audience ? `Edit ${audience.name}` : 'New audience'} className="w-[340px] max-w-[calc(100vw-32px)] p-4!">
      <form
        aria-labelledby={titleId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-4"
      >
        <h2 id={titleId} className="text-14 font-semibold text-text">
          {audience ? 'Edit audience' : 'New audience'}
        </h2>
        <div role="radiogroup" aria-label="Kind" className="flex flex-wrap gap-1.5">
          {AUDIENCE_KIND_ORDER.map((k, i) => {
            const K = AUDIENCE_KINDS[k];
            const on = kind === k;
            return (
              <button
                key={k}
                ref={(el) => {
                  kindRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => pickKind(k)}
                onKeyDown={(e) => onKindKey(e, i)}
                className={cx(
                  'inline-flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-13 font-medium transition-[background-color,color,border-color] duration-200 ease-cameo max-md:h-11',
                  on ? 'border-accent/40 bg-accent-soft text-text' : 'border-border bg-surface-2/60 text-text-2 hover:bg-surface-3 hover:text-text',
                )}
              >
                <K.icon size={16} aria-hidden className={on ? 'text-accent' : undefined} />
                {K.label}
              </button>
            );
          })}
        </div>
        <div className={field}>
          <label htmlFor={nameId} className={label}>
            Name
          </label>
          <Input
            ref={nameRef}
            id={nameId}
            value={name}
            placeholder={AUDIENCE_KINDS[kind].placeholder}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={taken || undefined}
            aria-describedby={taken ? `${nameId}-err` : undefined}
            autoComplete="off"
            className="max-md:h-11"
          />
          {taken && (
            <p id={`${nameId}-err`} className="text-12 text-reject">
              An audience with this name exists.
            </p>
          )}
        </div>
        <div className={field}>
          <label htmlFor={noteId} className={label}>
            Who sees it <span className="font-normal text-text-3">(optional)</span>
          </label>
          <Input id={noteId} value={note} placeholder="One line" onChange={(e) => setNote(e.target.value)} autoComplete="off" className="max-md:h-11" />
        </div>
        <div className={field}>
          <label htmlFor={basisId} className={label}>
            Sees products from
          </label>
          <div className="relative">
            <select
              ref={basisRef}
              id={basisId}
              value={basis}
              aria-describedby={factId}
              onChange={(e) => {
                setBasis(e.target.value);
                setBasisTouched(true);
              }}
              className={cx(
                'h-9 w-full cursor-pointer appearance-none rounded-[10px] border border-border bg-surface-2 pr-9 pl-3 text-14 text-text outline-none max-md:h-11',
                'transition-[border-color,background-color] duration-200 ease-cameo hover:border-border-strong focus-visible:border-accent/60',
              )}
            >
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
              <option value={OWN}>Its own products only</option>
            </select>
            <CaretUpDown size={14} aria-hidden className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-text-3" />
          </div>
          <p id={factId} className="text-12 text-text-3">
            {fact}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} className="max-md:h-11">
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!valid}
            className="max-md:h-11 disabled:border disabled:border-border disabled:bg-surface-2 disabled:font-medium disabled:text-text-3 disabled:opacity-100 disabled:shadow-none"
          >
            {audience ? 'Save' : 'Add audience'}
          </Button>
        </div>
      </form>
    </Popover>
  );
}
