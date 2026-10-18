import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { Pause, Play, SkipBack, SkipForward } from '@phosphor-icons/react';
import { episode, timecode } from '@/data/episode';
import { cx } from '@/lib/cx';
import { useElementSize } from '@/lib/hooks';
import { AudienceBar } from '@/features/audiences/AudienceBar';
import { useAudiences } from '@/features/audiences/model';
import { usePlacements } from '@/store/placements';
import type { BoxAssignment, SceneBox } from '@/store/placements';
import { sceneById, scenes, sceneStatus, useLiveCopy, splitSpots } from './model';
import type { SceneEntry } from './model';
import { getTime, onTime, scrubEnd, scrubStart, seek, toggle, usePlayer } from './player';
import { spansOf, useTracks } from './tracks';
import { useScenesUI } from './state';

const D = episode.duration;
const GAP = 4;
const RULER = 20;
const TRACK = 64;
const TICKS = Array.from({ length: Math.floor(D / 10) + 1 }, (_, i) => i * 10);

/** Scene index at time t (the last scene owns the end). */
const indexAt = (t: number) => {
  const i = scenes.findIndex((s) => t >= s.from && t < s.to);
  return i === -1 ? (t <= 0 ? 0 : scenes.length - 1) : i;
};

/**
 * Timeline strip: transport and the "On video" audience (AudienceBar, compact) on top, a
 * thin time ruler, the shots laid out proportionally to their duration (4 px gaps), box markers on
 * the bottom edge of each shot, and an accent playhead with a handle. Click seeks; drag scrubs the
 * video live. The playhead and the drag bubble are written straight to the DOM from the clock so
 * playback never re-renders this strip.
 */
