import { momentForShot, SURFACE_OF } from './scenes';
import { activeRecord } from './episode';
import type { Box } from './types';
import type { SceneBox } from '@/store/placements';
import { fetchDetected } from '@/services/api';

/**
 * "Detected by Gemini": the detection output of the API (`GET /episodes/{id}/detected.json`,
 * Gemini on Vertex AI with Cloud Vision context). The browser never calls a model. Shape: moments,
 * per-shot boxes with stage-3 suggestions per audience, skipped shots, scene facts and the ingest block.
 */

/** One moment as the API writes it (raw strings). */
export interface WebMoment {
  id: string;
  shotId: string;
  shotIds: string[];
  tIn: number;
  tOut: number;
  label: string;
  scene: string;
  surface: string;
  mode: 'replace' | 'insert' | 'blocked';
  box: Box;
  suitability: number;
  attention: number;
  tags: string[];
  risks: string[];
  reasoning: string;
  brandId: string | null;
  markets: string[];
  keyframe: string;
  keyframeT: number;
}

/** A surface box Gemini found in one shot (face boxes are dropped by the sync script). */
export interface DetectedBox {
  id: string;
  shotId: string;
  shotIds: string[];
  label: string;
  /** Detection kind: table, counter, wall, sign, screen, shelf, hand, apparel. */
  kind: string;
  box: Box;
  areaPct: number | null;
  blocked: boolean;
  note: string | null;
  /** Stage 3 (one Gemini call per episode): per audience, up to 3 catalog products best first, each with a one-line why. */
  suggestions?: Record<string, GeminiPick[]>;
  /** Stage 3: per audience, Gemini's edit prompt for its top pick. */
  defaultPrompts?: Record<string, string>;
}

/** One stage-3 suggestion: a catalog product id (`brewno-in`) and why it fits. */
export interface GeminiPick {
  productId: string;
  why: string;
}

export interface DetectedSkip {
  shotId: string;
  tIn: number;
  tOut: number;
  reasons: string[];
}

export interface DetectedScene {
  shotId: string;
  tIn: number;
  tOut: number;
  type: string;
  mood: string;
  tags: string[];
  /** Surfaces Gemini listed in the shot (before boxing). */
  surfaces: number;
  sensitivity: { level: string; reasons: string[] };
}

export interface DetectedFile {
  episodeId: string;
  /** The match these suggestions come from ('' or absent = the original run). */
  matchId?: string | null;
  /** Audience ids the suggestions are keyed by. */
  audiences?: string[];
  llm: string;
  model: string;
  platform: string;
  syncedAt?: string;
  moments: WebMoment[];
  scenes: DetectedScene[];
  boxes: DetectedBox[];
  skipped: DetectedSkip[];
  /** Ingest facts (API ≥ v14): duration and shots with keyframe names. */
  episode?: DetectedEpisode;
}

/** Where a box came from: Gemini's detection (absent on boxes the user drew). */
export type BoxSource = 'gemini';

/** The ingest facts the API folds in (`episode`): duration, size and shots with their keyframe names. */
export interface DetectedEpisode {
  id: string;
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  shots: Array<{ shotId: string; index: number; tIn: number; tOut: number; keyframes: Array<{ pos: string; t: number; name: string }>; visionObjects?: VisionObject[] }>;
}

/** A Cloud Vision object localised on a shot's keyframe. */
export interface VisionObject {
  name: string;
  score: number;
  box: Box;
}

const isFile = (d: unknown): d is DetectedFile => !!d && typeof d === 'object' && Array.isArray((d as DetectedFile).boxes);

const normalise = (d: unknown): DetectedFile | null =>
  isFile(d) ? { ...d, moments: d.moments ?? [], skipped: d.skipped ?? [], scenes: d.scenes ?? [] } : null;

/** An episode's detected file from the API for its own match (`''` = the original run; null when it has none). Throws `ApiUnreachable`. */
export async function fetchDetectedFile(id: string, matchId = ''): Promise<DetectedFile | null> {
  return normalise(await fetchDetected(id, matchId));
}

/** The objects Cloud Vision found on a shot's keyframes, best first, deduplicated by name. */
export function visionObjects(f: DetectedFile | null, shotId: string): string[] {
  const list = f?.episode?.shots.find((s) => s.shotId === shotId)?.visionObjects ?? [];
  return [...new Set([...list].sort((a, b) => b.score - a.score).map((o) => o.name.toLowerCase()))];
}

