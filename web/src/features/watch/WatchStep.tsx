import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowRight, Play } from '@phosphor-icons/react';
import { episode } from '@/data/episode';
import { useMaster } from '@/features/render/master';
import { AudienceBar } from '@/features/audiences/AudienceBar';
import { audienceLabel } from '@/features/audiences/model';
import { useSectionNav } from '@/features/preview/nav';
import { useUI } from '@/store/ui';
import { useWatchModel } from './audiences';
import { mmss } from '@/lib/timecode';
import { cx } from '@/lib/cx';
import { Button, EmptyState, Segmented, StepTitle } from '@/ui';
import { Interest } from './Interest';
import { Player } from './Player';
import type { MarketFilter } from './data';

type Tab = 'player' | 'interest';

/**
 * Watch: the title, then Player | Interest in a segmented control.
 * The tab lives in the URL (?tab=interest) so it survives reloads and can be linked.
 *
 * Products come from `useWatchModel`: the episode always plays in full (the original), and only
 * scenes with assigned products carry any. No products placed → an empty state with a way to
 * watch the plain original.
 */
export function WatchStep() {
  const go = useSectionNav();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { projectId = '' } = useParams();
  const tab: Tab = params.get('tab') === 'interest' ? 'interest' : 'player';
  const [rawFilter, setFilter] = useState<MarketFilter>('all');
  const [plain, setPlain] = useState(false);
  const model = useWatchModel();
  const audiences = model.audiences;
  const filter: MarketFilter = rawFilter === 'all' || audiences.some((r) => r.id === rawFilter) ? rawFilter : 'all';

  // Watch opens on the first audience (that has products); the control moves it from there.
  useEffect(() => {
    if (audiences[0]) useUI.getState().setMarket(audiences[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const uiMarket = useUI((s) => s.market);
  const market = audiences.some((r) => r.id === uiMarket) ? uiMarket : audiences[0]?.id;
  const placed = market ? model.byAudience[market] : undefined;
  // The audience's version with Gemini Omni's rendered shots cut in, once any are rendered; else the original.
  const master = useMaster(market);
  const sceneCount = market ? model.scenes[market].length : 0;
  const empty = audiences.length === 0;

  // Player lives at /watch, Interest at /analytics?tab=interest: switching moves between the two
  // sections so the sidebar highlights the right one.
  const setTab = (next: Tab) => {
    const q = new URLSearchParams(params);
    q.delete('t');
    if (next === 'interest') q.set('tab', 'interest');
    else q.delete('tab');
    const s = q.toString();
    navigate(`/p/${projectId}/${next === 'interest' ? 'analytics' : 'watch'}${s ? `?${s}` : ''}`);
  };

  const fact =
    tab === 'interest'
      ? `${episode.title} · ${mmss(Math.round(episode.duration))}`
      : market
        ? `${sceneCount} ${sceneCount === 1 ? 'scene' : 'scenes'} with products for ${audienceLabel(market)} · ${mmss(Math.round(episode.duration))}`
        : `${episode.title} · ${mmss(Math.round(episode.duration))}`;

  return (
    <div className={cx('flex flex-col', tab === 'player' && (!empty || plain) && 'md:h-[calc(100dvh-104px)]')}>
      <StepTitle title={tab === 'interest' ? 'How viewers respond' : 'Watch your episode'} fact={fact} className="shrink-0" />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 pt-4 pb-5 max-md:pb-4">
        <Segmented
          label="View"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'player', label: 'Player' },
            { value: 'interest', label: 'Interest' },
          ]}
        />
        {tab === 'interest' && audiences.length > 0 && (
          <AudienceBar label="Audience" includeAll audiences={audiences} value={filter} onChange={setFilter} />
        )}
      </div>
      {tab === 'interest' ? (
        <Interest filter={filter} model={model} onPlayer={() => setTab('player')} />
      ) : empty && !plain ? (
        <EmptyState
          title="No products placed yet"
          body="Assign products to the detected boxes in Scenes to see them beside the episode."
          actions={
            <>
              <Button variant="primary" trailing={<ArrowRight />} onClick={() => go('scenes')}>
                Go to Scenes
              </Button>
              <Button variant="ghost" icon={<Play weight="fill" />} onClick={() => setPlain(true)}>
                Watch the original
              </Button>
            </>
          }
        />
      ) : (
        <Player episode={master ? { ...episode, media: master, poster: master.replace(/\.mp4$/, '.jpg') } : episode} placed={placed ?? []} market={market ?? uiMarket} audiences={audiences} autoStart={plain} />
      )}
    </div>
  );
}
