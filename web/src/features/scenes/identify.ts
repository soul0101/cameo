import { activeEpisodeId } from '@/data/episode';
import { identify, isUnreachable } from '@/services/api';
import { projectPayload } from '@/services/payload';
import { usePlacements } from '@/store/placements';
import type { SceneBox } from '@/store/placements';

/**
 * The drawn-box moment: mark the box "looking", ask the API what the object is in the context of
 * the scene (`POST /episodes/{id}/identify`: Cloud Vision objects around the box, then Gemini on the
 * keyframe with the box marked, matched against the browser's catalog and audiences), then write its
 * label, its one-line read, its picks and prompts per audience and the Vision objects onto the box.
 * Always the live call; the server caches repeated questions.
 */
export async function identifyBox(b: SceneBox): Promise<void> {
  const st = usePlacements.getState();
  st.patchBox(b.id, { identify: 'looking', identifyError: undefined });
  const shotId = b.momentId; // scene id = shot id
  try {
    const answer = await identify(activeEpisodeId, { shotId, box: b.box, ...projectPayload() });
    if (!usePlacements.getState().boxes[b.momentId]?.some((x) => x.id === b.id)) return; // removed meanwhile
    st.patchBox(b.id, {
      identify: 'done',
      label: answer.label ? answer.label.charAt(0).toUpperCase() + answer.label.slice(1) : b.label,
      kind: answer.kind,
      why: answer.why,
      picks: answer.picks ?? {},
      prompts: answer.prompts ?? {},
      vision: answer.vision?.objects ?? [],
      edit: answer.edit,
      snappedTo: answer.vision?.snappedTo ?? undefined,
      ...(answer.box ? { box: answer.box } : {}),
    });
  } catch (err) {
    if (!usePlacements.getState().boxes[b.momentId]?.some((x) => x.id === b.id)) return;
    st.patchBox(b.id, { identify: 'failed', identifyError: isUnreachable(err) ? 'Backend unreachable: Gemini could not read this spot.' : `Gemini could not read this spot (${err instanceof Error ? err.message : 'error'}).` });
  }
}
