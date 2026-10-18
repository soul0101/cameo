import { useEffect, useMemo } from 'react';
import { isAvailable, liveIndex } from '@/data/catalog';
import type { CatalogProduct } from '@/data/catalog';
import { shots } from '@/data/episode';
import { momentForShot, sceneCopy } from '@/data/scenes';
import type { SceneCopy } from '@/data/scenes';
import type { Box, Moment, Shot } from '@/data/types';
import type { AudienceId } from '@/store/project';
import { orderBoxes, usePlacements } from '@/store/placements';
import type { BoxAssignment, SceneBox } from '@/store/placements';
import { detectedBoxesForShot, geminiPicks, geminiWhy, getDetected, skipFor, skipReasons } from '@/data/detected';
import type { DetectedFile } from '@/data/detected';

/**
 * Scenes. A scene is one shot of the active episode (scene id = shot
 * id), so the scene list, the scrubber and the playhead all agree. Everything here comes from the
 * episode's detection output (`data/detected`, `data/scenes`): the shots, Gemini's boxes, the skipped
 * scenes, the stage-3 suggestions and default prompts. Boxes and their default + overrides live in
 * `usePlacements` (boxes, assign) and are read through `resolve`.
 */

export interface SceneEntry {
  index: number;
  moment: Moment;
  shot: Shot;
  copy: SceneCopy;
  /** Seconds in the master: the shot's range (boxes draw while it is live). */
  from: number;
  to: number;
}

export const scenes: SceneEntry[] = shots
  .filter((shot) => !!momentForShot(shot.id))
  .map((shot, index) => {
    const moment = momentForShot(shot.id)!;
    return { index, moment, shot, copy: sceneCopy[moment.id], from: shot.tIn, to: shot.tOut };
  });

export const sceneById: Record<string, SceneEntry> = Object.fromEntries(scenes.map((s) => [s.moment.id, s]));

export function sceneAt(t: number): SceneEntry {
  const i = scenes.findIndex((s) => t >= s.from && t < s.to);
  return scenes[i === -1 ? (t < 0 ? 0 : scenes.length - 1) : i];
}

/* ---------- Building scenes ---------- */

const hasProduct = (a: BoxAssignment | undefined) => !!a && (!!a.default || Object.keys(a.overrides).length > 0);

/** One scene's boxes from Gemini, with no product placed: Gemini's picks stay suggestions until the producer adds one. */
function initScene(momentId: string) {
  const f = getDetected();
  const scene = sceneById[momentId];
  if (!f || !scene) return;
  usePlacements.getState().initScene(momentId, detectedBoxesForShot(f, scene.shot.id), {});
}

/** Build the boxes of every scene that has none yet (Scenes and Previews do this on mount). */
export function materialiseScenes() {
  const st = usePlacements.getState();
  scenes.forEach((s) => {
    if (!st.boxes[s.moment.id]) initScene(s.moment.id);
  });
}

/** Rebuild every scene from the detection, empty (Start over): boxes only, every product a suggestion. */
export function seedScenes() {
  scenes.forEach((s) => initScene(s.moment.id));
}

/** Mount on Scenes and Previews: every scene has its boxes. */
export function useBoxSync() {
  useEffect(() => {
    materialiseScenes();
  }, []);
}

/** The scene's copy: kind, opportunity and (skipped) Gemini's reasons. */
export interface LiveCopy extends SceneCopy {
  reasons: string[];
}

const listWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function liveCopy(momentId: string, f: DetectedFile | null = getDetected()): LiveCopy {
  const base = sceneCopy[momentId] ?? { momentId, name: momentId, opportunity: '', kind: 'placeable' as const };
  const shot = sceneById[momentId]?.shot.id ?? momentId;
  if (!f) return { ...base, reasons: [] };
  if (skipFor(f, shot)) {
    const reasons = skipReasons(f, shot);
    return { ...base, kind: 'blocked', skipReason: reasons.join('; '), reasons };
  }
  const found = f.boxes.filter((b) => b.shotId === shot && !b.blocked);
  const kind: SceneCopy['kind'] = 'placeable';
  const words = found.map((b) => b.label);
  const opportunity = words.length ? `Gemini found ${listWords(words.slice(0, 3))}` : 'Gemini found no surface here';
  return { ...base, kind, opportunity, skipReason: undefined, reasons: [] };
}

export function useLiveCopy(momentId: string): LiveCopy {
  return useMemo(() => liveCopy(momentId), [momentId]);
}

/* ---------- Actions ---------- */

export function addDrawnBox(momentId: string, box: Box): SceneBox {
  const n = (usePlacements.getState().boxes[momentId] ?? []).filter((b) => b.origin === 'drawn').length + 1;
  const b: SceneBox = { id: `B${Date.now().toString(36)}`, momentId, box, label: n > 1 ? `Your box ${n}` : 'Your box', origin: 'drawn' };
  usePlacements.getState().addBox(b);
  return b;
}

