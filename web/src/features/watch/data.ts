import { moments } from '@/data/scenes';
import { episode } from '@/data/episode';
import type { Placement } from '@/data/types';
import type { Analytics } from '@/services/api';
import type { AudienceId } from '@/store/project';
import type { WatchModel } from './audiences';

/** Interest data shaping: the API's analytics (`GET /episodes/{id}/analytics`) as the page shows it. Nothing is estimated here. */

export type MarketFilter = 'all' | AudienceId;

export const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits)}%`;
export const int = (v: number) => v.toLocaleString('en-US');

/** Scenes detection skipped (real detection data), drawn as areas on the chart. */
export const skippedMoments = moments.filter((m) => m.mode === 'blocked');

/** The episode's length in whole seconds. */
export const END = Math.max(1, Math.ceil(episode.duration));

export interface Point {
  t: number;
  impressions: number;
  shopClicks: number;
}

/** One point per second over the episode; seconds without events are zero. */
export function seriesPoints(series: Analytics['series']): Point[] {
  const out: Point[] = Array.from({ length: END + 1 }, (_, t) => ({ t, impressions: 0, shopClicks: 0 }));
  for (const s of series) {
    const p = out[Math.min(END, Math.max(0, Math.floor(s.t)))];
    p.impressions += s.impressions;
    p.shopClicks += s.shop_clicks;
  }
  return out;
}

export const isEmpty = (a: Analytics) => a.totals.impressions + a.totals.shop_clicks + a.totals.product_views + a.totals.product_saves === 0;

/** Every placement across audiences, one per box and product, by start time (the chart bands). */
export function allPlacements(model: WatchModel): Placement[] {
  const seen = new Map<string, Placement>();
  for (const list of Object.values(model.byAudience)) for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()].sort((a, b) => a.tIn - b.tIn);
}

/** Start of the first placement of each product (a table row seeks there). */
export function firstSeen(model: WatchModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of allPlacements(model)) if (out[p.productId] == null) out[p.productId] = p.tIn;
  return out;
}
