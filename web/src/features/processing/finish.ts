import { clearEpisodeWorkspace, uploadRecord } from '@/data/episode';
import type { EpisodeRecord } from '@/data/episode';
import { fetchDetectedFile } from '@/data/detected';
import { payloadSignature, projectPayload } from '@/services/payload';
import { useProject } from '@/store/project';

/**
 * End of a processing run: fetch the episode's detected.json from the API, cache it on the episode
 * record (`useProject().episodes`) and, on a re-run, drop the old working state so Scenes rebuilds
 * from the new detection. Returns the stored record, or null when there is no detection output.
 * Throws `ApiUnreachable` when the server does not answer.
 */
export async function storeProcessedEpisode(episodeId: string, name: string, rerun: boolean): Promise<EpisodeRecord | null> {
  const detected = await fetchDetectedFile(episodeId, '');
  if (!detected) return null;
  const project = useProject.getState();
  const prev = project.episodes.find((e) => e.id === episodeId);
  const base = prev ?? uploadRecord(episodeId, name, null);
  // A detection run (or re-run) starts from its own stage 3: the project's match goes back to ''.
  const rec: EpisodeRecord = { ...base, detected, processedAt: Date.now(), matchedWith: payloadSignature(projectPayload()), matchId: '' };
  project.saveEpisode(rec);
  if (rerun) clearEpisodeWorkspace(episodeId);
  return rec;
}
