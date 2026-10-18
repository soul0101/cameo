import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowLeft, ArrowRight, Prohibit, Sparkle } from '@phosphor-icons/react';
import { timecode } from '@/data/episode';
import { episode } from '@/data/episode';
import { episodeAspect } from '@/data/detected';
import type { Box } from '@/data/types';
import type { AudienceId } from '@/store/project';
import { cx } from '@/lib/cx';
import { useElementSize } from '@/lib/hooks';
import { audienceLabel } from '@/features/audiences/model';
import { resolveWith, usePlacements, useResolved } from '@/store/placements';
import { indexOf } from '@/data/catalog';
import { useProject } from '@/store/project';
import type { SceneBox } from '@/store/placements';
import { Packshot } from '@/ui';
import { addDrawnBox, sceneById, useLiveCopy, useSpots } from './model';
import { identifyBox } from './identify';
import { attach, onTime, pause, seek, toggle } from './player';
import { boxAt, markDrawn, revealBox, useTrackSync, useTracks, whereInView } from './tracks';
import { useScenesUI } from './state';

const MIN = 0.04;
type Size = { width: number; height: number };

/**
 * The stage's video: 9:16 letterboxed on --surface-2 (radius 16), the scene's numbered boxes on
 * top with the product tag for the "On video" version. Boxes swap with a 200 ms fade at cuts.
 * Drawing mode lays a crosshair layer over the frame.
 */
