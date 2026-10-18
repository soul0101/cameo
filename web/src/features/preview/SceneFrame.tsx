import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { animate, motion, useMotionValue, useMotionValueEvent, useReducedMotion, useTransform } from 'framer-motion';
import type { SceneItem } from '@/store/placements';
import { cx } from '@/lib/cx';
import { Packshot } from '@/ui';
import { episodeAspect } from '@/data/detected';

/** The episode's own shape, radius 16: as tall as the stage allows (`--fh`), never wider than its column. */
export function Frame({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  const aspect = episodeAspect();
  return (
    <div
      role={label ? 'img' : undefined}
      aria-label={label}
      className={cx('relative max-w-full shrink-0 overflow-hidden rounded-[16px] bg-black shadow-[0_0_0_1px_var(--border),0_18px_40px_-16px_rgba(0,0,0,.55)]', className)}
      style={{ aspectRatio: aspect, width: `min(100%, var(--fh) * ${aspect})` }}
    >
      {children}
    </div>
  );
}

/** The accent box-number badge, shared by the outlines and the "In this shot" cards. */
export function BoxBadge({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cx('mono inline-flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-accent text-14 font-semibold text-accent-ink shadow-[0_1px_3px_rgba(0,0,0,.35)]', className)}>
      {n}
    </span>
  );
}

const TAG_H = 28;
const TAG_GAP = 4;
const PAD = 6;

/** Rough width of a tag (badge + chip with a 20 px packshot and a name truncated at 140). */
const tagWidth = (name: string) => 28 + TAG_GAP + 3 + 20 + 6 + Math.min(140, Math.ceil(name.length * 6.6)) + 8;

type Rect = { x: number; y: number; w: number; h: number };
const hits = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Tag positions (px) for a frame of width W: inside the box's top corner (right-aligned for boxes on
 * the right), then the bottom corner, then nudged down until it clears the tags already placed.
 */
function layoutTags(items: SceneItem[], W: number): Map<string, { x: number; y: number; right: number | null }> {
  const H = (W * 16) / 9;
  const out = new Map<string, { x: number; y: number; right: number | null }>();
  const placed: Rect[] = [];
  const order = [...items].sort((a, b) => a.box.box.y - b.box.box.y || a.box.box.x - b.box.box.x);
  for (const it of order) {
    const { x, y, w, h } = it.box.box;
    const tw = Math.min(tagWidth(it.product.name), W - 2 * PAD);
    const right = x + w / 2 > 0.6;
    const bx = x * W, by = y * H, bw = w * W, bh = h * H;
    const left = right ? bx + bw - PAD - tw : bx + PAD;
    const lx = Math.max(PAD, Math.min(W - PAD - tw, left));
    const free = (r: Rect) => !placed.some((p) => hits(r, p));
    const tries = [by + PAD, by + bh - PAD - TAG_H];
    let ty = tries.find((t) => free({ x: lx, y: t, w: tw, h: TAG_H }));
    if (ty === undefined) {
      ty = by + PAD;
      while (!free({ x: lx, y: ty, w: tw, h: TAG_H }) && ty < H - TAG_H - PAD) ty += TAG_H + TAG_GAP;
    }
    ty = Math.max(PAD, Math.min(H - TAG_H - PAD, ty));
    placed.push({ x: lx, y: ty, w: tw, h: TAG_H });
    out.set(it.box.id, { x: lx, y: ty, right: right ? W - (lx + tw) : null });
  }
  return out;
}

/** Every box of the version outlined, the rest softly dimmed, and a tag per box: number + packshot + product name. */
export function BoxOverlay({ items, audience, onPick }: { items: SceneItem[]; audience: string; /** Click a box or its tag: open the prompt panel on it. */ onPick?: (n: number) => void }) {
  const maskId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tags = W ? layoutTags(items, W) : null;

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0">
      <svg className="absolute inset-0 size-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        <mask id={maskId}>
          <rect width="100" height="100" fill="white" />
          {items.map((it) => (
            <rect key={it.box.id} x={it.box.box.x * 100} y={it.box.box.y * 100} width={it.box.box.w * 100} height={it.box.box.h * 100} rx="1.6" fill="black" />
          ))}
        </mask>
        <rect width="100" height="100" fill="rgba(0,0,0,.42)" mask={`url(#${maskId})`} />
      </svg>
      {items.map((it) => {
        const { x, y, w, h } = it.box.box;
        return (
          <div
            key={it.box.id}
            onClick={onPick ? () => onPick(it.n) : undefined}
            title={onPick ? `Box ${it.n}: ${it.product.full}. Click for its prompt` : undefined}
            className={cx(
              'absolute rounded-[8px] border-2 border-accent shadow-[0_0_0_1px_rgba(0,0,0,.3)]',
              onPick && 'pointer-events-auto cursor-pointer transition-colors duration-200 ease-cameo hover:bg-accent/15',
            )}
            style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }}
          />
        );
      })}
      {tags &&
        items.map((it) => {
          const t = tags.get(it.box.id)!;
          return (
            <button
              type="button"
              key={it.box.id}
              disabled={!onPick}
              onClick={onPick ? () => onPick(it.n) : undefined}
              aria-label={`Box ${it.n}: ${it.product.full}. Open its prompt`}
              className={cx('absolute z-[1] flex items-center gap-1 rounded-[8px] disabled:cursor-default', onPick && 'pointer-events-auto transition-transform duration-200 ease-cameo hover:-translate-y-px', t.right !== null && 'flex-row-reverse')}
              style={t.right !== null ? { right: t.right, top: t.y } : { left: t.x, top: t.y }}
            >
              <BoxBadge n={it.n} />
              <span
                title={it.product.full}
                className="inline-flex h-7 max-w-[180px] items-center gap-1.5 rounded-[8px] bg-black/70 pr-2 pl-[3px] text-13 font-medium text-white shadow-[0_1px_3px_rgba(0,0,0,.35)]"
              >
                <Packshot productId={it.product.id} audience={audience} size={20} />
                <span className="max-w-[140px] truncate">{it.product.name}</span>
              </span>
            </button>
          );
        })}
    </div>
  );
}

