# Cameo API

FastAPI service in `agents/cameo_agents/api.py`. The browser keeps projects, the catalog and audiences, and sends them
in request bodies; the server keeps episodes and every model result in a file cache under `out/<episode>/`, keyed by a
hash of the inputs, so a repeated request costs nothing.

The web app is one client. A CMS, a studio's asset pipeline or an ad server can drive the same endpoints: send a video
and a catalog as JSON, confirm the estimate, approve stills, render, and serve each audience's episode as a plain MP4.

## Shared shapes

```ts
type AudienceId = string;
interface Audience { id: AudienceId; name: string; kind: string; basedOn?: AudienceId }
interface CatalogProduct {
  id: string; brand: string; name: string; category: string; url: string;
  availableIn: 'all' | AudienceId[];
  description?: string;
}
interface Box { x: number; y: number; w: number; h: number }   // 0..1 fractions of the frame
interface Pick { productId: string; why: string }
```

## Episodes and detection

| Method | Path | What it does |
|---|---|---|
| `POST` | `/uploads` | `{name, size, type}` → `{key, url, headers}`: a V4 signed URL, valid 15 minutes, that the browser `PUT`s the video to (straight into Cloud Storage, past Cloud Run's 32 MB request limit; at most 100 MB). `501` when the server has no bucket: send the file to `/episodes` instead. |
| `POST` | `/episodes` | JSON `{upload: key, trim?}` after `/uploads`, or multipart `file` (and `trim=1` to keep the first 10 s of a longer video). Returns `{jobId, episodeId}`. Ingest runs at once (ffmpeg: shots, 360p proxy, keyframes); the job then waits at `needs_confirmation` with the cost estimate. A video over 10 s without `trim` gets `422 {code: "too_long"}`. |
| `GET` | `/jobs/{id}/events` | Server-sent events: `{seq, t, stage, state, message, counts?, tokens?, seconds?, cost?, calls?, progress?}` for the stages `ingest`, `vision`, `understand`, `localise`, `match` and the final `job` event. A late subscriber gets every past event first. |
| `POST` | `/jobs/{id}/confirm` | `{catalog, audiences}`: runs detection (Cloud Vision, then Gemini stages 1 to 3) or a re-match. `409` unless the job is waiting. |
| `POST` | `/jobs/{id}/cancel` | Cancels a waiting or running job. `GET /jobs/{id}` returns its summary. |
| `POST` | `/episodes/{id}/rerun` | Re-cuts the shots from the source, clears everything derived from them, and waits for confirmation again. |
| `GET` | `/episodes/{id}` | `{episodeId, sample, hasDetected, duration, shots}` |
| `GET` | `/episodes/{id}/detected.json` | Scenes, boxes, Cloud Vision objects and per-audience suggestions with edit prompts. `?match=<matchId>` serves a re-match; the default is always the original run. |
| `GET` | `/episodes/{id}/media/proxy` | The 360p proxy (supports `Range`). `/media/keyframes/{name}` serves keyframes. |
| `DELETE` | `/episodes/{id}` | Removes the episode and everything made from it; running jobs are cancelled. |

## Placement

| Method | Path | What it does |
|---|---|---|
| `POST` | `/episodes/{id}/match` | `{catalog, audiences}`: re-runs product matching only (one Gemini call). Returns `{jobId}`; the job waits at `match / needs_confirmation`, and its `job / complete` event carries `matchId`. |
| `POST` | `/episodes/{id}/identify` | `{shotId, box, audiences, catalog}` for a box drawn on Scenes. Cloud Vision snaps the box to the object under it; Gemini names it in the scene's context and picks products. Returns `{label, kind, edit, why, box, picks: Record<AudienceId, Pick[]>, prompts: Record<AudienceId, string>, vision: {objects, snappedTo?}}`. |
| `POST` | `/episodes/{id}/prompt` | `{shotId, box, label, kind, product}`: Gemini writes the edit prompt for a product placed in a box. Returns `{prompt}`. |
| `GET` | `/episodes/{id}/tracks` | Each detected box followed through its shot: `{boxId: {t0, fps, boxes: Array<[x, y, w, h] \| null>, best}}`. `null` means out of view; `best` is the time the spot is largest in view. CPU only. |
| `POST` | `/episodes/{id}/track` | `{shotId, t, box}`: the same for a drawn box, from the frame it was drawn on. |

## Generation

| Method | Path | What it does |
|---|---|---|
| `POST` | `/episodes/{id}/previews` | `{shotId, audienceId, prompt, items: [{n, boxId, productId, label, kind, edit, box, product, image?}]}`: Nano Banana edits the shot's keyframe with each product in its box (`image` is the product photo as a data URL, sent as a reference). Returns `{id, url, model, seconds, cost, cached}`; `GET /previews/{id}.png` serves the still. |
| `POST` | `/episodes/{id}/renders` | `{shotId, audienceId, stillId, items, resolution: "360p", attempt?}`: Gemini Omni edits the shot's video so it matches the approved still, then Gemini checks the clip (products match, no new cuts, people unchanged). Returns the render's state at once; poll `GET /renders/{id}` until `status` is `done` or `failed`. `/renders/{id}.mp4` and `.jpg` serve the clip and its poster; `/clips/{shot}.mp4` serves the original shot. `attempt` asks for a new take after a failed check. |
| `POST` | `/episodes/{id}/masters` | `{audienceId, renders: [id]}`: the whole episode for one audience, rendered shots cut in and the original audio throughout. Returns `{url}`. |

## Samples, analytics and config

| Method | Path | What it does |
|---|---|---|
| `GET` | `/samples` | Ready-made episodes (`out/<id>/sample.json`, written by `scripts/make_sample.py`): name, shape, duration, poster and clip. |
| `GET` | `/episodes/{id}/sample` | A sample's manifest: per version, the products in its boxes, its approved still and its render, so the browser opens it finished. |
| `POST` | `/events` | `{episodeId, sessionId, type, t, shotId?, boxId?, productId?, audienceId?}` with `type` one of `impression`, `shop_click`, `product_view`, `product_save`. |
| `GET` | `/episodes/{id}/analytics` | This browser's recorded events (by `X-Cameo-Visitor`) aggregated into impressions, shop clicks, product views and saves. Samples are shared, so each browser sees only its own. |
| `POST` | `/ops/visit` | `{path, episodeId?}`: one page view for the operator dashboard. |
| `GET` | `/admin/summary` | `?days=N` (0 = all). Totals, activity series, samples, visitors, recent events and today's limits. Needs `Authorization: Bearer <CAMEO_ADMIN_TOKEN>`. |
| `POST` | `/admin/limits` | `{budget?, visitorCap?, networkCap?, resetSpend?, resetVisitor?, resetNetwork?, resetAll?}`: the dollar ceilings and unblocking. Same token. |
| `POST` | `/admin/test-alert` | Logs one test alert, which Cloud Monitoring emails. Same token. |
| `GET` | `/config` | `{maxSeconds, imageModel, imagePrice, videoModel, videoPricePerSecond}`, shown before anything is spent. |
| `GET` | `/health` | `{ok: true}` |