/** The active episode's detected file (cached in `useProject().episodes`; read once per page load). */
export const getDetected = (): DetectedFile | null => activeRecord.detected;
/** The episode's picture shape (width / height) from ingest; 9:16 until a detection says otherwise. */
export function episodeAspect(f: DetectedFile | null = getDetected()): number {
  const w = f?.episode?.width, h = f?.episode?.height;
  return w && h ? w / h : 9 / 16;
}
export const detectedStatus = (): 'ready' | 'missing' => (activeRecord.detected ? 'ready' : 'missing');

/** The active episode's detected file (null when it has none). */
export function useDetected(): DetectedFile | null {
  return activeRecord.detected;
}

/* ---------- Mapping to the app's model ---------- */

const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The scene whose shot is `shotId` (scene id = shot id). */
const sceneIdForShot = (shotId: string) => momentForShot(shotId)?.id;

export function skipFor(f: DetectedFile | null, shotId: string): DetectedSkip | undefined {
  return f?.skipped.find((s) => s.shotId === shotId);
}

/**
 * Gemini's reasons for skipping a shot. The detection rule may leave `reasons` empty; then the
 * scene's sensitivity reasons, else its mood, stand in.
 */
export function skipReasons(f: DetectedFile | null, shotId: string): string[] {
  const skip = skipFor(f, shotId);
  if (!skip) return [];
  if (skip.reasons.length) return skip.reasons;
  const sc = f?.scenes.find((s) => s.shotId === shotId);
  if (sc?.sensitivity.reasons.length) return sc.sensitivity.reasons;
  return sc?.mood ? [`${sc.mood} moment`] : ['sensitive moment'];
}

/** Gemini's boxes for one shot as Scenes boxes, in detection order. */
export function detectedBoxesForShot(f: DetectedFile, shotId: string): SceneBox[] {
  const momentId = sceneIdForShot(shotId);
  if (!momentId || skipFor(f, shotId)) return [];
  return f.boxes
    .filter((b) => b.shotId === shotId && !b.blocked)
    .map((b) => {
      const surface = SURFACE_OF[b.kind] ?? 'table';
      // Every box can carry a product; clothing is a real spot (a wearable replaces the garment).
      return {
        id: `g-${b.id}`,
        momentId,
        box: b.box,
        label: sentence(b.label),
        origin: 'scripted',
        source: 'gemini',
        kind: b.kind,
        surface,
        geminiLabel: b.label,
      } satisfies SceneBox;
    });
}

export interface DetectedCounts {
  scenes: number;
  boxes: number;
  surfaces: number;
  skipped: number;
}

export function detectedCounts(f: DetectedFile): DetectedCounts {
  return {
    scenes: f.scenes.length || new Set(f.boxes.map((b) => b.shotId)).size,
    boxes: f.boxes.length,
    surfaces: f.scenes.reduce((n, s) => n + (s.surfaces || 0), 0),
    skipped: f.skipped.length,
  };
}


/* ---------- Stage 3: Gemini's product suggestions per box per audience ---------- */

/** The detected box behind a Scenes box id (`g-C02-b3` → `C02-b3`). */
function detectedBoxFor(f: DetectedFile | null, sceneBoxId: string): DetectedBox | undefined {
  if (!f || !sceneBoxId.startsWith('g-')) return undefined;
  const id = sceneBoxId.slice(2);
  return f.boxes.find((b) => b.id === id);
}

/**
 * Gemini's picks for a Scenes box in an audience, best first (products resolved by the caller).
 * Without an audience: the first audience Gemini matched (the default product is set once and
 * resolves to the brand's local product elsewhere).
 */
export function geminiPicks(sceneBoxId: string, audienceId?: string, f: DetectedFile | null = getDetected()): GeminiPick[] {
  const sugs = detectedBoxFor(f, sceneBoxId)?.suggestions;
  if (!sugs) return [];
  if (audienceId) return sugs[audienceId] ?? [];
  return Object.values(sugs)[0] ?? [];
}

/** Gemini's stage-3 prompt for a box in an audience, written for its top pick there (`productId`). */
export function geminiDefaultPrompt(sceneBoxId: string, audienceId: string, productId: string, f: DetectedFile | null = getDetected()): string | undefined {
  const b = detectedBoxFor(f, sceneBoxId);
  const top = b?.suggestions?.[audienceId]?.[0];
  const text = b?.defaultPrompts?.[audienceId];
  return top && text && top.productId === productId ? text : undefined;
}

/** Gemini's why line for `productId` in a box and audience, if Gemini suggested it there. */
export function geminiWhy(sceneBoxId: string, audienceId: string, productId: string, f: DetectedFile | null = getDetected()): string | undefined {
  return geminiPicks(sceneBoxId, audienceId, f).find((g) => g.productId === productId)?.why;
}
