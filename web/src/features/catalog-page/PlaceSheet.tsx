import { useEffect, useId, useMemo, useState } from 'react';
import { CaretDown, Check } from '@phosphor-icons/react';
import { SURFACE_TYPES, getProduct, isAvailable, sceneAffinity } from '@/data/catalog';
import type { CatalogProduct } from '@/data/catalog';
import { materialiseScenes, sceneById, suggestedProducts } from '@/features/scenes/model';
import { cx } from '@/lib/cx';
import { orderBoxes, resolve, usePlacements } from '@/store/placements';
import type { SceneBox } from '@/store/placements';
import { useProject } from '@/store/project';
import type { AudienceId } from '@/store/project';
import { Button, Segmented, Sheet, Thumb, toast } from '@/ui';

/** Placement types a box can physically carry, from its label (sample and Gemini boxes alike), else its surface. */
const LABEL_TYPES: Array<[RegExp, string[]]> = [
  [/delivery|bag|parcel/i, ['delivery_box']],
  [/card stand|standee|counter sign|stand on the counter/i, ['counter_sign']],
  [/fridge|chiller|cooler/i, ['fridge', 'shelf']],
  [/bus shelter|shelter|lit panel/i, ['street_sign', 'billboard', 'poster']],
  [/billboard|hoarding/i, ['billboard', 'street_sign']],
  [/poster|wall|frame/i, ['poster', 'billboard']],
  [/laptop|monitor|computer/i, ['laptop_screen']],
  [/phone|mobile/i, ['phone_screen']],
  [/shelf|cans on the counter|counter/i, ['shelf', 'tabletop']],
  [/cup|mug|table|desk/i, ['tabletop', 'held_item']],
];
function boxTypes(box: SceneBox): string[] {
  const label = `${box.label} ${box.geminiLabel ?? ''}`;
  const hit = LABEL_TYPES.find(([re]) => re.test(label));
  if (hit) return hit[1];
  const surface = box.surface ?? sceneById[box.momentId]?.moment.surface;
  return (surface && SURFACE_TYPES[surface]) || [];
}

interface Row {
  box: SceneBox;
  /** "Box 2" within its scene. */
  n: number;
  sceneName: string;
  thumb: string;
  sceneIndex: number;
  /** Rank of the product among the box's suggestions (0 = best), -1 = not suggested. */
  rank: number;
  /** What the box shows now for the target ("Brewno Matcha Latte"), or null = empty. */
  now: string | null;
  /** The box's surface carries one of the product's placement types, and the scene does not exclude it. */
  fits: boolean;
  /** The box already shows this product for the target. */
  here: boolean;
}

const rankKey = (r: Row) => (r.rank < 0 ? 99 : r.rank);

/**
 * "Place in scenes…": "Where should <product> go?"
 * Lists the boxes the product suits (scene thumb 40, scene name, box label, what is there now),
 * with the top suggestions ticked, and a control "As the default · Only for <audience>". Primary
 * "Place in n boxes" writes defaults (or overrides) through the placements store; one toast, Undo.
 */
