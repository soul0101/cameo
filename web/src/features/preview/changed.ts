import { create } from 'zustand';
import { scopedKey } from '@/data/episode';
import { persist } from 'zustand/middleware';
import { sceneItems, usePlacements, useSceneItems } from '@/store/placements';
import { useProject } from '@/store/project';
import type { AudienceId } from '@/store/project';

/**
 * "Changed since approval": placements clears a version's approval when
 * its resolved products change, but does not remember that it was approved. This tiny store keeps the
 * product signature each version had when it was last approved; a version that is not approved now,
 * has such a record, and whose current signature differs is "changed since approval". Approving it
 * again (or approving anything with the new products) refreshes the record and the tag goes away.
 */

const key = (sceneId: string, audienceId: AudienceId) => `${sceneId}|${audienceId}`;

/** The products a version would show: box id → product id, in box order. */
const signatureOf = (items: Array<{ box: { id: string }; product: { id: string } }>) => items.map((i) => `${i.box.id}:${i.product.id}`).join(',');

interface SigState {
  sigs: Record<string, string>;
}
export const useApprovedSigs = create<SigState>()(persist(() => ({ sigs: {} }), { name: scopedKey('cameo-approved-sigs'), version: 1 }));

/** Record the signature of every version that is approved right now. */
function sync() {
  const s = usePlacements.getState();
  const cur = useApprovedSigs.getState().sigs;
  let next = cur;
  for (const [sceneId, byAud] of Object.entries(s.approved)) {
    for (const audId of Object.keys(byAud)) {
      const sig = signatureOf(sceneItems(sceneId, audId, s));
      if (!sig) continue;
      if (cur[key(sceneId, audId)] !== sig) next = { ...next, [key(sceneId, audId)]: sig };
    }
  }
  if (next !== cur) useApprovedSigs.setState({ sigs: next });
}

usePlacements.subscribe(sync);
useProject.subscribe(sync);
sync();

/** True when this version was approved before and its products have changed since. */
export function useChangedSinceApproval(sceneId: string, audienceId: AudienceId): boolean {
  const recorded = useApprovedSigs((s) => s.sigs[key(sceneId, audienceId)]);
  const approved = usePlacements((s) => !!s.approved[sceneId]?.[audienceId]);
  const items = useSceneItems(sceneId, audienceId);
  return !approved && recorded !== undefined && recorded !== signatureOf(items);
}

