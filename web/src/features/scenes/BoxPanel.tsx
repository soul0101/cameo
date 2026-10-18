import { useEffect, useRef, useState } from 'react';
import { getDetected, visionObjects, episodeAspect } from '@/data/detected';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CaretRight, ArrowCounterClockwise, ArrowsLeftRight, ArrowsOut, CheckCircle, CircleNotch, MagnifyingGlass, Plus, Prohibit, Sparkle, Trash, X } from '@phosphor-icons/react';
import { identifyBox } from './identify';
import { liveIndex } from '@/data/catalog';
import type { Box } from '@/data/types';
import type { Audience } from '@/store/project';
import { AudienceBar } from '@/features/audiences/AudienceBar';
import { useAudiences } from '@/features/audiences/model';
import { ProductPickerSheet } from '@/features/audiences/ProductPickerSheet';
import { cx } from '@/lib/cx';
import { EASE } from '@/lib/motion';
import { resolveWith, usePlacements, useResolved } from '@/store/placements';
import type { SceneBox } from '@/store/placements';
import { Button, ConfirmDialog, Packshot, toast } from '@/ui';
import { openProduct } from '@/ui/ProductModal';
import { assignFor, assignLine } from './assign';
import { pickWhy, sceneById, suggestedProducts, useLiveCopy, useSceneBoxes, useSpots } from './model';
import { useScenesUI } from './state';


/**
 * Boxes panel: what goes where, one audience at a time.
 * Audience tabs at the top (the same state as the timeline's "On video"), then one card per box:
 * number, Gemini's label, a crop of the box, and a single product slot for the active audience
 * (an 88 px row: 64 px packshot, name, brand, Swap, View). Swap opens the picker sheet. No prompts here.
 * Hovering a card highlights its box on the video; clicking a box on the video selects its card.
 */
/** How a product appears in a drawn spot, as Gemini read it. */
const EDIT_LABEL = { replace: 'Replace the object with a product', place: 'Place a product here', display: 'Show the product on this surface' } as const;