export function Frame({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const sceneId = useScenesUI((s) => s.sceneId);
  const drawing = useScenesUI((s) => s.drawing);
  const viewVersion = useScenesUI((s) => s.viewVersion);
  const scene = sceneById[sceneId];
  const { main, more, numberOf } = useSpots(sceneId);
  const moreOpen = useScenesUI((s) => s.moreOpen);
  const focusId = useScenesUI((s) => s.hoverBoxId ?? s.openBoxId);
  // Boxes on the frame: the main spots, plus an extra one while it is hovered or selected.
  const boxes = useMemo(() => [...main, ...more.filter((b) => b.id === focusId)], [main, more, focusId]);
  const pins = moreOpen ? more.filter((b) => b.id !== focusId) : [];
  // Boxes follow the video: each one where its track has it now, none while its spot is out of view.
  useTrackSync();
  const [now, setNow] = useState(0);
  useEffect(() => onTime(setNow), []);
  const tracks = useTracks((s) => s.byBox);
  const shown = useMemo(() => Object.fromEntries([...boxes, ...pins].map((b) => [b.id, boxAt(tracks[b.id], b.box, now)])), [boxes, pins, tracks, now]);
  // Spots out of view now, with where they come into view (the producer can jump there).
  const elsewhere = useMemo(
    () => main.flatMap((b) => (shown[b.id] ? [] : [{ box: b, where: whereInView(tracks[b.id], now) }])).filter((x) => x.where),
    [main, shown, tracks, now],
  );
  // Opening a spot that is out of view shows it: the video moves to its best frame.
  const openId = useScenesUI((s) => s.openBoxId);
  useEffect(() => {
    const b = [...main, ...more].find((x) => x.id === openId);
    if (b) revealBox(b);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);
  const kind = useLiveCopy(sceneId).kind;
  const aspect = episodeAspect();
  const [ref, size] = useElementSize<HTMLDivElement>();
  const ready = size.width > 0;
  const assign = usePlacements((s) => s.assign);
  const products = useProject((s) => s.products);
  const tagPlaces = useMemo(() => {
    const ix = indexOf(products);
    return layoutTags(
      boxes.flatMap((b) => (shown[b.id] ? [{ id: b.id, box: shown[b.id]!, label: resolveWith(assign[b.id], viewVersion, ix).product?.full }] : [])),
      size,
    );
  }, [boxes, shown, assign, products, viewVersion, size]);

  return (
    <div className={cx('relative flex items-center justify-center overflow-hidden rounded-[16px] bg-surface-2 p-3', className)}>
      {/* The stage is a size container: the frame takes the episode's own shape, as large as fits. */}
      <div className="flex size-full items-center justify-center" style={{ containerType: 'size' }}>
      <div
        ref={ref}
        className="relative overflow-hidden rounded-[12px] bg-black shadow-[0_0_0_1px_var(--border),0_18px_40px_-16px_rgba(0,0,0,.55)]"
        style={{ aspectRatio: aspect, width: `min(100cqw, 100cqh * ${aspect})` }}
      >
        <video
          ref={attach}
          src={episode.media}
          poster={scene.moment.keyframe}
          preload="auto"
          muted
          playsInline
          onClick={() => !drawing && toggle()}
          aria-label={`${episode.title}: ${scene.copy.name}`}
          className="h-full w-full object-cover"
        />
        {ready && (
          <div className="pointer-events-none absolute inset-0">
            <AnimatePresence initial={false}>
              <motion.div
                key={sceneId}
                className="pointer-events-none absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
              >
                {boxes.map((b) => (
                  <BoxRect key={b.id} box={b} shown={shown[b.id]} n={numberOf[b.id]} size={size} version={viewVersion} inert={drawing} place={tagPlaces[b.id]} />
                ))}
                {pins.map((b) => (
                  <SpotPin key={b.id} box={b} shown={shown[b.id]} n={numberOf[b.id]} size={size} inert={drawing} />
                ))}
              </motion.div>
            </AnimatePresence>
            <AnimatePresence>{drawing && <DrawLayer key="draw" size={size} sceneId={sceneId} />}</AnimatePresence>
          </div>
        )}
        {ready && !drawing && elsewhere.length > 0 && <Elsewhere items={elsewhere} numberOf={numberOf} />}
        {kind === 'blocked' && !drawing && (
          <p className="pointer-events-none absolute inset-x-0 bottom-5 mx-auto flex w-fit items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-12 font-medium text-white/90 backdrop-blur-sm">
            <Prohibit size={14} aria-hidden /> Skipped scene
          </p>
        )}
      </div>
      </div>
    </div>
  );
}

/* ---------- Tag layout: keep every box's tag readable ---------- */

type TagAt = 'above' | 'top' | 'bottom' | 'below';
interface TagPlace {
  at: TagAt;
  right: boolean;
}
type Rect = { x: number; y: number; w: number; h: number };

const TAG_H = 26;
/** Approximate width of the number + product tag (12 px Geist medium ≈ 6.6 px a character). */
const tagWidth = (label?: string) => (label ? 26 + 4 + Math.min(210, 3 + 20 + 6 + label.length * 6.6 + 8) : 26);

function tagRect(r: Box, { width: W, height: H }: Size, label: string | undefined, at: TagAt, right: boolean): Rect {
  const w = tagWidth(label);
  const outside = at === 'above' || at === 'below';
  const inset = outside ? 0 : 6;
  // Clamped into the frame (4 px margin): a long name never runs off the video.
  const x = Math.max(4, Math.min(W - 4 - w, right ? (r.x + r.w) * W - inset - w : r.x * W + inset));
  const y = at === 'above' ? r.y * H - TAG_H - 5 : at === 'below' ? (r.y + r.h) * H + 5 : at === 'top' ? r.y * H + 6 : (r.y + r.h) * H - 6 - TAG_H;
  return { x, y, w, h: TAG_H };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const fits = (t: Rect, { height: H }: Size) => t.y >= 0 && t.y + t.h <= H;

/** One tag's preferred place: above the box when there is room, else inside its top; right-aligned near the right edge. */
function placeTag(r: Box, size: Size, label?: string): TagPlace {
  const at: TagAt = r.y * size.height > TAG_H + 8 ? 'above' : 'top';
  return { at, right: r.x * size.width + tagWidth(label) > size.width };
}

/** Every tag of the scene, in box order: the preferred place, else the first place that collides with no earlier tag. */
function layoutTags(items: Array<{ id: string; box: Box; label?: string }>, size: Size): Record<string, TagPlace> {
  const out: Record<string, TagPlace> = {};
  const taken: Rect[] = [];
  for (const it of items) {
    const pref = placeTag(it.box, size, it.label);
    const options: TagPlace[] = [pref, ...(['above', 'top', 'bottom', 'below'] as const).flatMap((at) => [{ at, right: pref.right }, { at, right: !pref.right }])];
    const ok = options.find((o) => {
      const t = tagRect(it.box, size, it.label, o.at, o.right);
      return fits(t, size) && !taken.some((x) => overlaps(x, t));
    });
    const chosen = ok ?? pref;
    out[it.id] = chosen;
    taken.push(tagRect(it.box, size, it.label, chosen.at, chosen.right));
  }
  return out;
}

/* ---------- One box on the video ---------- */

function BoxRect({ box, shown, n, size, version, inert, place }: { box: SceneBox; shown: Box | null; n: number; size: Size; version: AudienceId; inert: boolean; place?: TagPlace }) {
  const open = useScenesUI((s) => s.openBoxId === box.id);
  const hovered = useScenesUI((s) => s.hoverBoxId === box.id);
  const someHover = useScenesUI((s) => s.hoverBoxId !== null);
  const toggleBox = useScenesUI((s) => s.toggleBox);
  const hover = useScenesUI((s) => s.hover);
  const resolved = useResolved(box.id, version);
  const [draft, setDraft] = useState<Box | null>(null);
  // Out of view now: the box keeps its last place, faded out, and takes no clicks.
  const last = useRef<Box>(shown ?? box.box);
  if (shown) last.current = shown;
  const away = !shown && !draft;
  const r = draft ?? shown ?? last.current;
  const { width: W, height: H } = size;
  const active = open || hovered;
  const looking = box.identify === 'looking';
  const product = resolved.product;
  // Where the number + product tag sit (see layoutTags); while resizing, recomputed for the draft.
  const { at, right: alignRight } = draft || !place ? placeTag(r, size, product?.full) : place;
  const tagX = tagRect(r, size, product?.full, at, alignRight).x;
  const resizable = open && box.origin === 'drawn' && !inert;

  const startResize = (corner: 'nw' | 'ne' | 'sw' | 'se') => (e: ReactPointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const start = { ...r };
    const ox = e.clientX;
    const oy = e.clientY;
    let latest = start;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - ox) / W;
      const dy = (ev.clientY - oy) / H;
      let { x, y, w, h } = start;
      if (corner.includes('w')) {
        x = Math.min(start.x + start.w - MIN, Math.max(0, start.x + dx));
        w = start.x + start.w - x;
      }
      if (corner.includes('e')) w = Math.min(1 - start.x, Math.max(MIN, start.w + dx));
      if (corner.includes('n')) {
        y = Math.min(start.y + start.h - MIN, Math.max(0, start.y + dy));
        h = start.y + start.h - y;
      }
      if (corner.includes('s')) h = Math.min(1 - start.y, Math.max(MIN, start.h + dy));
      latest = { x, y, w, h };
      setDraft(latest);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      usePlacements.getState().updateBox(box.id, latest);
      markDrawn(box.id); // the box now belongs to this frame: its track starts here
      setDraft(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div
      className={cx('absolute transition-opacity duration-200 ease-cameo', away ? 'opacity-0' : someHover && !hovered && 'opacity-45', inert || away ? 'pointer-events-none' : 'pointer-events-auto')}
      aria-hidden={away || undefined}
      style={{ left: r.x * W, top: r.y * H, width: r.w * W, height: r.h * H }}
    >
      <button
        type="button"
        aria-label={`Box ${n}: ${box.label}`}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          toggleBox(box.id);
        }}
        onPointerEnter={() => hover(box.id)}
        onPointerLeave={() => hover(null)}
        className={cx(
          'absolute inset-0 rounded-[8px] border-[1.5px] transition-[border-color,background-color] duration-200 ease-cameo focus-visible:outline-offset-4',
          // Empty spots are dashed; a placed product makes the outline solid (and adds its tag).
          !product && !looking && 'border-dashed',
          active ? 'border-accent shadow-[0_0_0_1px_rgba(0,0,0,.3)]' : cx(product ? 'border-white/80' : 'border-white/55', 'shadow-[0_0_0_1px_rgba(0,0,0,.25)] hover:border-accent'),
          hovered && 'bg-accent-soft',
          looking && 'border-accent bg-accent-soft motion-safe:animate-pulse',
        )}
      />
      {(
        <div
          className={cx(
            'pointer-events-none absolute flex items-center gap-1',
            active && 'z-[1]',
            at === 'above' ? '-top-[31px]' : at === 'below' ? '-bottom-[31px]' : at === 'top' ? 'top-1.5' : 'bottom-1.5',
            alignRight && 'flex-row-reverse',
          )}
          style={{ left: tagX - r.x * W, maxWidth: W - 4 - tagX }}
        >
          <span
            className={cx(
              'mono inline-flex size-[26px] shrink-0 items-center justify-center rounded-[8px] text-12 font-semibold shadow-[0_1px_3px_rgba(0,0,0,.35)] transition-colors duration-200 ease-cameo',
              active ? 'bg-accent text-accent-ink' : 'bg-white/80 text-black',
            )}
          >
            {n}
          </span>
          {looking && (
            <span className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[8px] bg-black/75 px-2 whitespace-nowrap text-12 font-medium text-white shadow-[0_1px_3px_rgba(0,0,0,.35)] backdrop-blur-sm">
              <Sparkle size={13} weight="fill" className="text-accent motion-safe:animate-pulse" aria-hidden />
              Gemini is looking
            </span>
          )}
          {product && (
            <span
              className="inline-flex h-[26px] max-w-[210px] min-w-0 items-center gap-1.5 rounded-[8px] bg-black/75 pr-2 pl-[3px] text-12 font-medium text-white shadow-[0_1px_3px_rgba(0,0,0,.35)] backdrop-blur-sm"
              title={`${product.full} (${audienceLabel(version)})`}
            >
              <Packshot productId={product.id} size={20} />
              <span className="truncate">{product.full}</span>
            </span>
          )}
        </div>
      )}
      {resizable &&
        (['nw', 'ne', 'sw', 'se'] as const).map((c) => (
          <span
            key={c}
            role="presentation"
            onPointerDown={startResize(c)}
            className={cx(
              'absolute size-3 touch-none rounded-full border-[1.5px] border-accent bg-white shadow-[0_1px_3px_rgba(0,0,0,.4)] max-md:size-5',
              c[0] === 'n' ? '-top-1.5 max-md:-top-2.5' : '-bottom-1.5 max-md:-bottom-2.5',
              c[1] === 'w' ? '-left-1.5 max-md:-left-2.5' : '-right-1.5 max-md:-right-2.5',
              c === 'nw' || c === 'se' ? 'cursor-nwse-resize' : 'cursor-nesw-resize',
            )}
          />
        ))}
    </div>
  );
}

/* ---------- Drawing a new box ---------- */

function DrawLayer({ size, sceneId }: { size: Size; sceneId: string }) {
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);
  const setDrawing = useScenesUI((s) => s.setDrawing);
  const openBox = useScenesUI((s) => s.openBox);
  const pos = (e: ReactPointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const rect = start && cur ? { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) } : null;

  return (
    <motion.div
      className="pointer-events-auto absolute inset-0 cursor-crosshair touch-none bg-black/30"
      data-drawing
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = pos(e);
        setStart(p);
        setCur(p);
      }}
      onPointerMove={(e) => start && setCur(pos(e))}
      onPointerUp={() => {
        if (rect && rect.w >= MIN && rect.h >= MIN) {
          const b = addDrawnBox(sceneId, rect);
          markDrawn(b.id);
          setDrawing(false);
          openBox(b.id);
          void identifyBox(b);
        }
        setStart(null);
        setCur(null);
      }}
    >
      {!rect && (
        <p className="pointer-events-none absolute inset-x-0 top-4 mx-auto w-fit rounded-full bg-black/75 px-3 py-1.5 text-12 font-medium text-white">
          Drag a rectangle · Esc to cancel
        </p>
      )}
      {rect && (
        <div
          className="pointer-events-none absolute rounded-[8px] border-[1.5px] border-dashed border-accent bg-accent-soft"
          style={{ left: rect.x * size.width, top: rect.y * size.height, width: rect.w * size.width, height: rect.h * size.height }}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
            <span
              key={c}
              className={cx('absolute size-2.5 rounded-full border-[1.5px] border-accent bg-white', c[0] === 'n' ? '-top-[5px]' : '-bottom-[5px]', c[1] === 'w' ? '-left-[5px]' : '-right-[5px]')}
            />
          ))}
        </div>
      )}
    </motion.div>
  );
}

