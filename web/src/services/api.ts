/**
 * Client for the Cameo API (`agents/`, FastAPI). Endpoints are documented in `docs/api.md`. The browser
 * never calls a model: every Gemini and Cloud Vision call happens on the server. Projects, catalog
 * and audiences live in the browser and travel in request bodies (`services/payload.ts`).
 *
 * When the server cannot be reached, calls throw `ApiUnreachable`; pages show a calm
 * "Backend unreachable" state with a retry (`ui/Unreachable`).
 */

import { inUse, onBackInUse } from '@/lib/activity';

export const API_URL: string = ((import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8787').replace(/\/$/, '');

export type JobStageId = 'ingest' | 'vision' | 'understand' | 'localise' | 'match';
export type JobState = 'running' | 'progress' | 'done' | 'failed' | 'needs_confirmation' | 'cancelled' | 'complete';

export interface JobEvent {
  seq: number;
  t: number;
  stage: JobStageId | 'job';
  state: JobState;
  message: string;
  counts?: Record<string, number>;
  tokens?: number;
  seconds?: number;
  cost?: number;
  calls?: number;
  progress?: number;
  /** Final event of a match job: the id its detected.json is fetched with. */
  matchId?: string;
}

export interface StartedJob {
  jobId: string;
  episodeId: string;
}

/** The server did not answer (network error or timeout), as opposed to answering with an error. */
/** The API answered with an error status (404: it does not have that thing). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ApiUnreachable extends Error {
  constructor() {
    super('Backend unreachable');
    this.name = 'ApiUnreachable';
  }
}

export const isUnreachable = (err: unknown): err is ApiUnreachable => err instanceof ApiUnreachable;

/* ---------- Contract shapes ---------- */

export type AudienceId = string;
export interface ApiAudience {
  id: AudienceId;
  name: string;
  kind: string;
  basedOn?: AudienceId;
}
export interface ApiProduct {
  id: string;
  brand: string;
  name: string;
  category: string;
  url: string;
  availableIn: 'all' | AudienceId[];
  description?: string;
}
export interface ApiBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface ProjectPayload {
  catalog: ApiProduct[];
  audiences: ApiAudience[];
}

export interface IdentifyResult {
  label: string;
  kind: string;
  why: string;
  picks: Record<AudienceId, Array<{ productId: string; why: string }>>;
  prompts: Record<AudienceId, string>;
  edit?: 'replace' | 'place' | 'display';
  vision?: { objects: string[]; snappedTo?: string | null };
  /** The box after snapping to the Cloud Vision object it mostly covered (unchanged otherwise). */
  box?: ApiBox;
}

export type EventType = 'impression' | 'shop_click' | 'product_view' | 'product_save';
export interface ViewerEvent {
  episodeId: string;
  sessionId: string;
  type: EventType;
  /** Episode second. */
  t: number;
  shotId?: string;
  boxId?: string;
  productId?: string;
  audienceId?: string;
}

export interface Counts {
  impressions: number;
  shop_clicks: number;
  product_views: number;
  product_saves: number;
}
export interface Analytics {
  totals: Counts;
  byProduct: Array<Counts & { productId: string }>;
  byAudience: Array<Counts & { audienceId: string }>;
  series: Array<{ t: number; impressions: number; shop_clicks: number }>;
}

/* ---------- URLs ---------- */

const ep = (id: string) => `${API_URL}/episodes/${encodeURIComponent(id)}`;

/** `'proxy'` is the mp4 proxy; anything else is a keyframe name (`C01_mid`). */
export const mediaUrl = (episodeId: string, what: 'proxy' | (string & {})) =>
  what === 'proxy' ? `${ep(episodeId)}/media/proxy` : `${ep(episodeId)}/media/keyframes/${what}.jpg`;

/** Base URL of an episode's keyframes (`${base}${name}.jpg`). */
export const keyframesBase = (episodeId: string) => `${ep(episodeId)}/media/keyframes/`;

/* ---------- Requests ---------- */

/** Set by `services/health`: any request that gets no answer marks the API as down at once. */
let onUnreachable: (() => void) | null = null;
export const setUnreachableReporter = (fn: (() => void) | null) => {
  onUnreachable = fn;
};

/** This browser's anonymous id: the server counts visitors and their requests by it (no account, no personal data). */
export function visitorId(): string {
  try {
    let id = localStorage.getItem('cameo-visitor');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('cameo-visitor', id);
    }
    return id;
  } catch {
    return 'anonymous';
  }
}

/*
 * Waking: the API sleeps when nobody uses it and takes a few seconds to start again. A request that is still waiting
 * after WAKE_AFTER_MS, when nothing has answered for COLD_AFTER_MS (or ever), reports "waking" until an answer comes.
 * Long but normal work (a preview, a render) happens while the server is answering, so it never shows as waking.
 */
const WAKE_AFTER_MS = 1200;
const COLD_AFTER_MS = 5 * 60_000;
let lastAnswer = 0;
let waiting = 0;
let wakeReporter: ((waking: boolean) => void) | null = null;
export const setWakeReporter = (fn: (waking: boolean) => void) => {
  wakeReporter = fn;
};

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const cold = Date.now() - lastAnswer > COLD_AFTER_MS;
  let reported = false;
  const wake = cold
    ? setTimeout(() => {
        reported = true;
        if (waiting++ === 0) wakeReporter?.(true);
      }, WAKE_AFTER_MS)
    : undefined;
  let r: Response;
  try {
    const headers = { 'X-Cameo-Visitor': visitorId(), ...(init.headers as Record<string, string> | undefined) };
    r = await fetch(`${API_URL}${path}`, { cache: 'no-store', ...init, headers, signal: ctl.signal });
    lastAnswer = Date.now();
  } catch {
    // Our own timeout: the server answered nothing in time but may still be working, so it is not marked down.
    if (ctl.signal.aborted) throw new Error('Cameo took too long to answer. It may still finish: check again in a moment.');
    onUnreachable?.();
    throw new ApiUnreachable();
  } finally {
    clearTimeout(timer);
    clearTimeout(wake);
    if (reported && --waiting === 0) wakeReporter?.(false);
  }
  if (!r.ok) {
    const detail = await r
      .json()
      .then((d: { detail?: unknown }) => (typeof d?.detail === 'string' ? d.detail : ''))
      .catch(() => '');
    throw new ApiError(detail || `${path} failed (${r.status})`, r.status);
  }
  return (await r.json().catch(() => ({}))) as T;
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

interface StartResponse {
  jobId: string;
  episodeId: string;
}
const started = (d: StartResponse): StartedJob => ({ jobId: d.jobId, episodeId: d.episodeId });

/** Files already put in Cloud Storage this session: "use the first 10 seconds" after a too-long answer needs no second upload. */
const stored = new WeakMap<File, string>();

/** PUT a file to a signed Cloud Storage URL, reporting bytes sent (fetch cannot report upload progress; XHR can). */
function putFile(url: string, headers: Record<string, string>, file: File, { onProgress, signal }: UploadOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() !== 'host') xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`The upload to storage was refused (${xhr.status}).`)));
    xhr.onerror = () => reject(new Error('The upload to storage did not go through. Check the connection and try again.'));
    xhr.send(file);
  });
}

