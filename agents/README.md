# Cameo API

FastAPI service behind the web app: ingest, detection, tracking and generation. Endpoints are in
[../docs/api.md](../docs/api.md); the pipeline, its rules and costs in [../docs/architecture.md](../docs/architecture.md).

## Run

```sh
python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # GOOGLE_CLOUD_PROJECT; credentials from `gcloud auth application-default login`
scripts/run_api.sh            # http://127.0.0.1:8787
```

ffmpeg must be on the PATH. Episodes and every cached model result are written under `out/<episode>/`.

## Modules

| File | Role | Google AI |
|---|---|---|
| `cameo_agents/api.py` | Endpoints, jobs and their event streams | |
| `cameo_agents/ingest.py` | Shots on real cuts, 360p proxy, keyframes | |
| `cameo_agents/vision.py` | Objects on each keyframe; snapping drawn boxes | Cloud Vision |
| `cameo_agents/models.py` | Scene understanding, boxes, product match (structured output) | Gemini 3.8 Flash |
| `cameo_agents/schemas.py` | Response schemas, shared placement rules, the sensitive-scene rule | |
| `cameo_agents/pipeline.py` | The detection stages, their caches and guards | |
| `cameo_agents/identify.py` | Drawn boxes; edit prompts for picked products | Gemini 3.8 Flash |
| `cameo_agents/tracking.py` | Boxes followed through each shot (OpenCV ViT tracker, CPU) | |
| `cameo_agents/preview.py` | Preview stills | Nano Banana |
| `cameo_agents/render.py` | Shot renders, their checks, per-audience masters | Gemini Omni, Gemini 3.8 Flash |
| `cameo_agents/events.py` | Viewer events and analytics, per browser | |
| `cameo_agents/limits.py` | Daily dollar ceilings per browser, network and server | |
| `cameo_agents/ops.py` | Visitor and generation log, operator dashboard, alerts | Cloud Logging |
| `cameo_agents/storage_sync.py` | Durable copies, restore after sleep, signed upload URLs | Cloud Storage |

## Command line

```sh
.venv/bin/python -m cameo_agents.ingest <video> out/<episode>
.venv/bin/python -m cameo_agents.pipeline out/<episode> --stages 1,2,3          # detection on Vertex AI
.venv/bin/python -m cameo_agents.pipeline out/<episode> --dry-run               # write the requests, call nothing
.venv/bin/python scripts/make_sample.py <episode> --name "Park walk" --order 1  # publish a finished episode as a sample
.venv/bin/python scripts/pack_samples.py                                        # copy samples into the image build
```

`scripts/gen_packshots.py` and `scripts/clean_packshot.py` make the starter catalog's product photos with Nano Banana.

## Tests

```sh
.venv/bin/pip install pytest httpx
.venv/bin/python -m pytest
```

Tests build their own clips with ffmpeg and use offline stand-ins for Gemini, Cloud Vision, Nano Banana and Gemini Omni,
so they need no credentials and make no network calls.
