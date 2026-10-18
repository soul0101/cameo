import { act } from '@/services/telemetry';
import { activeEpisodeId } from '@/data/episode';
import type { Placement } from '@/data/types';
import { postEvent } from '@/services/api';
import type { EventType } from '@/services/api';
import type { AudienceId } from './project';

/**
 * Viewer events from the Watch player, sent to `POST /events` as they happen. One session id per
 * page load (`crypto.randomUUID`). Interest reads them back from `GET /episodes/{id}/analytics`;
 * nothing is counted or seeded in the browser.
 */
const SESSION_ID: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
})();

/** Record one viewer event for a placed product at episode second `t`. */
export function track(type: EventType, t: number, audienceId: AudienceId, p?: Placement) {
  if (type !== 'impression') act(`viewer_${type}`, { product: p?.productId, for: audienceId });
  postEvent({
    episodeId: activeEpisodeId,
    sessionId: SESSION_ID,
    type,
    t: Math.round(t * 100) / 100,
    audienceId,
    ...(p ? { shotId: p.momentId, boxId: p.boxId, productId: p.productId } : {}),
  });
}