/**
 * Upload a video and start its episode. The file goes straight to Cloud Storage through a signed URL (Cloud Run
 * accepts request bodies up to 32 MB, and phone videos are often bigger); a server without a bucket takes it directly.
 */
export interface UploadOptions {
  /** Bytes sent so far, while the file goes to Cloud Storage. */
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export async function startUpload(file: File, trim = false, opts: UploadOptions = {}): Promise<StartedJob> {
  let key = stored.get(file);
  if (!key) {
    let signed: { key: string; url: string; headers: Record<string, string> } | null = null;
    try {
      signed = await request('/uploads', json({ name: file.name, size: file.size, type: file.type || 'application/octet-stream' }));
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 501)) throw err;
    }
    if (!signed) {
      const body = new FormData();
      body.append('file', file);
      if (trim) body.append('trim', '1');
      return request<StartResponse>('/episodes', { method: 'POST', body }, 10 * 60_000).then(started);
    }
    await putFile(signed.url, signed.headers, file, opts);
    key = signed.key;
    stored.set(file, key);
  }
  return request<StartResponse>('/episodes', json({ upload: key, trim }), 5 * 60_000).then(started);
}

/** Re-run detection for a stored episode (an upload waits for the cost confirmation again). */
export const startRerun = (episodeId: string) => request<StartResponse>(`/episodes/${encodeURIComponent(episodeId)}/rerun`, { method: 'POST' }).then(started);

