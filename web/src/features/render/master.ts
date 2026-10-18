import { useEffect, useMemo, useState } from 'react';
import { activeEpisodeId } from '@/data/episode';
import { buildMaster } from '@/services/api';
import { useStills } from '@/features/preview/stills';
import { useApprovedVersions, versionId } from '@/store/placements';
import { useRenders } from './renders';

/**
 * The episode as an audience watches it: every shot with a finished render cut in, the original everywhere
 * else, the episode's own audio throughout. Built on the server and cached; null while building or when the
 * audience has no render yet.
 */
export function useMaster(audienceId: string | undefined): string | null {
  const byVersion = useRenders((s) => s.byVersion);
  const stills = useStills((s) => s.stills);
  const approved = useApprovedVersions();
  const ids = useMemo(() => {
    if (!audienceId) return [];
    const ids: string[] = [];
    for (const v of approved) {
      if (v.audienceId !== audienceId) continue;
      const r = byVersion[versionId(v)];
      // Only a clip made from the version's current approved still: a swapped product never shows an old clip.
      if (!r || r.status !== 'done' || !stills[versionId(v)]?.url.includes(`/previews/${r.stillId}.png`)) continue;
      ids.push(r.id);
    }
    return ids.sort();
  }, [byVersion, stills, approved, audienceId]);
  const key = ids.join(',');
  const [url, setUrl] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!audienceId || !ids.length) return;
    let live = true;
    buildMaster(activeEpisodeId, audienceId, ids).then(
      (u) => live && setUrl({ key: `${audienceId}|${key}`, url: u }),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audienceId, key]);
  return url && url.key === `${audienceId}|${key}` ? url.url : null;
}