/* ---------- Reads ---------- */

const EMPTY: SceneBox[] = [];
/** The scene's boxes in display order (`orderBoxes`): index + 1 is the box number everywhere. */
export function useSceneBoxes(momentId: string): SceneBox[] {
  const boxes = usePlacements((s) => s.boxes[momentId]) ?? EMPTY;
  return useMemo(() => orderBoxes(boxes), [boxes]);
}

/* ---------- Spots: the best few boxes of a scene, the rest one click away ---------- */

/** Boxes shown on the frame per scene; further detections wait under "More spots". */
const MAIN_SPOTS = 3;

/** Surfaces that carry a placement best (a poster on a wall, an ad on a sign or screen, a pack on a table). */
const KIND_WEIGHT: Record<string, number> = { wall: 1, sign: 1, screen: 1, table: 0.9, counter: 0.9, shelf: 0.8, hand: 0.7, apparel: 0.6, vehicle: 0.6 };

/** How good a spot is: Gemini found a product for it, it is big enough to read, and its surface suits a placement. */
function spotScore(b: SceneBox): number {
  const fits = geminiPicks(b.id).length > 0 ? 2 : 0;
  const size = Math.min(1, (b.box.w * b.box.h) / 0.12);
  return fits + size + (KIND_WEIGHT[b.kind ?? ''] ?? 0.5);
}

export interface Spots {
  /** Shown as boxes: the best MAIN_SPOTS, plus every box with a product and every box the user drew. */
  main: SceneBox[];
  /** Other detections, listed under "More spots" and shown as pins only when that list is open. */
  more: SceneBox[];
  /** Box number shown on badges and cards: main boxes first (top to bottom), then the rest. */
  numberOf: Record<string, number>;
}

export function splitSpots(boxes: SceneBox[], assign: Record<string, BoxAssignment>): Spots {
  const always = (b: SceneBox) => b.origin !== 'scripted' || hasProduct(assign[b.id]);
  const best = new Set([...boxes].filter((b) => !always(b)).sort((a, b) => spotScore(b) - spotScore(a)).slice(0, Math.max(0, MAIN_SPOTS - boxes.filter(always).length)).map((b) => b.id));
  const main = boxes.filter((b) => always(b) || best.has(b.id));
  const more = boxes.filter((b) => !main.includes(b));
  const numberOf = Object.fromEntries([...main, ...more].map((b, i) => [b.id, i + 1]));
  return { main, more, numberOf };
}

/** A scene's spots, following its boxes and their products. */
export function useSpots(momentId: string): Spots {
  const boxes = useSceneBoxes(momentId);
  const assign = usePlacements((s) => s.assign);
  return useMemo(() => splitSpots(boxes, assign), [boxes, assign]);
}

/**
 * Up to `n` products Gemini suggested for a box, best first: its stage-3 picks for a detected box,
 * its identify picks for a drawn one. For the default (no `audienceId`) from the first audience it
 * matched; for an audience, only what is available there. Products already used elsewhere in the
 * scene (`usedInScene`, product ids) go last. No local ranking stands in when Gemini has none.
 */
export function suggestedProducts(box: SceneBox, n = 3, audienceId?: AudienceId, usedInScene: string[] = []): CatalogProduct[] {
  const ix = liveIndex();
  const pool = audienceId ? ix.products.filter((p) => isAvailable(p, audienceId)) : ix.products;
  const picks = box.source === 'gemini' ? geminiPicks(box.id, audienceId) : audienceId ? (box.picks?.[audienceId] ?? []) : (Object.values(box.picks ?? {})[0] ?? []);
  const out: CatalogProduct[] = [];
  for (const g of picks) {
    const p = ix.byId[g.productId];
    if (p && !out.some((x) => x.id === p.id) && pool.some((x) => x.id === p.id)) out.push(p);
  }
  const used = new Set(usedInScene.map((id) => ix.byId[id]?.line ?? id));
  return [...out.filter((p) => !used.has(p.line)), ...out.filter((p) => used.has(p.line))].slice(0, n);
}

/** Gemini's one-line why for a product it suggested in a box and audience (stage 3 or identify). */
export function pickWhy(box: SceneBox, audienceId: AudienceId, productId: string, f: DetectedFile | null = getDetected()): string | undefined {
  if (box.source === 'gemini') return geminiWhy(box.id, audienceId, productId, f);
  return box.picks?.[audienceId]?.find((g) => g.productId === productId)?.why;
}

/** Status line for the scene list. */
export function sceneStatus(momentId: string, boxes: SceneBox[], assign: Record<string, BoxAssignment>): string {
  const kind = liveCopy(momentId).kind;
  if (kind === 'blocked') return 'Skipped';
  const placed = boxes.filter((b) => hasProduct(assign[b.id])).length;
  if (!boxes.length) return 'No boxes';
  return `${boxes.length} ${boxes.length === 1 ? 'box' : 'boxes'} · ${placed} placed`;
}
