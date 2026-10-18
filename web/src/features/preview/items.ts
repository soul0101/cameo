import { useSceneItems } from '@/store/placements';
import type { SceneItem } from '@/store/placements';
import type { AudienceId } from '@/store/project';

/**
 * A scene version's items, numbered as on Scenes (`orderBoxes`: top to bottom), the same numbers as the composed prompt's (1)(2)(3). Previews uses these
 * numbers for outlines, tags and "In this shot" cards.
 */
export function useVersionItems(sceneId: string, audience: AudienceId): SceneItem[] {
  return useSceneItems(sceneId, audience);
}
