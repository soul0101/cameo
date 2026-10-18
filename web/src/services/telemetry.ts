import { activeEpisodeId } from '@/data/episode';
import { usePlacements } from '@/store/placements';
import { useProject } from '@/store/project';
import { API_URL, visitorId } from './api';
import { inUse, onBackInUse } from '@/lib/activity';

/**
 * Product analytics for the operator dashboard, privacy-safe: no IP lookups, no cookies, no third parties.
 * The visitor's country comes from their own browser's time zone (or language region); the rest is the browser,
 * device, screen size class, language, referring site and campaign tags. What they do is read from the app's stores
 * (a product placed in a box, a box drawn, a prompt edited, a version approved, a product or audience added) and
 * from the player (shop clicks, product views, saves), plus how long the tab was in view.
 */
type Props = Record<string, string | number | boolean | null | undefined>;

const SESSION_KEY = 'cameo-session';
const session = (() => {
  try {
    let id = sessionStorage.getItem(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID().slice(0, 12);
      sessionStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return 'none';
  }
})();

let muted = 0;
/** Changes made by the app itself (seeding a sample) are not the visitor's actions. */
export async function quietly<T>(work: () => Promise<T>): Promise<T> {
  muted++;
  try {
    return await work();
  } finally {
    muted--;
  }
}

function send(path: string, body: object) {
  void fetch(`${API_URL}${path}`, {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', 'X-Cameo-Visitor': visitorId() },
    body: JSON.stringify({ ...body, session }),
  }).catch(() => undefined);
}

const recent = new Map<string, number>();
/** One action by the visitor (repeats of the same action within 2 s count once). */
const operator = () => location.pathname.startsWith('/admin');

export function act(action: string, props: Props = {}) {
  if (muted || operator()) return;
  const key = `${action}|${JSON.stringify(props)}`;
  const now = Date.now();
  if (now - (recent.get(key) ?? 0) < 2000) return;
  recent.set(key, now);
  send('/ops/event', { action, episodeId: activeEpisodeId || null, props });
}

/* ---------- Who (anonymous) ---------- */

function browserOf(ua: string) {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Other';
}
function osOf(ua: string) {
  if (/Android/.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}
const deviceOf = (ua: string, w: number) => (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua)) ? 'Tablet' : /Mobi|iPhone/.test(ua) || w < 640 ? 'Phone' : 'Desktop');

async function context(): Promise<Props> {
  const ua = navigator.userAgent;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  let country = '';
  try {
    const zones: Record<string, string> = (await import('@/data/timezones.json')).default;
    country = zones[tz] ?? '';
  } catch {
    /* the table did not load: fall back to the language region */
  }
  const lang = navigator.language || '';
  if (!country) country = lang.split('-')[1]?.toUpperCase() ?? '';
  const params = new URLSearchParams(location.search);
  let referrer = '';
  try {
    const host = document.referrer ? new URL(document.referrer).hostname : '';
    referrer = host && host !== location.hostname ? host : '';
  } catch {
    referrer = '';
  }
  const w = window.screen?.width ?? window.innerWidth;
  return {
    country,
    timezone: tz,
    language: lang,
    browser: browserOf(ua),
    os: osOf(ua),
    device: deviceOf(ua, w),
    screen: w >= 1440 ? 'large' : w >= 1024 ? 'laptop' : w >= 640 ? 'tablet' : 'phone',
    referrer,
    utmSource: params.get('utm_source') ?? '',
    utmCampaign: params.get('utm_campaign') ?? '',
  };
}

const once = (key: string, value?: string) => {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    sessionStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
  return null;
};

/**
 * One page view; the first of a tab session also says who is looking. The app reloads when it switches episodes, so a
 * repeat of the same page within a few seconds is the same view.
 */
export function view(path: string, episodeId: string | null) {
  if (operator()) return; // the operator's own dashboard is not a visit
  const last = once('cameo-last-view');
  const now = Date.now();
  if (last) {
    const [p, t] = last.split('|');
    if (p === path && now - Number(t) < 5000) return;
  }
  once('cameo-last-view', `${path}|${now}`);
  const entry = !once('cameo-entry-sent');
  if (!entry) return send('/ops/visit', { path, episodeId });
  once('cameo-entry-sent', '1');
  void context().then((c) => send('/ops/visit', { path, episodeId, context: c, entry: true }));
}

/* ---------- What they do ---------- */

let started = false;
/** Mount once at the root: follows the stores and the time the tab is in view. */
export function startTelemetry() {
  if (started) return;
  started = true;

  usePlacements.subscribe((s, prev) => {
    for (const [boxId, a] of Object.entries(s.assign)) {
      const b = prev.assign[boxId];
      if (a === b) continue;
      if (a.default !== (b?.default ?? null)) act(a.default ? 'place_product' : 'remove_product', { product: a.default ?? b?.default ?? '', for: 'every audience' });
      for (const [aud, pid] of Object.entries(a.overrides)) {
        if (b?.overrides[aud] !== pid) act(pid === 'none' ? 'remove_product' : 'place_product', { product: pid === 'none' ? (b?.overrides[aud] ?? '') : pid, for: aud });
      }
    }
    if (s.boxes !== prev.boxes) {
      const count = (x: typeof s.boxes) => Object.values(x).flat().filter((b) => b.origin === 'drawn').length;
      if (count(s.boxes) > count(prev.boxes)) act('draw_box');
    }
    if (s.scenePrompt !== prev.scenePrompt) act('edit_prompt');
    for (const [scene, auds] of Object.entries(s.approved)) {
      for (const aud of Object.keys(auds)) if (!prev.approved[scene]?.[aud]) act('approve', { scene, for: aud });
    }
  });

  useProject.subscribe((s, prev) => {
    if (s.products.length > prev.products.length) act('add_product', { product: s.products[s.products.length - 1]?.name ?? '' });
    if (s.audiences.length > prev.audiences.length) act('add_audience', { audience: s.audiences[s.audiences.length - 1]?.name ?? '' });
  });

  // Time in use (visible and recently interacted with), sent at most once a minute and when the tab is hidden or
  // closed; an idle open tab sends nothing, so it never keeps the server awake.
  let since = inUse() ? Date.now() : 0;
  const flush = () => {
    if (!since || operator()) return;
    const seconds = Math.round((Date.now() - since) / 1000);
    since = inUse() ? Date.now() : 0;
    if (seconds >= 3) send('/ops/event', { action: 'engaged', episodeId: activeEpisodeId || null, props: { seconds: Math.min(seconds, 600) } });
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  onBackInUse(() => {
    since = Date.now();
  });
  window.addEventListener('pagehide', flush);
  setInterval(flush, 60_000);
}
