import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useMemo } from 'react';
import { composeScenePrompt, promptBase } from '@/data/prompts';
import type { PromptSource } from '@/data/prompts';
import { indexOf, isAvailable, siblingWith } from '@/data/catalog';
import type { CatalogIndex, CatalogProduct } from '@/data/catalog';
import { scopedKey, shots } from '@/data/episode';
import { momentForShot } from '@/data/scenes';
import type { Box, Surface } from '@/data/types';
import type { BoxSource, GeminiPick } from '@/data/detected';
import { useProject } from './project';
import { useWrittenPrompts } from '@/data/writtenPrompts';
import type { AudienceId } from './project';


/**
 * The working state of the active episode (persisted per episode as `cameo-placements`): boxes per
 * scene, what each box shows per audience (default + overrides), edited scene prompts and the
 * Previews approvals.
 */

/**
 * A box on the frame: one placement target. `scripted` boxes are Gemini's detection
 * (clothing included: a wearable replaces the garment), `drawn` boxes are the user's own rectangles
 * (resizable), `extra` holds a product added to a scene from elsewhere.
 */
export interface SceneBox {
  id: string;
  momentId: string;
  box: Box;
  label: string;
  origin: 'scripted' | 'drawn' | 'extra';
  /** Detected boxes are `gemini`; boxes the user drew have none. */
  source?: BoxSource;
  /** Detected boxes: Gemini's surface kind (table, counter, wall, sign, screen, shelf, hand, apparel). */
  kind?: string;
  /** Detected boxes: the app surface the kind maps to. */
  surface?: Surface;
  /** Detected boxes: Gemini's own label, as written. */
  geminiLabel?: string;
  /** Drawn boxes: Gemini looking at the spot in context, done (label, why, picks set), or no answer. */
  identify?: 'looking' | 'done' | 'failed';
  /** Drawn boxes: Gemini's one-line read of the spot in the scene. */
  why?: string;
  /** Drawn boxes: Gemini's picks per audience, best first, each with its why. */
  picks?: Record<string, GeminiPick[]>;
  /** Drawn boxes: Gemini's edit prompt per audience, written for its top pick there. */
  prompts?: Record<string, string>;
  /** Drawn boxes: the objects Cloud Vision found around the box. */
  vision?: string[];
  /** Drawn boxes: how a product appears here (Gemini): swap the object or garment, set one on it, or show an image on it. */
  edit?: 'replace' | 'place' | 'display';
  /** Drawn boxes: the Cloud Vision object the drawn box was tightened to, when it mostly covered one. */
  snappedTo?: string;
  /** Drawn boxes: why the last identify failed (shown with a retry). */
  identifyError?: string;
}

/**
 * Display order of a scene's boxes, and so their numbers (1..n) everywhere: Scenes cards, the
 * on-video tags, Previews outlines, "In this shot" badges, the composed prompt. Placeable boxes
 * first, top to bottom (then left to right).
 */