export function PlaceSheet({ open, product, audienceId, onClose }: { open: boolean; product: CatalogProduct | null; audienceId: AudienceId | null; onClose: () => void }) {
  const audiences = useProject((s) => s.audiences);
  const boxes = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const [mode, setMode] = useState<'default' | 'only'>('default');
  const [target, setTarget] = useState<AudienceId>('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const selectId = useId();

  // Audiences the product can be placed for (available there, `basedOn` included).
  const eligible = useMemo(() => (product ? audiences.filter((a) => isAvailable(product, a.id, audiences)) : []), [product, audiences]);

  useEffect(() => {
    if (!open || !product) return;
    materialiseScenes();
    setMode('default');
    setTarget(eligible.find((a) => a.id === audienceId)?.id ?? eligible[0]?.id ?? '');
    setShowAll(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product?.id]);

  const forAudience = mode === 'only' ? target || undefined : undefined;

  const rows = useMemo<Row[]>(() => {
    if (!product) return [];
    const out: Row[] = [];
    for (const [momentId, list] of Object.entries(boxes)) {
      const scene = sceneById[momentId];
      if (!scene || scene.copy.kind === 'blocked') continue;
      orderBoxes(list)
        .forEach((box, i) => {
          const suggestions = suggestedProducts(box, 6, forAudience);
          const types = boxTypes(box);
          const aff = sceneAffinity(product, momentId);
          const rank = suggestions.findIndex((p) => p.id === product.id || p.line === product.line);
          // A Gemini pick always fits; otherwise a simple rule: the surface carries the product's type in a scene it suits.
          const fits = rank >= 0 || (types.some((t) => product.placementTypes.includes(t)) && !aff.excluded && aff.words > 0);
          const current = forAudience ? resolve(box.id, forAudience).product : getProduct(assign[box.id]?.default) ?? null;
          out.push({
            box,
            n: i + 1,
            sceneName: scene.copy.name,
            thumb: scene.shot.thumb,
            sceneIndex: scene.index,
            rank,
            fits,
            now: current?.full ?? null,
            here: current?.id === product.id,
          });
        });
    }
    return out.sort((a, b) => a.sceneIndex - b.sceneIndex || a.n - b.n);
  }, [product, boxes, assign, forAudience]);

  // Tick only genuine fits whenever the target changes: boxes whose surface carries one of the
  // product's placement types in a scene it suits, best suggestion rank first, at most four,
  // skipping boxes that already show it.
  useEffect(() => {
    if (!open) return;
    const best = rows
      .filter((r) => !r.here && r.fits)
      .sort((a, b) => rankKey(a) - rankKey(b) || Number(!!a.now) - Number(!!b.now) || a.sceneIndex - b.sceneIndex || a.n - b.n)
      // One box per scene: a scene's other fitting boxes stay listed, unticked.
      .filter((r, i, all) => all.findIndex((x) => x.box.momentId === r.box.momentId) === i)
      .slice(0, 4);
    setTicked(new Set(best.map((r) => r.box.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, product?.id, mode, target]);

  const suited = rows.filter((r) => r.fits).sort((a, b) => rankKey(a) - rankKey(b) || a.sceneIndex - b.sceneIndex || a.n - b.n);
  const others = rows.filter((r) => !r.fits).sort((a, b) => rankKey(a) - rankKey(b) || a.sceneIndex - b.sceneIndex || a.n - b.n);
  const count = [...ticked].filter((id) => rows.some((r) => r.box.id === id && !r.here)).length;
  const targetName = audiences.find((a) => a.id === target)?.name ?? '';

  const toggle = (id: string) =>
    setTicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const place = () => {
    if (!product || !count) return;
    const st = usePlacements.getState();
    const ids = rows.filter((r) => ticked.has(r.box.id) && !r.here).map((r) => r.box.id);
    const before = Object.fromEntries(ids.map((id) => [id, st.assign[id]]));
    const aud = forAudience;
    ids.forEach((id) => (aud ? st.setOverride(id, aud, product.id) : st.setDefault(id, product.id)));
    const n = ids.length;
    toast({
      title: `Placed ${product.full} in ${n} ${n === 1 ? 'box' : 'boxes'}`,
      description: aud ? `Only for ${targetName}` : 'As the default for every audience',
      tone: 'pass',
      action: {
        label: 'Undo',
        onClick: () => {
          const s = usePlacements.getState();
          ids.forEach((id) => {
            const prev = before[id];
            if (aud) {
              const o = prev?.overrides[aud];
              if (o === undefined) s.clearOverride(id, aud);
              else s.setOverride(id, aud, o);
            } else s.setDefault(id, prev?.default ?? null);
          });
        },
      },
    });
    onClose();
  };

  const list = (items: Row[]) => (
    <ul className="flex flex-col gap-1">
      {items.map((r) => {
        const on = r.here || ticked.has(r.box.id);
        return (
          <li key={r.box.id}>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-disabled={r.here || undefined}
              onClick={() => !r.here && toggle(r.box.id)}
              className={cx(
                'flex w-full items-center gap-3 rounded-[12px] px-2 py-2 text-left transition-colors duration-200 ease-cameo max-md:min-h-14',
                r.here ? 'cursor-default' : 'hover:bg-surface-3',
                on && !r.here && 'bg-surface-2',
              )}
            >
              <span
                aria-hidden
                className={cx(
                  'inline-flex size-[18px] shrink-0 items-center justify-center rounded-[6px] border transition-colors duration-200 ease-cameo',
                  r.here ? 'border-border-strong bg-surface-3 text-text-3' : on ? 'border-accent bg-accent text-accent-ink' : 'border-border-strong',
                )}
              >
                {on && <Check size={12} weight="bold" />}
              </span>
              <span className="size-10 shrink-0 overflow-hidden rounded-[8px] bg-surface-2">
                <Thumb src={r.thumb} alt="" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-14 font-medium text-text">{r.sceneName}</span>
                <span className="truncate text-12 text-text-3">
                  Box {r.n} · {r.box.label}
                </span>
              </span>
              <span className={cx('max-w-[42%] shrink-0 truncate text-right text-12', r.here ? 'text-text-3' : r.now ? 'text-text-2' : 'text-text-3')}>
                {r.here ? 'Already here' : r.now ? `Now: ${r.now}` : 'Now: Empty'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <Sheet
      open={open && !!product}
      onClose={onClose}
      title={product ? `Where should ${product.full} go?` : 'Place in scenes'}
      width={480}
      translucent
      header={
        <div className="flex flex-col gap-2.5">
          <Segmented
            label="Place as"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'default', label: 'As the default' },
              { value: 'only', label: targetName ? `Only for ${targetName}` : 'Only for one audience', disabled: !eligible.length },
            ]}
            className="self-start"
          />
          {mode === 'only' && eligible.length > 1 && (
            <div className="flex items-center gap-2 text-13 text-text-2">
              <label htmlFor={selectId}>Audience</label>
              <span className="relative">
                <select
                  id={selectId}
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="h-8 cursor-pointer appearance-none rounded-[10px] border border-border bg-surface-2 pr-8 pl-2.5 text-13 font-medium text-text outline-none hover:border-border-strong focus-visible:border-accent/60"
                >
                  {eligible.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <CaretDown size={12} aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-text-3" />
              </span>
            </div>
          )}
          <p className="text-13 text-text-2">
            {mode === 'default'
              ? 'Every audience sees it, or the brand’s own product where it isn’t sold.'
              : `Only ${targetName} changes; other audiences keep what they have.`}
          </p>
        </div>
      }
      footer={
        <>
          <span className="flex-1 text-13 text-text-3">{suited.length ? `Suits ${suited.length} of ${rows.length} boxes` : ''}</span>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!count}
            onClick={place}
            className="disabled:border disabled:border-border disabled:bg-surface-2 disabled:font-medium disabled:text-text-3 disabled:opacity-100 disabled:shadow-none"
          >
            {count ? `Place in ${count} ${count === 1 ? 'box' : 'boxes'}` : 'Pick boxes'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 px-3 pt-1 pb-5">
        {suited.length > 0 ? (
          <section aria-label="Boxes it suits" className="flex flex-col gap-1.5">
            <h3 className="px-2 text-12 font-medium text-text-3">Suits these boxes</h3>
            <p className="px-2 text-12 text-text-3">Boxes whose surface fits the product type; Gemini&apos;s picks first.</p>
            {list(suited)}
          </section>
        ) : (
          <p className="px-2 pt-2 text-14 text-text-2">No box is a natural fit for {product?.name}. Pick any box below.</p>
        )}
        {others.length > 0 &&
          (showAll || !suited.length ? (
            <section aria-label="Other boxes" className="flex flex-col gap-1.5">
              <h3 className="px-2 text-12 font-medium text-text-3">Other boxes</h3>
              {list(others)}
            </section>
          ) : (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAll(true)}>
              Show {others.length} other {others.length === 1 ? 'box' : 'boxes'}
            </Button>
          ))}
      </div>
    </Sheet>
  );
}
