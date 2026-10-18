import { useEffect } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { activeEpisodeId, scopedKey } from '@/data/episode';
import { sceneById } from '@/features/scenes/model';
import { API_URL, ApiError, getRender, isUnreachable, startRender } from '@/services/api';
import type { RenderResolution, RenderView } from '@/services/api';
import { sceneItems, versionId } from '@/store/placements';
import type { SceneVersion } from '@/store/placements';
import { useStills } from '@/features/preview/stills';
import { toast } from '@/ui';

/**
 * Renders (Gemini Omni) per scene version: one clip per (shot, audience), made from the shot's own video
 * and the version's approved still. The server does the work and caches it; this store remembers which
 * render belongs to which version and polls the running ones.
 */
interface RendersState {
  byVersion: Record<string, RenderView>;
}

export const useRenders = create<RendersState>()(
  persist(
    () => ({ byVersion: {} }),
    { name: scopedKey('cameo-renders'), version: 1, partialize: (s) => ({ byVersion: s.byVersion }) },
  ),
);

const put = (key: string, r: RenderView) => useRenders.setState((s) => ({ byVersion: { ...s.byVersion, [key]: r } }));

/** The approved still's id for a version, from its URL (`.../previews/<id>.png`), or null. */
export function stillIdOf(v: SceneVersion): string | null {
  const url = useStills.getState().stills[versionId(v)]?.url;
  return url?.match(/\/previews\/([0-9a-f]{20})\.png/)?.[1] ?? null;
}

/** Record a render that already exists on the server for a version (a sample's clip). */
export const seedRender = (v: SceneVersion, r: RenderView) => put(versionId(v), r);

/** The finished clip's absolute URL. */
export const renderSrc = (r: RenderView | undefined) => (r?.url ? `${API_URL}${r.url}` : null);

/** Versions whose render request is on its way: a second click never starts a second paid render. */
const starting = new Set<string>();

/** Render one version (or return its cached render). */
export async function renderVersion(v: SceneVersion, resolution: RenderResolution, attempt = 1): Promise<void> {
  const scene = sceneById[v.sceneId];
  const stillId = stillIdOf(v);
  if (!stillId) {
    toast({ tone: 'reject', title: 'Render not started', description: `${scene.copy.name}: approve its preview still first.` });
    return;
  }
  const key = versionId(v);
  if (starting.has(key)) return;
  starting.add(key);
  const items = sceneItems(v.sceneId, v.audienceId).map((i) => ({
    boxId: i.box.id,
    productId: i.product.id,
    label: i.box.label,
    kind: i.box.kind,
    edit: i.box.edit,
    box: i.box.box,
    product: { brand: i.product.brand, name: i.product.name, category: i.product.category, description: i.product.description },
  }));
  try {
    put(key, await startRender(activeEpisodeId, { shotId: scene.shot.id, audienceId: v.audienceId, stillId, items, resolution, attempt }));
  } catch (err) {
    toast({ tone: 'reject', title: 'Render not started', description: isUnreachable(err) ? 'The API stopped answering.' : `${scene.copy.name}: ${err instanceof Error ? err.message : 'error'}` });
  } finally {
    starting.delete(key);
  }
}

/** Longest a render may run before the page stops waiting on it (Omni takes one to two minutes). */
const GIVE_UP_MS = 15 * 60_000;

/**
 * Render several versions: one queue per audience, running side by side. Within an audience the shots go in
 * story order, one after another, so each later cut of a scene can take the earlier cut's look as a reference.
 */
export async function renderVersions(versions: SceneVersion[], resolution: RenderResolution): Promise<void> {
  const byAudience = new Map<string, SceneVersion[]>();
  for (const v of versions) byAudience.set(v.audienceId, [...(byAudience.get(v.audienceId) ?? []), v]);
  await Promise.all(
    [...byAudience.values()].map(async (queue) => {
      for (const v of queue) {
        await renderVersion(v, resolution);
        await waitFor(versionId(v));
      }
    }),
  );
}

const waitFor = (key: string) =>
  new Promise<void>((resolve) => {
    const t0 = Date.now();
    const check = () => (useRenders.getState().byVersion[key]?.status === 'running' && Date.now() - t0 < GIVE_UP_MS ? setTimeout(check, 1500) : resolve());
    check();
  });

const failed = (r: RenderView, error: string): RenderView => ({ ...r, status: 'failed', stage: 'failed', error });

/**
 * Mount once for the whole project (the shell): polls every running render every 3 s until it finishes, on
 * any page, so a queue started on Render keeps going while the producer looks elsewhere. A render the server
 * no longer has, or one running far too long, is marked failed so the page offers a retry.
 */
export function useRenderPolling() {
  useEffect(() => {
    const id = setInterval(() => {
      const running = Object.entries(useRenders.getState().byVersion).filter(([, r]) => r.status === 'running');
      running.forEach(([key, r]) => {
        if (r.startedAt && Date.now() - r.startedAt * 1000 > GIVE_UP_MS) return put(key, failed(r, 'This render took too long. Try again.'));
        getRender(activeEpisodeId, r.id).then(
          (next) => put(key, next),
          (err) => err instanceof ApiError && err.status === 404 && put(key, failed(r, 'The server no longer has this render. Try again.')),
        );
      });
    }, 3000);
    return () => clearInterval(id);
  }, []);
}