export function orderBoxes(boxes: SceneBox[]): SceneBox[] {
  return [...boxes].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

type BoxWorkspace = Pick<PlacementsState, 'boxes' | 'assign' | 'scenePrompt' | 'include' | 'approved'>;

const EMPTY_WORKSPACE: BoxWorkspace = { boxes: {}, assign: {}, scenePrompt: {}, include: {}, approved: {} };

/**
 * What one box shows: a default product for every audience, and
 * per-audience overrides (a product, or 'none' = explicitly nothing there). One source of truth:
 * every reader goes through `resolve`.
 */
export interface BoxAssignment {
  default: string | null;
  overrides: Record<AudienceId, string | 'none'>;
}

/** How a (box, audience) got its product. See `resolve`. */
export type ResolveState = 'override' | 'none' | 'default' | 'local' | 'gap';

export interface Resolved {
  product: CatalogProduct | null;
  state: ResolveState;
}

const EMPTY_ASSIGNMENT: BoxAssignment = { default: null, overrides: {} };

interface PlacementsState {
  /** Boxes per scene (moment id), materialised the first time Scenes sees the scene. */
  boxes: Record<string, SceneBox[]>;
  /** Default + overrides per box id. Read through `resolve`. */
  assign: Record<string, BoxAssignment>;

  /** First-time scene setup (boxes + their assignments). Replaces the scene's boxes. */
  initScene: (momentId: string, boxes: SceneBox[], assign: Record<string, BoxAssignment>) => void;
  addBox: (box: SceneBox) => void;
  updateBox: (boxId: string, box: Box) => void;
  /** Merge fields into a box (Gemini's answer for a drawn box). */
  patchBox: (boxId: string, patch: Partial<SceneBox>) => void;
  /** Remove a box and its assignment (every audience's version of the scene goes stale). */
  removeBox: (boxId: string) => void;
  /** The product every audience gets (null clears it). Versions whose product changes go stale. */
  setDefault: (boxId: string, productId: string | null) => void;
  /** A different product, or 'none' (nothing), for one audience. */
  setOverride: (boxId: string, audienceId: AudienceId, productId: string | 'none') => void;
  /** Back to inheriting the default for one audience. */
  clearOverride: (boxId: string, audienceId: AudienceId) => void;

  /* ---- Scene versions: the unit is (scene, audience). ---- */
  /** Scenes switched off on the Scenes page (missing = included: on by default once it has a product). */
  include: Record<string, boolean>;
  /** Edited combined prompts per scene and audience (missing = composed from the box prompts). */
  scenePrompt: Record<string, Record<AudienceId, string>>;
  /** Scene versions approved on Previews. */
  approved: Record<string, Record<AudienceId, true>>;

  setInclude: (sceneId: string, on: boolean) => void;
  setScenePrompt: (sceneId: string, audience: AudienceId, text: string) => void;
  resetScenePrompt: (sceneId: string, audience: AudienceId) => void;
  setApproved: (sceneId: string, audience: AudienceId, on?: boolean) => void;
  /** Previews "Approve all". */
  approveVersions: (versions: SceneVersion[]) => void;
  reset: () => void;
}

/** One scene in one audience: one combined prompt, one approval. */
export interface SceneVersion {
  sceneId: string;
  audienceId: AudienceId;
}

export const versionId = (v: SceneVersion) => `${v.sceneId}-${v.audienceId}`;

const setIn = <T,>(rec: Record<string, Record<AudienceId, T>>, sceneId: string, audience: AudienceId, value: T | undefined) => {
  const cur = { ...(rec[sceneId] ?? {}) };
  if (value === undefined) delete cur[audience];
  else cur[audience] = value;
  const next = { ...rec };
  if (Object.keys(cur).length) next[sceneId] = cur;
  else delete next[sceneId];
  return next;
};

/** A product change in a box makes the scene version's approval stale. */
const staleVersion = (s: Pick<PlacementsState, 'approved'>, sceneId: string | undefined, audience: AudienceId) =>
  sceneId ? { approved: setIn(s.approved, sceneId, audience, undefined) } : {};

const momentOfBox = (s: Pick<PlacementsState, 'boxes'>, boxId: string) => Object.values(s.boxes).flat().find((b) => b.id === boxId)?.momentId;

const audienceIds = (): AudienceId[] => useProject.getState().audiences.map((a) => a.id);
const liveIx = () => indexOf(useProject.getState().products);

/**
 * Pure: what a box shows in an audience, in the spec's order:
 * 1. `override`: an explicit product for this audience.
 * 2. `none`: explicitly nothing in this audience.
 * 3. `default`: the default product, available in this audience.
 * 4. `local`: the default isn't available here, but the same brand has a product that is.
 * 5. `gap`: nothing resolves (includes a box with no default yet).
 * Products missing from the library (removed) count as unset, so Undo brings them back.
 */
export function resolveWith(a: BoxAssignment | undefined, audienceId: AudienceId, ix: CatalogIndex): Resolved {
  const o = a?.overrides[audienceId];
  if (o === 'none') return { product: null, state: 'none' };
  if (o && ix.byId[o]) return { product: ix.byId[o], state: 'override' };
  const d = a?.default ? ix.byId[a.default] : undefined;
  if (d && isAvailable(d, audienceId)) return { product: d, state: 'default' };
  const local = d ? siblingWith(ix, d, audienceId) : undefined;
  if (local) return { product: local, state: 'local' };
  return { product: null, state: 'gap' };
}

/** What a box shows in an audience, from the live stores. See `resolveWith`. */
export function resolve(boxId: string, audienceId: AudienceId): Resolved {
  return resolveWith(usePlacements.getState().assign[boxId], audienceId, liveIx());
}

/**
 * Stale every version of the box's scene whose resolved product differs between two assignment
 * (or catalog) states.
 */
function staleChanged(
  s: Pick<PlacementsState, 'boxes' | 'approved'>,
  boxId: string,
  before: [BoxAssignment | undefined, CatalogIndex],
  after: [BoxAssignment | undefined, CatalogIndex],
  audiences: AudienceId[] = audienceIds(),
): Pick<PlacementsState, 'approved'> {
  const sceneId = momentOfBox(s, boxId);
  let acc = { approved: s.approved };
  for (const id of audiences) {
    const was = resolveWith(before[0], id, before[1]).product?.id ?? null;
    const now = resolveWith(after[0], id, after[1]).product?.id ?? null;
    if (was !== now) acc = { ...acc, ...staleVersion(acc, sceneId, id) };
  }
  return acc;
}

/** Write a box's next assignment, staling the versions whose product changed. */
function writeAssignment(s: PlacementsState, boxId: string, next: BoxAssignment): Partial<PlacementsState> {
  const ix = liveIx();
  const prev = s.assign[boxId];
  return { assign: { ...s.assign, [boxId]: next }, ...staleChanged(s, boxId, [prev, ix], [next, ix]) };
}

export const usePlacements = create<PlacementsState>()(
  persist(
    (set) => ({
      boxes: {},
      assign: {},
      initScene: (momentId, boxes, assign) => set((s) => ({ boxes: { ...s.boxes, [momentId]: boxes }, assign: { ...s.assign, ...assign } })),
      addBox: (box) => set((s) => ({ boxes: { ...s.boxes, [box.momentId]: [...(s.boxes[box.momentId] ?? []), box] } })),
      updateBox: (boxId, box) =>
        set((s) => {
          const next = { ...s.boxes };
          for (const k of Object.keys(next)) next[k] = next[k].map((b) => (b.id === boxId ? { ...b, box } : b));
          return { boxes: next };
        }),
      patchBox: (boxId, patch) =>
        set((s) => {
          const next = { ...s.boxes };
          for (const k of Object.keys(next)) next[k] = next[k].map((b) => (b.id === boxId ? { ...b, ...patch } : b));
          return { boxes: next };
        }),
      removeBox: (boxId) =>
        set((s) => {
          const ix = liveIx();
          const stale = staleChanged(s, boxId, [s.assign[boxId], ix], [undefined, ix]);
          const next = { ...s.boxes };
          for (const k of Object.keys(next)) next[k] = next[k].filter((b) => b.id !== boxId);
          const assign = { ...s.assign };
          delete assign[boxId];
          return { boxes: next, assign, ...stale };
        }),
      setDefault: (boxId, productId) =>
        set((s) => {
          const cur = s.assign[boxId] ?? EMPTY_ASSIGNMENT;
          if (cur.default === productId) return s;
          return writeAssignment(s, boxId, { ...cur, default: productId });
        }),
      setOverride: (boxId, audienceId, productId) =>
        set((s) => {
          const cur = s.assign[boxId] ?? EMPTY_ASSIGNMENT;
          if (cur.overrides[audienceId] === productId) return s;
          return writeAssignment(s, boxId, { ...cur, overrides: { ...cur.overrides, [audienceId]: productId } });
        }),
      clearOverride: (boxId, audienceId) =>
        set((s) => {
          const cur = s.assign[boxId];
          if (!cur || !(audienceId in cur.overrides)) return s;
          const overrides = { ...cur.overrides };
          delete overrides[audienceId];
          return writeAssignment(s, boxId, { ...cur, overrides });
        }),

      include: {},
      scenePrompt: {},
      approved: {},
      setInclude: (sceneId, on) =>
        set((s) => {
          const include = { ...s.include };
          if (on) delete include[sceneId];
          else include[sceneId] = false;
          return { include };
        }),
      setScenePrompt: (sceneId, audience, text) =>
        set((s) => {
          const base = defaultScenePrompt(sceneId, audience, s);
          const value = !text.trim() || text.trim() === base ? undefined : text;
          return { scenePrompt: setIn(s.scenePrompt, sceneId, audience, value) };
        }),
      resetScenePrompt: (sceneId, audience) => set((s) => ({ scenePrompt: setIn(s.scenePrompt, sceneId, audience, undefined) })),
      setApproved: (sceneId, audience, on = true) => set((s) => ({ approved: setIn(s.approved, sceneId, audience, on ? (true as const) : undefined) })),
      approveVersions: (versions) =>
        set((s) => {
          let approved = s.approved;
          for (const v of versions) approved = setIn(approved, v.sceneId, v.audienceId, true as const);
          return { approved };
        }),

      reset: () => set({ ...EMPTY_WORKSPACE }),
    }),
    {
      // One workspace per episode (`cameo-placements`, `cameo-placements:<uploadId>`).
      name: scopedKey('cameo-placements'),
      version: 6,
      partialize: (s) => ({ boxes: s.boxes, assign: s.assign, include: s.include, scenePrompt: s.scenePrompt, approved: s.approved }),
    },
  ),
);

/* ---------- Scene versions: reads ---------- */

type Snap = Pick<PlacementsState, 'boxes' | 'assign' | 'include' | 'scenePrompt' | 'approved'>;

/** One row of "Going into this scene": a box and what it resolves to in an audience. */
export interface SceneItem {
  box: SceneBox;
  /** 1-based number among the scene's boxes (matches the badge on Scenes). */
  n: number;
  /** The product this box shows in the audience (`resolve`). */
  product: CatalogProduct;
  /** How it resolved (default, local, override). */
  state: ResolveState;
  /** The box's prompt for this product and audience. */
  prompt: string;
  /** Gemini wrote it, or the plain template stands in. */
  promptSource: PromptSource;
}

/** The boxes of a scene that show a product in this audience (via `resolve`), numbered as on Scenes. */
export function sceneItems(sceneId: string, audience: AudienceId, s: Snap = usePlacements.getState()): SceneItem[] {
  const out: SceneItem[] = [];
  const ix = liveIx();
  orderBoxes(s.boxes[sceneId] ?? []).forEach((box, i) => {
    const { product, state } = resolveWith(s.assign[box.id], audience, ix);
    if (!product) return;
    const { text, source } = promptBase(box, product, audience);
    out.push({ box, n: i + 1, product, state, prompt: text, promptSource: source });
  });
  return out;
}

/** The composed combined prompt for a scene version (before any edit). */
function defaultScenePrompt(sceneId: string, audience: AudienceId, s: Snap = usePlacements.getState()): string {
  return composeScenePrompt(sceneItems(sceneId, audience, s).map((i) => [i.prompt, i.n] as const));
}

/** The combined prompt in effect, and whether the user edited it. */
export function scenePromptFor(sceneId: string, audience: AudienceId, s: Snap = usePlacements.getState()): { text: string; base: string; edited: boolean } {
  const base = defaultScenePrompt(sceneId, audience, s);
  const custom = s.scenePrompt[sceneId]?.[audience];
  return custom !== undefined ? { text: custom, base, edited: true } : { text: base, base, edited: false };
}

const enabledIds = audienceIds;

/** Scene ids in timeline order (one per shot, as on Scenes). */
const SCENE_IDS: string[] = shots.map((sh) => momentForShot(sh.id)?.id).filter((id): id is string => !!id);

/** Scenes (timeline order) with at least one product in some audience. */
function scenesWithProducts(s: Snap = usePlacements.getState(), audiences: AudienceId[] = enabledIds()): string[] {
  return SCENE_IDS.filter((id) => audiences.some((r) => sceneItems(id, r, s).length > 0));
}

const isIncluded = (sceneId: string, s: Pick<Snap, 'include'> = usePlacements.getState()) => s.include[sceneId] !== false;

/** Scenes that go on to Previews: have products and the Include switch is on. */
function includedScenes(s: Snap = usePlacements.getState(), audiences: AudienceId[] = enabledIds()): string[] {
  return scenesWithProducts(s, audiences).filter((id) => isIncluded(id, s));
}

/** Every (included scene, audience) pair that has at least one product: the one selector every page counts with. */
export function sceneVersions(s: Snap = usePlacements.getState(), audiences: AudienceId[] = enabledIds()): SceneVersion[] {
  return includedScenes(s, audiences).flatMap((sceneId) => audiences.filter((r) => sceneItems(sceneId, r, s).length > 0).map((audienceId) => ({ sceneId, audienceId })));
}

/** Approved scene versions. */
function approvedVersions(s: Snap = usePlacements.getState(), audiences: AudienceId[] = enabledIds()): SceneVersion[] {
  return sceneVersions(s, audiences).filter((v) => s.approved[v.sceneId]?.[v.audienceId]);
}

/* ---------- Scene versions: hooks (memoised on the store slices they read) ---------- */

function useSnap(): [Snap, AudienceId[]] {
  const boxes = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const include = usePlacements((s) => s.include);
  const scenePrompt = usePlacements((s) => s.scenePrompt);
  const approved = usePlacements((s) => s.approved);
  const audiences = useProject((s) => s.audiences);
  const products = useProject((s) => s.products);
  const written = useWrittenPrompts((s) => s.prompts);
  return useMemo(
    () => [{ boxes, assign, include, scenePrompt, approved }, audiences.map((a) => a.id)],
    // products: catalog edits change what a box resolves to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boxes, assign, include, scenePrompt, approved, audiences, products, written],
  );
}

export function useScenesWithProducts(): string[] {
  const [s, r] = useSnap();
  return useMemo(() => scenesWithProducts(s, r), [s, r]);
}
export function useIncludedScenes(): string[] {
  const [s, r] = useSnap();
  return useMemo(() => includedScenes(s, r), [s, r]);
}
export function useSceneVersions(): SceneVersion[] {
  const [s, r] = useSnap();
  return useMemo(() => sceneVersions(s, r), [s, r]);
}
export function useApprovedVersions(): SceneVersion[] {
  const [s, r] = useSnap();
  return useMemo(() => approvedVersions(s, r), [s, r]);
}
export function useSceneItems(sceneId: string, audience: AudienceId): SceneItem[] {
  const [s] = useSnap();
  return useMemo(() => sceneItems(sceneId, audience, s), [s, sceneId, audience]);
}
export function useScenePrompt(sceneId: string, audience: AudienceId) {
  const [s] = useSnap();
  return useMemo(() => scenePromptFor(sceneId, audience, s), [s, sceneId, audience]);
}

/* ---------- Resolve: hooks and coverage ---------- */

/** `resolve` for React: re-renders when the box's assignment or the library changes. */
export function useResolved(boxId: string, audienceId: AudienceId): Resolved {
  const a = usePlacements((s) => s.assign[boxId]);
  const products = useProject((s) => s.products);
  return useMemo(() => resolveWith(a, audienceId, indexOf(products)), [a, audienceId, products]);
}


/* ---------- Follow the project: audiences removed, products edited ---------- */

// Removing an audience drops its overrides; any catalog change (availability, removal) stales the
// versions whose resolved product changed.
useProject.subscribe((next, prev) => {
  if (next.products === prev.products && next.audiences === prev.audiences) return;
  const s = usePlacements.getState();
  const gone = prev.audiences.filter((a) => !next.audiences.some((x) => x.id === a.id)).map((a) => a.id);
  const before = indexOf(prev.products);
  const after = indexOf(next.products);
  const ids = next.audiences.map((a) => a.id);
  let assign = s.assign;
  if (gone.length) {
    assign = Object.fromEntries(
      Object.entries(s.assign).map(([id, a]) => {
        if (!gone.some((g) => g in a.overrides)) return [id, a];
        const overrides = { ...a.overrides };
        gone.forEach((g) => delete overrides[g]);
        return [id, { ...a, overrides }];
      }),
    );
  }
  let acc: Pick<PlacementsState, 'approved'> = { approved: s.approved };
  if (next.products !== prev.products) {
    for (const boxId of Object.keys(assign)) acc = staleChanged({ ...s, ...acc }, boxId, [assign[boxId], before], [assign[boxId], after], ids);
  }
  if (assign !== s.assign || acc.approved !== s.approved) usePlacements.setState({ assign, ...acc });
});