/** An extra detection while "More spots" is open: a small numbered pin at its centre; hover or click shows its box. */
function SpotPin({ box, shown, n, size, inert }: { box: SceneBox; shown: Box | null; n: number; size: Size; inert: boolean }) {
  const hover = useScenesUI((s) => s.hover);
  const toggleBox = useScenesUI((s) => s.toggleBox);
  if (!shown) return null;
  const x = (shown.x + shown.w / 2) * size.width;
  const y = (shown.y + shown.h / 2) * size.height;
  return (
    <button
      type="button"
      tabIndex={inert ? -1 : 0}
      aria-label={`More spot ${n}: ${box.label}`}
      onClick={() => toggleBox(box.id)}
      onPointerEnter={() => hover(box.id)}
      onPointerLeave={() => hover(null)}
      className={cx('mono absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/70 bg-black/55 text-[11px] font-semibold text-white shadow-[0_1px_4px_rgba(0,0,0,.4)] backdrop-blur-sm transition-colors duration-150 hover:border-accent hover:bg-accent hover:text-accent-ink', inert ? 'pointer-events-none' : 'pointer-events-auto')}
      style={{ left: x, top: y }}
    >
      {n}
    </button>
  );
}

/* ---------- Spots out of view ---------- */

/**
 * The main spots not in the frame right now, bottom left: number, name and when it is in view, with an arrow
 * the way to go. A click moves the video (paused) to the spot's best frame.
 */
