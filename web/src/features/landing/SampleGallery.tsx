import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { CaretLeft, CaretRight, Play } from '@phosphor-icons/react';
import { timecode } from '@/data/episode';
import { apiAsset } from '@/services/api';
import type { SampleSummary } from '@/services/api';
import { cx } from '@/lib/cx';
import { Skeleton } from '@/ui';

/**
 * The samples on an even grid that fills the column: equal cells, rows that stretch to the height the
 * column has (and scroll once they would get too short), and a last row whose cards widen to close the
 * gap (vertical clips take two rows when that packs evenly). A clip close to its card's shape fills it; one far from it (a vertical clip in a wide card) shows whole
 * over a soft blur of itself, so vertical, square and landscape samples sit side by side. Hover plays the rendered clip.
 */
const MIN_ROW = 190;
const GAP = 12;

/** The space the gallery has: its width, and its height when the page gives it one (one screen, desktop). */
function useSpace() {
  const ref = useRef<HTMLDivElement>(null);
  const [space, setSpace] = useState({ w: 900, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSpace({ w: el.clientWidth, h: getComputedStyle(el).overflowY === 'auto' ? el.clientHeight : 0 }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, space] as const;
}

/**
 * How many columns: the count whose cells come closest to the samples' usual shape, so most clips fill their
 * card. With no fixed height (phones, narrow windows) it goes by width alone.
 */
function columnsFor(n: number, aspect: number, { w, h }: { w: number; h: number }) {
  const max = w < 420 ? 1 : w < 700 ? 2 : 3;
  if (!h) return max;
  let best = max;
  let score = Infinity;
  for (let c = 1; c <= max; c++) {
    const rows = Math.ceil(n / c);
    const cell = (w - GAP * (c - 1)) / c / Math.max(MIN_ROW, (h - GAP * (rows - 1)) / rows);
    const d = Math.abs(Math.log(cell / aspect));
    if (d < score - 0.01) [best, score] = [c, d];
  }
  return best;
}

/**
 * Where each card goes. Vertical clips take two rows (a tall cell suits them), as long as the cells still come
 * out even; otherwise every card takes one cell and the last row's cards widen to close the gap (cols × last
 * units: full rows span units/cols each, the last row's cards span units/last).
 */
function layout(shapes: number[], cols: number) {
  const n = shapes.length;
  const tall = new Set(cols > 1 ? shapes.flatMap((a, i) => (a < 0.9 ? [i] : [])) : []);
  while (tall.size && (n + tall.size) % cols) tall.delete([...tall].pop()!);
  if ((n + tall.size) % cols === 0)
    return { units: cols, rows: Math.max(1, (n + tall.size) / cols), place: (i: number): CSSProperties => (tall.has(i) ? { gridRow: 'span 2' } : {}) };
  const last = n % cols;
  const units = cols * last;
  return {
    units,
    rows: Math.ceil(n / cols),
    place: (i: number): CSSProperties => ({ gridColumn: `span ${i >= n - last ? units / last : units / cols}` }),
  };
}

export function SampleGallery({ samples }: { samples: SampleSummary[] | null }) {
  const [ref, space] = useSpace();
  const list = samples ?? [];
  const n = samples === null ? 6 : list.length;
  // The shape most samples have (the median), never narrower than 4:3 so vertical outliers do not rule the grid.
  const shapes = list.map((s) => s.width / s.height).sort((a, b) => a - b);
  const aspect = Math.max(4 / 3, shapes[Math.floor(shapes.length / 2)] ?? 16 / 9);
  const cols = columnsFor(n, aspect, space);
  const { units, rows, place } = layout(samples === null ? Array(n).fill(16 / 9) : list.map((s) => s.width / s.height), cols);
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-[16px] max-lg:overflow-visible">
      <div
        className="grid h-full grid-flow-row-dense gap-3"
        style={{ gridTemplateColumns: `repeat(${units}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(${MIN_ROW}px, 1fr))` }}
      >
        {samples === null
          ? Array.from({ length: n }, (_, i) => <div key={i} style={place(i)}><Skeleton className="size-full rounded-[16px]" /></div>)
          : list.map((s, i) => <SampleCard key={s.id} sample={s} style={place(i)} />)}
      </div>
    </div>
  );
}

/**
 * Whether a clip of this shape can fill its card: yes when cropping would trim at most a fifth of it (a
 * landscape clip in a landscape card), else it shows whole over a blur of itself (a vertical clip in a wide card).
 */
function useFills(aspect: number) {
  const ref = useRef<HTMLButtonElement>(null);
  const [cover, setCover] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const box = el.clientWidth / Math.max(1, el.clientHeight);
      setCover(Math.min(box, aspect) / Math.max(box, aspect) >= 0.8);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return { ref, cover };
}

/**
 * One sample, whole and at its own shape over a blur of itself. Hovering plays it as a before/after wipe: the
 * original shot left of the pointer, the Cameo render right of it, a divider that follows the pointer. The two
 * clips play in step (the render keeps the shot's length and frame count).
 */
function SampleCard({ sample: s, style }: { sample: SampleSummary; style: CSSProperties }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState(false);
  const fill = useFills(s.width / s.height);
  const poster = apiAsset(s.poster);
  const clip = apiAsset(s.clip);
  const original = apiAsset(s.original);
  const after = useRef<HTMLVideoElement>(null);
  const before = useRef<HTMLVideoElement>(null);
  const fit = fill.cover ? 'object-cover' : 'object-contain';

  // Split position as a CSS variable on the card: the wipe follows the pointer without re-rendering.
  const setSplit = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    e.currentTarget.style.setProperty('--split', `${(x * 100).toFixed(2)}%`);
  };

  // Keep the original in step with the render (both loop; drift past a frame or two is corrected).
  useEffect(() => {
    if (!hover || !original) return;
    const id = window.setInterval(() => {
      const a = after.current;
      const b = before.current;
      if (!a || !b || a.readyState < 2 || b.readyState < 2) return;
      if (Math.abs(a.currentTime - b.currentTime) > 0.08) b.currentTime = a.currentTime;
      if (a.paused !== b.paused) void (a.paused ? b.pause() : b.play().catch(() => undefined));
    }, 200);
    return () => window.clearInterval(id);
  }, [hover, original]);

  const wipe = hover && !!clip && !!original;
  return (
    <button
      ref={fill.ref}
      type="button"
      onClick={() => navigate(`/p/${s.id}/scenes`)}
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch') return; // a tap opens the sample
        setSplit(e);
        setHover(true);
      }}
      onPointerMove={(e) => e.pointerType !== 'touch' && setSplit(e)}
      onPointerLeave={() => setHover(false)}
      aria-label={`Open the sample ${s.name}`}
      style={{ ...style, '--split': '50%' } as CSSProperties}
      className="group relative min-h-0 overflow-hidden rounded-[16px] bg-black text-left shadow-[0_0_0_1px_var(--border)] transition-shadow duration-200 hover:shadow-[0_0_0_1px_var(--border),0_16px_36px_-18px_rgba(0,0,0,.5)] focus-visible:outline-offset-2"
    >
      {poster && !fill.cover && <img src={poster} alt="" aria-hidden className="absolute inset-0 size-full scale-110 object-cover opacity-60 blur-2xl" />}
      {poster && <img src={poster} alt="" className={cx('absolute inset-0 size-full', fit)} />}
      {hover && clip && <video ref={after} src={clip} autoPlay muted loop playsInline className={cx('absolute inset-0 size-full', fit)} />}
      {hover && original && (
        <video
          ref={before}
          src={original}
          autoPlay
          muted
          loop
          playsInline
          aria-hidden
          className={cx('absolute inset-0 size-full', fit)}
          style={{ clipPath: 'inset(0 calc(100% - var(--split)) 0 0)' }}
        />
      )}
      {wipe && (
        <>
          <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0" style={{ left: 'var(--split)' }}>
            <span className="absolute inset-y-0 -left-px w-[2px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,.25),0_0_12px_rgba(0,0,0,.35)]" />
            <span className="absolute top-1/2 -left-[13px] flex size-[26px] -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow-[0_2px_8px_rgba(0,0,0,.35)]">
              <CaretLeft size={10} weight="bold" />
              <CaretRight size={10} weight="bold" />
            </span>
          </span>
          <span aria-hidden className="pointer-events-none absolute top-3 left-3 rounded-full bg-black/60 px-2 py-1 text-11 font-medium text-white/90 backdrop-blur-sm">
            Original
          </span>
          <span aria-hidden className="pointer-events-none absolute top-3 right-3 rounded-full bg-accent px-2 py-1 text-11 font-semibold text-accent-ink shadow-[0_2px_8px_rgba(0,0,0,.25)]">
            With Cameo
          </span>
        </>
      )}
      {!wipe && (
        <span className="absolute top-3 left-3 inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-11 font-medium text-white/90 backdrop-blur-sm">
          <Play size={10} weight="fill" aria-hidden /> Placed by Gemini Omni
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 flex flex-col gap-0.5 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-4 pt-12 pb-3.5 text-white">
        <span className="truncate text-16 font-semibold">{s.name}</span>
        <span className="mono truncate text-12 text-white/70">
          {wipe ? 'Move across to compare' : `${timecode(s.duration)} · ${s.products} ${s.products === 1 ? 'product' : 'products'} placed`}
        </span>
      </span>
    </button>
  );
}