export function BoxPanel({ className }: { className?: string }) {
  const sceneId = useScenesUI((s) => s.sceneId);
  const drawing = useScenesUI((s) => s.drawing);
  const setDrawing = useScenesUI((s) => s.setDrawing);
  const viewVersion = useScenesUI((s) => s.viewVersion);
  const setViewVersion = useScenesUI((s) => s.setViewVersion);
  const audiences = useAudiences();
  const audience = audiences.find((a) => a.id === viewVersion) ?? audiences[0];
  const boxes = useSceneBoxes(sceneId);
  const { main, more, numberOf } = useSpots(sceneId);
  const moreOpen = useScenesUI((s) => s.moreOpen);
  const setMoreOpen = useScenesUI((s) => s.setMoreOpen);
  const reduce = useReducedMotion();
  const copy = useLiveCopy(sceneId);
  const kind = copy.kind;
  const seen = visionObjects(getDetected(), sceneById[sceneId]?.shot.id ?? sceneId);
  const spots = main.length;
  const placedHere = usePlacements((s) => (audience ? main.filter((b) => resolveWith(s.assign[b.id], audience.id, liveIndex()).product).length : 0));

  return (
    <section aria-label="Boxes in this scene" className={cx('@container flex min-h-0 flex-col', className)}>
      <header className="flex h-9 shrink-0 items-center gap-2 pl-1">
        <h2 className="min-w-0 truncate text-14 font-semibold text-text">
          {kind === 'blocked' ? 'This scene' : 'Spots'}
          {kind !== 'blocked' && audience && spots > 0 && (
            <span className={cx('font-normal', placedHere === spots ? 'text-pass' : 'text-text-3')}>
              {' '}· {placedHere} of {spots} placed
            </span>
          )}
        </h2>
        <span className="flex-1" />
        {kind === 'placeable' &&
          (drawing ? (
            <Button size="sm" variant="ghost" icon={<X />} onClick={() => setDrawing(false)} className="max-md:h-11">
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={<Plus />} onClick={() => setDrawing(true)} title="Add box (A)" className="max-md:h-11">
              Add box
            </Button>
          ))}
      </header>
      {seen.length > 0 && <p className="shrink-0 truncate pb-1 pl-1 text-12 text-text-3" title={seen.join(', ')}>Cloud Vision sees: {seen.slice(0, 8).join(', ')}</p>}
      {kind !== 'blocked' && audience && (
        <div className="shrink-0 pt-1 pb-2">
          <AudienceBar
            label="Audience"
            value={audience.id}
            onChange={setViewVersion}
            className="rounded-[12px] bg-surface-2 p-1 [&_[data-audience]]:flex-1 [&_[data-audience]>button]:w-full [&_[data-audience]>button]:max-w-none [&_[data-audience]>button]:justify-center [&>[role=radiogroup]]:flex-1"
          />
        </div>
      )}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={sceneId}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.2, ease: EASE }}
          className={cx('no-scrollbar -mx-1 flex min-h-0 flex-col gap-1.5 overflow-y-auto px-1 pb-1 max-lg:overflow-visible', kind === 'blocked' && 'pt-3')}
        >
          {kind === 'blocked' ? (
            <div className="flex items-start gap-3 rounded-[16px] border border-dashed border-border-strong p-4">
              <Prohibit size={20} className="mt-px shrink-0 text-text-3" aria-hidden />
              <div className="min-w-0">
                <p className="text-14 font-medium text-text-2">Skipped by Gemini</p>
                <ul className="mt-1.5 flex flex-col gap-1 text-13 text-text-2">
                  {copy.reasons.map((r) => (
                    <li key={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</li>
                  ))}
                </ul>
                <p className="mt-2 text-13 text-text-3">Cameo doesn't place products here.</p>
              </div>
            </div>
          ) : boxes.length === 0 ? (
            <button
              type="button"
              onClick={() => setDrawing(true)}
              className="flex h-14 items-center justify-center gap-2 rounded-[16px] border border-dashed border-border-strong text-13 font-medium text-text-2 transition-colors duration-200 ease-cameo hover:border-accent hover:text-text"
            >
              <Plus size={16} aria-hidden /> Draw a box on the frame
            </button>
          ) : (
            audience && (
              <>
                {main.map((b) => (
                  <BoxCard key={b.id} box={b} n={numberOf[b.id]} siblings={boxes} audience={audience} />
                ))}
                {more.length > 0 && (
                  <>
                    <button
                      type="button"
                      aria-expanded={moreOpen}
                      onClick={() => setMoreOpen(!moreOpen)}
                      className="mt-1 flex h-9 items-center gap-1.5 rounded-[10px] px-1 text-13 font-medium text-text-2 transition-colors duration-150 hover:text-text"
                    >
                      <CaretRight size={14} aria-hidden className={cx('transition-transform duration-200 ease-cameo', moreOpen && 'rotate-90')} />
                      More spots ({more.length})
                      <span className="font-normal text-text-3">· other places Gemini found</span>
                    </button>
                    {moreOpen && more.map((b) => <BoxCard key={b.id} box={b} n={numberOf[b.id]} siblings={boxes} audience={audience} />)}
                  </>
                )}
              </>
            )
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}


/* ---------- One card per box ---------- */

function BoxCard({ box, n, siblings, audience }: { box: SceneBox; n: number; siblings: SceneBox[]; audience: Audience }) {
  const selected = useScenesUI((s) => s.openBoxId === box.id);
  const hovered = useScenesUI((s) => s.hoverBoxId === box.id);
  const hover = useScenesUI((s) => s.hover);
  const toggleBox = useScenesUI((s) => s.toggleBox);
  const assign = usePlacements((s) => s.assign);
  const reduce = useReducedMotion();
  const [confirm, setConfirm] = useState(false);
  const [picker, setPicker] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const usedInScene = siblings
    .flatMap((s) => (s.id === box.id ? [] : [assign[s.id]?.default ?? '', ...Object.values(assign[s.id]?.overrides ?? {})]))
    .filter((id) => id && id !== 'none');

  // A box clicked on the video brings its card into view.
  useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
  }, [selected, reduce]);

  return (
    <div
      ref={ref}
      data-box={box.id}
      onPointerEnter={() => hover(box.id)}
      onPointerLeave={() => hover(null)}
      className={cx(
        'shrink-0 rounded-[16px] border bg-[color-mix(in_oklab,var(--surface-2)_70%,transparent)] p-2 transition-[border-color] duration-200 ease-cameo',
        selected ? 'border-accent' : hovered ? 'border-border-strong' : 'border-border',
      )}
    >
      <div className="flex h-7 items-center gap-2.5 pl-0.5">
        <button
          type="button"
          aria-pressed={selected}
          onClick={() => toggleBox(box.id)}
          title={selected ? undefined : 'Select this box on the video'}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] text-left focus-visible:outline-offset-2"
        >
          <span
            aria-hidden
            className={cx(
              'mono inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] text-12 font-semibold transition-colors duration-200 ease-cameo',
              selected || hovered ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-text-2',
            )}
          >
            {n}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="min-w-0 shrink truncate text-14 font-medium text-text">
              <span className="sr-only">Box {n}: </span>
              {box.label}
            </span>
            <span className="min-w-0 shrink-[2] truncate text-12 text-text-3">
              {box.source === 'gemini'
                ? `Gemini · ${box.kind}`
                : box.origin === 'drawn'
                  ? box.identify === 'looking'
                    ? 'Looking…'
                    : box.identify === 'done'
                      ? 'Named by Gemini'
                      : 'Drawn by you'
                  : sceneById[box.momentId].copy.opportunity}
            </span>
          </span>
        </button>
        <BoxCrop keyframe={sceneById[box.momentId].moment.keyframe} box={box.box} />
        {(
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<Trash />}
            aria-label={`Remove box ${n}`}
            title="Remove box"
            onClick={() => setConfirm(true)}
            className="-my-1 -mr-0.5 shrink-0 text-text-3 max-md:size-11"
          />
        )}
      </div>

      {box.identify === 'looking' ? (
        <Looking />
      ) : (
        <>
          {box.origin === 'drawn' && box.identify === 'done' && (box.why || !!box.vision?.length) && (
            <motion.div
              initial={reduce ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="mt-1.5 flex gap-2 rounded-[10px] bg-surface px-2.5 py-2 text-12 leading-[18px] text-text-2 shadow-[0_0_0_1px_var(--border)]"
            >
              <Sparkle size={13} weight="fill" className="mt-[2px] shrink-0 text-accent" aria-hidden />
              <span className="flex min-w-0 flex-col gap-1">
                {box.edit && <span className="font-medium text-text">{EDIT_LABEL[box.edit]}</span>}
                {box.why && <span>{box.why}</span>}
                {box.snappedTo && <span className="text-text-3">Box tightened to the {box.snappedTo.toLowerCase()} Cloud Vision outlined.</span>}
                {!!box.vision?.length && <span className="text-text-3">Cloud Vision sees: {box.vision.join(', ')}</span>}
              </span>
            </motion.div>
          )}
          {box.origin === 'drawn' && box.identify === 'failed' && (
            <p className="mt-1.5 flex items-center gap-2 rounded-[10px] bg-surface px-2.5 py-2 text-12 leading-[18px] text-text-2 shadow-[0_0_0_1px_var(--border)]">
              <span className="min-w-0 flex-1">{box.identifyError ?? 'Gemini could not read this spot.'}</span>
              <Button size="sm" variant="ghost" onClick={() => void identifyBox(box)}>
                Retry
              </Button>
            </p>
          )}
          {<ProductSlot box={box} n={n} audience={audience} usedInScene={usedInScene} onBrowse={() => setPicker(true)} />}
        </>
      )}
      {selected && box.origin === 'drawn' && <p className="mt-2 text-12 text-text-3">Drag its corners on the video to resize.</p>}

      <ConfirmDialog
        open={confirm}
        title={`Remove box ${n}?`}
        description={`“${box.label}” and its products are removed for every audience.`}
        confirmLabel="Remove box"
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          useScenesUI.getState().openBox(null);
          usePlacements.getState().removeBox(box.id);
        }}
      />
      {<ProductPickerSheet open={picker} onClose={() => setPicker(false)} boxId={box.id} audienceId={audience.id} />}
    </div>
  );
}

