import { useEffect } from 'react';
import { act, quietly } from '@/services/telemetry';
import { activeEpisodeId, clearEpisodeWorkspace } from '@/data/episode';
import { seedStill } from '@/features/preview/stills';
import { seedRender } from '@/features/render/renders';
import { materialiseScenes, scenes } from '@/features/scenes/model';
import { ApiError, apiAsset, getRender, getSample, previewUrl } from '@/services/api';
import { useStills } from '@/features/preview/stills';
import { categoryOf } from '@/data/starterCatalog';
import { useProject } from '@/store/project';
import { usePlacements } from '@/store/placements';

/**
 * A sample opens ready: the first time this browser opens it, its products go into their boxes, and its
 * approved stills and rendered clips are recorded for their versions, so Scenes, Previews, Render and Watch
 * all show the finished work. After that it is the browser's own workspace like any other.
 */
const doneKey = (id: string) => `cameo-sample-seeded:${id}`;
const seeding = new Set<string>();

const remember = (id: string, value: string) => {
  try {
    localStorage.setItem(doneKey(id), value);
  } catch {
    /* storage blocked */
  }
};

async function seedSample(id: string) {
  if (seeding.has(id)) return; // one seeding at a time (a remount mid-seed waits for the first)
  seeding.add(id);
  try {
    await quietly(() => seed(id));
  } finally {
    seeding.delete(id);
  }
}

async function seed(id: string) {
  let done: string | null = null;
  try {
    done = localStorage.getItem(doneKey(id));
  } catch {
    return;
  }
  if (done === 'not a sample') return;
  let manifest;
  try {
    manifest = await getSample(id);
  } catch (err) {
    // Only the server saying "no such sample" is final; a network hiccup tries again on the next open.
    if (err instanceof ApiError && err.status === 404) remember(id, 'not a sample');
    return;
  }
  // A sample goes by its own name, even where it began as an upload ("download (13)").
  const project = useProject.getState();
  const rec = project.episodes.find((e) => e.id === id);
  if (rec && rec.name !== manifest.name) {
    project.saveEpisode({ ...rec, name: manifest.name });
    if (project.projectId === id) useProject.setState({ name: manifest.name });
  }
  if (done) return;
  // A browser that already worked on this episode (stills of its own) keeps its work.
  if (Object.keys(useStills.getState().stills).length) return remember(id, 'kept own work');
  // Everything the server holds is fetched first and applied below in one synchronous pass: a reload or a failed
  // fetch never leaves a half-seeded sample (which the check above would then keep as "own work" for good).
  let clips: Map<string, Awaited<ReturnType<typeof getRender>>>;
  try {
    const ids = manifest.versions.flatMap((v) => (v.renderId ? [v.renderId] : []));
    clips = new Map(await Promise.all(ids.map(async (r) => [r, await getRender(id, r)] as const)));
  } catch {
    return; // tried again on the next open
  }
  materialiseScenes();
  const st = usePlacements.getState();
  for (const v of manifest.versions) {
    const scene = scenes.find((s) => s.shot.id === v.shotId);
    if (!scene) continue;
    const version = { sceneId: scene.moment.id, audienceId: v.audienceId };
    for (const a of v.assignments) {
      // A box drawn by hand, or a product added to the catalog, exists only where it was made: rebuild it here.
      if (!usePlacements.getState().boxes[scene.moment.id]?.some((b) => b.id === a.boxId)) {
        if (!a.box) continue;
        st.addBox({ id: a.boxId, momentId: scene.moment.id, box: a.box, label: a.label ?? 'Your box', origin: 'drawn', kind: a.kind, edit: a.edit, identify: 'done' });
      }
      if (!useProject.getState().products.some((p) => p.id === a.productId)) {
        if (!a.product) continue;
        const p = a.product;
        useProject.setState((s) => ({
          products: [
            ...s.products,
            { id: a.productId, line: a.productId, brand: p.brand, name: p.name, category: categoryOf(p.category.toLowerCase()), url: '', images: p.image ? [apiAsset(p.image)!] : [], availableIn: 'all', description: p.description ?? undefined },
          ],
        }));
      }
      st.setOverride(a.boxId, v.audienceId, a.productId);
    }
    seedStill(version, previewUrl(`/episodes/${id}/previews/${v.stillId}.png`));
    st.setApproved(version.sceneId, version.audienceId, true);
    const clip = v.renderId && clips.get(v.renderId);
    if (clip) seedRender(version, clip);
  }
  remember(id, String(Date.now()));
}

/** Whether an episode opened in this browser is a ready-made sample. */
export function isSample(id: string): boolean {
  try {
    const v = localStorage.getItem(doneKey(id));
    return v !== null && v !== 'not a sample';
  } catch {
    return false;
  }
}

/** Bring a sample back as it ships: this browser's changes to it are cleared and it seeds again on reload. */
export function restoreSample(id: string) {
  act('restore_sample');
  clearEpisodeWorkspace(id);
  location.assign(`/p/${id}/scenes`);
}

/** Mount in the project layout once the episode is ready. */
export function useSampleSeed(ready: boolean) {
  useEffect(() => {
    if (ready) void seedSample(activeEpisodeId);
  }, [ready]);
}