/** Small "Before" / "After" label in a frame corner. */
export function FrameLabel({ children, accent, right }: { children: ReactNode; accent?: boolean; right?: boolean }) {
  return (
    <span
      className={cx(
        'pointer-events-none absolute top-3 z-[2] rounded-[8px] bg-black/65 px-2 py-1 text-13 font-medium',
        right ? 'right-3' : 'left-3',
        accent ? 'text-accent' : 'text-white/85',
      )}
    >
      {children}
    </span>
  );
}

/** Seconds since `since` (ms epoch), ticking once a second. */
function useElapsed(since: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.round((now - since) / 1000));
}

/**
 * Over the After frame while Nano Banana works: the real elapsed time, never a made-up percentage
 * (one image takes about 15 to 30 seconds).
 */
export function GenOverlay({ since, count }: { since: number; count: number }) {
  const s = useElapsed(since);
  return (
    <div role="status" className="absolute inset-0">
      <div aria-hidden className="absolute inset-0 bg-black/55" />
      <div aria-hidden className="shimmer absolute inset-0 opacity-70" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-white">
        <span className="text-[32px] leading-none font-semibold tabular-nums">{s}s</span>
        <span className="text-14 text-white/80">
          Nano Banana is placing {count} {count === 1 ? 'product' : 'products'}
        </span>
        <span className="text-12 text-white/60">Usually 15 to 30 seconds</span>
      </div>
    </div>
  );
}

const clamp = (v: number) => Math.min(100, Math.max(0, v));

/** One frame, Before under After with a draggable accent seam (pointer, ←/→, Home/End). Sweeps once. */
export function WipeFrame({ before, after }: { before: ReactNode; after: ReactNode }) {
  const reduce = useReducedMotion();
  const seam = useMotionValue(50);
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const clip = useTransform(seam, (p) => `inset(0 0 0 ${p}%)`);
  const left = useTransform(seam, (p) => `${p}%`);
  const [now, setNow] = useState(50);
  useMotionValueEvent(seam, 'change', (v) => setNow(Math.round(v)));

  useEffect(() => {
    if (reduce) return;
    const c = animate(seam, [50, 80, 20, 50], { duration: 1.3, ease: [0.45, 0, 0.25, 1], times: [0, 0.35, 0.75, 1], delay: 0.25 });
    return () => c.stop();
  }, [reduce, seam]);

  const setFrom = (clientX: number) => {
    const r = area.current?.getBoundingClientRect();
    if (!r) return;
    seam.stop();
    seam.set(clamp(((clientX - r.left) / r.width) * 100));
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setFrom(e.clientX);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2;
    const next = e.key === 'ArrowLeft' ? now - step : e.key === 'ArrowRight' ? now + step : e.key === 'Home' ? 0 : e.key === 'End' ? 100 : null;
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    seam.stop();
    seam.set(clamp(next));
  };

  return (
    <Frame>
      {before}
      <motion.div className="absolute inset-0" style={{ clipPath: clip }}>
        {after}
      </motion.div>
      <FrameLabel>Before</FrameLabel>
      <FrameLabel accent right>
        After
      </FrameLabel>
      <div
        ref={area}
        data-wipe
        onPointerDown={onDown}
        onPointerMove={(e) => dragging.current && setFrom(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        className="absolute inset-0 z-[3] cursor-ew-resize touch-pan-y select-none"
      >
        <motion.div className="absolute inset-y-0 w-0" style={{ left }}>
          <span aria-hidden className="absolute inset-y-0 -left-px w-0.5 bg-accent shadow-[0_0_0_1px_rgba(0,0,0,.25)]" />
          <div
            role="slider"
            tabIndex={0}
            aria-label="Wipe between before and after"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={now}
            aria-valuetext={`${100 - now}% after`}
            onKeyDown={onKey}
            className="absolute top-1/2 left-0 flex h-12 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-accent bg-black/75 focus-visible:outline-offset-2"
          >
            <span aria-hidden className="h-5 w-px bg-accent" />
          </div>
        </motion.div>
      </div>
    </Frame>
  );
}
