import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { activeEpisodeId, scopedKey } from '@/data/episode';
import { sceneById } from '@/features/scenes/model';
import { generatePreview, isUnreachable, previewUrl } from '@/services/api';
import type { PreviewItem } from '@/services/api';
import { scenePromptFor, sceneItems, usePlacements, versionId } from '@/store/placements';
import type { SceneVersion } from '@/store/placements';
import { toast } from '@/ui';
import { promptsReady } from './writePrompts';

/** A generated still for one scene version: where it is, and the prompt and products it was made from. */
export interface Still {
  url: string;
  /** The prompt + products it was generated from; a different signature means it is out of date. */
  sig: string;
  /** A sample's still: only its products count (the prompt on this browser may be worded differently). */
  seeded?: boolean;
  model: string;
  seconds: number;
  cost: number;
  at: number;
}

interface StillsState {
  stills: Record<string, Still>;
  /** Versions being generated now: start time (ms epoch). Not persisted. */
  running: Record<string, number>;
}

export const useStills = create<StillsState>()(
  persist(() => ({ stills: {}, running: {} }), {
    name: scopedKey('cameo-stills'),
    version: 1,
    partialize: (s) => ({ stills: s.stills }),
  }),
);

/** The request for a version: the prompt as shown in the panel and each box's product. */
function requestFor(v: SceneVersion) {
  const scene = sceneById[v.sceneId];
  const items = sceneItems(v.sceneId, v.audienceId);
  const prompt = scenePromptFor(v.sceneId, v.audienceId).text.trim();
  const body = {
    shotId: scene.shot.id,
    audienceId: v.audienceId,
    prompt,
    items: items.map<PreviewItem>((i) => ({
      n: i.n,
      boxId: i.box.id,
      productId: i.product.id,
      label: i.box.label,
      kind: i.box.kind,
      edit: i.box.edit,
      box: i.box.box,
      product: { brand: i.product.brand, name: i.product.name, category: i.product.category, description: i.product.description },
      // the product's photo goes along as a reference image (resolved to a data URL when generating)
      image: i.product.packshot ?? undefined,
    })),
  };
  const products = JSON.stringify(body.items.map((i) => [i.n, i.product.brand, i.product.name, i.box]));
  return { body, sig: JSON.stringify([body.prompt, products]), products };
}

/** A product photo as a data URL for the API (uploads already are; starter photos are fetched). Null when it cannot be read. */
async function asDataUrl(src: string): Promise<string | undefined> {
  if (src.startsWith('data:')) return src;
  try {
    const blob = await (await fetch(src)).blob();
    if (!blob.type.startsWith('image/')) return undefined;
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** Record a still that already exists on the server for a version (a sample's approved still). */
export function seedStill(v: SceneVersion, url: string) {
  const { products } = requestFor(v);
  useStills.setState((s) => ({ stills: { ...s.stills, [versionId(v)]: { url, sig: products, seeded: true, model: 'gemini-nano-banana-2.1', seconds: 0, cost: 0, at: Date.now() } } }));
}

/** The version's still, or null; `stale` when the prompt or products changed since it was made. */
export function useStill(v: SceneVersion): { still: Still | null; stale: boolean; running: number | null } {
  const key = versionId(v);
  const still = useStills((s) => s.stills[key] ?? null);
  const running = useStills((s) => s.running[key] ?? null);
  usePlacements((s) => s.assign);
  usePlacements((s) => s.scenePrompt);
  const now = requestFor(v);
  const stale = !!still && still.sig !== (still.seeded ? now.products : now.sig);
  return { still, stale, running };
}

/** Generate one version's still with Nano Banana (the server caches identical requests). Clears its approval. */
export async function generateStill(v: SceneVersion): Promise<boolean> {
  const key = versionId(v);
  if (useStills.getState().running[key]) return false;
  // Marked running before any wait, so a second click (or Generate all) never sends a second paid request.
  useStills.setState((s) => ({ running: { ...s.running, [key]: Date.now() } }));
  try {
    await promptsReady(v); // Gemini may still be writing a prompt for a product the producer picked
    const { body, sig } = requestFor(v);
    if (!body.items.length || !body.prompt) return false;
    usePlacements.getState().setApproved(v.sceneId, v.audienceId, false);
    const items = await Promise.all(body.items.map(async (i) => ({ ...i, image: i.image ? await asDataUrl(i.image) : undefined })));
    const r = await generatePreview(activeEpisodeId, { ...body, items });
    useStills.setState((s) => ({ stills: { ...s.stills, [key]: { url: previewUrl(r.url), sig, model: r.model, seconds: r.seconds, cost: r.cost, at: Date.now() } } }));
    return true;
  } catch (err) {
    const scene = sceneById[v.sceneId];
    toast({
      tone: 'reject',
      title: 'Preview not generated',
      description: isUnreachable(err) ? 'The API stopped answering.' : `${scene.copy.name}: ${err instanceof Error ? err.message : 'error'}`,
    });
    return false;
  } finally {
    useStills.setState((s) => {
      const running = { ...s.running };
      delete running[key];
      return { running };
    });
  }
}

/** Generate several versions, two at a time (each is one image on the server). */
export async function generateStills(versions: SceneVersion[]): Promise<void> {
  const queue = [...versions];
  const worker = async () => {
    for (let v = queue.shift(); v; v = queue.shift()) await generateStill(v);
  };
  await Promise.all([worker(), worker()]);
}
