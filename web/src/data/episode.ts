import type { Episode, Shot } from './types';
import type { DetectedFile } from './detected';
import { keyframesBase, mediaUrl } from '@/services/api';

/**
 * The episode a page load works on. Detection output is the only source for Scenes. Every episode, a
 * server sample or an upload, is an `EpisodeRecord` in `useProject().episodes` (persisted,
 * `cameo-project`), carrying its media URLs and its cached detected JSON. One episode is *active* per
 * page load: it is chosen at boot from the URL (`/p/<id>/…`), else the last one opened, and the live
 * `episode` / `shots` below are built from its detected data. Opening another episode reloads the
 * page (`openEpisode`), so module-level readers (the Scenes clock, the timeline) always see the
 * active one.
 */

/** Every episode's media comes from the API. */
export interface EpisodeMedia {
  /** The episode proxy the player and Scenes play. */
  video: string;
  /** Base URL for keyframe stills: `${keyframes}${name}.jpg` (`C01_mid`). */
  keyframes: string;
}

export interface EpisodeRecord {
  id: string;
  name: string;
  media: EpisodeMedia;
  /** The cached detection output (null until processed / loaded). */
  detected: DetectedFile | null;
  processedAt: number | null;
  /** `payloadSignature` of the catalog and audiences its stage 3 matched against. */
  matchedWith?: string;
  /** This project's own re-match (`?match=` on detected.json); '' or absent = the original run. */
  matchId?: string;
}

const mediaOf = (id: string): EpisodeMedia => ({ video: mediaUrl(id, 'proxy'), keyframes: keyframesBase(id) });

export function uploadRecord(id: string, name: string, detected: DetectedFile | null): EpisodeRecord {
  return { id, name, media: mediaOf(id), detected, processedAt: detected ? Date.now() : null };
}

/** A stored record with its media URLs rebuilt for the current API base. */
export const withMedia = (r: EpisodeRecord): EpisodeRecord => ({ ...r, media: mediaOf(r.id) });

/* ---------- Boot: pick the active episode synchronously (persisted project store) ---------- */

interface PersistedProject {
  state?: { episodes?: EpisodeRecord[]; activeEpisodeId?: string };
}

function readStored(): PersistedProject['state'] {
  try {
    return (JSON.parse(localStorage.getItem('cameo-project') ?? 'null') as PersistedProject | null)?.state ?? {};
  } catch {
    return {};
  }
}

const stored = typeof window === 'undefined' ? {} : readStored();
const urlId = typeof window === 'undefined' ? null : (location.pathname.match(/^\/p\/([^/]+)/)?.[1] ?? null);
const storedEpisodes = stored?.episodes ?? [];
const bootId = [urlId, stored?.activeEpisodeId].find((id) => !!id && storedEpisodes.some((e) => e.id === id));
const storedBoot = storedEpisodes.find((e) => e.id === bootId);
// With no known episode (landing page, first visit) the active record is an empty placeholder.
const bootRecord: EpisodeRecord = storedBoot ? withMedia(storedBoot) : uploadRecord('', 'Untitled', null);

/** The episode this page load works on. */
export const activeEpisodeId: string = bootRecord.id;
export const activeRecord: EpisodeRecord = bootRecord;

/** Per-episode storage key: `name:id`. */
export const scopedKey = (name: string) => `${name}:${activeEpisodeId}`;

/* ---------- Live shots and episode, from the active episode's detected data ---------- */

export const keyframeUrl = (name: string, media: EpisodeMedia = activeRecord.media) => `${media.keyframes}${name}.jpg`;

/** The keyframe name for a shot at a position (`C01_mid`), from the detected episode block. */
export function keyframeName(f: DetectedFile | null, shotId: string, pos = 'mid'): string {
  const shot = f?.episode?.shots.find((s) => s.shotId === shotId);
  const kf = shot?.keyframes.find((k) => k.pos === pos) ?? shot?.keyframes[Math.floor((shot?.keyframes.length ?? 1) / 2)];
  return kf?.name ?? `${shotId}_${pos}`;
}

/** The detected file's shots: the ingest block when present, else the scene list. */
export function shotsOf(f: DetectedFile | null, media: EpisodeMedia = activeRecord.media): Shot[] {
  if (!f) return [];
  const list = f.episode?.shots?.length
    ? f.episode.shots.map((s) => ({ id: s.shotId, tIn: s.tIn, tOut: s.tOut }))
    : f.scenes.map((s) => ({ id: s.shotId, tIn: s.tIn, tOut: s.tOut }));
  return list.map(({ id, tIn, tOut }) => {
    const sc = f.scenes.find((s) => s.shotId === id);
    const still = keyframeUrl(keyframeName(f, id), media);
    return {
      id,
      tIn,
      tOut,
      scene: sc?.type ?? '',
      description: sc?.mood ?? '',
      media: `${media.video}#t=${tIn},${tOut}`,
      thumb: still,
    };
  });
}

export const durationOf = (f: DetectedFile | null) => f?.episode?.duration ?? Math.max(0, ...(f?.scenes ?? []).map((s) => s.tOut));

export const shots: Shot[] = shotsOf(activeRecord.detected);

export const episode: Episode = {
  id: activeRecord.id,
  title: activeRecord.name,
  duration: durationOf(activeRecord.detected) || 0,
  media: activeRecord.media.video,
  poster: shots[0] ? keyframeUrl(keyframeName(activeRecord.detected, shots[0].id)) : '',
  shots,
};

/** Poster (first keyframe) of any stored episode. */
export const posterOf = (r: EpisodeRecord) => {
  const first = shotsOf(r.detected, r.media)[0];
  return first ? keyframeUrl(keyframeName(r.detected, first.id), r.media) : '';
};

/**
 * Open an episode: a full page load, so every module rebuilds from it (cheap, and the only way the
 * Scenes clock and timeline, which read the duration at load, follow a switch).
 */
export function openEpisode(id: string, section = 'scenes') {
  window.location.assign(`/p/${encodeURIComponent(id)}/${section}`);
}

/** 0:08 style timecode. */
export function timecode(t: number): string {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Forget an episode's working state (boxes, products in boxes, approvals, Scenes UI). */
export function clearEpisodeWorkspace(id: string) {
  try {
    localStorage.removeItem(`cameo-sample-seeded:${id}`); // a sample cleared starts ready-made again
  } catch {
    /* storage blocked */
  }
  // Everything keyed by the episode's scenes: boxes and products, flow, Scenes UI, approvals and generated stills.
  for (const name of ['cameo-placements', 'cameo-flow', 'cameo-scenes-ui', 'cameo-approved-sigs', 'cameo-stills', 'cameo-renders']) {
    try {
      localStorage.removeItem(`${name}:${id}`);
    } catch {
      /* storage blocked: nothing persisted */
    }
  }
}
