import { create } from 'zustand';
import { episode } from '@/data/episode';

/**
 * The Scenes page clock. One <video> (the stage) is attached; the timeline, the stage and the
 * keyboard all drive it through these functions. Time is NOT React state: it is pushed to
 * `onTime` listeners (the playhead writes its own style), so playback and scrubbing never
 * re-render the page. React only sees `playing`, `scrubbing` and the whole second (mono clock).
 *
 * Scrubbing coalesces seeks: while the decoder is still seeking, the newest target waits and is
 * applied on `seeked`, so dragging stays live without a backlog of stale frames.
 */

interface PlayerState {
  playing: boolean;
  scrubbing: boolean;
  /** Whole seconds of the current time (drives the mono clock only). */
  second: number;
}

export const usePlayer = create<PlayerState>()(() => ({ playing: false, scrubbing: false, second: 0 }));

const D = episode.duration;
const clamp = (t: number) => Math.min(D - 0.04, Math.max(0, t));

let video: HTMLVideoElement | null = null;
let time = 0;
let raf = 0;
let pending: number | null = null;
const listeners = new Set<(t: number) => void>();

function emit(t: number) {
  time = t;
  listeners.forEach((l) => l(t));
  const s = Math.floor(t);
  if (usePlayer.getState().second !== s) usePlayer.setState({ second: s });
}

export const getTime = () => time;

/** Subscribe to the clock (called immediately with the current time). */
export function onTime(listener: (t: number) => void): () => void {
  listeners.add(listener);
  listener(time);
  return () => {
    listeners.delete(listener);
  };
}

function tick() {
  if (!video) return;
  if (!usePlayer.getState().scrubbing) emit(video.currentTime);
  raf = requestAnimationFrame(tick);
}

const onPlay = () => {
  usePlayer.setState({ playing: true });
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
};
const onPause = () => {
  usePlayer.setState({ playing: false });
  cancelAnimationFrame(raf);
  if (video && !usePlayer.getState().scrubbing) emit(video.currentTime);
};
const onSeeked = () => {
  if (!video) return;
  if (pending !== null) {
    const t = pending;
    pending = null;
    video.currentTime = t;
  }
};
const onMeta = () => {
  if (video && Math.abs(video.currentTime - time) > 0.02) video.currentTime = time;
};

/** Ref callback for the stage's <video>. */
export function attach(el: HTMLVideoElement | null) {
  if (video === el) return;
  if (video) {
    video.removeEventListener('play', onPlay);
    video.removeEventListener('pause', onPause);
    video.removeEventListener('ended', onPause);
    video.removeEventListener('seeked', onSeeked);
    video.removeEventListener('loadedmetadata', onMeta);
    cancelAnimationFrame(raf);
  }
  video = el;
  pending = null;
  if (!el) {
    usePlayer.setState({ playing: false, scrubbing: false });
    return;
  }
  el.addEventListener('play', onPlay);
  el.addEventListener('pause', onPause);
  el.addEventListener('ended', onPause);
  el.addEventListener('seeked', onSeeked);
  el.addEventListener('loadedmetadata', onMeta);
  if (el.readyState >= 1) onMeta();
}

/** Move the clock (the video follows as fast as it can decode). */
export function seek(t: number) {
  const c = clamp(t);
  emit(c);
  if (!video || video.readyState < 1) return;
  if (video.seeking) pending = c;
  else video.currentTime = c;
}

function play() {
  if (!video) return;
  if (time >= D - 0.3) seek(0);
  void video.play().catch(() => undefined);
}
export function pause() {
  video?.pause();
}
export function toggle() {
  if (video?.paused) play();
  else pause();
}
const isPlaying = () => !!video && !video.paused;

/** Scrub start/end: pauses, and resumes afterwards if it was playing. */
let resume = false;
export function scrubStart() {
  resume = isPlaying();
  usePlayer.setState({ scrubbing: true });
  pause();
}
export function scrubEnd() {
  usePlayer.setState({ scrubbing: false });
  if (resume) play();
  resume = false;
}
