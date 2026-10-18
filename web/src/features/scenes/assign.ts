import { liveIndex } from '@/data/catalog';
import { resolveWith, usePlacements } from '@/store/placements';
import type { AudienceId } from '@/store/project';

/** What a pick did: became the default, set an override, cleared one (back to inheriting), or nothing. */
export type AssignResult = 'default' | 'override' | 'revert' | 'same';

/** One product choice for a box, for the active audience only (an override); the same product again is a no-op. */
export function assignFor(boxId: string, audienceId: AudienceId, productId: string): AssignResult {
  // A pick is for the audience it was made in only: the other audiences stay as they are, so placing
  // a tote for one audience never quietly puts one in another. (Fill with suggestions is the every-audience action.)
  const st = usePlacements.getState();
  if (resolveWith(st.assign[boxId], audienceId, liveIndex()).product?.id === productId) return 'same';
  st.setOverride(boxId, audienceId, productId);
  return 'override';
}

/** The toast's second line for a pick. */
export function assignLine(result: AssignResult, audienceName: string): string {
  return result === 'default' ? 'Every audience' : result === 'override' ? `For ${audienceName} only` : `Back to the default for ${audienceName}`;
}
