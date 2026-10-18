import { activeRecord, keyframeName, keyframeUrl, shots } from './episode';
import type { DetectedFile } from './detected';
import type { Moment, Scene, Surface } from './types';

/**
 * The active episode's scenes, derived from its detection output only (no hand-made data): one scene
 * per shot, whose id is the shot id (`C01`). `moments[i]` is the scene's moment in the app's shape,
 * built from Gemini's facts for that shot; `sceneCopy` is its name and kind.
 */
export interface SceneCopy {
  momentId: string;
  /** "Café" */
  name: string;
  /** What Cameo sees, in plain words. */
  opportunity: string;
  kind: 'placeable' | 'blocked';
  skipReason?: string;
}

/** Detection kind → the app's surface vocabulary. */
export const SURFACE_OF: Record<string, Surface> = {
  table: 'table',
  counter: 'counter',
  shelf: 'counter',
  wall: 'wall',
  sign: 'street',
  street: 'street',
  screen: 'screen',
  hand: 'hand',
  apparel: 'wardrobe',
  wardrobe: 'wardrobe',
};

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const SCENE_WORDS: Array<[RegExp, Scene]> = [
  [/caf|coffee|restaurant|diner/i, 'Café'],
  [/street|road|outdoor|bus|city|park/i, 'Street'],
  [/apartment|home|room|kitchen|hall|bed|office|doorway/i, 'Apartment'],
  [/shop|store|market|counter|mall/i, 'Shop'],
];
const sceneGroup = (words: string, fallback?: string): Scene => (SCENE_WORDS.find(([re]) => re.test(words))?.[1] ?? (fallback as Scene) ?? 'Café');

/** The moments of a detected file, one per shot (id = shot id). */
function momentsOf(f: DetectedFile | null): Moment[] {
  if (!f) return [];
  return shots.map((shot): Moment => {
    const id = shot.id;
    const sc = f.scenes.find((s) => s.shotId === id);
    const skipped = f.skipped.some((s) => s.shotId === id);
    const own = f.moments.filter((m) => m.shotId === id);
    const lead = own.find((m) => m.mode !== 'blocked') ?? own[0];
    const boxes = f.boxes.filter((b) => b.shotId === id && !b.blocked);
    const placeable = boxes.filter((b) => SURFACE_OF[b.kind] !== 'wardrobe');
    return {
      id,
      shotId: id,
      tIn: shot.tIn,
      tOut: shot.tOut,
      label: lead?.label ?? placeable[0]?.label ?? sc?.type ?? '',
      scene: sceneGroup(`${sc?.type ?? ''} ${lead?.scene ?? ''}`, lead?.scene),
      surface: (SURFACE_OF[lead?.surface ?? placeable[0]?.kind ?? ''] ?? 'table') as Surface,
      mode: skipped ? 'blocked' : (lead?.mode ?? (placeable.length ? 'replace' : 'insert')),
      tags: [...new Set([sc?.type, sc?.mood, ...(sc?.tags ?? []), ...(lead?.tags ?? [])].filter((t): t is string => !!t))],
      keyframe: keyframeUrl(keyframeName(f, id)),
    };
  });
}

const kindOf = (m: Moment): SceneCopy['kind'] => (m.mode === 'blocked' ? 'blocked' : 'placeable');

function nameOf(f: DetectedFile, m: Moment, i: number): string {
  const type = f.scenes.find((s) => s.shotId === m.shotId)?.type;
  return type ? sentence(type) : `Shot ${i + 1}`;
}

export const moments: Moment[] = momentsOf(activeRecord.detected);
export const momentById: Record<string, Moment> = Object.fromEntries(moments.map((m) => [m.id, m]));

export const sceneCopy: Record<string, SceneCopy> = Object.fromEntries(
  moments.map((m, i) => [m.id, { momentId: m.id, kind: kindOf(m), name: nameOf(activeRecord.detected!, m, i), opportunity: m.label ? sentence(m.label) : '' }]),
);

/** The scene whose shot is `shotId` (one scene per shot). */
export function momentForShot(shotId: string): Moment | undefined {
  return momentById[shotId];
}