/** Re-run stage 3 (matching) against the browser's catalog and audiences. The job asks for confirmation first. */
export const startMatch = (episodeId: string, payload: ProjectPayload) =>
  request<{ jobId: string }>(`/episodes/${encodeURIComponent(episodeId)}/match`, json(payload)).then((d) => ({ jobId: d.jobId, episodeId }) satisfies StartedJob);

/**
 * Confirm a job waiting at `needs_confirmation`. A detection job takes the catalog and audiences
 * stage 3 matches against; a match job already has them (no body).
 */
export const confirmJob = (jobId: string, payload?: ProjectPayload) =>
  request(`/jobs/${jobId}/confirm`, payload ? json(payload) : { method: 'POST' }).then(() => undefined);

export const cancelJob = (jobId: string) =>
  request(`/jobs/${jobId}/cancel`, { method: 'POST' }, 5000)
    .then(() => undefined)
    .catch(() => undefined);

/**
 * `GET /episodes/{id}/detected.json?match=<matchId>`, or null when the episode has none yet. Always
 * names the project's own match: `''` is the original detection run (also the server's default;
 * a re-match is served only by its id). Throws when the server does not answer or fails.
 */
export async function fetchDetected(episodeId: string, matchId = ''): Promise<unknown | null> {
  try {
    return await request<unknown>(`/episodes/${encodeURIComponent(episodeId)}/detected.json?match=${encodeURIComponent(matchId)}`, {}, 15_000);
  } catch (err) {
    // Only "not found" means there is none; a busy or failing server is an error the page offers to retry.
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** `GET /health`: true when the API answers. Never throws. */
// Generous: a server waking from sleep takes a few seconds, and that is not an outage.
export const checkHealth = () =>
  request('/health', {}, 20_000).then(
    () => true,
    () => false,
  );

export interface EpisodeInfo {
  episodeId: string;
  sample: boolean;
  hasDetected: boolean;
  duration: number;
  shots: number;
}

/** `GET /episodes/{id}`, or null when the server does not know the episode. Throws when it does not answer or fails. */
export async function fetchEpisodeInfo(episodeId: string): Promise<EpisodeInfo | null> {
  try {
    return await request<EpisodeInfo>(`/episodes/${encodeURIComponent(episodeId)}`, {}, 15_000);
  } catch (err) {
    // Only "not found" means there is none; a busy or failing server is an error the page offers to retry.
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

/** Gemini (with Cloud Vision context) reads a box drawn on a shot's keyframe. Always live; the server caches. */
export const identify = (episodeId: string, body: { shotId: string; box: ApiBox } & ProjectPayload) =>
  request<IdentifyResult>(`/episodes/${encodeURIComponent(episodeId)}/identify`, json(body), 60_000);

/* ---------- Previews (Nano Banana) ---------- */

/** What the server needs to edit one scene version's keyframe: the edit prompt and each box's product. */
export interface PreviewItem {
  n: number;
  /** The scene box and the catalog product, stored with the still so a sample can be rebuilt. */
  boxId?: string;
  productId?: string;
  label: string;
  kind?: string;
  edit?: 'replace' | 'place' | 'display';
  box: ApiBox;
  product: { brand: string; name: string; category: string; description?: string };
  /** The product's cover image as a data URL, when the browser has one (sent as a reference). */
  image?: string;
}
export interface PreviewRequest {
  shotId: string;
  audienceId: string;
  prompt: string;
  items: PreviewItem[];
}
export interface PreviewResult {
  id: string;
  /** Path on the API (`/episodes/{id}/previews/{id}.png`); `previewUrl` makes it absolute. */
  url: string;
  model: string;
  seconds: number;
  cost: number;
  cached: boolean;
}
/** Gemini writes the edit prompt for a product the producer put in a box (cached on the server). */
export const writePrompt = (episodeId: string, body: { shotId: string; box: ApiBox; label: string; kind?: string; product: { brand: string; name: string; category: string; description?: string } }) =>
  request<{ prompt: string }>(`/episodes/${encodeURIComponent(episodeId)}/prompt`, json(body), 60_000).then((r) => r.prompt);

/** A box through its shot: normalised [x, y, w, h] at `fps` samples per second from `t0`, null where out of view. */
export interface BoxTrack {
  t0: number;
  fps: number;
  boxes: Array<number[] | null>;
  /** When the spot is largest in view. */
  best: number;
}
/** Gemini's boxes, each followed through its shot (by detected box id). CPU-only on the server, cached. */
export const fetchTracks = (episodeId: string) => request<Record<string, BoxTrack>>(`/episodes/${encodeURIComponent(episodeId)}/tracks`, {}, 60_000);
/** A drawn box followed through its shot from the frame it was drawn on. */
export const trackBox = (episodeId: string, body: { shotId: string; t: number; box: ApiBox }) =>
  request<BoxTrack>(`/episodes/${encodeURIComponent(episodeId)}/track`, json(body), 60_000);

/** Generate (or fetch the cached) still for one scene version. Costs one image on the server unless cached. */
export const generatePreview = (episodeId: string, body: PreviewRequest) =>
  request<PreviewResult>(`/episodes/${encodeURIComponent(episodeId)}/previews`, json(body), 180_000);
export const previewUrl = (path: string) => `${API_URL}${path}`;

export interface ApiConfig {
  maxSeconds: number;
  imageModel: string | null;
  /** USD per generated still (estimate shown before generating). */
  imagePrice: number;
  videoModel: string | null;
  /** USD per second of rendered video, by resolution (estimate shown before rendering). */
  videoPricePerSecond: Record<RenderResolution, number>;
}

/* ---------- Renders (Gemini Omni) ---------- */

export type RenderResolution = '360p';
export interface RenderRequest {
  shotId: string;
  audienceId: string;
  /** The approved preview still (its id): Omni's <IMAGE_REF_0>. */
  stillId: string;
  items: Array<Omit<PreviewItem, 'n' | 'image'>>;
  resolution: RenderResolution;
  /** 2+ asks for a new take instead of the cached one. */
  attempt?: number;
}
export interface RenderView {
  id: string;
  status: 'running' | 'done' | 'failed';
  stage: 'rendering' | 'verifying' | 'done' | 'failed';
  shotId: string;
  audienceId: string;
  stillId: string;
  attempt?: number;
  resolution: RenderResolution;
  seconds: number;
  estimate: number;
  cost?: number;
  renderSeconds?: number;
  /** Gemini's check of the clip against the still; `pass` null when the check could not run. */
  verify?: { pass: boolean | null; note: string; productsMatch?: boolean; newCuts?: boolean; peopleChanged?: boolean };
  error?: string;
  continuity?: boolean;
  startedAt?: number;
  /** Path on the API when done. */
  url?: string;
}
export const startRender = (episodeId: string, body: RenderRequest) => request<RenderView>(`/episodes/${encodeURIComponent(episodeId)}/renders`, json(body), 60_000);
export const getRender = (episodeId: string, id: string) => request<RenderView>(`/episodes/${encodeURIComponent(episodeId)}/renders/${id}`);
/** A shot's original clip (what Omni edited), for the Original side. */
export const clipUrl = (episodeId: string, shotId: string) => `${API_URL}/episodes/${encodeURIComponent(episodeId)}/clips/${shotId}.mp4`;
/** The episode for one audience with its rendered shots cut in. */
export const buildMaster = (episodeId: string, audienceId: string, renders: string[]) =>
  request<{ url: string }>(`/episodes/${encodeURIComponent(episodeId)}/masters`, json({ audienceId, renders }), 180_000).then((r) => `${API_URL}${r.url}`);
let config: Promise<ApiConfig> | null = null;
/** `GET /config`, once per page load. */
export const apiConfig = () => (config ??= request<ApiConfig>('/config').catch((e) => ((config = null), Promise.reject(e))));

/* ---------- Samples ---------- */

/** A ready-made episode on the landing page (GET /samples). Paths are on the API. */
export interface SampleSummary {
  id: string;
  name: string;
  blurb: string;
  duration: number;
  width: number;
  height: number;
  shots: number;
  versions: number;
  products: number;
  poster: string | null;
  /** The rendered clip, and the same shot before Cameo (for the before/after wipe). */
  clip: string | null;
  original: string | null;
}
/** One sample's versions: per shot and audience, the products in its boxes, its approved still and its clip. */
export interface SampleManifest {
  name: string;
  versions: Array<{
    shotId: string;
    audienceId: string;
    stillId: string;
    renderId: string | null;
    /** Per box: the product, plus what a browser without them needs (a drawn box's place, the product itself). */
    assignments: Array<{
      boxId: string;
      productId: string;
      box?: ApiBox;
      label?: string;
      kind?: string;
      edit?: 'replace' | 'place' | 'display';
      product?: { brand: string; name: string; category: string; description?: string | null; image?: string | null };
    }>;
  }>;
}
export const listSamples = () => request<SampleSummary[]>('/samples');
export const getSample = (id: string) => request<SampleManifest>(`/episodes/${encodeURIComponent(id)}/sample`);
export const apiAsset = (path: string | null) => (path ? `${API_URL}${path}` : null);

/** Remove an uploaded episode and everything made from it on the server (not the sample). */
export const deleteEpisode = (episodeId: string) =>
  request<{ ok: boolean; deleted: boolean }>(`/episodes/${encodeURIComponent(episodeId)}`, { method: 'DELETE' });

/** Record one viewer event. Fire and forget: a lost event is never retried or made up. */
export function postEvent(e: ViewerEvent) {
  // Tagged with this browser's id: Interest shows each browser only its own viewers' events.
  void fetch(`${API_URL}/events`, { ...json(e), headers: { 'Content-Type': 'application/json', 'X-Cameo-Visitor': visitorId() }, keepalive: true }).catch(() => undefined);
}

export const fetchAnalytics = (episodeId: string) => request<Analytics>(`/episodes/${encodeURIComponent(episodeId)}/analytics`, {}, 15_000);

const isTerminal = (e: JobEvent) => e.stage === 'job' && (e.state === 'complete' || e.state === 'failed' || e.state === 'cancelled');

/**
 * Follow a job's events (the server replays its history on connect, and the page skips events it has seen). Closes
 * itself on a terminal event. While the job only waits for the producer's go-ahead and the page is not in use, the
 * stream is closed so the idle server can sleep; it reopens on the next interaction.
 */
export function subscribeJob(jobId: string, onEvent: (e: JobEvent) => void, onError?: () => void): () => void {
  let es: EventSource | null = null;
  let done = false;
  let waiting = false;
  const open = () => {
    const source = new EventSource(`${API_URL}/jobs/${jobId}/events`);
    es = source;
    source.onmessage = (m) => {
      let e: JobEvent;
      try {
        e = JSON.parse(m.data as string) as JobEvent;
      } catch {
        return;
      }
      waiting = e.state === 'needs_confirmation';
      onEvent(e);
      if (isTerminal(e)) {
        done = true;
        source.close();
      }
    };
    source.onerror = () => {
      // EventSource retries by itself (and the server replays history); give up only once it closed.
      if (!done && source.readyState === EventSource.CLOSED) onError?.();
    };
  };
  open();
  const idle = setInterval(() => {
    if (es && waiting && !done && !inUse()) {
      es.close();
      es = null;
    }
  }, 30_000);
  const offBack = onBackInUse(() => {
    if (!es && !done) open();
  });
  return () => {
    done = true;
    clearInterval(idle);
    offBack();
    es?.close();
  };
}

/* ---------- Operator dashboard (needs the server's admin token) ---------- */

export interface OpsEvent {
  t: number;
  kind: string;
  visitor: string;
  net?: string;
  episode: string | null;
  episodeName?: string | null;
  cost: number;
  [key: string]: unknown;
}
export interface OpsVisitor {
  visitor: string;
  /** A headless or scripted browser (tests, monitors, crawlers): kept apart from people. */
  automated?: boolean;
  net?: string;
  first: number;
  last: number;
  visits: number;
  samples: string[];
  uploads: number;
  images: number;
  renders: number;
  spend: number;
  refused: number;
  ua: string;
  sessions: number;
  actions: number;
  /** Seconds the tab was in view. */
  seconds: number;
  sections: string[];
  lastAction: string;
  country: string;
  timezone: string;
  language: string;
  browser: string;
  os: string;
  device: string;
  referrer: string;
  utmSource: string;
  utmCampaign: string;
}
export interface OpsCount {
  name: string;
  visitors: number;
}
export interface OpsLimits {
  day: string;
  spent: number;
  budget: number;
  visitorCap: number;
  networkCap: number;
  /** Today's spend per browser and per network (hash). */
  visitors: Record<string, number>;
  nets: Record<string, number>;
  blocked: { visitors: string[]; nets: string[] };
}
export interface OpsSummary {
  days: number;
  generatedAt: number;
  hourly: boolean;
  today: string;
  totals: Record<string, number>;
  series: Array<{ bucket: string; visits?: number; images?: number; renders?: number; uploads?: number; detections?: number; spend?: number }>;
  samples: Array<{ id: string; name: string; views: number; visitors: number }>;
  visitors: OpsVisitor[];
  recent: OpsEvent[];
  limits: OpsLimits | null;
  funnel: Array<{ step: string; visitors: number }>;
  actions: Array<{ action: string; count: number }>;
  audience: { countries: OpsCount[]; devices: OpsCount[]; browsers: OpsCount[]; os: OpsCount[]; languages: OpsCount[]; referrers: OpsCount[] };
  console: Partial<Record<'logs' | 'billing' | 'vertex' | 'service', string>>;
}
export interface OpsVisitorDetail {
  profile: OpsVisitor | null;
  spentToday: number;
  networkSpentToday: number;
  visitorCap: number;
  networkCap: number;
  blocked: boolean;
  networkBlocked: boolean;
  timeline: OpsEvent[];
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
export const adminSummary = (token: string, days: number) => request<OpsSummary>(`/admin/summary?days=${days}`, { headers: bearer(token) });
export const adminVisitor = (token: string, id: string) => request<OpsVisitorDetail>(`/admin/visitor/${encodeURIComponent(id)}`, { headers: bearer(token) });
export const adminTestAlert = (token: string) => request<{ ok: boolean }>('/admin/test-alert', { method: 'POST', headers: bearer(token) });
export const adminLimits = (
  token: string,
  body: { budget?: number; visitorCap?: number; networkCap?: number; resetSpend?: boolean; resetVisitor?: string; resetNetwork?: string; resetAll?: boolean },
) =>
  request<OpsLimits>('/admin/limits', { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