export function Timeline({ className }: { className?: string }) {
  const sceneId = useScenesUI((s) => s.sceneId);
  const viewVersion = useScenesUI((s) => s.viewVersion);
  const setViewVersion = useScenesUI((s) => s.setViewVersion);
  const audiences = useAudiences();
  const enabled = audiences.map((r) => r.id);
  const boxes = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const second = usePlayer((s) => s.second);

  const [areaRef, size] = useElementSize<HTMLDivElement>();
  const scroller = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverScene, setHoverScene] = useState<SceneEntry | null>(null);

  // Time ↔ x, exact across the 4 px gaps between shots.
  const W = size.width;
  const inner = Math.max(0, W - GAP * (scenes.length - 1));
  const xAt = useCallback((t: number) => (Math.min(D, Math.max(0, t)) / D) * inner + indexAt(Math.min(t, D - 0.001)) * GAP, [inner]);
  const timeAtX = useCallback(
    (x: number) => {
      for (const s of scenes) {
        const x0 = (s.from / D) * inner + s.index * GAP;
        const x1 = (s.to / D) * inner + s.index * GAP;
        if (x < x1 + GAP / 2 || s.index === scenes.length - 1) {
          const f = Math.min(1, Math.max(0, (x - x0) / Math.max(1, x1 - x0)));
          // Never land exactly on a cut: the decoder may show the previous shot's last frame.
          return Math.min(s.to - 0.05, Math.max(s.from + 0.05, s.from + f * (s.to - s.from)));
        }
      }
      return 0;
    },
    [inner],
  );

  // The clock moves the playhead (no React render).
  useLayoutEffect(() => {
    const apply = (t: number) => {
      if (playhead.current) playhead.current.style.transform = `translateX(${xAt(t)}px)`;
      if (bubble.current) bubble.current.textContent = timecode(t);
    };
    apply(getTime());
    return onTime(apply);
  }, [xAt]);

  // Phones: keep the current shot in view.
  useEffect(() => {
    const el = scroller.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const s = sceneById[sceneId];
    const x0 = (s.from / D) * inner + s.index * GAP;
    const x1 = (s.to / D) * inner + s.index * GAP;
    if (x0 < el.scrollLeft || x1 > el.scrollLeft + el.clientWidth) el.scrollTo({ left: Math.max(0, x0 - 24), behavior: 'smooth' });
  }, [sceneId, inner]);

  const localX = (clientX: number) => clientX - (areaRef.current?.getBoundingClientRect().left ?? 0);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    setDragging(true);
    setHoverScene(null);
    scrubStart();
    seek(timeAtX(localX(e.clientX)));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const x = Math.min(W, Math.max(0, localX(e.clientX)));
    if (dragging) {
      seek(timeAtX(x));
      return;
    }
    if (ghost.current) {
      ghost.current.style.opacity = '1';
      ghost.current.style.transform = `translateX(${x}px)`;
    }
  };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
    scrubEnd();
  };
  const onLeave = () => {
    if (ghost.current) ghost.current.style.opacity = '0';
    setHoverScene(null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      seek(e.key === 'Home' ? 0 : D);
    }
  };

  const current = sceneById[sceneId];

  return (
    <section aria-label="Timeline" className={cx('surface rounded-[20px]! px-4 py-3 max-md:p-3', className)}>
      {/* Transport · On video */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <TransportButton label="Previous scene" icon={<SkipBack size={16} weight="fill" />} disabled={current.index === 0} onClick={() => useScenesUI.getState().goScene(scenes[current.index - 1].moment.id)} />
          <PlayButton />
          <TransportButton label="Next scene" icon={<SkipForward size={16} weight="fill" />} disabled={current.index === scenes.length - 1} onClick={() => useScenesUI.getState().goScene(scenes[current.index + 1].moment.id)} />
        </div>
        <p className="mono text-13 whitespace-nowrap text-text tabular-nums" aria-live="off">
          {timecode(second)} <span className="text-text-3">/ {timecode(D)}</span>
        </p>
        <span className="flex-1" />
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="shrink-0 text-13 text-text-3 max-sm:hidden">On video</span>
          <AudienceBar label="Audience shown on the video" compact manage value={enabled.includes(viewVersion) ? viewVersion : enabled[0]} onChange={setViewVersion} />
        </div>
      </div>

      {/* Ruler + track */}
      <div ref={scroller} className="no-scrollbar -mx-2 mt-2 px-2 pt-1 pb-1 max-md:-mx-3 max-md:overflow-x-auto max-md:px-3 max-md:pt-9 max-md:-mt-5">
        <div
          ref={areaRef}
          role="slider"
          tabIndex={0}
          aria-label="Episode timeline"
          aria-valuemin={0}
          aria-valuemax={D}
          aria-valuenow={second}
          aria-valuetext={`${timecode(second)}, ${current.copy.name}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onLeave}
          onKeyDown={onKey}
          className={cx(
            'group/tl relative touch-none select-none max-md:touch-pan-x rounded-[10px] outline-none max-md:min-w-[760px]',
            'focus-visible:shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--accent)]',
            dragging ? 'cursor-grabbing' : 'cursor-pointer',
          )}
          style={{ paddingBottom: 10 }}
        >
          {/* Ruler: labels every 10 s */}
          <div className="relative" style={{ height: RULER }} aria-hidden>
            {W > 0 &&
              TICKS.map((t, i) => {
                const edge = i === 0 ? 'left' : i === TICKS.length - 1 ? 'right' : 'mid';
                return (
                  <span key={t} className="absolute top-0 h-full" style={{ left: xAt(t) }}>
                    <span
                      className={cx(
                        'mono absolute top-0 text-[11px] leading-none whitespace-nowrap text-text-3 tabular-nums',
                        edge === 'left' ? 'left-0' : edge === 'right' ? 'right-0' : '-translate-x-1/2',
                      )}
                    >
                      {timecode(t)}
                    </span>
                    <span className={cx('absolute bottom-1 h-1 w-px bg-border-strong', edge === 'right' && '-left-px')} />
                  </span>
                );
              })}
          </div>

          {/* Shots, proportional to duration */}
          <div className="relative flex" style={{ height: TRACK, gap: GAP }}>
            {scenes.map((s) => (
              <Shot
                key={s.shot.id}
                scene={s}
                current={s.moment.id === sceneId}
                boxes={boxes[s.moment.id] ?? []}
                assign={assign}
                onHover={(on) => !dragging && setHoverScene(on ? s : null)}
              />
            ))}
          </div>

          {/* Hover ghost */}
          <div
            ref={ghost}
            aria-hidden
            className={cx('pointer-events-none absolute top-0 left-0 w-px bg-text-3/70 opacity-0 transition-opacity duration-150', dragging && 'hidden')}
            style={{ height: RULER + TRACK }}
          />

          {/* Hover card: scene name + boxes */}
          {hoverScene && !dragging && W > 0 && (
            <HoverCard
              scene={hoverScene}
              x={xAt(hoverScene.from + (hoverScene.to - hoverScene.from) / 2)}
              W={W}
              status={sceneStatus(hoverScene.moment.id, boxes[hoverScene.moment.id] ?? [], assign)}
            />
          )}

          {/* Playhead */}
          <div ref={playhead} aria-hidden className="pointer-events-none absolute top-0 left-0 z-10 w-0 will-change-transform" style={{ height: RULER + TRACK }}>
            <div className="absolute top-1 bottom-0 -left-px w-[2px] rounded-full bg-accent shadow-[0_0_0_1px_rgba(0,0,0,.18)]" />
            <div
              className={cx(
                'absolute top-0 -left-1.5 size-3 rounded-full bg-accent shadow-[0_0_0_2px_var(--surface),0_1px_4px_rgba(0,0,0,.35)] transition-transform duration-150 ease-cameo',
                dragging ? 'scale-[1.35]' : 'group-hover/tl:scale-[1.15]',
              )}
            />
            <span
              ref={bubble}
              className={cx(
                'mono absolute -top-8 left-0 -translate-x-1/2 rounded-[7px] bg-text px-2 py-1 text-12 leading-none font-medium text-surface tabular-nums shadow-[0_4px_12px_rgba(0,0,0,.25)] transition-opacity duration-150',
                dragging ? 'opacity-100' : 'opacity-0',
              )}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- One shot on the track ---------- */

function Shot({
  scene,
  current,
  boxes,
  assign,
  onHover,
}: {
  scene: SceneEntry;
  current: boolean;
  boxes: SceneBox[];
  assign: Record<string, BoxAssignment>;
  onHover: (on: boolean) => void;
}) {
  const kind = useLiveCopy(scene.moment.id).kind;
  return (
    <div className="relative h-full min-w-0" style={{ flexGrow: scene.to - scene.from, flexBasis: 0 }} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
      <div className="absolute inset-0 overflow-hidden rounded-[10px] bg-black">
        <img
          src={scene.shot.thumb}
          alt=""
          draggable={false}
          className={cx(
            'h-full w-full object-cover transition-[opacity,filter] duration-200 ease-cameo',
            current ? 'opacity-100' : 'opacity-60 group-hover/tl:opacity-75',
            kind === 'blocked' && 'grayscale',
          )}
        />
      </div>
      <div
        aria-hidden
        className={cx(
          'pointer-events-none absolute inset-0 rounded-[10px] transition-[box-shadow,background-color] duration-200 ease-cameo',
          current ? 'bg-accent-soft shadow-[inset_0_0_0_1.5px_var(--accent)]' : 'shadow-[inset_0_0_0_1px_rgba(255,255,255,.06)]',
        )}
      />
      {kind !== 'blocked' && <Lanes scene={scene} boxes={boxes} assign={assign} />}
      <Markers kind={kind} boxes={boxes} assign={assign} />
    </div>
  );
}

/**
 * When each main spot is in view: one thin lane per spot along the shot (yellow = a product is placed there,
 * white = empty), so a spot that only comes into view later is visible on the timeline too.
 */
function Lanes({ scene, boxes, assign }: { scene: SceneEntry; boxes: SceneBox[]; assign: Record<string, BoxAssignment> }) {
  const tracks = useTracks((s) => s.byBox);
  const span = scene.to - scene.from;
  const lanes = splitSpots(boxes, assign)
    .main.map((b) => ({ b, spans: spansOf(tracks[b.id]) }))
    .filter((l) => l.spans.length);
  if (!lanes.length || span <= 0) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute inset-x-1.5 bottom-2 flex flex-col-reverse gap-[3px]">
      {lanes.map(({ b, spans }) => {
        const placed = !!assign[b.id]?.default || Object.keys(assign[b.id]?.overrides ?? {}).length > 0;
        return (
          <span key={b.id} className="relative h-[3px]">
            {spans.map(([from, to]) => (
              <span
                key={from}
                className={cx('absolute inset-y-0 rounded-full shadow-[0_0_0_1px_rgba(0,0,0,.35)]', placed ? 'bg-accent' : 'bg-white/85')}
                style={{ left: `${(Math.max(0, from - scene.from) / span) * 100}%`, width: `${(Math.max(0, Math.min(scene.to, to) - Math.max(scene.from, from)) / span) * 100}%` }}
              />
            ))}
          </span>
        );
      })}
    </span>
  );
}

/** Small pills on the shot's bottom edge: one per main spot (yellow = placed, grey = empty), red = skipped. */
function Markers({ kind, boxes, assign }: { kind: SceneEntry['copy']['kind']; boxes: SceneBox[]; assign: Record<string, BoxAssignment> }) {
  const pill = 'h-[6px] w-3 rounded-full shadow-[0_0_0_2px_var(--surface)]';
  let items: string[] = [];
  if (kind === 'blocked') items = [cx(pill, 'bg-reject')];
  else
    items = splitSpots(boxes, assign).main.map((b) =>
      assign[b.id]?.default || Object.keys(assign[b.id]?.overrides ?? {}).length
          ? cx(pill, 'bg-accent')
          : cx(pill, 'border border-text-3 bg-surface'), // empty: grey, so yellow only ever means placed
    );
  if (!items.length) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute -bottom-[3px] left-2 flex gap-[5px]">
      {items.map((c, i) => (
        <span key={i} className={c} />
      ))}
    </span>
  );
}

function HoverCard({ scene, x, W, status }: { scene: SceneEntry; x: number; W: number; status: string }) {
  const half = 60;
  const left = Math.min(W - half, Math.max(half, x));
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-20 flex w-max max-w-[180px] -translate-x-1/2 flex-col items-center rounded-[8px] bg-black/75 px-2.5 py-1.5 text-center shadow-[0_4px_12px_rgba(0,0,0,.3)] backdrop-blur-sm"
      style={{ left, top: RULER + 8 }}
    >
      <span className="truncate text-12 leading-[1.35] font-medium text-white">{scene.copy.name}</span>
      <span className="text-12 leading-[1.35] text-white/70">{status}</span>
    </div>
  );
}

/* ---------- Transport ---------- */

function TransportButton({ label, icon, onClick, disabled }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-9 items-center justify-center rounded-full text-text-2 transition-colors duration-200 ease-cameo hover:bg-surface-3 hover:text-text disabled:pointer-events-none disabled:opacity-35 max-md:size-11"
    >
      {icon}
    </button>
  );
}

function PlayButton() {
  const playing = usePlayer((s) => s.playing);
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={playing ? 'Pause' : 'Play'}
      title={playing ? 'Pause (Space)' : 'Play (Space)'}
      className="inline-flex size-9 items-center justify-center rounded-full bg-text text-surface transition-transform duration-200 ease-cameo hover:scale-105 active:scale-95 max-md:size-11"
    >
      {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" className="translate-x-px" />}
    </button>
  );
}
