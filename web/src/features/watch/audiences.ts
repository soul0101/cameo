import { useMemo } from 'react';
import type { Placement } from '@/data/types';
import { sceneById } from '@/features/scenes/model';
import { useAudiences } from '@/features/audiences/model';
import { sceneItems, sceneVersions, usePlacements } from '@/store/placements';
import type { SceneVersion } from '@/store/placements';
import { useProject } from '@/store/project';
import type { Audience, AudienceId } from '@/store/project';

/**
 * What Watch shows per audience. Nothing is rendered yet, so the player plays the original episode;
 * a "placed" product is a box's product for the audience in an included scene (Scenes), on screen
 * for that scene's shot. The Shop chip, the products panel and every viewer event follow these.
 */

export interface WatchModel {
  /** Scene versions with at least one product (included scenes × audiences). */
  versions: SceneVersion[];
  /** Audiences with at least one placed product, in list order (Watch defaults to the first). */
  audiences: Audience[];
  /** Placed products per audience, by start time. */
  byAudience: Record<AudienceId, Placement[]>;
  /** Scene ids with products per audience. */
  scenes: Record<AudienceId, string[]>;
}

type Snap = Parameters<typeof sceneItems>[2];

function placedIn(versions: SceneVersion[], audience: AudienceId, s: Snap): Placement[] {
  const out: Placement[] = [];
  for (const v of versions) {
    if (v.audienceId !== audience) continue;
    const scene = sceneById[v.sceneId];
    if (!scene) continue;
    for (const it of sceneItems(v.sceneId, audience, s))
      out.push({
        id: `${it.box.id}:${it.product.id}`,
        momentId: v.sceneId,
        boxId: it.box.id,
        productId: it.product.id,
        object: it.box.label,
        box: it.box.box,
        tIn: scene.from,
        tOut: scene.to,
      });
  }
  return out.sort((a, b) => a.tIn - b.tIn || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export function useWatchModel(): WatchModel {
  const audiences = useAudiences();
  const boxes = usePlacements((s) => s.boxes);
  const assign = usePlacements((s) => s.assign);
  const include = usePlacements((s) => s.include);
  const products = useProject((s) => s.products);
  return useMemo(() => {
    const snap = { ...usePlacements.getState(), boxes, assign, include };
    const ids = audiences.map((a) => a.id);
    const versions = sceneVersions(snap, ids);
    const byAudience: Record<AudienceId, Placement[]> = {};
    const scenes: Record<AudienceId, string[]> = {};
    for (const a of audiences) {
      const list = placedIn(versions, a.id, snap);
      if (!list.length) continue;
      byAudience[a.id] = list;
      scenes[a.id] = [...new Set(list.map((p) => p.momentId))];
    }
    return { versions, audiences: audiences.filter((a) => byAudience[a.id]), byAudience, scenes };
    // products: catalog edits change what a box resolves to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audiences, boxes, assign, include, products]);
}

/** Placed products live at time t. */
export const placedAt = (list: Placement[], t: number) => list.filter((p) => t >= p.tIn && t < p.tOut);
