import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { activeEpisodeId, scopedKey } from '@/data/episode';
import type { Box } from '@/data/types';
import { fetchTracks, trackBox } from '@/services/api';
import type { BoxTrack } from '@/services/api';
import { getDetected } from '@/data/detected';
import { usePlacements } from '@/store/placements';
import type { SceneBox } from '@/store/placements';
import { getTime, pause, seek } from './player';
import { sceneById } from './model';

/**
 * Where each box is at every moment of its shot, so the Scenes overlay follows the video (server: tracking.py,
 * CPU only). Gemini's boxes come tracked from their keyframes; a box the producer draws is tracked from the frame
 * it was drawn on. `null` in a track means the spot is out of view then: the box fades out and the page says
 * when it comes into view. A box with no track yet simply stays where it was boxed.
 */
interface TracksState {
  byBox: Record<string, BoxTrack>;
  /** Drawn boxes: the time of the frame they were drawn or last resized on (persisted). */
  drawnAt: Record<string, number>;
  /** Drawn boxes: the geometry + time their track was made for. */
  madeFor: Record<string, string>;
}

export const useTracks = create<TracksState>()(
  persist(() => ({ byBox: {}, drawnAt: {}, madeFor: {} }), {
    name: scopedKey('cameo-tracks'),
    version: 1,
    partialize: (s) => ({ drawnAt: s.drawnAt }),
  }),
);

/** Remember the frame a drawn box was drawn or resized on (its track starts there). */
export const markDrawn = (boxId: string) => useTracks.setState((s) => ({ drawnAt: { ...s.drawnAt, [boxId]: getTime() } }));

/** The box at time t: interpolated between track samples; null when out of view; the box itself when untracked. */
export function boxAt(track: BoxTrack | undefined, fallback: Box, t: number): Box | null {
  if (!track) return fallback;
  const k = (t - track.t0) * track.fps;
  const n = track.boxes.length;
  if (k < -0.5 || k > n - 0.5) return null;
  const a = Math.max(0, Math.min(n - 1, Math.floor(k)));
  const b = Math.min(n - 1, a + 1);
  const A = track.boxes[a];
  const B = track.boxes[b];
  if (!A && !B) return null;
  if (!A || !B) return (k - a < 0.5 ? A : B) ? toBox((k - a < 0.5 ? A : B)!) : null;
  const u = Math.max(0, Math.min(1, k - a));
  return toBox(A.map((v, i) => v * (1 - u) + B[i] * u));
}

const toBox = (v: number[]): Box => ({ x: v[0], y: v[1], w: v[2], h: v[3] });

/** The stretches (seconds) a tracked box is in view. */
export function spansOf(track: BoxTrack | undefined): Array<[number, number]> {
  if (!track) return [];
  const out: Array<[number, number]> = [];
  let start: number | null = null;
  track.boxes.forEach((b, i) => {
    const t = track.t0 + i / track.fps;
    if (b && start === null) start = t;
    if (!b && start !== null) {
      out.push([start, t]);
      start = null;
    }
  });
  if (start !== null) out.push([start, track.t0 + track.boxes.length / track.fps]);
  return out;
}

/** Where to look for a box that is out of view at t: its best frame, and whether that lies ahead or behind. */
export function whereInView(track: BoxTrack | undefined, t: number): { at: number; from: number; to: number; ahead: boolean } | null {
  const spans = spansOf(track);
  if (!track || !spans.length) return null;
  const span = spans.find(([a, b]) => track.best >= a && track.best <= b) ?? spans.find(([a]) => a > t) ?? spans[spans.length - 1];
  const at = Math.min(Math.max(track.best, span[0]), span[1] - 0.05);
  return { at, from: span[0], to: span[1], ahead: span[0] > t };
}

/** Show a box: move the video to its best frame (paused) when it is out of view now. */
export function revealBox(box: SceneBox) {
  const track = useTracks.getState().byBox[box.id];
  if (!track || boxAt(track, box.box, getTime())) return;
  const where = whereInView(track, getTime());
  if (!where) return;
  pause();
  seek(where.at);
}

/** The shot's middle keyframe time (the frame previews are made on). */
const midFrame = (shotId: string) => getDetected()?.episode?.shots.find((s) => s.shotId === shotId)?.keyframes.find((k) => k.pos === 'mid')?.t;

let fetched = false;

/**
 * Mount on Scenes: Gemini's tracks once per page load, and a track for every drawn box whose geometry or frame
 * changed since its last one (sent one at a time; the server caches them).
 */
export function useTrackSync() {
  const boxes = usePlacements((s) => s.boxes);
  const drawnAt = useTracks((s) => s.drawnAt);
  useEffect(() => {
    if (fetched) return;
    fetched = true;
    fetchTracks(activeEpisodeId).then(
      (got) => useTracks.setState((s) => ({ byBox: { ...s.byBox, ...Object.fromEntries(Object.entries(got).map(([id, tr]) => [`g-${id}`, tr])) } })),
      () => {
        fetched = false; // try again on the next visit; boxes stay put meanwhile
      },
    );
  }, []);
  useEffect(() => {
    for (const [momentId, list] of Object.entries(boxes)) {
      const scene = sceneById[momentId];
      if (!scene) continue;
      for (const b of list) {
        if (b.origin !== 'drawn') continue;
        // A box with no recorded draw time (a seeded sample's) counts as drawn on the shot's middle frame.
        const t = drawnAt[b.id] ?? midFrame(scene.shot.id) ?? (scene.from + scene.to) / 2;
        const sig = JSON.stringify([b.box, Math.round(t * 100)]);
        if (useTracks.getState().madeFor[b.id] === sig) continue;
        // Until the new track arrives the box stays where it was drawn, not on the previous track.
        useTracks.setState((s) => {
          const byBox = { ...s.byBox };
          delete byBox[b.id];
          return { madeFor: { ...s.madeFor, [b.id]: sig }, byBox };
        });
        trackBox(activeEpisodeId, { shotId: scene.shot.id, t, box: b.box }).then(
          (tr) => useTracks.getState().madeFor[b.id] === sig && useTracks.setState((s) => ({ byBox: { ...s.byBox, [b.id]: tr } })),
          () => useTracks.setState((s) => ({ madeFor: { ...s.madeFor, [b.id]: '' } })),
        );
      }
    }
  }, [boxes, drawnAt]);
}