function Elsewhere({ items, numberOf }: { items: Array<{ box: SceneBox; where: ReturnType<typeof whereInView> }>; numberOf: Record<string, number> }) {
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-24px)] flex-col items-start gap-1.5">
      {items.map(({ box, where }) => (
        <button
          key={box.id}
          type="button"
          onClick={() => {
            pause();
            seek(where!.at);
          }}
          title={`Jump to ${timecode(where!.at)}, where ${box.label.toLowerCase()} is in view`}
          className="pointer-events-auto inline-flex h-8 max-w-full items-center gap-2 rounded-full bg-black/70 pr-3 pl-1 text-12 font-medium text-white shadow-[0_2px_8px_rgba(0,0,0,.35)] backdrop-blur-sm transition-colors duration-150 hover:bg-black/85"
        >
          <span className="mono inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-white/70 text-[11px] font-semibold">{numberOf[box.id]}</span>
          {!where!.ahead && <ArrowLeft size={13} weight="bold" aria-hidden className="shrink-0 text-white/80" />}
          <span className="truncate">{box.label}</span>
          <span className="mono shrink-0 text-white/65">
            {where!.ahead ? 'in view at' : 'was in view'} {timecode(where!.ahead ? where!.from : where!.at)}
          </span>
          {where!.ahead && <ArrowRight size={13} weight="bold" aria-hidden className="shrink-0 text-white/80" />}
        </button>
      ))}
    </div>
  );
}
