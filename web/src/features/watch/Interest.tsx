import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { ArrowClockwise, ArrowRight } from '@phosphor-icons/react';
import { enter } from '@/lib/motion';
import { cx } from '@/lib/cx';
import { activeEpisodeId } from '@/data/episode';
import { audienceLabel } from '@/features/audiences/model';
import { fetchAnalytics, isUnreachable } from '@/services/api';
import type { Analytics, Counts } from '@/services/api';
import { Button, EmptyState, Skeleton, Unreachable } from '@/ui';
import { PlacementTable } from './PlacementTable';
import { TimelineChart } from './TimelineChart';
import { usePlayhead } from './session';
import { allPlacements, firstSeen, int, isEmpty, pct, seriesPoints } from './data';
import type { MarketFilter } from './data';
import type { WatchModel } from './audiences';

type Load = { status: 'loading' } | { status: 'unreachable' } | { status: 'error'; message: string } | { status: 'ready'; data: Analytics };

const ZERO: Counts = { impressions: 0, shop_clicks: 0, product_views: 0, product_saves: 0 };
const of = (a: number, b: number, what: string) => `${b > 0 ? pct(a / b) : '0.0%'} of ${what}`;

/**
 * Interest tab: impressions → shop clicks → product views → saves, read
 * from the API, then the per-second timeline and the per-product table. The audience filter only
 * narrows the stat row: the API splits the totals by audience, not the series or products.
 */
export function Interest({ filter, model, onPlayer }: { filter: MarketFilter; model: WatchModel; onPlayer: () => void }) {
  const playhead = usePlayhead((s) => s.t);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const read = useCallback(async () => {
    try {
      setLoad({ status: 'ready', data: await fetchAnalytics(activeEpisodeId) });
    } catch (err) {
      setLoad(isUnreachable(err) ? { status: 'unreachable' } : { status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
    }
  }, []);
  useEffect(() => {
    void read();
  }, [read]);
  const refresh = async () => {
    setRefreshing(true);
    await read();
    setRefreshing(false);
  };

  const data = load.status === 'ready' ? load.data : null;
  const series = useMemo(() => (data ? seriesPoints(data.series) : []), [data]);
  const placements = useMemo(() => allPlacements(model), [model]);
  const seek = useMemo(() => firstSeen(model), [model]);

  if (load.status === 'loading')
    return (
      <div aria-busy="true" className="flex flex-col gap-6 max-md:gap-4">
        <div className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-md:gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={116} className="rounded-[20px]" />
          ))}
        </div>
        <Skeleton height={376} className="rounded-[20px]" />
      </div>
    );
  if (load.status === 'unreachable') return <Unreachable what="viewer activity" onRetry={read} />;
  if (load.status === 'error')
    return (
      <EmptyState
        title="Could not load viewer activity"
        body={load.message}
        actions={
          <Button variant="primary" icon={<ArrowClockwise />} onClick={() => void read()}>
            Retry
          </Button>
        }
      />
    );
  if (!data) return null;
  if (isEmpty(data))
    return (
      <EmptyState
        title="No viewer activity yet"
        body="Play the episode on Watch; impressions, shop clicks, product views and saves are recorded here as they happen."
        actions={
          <>
            <Button variant="primary" trailing={<ArrowRight />} onClick={onPlayer}>
              Go to Player
            </Button>
            <Button variant="ghost" icon={<ArrowClockwise />} loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          </>
        }
      />
    );

  const c: Counts = filter === 'all' ? data.totals : (data.byAudience.find((a) => a.audienceId === filter) ?? ZERO);
  return (
    <div className="flex flex-col gap-6 max-md:gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-13 text-text-2">
        <span>
          {filter === 'all' ? 'All audiences' : audienceLabel(filter)} · counts from viewer events recorded by the player
          {filter !== 'all' && <span className="text-text-3"> · the chart and table below cover all audiences</span>}
        </span>
        <Button variant="ghost" size="sm" icon={<ArrowClockwise />} loading={refreshing} onClick={() => void refresh()} className="ml-auto max-md:ml-0">
          Refresh
        </Button>
      </div>
      <dl className="grid grid-cols-4 gap-4 max-lg:grid-cols-2 max-md:gap-3">
        <Stat i={0} label="Impressions" value={int(c.impressions)} sub="On screen for 1 s or more" />
        <Stat i={1} label="Shop clicks" value={int(c.shop_clicks)} sub={of(c.shop_clicks, c.impressions, 'impressions')} />
        <Stat i={2} label="Product views" value={int(c.product_views)} sub={of(c.product_views, c.shop_clicks, 'shop clicks')} />
        <Stat i={3} label="Saves" value={int(c.product_saves)} sub={of(c.product_saves, c.product_views, 'views')} />
      </dl>
      <TimelineChart data={series} playhead={playhead} placements={placements} />
      <PlacementTable rows={data.byProduct} seek={seek} />
    </div>
  );
}

function Stat({ i, label, value, sub, className }: { i: number; label: string; value: ReactNode; sub: string; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...enter, delay: reduce ? 0 : i * 0.04 }}
      className={cx('surface flex min-w-0 flex-col gap-3 p-5 max-md:gap-2 max-md:p-4', className)}
    >
      <dt className="truncate text-13 text-text-2">{label}</dt>
      <dd>
        <span className="block text-32 leading-none font-semibold tracking-[-0.02em] text-text tabular-nums max-md:text-24">{value}</span>
        <span className="mt-2 block truncate text-12 text-text-3 max-md:line-clamp-2 max-md:whitespace-normal">{sub}</span>
      </dd>
    </motion.div>
  );
}