/**
 * The box's product in the active audience. Two looks that can't be confused: placed is a solid card
 * with a "Placed" label (and a product tag on the video); empty is a dashed slot that says so, with
 * Gemini's pick inside it as a faded suggestion that only an explicit Add places.
 */
function ProductSlot({ box, n, audience, usedInScene, onBrowse }: { box: SceneBox; n: number; audience: Audience; usedInScene: string[]; onBrowse: () => void }) {
  const { product, state } = useResolved(box.id, audience.id);

  if (product) {
    return (
      <div className="mt-1.5 flex h-[88px] items-center gap-3 rounded-[12px] bg-surface p-3 shadow-[0_0_0_1px_color-mix(in_oklab,var(--pass)_45%,var(--border))]">
        <button
          type="button"
          onClick={() => openProduct(product.id)}
          aria-label={`View ${product.full}`}
          className="shrink-0 rounded-[12px] transition-transform duration-200 ease-cameo hover:-translate-y-0.5"
        >
          <Packshot productId={product.id} size={64} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="flex min-w-0 items-center gap-1 text-12 leading-4 font-medium text-pass">
            <CheckCircle size={13} weight="fill" aria-hidden className="shrink-0" />
            <span className="truncate">
              Placed for {audience.name}
              {state === 'local' && <span className="font-normal text-text-3"> · local version</span>}
            </span>
          </p>
          <p className="mt-0.5 truncate text-[15px] leading-5 font-medium text-text" title={product.full}>
            {product.name} <span className="text-13 font-normal text-text-2">{product.brand}</span>
          </p>
          <div className="mt-1 flex items-center gap-1">
            <Button size="sm" variant="secondary" icon={<ArrowsLeftRight />} onClick={onBrowse} aria-haspopup="dialog" aria-label={`Swap the product in box ${n}`}>
              Swap
            </Button>
            <Button size="sm" variant="ghost" icon={<ArrowsOut />} onClick={() => openProduct(product.id)} aria-label={`View ${product.full}`}>
              View
            </Button>
            <span className="flex-1" />
            {state === 'override' && !!usePlacements.getState().assign[box.id]?.default && (
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon={<ArrowCounterClockwise />}
                aria-label={`Use the default for ${audience.name}`}
                title="Back to the default"
                onClick={() => {
                  usePlacements.getState().clearOverride(box.id, audience.id);
                  toast({ title: `Box ${n} follows the default in ${audience.name}` });
                }}
                className="text-text-3"
              />
            )}
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<X />}
              aria-label={`Remove ${product.full} from box ${n} in ${audience.name}`}
              title={`Remove from ${audience.name}`}
              onClick={() => {
                usePlacements.getState().setOverride(box.id, audience.id, 'none');
                toast({ title: `Box ${n} is empty in ${audience.name}` });
              }}
              className="-mr-1 text-text-3"
            />
          </div>
        </div>
      </div>
    );
  }

  const top = suggestedProducts(box, 1, audience.id, usedInScene)[0];
  const why = top ? pickWhy(box, audience.id, top.id) : undefined;
  return (
    <div className="mt-1.5 rounded-[12px] border-[1.5px] border-dashed border-border-strong px-2.5 py-2">
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="inline-flex size-7 shrink-0 items-center justify-center rounded-[10px] border border-dashed border-border-strong text-text-3">
          <Plus size={14} />
        </span>
        <p className="min-w-0 flex-1 truncate text-14 font-medium text-text-2">No product for {audience.name}</p>
        <Button size="sm" variant="ghost" icon={<MagnifyingGlass />} onClick={onBrowse} aria-haspopup="dialog" className="-mr-1 max-md:h-11">
          Browse
        </Button>
      </div>
      {top && (
        <div className="mt-2 border-t border-dashed border-border pt-2">
          <div className="flex items-center gap-2.5" title={why}>
            <span className="shrink-0 opacity-60 saturate-50">
              <Packshot productId={top.id} size={36} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-1 text-12 text-text-3">
                <Sparkle size={12} aria-hidden className="shrink-0" /> Gemini suggests
              </span>
              <span className="truncate text-13 font-medium text-text-2">{top.full}</span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus />}
              onClick={() => {
                const result = assignFor(box.id, audience.id, top.id);
                if (result !== 'same') toast({ title: `${top.full} placed in box ${n}`, description: assignLine(result, audience.name), tone: 'pass' });
              }}
              aria-label={`Use ${top.full} in box ${n}`}
              className="shrink-0"
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A drawn box while the identify call runs (Cloud Vision, then Gemini on the keyframe). */
function Looking() {
  return (
    <div role="status" aria-live="polite" className="mt-1.5 rounded-[12px] bg-accent-soft/60 p-3 shadow-[0_0_0_1px_color-mix(in_oklab,var(--accent)_35%,transparent)]">
      <p className="flex items-center gap-1.5 text-13 font-medium text-text">
        <CircleNotch size={14} className="text-accent motion-safe:animate-spin" aria-hidden />
        Gemini is looking at this spot
      </p>
      <p className="mt-1 text-12 text-text-3">Cloud Vision and Gemini read the frame around your box and match your catalog.</p>
    </div>
  );
}

/** Exactly what will change: the keyframe cropped to the box (28 px tall). */
function BoxCrop({ keyframe, box }: { keyframe: string; box: Box }) {
  const ch = 28;
  const aspect = episodeAspect();
  const cw = Math.round(Math.min(48, Math.max(24, ch * ((box.w * aspect) / box.h))));
  const iw = Math.max(cw / box.w, (ch / box.h) * aspect);
  const ih = iw / aspect;
  const left = -box.x * iw + (cw - box.w * iw) / 2;
  const top = -box.y * ih + (ch - box.h * ih) / 2;
  return (
    <div className="relative shrink-0 overflow-hidden rounded-[7px] bg-black shadow-[0_0_0_1px_var(--border)]" style={{ width: cw, height: ch }} aria-hidden>
      <img src={keyframe} alt="" draggable={false} className="absolute max-w-none" style={{ width: iw, height: ih, left, top }} />
    </div>
  );
}
