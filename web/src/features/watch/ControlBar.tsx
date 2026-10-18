import { forwardRef, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, PointerEvent, ReactElement, ReactNode } from 'react';
import { CornersIn, CornersOut, Pause, Play, SpeakerSimpleHigh, SpeakerSimpleSlash } from '@phosphor-icons/react';
import type { Audience, AudienceId } from '@/store/project';
import { mmss } from '@/lib/timecode';
import { cx } from '@/lib/cx';
import { AudienceIcon } from '@/features/audiences/AudienceBar';
import { Segmented, Tooltip } from '@/ui';

interface Props {
  visible: boolean;
  time: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  fullscreen: boolean;
  panelOpen: boolean;
  market: AudienceId;
  /** Regions with at least one scene (the audience control). */
  audiences: Audience[];
  /** Starts of the scenes with products for this audience. */
  ticks: number[];
  /** No placements at all: a plain player (no disclosure tag, no audience control). */
  plain: boolean;
  compact: boolean;
  onToggle: () => void;
  onSeek: (t: number) => void;
  onMute: () => void;
  onFullscreen: () => void;
  onPanel: () => void;
  onMarket: (m: AudienceId) => void;
  onFocus: () => void;
}

/**
 * The one control bar: a floating dark dock at the foot of the picture area (dark in both themes).
 * "Sponsored placements" (the persistent disclosure; opens the products panel) · play · time ·
 * scrub with placement ticks · audience · mute · full screen.
 */
export function ControlBar(p: Props) {
  return (
    <div
      role="toolbar"
      aria-label="Player controls"
      onFocusCapture={p.onFocus}
      className={cx(
        'absolute bottom-4 left-1/2 z-20 flex h-12 w-[min(760px,calc(100%-32px))] -translate-x-1/2 items-center gap-1 rounded-[14px] px-2 text-white max-md:bottom-2 max-md:h-[52px] max-md:w-[calc(100%-16px)] max-md:gap-0.5 max-md:px-1.5',
        'border border-white/8 bg-[#17171c] shadow-[0_12px_32px_rgba(0,0,0,.45),inset_0_1px_0_rgba(255,255,255,.05)]',
        'transition-[opacity,transform] duration-[240ms] ease-cameo motion-reduce:transition-none',
        p.visible ? 'opacity-100' : 'pointer-events-none translate-y-1 opacity-0',
      )}
    >
      {!p.plain && (
      <>
      <Tip content={p.panelOpen ? 'Hide products' : 'Products in this video'} shortcut="S">
        <button
          type="button"
          aria-label="Sponsored placements: show products"
          aria-pressed={p.panelOpen}
          onClick={p.onPanel}
          className={cx(
            'inline-flex h-8 shrink-0 items-center rounded-[8px] px-2 text-12 font-medium whitespace-nowrap transition-colors duration-200 ease-cameo max-md:h-11',
            p.panelOpen ? 'bg-white/12 text-white' : 'text-white/60 hover:bg-white/8 hover:text-white',
          )}
        >
          {p.compact ? 'Sponsored' : 'Sponsored placements'}
        </button>
      </Tip>
      <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-white/10" />
      </>
      )}
      <Tip content={p.playing ? 'Pause' : 'Play'} shortcut="Space">
        <BarButton aria-label={p.playing ? 'Pause' : 'Play'} onClick={p.onToggle}>
          {p.playing ? <Pause weight="fill" /> : <Play weight="fill" />}
        </BarButton>
      </Tip>
      <span className="mono shrink-0 px-1.5 text-12 text-white/90" aria-label="Time">
        {mmss(p.time)}
        {!p.compact && <span className="text-white/40"> / {mmss(p.duration)}</span>}
      </span>
      <Scrub time={p.time} duration={p.duration} ticks={p.ticks} onSeek={p.onSeek} />
      {!p.compact && !p.plain && (
        <Segmented
          label="Audience"
          onDark
          value={p.market}
          onChange={p.onMarket}
          options={p.audiences.map((a) => ({
            value: a.id,
            // Past three audiences only the active one keeps its name; the rest are icon-only (name in the tooltip).
            label: (
              <span className="inline-flex items-center gap-1.5">
                <AudienceIcon kind={a.kind} size={14} />
                {(p.audiences.length <= 3 || a.id === p.market) && <span className="inline-block max-w-[110px] truncate">{a.name}</span>}
              </span>
            ),
            title: a.name,
            ariaLabel: a.name,
          }))}
          className="mx-1"
        />
      )}
      <Tip content={p.muted ? 'Unmute' : 'Mute'} shortcut="M">
        <BarButton aria-label={p.muted ? 'Unmute' : 'Mute'} aria-pressed={p.muted} onClick={p.onMute}>
          {p.muted ? <SpeakerSimpleSlash /> : <SpeakerSimpleHigh />}
        </BarButton>
      </Tip>
      <Tip content={p.fullscreen ? 'Exit full screen' : 'Full screen'} shortcut="F">
        <BarButton aria-label={p.fullscreen ? 'Exit full screen' : 'Full screen'} onClick={p.onFullscreen}>
          {p.fullscreen ? <CornersIn /> : <CornersOut />}
        </BarButton>
      </Tip>
    </div>
  );
}

function Tip({ children, ...rest }: { content: string; shortcut: string; children: ReactElement<Record<string, unknown>> }) {
  return (
    <Tooltip {...rest} side="top">
      {children}
    </Tooltip>
  );
}

const BarButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }>(
  function BarButton({ className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        className={cx(
          'inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] text-white/75 [&_svg]:size-[18px] max-md:size-11',
          'transition-[background-color,color,transform] duration-200 ease-cameo hover:bg-white/8 hover:text-white active:scale-[.97]',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

/** Scrub bar: 3 px track, thin accent ticks where placements start, a small knob. Keyboard: ←/→ 5 s, Home/End. */
function Scrub({ time, duration, ticks, onSeek }: { time: number; duration: number; ticks: number[]; onSeek: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [hover, setHover] = useState(false);
  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 5;
    const next =
      e.key === 'ArrowRight' ? time + step : e.key === 'ArrowLeft' ? time - step : e.key === 'Home' ? 0 : e.key === 'End' ? duration : null;
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    onSeek(Math.max(0, Math.min(duration, next)));
  };
  const pct = (t: number) => `${(t / duration) * 100}%`;
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={mmss(time)}
      onKeyDown={onKey}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        onSeek(at(e));
      }}
      onPointerMove={(e) => dragging.current && onSeek(at(e))}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      className="relative mx-2 h-full min-w-10 flex-1 cursor-pointer touch-none rounded-[6px] focus-visible:outline-offset-[-6px]"
    >
      <span aria-hidden className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/16" />
      <span aria-hidden className="absolute top-1/2 left-0 h-[3px] -translate-y-1/2 rounded-full bg-white/85" style={{ width: pct(time) }} />
      {ticks.map((t) => (
        <span key={t} aria-hidden data-tick={t} className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-accent" style={{ left: pct(t) }} />
      ))}
      <span
        aria-hidden
        className={cx(
          'absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,.4)] transition-transform duration-200 ease-cameo',
          hover ? 'scale-100' : 'scale-75',
        )}
        style={{ left: pct(time) }}
      />
    </div>
  );
}
